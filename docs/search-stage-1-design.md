# 阶段 1 设计：离线搜索骨架与最小持久化

状态：已实现并通过阶段 1 测试，实际范围与验证结果见[验收记录](search-stage-1-acceptance.md)。依据：[总规划](search-implementation-plan.md)、[阶段 0 基线](search-stage-0/README.md)。本阶段只使用假渠道，不调用搜索平台或模型 API，不接入现有主 Agent tool，不修改活动数据。

## 1. 阶段目标及边界

实现一个可独立调用的 `SearchService`，接收阶段 0 参数，调度注入的假渠道，返回符合契约的 JSON，并保存执行记录、文档和结果关联。离线证明超时、取消、并发、去重、持久化与分页可用。

本阶段返回结果全部为 `document`，不能生成 `event_id` 或宣称可规划。阶段 0 的活动和写回失败样例继续作为完整响应契约测试，不代表阶段 1 已实现活动发布。

- 建立 `search_runs/search_documents/search_run_results`，不建立后续地点、活动、证据表。
- 不改 `src/agent/tools.ts`、Planner、Web、前端及现有 `EventRepository`。
- 不实现本地活动混合搜索、正文抓取、模型提取、活动写回、`guide_url` 迁移。它们分别属于后续阶段。
- `mode=external` 可完整执行假外部渠道。`local` 返回明确的 `LOCAL_NOT_IMPLEMENTED` 失败；`hybrid` 执行假外部渠道，同时报告本地覆盖缺失，因此为 partial。不把尚未实现的分支当成功。
- 阶段 0 默认 hybrid 保持不变；本阶段主验收样例显式使用 external，避免偷偷改变默认语义。

## 2. 模块关系与建议文件

```text
调用方 → service
          ├─ contract：请求校验、默认值、响应校验
          ├─ registry：渠道登记、平台能力、执行计划
          ├─ scheduler：队列、截止时间、并发、重试、取消
          │     └─ 注入的 SearchAdapter
          ├─ normalize：URL 身份、命中校验、去重、排名
          ├─ snapshot：页切分、游标、响应体预算
          └─ repository：SQLite 短事务
```

| 建议路径 | 职责 |
| --- | --- |
| `src/search/types.ts` | 请求、响应、适配器、时钟和仓库类型 |
| `src/search/contract.ts` | 标准化与 schema/业务不变量校验 |
| `src/search/registry.ts` | 渠道能力与请求的平台路由 |
| `src/search/scheduler.ts` | 执行控制，不处理 SQL 和活动语义 |
| `src/search/normalize.ts` | 命中校验、URL 规范化、去重和排名融合 |
| `src/search/snapshot.ts` | 冻结结果、生成页和校验游标 |
| `src/search/service.ts` | 编排上述组件，决定最终状态 |
| `src/search/schema.ts` | 仅三张搜索表的幂等迁移 |
| `src/search/repository.ts` | 持久化接口 |
| `src/search/sqlite.ts` | Node 内置 SQLite 实现 |
| `test/search-fixture.ts` | 假渠道、可控时间、临时库 |
| `test/search-*.test.ts` | 按下文关卡拆分的行为测试 |

按职责实现，若某模块只有少量代码可合并，不为文件数量机械拆分。假渠道放在 test，不在生产代码中启用虚假平台。

### 2.1 服务上下文

沿用阶段 0 的 signal/deadline，补充必填 `scopeKey`，由调用方提供服务端内部作用域，不能由 tool JSON 自行指定。阶段 1 使用测试作用域；阶段 6 从用户/会话上下文注入。

注入 `Clock`（当前时间、可取消等待）、ID/随机令牌生成器、搜索仓库和渠道注册表。生产默认使用真实时钟与加密随机数；测试不依赖长时间 sleep。

适配器只接受标准查询，返回规范化 hits、实际生效的过滤条件、限制及供应商后页令牌。适配器不写库、不做重试、不生成面向主 Agent 的游标。服务不会扩展用户兴趣；只做平台参数映射和西安范围限定。

## 3. 一次搜索的状态流

