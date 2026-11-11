# 会话持久化与压缩：实施计划与接口契约

日期：2026-11-11。状态：任务 02–04 与评审修复已在当前工作树实现
（未提交）（持久仓库、压缩核心、Planner/CLI 接入与离线测试）。
sol 复审已完成：独立全套 261/261、定向回归 28/28 通过；首审 6 项
closed；扩展 3 项中 2 项 closed、child 候选恢复遗留 1 项 P2 open，
另记录 1 项 P3。**尚未最终验收**——逐条结论与待办见
[session-persistence-acceptance.md](session-persistence-acceptance.md)。
数据设计语义见 [users-and-sessions.md](users-and-sessions.md)（字段、
恢复、验收清单以该文为准，本文只管任务拆分与代码边界）。

## 1. 任务划分

| 任务 | 内容 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| 02 | `node:sqlite` 持久仓库：users / sessions / session_records / runs | 无 | 与 03 并行 |
| 03 | 独立压缩核心：移植 Rudy `src/compaction`，配置与模型输出预算 | 无（只依赖 pi 1.4.0 类型） | 与 02 并行 |
| 04 | PlannerSession/CLI 接入 + 离线集成测试 | 02、03 都完成 | — |
| 05 | sol 统一只读 review | 04 完成 | — |
| 09 | 扩展复审修复：op 内 close、commit 后迟到 cancel、child 候选恢复 + 回归 | 05 复审意见 | — |

05 之后的修复批次：sol 首审 6 项问题修复并经复审 closed（批次编号以
协调记录为准）；扩展复审 3 项经任务 09 修复，新增 7 条回归用例。
sol 最终复审后，op 内 close 与迟到 cancel 两项 closed；child 候选
恢复在同毫秒并列下仍可能选中旧候选，留 **P2 open**（建议以关联
记录的 message_seq 做稳定排序，尚未实施）；另记录 **P3** 一项
（见 §6）。

**文件归属（02 与 03 并行期间不得越界）：**

- 02 拥有：`src/session/**`、`test/session-*.test.ts`、`test/session-fixture.ts`
- 03 拥有：`src/compaction/**`、`test/compaction-*.test.ts`、
  `src/config.ts`、`src/agent/model.ts`
- 04 拥有：`src/agent/session.ts`、`src/agent/persistent/**`、
  `src/agent/interrupted.ts`、`src/cli/**`、`src/config.ts`（会话库
  路径配置，顺序在 03 之后故不冲突）、`test/session-integration*.test.ts`、
  `test/e2e-fixture.ts`（如需扩展）
- 双方都**不**改：`src/data/**`、`src/itinerary/**`、`src/agent/prompt.ts`、
  `src/agent/response.ts`、`src/agent/tools.ts`、`scripts/**`（除 04 需要外）

## 2. 共享契约（02 与 03 的接缝）

- `session_records.payload` 的 JSON 形状由 02 在 `src/session/types.ts`
  定义；02 对 payload 做**边界校验**（结构合法），不理解压缩语义。
- 03 的 `compact()` 工作在**内存 `AgentMessage[]`** 上：`firstKept` 是
  1-based 的 raw 数组序号，与 Rudy 一致。`message_seq` 换算发生在
  持久化边界（04 侧 `persistCheckpoint`）：
  `first_kept_message_seq = 对应 raw 记录行的 message_seq`，
  空尾部为 `当时最大 message_seq + 1`；
  `source_through_message_seq = 生成时最后一条 raw 记录的 message_seq`，
  且提交时必须仍等于库内最大 `message_seq`。
- 内存 `raw` **不含 system 消息**（system 不落库）；raw 顺序与
  session_records 中 type=message 行按 message_seq 升序一一对应，
  由 04 的 `RawHistory`（`src/agent/persistent/history.ts`）维护
  raw↔record 索引与序号换算（compact 依赖消息对象同一性）。
- 会话库文件独立于活动库：`EXPLORER_SESSION_DB_PATH`，默认
  `data/sessions.db`。`npm run seed` 只清 events 表，绝不触碰会话库；
  `.gitignore` 的 `data/*.db` 已覆盖。
