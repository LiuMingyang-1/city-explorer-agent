> 当前契约已升级为 xian-events/2：events 仍为原 18 列，start_at/end_at/suggested_duration_minutes 可以为 NULL，经纬度必填。source_url 移到 provenance，Qovia 已禁用；见 [夜间静态数据方案](../nightly-static-events-plan.md)。本页其余内容是阶段 A 初次验收记录。

# 真实数据阶段 A：契约与发布前校验

状态：2026-11-12 已完成离线实现及测试。没有调用搜索或模型 API，没有生成真实数据集，也没有修改项目运行数据库。下一阶段为小样本获取与测速。

## 已完成

- `src/collection/dataset.schema.json`：最终数据包契约，包含 events 与 provenance；中间不完整候选不属于最终发布类型。
- `src/collection/types.ts`：固定类别词表与来源依据类型。
- `src/collection/identity.ts`：稳定时段 ID；根据活动届次身份、物理场馆身份和开场/开放时间生成，修改介绍、票价或结束时间不改变 ID。活动 key 一经确定不因更换主要来源而变化；开场改变视为新时段，旧 ID 不循环使用。
- `src/collection/validate.ts`：schema、时间、费用、时段、证据、坐标元信息、批次范围与疑似密钥检查。不输出源文本或凭据值。
- `src/collection/config.ts`：独立 QOVIA_KEY / DEEPSEEK_API_KEY 读取，不回退主 Agent 密钥；错误只返回变量名及代码。
- `events-delivery.sql`：交付库草案，仅 events 和索引，现有 18 列加 source_url；guide_url 留 NULL。当前后端能继续读其他字段，但来源展示仍需后续最小映射对接。
- `.gitignore`：忽略 .env、.env.*（保留 .env.example）、.local-data、上游核对快照与交付库 sidecar。已创建空白本地 .env 便于后续填写，没有填入密钥。

## 搜索返回字段是否能直接入库

依据官方接口示例，尚无真实账户响应可用于确认当前返回质量。

| events 字段 | 本地处理或提取策略 |
| --- | --- |
| id | 本地生成活动时段 ID，不照搬搜索结果 ID |
| source_url | 来自结果原始 url，校验后保留；发现更可靠主来源时记录证据 |
| title | 搜索标题只是文章/帖子标题，需提取具体活动名；合集可包含多个活动 |
| description、category | 从正文概括及分类，模型辅助；类别使用固定词表 |
| venue_name、address | 从正文提取，再用分馆/场馆资料核对 |
| latitude、longitude | 场馆数据或地理编码，统一 WGS-84；不能凭模型知识生成 |
| start_at、end_at | 模型提取展期/场次/开放规则，本地展开；不是 published_at/date |
| suggested_duration_minutes | 原文有明确时长则提取；自由参观可用有标记的规划估计；固定演出不可推测散场 |
| budget_min、budget_max、budget_note | 提取价格语义与适用对象，本地转换为每人分；未知为 NULL |
| currency | 本批统一 CNY，遇外币价格拒绝直接套用 |
| thumbnail_url、image_urls | Qovia 活动内容图片可作为候选，需区分头像/广告；DeepSeek site_icon 是站点图标，不能当活动图 |
| guide_url | 过渡兼容列，最终新数据留 NULL |

Qovia 返回标题、文本、链接、发布信息及媒体等；DeepSeek 返回标题、摘要、可选正文和发布信息。两者提供“资料结构”，没有直接提供完整的“活动时段结构”。因此长正文提取应接模型 API，不用正则硬填完整 events。规则先做去重、清洗和单位格式转换，模型仅处理值得补全的资料。

阶段 C 模型中间结果需区分：活动届次、分馆、展期、每天开放、固定场次、闭馆、停止入场、票价与预约，并返回字段证据。缺少事实必须继续补查，模型无法补出不存在的信息。

## 校验边界

- `verified_at` 发布时要求不晚于 asOf，距 asOf 不超过 36 小时；这是本批数据生成的初始工程门槛，不是来源实时正确性的保证。
- 经纬度的粗范围只能拦截上海/坐标轴反转等明显错误。真正的西安市行政归属、分馆匹配、地理编码结果核对在阶段 C 实现。
- 校验会验证引用原文、来源 URL 与 SHA-256 的对应关系，但不能仅凭一句原文存在就证明语义提取正确。
- 整数金额只能检查表示合法；“20 元”是否被正确转换成 2000 分、是否是每人票价，需要提取及字段证据处理验证。
- 本地凭据扫描为已知形态的防误写检查，不替代“不将 env/请求头加入数据”的实现约束。网络调用和日志实现必须继续遵守脱敏规则。

## 数据包与交付清单

内部 final dataset 包含 schema_version=xian-events/1、base_date、days=14、events、provenance。发布时拆成 events.json 和 provenance.jsonl。

阶段 D/E 的 manifest 至少包括：数据集版本、来源上游提交、构建工具版本、基准日和截至日、生成时间、数据截至时间、不同项目/场馆/时段数、类别及日期分布、JSON 与数据库 SHA-256、校验结果、数据缺口。仅在实际生成并关闭库后填真实哈希，不提前伪造。

## 验证结果

```powershell
node --test "test/collection-*.test.ts"
# 37/37 pass
node node_modules/typescript/bin/tsc --noEmit
# exit 0
node --test --test-timeout=30000 "test/**/*.test.ts"
# 336/336 pass; 0 fail, 0 cancelled, 0 skipped
```

全量回归包含本地 HTTP/子进程，使用沙箱外执行；测试中的虚构活动只存在 test fixture，未写入 datasets/。没有在线测速结论，阶段 B 待凭据配置后进行。

参考：[Qovia 搜索](https://www.qovia.ai/zh/docs/api-reference/search/)、[DeepSeek 搜索](https://api-docs.deepseek.com/zh-cn/api/search/)、[JSON 输出](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)。
