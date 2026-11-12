# 对话会话模型与子 Agent 编排设计

日期：2026-11-12。状态：已评审修订稿（逻辑与边界问题已收敛，待实现）。
本文针对两项新需求给出实现方案：

1. **前端每次访问即新对话**——不再默认恢复上次会话；跨对话连续性
   完全由 `user_memory` 长期记忆承担。
2. **子 Agent 编排**——在已落地的会话/runs 数据模型上实现
   `delegate_task` 同步派发工具。

两项需求共享同一次会话模型重述：**`kind='main'` 的语义从
"每用户唯一长期主会话"改为"用户面顶层对话会话"**（每用户可有 N 个），
`kind='child'` 专职表示子 Agent 派生的任务会话。本文取代
[users-and-sessions.md](users-and-sessions.md) §3/§4 中
"每用户恰好一个 main"的相关表述；该文其余语义（记录日志、压缩、
租约、run 状态机、归属校验）不变。

## 1. 决策摘要

- 会话模型：**对话即 main**。放开 `sessions` 唯一主会话索引；
  `users.main_session_id` 列与 `getMainSession` 一并下线；Web 对话
  在首条消息时由 `createConversation` 懒创建，标题取首条消息前 30 个
  码点。
- 归档：`archiveSession` 的 `main → conflict` 特例删除，任意 active
  会话可归档。
- 蒸馏：保留 `kind='main'` 触发门；针对"每次访问即新对话"后的短对话
  常态，无方案保底门槛从 10 条下调至 **3 条** user 消息，后台蒸馏从
  "在途即丢弃"改为**每用户串行尾随队列**，防止末轮微调或跨页新对话
  永久漏蒸。
- 编排：**同步派发**。`delegate_task` 在同进程内开完整
  `PlannerSession` 跑候选方案，透传父会话当前位置，结果回传**结构化
  候选行程 + 所选活动关键元信息**（非仅一句话摘要），供父 Agent 直接
  比选/合并并通过 `validateItinerary`；不走 MCP、不走外部进程。
- 控制面：进程级并发信号量默认 **8**（可配），递归深度上限收敛为
  **1**（对话=0 → 子任务=1，子任务不挂 `delegate_task`，根除共享
  信号量嵌套等待死锁）；单次子任务超时默认 **120s**，前端请求超时
  放宽至 **210s**，父取消级联到子。
- run 树：子 run 的 `parent_run_id` / `reply_to_session_id` /
  `root_run_id` 写全，`delivered_at` 仍恒为 NULL——记录形状按异步终态
  备好，将来升级后台调度零表迁移。

## 2. 为什么推翻"每用户一个主会话"

原设计前提（users-and-sessions.md §1）："每个 Web 用户拥有一个长期
主会话，用户默认一直与该主会话交互"。新需求要求每次访问都是新对话，
该前提失效。曾评估"对话=main 的 child"（不动 schema）方案，但其
语义债更重：

- **两种 child 混用**：对话会话与任务会话同为 `kind='child'`，
  但蒸馏/指针/归档语义不同，只能靠约定区分——等于在 schema 之外
  私造第三种 kind。
- **用户流量走候选路径**：`current_itinerary_record_id` 是 main
  专属，child 只能从最新 completed run 倒推"候选"——而久经测试的
  正式指针路径反而闲置。
- **蒸馏要改两处**：触发门 main-only + 触发信号靠 plan 标注，
  child 两个都不沾。
- **main 退化为空壳根**：建对话还要拿一个无人使用的会话的租约，
  树多出一层不干活。

结论：改 schema 的爆炸半径反而更集中，且终点状态诚实——`kind` 边界
就是"用户面对话 vs 内部子任务"边界。

## 3. 会话模型改造（对话即 main）

### 3.1 schema（`src/session/schema.ts`）

