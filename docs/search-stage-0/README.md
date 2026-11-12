# 阶段 0：搜索契约与存储设计基线

状态：阶段 0 设计基线 v1。这里的 schema、DDL、接口与样例用于后续实现验收，尚未接入运行时，不代表外部平台已可用。总规划见 [上级文档](../search-implementation-plan.md)。

## 交付物

- `request.schema.json`、`response.schema.json`：JSON Schema 2020-12；业务不变量另见下文。
- `examples.json`：9 个虚构离线案例，涵盖空结果、仅资料、可规划活动、部分失败、写回失败、分页、全失败和取消。
- `adapter-contract.ts`：适配器边界的 TypeScript 设计，不属于当前 src 编译输入。
- `schema.draft.sql`：目标 DDL，仅在临时库验证；不是可重复执行的迁移脚本。
- `verify.py`：用标准库验证本文实际使用的 schema 关键字、业务不变量、反例及 DDL；并非通用 JSON Schema 引擎。阶段 1 在项目内选定正式校验器，重用相同样例。

## 请求语义

保留 `date/category/keyword` 原参数，空对象仍合法；不添加第二个主 Agent 工具。不在工具内部做自主需求规划。

- `date`：上海时区真实日历日；正则仅检查形状，业务代码必须拒绝 02-30 等日期。
- `keyword`、`category`：trim 后不得为空，分别最多 1000、100 字；类型筛选沿用本地精确匹配，外部不支持时披露限制。
- `mode` 默认 `hybrid`，可选 `local/external`。local 只查本地活动；external 不查本地活动但可复用外部搜索缓存；hybrid 合并两者。
- `platforms` 省略表示所有已启用平台；显式指定未启用平台返回 unsupported，不能静默忽略或宣称零命中。web 表示无法归入专用平台的公开网页，不代表所有平台均已覆盖。
- `limit` 默认 20，范围 1–50，限制当前页，不静默丢弃后续资料。
- `freshness` 默认 cached：允许使用有效缓存；refresh：绕过搜索缓存访问外部渠道。它不延长活动事实的新鲜度。
- `cursor` 为服务端不透明随机令牌，绑定调用者作用域、标准化参数、结果快照与偏移。后续分页携带原请求，除 cursor 外参数需相同；不接受供应商原始游标。过期、跨作用域或参数改变返回 INVALID_CURSOR。
- 阶段 0 不增加 query、日期区间和用户可控城市字段，避免与旧参数重叠。城市固定西安市；显式异地意图由上游处理。搜索命中城市不明仍可返回资料并标记 unknown，明确异地结果在最终发布前排除。
- 未知请求字段拒绝。日期、URL、时间顺序、证据真实性无法仅靠 JSON Schema 完成。

## 响应业务不变量

结果采用 snake_case 外部 JSON，EventRepository 仍为 camelCase；转换由 service 负责。

1. document：plannable=false、event=null、document_id 非空、result_id=document_id。发布时间不等于活动时间。
2. event：plannable=true、event 非空、result_id=event.event_id，城市为 confirmed，带 date 请求时日期必须 confirmed；ID 已提交并可被同一 EventRepository.getByIds 回查。document_id 允许为空（旧本地数据）。
3. 外部新活动必须有 source_url、verified_at、fresh_until；费用上下限非负且下限不大于上限。legacy 本地活动可为空，limitations 必须标记 legacy_unverified，不伪装新鲜来源。
4. start_at/end_at 是上海本地 YYYY-MM-DDTHH:MM；执行与抓取时间是 RFC3339 UTC；必须检查真实日历、窗口顺序、坐标与金额。fixed 场次未来需校验完整参加。
5. 只做事实可用性校验，不判断兴趣选择或生成行程。正文包含的指令不执行。
6. success：至少一个计划渠道成功、无执行错误；零命中合法。partial：有可用成功渠道或保留结果，同时存在执行错误/覆盖失败，partial=true。failed：无成功渠道且无可用结果，partial=false。cancelled：调用被取消，partial=false，不提交新发布批次，已提交的缓存/搜索记录可保留。
7. 筛选能力不足通过 limitations 披露；渠道 unsupported 算覆盖缺失。部分搜索正常而写回失败时仍返回 document，并给 WRITEBACK_FAILED；禁止生成 event 假 ID。
8. coverage.count 是该渠道去重前有效命中数，允许大于最终页数。分页不改变原执行覆盖情况。
9. truncated=true 表示快照还有后页或存在预算/上游截断；只有后页确实可取才提供 next_cursor。上游预算截断却无后页时 errors/limitations 必须说明，不能假装完整。
10. 所有错误代码脱敏。请求非法用 INVALID_REQUEST；无效游标用 INVALID_CURSOR；预期上游失败用 JSON 状态，不作为无解释的空数组。调用者 AbortSignal 取消时内部抛 AbortError，调度器记录 cancelled；工具若还能正常返回可使用 cancelled envelope，不能保证已断开的客户端接收。