1. 校验 unknown 字段、类型、长度、真实日期；trim 文本，补默认值，平台数组排序去重。非法请求抛带代码的 `SearchRequestError`，不创建运行记录。
2. 已取消或父 deadline 已过期则直接终止，不发渠道请求；有游标则走分页读取，不重新搜索。
3. 建立 running 记录，保存标准请求、scope 和执行计划。创建失败立即抛 `SearchStorageError`，不先调用收费渠道。
4. 只路由 enabled 渠道；显式请求平台无可用渠道时记录 unsupported。平台省略时按已启用能力计划，不宣称覆盖所有候选平台。没有可运行渠道返回 failed/NO_CHANNEL_AVAILABLE。
5. 按预算执行计划，命中校验、规范化、去重、排名。中途失败保留其他成功渠道结果。
6. 冻结结果成员与顺序，切页，检查完整 JSON 字节预算，计算最终状态及 coverage。
7. 一个短事务内 upsert 文档、写关联、保存快照、终结 run。事务成功才返回已持久化响应。
8. 完成持久化失败，回滚文档及关联，尽力单独标记 run failed；向调用方抛 `SearchStorageError`，不伪装已保存或返回假分页游标。可重放读库错误同理。

正常终态：success / partial / failed。父调用取消：记录 cancelled，内部抛 AbortError；不将其转换为 TIMEOUT。进程中断留下的 running 不参与缓存；阶段 1 不自动把其他进程仍运行的记录判为失败，后续清理按保留期处理。

服务提供 `close()`：停止接收新请求，取消并等待自己管理的任务收尾，再由连接所有者关闭库；多次调用幂等。连接是否由服务拥有在构造时明确，不关闭调用方借用的连接。

## 4. 调度规则

### 4.1 并发与截止时间

- 服务实例共享全局信号量（默认 4），按 channel 共享单渠道信号量（默认 1）；限制必须跨同时到达的多次搜索生效。
- 每次调用总预算 12 秒且不超过父 deadline；每次实际渠道请求最多 5 秒。排队消耗总预算，不能出队后重新获得完整总预算。
- 排队时取消可移除任务；未启动渠道记录 timeout/cancelled，不调用适配器。
- 父信号、全局截止和单请求截止合成子 AbortSignal；完成后解除监听和定时器。
- 不能只用 Promise.race 后释放槽位：适配器未实际 settled 时保留其执行槽位，忽略晚到结果，避免后台真实并发失控。适配器必须遵守取消契约；测试覆盖不配合取消的假渠道，用手动释放保证测试收尾。
- 每轮 Planner 的 20 秒累计预算留给阶段 6；本阶段只消费调用方传入的剩余 deadline。

### 4.2 重试与分页

- 每次渠道搜索页最多一次重试；仅限暂时网络失败、超时、限流。鉴权、非法响应、取消不重试。
- 初始退避 200ms；有 Retry-After 时等待更长者。等待及重试都在原预算内，等待时不占网络槽位。
- 初始渠道请求每个最多 20 条，尊重其 maxPageSize。取得的供应商后页只在同一次搜索预算内使用，不把供应商 cursor 暴露给主 Agent。
- 本阶段每渠道最多 2 页、全局最多 200 个原始命中。达到上限且渠道有后页时标记 upstream_truncated；不能声称已搜完。重复的后页令牌立即停止并记录限制，防止死循环。
- 首版不同时实现复杂备用渠道与熔断：覆盖失败明确报告，重试与后页已足够验证核心调度。跨供应商备用路由、熔断在真实渠道接入后根据故障模式补充。

## 5. 命中处理与结果顺序