- 删除 `idx_sessions_main` 部分唯一索引：DDL 中移除该
  `CREATE UNIQUE INDEX`；`ensureSessionSchema` 内追加一行
  `DROP INDEX IF EXISTS idx_sessions_main`，兼容已存在的 dev 库
  （否则老库仍拒绝第二个 main）。
- `users` 表 DDL 移除 `main_session_id` 列：新库不再有该列；老库文件
  保留该列（因其带 `REFERENCES sessions(session_id)` 外键，SQLite
  不支持直接 `ALTER TABLE DROP COLUMN`，不做表重建），代码从此不引用
  它，新插入行自动为 `NULL`。
- 其余 CHECK 与索引**不动**：`kind='main' AND parent_session_id IS NULL`
  （对话天然无父）、`kind='main' OR current_itinerary_record_id IS NULL`
  （对话可持指针）均原样适用。

### 3.2 仓库层（`src/session/`）

- `createUser` 瘦身：只 `INSERT INTO users`（幂等不变：`user_id` 撞键
  返回既有用户），不再附带建会话与回填。
- 新增 `createConversation(userId, { title? })`：建
  `kind='main'`、`parent_session_id IS NULL` 的会话。**不需要
  LeaseWriter**——无父会话就无树完整性要保护，归属由 `userId` 保证；
  用户不存在 → `not_found`。`title` 缺省 `NULL`。
- `getMainSession` 与 `User.mainSessionId` 删除：
  `repository.ts` 接口、`impl/sessions.ts` 实现、`sqlite.ts` 装配、
  `types.ts`/`impl/context.ts` 行映射同步移除。
- `archiveSession`：删除 `kind === "main"` → `conflict` 特例，
  任意 active 会话可归档（归档语义不变：只读、清租约）。
- `listSessions` 不变，天然成为"对话列表"数据源（含 child，
  上层按 `kind` / `parentSessionId` 过滤）。

### 3.3 运行时（`src/agent/session.ts`、`persistent/runtime.ts`）

- `PersistentPlannerOptions` 新增可选 `title?: string`（仅新建对话时
  使用）及编排入参（见 §5）。
- `PersistentRuntime.resolveSession` 改两路：
  - 显式 `sessionId` → 打开（校验属于该用户、active；**两种 kind
    都允许**——编排层要开 child 会话）。
  - 未给 `sessionId` → `createUser` 幂等 +
    `createConversation(userId, { title })` 建新对话。租约纪律不变：
    `guard.run` 在新会话上正常 acquire。
  - **Web 与 CLI 的创建时机差异**：Web 在收到首条 `POST /api/chat`
    时才调 `openPlanner`，故空页面加载不产生任何会话行；CLI 在启动
    `open()` 时即建立本次对话（立即 `Ctrl+D` 退出会留一条 0 消息空
    会话，属本地 CLI 可接受行为）。
- `commitValidatedPlan` 与 close 的 `sessionKind === "main"` 蒸馏门
  **原样生效**：对话即 main，指针与蒸馏照常；任务会话即 child，天然
  不触发蒸馏。
- **后台蒸馏改为每用户串行尾随队列**（修补多对话下的竞态）：
  将原 `distillingUsers: Set<string>` 升级为按 `userId` 串行调度的
  待蒸队列（同 `sessionId` 合并去重）。当同一用户在前一轮或另一标签页
  已有蒸馏在途时，后续 `close` 不再直接丢弃，而是排入该用户队尾等前序
  完成后顺次执行——既避免对话末轮被静默漏蒸，也消除同一用户跨对话并发
  `putUserMemory` 的游标覆盖竞态。
- **注意维持 `opScope` 实例隔离**：`PersistentRuntime` 的
  `opScope = new AsyncLocalStorage<symbol>()` 必须保持为**实例级属性**
  （拆分模块时不得改为模块级单例），确保父 `opScope` 异步链内调用
  `childPlanner.close()` 时不会误触发"禁止在 op 链内 close"守卫。
