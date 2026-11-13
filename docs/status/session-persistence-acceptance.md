# 会话持久化与压缩：验收状态记录

日期：2026-11-11。状态：**sol 复审遗留 P2/P3 已实施修复，待复验**——
独立复跑全套 261/261、定向回归 28/28 通过；首审 6 项 closed；
扩展 3 项中 2 项 closed；child 候选恢复 1 项 P2 与判拒顺序 1 项 P3
**修复已实施**（按 §3 既定方向），修复后全套 **262/262** 通过（含新增
同毫秒决胜回归 1 条）；待复审确认后更新最终结论（见 §6）。

关联文档：[sessions.md](../architecture/sessions.md)（数据设计，§10 为
验收清单）、[session-implementation-plan.md](session-implementation-plan.md)
（任务拆分与接口契约）。

## 1. 测试规模时间线（编码者报告口径）

| 阶段 | 全量套件累计 | 说明 |
| --- | --- | --- |
| 基线（任务 02 前既有套件） | 82 | 会话功能引入前的项目测试总数 |
| 任务 02+03 完成（仓库 + 压缩核心） | 159 | 新增存储层与压缩单测 |
| 任务 04 完成（Planner/CLI 接入 + 离线集成） | 184 | 新增持久运行时与集成用例 |
| 评审修复完成（含任务 09 扩展项） | 261 | 新增 7 条回归及其余修复覆盖 |

口径说明：累计数为**全量套件**（含既有非会话测试）；会话相关回归分布在
`test/session-*.test.ts`、`test/compaction-*.test.ts`、
`test/session-integration*.test.ts`（具体用例名以仓库为准）。
sol 复审已独立复跑核实：全套 **261/261** 通过、定向回归 **28/28** 通过。
P2/P3 修复后全套 **262/262** 通过（待复审复跑确认）。

## 2. 评审历史

- **sol 首审**：对照验收清单与文件归属审查，提出 **6 项问题** →
  修复后经复审确认 **closed**（明细见协调/评审记录，本文不复列行号）。
- **sol 扩展复审**：再提出 **3 项**（见 §3）→ 经**任务 09** 修复并
  新增 **7 条回归**用例。
- **sol 最终复审（已完成）**：独立复跑全套 **261/261**、定向回归
  **28/28** 通过；扩展项中 op 内 close、commit 后迟到 cancel
  **closed**；child 候选恢复常规继承修复有效，但复现确认仍存在
  恢复旧候选场景 → **1 项 P2 open**；另记录 **1 项 P3**（见 §3 第 4 项）。
- **当前**：P2/P3 修复待实施并重验；**本期验收未最终通过**。

## 3. 扩展复审 3 项与遗留问题

1. **op 异步链内 close 死锁**——在会话操作（prompt/compact）的异步链
   （含 Agent 事件回调）内调 `close()` 会等自己收尾造成死锁。
   修复方向：runtime 用 AsyncLocalStorage 标记 op 链，`close()` 在链内
   **明确 reject 且不改变状态**；注释/错误信息引导改用 `cancel()` 中止
   当轮、由 op 外调用方执行 close。外部 `close()` 取消并等 inFlight 整轮
   收尾后才退订/停心跳/放租约；并发 close 共享同一收尾 Promise。
   **复审结论：closed**。
2. **commit 后迟到 cancel**——plan 提交或 run 收尾落库成功后到达的
   cancel/close 曾可能把已完成 run 写成 cancelled。
   修复方向：`turnCommitted` 线性化点——`commitValidatedPlan` 返回即
   标注+指针已同事务落库；终态按"已提交/产出非 error"判定 completed，
   迟到取消不再改写；仓库层终态不可相互覆盖、cancelled 必须先
   `requestCancelRun` 兜底。
   **复审结论：closed**。
3. **child 候选继承**——child 会话无 `current_itinerary_record_id`
   指针，重启后需有规划状态来源。
   修复方向：child 仅从**本 session 最新一条 completed 且结果为
   itinerary 的 run** 恢复候选（`latestCandidatePlan`），渲染进 system
   的 `candidate_itinerary` section 并明确标注候选身份；failed/cancelled/
   追问轮不覆盖更早成功候选；不更新 main 指针，main/child 状态独立。
   **复审结论：P2 open → 已修复待复验**——常规继承路径已验证修复，
   但复现确认：真实时钟下新旧两个 run 的 `createdAt`/`finishedAt`
   落在同一毫秒，决胜次序依赖随机 `run_id` 序，仍可能选中旧候选恢复。
   **已按建议实施**：`latestCandidatePlan` 改按该 run 已落库消息的最大
   `message_seq` 决胜（`RawHistory.maxSeqByRun()` 提供），无消息记录的
   run 才回退列表次序；新增同毫秒决胜回归用例
   （`session-runtime-regression-replay-child.test.ts`）。待复审重验关闭。
4. **P3：`PlannerSession.close()` 判拒顺序**——`close()` 先执行
   `unsubscribeTrace()` 再委托 `runtime.close()`；当 runtime 因 op 链内
   调用明确 reject 时，trace 已退订，后续 `tool_execution_end` 不再记入
   `toolCalls`（跟踪静默漏记）。**已修复待复验**：退订移入确认关闭路径
   （`runtime.close().then(退订)`），判拒时保持订阅。