## 缓存、分页及存储决定

- 全部结构化表存 EXPLORER_DB_PATH 指向的活动库，默认 data/events.db；不写 sessions.db。每条连接启用 foreign_keys，写事务短且串行，网络和模型等待不得占用写事务。锁等待初始上限 1 秒，并受父 deadline 限制。
- 文档快照放活动库同级 search-snapshots/，内容哈希寻址；路径限定在该目录。数据库保存版本 hash/路径，被证据引用的版本保留。
- search_runs 增加 request_key、response_json、cache_until、snapshot_until：完整冻结响应支持分页，不依赖会变化的文档最新字段。长正文快照存文件，不重复放完整响应。response_json 不含游标秘密。
- 缓存 key 包括标准化参数（不含 cursor）、作用域、schema/调度版本、启用渠道及能力版本；默认外部搜索缓存 10 分钟，失败不做成功缓存，partial 默认不复用。freshness=refresh 不读旧缓存。平台 TTL 可配置，阶段 2 实测后调整。
- 成功快照分页有效期 30 分钟；执行与结果关联保留 7 天；无活动证据引用的孤立文档/快照 30 天后可清理。删除顺序先过期 run/result，再检查文档引用和快照引用；引用中的资料不删。不自动清理 activities/events。
- 搜索缓存有效不代表活动可规划状态有效。读取活动必须独立检查状态、适用日期与新鲜度。旧响应重放前重新校验 event 资格，失效则降为资料/不可规划并披露结果变化；不得盲目重放 cancelled 活动。分页顺序和成员固定，资格可因取消变化。
- 后续活动 freshness 初始上限：临时活动 6 小时、常态开放规则 24 小时；时段不跨已知有效期。仅是工程初值，不能承诺实际无变更。
- 现有历史协议展示“已存行程 + 当前活动详情”，阶段 0 选择保持这一语义，不承诺当时详情快照。未来增加可选状态字段，取消/过期保留 ID，不删除。若要展示预订时快照，应另立版本升级任务。

## 生命周期和预算

默认单次搜索总预算 12 秒、单渠道最多 5 秒、全局同时 4 请求、每渠道默认 1；最多一次可重试错误重试（限流/超时/暂时网络失败），须有剩余预算并遵循 Retry-After，不重试鉴权错误。详情与提取若启用，共享这 12 秒，不能再加一轮独立 12 秒。

同一轮 Planner 多次工具调用共享累计 20 秒搜索预算；在 Web service/Planner 作用域传递，而不是全局变量。现有前端 POST 60 秒是客户端上限，并非后端已实现的整轮硬截止时间。阶段 6 需接入剩余预算与取消传播；搜索预算不能保证模型总回复必在 60 秒内。

结果当前页最大 50、默认 20；JSON UTF-8 初始上限 64 KiB，单摘要最多 1000 字，正文片段最多 2000 字，不直接向模型塞整页原文。到达字节预算提前分页并标记截断；单条过长可截片段并加 content_truncated，保留原始快照。文本 content 与结构化 JSON 同值。

## 渠道能力矩阵基线

所有外部能力均为 unverified，不把候选服务描述为已接通。配置能力应分别记录“供应商声称”和“实测验证”，调度只依赖验证结果。