- CLI（`src/cli/main.ts`）：无 `EXPLORER_SESSION_ID` 时每次启动建新
  对话，并在 `stderr` 打印本次 `sessionId`；设置 `EXPLORER_SESSION_ID`
  时恢复指定会话（调试/回归用）。USAGE 文案同步更新。

### 3.4 Web 协议与服务（`src/web/`）

- 协议类型（`types.ts`、`request.ts`）：
  - `ChatSendRequest` 增加可选 `session_id?: string`；`parseChatSend`
    白名单放行 `session_id` 并校验为非空有限长度字符串（如 `1..128`
    字符，拒绝空白或非字符串）。
  - `ChatResult`（`clarification` 与 `itinerary` 两种形态）均增加
    必填 `session_id: string` 返回本次对话 ID。
- `service.send`：
  - 带 `session_id` → `getSession` 校验：不存在、不属于该用户、或
    `kind !== 'main'`（拒绝直接向内部 child 任务会话发消息）→ 抛客户端
    `not_found` 错误；`status === 'archived'` → 抛 `archived` 错误。
  - 不带 `session_id` → 取首条消息 trim 后前 30 个码点
    （`[...trimmed].slice(0, 30).join("")`，不截断 surrogate 对）作
    `title` 传给 `openPlanner` 懒建新对话，从 `planner.sessionId` 取回
    ID 写入 `ChatResult.session_id`。
- `service.history`：`GET /api/chat/history?session_id=…` 参数化读取
  指定对话（同样校验存在、归属、`kind === 'main'`、active）；无
  `session_id` 时返回空历史 `{ messages: [], itinerary: null }`（前端
  本期不再调用此端点，保留供后续"继续对话"入口使用）。
- **HTTP 错误状态码映射（`http.ts`）**：不再把所有服务层异常一刀切为
  500。定义显式错误分类：
  - 会话不存在 / 跨用户 / `kind='child'` → **`404`**（统一响应体，不
    泄露跨用户或内部会话存在性，不触发服务端 `onError` 500 告警）；
  - 会话已归档（`archived`）或同会话写租约忙 → **`409`**；
  - 其余模型/内部异常 → **`500`**（记 `onError`，通用文案返回）。
- **首轮失败边界（如实声明）**：未带 `session_id` 的首条消息若在服务端
  建会话后因模型错误（500）或客户端断连失败，前端尚未拿到
  `session_id`——此时点"重试"会新建另一条对话，旧失败会话留作历史孤儿
  行；首轮不承诺跨会话 `requestId` 幂等重放，已拿到 `session_id` 后的
  后续轮次幂等语义照旧。

### 3.5 前端（`frontend/chat.js`）

- 删除 `initHistory`、`showInitError` 及 `/api/chat/history` 调用：
  脚本加载即置 `ready = true`，刷新页面即干净新对话。
- `state.sessionId` 为普通页面内存变量（**不落 `sessionStorage`**——
  硬新建语义）；`deliver` 在 `state.sessionId` 存在时随 POST body 带上
  `session_id`，成功响应后将 `data.session_id` 存回，同一次页面访问内
  后续轮次沿用。
- **请求超时与长轮反馈**：`POST /api/chat` 的 `timeout` 从 `60000`
  放宽至 **`210000`（210s）**（对齐 §5.3 子任务预算，低于 Node
  `http.Server.requestTimeout` 默认 300s）；请求超过 15s 未返回时将
  等待气泡标签从"漫游正在整理灵感"平滑更新为"漫游正在多路比选方案"，
  其余位置、行程卡片、地图路线逻辑不变。

### 3.6 蒸馏语义变化（`src/memory/distill.ts`）