回归覆盖：定向回归 **28/28** 经 sol 复跑通过；新增 7 条用例覆盖上述
扩展项及重放/终态边界，归入 `test/session-*.test.ts` 与
`test/session-integration*.test.ts`（泛称，具体名以仓库为准）。

## 4. 原 9 项验收清单状态（sessions §10）

| # | 验收点 | 实现/修复方向 | 回归覆盖（泛称） | sol 复审结论 |
| --- | --- | --- | --- | --- |
| 1 | 用户间隔离 | 仓库全方法显式携带 userId：跨用户读按不存在/not_found、写 → cross_user；pointer/parent/run/reply_to/record-run 关联注入断言 | `test/session-*.test.ts` | 通过（复审核实） |
| 2 | 并发初始化单主会话 | createUser 幂等 + `UNIQUE sessions(user_id) WHERE kind='main'` 部分唯一索引 + 单事务建会话回填 | `test/session-*.test.ts` | 通过（复审核实） |
| 3 | 单写者租约 | owner+epoch+expiry 三元组；写操作 WHERE 带 owner+epoch，影响 0 行 → lease_lost；过期可抢占、不可复活；release 只清匹配 | `test/session-*.test.ts` | 通过（复审核实） |
| 4 | 重启恢复 | reload：死 run 标 failed → 增量加载 → 补闭环中断批次 → 最新合法检查点投影；无检查点正常；非法 compaction → corrupt | `test/session-integration*.test.ts` | 通过（复审核实） |
| 5 | 连续多次压缩 | first_kept 单调不回退；through==当时最大 message_seq；原文全保留 | `test/compaction-*.test.ts` / `test/session-*.test.ts` | 通过（复审核实） |
| 6 | 工具批次与去重 | first_kept 不指向 toolResult；孤立 toolResult 拒绝；dedupe 同键同内容幂等、异内容 conflict | `test/session-*.test.ts` / `test/compaction-*.test.ts` | 通过（复审核实） |
| 7 | plan 事务与恢复 | commitValidatedPlan 标注+指针单事务、只前进；失败校验不覆盖；重启恢复 confirmed；child 只恢复自身候选 | `test/session-*.test.ts` / `test/session-integration*.test.ts` | **已修复待复验**：main 指针路径 closed；child 候选恢复改按关联记录 `message_seq` 决胜，同毫秒不再误选旧候选（见 §3 第 3 项） |
| 8 | 取消/失败语义 | run 行与消息保留；取消不提交未完成摘要、已提交检查点不回滚；turnCommitted 后迟到 cancel 不抹 completed；终态不可互覆盖 | `test/session-integration*.test.ts` | 通过（复审核实） |
| 9 | 压缩触发与预算 | prepareRequest 钩子覆盖工具循环续跑；摘要请求不递归触发；摘要预算 8192 独立于回复 4096；自定义端点声明上限覆盖两者 | `test/compaction-*.test.ts` | 通过（复审核实） |

## 5. 已知限制与范围外事项（如实记录，不视为本期验收缺陷）

- `runs.delivered_at` 预留恒为 NULL；自动调度、后台唤醒、异步投递
  执行器未实现，属后续独立版本。
- 历史分页读取工具（`read_session_history` 类）未实现；摘要提示不承诺
  可调用。
- CLI `userId` 默认 `"local"` 是本地演示标识，**不是认证**；认证/登录
  属独立版本。
- SQLite 单文件适合同主机多进程共享（DB 租约协调）；跨主机/远端部署
  需替换仓库实现。
- `latestCompaction`、`listRecords`、`findRunByRequestId` 按会话全历史
  扫描；超大历史需索引/分页，属后续优化项。
- `src/agent/persistent/` 长模块（如 runtime.ts）超出"单文件 ≤200 行"
  口径：已登记为维护性改进项，**不声称已达标**，亦不构成本期功能
  验收缺陷。
- 前端/web 由独立工作流推进：不否认其存在，但其验收不在本文范围，
  本文亦不对其作任何通过性声明。
- 请求级幂等限同会话同 `requestId` 重放；同键不同文本明确冲突；
  CLI 不传 key，未宣称 HTTP 级幂等。

## 6. 待办与最终结论补入

- 【已实施待复验】**P2**：child 候选恢复改按关联记录 `message_seq`
  决胜（`latestCandidatePlan(runs, seqByRun)`），不再依赖同毫秒
  时间戳/run_id；新增同毫秒决胜回归用例。
- 【已实施待复验】**P3**：`close()` 判拒先于退订——退订移入
  `runtime.close()` 确认之后，reject 路径保持 trace 订阅；
  重验 `toolCalls` 跟踪连续性后可关闭。
- 【待填】P2/P3 复审 closed 后的本期最终验收结论（届时更新各文档头
  状态为"验收通过"）。
- 【待填】遗留跟进项立项：长模块拆分（维护性）、历史全量扫描优化、
  自动调度/异步投递、历史读取工具、认证与数据保留策略、前端版本
  （独立工作流）。
