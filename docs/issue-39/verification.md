# Issue #39 集成验收记录（R4 复验轮）

基线：`61d93f1`（base）→ 分支 `issue39-process-events`，最终 head 见
`git rev-parse HEAD`（R4 统一提交点）。
worktree：`/Users/lmy/.lody/repos/local---e13ea63c064f/worktrees/22b61a31-6c0b-48a5-9393-9e4563d196de`

> 状态：**修复已集成，待独立复审**。R1（嵌套盖章）/R2（终局点 done）
> /R3（文档快照语义）全部落地并复验通过；不自称 review 通过。

## 1. 命令与结果（R4，最终态）

| 命令 | 结果 |
|---|---|
| `npm run check`（`tsc --noEmit` + `node --test "test/**/*.test.ts"`） | 0 类型错误；**949 tests 全绿** |
| `npm run check:frontend`（全部 frontend/*.js `node --check`） | 通过（本 issue 未改前端，回归确认） |
| `git diff --check` | 干净（无空白错误） |
| `npx node --test test/agent-delegate-progress.test.ts` 等 R1/R2 回归 | 含在 949 内全绿（delegate 相关 32 例） |

测试数口径：base `61d93f1` 实有 **908** → 最终 **949**，本 issue 净增
**+41**（含首轮 943 + R1/R2 回归 6 例）。

## 2. R1/R2 修复与语义变更（相对首轮 edbf01f）

- **R1 嵌套盖章归属修复**（progress.ts `stampSubagent`）：事件已带
  `subagent_id`（孙会话产出）时保留原值不重盖，只给未归属事件补盖
  当前 child id；stage 帧原样返回（本就不透传）。回归：纯函数用例 +
  真实父/子/孙三层 faux+SQLite 派发，事件按产生层精确归属。
- **R2 终局点 done 重构**（delegate.ts execute 尾段）：
  1. turn/异常先折算初步 `details`（`runId` 占位）——不发事件；
  2. `child.close()` 落定：close 拒绝且结果已成功者降级 `failed`，
     `cancelled`/`failed` 保留首因不被覆盖；spawn 后意外异常收编为
     结构化 `failed` details 同路返回（父模型按既有 isError 降级）；
  3. 紧挨 done 发射前统一 `listRunsBySession.at(-1)` 快照回填
     `details.runId` 与 `childRunStatus`；
  4. 唯一 `finish`：emitDone + 返回同源 `toResult`——done 永不先于
     终局发出，取消/close 拒绝/spawn 后异常均仍只一个 done。
  透传回调生命周期 = `child.prompt` 调用期（`forwardEvents` 封口），
  其后含 close 与 done 之后的悬挂子事件不再透传。
- **R3 文档统一**：`child_run_*` 全库统一为"done 发射瞬间 DB 状态
  快照"语义（快照取在 close 落定后、紧邻发射；可与父视角 `status`
  不同，竞态如实 `running`、启动失败半成品 run 如实抄录、查无 null；
  消费者不得据此猜测终结，服务端不做 running→终态追帧）。源码注释
  （progress.ts/delegate.ts）已与文档同口径。

## 3. 契约↔实现核对（以最终文件为准）

- `subagent_done.title` 必填 ≤40 码点：builder 强约束，delegate 以
  spawned 同源标题回传。
- 未知工具参数摘要不透键值：`summarizeToolArgs` default 只报 `N 项参数`。
- `result_count` 真实推导：`toolResultCount(toolName, result)`——
  details.count / web_search results[] / delegate_task itinerary.stops[]；
  推导不出 null。
- spawn 失败与终局点 `childRun*` 均走 `listRunsBySession` 如实抄录。
- 兼容：stage 帧无 `type` 键字节级不变；新事件恒带 ≤160 码点单行
  `message`；`safeEmit` 吞 sink 异常；新类型留在 `progress` 帧内。

## 4. 证据点（faux provider + 真实 HTTP/SSE/SQLite 栈）

- **成功**：spawned×2（plan_id A/B、title、parent_run_id 同源）、子侧
  `tool_call` 盖章 `subagent_id` 透父流、done×2 completed、spawn:done
  按 `subagent_id` 配对（web-sse-e2e 并行派发用例）。
- **父取消**：断连前实见 `subagent_spawned`；断连后以会话库验证父/子
  run cancelled、租约释放，不伪称收帧。
- **子超时**：`subagentTimeoutMs:150` + 慢 child faux → done.status
  `cancelled`，child_run_id/child_run_status 与 DB 逐一对账；父轮降级
  照常输出 result。
- **旧前端**：真实 `transport.js`+`chat.js` 逐帧录 `textContent`——
  手写新类型帧与 day0 stream.sse 均无 `undefined`/无通用兜底。
- **R2 回归**：close 拒绝降级、首因保留、spawn 后异常结构化 failed、
  prompt 落定封口（delegate-progress 32 例内）。

## 5. 历史记录：首轮 review（@edbf01f）

独立 reviewer 判 943 全绿但暂不可交付：P2-1 嵌套 `stampSubagent` 覆盖
归属、P2-2 `child.close` 拒绝致 done 与抛错矛盾、P3 文档"持久化终态"
表述失准。三项均已修复并复验（见 §1/§2）。

## 6. 未验边界（诚实声明）

- 全部模型交互经 faux provider；真实 LLM/SDK 未覆盖。
- 事件频率/气泡闪烁未做人工 UX 走查；独立 SSE event 名逃生阀未预置。
- 并行工具下 `subagent_done`/`tool_call` 相对顺序不保证（测试按集合断言）。
- 子会话事件透传依赖 `child.prompt({onProgress})` 挂接且仅 prompt 调用
  期存活；嵌套（孙）事件经逐层透传归顶，超出深度限制的层级按既有
  深度闸不派发。
