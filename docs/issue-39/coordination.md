# Issue #39 协调文档：过程事件契约（I39-1 交付）

> 范围：`src/agent/progress.ts` 事件契约 + dispatch 透传骨架。
> 本文是 I39-2（delegate 生命周期发射点）、I39-3（tool_call 发射）、
> I39-4（SSE 文档/样例/faux 测试）的共享接口约定。

## 1. 事件通道与兼容底线

- **全部事件走 SSE `progress` 帧**（`event: progress`），单一通道天然保序；
  载荷是 `PlannerProcessEvent` 联合，以 `data.type` 判别。
- 旧 4 个 stage（`searching_events / exploring_plans / routing /
  validating_schedule`）**wire 形状字节级不变**：`{stage,message,plan_ids}`，
  **不带 type 键**；消费端用 `event.type ?? "stage"` 归一。
  `web-sse-e2e` 对 stage 帧做 deepEqual，前端 `chat.js` 只读
  `message`/`stage`——两边零改动兼容。
- 新事件一律带 `message` 单行文案：旧前端 progress 气泡取
  `progress.message` 兜底展示（graceful degradation），新前端按 type 分流。
- 备选：若前端要求独立 event 名（`event: subagent_spawned`），只需 I39-4
  在 `http.ts` 加一行映射，契约字段不变。

### 旧前端兼容硬约定（chat.js 逐帧覆盖 `status.textContent`）

旧前端对**每一条** progress 帧执行
`textContent = progress.message || stageNames[stage] || '正在整理方案'`。
防回退/防闪烁据此立约：

1. **message 恒非空**：所有事件必须经 `progress.ts` 的 builders 构造
   （`stageProgress/subagentSpawnedEvent/subagentDoneEvent/toolCallEvent`），
   message 由模板组合 + clipText 产出，恒为非空单行——禁止手写事件对象
   绕过 builders（I39-2/3 评审项）。由此新事件永不落入 `stageNames` /
   `'正在整理方案'` 兜底。
2. **stage 帧保持旧序旧形**：父轮 stage 序列不被子会话插入（stage 属
   本轮私有叙事、不透传），`searching→exploring→routing→validating`
   文案演进与今一致。
3. **新事件帧是实时 narrate 而非 stage**：它们会覆盖气泡文案为真实动作
   （如「正在派发子任务「方案A」」「search_events date=…：12 条」），
   语义上不低于 stage 帧信息密度——这是设计内的活报，不是回退。
4. **逃生阀（I39-4 决策项）**：若联调实测高频帧导致气泡闪烁观感差，
   将三类新事件改发独立 SSE event 名（契约字段不变，`http.ts` 一处映射
   + 前端 transport 注册新名）；旧前端天然忽略未知事件名，自动停在
   最后一个 stage 文案。**该切换属 I39-4 验收范围，不在骨架期预置。**

## 2. 事件契约（progress.ts 为唯一权威）

```ts
type PlannerProcessEvent = PlannerProgress | SubagentSpawnedEvent
                         | SubagentDoneEvent | ToolCallEvent;
type ProgressSink = (e: PlannerProcessEvent) => void;   // 观察回调
```

- `subagent_spawned`：`{type, subagent_id, plan_id, parent_run_id, title, task_summary, message}`
- `subagent_done`：`{type, subagent_id, plan_id, status("completed"|"failed"|"cancelled"), kind?("itinerary"|"clarification"), stops_count(number|null), title, summary, child_run_id, child_run_status(RunStatus|null，发射时 DB 快照，竞态下可为 running，见 §4), message}`
  （契约修订：`title` 必填 ≤40 码点，与 spawned 同源——I39-2 发射时回传派发 title，分身退场景气泡可直接复用。）
- `tool_call`：`{type, tool_call_id, name, args_summary, result_count(number|null), status("completed"|"error"), duration_ms?, subagent_id?, message}`
- `stage`（PlannerProgress）：`{type?, stage, message, plan_ids, subagent_id?}`

辅助：`clipText`（单行 ≤160 码点）、`stageMessage/stageProgress`、
`summarizeToolArgs`（白名单）、`toolResultCount`（`details.count` 有限数）、
`toolCallEvent / subagentSpawnedEvent / subagentDoneEvent`、
`stampSubagent`（盖章透传）、`safeEmit`（吞 sink 异常）。

## 3. ID 关联图（#41/#42/#43 消费用）

```
父 run (parent_run_id) ──┬─ subagent_spawned/done.subagent_id = child sessionId
                        │    ├─ plan_id = 父轮 delegate 派发序标号 A/B/…
                        │    │   （与 exploring_plans.plan_ids 同源：
                        │    │     PlannerSession.planIdForToolCall(toolCallId)）
                        │    └─ child_run_id / child_run_status = 子会话最新 run
                        │      （done 发射瞬间的 DB 状态快照）
                        └─ tool_call.subagent_id = child sessionId（子内部调用盖章）
```

- `tool_call_id` = Pi agent `toolCallId`（start/end 配对键，会话内唯一）。
- 子会话内部事件经 `child.prompt` 的 onProgress 透传、`stampSubagent`
  盖章 `subagent_id` 后落父 sink（骨架已接通）；**stage 事件不透传**——
  stage 是本轮私有叙事，父轮 stage 序列不被子会话插入（旧 wire/旧前端/
  既有 e2e 序列断言零扰动），子侧可见性由 subagent_* 与盖章 tool_call
  等实体级事件承担。**多层派发保留已有归属**：事件已带 `subagent_id`
  （如孙会话产出）时不重盖章，只给未归属事件补盖当前 child id——
  消费端据此把事件精确归属到产生它的那一层会话（R1 修复）。
