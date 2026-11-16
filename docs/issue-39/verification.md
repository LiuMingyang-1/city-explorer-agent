# Issue #39 集成验收记录（I39-5，首轮）

基线：`61d93f1`（base）→ 首轮集成提交 `edbf01f`。分支 `issue39-process-events`。
worktree：`/Users/lmy/.lody/repos/local---e13ea63c064f/worktrees/22b61a31-6c0b-48a5-9393-9e4563d196de`

> 状态：**首轮验证通过但独立 review 发现 2×P2 + 1×P3，修复中——
> 尚不可交付**。最终验收结果待修复交齐复验后补记（见 §5）。

## 1. 命令与结果（首轮，@edbf01f）

| 命令 | 结果 |
|---|---|
| `npm run check`（`tsc --noEmit` + `node --test "test/**/*.test.ts"`） | 0 类型错误；**943 tests 全绿** |
| `npm run check:frontend`（全部 frontend/*.js `node --check`） | 通过（本 issue 未改前端，回归确认） |
| `npx node --test test/web-sse.test.ts test/web-sse-e2e.test.ts test/frontend-progress-events.test.ts` | 23/23 |
| `npx node --test test/agent-progress.test.ts test/agent-delegate-progress.test.ts test/agent-tool-progress.test.ts` | 28/28（含 I39-2 启动失败真实 runId/status 用例） |

测试数口径：base `61d93f1` 实有 **908**（骨架提交 `a8b57b6` 后 916，
其中骨架新增 `agent-progress.test.ts` 8 例）→ head 943，**本 issue
净增 +35**。此前「916→+27」的写法把骨架后计数误作 base，已更正。

## 2. 契约↔实现核对（以最终文件为准）

- `subagent_done.title` 必填 ≤40 码点：`progress.ts` builder 强约束，`delegate.ts` 以 spawned 同源标题回传；`agent-api.md`/`coordination.md` 已同步。
- 未知工具参数摘要不透键值：`summarizeToolArgs` default 分支只报 `N 项参数`；白名单仅 search_events/delegate_task/estimate_travel/web_search。
- `result_count` 真实推导：`toolResultCount(toolName, result)` —— details.count / web_search results[] / delegate_task itinerary.stops[]；推导不出 null，不凑数。
- spawn 失败 `childRun*`：catch 路径走 `listRunsBySession` 如实抄录，查无才 null；`coordination.md §7.2` 已改写，不凌驾落库真相。
- `child_run_status` 语义：发射瞬间 DB 状态快照（非"已终结"承诺）——
  父取消/超时竞态可如实为 `running`，与父视角 `status` 可不同；
  `doneEmitted` 幂等 + catch 兜底保 spawn:done 恒 1:1。
- 兼容：stage 帧无 `type` 键字节级不变；新事件恒带 ≤160 码点单行 `message`；`safeEmit` 吞 sink 异常（单测覆盖）；`transport.js` 只认 `meta/progress/result/error`，新类型留在 `progress` 帧内。

## 3. 证据点（faux provider + 真实 HTTP/SSE/SQLite 栈）

- **成功**：`web-sse-e2e`「并行派发」—— spawned×2（plan_id A/B、title、parent_run_id 同源）、子侧 `tool_call` 盖章 `subagent_id` 透父流、done×2（completed/itinerary/stops_count/child_run_status=completed），spawn:done 按 `subagent_id` 配对。
- **父取消**：客户端断连前实见 `subagent_spawned`；断连后不伪称收帧——以会话库验证父 run cancelled、child run cancelled、租约释放。
- **子超时**：注入 `subagentTimeoutMs:150` + 慢 child faux → `done.status="cancelled"`，`child_run_id`/`child_run_status` 与 DB 逐一对账；父轮降级照常输出 result。
- **旧前端**：`frontend-progress-events` 用真实 `transport.js`+`chat.js` 逐帧录 `status.textContent`——手写新类型帧与 `docs/mocks/day0/stream.sse` 均无 `undefined`、无「正在整理方案」兜底；day0 样例即被真实 transport 消费的直接证据。
- **样例修复**：发现既有派发用例 `content===string` 分流从不命中（`agent.prompt` 恒产 parts 数组），B 子任务曾静默打向耗尽核失败——已修 `firstUserText`。

## 4. 未验边界（诚实声明）

- 全部模型交互经 faux provider；真实 LLM/SDK（流式分块、真实 tool_call id 形态、网络抖动）未覆盖。
- 事件频率/气泡闪烁未做人工 UX 走查；逃生阀（独立 SSE event 名）契约 §8 留有方案，未预置。
- `subagent_done` 与 `tool_call` 相对顺序在并行工具下不保证；测试按集合断言，消费端勿依赖交错序。
- 子会话内部 tool_call 透传依赖 dispatch 上下文挂接；非委派路径（如未来其他子会话来源）需同样走 `child.prompt({onProgress})` 才会盖章上达。

## 5. 首轮 review 发现与修复指派（@edbf01f，修复进行中）

独立 reviewer 判 943 全绿但暂不可交付，发现 2×P2 + 1×P3：

- **P2-1 嵌套 `stampSubagent` 覆盖真实归属**（`progress.ts`，I39-3 修）：
  多层派发时子事件已带 `subagent_id`，再经外层 `stampSubagent` 会被
  覆盖为中间层 id，grandchild 事件归属失真。回归要求：已带
  `subagent_id` 的事件透传时不得被重写；嵌套场景（child→grandchild）
  事件须携带最末层真实 subagent_id 上达顶层 sink，并有对应单测。
- **P2-2 `child.close` 拒绝使终态矛盾**（`delegate.ts`，I39-2 修）：
  已发 `completed` done 后 `child.close()` 抛错会上抛，与已宣告的
  成功终态自相矛盾；并评估 done 之后过期回调门控（防晚到帧二次发射）。
  回归要求：close 失败不得推翻已发 done 终态；done 之后不再有任何
  同一 subagent 的二次 done/迟发帧；补针对性单测。
- **P3 文档语义**（本文件/`agent-api.md`/`coordination.md`，R3 已修）：
  `child_run_status` 原称"持久化终态"与实现允许 `running` 不符，
  已统一为"发射时 DB 状态快照"语义并列出竞态/启动失败行为；
  源代码注释由文件所有者随后核对（R3 不跨改 progress/delegate）。

修复交齐后须重跑 `npm run check` + 本条所列回归用例，最终验收结果
另行补记，本记录不提前宣称通过。
