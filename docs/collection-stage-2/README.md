# 阶段 2：MediaCrawler 接入与验收记录

更新：2026-11-12。阶段 1 已完成；本阶段在线验收进行中，不能把导出适配测试视为七平台采集通过。

## 版本与隔离

- 固定源码：NanmiCoder/MediaCrawler `306ab4ca26c0e44fb87ede0e40e98748752815a6`。
- 本地工具目录：`.local-data/tools/MediaCrawler-306ab4ca26c0`，不提交第三方源码。
- Python 3.12 独立环境：`.local-data/tools/mediacrawler-venv`；已安装并记录 [依赖版本](mediacrawler-requirements.lock.txt)。
- 本地启动清单：`.local-data/tools/mediacrawler-local.json`，包含固定 commit 与本机路径，不含账号凭据。
- Playwright Chromium 下载因 CDN DNS 失败；当前使用已安装 Edge，但所有登录都使用本项目独立资料目录。禁止 CDP 连接日常浏览器。
- `scripts/mediacrawler-local.py --check` 在正常本机权限下通过：七个平台模块导入成功，独立 Edge 可用。受限环境的子进程启动存在卡顿，不能据此宣布平台不可用。
- MediaCrawler 的学习用途及禁止商业用途限制保留；工具选型不等于取得其他使用授权。

## 入口

从项目根目录在 PowerShell 运行：

```powershell
$python = '.local-data/tools/mediacrawler-venv/Scripts/python.exe'
& $python scripts/mediacrawler-local.py --check

# 首次正常登录：在专用窗口完成后关闭该窗口，登录态留在本地。
& $python scripts/mediacrawler-local.py --login --platform xhs

# 登录后仅检查登录态，不发起关键词搜索。
& $python scripts/mediacrawler-local.py --verify-login --platform xhs --timeout 60

# 每次使用新的输出目录，不覆盖旧结果；本阶段每次上限初值为 5。
& $python scripts/mediacrawler-local.py --platform xhs --keyword '西安 展览' --limit 5 --timeout 120 --output .local-data/xian/runs/xhs-sample-01

# 对导出的 search_contents_日期.jsonl 做本地规范化，输出路径也必须在 .local-data。
node scripts/import-mediacrawler.ts xhs .local-data/xian/runs/xhs-sample-01/xhs/jsonl/search_contents_2026-11-12.jsonl .local-data/xian/runs/xhs-sample-01/normalized.json
```

平台代码：xhs 小红书、dy 抖音、ks 快手、bili B站、wb 微博、tieba 贴吧、zhihu 知乎。导出路径以实际生成文件为准，示例日期不是固定配置。登录命令会打开窗口，只供首次登录；搜索入口为 headless，登录失效停止，不启动二维码/手机号登录。

本机启动清单及源码需要先存在。依赖锁仅说明本次成功安装环境，不是自动安装脚本。重新部署必须固定对应上游 commit、使用独立环境并重新验收。

脚本关闭 dotenv 自动发现，不把项目模型 Key 传给采集配置；关闭评论、二级评论、媒体下载、代理及平台原始详细日志。脚本只输出状态/异常类型，不输出上游异常消息。原始导出仍可能包含平台签名链接，只能保留在忽略目录；规范化结果不保留 Cookie、昵称或 xsec_token 字段。

## 导出适配约定

| 平台 | 身份字段 | 发布时间来源 | 内容限制 |
| --- | --- | --- | --- |
| 小红书 | note_id | time，毫秒 | 标题与 desc；海报文字尚未处理 |
| 抖音 | aweme_id | create_time，秒 | 仅描述，非视频转写 |
| 快手 | video_id | create_time，毫秒 | 上游描述可能截断 |
| B站 | video_id | create_time，秒 | 上游标题/简介可能截断 |
| 微博 | note_id | create_time，秒 | 正文；无独立标题时截取开头作展示标签 |
| 贴吧 | note_id | 完整年份 publish_time，按上海时区 | 缺年份不猜日期 |
| 知乎 | content_type + content_id | created_time，秒 | 只接 article/answer 的 content_text，不把 desc 摘要替代正文 |

`last_modify_ts` 不作为发帖日期、编辑日期或事实核验时间。发布时间解析失败保留 NULL，不用当前时间填充。相同来源 ID/相同正文哈希去重，正文变更保留新版本供后续核验。链接按内容 ID 生成不含访问令牌的 canonical URL；小红书详情补抓如需平台签名链接仍从私有原始导出读取，不把它放进发布包。

正文 hash 对应规范化后的实际输入，模型提取必须引用相同文本。没有可用文本的内容直接拒绝；截断或仅描述的资料有明确 content_scope 标记，不代表正文完整或活动已经核实。

## 当前验证结果

- 类型检查通过；全部 Node 回归 429/429 通过，0 失败、0 跳过。
- 七平台字段映射的 12 项离线测试通过，包括时间单位、令牌剥离、内容范围、坏 JSONL、评论排除、去重及更新版本。
- 导入 CLI 用明确标识的合成样本验证通过，结果仅在忽略目录，没有写 events。
- 小红书已在线验收：首轮默认热度排序返回 20 条，多为旧内容；修正为最新排序，并在详情请求前将结果硬限制到 5 条。第二轮“西安 展览 11月”实际导出 5 条、规范化通过 5 条，总耗时 31,701 ms（含启动、请求、退避及清理；单次样本不能推断稳定 p95）。
- 第二轮含近期展讯、回顾和综合介绍，尚未经过阶段 3 真实性/活动有效性校验，不能把 5 条文档计作 5 个合格活动。
- Python 边界测试 4/4 通过：详情前限量、广告项排除、私有路径限制和七平台入口。
- 抖音：用户已完成独立窗口登录；其余五平台登录交接进行中。按用户最新指示先完成登录，暂不进行其余平台关键词采集。
- 新增 --verify-login：复用上游登录检测、跳过实际 search。抖音/贴吧检测依据是本地浏览器状态，只标 login_state_detected；其余平台通过上游账号检查时标 login_verified。两者均不等于关键词搜索已验收。
- DeepSeek 新轮网页连通样本：一次请求 HTTP 200、562 ms，返回并解析 20 条命中；仅连通和解析通过，尚未逐条验证正文完整性、有效性或来源。未调用提取模型。
- 正式活动库未写入；阶段 3–6 未开始，不安装夜间任务。