- **消费者须容忍**：透传事件的 `subagent_id` 与 subagent_spawned/done
  之间可能有交错（并行派发下各事件按真实发生序到达），按 id 归属即可。

## 4. 终态与取消一致性

- `subagent_done.status` = 回传父模型的 `DelegateTaskDetails.status`
  （父视角派发终态）；`child_run_status` = 发射瞬间子会话最新 run 的
  DB 状态快照（不是"已终结"承诺：父超时/取消瞬间可如实为 `running`，
  消费者不得据此猜测终结，确认终态另行查库）。两字段通常一致；
  竞态（父超时瞬间子已提交）时以 `child_run_status` 为权威，
  `status` 仍如实反映父收到什么。
- `stops_count`：仅 completed+itinerary 为站点数，其余 null；`summary` 为
  行程 summary / 追问 / 失败原因裁剪。
- `tool_call.status`：`isError → "error"`，error 时 `result_count=null`。

## 5. 信息边界

- `args_summary` 白名单摘要（search_events 的 type/date/category/keyword/
  near/radiusKm；delegate_task 的 title|task；estimate_travel 起止+mode；
  web_search query）；**未知工具不给原始 JSON，给安全默认摘要**（契约修订，
  具体形态以 progress.ts 实现为准）；不回传完整入参/结果内容。
- 全部文本字段 `clipText` ≤160 码点单行；工具入参均为模型产出标量，
  无密钥路径，但仍限长控制帧大小。

## 6. 子任务文件划分（避免合并冲突）

| 子任务 | 拥有/主改文件 | 只做 |
| --- | --- | --- |
| I39-1（本骨架，已提交） | `src/agent/progress.ts`（新）、`test/agent-progress.test.ts`（新）、本文件 | 契约 + 槽位 + 透传盖章 |
| I39-2 delegate 生命周期 | `src/agent/delegate.ts`（emit 点） | spawned/done 发射（见 §7）；可改 delegate 单测 |
| I39-3 tool_call 发射 | `src/agent/session.ts`（subscribe 块 + emit 点） | tool_execution_end → toolCallEvent 发射 |
| I39-4 SSE/文档/测试 | `docs/contracts/agent-api.md` §4、`docs/mocks/day0/*.sse`、SSE/faux 测试 | §8 验收；http.ts 如需独立事件名可改 |

共享但只允许各自动责内的增量：`session.ts`/`runtime.ts`/`service.ts`/
`sse.ts`（I39-1 已放好槽位，其余子任务原则上不再动）。

## 7. I39-2 精确发射点（delegate.ts execute 内）

1. `createChildSession` 成功后（`spawnChild` 之前）：`safeEmit(ctx.onProgress,
   subagentSpawnedEvent({subagentId: childSession.sessionId,
   planId: ctx.planIdForToolCall?.(toolCallId) ?? null,
   parentRunId: ctx.runId, title: params.title, task}))`。
   注意 `execute` 首参 `_toolCallId` 需改名启用。
2. `spawnChild` 失败返回处：`subagentDoneEvent({status:"failed",
   summary:"启动子任务失败：…"})`——`childRunId`/`childRunStatus` 不恒
   null：失败前可能已建半成品 run 行，同样走 `listRunsBySession`
   如实抄录，查无才 null（与 §4 DB 快照语义一致，文档不凌驾落库真相）。
3. `child.prompt` 落定后终局决策（最终形态，I39-R P2 修订）：
   a. turn/异常先折算初步 details（`runId` 占位 null，不发事件）；
   b. `child.close()` 落定——close 拒绝且结果已成功者降级 `failed`；
      `cancelled`/`failed` 保留首因不被覆盖；
   c. 紧挨 done 发射前统一 `listRunsBySession.at(-1)` 快照，回填
      `details.runId` 与 `childRunStatus`（发射瞬间 DB 状态快照，
      竞态下可如实为 `running`；快照取在 close 之后、紧邻发射）；
   d. 唯一 `finish(details, childRunStatus)`：emitDone + 返回同源
      toResult——done 永不先于终局发出，杜绝"done.completed+tool
      上抛"分裂；spawn 后意外异常收编为结构化 `failed` details 同路
      发出（父模型按既有降级准则处理 isError 结果）。
   透传回调生命周期 = prompt 调用期：`forwardEvents` 封口后（含 close
   与 done 之后）悬挂子事件不再透传。超时/父取消 → `"cancelled"`，
   `summary` = `cancelError()`。
4. `createChildSession` 之前的失败（空 task、无 ctx、depth、信号量取消）
   不发 spawned/done——分身未入场。
5. 每条 done 只发一次；spawn 与 done 恒 1:1 配对。

## 8. I39-3/I39-4 要点

- I39-3：`session.ts` constructor subscribe 的 `tool_execution_end` 分支，
  由 `pending` 取 args、`event.result` 取 details，`safeEmit(progress.sink,
  toolCallEvent({...}))`；`toolCallId` 即 `event.toolCallId`。子会话的
  PlannerSession 天然走同一路径 → 自动经透传缝盖章上达父 sink。
- I39-4：agent-api.md §4 加三类事件帧样例（沿用 `event: progress`），
  day0 stream.sse 插入 `type:"subagent_spawned"` 等帧；faux e2e 覆盖
  成功/父取消/子超时三条路径——子超时可注入短 `subagentTimeoutMs` +
  慢 child stream（参照 web-sse-e2e 断连用例）。
