# 小红书图片云端 OCR（Issue #21）

采集入口 `collect` 和定时入口 `collect:task` 共用 `runCollection`。启用 `processing.ocr` 时，图片识别改用 SiliconFlow 托管的 `deepseek-ai/DeepSeek-OCR`；正文分析仍使用原来的 DeepSeek 配置，地图仍使用高德，数据库结构及写入规则不变。

## 配置与运行

在本机或部署环境的 `.env` 配置：

```dotenv
SILICONFLOW_API_KEY=
SILICONFLOW_OCR_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_OCR_MODEL=deepseek-ai/DeepSeek-OCR
SILICONFLOW_OCR_TIMEOUT_MS=60000
SILICONFLOW_OCR_CONCURRENCY=2
SILICONFLOW_OCR_MAX_TOKENS=4096
```

Key 必须单独申请，不复用 `DEEPSEEK_API_KEY`。不要提交 `.env`。当处理与 OCR 均启用时，缺少 Key 会在开始搜索和写库前报 `SILICONFLOW_API_KEY_REQUIRED`。仅采集来源或 `processing.ocr=false` 不要求 OCR Key。

采集配置沿用 `processing.ocr`、`processing.ocr_max_images`：每篇默认最多 10 张，可配置 1–20 张；不是帖子数。正常运行仍使用：

```sh
npm run collect -- --config configs/collection.example.json --live
```

## 处理协议与边界

1. 使用本轮新采集的图片 URL。只接受 `*.xhscdn.com` 的 HTTP/HTTPS 地址，下载统一 HTTPS，不跟随重定向，不发送登录 Cookie 或模型 Key。每次下载最多 15 秒，每张最多 12 MiB，检查实际图片签名，支持 PNG、JPEG、WebP、GIF。
2. 下载成功后，将图片字节编码为 base64 data URI，通过 `/chat/completions` 发送一张图片及 `<image>\nFree OCR.`。SiliconFlow 不接收小红书 Cookie；它会收到图片内容。
识别请求固定 temperature=0、frequency_penalty=1.2，以抑制自然场景照片引起的重复解码。输出包含大量相同重复行时记为 OCR_REPETITIVE_RESPONSE，禁止作为事实提交给后续分析。

3. 默认同时识别 2 张（可配置 1–4），每次模型请求最多 60 秒（可配置 10–120000 毫秒），单篇全部下载与识别共享最多 180 秒，并受外层任务剩余时间约束。
4. 网络、超时、429、5xx 等暂时失败最多重试一次，成功图片不重跑。401/403 认证失败或 402 余额不足会阻止同篇后续请求；已在执行的请求可能完成。单图超时后重试可能产生额外计费，以服务商账单为准。
5. 保持原图片顺序和 `【图片N】` 编号。部分失败保留成功文本与逐图错误；超出图片上限会明确报告。正文和 OCR 合并后送给原分析模型、高德工具与本地校验，再按原规则去重、写入同一个数据库。

正文最多 15000 字符，OCR 最多 14000 字符，合并上限 30000 字符。图片文字仍属于不可信资料，不能变成系统指令。图片原字迹和 OCR 都可能有误；模型返回与后续校验不能证明每个事实都正确。

## 报告与错误

私有运行目录 `ocr-N.json` 包含 provider、model、逐图 text/error/elapsed_ms/attempts/usage，以及整篇 elapsed_ms。`processing.json` 保留 `ocr_errors`；即使成功图片产出的候选通过写库，只要存在 OCR 错误，本轮也按原机制标记 partial。空输出、无效 JSON、被截断输出不作为识别成功。

| 错误 | 含义与处理 |
| --- | --- |
| IMAGE_HOST_NOT_ALLOWED | 图片来源不允许；不下载、不重试 |
| OCR_IMAGE_HTTP_ERROR | 图片站返回非暂时 HTTP 错误，如 403；不能据此判定账号未登录 |
| OCR_IMAGE_TRANSIENT | 图片站 429/5xx；最多重试一次 |
| OCR_AUTH_FAILED / OCR_BALANCE_DEPLETED | OCR 服务认证或余额问题；不当成图片无文字 |
| OCR_RATE_LIMITED / OCR_SERVER_ERROR | OCR 服务限流或服务端暂时异常；最多重试一次 |
| OCR_API_REJECTED | OCR 请求被拒绝；不返回服务商错误正文，避免泄密 |
| OCR_TIMEOUT / OCR_NETWORK_ERROR / OCR_BATCH_TIMEOUT | 单次超时、网络异常、整篇预算到期 |
| OCR_INVALID_RESPONSE / OCR_TRUNCATED_RESPONSE / OCR_EMPTY_TEXT / OCR_REPETITIVE_RESPONSE | 响应结构异常、输出截断、空文本或明显循环重复 |
| OCR_UNSUPPORTED_IMAGE / OCR_RESPONSE_TOO_LARGE | 图片格式不支持或图片/响应超过大小限制 |
| OCR_IMAGE_LIMIT | 超过配置图片数，未宣称完整识别 |

日志不保存请求 base64、Authorization 或服务商错误正文。Token usage 仅统计服务商成功响应返回的计数，缺失计数不代表免费；失败或超时请求是否扣费以账单为准。历史“限时免费”公告不能作为当前价格承诺。

## 本地 OCR 与 Python

保留 `src/collection/ocr.ts`、`scripts/collection-ocr.py` 和本地 OCR 测试，供开发者显式调用及对照。主采集入口不再调用本地 OCR，也不自动降级到本地，以免服务器依赖未安装而失败，或掩盖云端故障。服务器无需安装 RapidOCR/ONNX。Python/Playwright 仍是 MediaCrawler 的依赖；其跨平台适配属于独立问题，本 PR 不包含该修改。

## 独立评估工具

`node scripts/eval-cloud-ocr.ts .local-data/.../samples.json` 只评估 OCR，不采集来源、不写数据库。输入为最多 10 项的数组，每项提供 `label` 和原始 `document`。默认真实下载 document.image_urls；可选 `local_images` 仅用于评估已保存的真实图片，路径必须位于 `.local-data` 内。此模式会绕过 CDN 下载，因此其成功不能证明线上图片链接有效。工具仍实际调用云端并产生可能的费用。结果和汇总仅写入私有 `.local-data/xian/issue-21/`。

实际验收见 [测试报告](../status/issue-21-cloud-ocr-evaluation.md)。接口依据：[多模态文档](https://docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision)、[Chat Completions](https://docs.siliconflow.cn/docs/api/chat-completions-post)。