- 适配器输出也视为外部输入：校验类型、时间、排名、URL 和平台范围；非法单条剔除并报告 INVALID_HIT，整个页格式不合法则 INVALID_RESPONSE。
- 仅接受无凭据的 http/https URL；本阶段不访问 URL，不解析短链，不做 DNS 请求。后续抓取阶段再加重定向和网络目标检查。
- URL 规范化采用 URL 解析器：主机标准化、移除 fragment 和明确允许删除的跟踪参数，保留身份参数。不同内容不能因过度清洗合并。
- 同平台内容 ID 优先，同规范化 URL 其次；出现 ID/URL 对应两个已有文档的冲突时采用事务内确定性合并策略，不能简单 INSERT OR REPLACE 删除已有引用。
- 第一版身份冲突保守处理：不跨既有 document_id 自动合并；拒绝该冲突命中并报 IDENTITY_CONFLICT，其他命中继续。没有可靠平台 ID 时宁可保留候选重复，不按相似标题强行去重。
- 去重后合并 channels；标题/摘要按固定渠道优先级及原排名选择，不能由请求完成先后决定结果。
- 使用 RRF 排名：同一渠道同一文档只贡献一次，按该渠道最优原排名计算 `1/(60+rank)`；平分按渠道优先级、规范化 URL 决定。固定输入的结果不随并发完成顺序改变。
- 阶段 1 不从关键词判断活动日期和城市，document 的 city_status/date_status 为 unknown；支持适配器明确提供范围外标记后再扩充 schema。所有结果 plannable=false。

## 6. 三张表落地及最小迁移

阶段 0 DDL 草案的前三张表是起点。设计细化后补齐以下字段，不执行后续 activities/events ALTER：

| 表 | 阶段 1 补充 | 原因 |
| --- | --- | --- |
| search_runs | `scope_key` | 游标与缓存隔离，不能仅凭 search_id 跨作用域访问 |
| search_runs | `cursor_state_json` | 保存随机游标的哈希及偏移、过期时间，不塞进公共 response_json |
| search_runs | `request_key/response_json/cache_until/snapshot_until` | 阶段 0 已设计的缓存和冻结快照字段 |

`response_json` 存内部快照封装：去重有序 results、公共响应元信息及确定后的分页边界，不仅是第一页。最多 200 个原始命中带来的有限结果；不含原始大正文和游标原文。公共响应仍严格遵守 response schema。

`cursor_state_json` 存哈希到下一页边界的映射。随机 256 bit 原令牌仅返回调用方，存储 SHA-256；token 携带 search_id 作为定位提示，仍必须同时验证 scope、哈希、请求与有效期。重复使用同一个游标返回同一页；已生成后继令牌无法从哈希复原，因此每次可生成不同后继令牌，但页内容和偏移相同。限制每 run 活跃令牌数量（默认 128），超限明确报 CURSOR_LIMIT，不能无界增长。

所有连接启用外键；迁移只对已有文件显式打开，不在 CLI/Web 启动时接线。新库可以只含搜索表；与 events 共库时不得改已有活动。`CREATE TABLE/INDEX IF NOT EXISTS` 加列检查在事务内完成；保留未知表及既有数据，禁止 seed、清表、PRAGMA user_version 覆盖其他模块的版本号。

文档主键为稳定随机 ID，唯一索引承担并发去重。相同命中重复持久化通过 UPSERT 更新允许更新的文档字段；first_seen_at 不变，抓取失败不覆盖已有成功正文。无全文内容的阶段 1 不生成伪 content_hash 或快照文件。

仓库建议方法：`beginRun`、`completeRun`、`failRun`、`getSnapshot`、`issueCursor`、`resolveCursor`、`close`。网络与等待在事务外；completeRun 的文档/关联/快照/终态写入为一个事务。SQLite 同步锁等待必须按当前剩余预算缩短，避免固定 1 秒阻塞超过父 deadline。

## 7. 分页、预算与缓存范围

- 第一版只完成快照分页，不实现搜索结果缓存命中复用；cache_until 保留且为 NULL，缓存读取到阶段 2–4 落地。分页快照不等于搜索缓存。
- `limit` 决定每页条数，完整 JSON 还受 64 KiB 限制；按 Unicode 字符边界截摘要，每次序列化以 UTF-8 字节数计算，包括 coverage/errors 和游标。
- 超大 metadata 不能靠清空 results 掩盖：限制注册渠道数（初值 32）、错误数及字符串长度，超出以汇总代码表示；最低 envelope 都放不下时报 RESPONSE_TOO_LARGE。
- 有后页则 next_cursor 非空、truncated=true；最后一页无后页时 next_cursor=null。即使本地快照页已读完，上游仍被截断时 truncated 仍为 true，并说明 upstream_truncated。
- 游标有效期 30 分钟，run 记录保留 7 天；阶段 1 只验证过期拒绝和清理顺序，不启动定时任务、不删除实际用户资料。清理方法只接受显式 now，测试临时库验证。
- 分页请求不新建 tool 搜索 run、不重新调渠道；原 search_id 不变。是否需要每次分页调用审计日志属于后续观测任务。

