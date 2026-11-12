# 阶段 2：MediaCrawler 接入与验收记录

> 最新范围仅启用小红书，其他平台已停用。下文六平台结果保留为历史验收；后续实现见 [后处理设计](../collection-downstream-design.md)。

更新：2026-11-12。阶段 1 已完成；本阶段基础接入与首轮在线小样本验收完成。用户已取消知乎，当前启用六平台；仅表示采集及解析链路通过，不代表活动事实与最终入库验收通过。

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

当前平台代码：xhs 小红书、dy 抖音、ks 快手、bili B站、wb 微博、tieba 贴吧。知乎已从登录/搜索入口及新导入 CLI 移除，底层历史解析适配保留。导出路径以实际生成文件为准，示例日期不是固定配置。登录命令会打开窗口，只供首次登录；搜索入口为 headless，登录失效停止，不启动二维码/手机号登录。

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
| 知乎（历史解析，未启用） | content_type + content_id | created_time，秒 | 只接 article/answer 的 content_text，不把 desc 摘要替代正文 |

`last_modify_ts` 不作为发帖日期、编辑日期或事实核验时间。发布时间解析失败保留 NULL，不用当前时间填充。相同来源 ID/相同正文哈希去重，正文变更保留新版本供后续核验。链接按内容 ID 生成不含访问令牌的 canonical URL；小红书详情补抓如需平台签名链接仍从私有原始导出读取，不把它放进发布包。

正文 hash 对应规范化后的实际输入，模型提取必须引用相同文本。没有可用文本的内容直接拒绝；截断或仅描述的资料有明确 content_scope 标记，不代表正文完整或活动已经核实。

## 当前验证结果

- 类型检查通过；全部 Node 回归 430/430 通过，0 失败、0 跳过。
- 七平台字段映射的 12 项离线测试通过，包括时间单位、令牌剥离、内容范围、坏 JSONL、评论排除、去重及更新版本。
- 导入 CLI 用明确标识的合成样本验证通过，结果仅在忽略目录，没有写 events。
- 小红书已在线验收：首轮默认热度排序返回 20 条，多为旧内容；修正为最新排序，并在详情请求前将结果硬限制到 5 条。第二轮“西安 展览 11月”实际导出 5 条、规范化通过 5 条，总耗时 31,701 ms（含启动、请求、退避及清理；单次样本不能推断稳定 p95）。
- 第二轮含近期展讯、回顾和综合介绍，尚未经过阶段 3 真实性/活动有效性校验，不能把 5 条文档计作 5 个合格活动。
- Python 边界测试 5/5 通过：详情前限量、广告项排除、私有路径限制和六平台启用范围。
- 登录交接：抖音、快手、B站、微博、贴吧专用窗口均已结束；用户取消知乎，不能将其窗口结束记录计为已启用平台。先完成全部启用平台登录及检查，然后继续原计划的小样本搜索，未扩大采集量。
- 已检查：抖音/贴吧检测到本地登录状态；快手/B站/微博通过上游账号检查。微博首轮等待页面完整加载超时，将初始页面等待改为 DOM 就绪后账号检查通过（8,140 ms）；没有跳过账号验证。上述状态不记录账号名称、Cookie 或令牌。
- 新增 --verify-login：复用上游登录检测、跳过实际 search。抖音/贴吧检测依据是本地浏览器状态，只标 login_state_detected；其余平台通过上游账号检查时标 login_verified。两者均不等于关键词搜索已验收。
- DeepSeek 新轮网页连通样本：一次请求 HTTP 200、562 ms，返回并解析 20 条命中；仅连通和解析通过，尚未逐条验证正文完整性、有效性或来源。未调用提取模型。
- 正式活动库未写入；阶段 3–6 未开始，不安装夜间任务。

## 六平台首轮搜索与解析结果