- 02、03 全部测试离线；禁止真实模型 API（faux provider 见
  `test/e2e-fixture.ts` 的用法）。

## 3. 任务 02：持久仓库（`src/session/`）

新模块，风格对齐 `src/data/`（接口 + SQLite 实现 + 幂等 schema）。

### 3.1 实际接口（已实现）

行类型与 payload 形状在 `src/session/types.ts`（camelCase TS 类型，
snake_case 列名映射在实现侧；payload 解析/校验在 `src/session/payload.ts`）。
关键类型：`User` / `Session` / `SessionRecord` / `Run` / `ValidatedPlan` /
`MessagePayload` / `CompactionPayload`（字段名保持 snake_case）/
`LeaseWriter { owner, epoch }` / `ValidatedCompaction { record, payload }` /
`CurrentItinerary { record, plan }` / `RunFinishOutcome`（判别联合）/
`SessionRepositoryError`（code：`cross_user` | `not_found` | `lease_lost` |
`archived` | `conflict` | `invalid_state` | `invalid_payload` | `corrupt`）。

`SessionRepository`（`src/session/repository.ts`，权威注释见源码）约定：

- 所有会话级方法显式携带 `userId`：**读方法与 `acquireLease` 首参即
  `userId`**；**持租约的写方法首参是 `LeaseWriter`、`userId` 第二**。
- 归属语义：单实体读跨用户按不存在返回 `undefined`；范围读的
  范围实体缺失/跨用户 → `not_found`；写跨用户 → `cross_user`。

```ts
// users / 初始化
createUser(input: { userId?; displayName? }): Promise<User>;   // 幂等
getUser(userId): Promise<User | undefined>;
getMainSession(userId): Promise<Session>;   // 用户缺失→not_found；未绑定→corrupt

// sessions
getSession(userId, sessionId): Promise<Session | undefined>;   // 跨用户→undefined
listSessions(userId): Promise<Session[]>;                      // last_activity_at 降序
createChildSession(w, userId, { parentSessionId, title? });    // 持父会话租约
archiveSession(w, userId, sessionId): Promise<void>;           // 仅 child；清租约

// 单写者租约（owner+epoch+expiry 三元组）
acquireLease(userId, sessionId, owner, ttlMs): Promise<LeaseWriter | undefined>;
renewLease(w, userId, sessionId, ttlMs): Promise<boolean>;     // 已过期→false
releaseLease(w, userId, sessionId): Promise<void>;             // 只清匹配 owner+epoch

// records（统一追加日志；message 追加同事务分配 seq/message_seq 并
// 推进 last_activity_at；compaction 行 message_seq 为 NULL、只推进 updated_at）
appendMessage(w, userId, sessionId, { payload, runId?, sourceRunId?, dedupeKey? });
appendCompaction(w, userId, sessionId, { payload, dedupeKey? });
commitValidatedPlan(w, userId, sessionId, recordId, plan): Promise<void>;  // 仅 main
listRecords(userId, sessionId): Promise<SessionRecord[]>;                  // seq 升序
listMessagesFrom(userId, sessionId, firstMessageSeq): Promise<SessionRecord[]>;
latestCompaction(userId, sessionId): Promise<ValidatedCompaction | undefined>;
getRecord(userId, sessionId, recordId): Promise<SessionRecord | undefined>;
getCurrentItinerary(userId, sessionId): Promise<CurrentItinerary | undefined>;

// runs
createRun(w, userId, { sessionId, input, parentRunId?, replyToSessionId?,
                       startImmediately? }): Promise<Run>;
getRun(userId, runId): Promise<Run | undefined>;
listRunsBySession(userId, sessionId): Promise<Run[]>;
listRunsByParent(userId, parentRunId): Promise<Run[]>;   // 逐层递归查询
listRunsByUser(userId): Promise<Run[]>;
startRun(w, userId, runId): Promise<void>;               // queued→running
finishRun(w, userId, runId, outcome: RunFinishOutcome): Promise<void>;
requestCancelRun(w, userId, runId): Promise<boolean>;    // 已终态→false
close(): void;
```