- **下调无方案保底门槛**：旧设计假定全生命周期单会话，10 条 user 消息可
  跨多次访问累积；改为每次访问新建会话后，大量真实对话仅 2–5 轮即结束。
  将 `minNewUserMessages` 默认值从 `10` 下调至 **`3`**（可通过配置项
  `EXPLORER_MEMORY_MIN_USER_MESSAGES` 调整）；有新确认方案（`plan`
  标注）仍为 1 次即蒸。未满 3 条且未产出确认方案即放弃的极短试探对话
  不触发蒸馏，作为机会性记忆的合理噪声过滤。
- **游标与串行化**：`sourceSessionId !== sessionId` 时游标自动从 `0`
  重算，配合 §3.3 的每用户串行尾随队列，同会话快速连续轮次或跨会话切换
  均按 `close` 顺序逐个推进，不丢末轮、不乱序覆盖。
- **任务会话（child）不蒸**：`kind='child'` 在 close 门处直接跳过。
  注意机制依据：`distill.ts` 仅将 `user` 与 `assistant` 消息喂给蒸馏
  模型（显式过滤 `toolResult`）；`child` 内无新增原始用户陈述，且其产出
  仅为未确认候选——只有被父 Agent 采纳并写入父 `assistant` 正式回复与
  `plan` 标注的内容才代表用户真实足迹，随父对话蒸馏即可。

### 3.7 数据兼容

- 老 dev 库：原唯一 main 会话在 `DROP INDEX` 后就地变成一条普通历史
  对话；`users.main_session_id` 外键死列保留无害（本期只做 `archived`
  软归档，不做物理 `DELETE FROM sessions`，不会触发外键拦截）。如需
  完全干净表结构，直接删除本地 `data/sessions.db` 重建即可。

## 4. 影响面清单

| 层 | 文件 | 改动 |
| --- | --- | --- |
| schema | `src/session/schema.ts` | 删 `idx_sessions_main`、删 `users.main_session_id` 列、`ensureSessionSchema` 加 `DROP INDEX IF EXISTS` |
| 仓库 | `src/session/{types,repository,sqlite,impl/sessions,impl/context}.ts` | `createUser` 瘦身、新增 `createConversation`、删 `getMainSession`/`User.mainSessionId`、`archiveSession` 放开 main |
| 记忆 | `src/memory/distill.ts`、`src/config.ts` | `minNewUserMessages` 默认改为 3（可配），配置透传 |
| 编排 | `src/agent/delegate.ts`（新增）、`src/agent/{explorer-agent,prompt}.ts` | `delegate_task` 工具、信号量、子超时、结构化结果组装、系统提示派发规范 |
| 运行时 | `src/agent/{session,persistent/runtime}.ts` | `resolveSession` 两路、`title` 与编排上下文透传、每用户串行蒸馏队列 |
| web | `src/web/{types,request,service,http}.ts` | `session_id` 出入参与校验、首条消息截断 `title`、404/409/500 分类映射、history 参数化 |
| 前端 | `frontend/chat.js` | 移除 `initHistory`、`state.sessionId` 页内存续、超时放宽至 210s 与长轮提示文案 |
| CLI | `src/cli/main.ts`、`src/config.ts` | `EXPLORER_SESSION_ID`、子任务并发/超时配置、stderr 打印会话 ID、USAGE 更新 |
| 测试 | `test/session-*/web-*/memory-distill*` 及新增 `test/agent-delegate*.test.ts` | 旧"唯一 main"断言改写 + 多对话、404/409、串行蒸馏、同步编排/取消/超时/深度回归 |
| 文档 | `docs/users-and-sessions.md` §3/§4 | 随实现同步更新 |

## 5. 子 Agent 编排：同步派发

### 5.1 执行模型决策

- **同步派发（本期实现）**：`delegate_task` 工具 `execute` 阻塞至
  子任务完成，结果作为 `toolResult` 回父 Agent。无后台调度器、无投递
  事务、无唤醒语义；Web 请求-响应模型下用户本就在等待当轮最终方案。