| 目标平台 | 优先路径 | 补充路径 | 待验证项 |
| --- | --- | --- | --- |
| 小红书 | 专用授权/第三方搜索 | 网页搜索 | 原始链接、关键词、分页、时间与正文 |
| 抖音 | 专用搜索 | 网页搜索 | 视频/图文、地点、时间、可获取字段 |
| 微博 | 专用搜索 | 网页搜索 | 最新排序、历史范围、分页 |
| 微信公众号 | 文章搜索服务 | 网页搜索 | 原文链接、发布时间、正文；不含私域 |
| B站 | 平台搜索 | 网页搜索 | 视频链接、时间、简介 |
| 豆瓣、活动行 | 公开站内搜索 | 网页搜索 | 西安过滤、详情、场次语义 |
| 秀动、大麦、猫眼 | 可用平台接入 | 网页搜索 | 项目与场次、票价、可访问性 |
| 本地宝、旅游平台 | 网页搜索 | 站点适配器 | 过期文章、来源、内容类型 |
| 场馆、商场等 | 网页搜索 | 固定站点适配器 | 公告、变更、适用分馆 |
| 本地 SQLite | 现有 EventRepository | 无 | 已有 date/category/keyword；100 条上限需阶段 4 增加内部分页 |

接口层只接收主 Agent 参数，不自行扩展用户兴趣；为渠道适配添加西安限定词、格式化日期是机械转换，必须记录实际发送查询。

## 集成与兼容清单

- src/agent/tools.ts：阶段 6 注入 SearchService，替换旧数组返回；不得同时出现旧、新两个同名工具。
- src/agent/explorer-agent.ts、agent/session.ts：装配与生命周期传递，仍只挂一个工具；旧查询参数继续有效，响应升级是显式破坏性变更，必须与提示同步，不能称为输出向后兼容。
- src/agent/prompt.ts：读取 results 的 document/event，只有 plannable event 才可引用；不信任外部内容指令。
- src/data/repository.ts/sqlite.ts：读接口保留，新增独立发布接口；共享同一活动库与受控连接。getByIds 保留历史记录，不能简单加 active 过滤。
- src/agent/session.ts、itinerary/validation.ts：发布状态与 fixed 校验在规划提交前复查；不存在的 ID 始终拒绝。
- src/web/service.ts/types.ts：source 字段映射、可选状态字段和当前详情恢复；ChatResult 的 itinerary/clarification 外壳维持。
- frontend/chat.js：仍消费 ChatResult，不直接接收 SearchResponse；未知资料不得画地图路线。检索所有旧字段引用后再改。
- test/contracts、agent、agent-e2e、data、schema-migration、web-service/history 等测试按实际影响更新。

## source_url 非破坏迁移决定

阶段 5 先在旧 events 上追加 source_url，NULL 默认，保留 guide_url 原列及值；实际迁移按 table_info 幂等判断，并记录版本。禁止一条 UPDATE 将所有攻略认定来源。

新版 TS/API 只使用 sourceUrl/source_url，读 source_url 不回退 guide_url；新数据要求具体来源页。旧 seed 如是虚构攻略不回填 source，更新 fixture/seed 映射但不自动执行 seed。新版本不再写 guide_url。旧列为历史保留，后续明确兼容周期再考虑重建表移除；不承诺新旧程序并发双向写兼容。

验证旧行、ID 和 guide 值保留，新列 NULL、重复迁移幂等、失败回滚、未知旧值不回填、查询/工具/Web 映射一致。DDL 草案仅演示一次升级，幂等实现属于阶段 5。

## 阶段 0 验收与下一步

运行：`python docs/search-stage-0/verify.py`。全部设计样例通过 schema 子集与业务检查；反例必须被拒绝；临时 SQLite 创建成功并检查外键、唯一性、JSON 与旧值保留。不执行任何生产数据库迁移，不访问平台或模型 API。

本基线是项目内可实现约定，不表示主 Agent 另一位负责人已确认；对接时如修改字段应版本化更新 schema、样例及测试。尚待后续阶段验证：供应商、平台权限与能力、真实耗时成本、提取模型。以上不阻碍阶段 1 假渠道实现。