### 3.2 02 内嵌的不变量（已实现口径）

- `UNIQUE sessions(user_id) WHERE kind='main'`；`(session_id, seq)`、
  `(session_id, message_seq)`（仅 message 行）、`(session_id, dedupe_key)`
  （非空行）唯一。`message_seq` 用 `NULL` 表示 compaction 行——
  唯一索引天然放行多 NULL。
- 所有"写会话数据"方法要求 `LeaseWriter` 并在 UPDATE 的 WHERE 中携带
  `lease_owner=? AND lease_epoch=?`；影响行数为 0 即抛 `lease_lost`。
  `acquireLease` 可得条件：无 owner、`lease_expires_at < now`、同 owner；
  成功 `lease_epoch + 1`。过期租约不可经续期复活；release 不误清新 owner。
- 归属断言在仓库层抛错：parent/run/reply_to 跨用户（`cross_user`）、
  itinerary 指针跨会话/非 main/回退（`cross_user`/`conflict`）、
  append 到 archived 会话（`archived`）。
- `appendMessage`：toolResult 必须引用本会话已有 toolCallId（拒孤立）；
  dedupe 撞键内容一致幂等返回、不同 `conflict`。
- `appendCompaction`：`source_through_message_seq` 必须等于提交时最大
  `message_seq`；first_kept ∈ `[min+1, max+1]`、不指向 toolResult、
  不小于上一检查点边界；只推进 `updated_at`（不动 `last_activity_at`）。
- `latestCompaction`：**每条已存检查点按它写入时的记录前缀**校验
  （summary 非空、边界区间、不指向 toolResult、不小于上一有效边界），
  返回最新合法一条 `{ record, payload }`；无 → `undefined`；任一非法
  → `corrupt`，不静默跳过。
- `commitValidatedPlan`：仅 main；目标 record 必须是本会话成功 assistant
  消息且未带 plan；标注 payload.plan + 推进指针同一事务；指针只前进。
- run 状态机：queued/running → 终态，终态不可相互覆盖（`invalid_state`）；
  `cancelled` 终态要求此前 `requestCancelRun`；`startImmediately` 创建
  即 running（原子写 startedAt）。
- message 追加的 seq/message_seq 分配、record 插入与 `last_activity_at`
  刷新同事务（compaction 行 `message_seq` 恒为 NULL、只推进
  `updated_at`，不走此口径）；会话级写同时校验会话 active。

### 3.3 02 验收

`docs/users-and-sessions.md` §10 中第 1–6、8 条的存储层部分 +
并发初始化单主会话 + 租约竞争/过期抢占/过期不可复活/旧 epoch 拒写 +
plan 标注与指针原子性。

## 4. 任务 03：独立压缩核心（`src/compaction/`）

移植本机 Rudy `src/compaction/`（`/Users/lmy/Documents/code/rudy/`，
只读参考，pi 同为 1.4.0）。**不依赖 `src/session/`**——输入输出都是
`AgentMessage[]` 与内存 Checkpoint，持久化映射由 04 完成。

### 4.1 文件与导出（以源码为准）