- **异步派发（数据已备、本期不做）**：工具只建 child + queued run
  即返回；后台 worker 执行后向 `reply_to_session_id` 会话投递结果
  消息（`source_run_id` 关联、`delivered_at` 标记——届时新增
  "投递+标记"原子 repo 方法）。schema 字段已齐备，升级零表迁移。
- **不走 MCP**：父子共享同进程代码、`EventRepository`、`SessionRepository`
  与 `streamFn`；包一层 MCP 只会引入跨进程序列化开销并打断 faux
  provider 离线测试链。

### 5.2 机制

```text
父 Agent 本轮 loop（父会话租约窗口内，心跳照常续期）
 └─ 模型调 delegate_task({ task, title? })（支持同轮并行多次调用）
     └─ tool.execute(toolCallId, params, signal)：
         1. 读 dispatch 上下文：{ writer, sessionId, runId, location, depth }
         2. 进程信号量 acquire（受父 signal 与子超时联合控制）
         3. sessions.createChildSession(父writer, userId, { parentSessionId, title })
         4. createPersistentPlanner({ sessionId: child.sessionId,
             parentRunId: 父runId, replyToSessionId: 父sessionId,
             depth: depth + 1, detachDistill: false })
         5. try:
              await childPlanner.prompt(task, { location })
            finally:
              await childPlanner.close()   ← 必走 finally 释放 child 租约与心跳
              semaphore.release()
         6. 组装结构化结果返回 toolResult（失败/取消置 isError: true）
```

关键边界处理：

- **dispatch 上下文**：沿用 `createPersistentPlanner` 的闭包持有对象模式——
  构造时把可变上下文槽同时传给 `createExplorerAgent`（仅当 `depth < maxDepth`
  时挂载 `delegate_task` 工具）与 `PersistentRuntime`。`runPrompt` 在建好
  父 `run` 后填入 `{ writer: guard.current, sessionId, runId: activeRunId,
  location: currentLatLng, depth }`，`finally` 清空；槽为空时工具直接返回
  `isError: true`（"当前不在可派发的持久运行上下文中"）。
- **位置继承**：`child` 会话初始无历史 `runs`，不会从自身库恢复位置；
  必须由 orchestrator 从 dispatch 上下文取出父会话当前生效的 `{ lat, lng }`
  （本轮新传优先，否则为 reload 恢复的会话最近位置），显式传给
  `childPlanner.prompt(task, { location })`，使 child 的
  `location_context` section 与父一致。
- **父租约异常分流**：步骤 3 调 `sessions.createChildSession` 时直接传
  `writer`，**不经过父 `guard.guarded()`**（避免普通校验错误误置父闩锁）；
  但若捕获 `SessionRepositoryError` 且 `code === "lease_lost" ||
  code === "archived"`，说明父会话写租约已失效，立即调父 `guard.fail(err)`
  中止父轮，避免父模型继续空跑浪费 token。
- **结构化结果回传（解决 `event_id` 断链）**：
  - `turn.kind === "itinerary"`：按 `turn.itinerary.stops` 提取去重后的
    `event_id` 列表，从 `EventRepository.getByIds` 取出对应活动的校验与决策
    元信息（`id`、`title`、`category`、`venueName`、`startAt`、`endAt`、
    `suggestedDurationMinutes`、`budgetMin`、`budgetMax`、`currency`、
    `budgetNote`），序列化为 JSON 文本放入 `content`：
    `{ status: "completed", kind: "itinerary", sessionId, runId,
    constraints, itinerary, events }`。父 Agent 无需重复调用
    `search_events` 即可核对时间窗、对比预算并合成最终通过校验的行程。
  - `turn.kind === "clarification"`：返回 `{ status: "completed",
    kind: "clarification", sessionId, runId, question }`（`isError: false`）。
  - `turn.kind === "error"` 或超时/取消：**不 `throw`**，返回
    `{ status: "failed" | "cancelled", sessionId, runId, error }` 且显式置
    **`isError: true`**——既遵循 `pi-agent-core` 工具契约（让 `toolCalls`
    轨迹如实记错），又允许父模型读取错误原因决定降级自查或调整重试。