## 8. 正式契约校验器选择

阶段 1 计划使用 Ajv 的 2020-12 实现验证阶段 0 JSON Schema，作为运行时依赖；安装时锁定实际版本并更新 lockfile，不使用 Python 子集验证器作为运行时校验。包接口及 Node ESM 导入方式在实现时按正式文档验证。

schema 从单一权威来源复用：本阶段可以直接加载 docs/search-stage-0 中的 JSON（仓库直接运行，无打包）；以后发布制品时再迁到 src/contracts 并更新文档引用，禁止维护两份会分叉的 schema。服务业务检查补充真实日期、判别结果类型、状态组合等 schema 未覆盖的不变量。

阶段 0 全部 9 个样例必须通过正式校验器；其余 8 个反例按 schema 或业务规则拒绝。独立补充响应坏样例，不能仅测试实现自己生成的 JSON。

## 9. 实现顺序与测试关卡

每个关卡通过后再进入下一关；这是阶段 1 内部的推进顺序，不表示提前进入外部接入阶段。

| 关卡 | 产物 | 必须验证的行为 |
| --- | --- | --- |
| 1A 契约与假渠道 | types、正式校验器、fixture | 9 个阶段 0 正例、8 个反例；默认值、未知字段、假日期、空文本、unsupported 平台 |
| 1B 最小仓库 | 三张表与仓库 | 新建/重复迁移、旧活动完全保留、外键/唯一性、失败回滚、重复写入、身份冲突、关闭重开 |
| 1C 调度器 | registry、scheduler | 跨搜索全局/渠道并发、排队超时、单请求超时、父取消、重试上限、Retry-After、迟到结果丢弃、槽位释放、重复页令牌 |
| 1D 合并与分页 | normalize、snapshot | 跨渠道同文档去重、不同文档不误合并、排序与完成先后无关、UTF-8 预算、页不重漏、过期/跨作用域/参数改变游标拒绝 |
| 1E 服务集成 | service | 成功零命中、仅资料、部分失败、全失败、持久化错误、模式未实现说明、取消收尾、分页不再次搜索 |
| 1F 回归与报告 | 验收文档 | 搜索测试、typecheck、项目现有测试通过；确认未接线旧 tool，未访问真实服务 |

测试用 Node 内置 node:test 与临时 SQLite，参考现有 fixture 的创建及 t.after 清理方式。时钟控制超时、退避、TTL；门闩控制假渠道开始和释放。仅少量真实定时器冒烟验证 AbortSignal 接线，不使用长等待掩盖竞态。

故障注入包括：beginRun 失败、completeRun 中途失败、终态记录失败、JSON 损坏、锁等待、渠道抛非 Error、返回坏页面、忽略取消。对无法落盘的错误明确抛出并释放资源，不声称数据库一定有完整审计。

建议执行命令：

```powershell
# 实现时先安装锁定依赖，再按关卡逐步运行具体测试文件。
node --test "test/search-*.test.ts"
npm run check
python docs/search-stage-0/verify.py
```

不因阶段 1 未动前端而额外引入前端测试。若环境/现有测试阻塞，报告原始原因，不跳过必需检查后宣称完成。

## 10. 完成定义及后续接缝

完成定义：独立 SearchService 在假渠道下完整运行、三张表可持久恢复、预算和取消可控、JSON/分页契约一致、相关测试与既有回归通过。只在完成后更新总规划为“阶段 1 实现完成”。

阶段 2 接入真实网页搜索只需新增适配器及服务端配置；阶段 3 复用同一调度接口扩平台；阶段 4 加本地活动和有效缓存；阶段 5 在文档结果之后增加事实提取与发布；阶段 6 才替换主 Agent 工具的数组返回及提示。`guide_url → source_url` 仍属于阶段 5，不在本阶段提前修改。