```ts
// src/compaction/tokens.ts —— 直接移植
export interface UsageBaseline { estimate(...); observe(...); clear(): void; }
export function createUsageBaseline(): UsageBaseline;
export function estimateText(text: string): number;
export function estimateMessages(messages: AgentMessage[]): number;
export function recentStart(messages: AgentMessage[], target: number): number;

// src/compaction/checkpoint.ts —— 直接移植
export interface Checkpoint { summary: string; timestamp: number; firstKept: number; }
export function summaryMessage(record): AgentMessage;
export function projectHistory(messages, checkpoint, system): AgentMessage[];

// src/compaction/summary.ts —— 移植 + 提示词定制
export function generateSummary(agent: Agent, model: Model<Api>,
  messages: AgentMessage[], maxTokens: number,
  signal?: AbortSignal): Promise<{ summary: string; usage: Usage }>;
// 提示词保留 pi 1.4.0 结构与 MIT 来源注释（同 Rudy 做法），
// 在 Critical Context/Constraints 段落明确：出行日期、已确认与待确认约束、
// 活动 event_id、用户已拒绝的选项、当前行程状态必须保留。

// src/compaction/compact.ts —— 移植 + 持久化接缝入参
export interface CompactionOptions { compactionThreshold;
  compactionKeepRecentTokens; compactionMaxTokens; maxTokens; }
export interface CompactionResult extends Checkpoint { usage: Usage;
  tokensBefore: number; tokensAfter: number; replacement: AgentMessage[]; }
// 调用形状（04 侧 runtime.ts 实际用法）：
compact({
  agent, model,
  messages: AgentMessage[],     // 当前投影上下文（摘要+保留尾部）
  raw: AgentMessage[],          // 未压缩原始历史（不含 system）
  checkpoint?: Checkpoint,      // 上一有效检查点
  baseline: UsageBaseline,
  options: CompactionOptions,
  manual: boolean,              // 手动压缩：不走阈值、不产生空检查点
  signal?: AbortSignal,
}): Promise<CompactionResult | undefined>;

// src/compaction/options.ts —— env 读取 + 解析补全两层
export function loadCompactionOptions(env?: NodeJS.ProcessEnv):
  Partial<CompactionOptions>;            // 只读 EXPLORER_COMPACTION_* env
export function resolveCompactionOptions(config: ExplorerConfig): CompactionOptions;
// resolve 把 config.compaction（Partial）补全为完整 CompactionOptions；
// 默认值与正数校验细节见该文件。maxTokens 字段由普通回复预算填充。
```

### 4.2 03 对既有文件的修改（仅限这两处）

- `src/config.ts`：`ExplorerConfig` 增加
  `compaction?: Partial<CompactionOptions>`（可选、允许部分字段），
  `loadConfig` 调 `loadCompactionOptions` 从 env 填充；使用方再经
  `resolveCompactionOptions(config)` 把 Partial 补全成完整
  `CompactionOptions` 使用。
- `src/agent/model.ts`：自定义端点声明能力改为
  `maxTokens: Math.min(contextWindow, Math.max(config.maxTokens,
  resolveCompactionOptions(config).compactionMaxTokens))`——
  **声明上限必须同时覆盖普通回复与摘要预算**：`config.maxTokens`
  是普通回复预算，摘要预算取补全后的 `compactionMaxTokens`（不是
  `config.compaction.maxTokens`，那是回复预算口径），否则
  `generateSummary` 的窗口余量计算会把摘要预算钳死。普通请求的每请求
  `maxTokens` 仍由 explorer-agent.ts 的 streamFn 按 `config.maxTokens`
  提供，不受声明上限影响。
- 内置 provider（openai/anthropic 目录模型）自带真实 maxTokens，无需改。

### 4.3 03 验收（离线）

对齐 Rudy 测试面：80% 阈值与 fits() 输出预留、usage 基准/缺失回退估算、
recentStart 工具批次不可拆与 1.2 倍边界、多次压缩边界单调、
空摘要/截断/临时错误有限重试、取消传播、摘要请求不递归触发压缩、
手动 compact 不生成空检查点、声明 maxTokens 覆盖摘要预算的
model-config 用例。

## 5. 任务 04：Planner/CLI 接入与离线集成测试

把 02、03 接进 `PlannerSession`（参考 Rudy `src/session/session.ts` 的
接线方式：message_end 订阅持久化 + `agent.prepareRequest` 钩子压缩）。

### 5.1 实际契约（已实现；权威注释见 `src/agent/session.ts`）