- **run 树**：`PersistentRuntime` 将可选 `parentRunId` / `replyToSessionId`
  透传进 `createRun`，`root_run_id` 由仓库层自动继承，零额外写库。
- **取消与优雅关闭级联**：`execute` 同时监听父 `signal` 与本地子超时定时器
  → 触发 `childPlanner.cancel()`。因 `await childPlanner.close()` 位于
  `finally` 内，`WebChatService.shutdown()` 等待父 `inflight` 结束时，所有
  在途 child 的 run 终态与租约释放必然先于 `closeDbs()` 完成，不会撞上已关
  数据库。

### 5.3 控制面

- **递归深度上限 = 1（硬防死锁）**：dispatch 上下文携带 `depth`（对话
  会话为 `0`，子任务为 `1`）；默认最大深度 `1`，`depth >= 1` 的 Agent
  **不挂载 `delegate_task` 工具**。这从结构上消除了"父子共用同一阻塞
  信号量池导致的嵌套饥饿死锁"，同时把串行延迟控制在最多"父 → 子 → 父"
  两跳之内。底层 schema 的任意层级能力保持不变；若未来确需开放 `depth > 1`，
  必须同步将信号量改为按深度分池。
- **并发上限 = 8**：进程级信号量，默认 `8`，
  `EXPLORER_SUBAGENT_MAX_CONCURRENT` 可配。同轮并行派发或多请求并发超限时
  在队列中等待；等待期间若父 `signal` 已 abort 或子超时已到，立即退出队列
  不占槽位。
- **超时预算对齐（消除前后端倒挂）**：
  - 单次子任务超时：`EXPLORER_SUBAGENT_TIMEOUT_MS` 默认 **`120_000`
    （120s）**，从进入 `execute`（含信号量排队）起算。本地超时触发时记
    `timedOut = true` 并调 `childPlanner.cancel()`，向父返回明确文案
    `"子任务执行超时（120s）"`（区别于父请求被用户/断连取消的
    `"父请求已取消"`），便于父模型直接降级用 `search_events` 兜底。
  - 前端请求超时：`frontend/chat.js` 的 `POST /api/chat` 超时设为
    **`210_000`（210s）**，为 `120s` 子任务前后留出 `90s` 的父轮拆解与
    汇总校验余量，同时低于 Node `http.Server.requestTimeout` 默认值
    （300s）。

### 5.4 产品定位、提示词与工具面

- **产品定位（v1 定稿）**：`delegate_task` 专用于**给定明确日期下的多方向/
  多片区候选行程探路与并行方案比选**（例如：用户想在"文艺看展线 vs 轻松市集
  音乐线"之间二选一、跨两个城区比选、或上下午偏好跨度大需分头深挖时，由父
  Agent 并行派发 2–3 个子任务各自独立检索排期，再汇总择优或拼接成最终一日
  行程）。**单日单方向的常规需求或缺出行日期需先追问的场景，父 Agent 直接
  调 `search_events` 或直接 `clarify`，禁止无意义套壳派发。**
  该定位与 child 复用的 `clarify | itinerary` 输出契约天然吻合，无需维护
  第二套自由文本解析器。
- **工具参数面（v1 定稿）**：
  - `task: string`（必填）：自包含的子任务说明。系统提示明确要求父模型写入
    推断后的具体日期 `YYYY-MM-DD`、可用时段、探索方向/区域及已知预算或偏好
    约束——child 看不到父对话消息流。
  - `title?: string`（可选）：简短子任务标题（如 `"周六下午大雁塔看展方案"`），
    落入 `sessions.title` 供会话树与日志排查。
  - 位置与长期记忆由运行时自动注入，不在工具参数中重复暴露经纬度。