| 平台 | 导出文档数 | 规范化通过 | 规范化拒绝 | 单次总耗时 | 搜索排序/限制 |
| --- | --- | --- | --- | --- | --- |
| 小红书 | 5 | 5 | 0 | 31.701 秒 | 最新排序，详情前限 5 条 |
| 抖音 | 4 | 4 | 0 | 9.173 秒 | 最新排序，近一周发布过滤 |
| 快手 | 5 | 5 | 0 | 14.422 秒 | 接口默认排序，含旧内容，不能宣称近期覆盖已达标 |
| B站 | 5 | 3 | 2 | 28.623 秒 | 请求最新排序、近 30 天；两条缺正文拒绝 |
| 微博 | 5 | 5 | 0 | 26.480 秒 | 实时/最新搜索，展开后最多处理 5 条帖子 |
| 贴吧 | 5 | 4 | 1 | 31.602 秒 | 请求按时间排序，一条缺正文拒绝；实际发帖日期并非严格降序 |

共导出 29 条，规范化通过 26 条、拒绝 3 条。所有计数都是来源文档，不是活动数。统计来自 .local-data/xian/runs/stage2-summary.json；原始内容、图片、签名链接与完整正文均未提交。每个平台目前只有一次受控测量，不能以此推断 p95、长期稳定性或夜间完整耗时。小红书早先默认排序的 20 条探索样本不计入本表。

快手本轮五条中有三条发帖时间超过 30 天；即使解析成功也不能直接进入近期候选。贴吧排序也必须再以真实发帖时间和活动有效期检查。B站只有标题而无正文的内容直接拒绝，不用模型根据标题补内容。来源 canonical URL 不含内容访问令牌，部分平台直接浏览可能仍要求登录或有效分享链接，不能把可生成 URL 等同于任意浏览器可打开。

新增搜索指标记录 search_calls、returned_items、search_errors、exported_documents，区分 documents_exported、no_results、search_failed、detail_failed、search_not_executed。上游吞掉异常或零条输出不能自动判定采集成功。每个验收任务最多一次搜索调用，先限制结果再处理详情；微博先展开卡片再限帖子数。各平台网络层内部的重试不计作新的业务搜索调用，此统计不是 HTTP 总请求次数。

最后验收：Python 5/5、Node 430/430、类型检查全部通过。阶段 3 下一步处理真实性、语义提取、证据与时效；阶段 4 查询坐标；这两项通过前不会将这 26 条文档写入 events。

## 第二关键词补测与当前执行状态

六平台分别补测“西安 市集 11月”，均为一次业务搜索调用、最多 5 条处理上限。

| 平台 | 导出 | 规范化通过 | 拒绝 | 耗时（秒） |
| --- | --- | --- | --- | --- |
| xhs | 5 | 4 | 1 | 30.719 |
| dy | 3 | 2 | 1 | 8.871 |
| ks | 5 | 5 | 0 | 13.983 |
| bili | 5 | 3 | 2 | 29.335 |
| wb | 5 | 5 | 0 | 29.364 |
| tieba | 5 | 5 | 0 | 31.622 |

第二轮导出 28 条，规范化通过 24 条。DeepSeek 六类别补测均 HTTP 200，每查询请求/保留 5 条，共 30 条不同 URL，单次耗时 329–465 ms；这是搜索命中与提供的正文，不等于已经独立核实的原站全文。

用户询问账号风险后，不再发起新的平台采集；此前已发出的任务均已结束。当前未安装夜间定时任务，正式 events 未写入。使用个人账号进行非官方自动化访问存在验证、功能限制及封号风险；低频和独立本地资料目录均不构成安全保证。后续是否继续账号采集等待用户决定，离线结果与代码保留。

参考：[抖音用户协议](https://www.douyin.com/draft/douyin_agreement/douyin_agreement_user.html?id=6773906068725565448)、[B站用户协议](https://www.bilibili.com/blackboard/protocal/licence.html)。两者包含未经授权自动化获取数据的限制以及违约处置；不据此推断每个平台的具体封号阈值。