```ts
// 持久化入口
export interface PersistentPlannerOptions extends ExplorerAgentOptions {
  sessions: SessionRepository;   // 调用方创建并负责 close()；":memory:" 供测试
  userId: string;                // 认证后用户标识；CLI 取 EXPLORER_USER_ID，
                                 // 默认 "local"（本地演示，不是认证）
  sessionId?: string;            // 缺省=该用户主会话（幂等建立）；
                                 // 显式给定须同用户且 active
  leaseOwner?: string;           // 缺省 planner-<pid>-<rand>
  leaseTtlMs?: number;           // 默认 30s；心跳缺省 ttl/3
  leaseRenewMs?: number;
  compaction?: CompactionOptions; // 缺省 resolveCompactionOptions(config)
  validate?: PlannerSessionOptions["validate"];
  maxCorrections?: number;
}
export function createPersistentPlanner(
  options: PersistentPlannerOptions,
): Promise<PlannerSession>;

// 运行时接缝（PersistentRuntime 实现；PlannerSession 持久模式委托它）
export interface PlannerRuntime {
  prompt(text: string, options?: PlannerPromptOptions): Promise<PlannerTurn>;
  compact(): Promise<PlannerCompactOutcome>;   // { applied: boolean; error?: string }
  cancel(): void;
  close(): Promise<void>;
  readonly busy: boolean;
  readonly sessionId: string;
}
export interface PlannerPromptOptions { requestId?: string; }  // 请求级幂等键

// PlannerSession 增加：runtime?（@internal 注入）、restorePlan()、
// performTurn(text, { signal })（@internal）、cancel()、close()；
// prompt/compact 持久模式走 runtime，内存模式 compact 明确报错。
```

### 5.2 运行时职责（`src/agent/persistent/` 实现口径）

模块拆分：`runtime.ts`（PersistentRuntime：整轮编排、inFlight 跟踪、
close/cancel）、`lease.ts`（LeaseGuard：租约窗口/心跳/闩锁，写失败上闩
+ abort，不让订阅异常被吞成"成功"轮次）、`history.ts`（RawHistory：
raw↔record 索引与序号换算）、`runs.ts`（settleRun 终态写入、
requestId 重放、child 候选恢复）、`context.ts`（规划状态注入
system section），另有 `src/agent/interrupted.ts`（尾部未闭环工具批次
补 isError toolResult）。

- 打开：`resolveSession`（显式 sessionId 校验同用户且 active；缺省
  `createUser` 幂等 → `getMainSession`）→ 租约内 `reload()` →
  挂 `message_end` 落库订阅与 `prepareRequest` 压缩钩子。
- 每轮 `reload()`（也在租约内）：遗留 queued/running run 标 `failed`
  → 增量 `listMessagesFrom` → `closeInterrupted` 补全尾部工具批次
  → `latestCompaction` 换算 firstKept → main 读 `getCurrentItinerary`
  恢复正式指针 / child 用 `latestCandidatePlan` 恢复自身候选 →
  `applyContext()` 重建投影（system 按当前配置 + 规划节注入）。
- `message_end`：system 消息不落库；无租约的事件不是写路径；写失败
  经 `guarded()` 上闩 + abort + 原样抛出。`baseline.observe` 同步记 usage。
- `prepareRequest`：调 `compact()`；有结果先 `persistCheckpoint` 落库
  （firstKept 数组序号 ↔ first_kept_message_seq 在此换算），成功才
  `applyContext()` 切换——交回 Pi 循环的是**独立数组**（消息对象与
  raw 同引用），循环与事件各写各的数组，共享会双写。
- `prompt`：busy 互斥（同会话第二请求报错）→ reload → `requestId`
  查重（`findRunByRequestId` 扫本会话 run.input；同键同文本 →
  `replayedTurn` 返回既有 run 结果，同键不同文本 → `request_conflict`
  error turn，不建 run 不写消息）→ `createRun(startImmediately)` →
  `performTurn(text, { signal })` → `settleRun` 落终态
  （写不进时返回警告文本，不覆盖他人数据）。
- **已提交优先**：`turnCommitted` 线性化点——`commitValidatedPlan`
  返回（plan 标注+指针已同事务落库）或本轮产出非 error turn 后，
  迟到 cancel/close 不再把 completed 抹成 cancelled。
- `compact()`（手动）：记一条 `kind='manual_compact'` run；
  返回 `{ applied, error? }`，checkpoint 已落库即 completed。
- plan 注入：`context.ts` 把已确认/候选规划渲染进 system 的
  `confirmed_itinerary` / `candidate_itinerary` section（进预算、
  不进 raw、不落库），每轮请求可见，不依赖摘要保留；child 候选
  明确标注"仅本子会话有效，不是主会话正式行程"。