- **`buildSystemPrompt` 分支**：`buildSystemPrompt(currentDate, { canDelegate })`
  仅在 `canDelegate === true`（即持久模式且 `depth < 1`）时附加
  `delegate_task` 使用准则；child Agent（`depth = 1`）与纯内存模式既无该
  工具，系统提示也不提派发，避免模型幻觉调用。

### 5.5 与记忆/归档的关系

- 任务会话 `kind='child'` → `close()` 不触发蒸馏；被采纳的候选站点随父
  会话确认行程写入父消息流，由父会话蒸馏进入 `user_memory`。
- 任务会话可归档（§3.2 放开后任意会话可归档）；本期不提供自动归档后台任务，
  留作后续清理手段。

## 6. 本期不做 / 如实边界

- 异步调度：queued run 后台执行器、向 `reply_to_session_id` 投递消息、
  `delivered_at` 标记（字段保留恒 NULL）。
- 会话列表 UI、手动归档入口、"继续历史对话"入口（后端 `history?session_id=`
  已就绪）。
- 子 Agent 异构模型或自由文本调研模式（本期 child 与父同模型、同输出契约）。
- 首条消息（尚未拿到 `session_id`）失败时的原会话续接与跨会话 `requestId`
  幂等重放。
- `users.main_session_id` 老库死列的物理表重建清理。
- 跨进程/跨机多 Agent 信号量协调（沿用 SQLite 单机部署边界）。

## 7. 验收清单

会话模型与记忆：

1. 同一用户可建多个 `kind='main'` 会话；`users` 无 `main_session_id` 依赖；
   含 `idx_sessions_main` 的老库经 `ensureSessionSchema` 后可建第二个 main。
2. Web 空页面加载不产生任何会话行；首条 `POST /api/chat` 懒建对话，响应含
   `session_id`，会话 `title` 为首条消息前 30 个码点，同页后续消息复用该
   `session_id`。
3. Web `session_id` 校验：不存在 / 跨用户 / `kind='child'` 一律回 **404**；
   `archived`（及同会话租约竞争忙）回 **409**；均不误报 500。
4. 对话会话：行程指针推进、自动/手动压缩、新对话 `memory_context` 注入与
   既有行为一致。
5. 蒸馏：有新 `plan` 立即触发，无 `plan` 满 3 条新 user 消息触发；同一用户
   连续或跨对话并发 `close` 时按串行队列逐一蒸馏，末轮结果不因在途锁丢失。
6. 任意 active 会话（含 main）可归档；归档后打开/写操作一律拒绝（`archived`）。
7. CLI：默认新建对话并在 `stderr` 输出 `sessionId`；设
   `EXPLORER_SESSION_ID` 可恢复指定会话。

子 Agent 编排：

8. `delegate_task` 成功派发：创建 `kind='child'` 会话（`parent=父对话`）与
   child run（`parent_run_id` / `reply_to_session_id` / `root_run_id` 正确）；
   父会话当前 `location` 自动透传进 child；`toolResult` 含候选 `itinerary`
   与所选 `events` 元信息，父对话消息表不含 child 内部消息。
9. child 失败 / 取消 / 超时：child run 终态正确、child 租约在 `finally` 中
   释放；`toolResult` 带 `isError: true` 与可读原因（区分"子任务超时"与
   "父请求取消"），父轮不被拖死；父租约若已 `lease_lost` 则立即中止父轮。
10. 控制面：并发数超信号量上限时排队等待，被取消时立即退队；`depth = 1` 的
    child Agent 不含 `delegate_task` 工具且系统提示不含派发说明，满载并发下
    无嵌套死锁。
11. 级联与隔离：父取消或 `WebChatService.shutdown()` → 在途 child 级联取消并
    先于关库完成 `close()`；child 候选行程绝不改动父会话指针；child `close()`
    不触发记忆蒸馏。
