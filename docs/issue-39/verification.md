# Issue #39 集成验收记录（I39-5）

基线：`61d93f1`（base）→ 集成提交见本分支 head。分支 `issue39-process-events`。
worktree：`/Users/lmy/.lody/repos/local---e13ea63c064f/worktrees/22b61a31-6c0b-48a5-9393-9e4563d196de`

## 1. 命令与结果

| 命令 | 结果 |
|---|---|
| `npm run check`（`tsc --noEmit` + `node --test "test/**/*.test.ts"`） | 0 类型错误；**943 tests 全绿**（基线 916 → +27） |
| `npm run check:frontend`（全部 frontend/*.js `node --check`） | 通过（本 issue 未改前端，回归确认） |
| `npx node --test test/web-sse.test.ts test/web-sse-e2e.test.ts test/frontend-progress-events.test.ts` | 23/23 |
| `npx node --test test/agent-progress.test.ts test/agent-delegate-progress.test.ts test/agent-tool-progress.test.ts` | 28/28（含 I39-2 启动失败真实 runId/status 用例） |

## 2. 契约↔实现核对（以最终文件为准）

- `subagent_done.title` 必填 ≤40 码点：`progress.ts` builder 强约束，`delegate.ts` 以 spawned 同源标题回传；`agent-api.md`/`coordination.md` 已同步。
- 未知工具参数摘要不透键值：`summarizeToolArgs` default 分支只报 `N 项参数`；白名单仅 search_events/delegate_task/estimate_travel/web_search。
- `result_count` 真实推导：`toolResultCount(toolName, result)` —— details.count / web_search results[] / delegate_task itinerary.stops[]；推导不出 null，不凑数。
- spawn 失败 `childRun*`：catch 路径走 `listRunsBySession` 如实抄录，查无才 null；`coordination.md §7.2` 已改写，不凌驾落库真相。
- 终态权威：`child_run_status` 抄录 DB 持久化状态（父取消瞬间可为 `running`，不伪装）；`doneEmitted` 幂等 + catch 兜底保 spawn:done 恒 1:1。
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