- `close()`：op 异步链（含 Agent 事件回调）内调用明确 reject 且不改
  状态（引导改用 `cancel()` 或由 op 外调用方 close）；外部 close 取消
  并等 inFlight 整轮收尾 → 退订、恢复 prepareRequest、停心跳、放租约；
  并发 close 共享同一 Promise（方法故意非 async）。
- 幂等键落在 `prompt(text, { requestId })`：run.input 记 requestId，
  首轮 user 消息带 `request:{id}` dedupe_key；CLI 无重试语义不传 key，
  未宣称 HTTP 级幂等。`/compact` 只按 slash 命令解析，裸 `compact`
  单词照常进模型；未知 slash 命令报提示不送模型。

### 5.3 集成测试（离线，faux provider）

- 首轮 → 关闭 → 重开：上下文、confirmed constraints、行程恢复。
- 触发压缩（压低窗口/阈值注入）→ compaction record 落库 →
  重开后按边界重建，原文仍在。
- 校验通过 → plan 标注 + 指针；再一轮失败校验 → 状态不覆盖。
- 去重键重放、archived 会话拒写、忙时第二 prompt 报错。
- 任务 09 新增 7 条回归：op 内 close reject、commit 后迟到 cancel、
  child 候选恢复及重放/终态边界（详见验收文档）。

## 6. 任务 05+：sol 只读 review 与修复批次

- sol 首审：对照 `docs/users-and-sessions.md` §10 验收清单逐条核对、
  文件归属无越界、payload 形状一致、MIT 来源注释、无密钥/路径泄露、
  无真实 API 调用路径进测试——提出 6 项问题，已修复并经复审 closed。
- 扩展复审：追加 3 项（op 异步链内 close 死锁、commit 后迟到 cancel、
  child 候选继承），任务 09 修复并新增 7 条回归。
- sol 最终复审（已完成）：独立全套 **261/261**、定向回归 **28/28**
  通过；扩展项中 op 内 close、迟到 cancel 两项 **closed**；child 候选
  恢复常规继承修复有效，但真实时钟下同毫秒并列仍可能恢复旧候选
  ——**P2 open**（复现：新旧两 run 的 createdAt/finishedAt 落在同一
  毫秒，决胜次序依赖随机 run_id 而选中旧者；建议以关联记录的
  message_seq 做稳定排序，尚未实施）。另记录 **P3**：
  `PlannerSession.close()` 在 runtime 判拒前先 `unsubscribeTrace()`，
  被拒后漏 `toolCalls` 跟踪。
- 当前：P2/P3 修复待实施并重验，**验收未最终通过**；逐条结论见
  [session-persistence-acceptance.md](session-persistence-acceptance.md)。

## 7. 风险与备注

- `node:sqlite` `DatabaseSync` 是同步 API；会话库单进程单连接使用，
  多实例部署时靠 DB 租约（行级 CAS）而非进程锁；SQLite 单文件只适合
  同主机共享，跨主机部署需替换仓库实现（接口为 Promise 已预留）。
- compaction `firstKept`（数组序号）↔ `first_kept_message_seq` 的换算
  依赖"raw 与 message 记录一一对应"这条不变量；合成消息（摘要消息、
  规划状态注入节）只进 `replacement`/system section，不进 raw——
  该约束已在 runtime 层落实，未来新增合成消息同样不得入 raw。
- `latestCompaction`（按写入前缀逐条校验）、`listRecords`、
  `findRunByRequestId` 目前按会话全历史扫描；超大历史需索引/分页，
  属后续优化项。
- runs 表本期只记录生命周期；自动调度、异步投递执行器、历史分页
  工具属后续版本，字段已预留但接口不得提前承诺。
- `src/agent/persistent/` 长模块（runtime.ts 等）超出"单文件 ≤200 行"
  的仓库口径：属维护性改进跟进项，不声称已达标。
- Rudy 移植代码保留来源注释（pi 1.4.0 MIT）；移植文件头注明
  `Adapted from Rudy src/compaction/*` 及 pi MIT 声明链路。
