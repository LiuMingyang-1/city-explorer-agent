# 用户与会话数据设计

日期：2026-11-11。状态：已确认方案；任务 02–04 与评审修复已在当前
工作树实现（未提交）：SQLite 仓库、压缩核心、Planner/CLI 接入、持久
运行时与离线测试。sol 复审已完成：独立全套 261/261、定向回归 28/28
通过，首审 6 项与扩展 3 项中 2 项 closed；遗留 1 项 P2（child 候选
稳定排序）与 1 项 P3 待修复重验，**尚未最终通过**。任务拆分见
[session-implementation-plan.md](session-implementation-plan.md)，验收状态见
[session-persistence-acceptance.md](session-persistence-acceptance.md)。

本文取代 2026-11-11 早些时候的讨论稿：原 `messages` / `compactions` /
`session_states` 三张分表合并为统一追加日志 `session_records`，并新增 `runs`
记录 Agent 运行生命周期。本文定义语义边界；方法级签名、参数与错误码以
`src/session/types.ts`、`src/session/repository.ts` 的注释为准。

2026-11-12 更新：`kind='main'` 语义由"每用户唯一长期主会话"重述为
"用户面顶层对话会话"（每用户可有多个，每次访问即新对话），同步子 Agent
派发工具 `delegate_task` 已落地；方案与验收见
[conversations-and-orchestration.md](conversations-and-orchestration.md)。

## 1. 已确认的方向

- 面向 Web 多用户部署，会话数据存数据库（Node ≥22 内置 `node:sqlite`），
  不按用户或会话建文件夹、不用 JSONL。
- 每个 Web 用户可有**多个顶层对话会话**（`kind='main'`，"对话即 main"）：
  每次访问即新对话，由 `createConversation` 在首条消息时懒建；跨对话
  连续性完全由 `user_memory` 长期记忆承担（见
  [conversations-and-orchestration.md](conversations-and-orchestration.md)）。
- 对话会话持续追加消息并压缩，**压缩不更换 session_id**。
- 子 Agent 由对话会话派出处理独立任务（`kind='child'`）；子 Agent 可
  **递归**再派生子 Agent，
  所有会话通过 `parent_session_id` 构成树，全部上下文按用户授权隔离。
- 本期只做后端库与 CLI 集成；不做登录/认证服务，`user_id` 由调用方在
  认证后给出，存储层只校验归属、不识别身份。前端由独立工作流推进，
  不在本期范围，本文不覆盖其验收。
- 压缩借鉴本机 Rudy（`/Users/lmy/Documents/code/rudy`，只读参考）与
  pi 1.4.0 的方案：同一模型独立摘要请求、近期原文按完整工具批次保留、
  写检查点成功后才切换运行上下文。

对话会话数据长期保留，但不要求 Agent 进程常驻；恢复指定会话时从数据库
重建其上下文。

## 2. 表结构总览

```text
users
  ├─ user_memory         （每用户一行：长期记忆文档 + 蒸馏游标）
  └─ sessions            （kind=main 对话会话，每用户可有多个）
                           ├─ session_records （统一追加日志：message | compaction）
                           ├─ sessions        （kind=child，parent_session_id 递归成树）
                           └─ runs            （一次 Agent 运行的生命周期记录）

events（既有活动表）：本方案不改动。
```

- `users` 是数据归属边界；`sessions` 是上下文与任务的边界。
- `session_records` 同时承担消息记录与压缩检查点：一条 append-only 日志，
  原始消息**永不因压缩被删除**。
- `runs` 记录"哪次运行、在哪个会话、为谁、由谁派出、结果如何"，是异步
  子任务与投递机制的数据基础；消息可关联到产生它的 run。
- `user_memory` 保存跨会话蒸馏的用户长期记忆文档与蒸馏游标
  （`src/memory/`）：运行时 reload 把文档注入 system 的
  `memory_context` 节（main/child 同规则），main 会话 close 时
  机会性触发蒸馏写回并推进游标。

所有时间字段为 UTC ISO-8601 文本（`created_at` 等）；所有 ID 为服务端生成的
不透明字符串（建议 UUID），不使用昵称、序号当标识。

**归属校验贯穿所有读写**：仓库 API 的每个会话级方法都显式携带 `userId`
参数——不只靠外键关联，而是逐方法校验"会话/记录/run 属于该用户"：

- 单实体读取（`getSession` / `getRun`）：不属于该用户一律按不存在返回；
- 范围读取（`list*` / `latestCompaction` / `getRecord` / `getCurrentItinerary`）：
  范围实体不存在或不属于该用户 → `not_found`；
- 写路径：跨用户 → `cross_user`，引用实体缺失 → `not_found`；
- 会话级写还要求有效租约（见 §4）：owner+epoch 匹配、未过期、会话 active，
  否则 `lease_lost` / `archived`。

错误以 `SessionRepositoryError` 抛出，code 取值：`cross_user` /
`not_found` / `lease_lost` / `archived` / `conflict` / `invalid_state` /
`invalid_payload` / `corrupt`（定义见 `src/session/types.ts`）。

## 3. users：用户入口与对话创建

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | TEXT | 是 | 主键 |
| `display_name` | TEXT | 否 | 展示名，可改，不参与授权 |
| `created_at` | TEXT | 是 | |
| `updated_at` | TEXT | 是 | |

约束：`createUser` 幂等——`user_id` 已存在时返回既有用户；只插入
`users` 行，**不附带创建任何会话**。对话会话由
`createConversation(userId, { title? })` 按需创建：`kind='main'`、
`parent_session_id IS NULL`、不要求租约；用户不存在 → `not_found`。
同一用户可创建任意多个对话会话（原"每用户唯一 main"的
`idx_sessions_main` 部分唯一索引已移除；老库升级时
`ensureSessionSchema` 会 DROP 掉该索引，`users.main_session_id`
老列保留为死列、代码不再引用）。

## 4. sessions：会话归属、层级与运行权

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 主键；压缩、恢复不改变它 |
| `user_id` | TEXT | 是 | 所属用户，创建后不可转移 |
| `kind` | TEXT | 是 | `'main'` / `'child'` |
| `parent_session_id` | TEXT | child 必填 | 父会话，必须与 child 同用户；多级递归时指向直接父会话 |
| `title` | TEXT | 否 | 便于识别，如"周六看展方案比较" |
| `status` | TEXT | 是 | `'active'` / `'archived'`；任意 active 会话可归档 |
| `current_itinerary_record_id` | TEXT | 否 | **仅 kind='main' 对话会话可维护**；指向本会话一条通过校验的 assistant 消息记录，见 §7 |
| `lease_owner` | TEXT | 否 | 当前写者标识（实例/worker ID）；为空表示无写者 |
| `lease_epoch` | INTEGER | 是 | 租约纪元，每次成功获取 +1；写操作须携带当前 epoch |
| `lease_expires_at` | TEXT | 否 | 租约过期时间；过期后他人可抢占 |
| `last_activity_at` | TEXT | 是 | 最近实质活动时间（消息追加 / run 状态推进 / plan 标注），列表排序用 |
| `created_at` / `updated_at` | TEXT | 是 | |

约束与规则：

- 对话即 main：`kind='main'` 表示用户面顶层对话会话，每用户可有多个；
  `kind='child'` 专职表示子 Agent 派生的任务会话（表内 CHECK：main 无父、
  child 必有父）。
- `parent_session_id` 指向的会话必须属于同一 `user_id`；跨用户父子关系拒绝。
  创建 child 会话需持**父会话**写租约，且父会话必须 active。
- `current_itinerary_record_id` 指向的 `session_records` 行必须属于**本会话**，
  且 `kind='main'` 才允许设置；child 会话该列必须为 NULL。指针只前进：
  新指针记录的 `seq` 必须大于当前指针记录（回退 → `conflict`）。
- **单写者租约**：任何修改会话数据的写者须先 `acquireLease` 取得
  `(owner, epoch, expires_at)`；续期与所有会话级写操作都校验
  `lease_owner = ? AND lease_epoch = ?`（UPDATE WHERE 携带，影响行数 0
  即 `lease_lost`）。获取条件：无 owner、`lease_expires_at < now`（过期
  可抢占）、或同 owner 重复获取——成功即 `lease_epoch + 1`。
  已过期租约**不能**通过续期复活（`renewLease` 返回 false）；`releaseLease`
  只清 owner+epoch 匹配的租约，不误清新 owner。旧 worker 因 epoch 已推进
  而无法再写——防止崩溃残留与"僵尸写者"。
- `last_activity_at` 由消息追加、run 状态推进与 plan 标注的同事务推进；
  `type='compaction'` 记录只推进 `updated_at`，**不**刷新
  `last_activity_at`（纯压缩不是用户可见进展），也不按"当前时间"随意刷新。
- 归档：任意 active 会话（含 main 与 child）可归档；归档会话只读，
  所有写与租约操作拒绝（`archived`），租约字段同时清除。

## 5. session_records：统一追加日志

沿 Rudy JSONL 的思路落库：会话历史是一条 append-only 记录流，消息与压缩
检查点是同一序列里的两种记录。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `record_id` | TEXT | 是 | 主键 |
| `session_id` | TEXT | 是 | 所属会话 |
| `seq` | INTEGER | 是 | 会话内单调递增的**记录序号**，`(session_id, seq)` 唯一；事务内 `max(seq)+1` 分配 |
| `type` | TEXT | 是 | `'message'` / `'compaction'` |
| `message_seq` | INTEGER | message 必填 | **消息序号**：会话内稳定、唯一、单调；`type='compaction'` 时为 NULL。与 `seq` 是两个序列，不可混用 |
| `payload` | TEXT（JSON） | 是 | 记录体，结构按 `type` 区分，见下 |
| `run_id` | TEXT | 否 | 产生该消息的 run；**必须与消息同会话**，校验见 §6 |
| `source_run_id` | TEXT | 否 | 消息的来源 run（如子任务回传）；同用户即可，与归属 run 分开 |
| `dedupe_key` | TEXT | 否 | 会话内唯一（部分唯一索引）；请求重试、工具结果、子任务回传的防重复键 |
| `created_at` | TEXT | 是 | |

唯一约束：`(session_id, seq)`、`(session_id, message_seq)`（message 行）、
`(session_id, dedupe_key)`（dedupe_key 非空行）。

记录级规则：

- message 的角色限 `user` / `assistant` / `toolResult`；`toolResult` 必须
  引用本会话**已存在**的 `toolCallId`（拒绝孤立工具结果）。
- `dedupe_key` 撞键且 `type` / `payload.message` / run 关联一致 → 幂等
  返回既有记录，不重复追加；同键内容不同 → `conflict` 拒绝。

### 5.1 `type='message'` 的 payload

```json
{
  "message": { "role": "assistant", "content": [ "..." ], "...": "Pi AgentMessage 原样" },
  "plan": { "constraints": { "...": "..." }, "itinerary": { "...": "..." } }
}
```

- `message`：Pi `AgentMessage` 原始结构逐字保存（内容、工具调用参数、
  工具结果、usage、stopReason 等），不能只存展示文本。角色限
  `user` / `assistant` / `toolResult`；system 属于运行时配置，**不落库**，
  恢复时按当前配置重建。
- `plan`（可选）：仅出现在"通过校验的 assistant 消息"上，且只能经
  `commitValidatedPlan` 附加（调用方不得在 `appendMessage` 时自带）。
  `PlannerSession` 确认约束与行程后，在保留原始 `message` 之外追加这份
  已验证的规划元信息（完整 effective constraints + itinerary），供
  `current_itinerary_record_id` 指针恢复，替代旧方案的 `session_states` 表。
- 追加 plan 元信息与设置 `current_itinerary_record_id` 必须在**同一事务**，
  保证指针不指向未标注或未保存的消息。除这次受控标注外，已追加 record
  不可改写（append-only）。

### 5.2 `type='compaction'` 的 payload

```json
{
  "summary": "供模型继续工作的历史摘要文本",
  "source_through_message_seq": 40,
  "first_kept_message_seq": 31,
  "tokens_before": 0, "tokens_after": 0,
  "model_ref": "provider/model",
  "usage": { "...": "摘要请求 usage" }
}
```

- `summary` 必填非空；是历史资料而非系统指令。
- `source_through_message_seq`：生成摘要时看到的最大 `message_seq`；
  **提交时必须等于当时库内最大 `message_seq`**（单写者下的兜底校验，
  防止压缩计算与提交之间混入新消息）。
- `first_kept_message_seq`：仍重放原文的起点 `message_seq`；
  无近期原文时为 `当时最大 message_seq + 1`。必须落在安全边界——
  取值区间 `[最小 message_seq + 1, 最大 message_seq + 1]`、不得小于
  上一条有效检查点的边界（边界单调不回退），且只能落在**完整工具
  批次之外**：既不能切断未闭环的调用头（assistant toolCall 与其
  toolResult 之间），也不能切进任一已闭环的 call→result 片段中间；
  指向的消息不得是 toolResult。
- `summary` 的生成输入**包含保留尾部**（`first_kept..through` 的消息
  同样喂给了摘要请求），因此 `source_through_message_seq` 覆盖范围
  与重放原文重叠是**预期设计**：摘要见过尾部，恢复时尾部仍按原文
  逐字重放以保证连续性，不算数据重复。
- `tokens_*`、`model_ref`、`usage` 为观测字段，不参与恢复正确性。
- 不设独立 `source_version`：检查点是否过期由 `seq` 顺序决定——恢复只认
  **最新一条合法 compaction**，旧检查点自然失效，原始消息也仍在。

### 5.3 seq 与 message_seq 的分工

```text
seq=39  type=message     message_seq=39   assistant: 行程 JSON（带 plan）
seq=40  type=compaction  message_seq=NULL summary（first_kept=31, through=39）
seq=41  type=message     message_seq=40   user: "第二个换一个"
```

`seq` 回答"日志第几条"（含 compaction）；`message_seq` 回答"第几条消息"
（压缩边界、工具批次完整性都用它）。compaction 插入后 `seq` 继续 +1，
`message_seq` 只在 message 行上增长。

## 6. runs：Agent 运行生命周期

一次"请求 → 工具循环 → 产出"的执行记录。数据模型支持递归层级
（子 run 可再派生 run）；同步派发工具 `delegate_task` 在运行时层已落地
（父轮内建 child 会话与子 run，见
[conversations-and-orchestration.md](conversations-and-orchestration.md) §5），
**不实现后台异步调度**。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `run_id` | TEXT | 是 | 主键 |
| `user_id` | TEXT | 是 | 归属用户；须等于 `session_id` 所属用户 |
| `session_id` | TEXT | 是 | 本 run 在哪个会话执行（上下文/租约边界） |
| `parent_run_id` | TEXT | 否 | 派出本 run 的父 run；同用户 |
| `root_run_id` | TEXT | 否 | 递归树的根 run；无父时等于自身 run_id |
| `reply_to_session_id` | TEXT | 否 | **结果投递目标**会话；与执行所在 `session_id` 是两列，分开校验（同用户） |
| `status` | TEXT | 是 | `'queued'` / `'running'` / `'completed'` / `'failed'` / `'cancelled'` |
| `input` | TEXT（JSON） | 是 | 输入快照：任务目标、相关约束、必要资料（不复制父会话全部历史）；上层约定可携带 `requestId` 作请求级幂等键、`location` 记录该轮透传的用户位置（恢复会话最近位置的依据） |
| `result` | TEXT（JSON） | 否 | 完成时的结果摘要；须持久化，供回投与重放（上层存 `{ turn }` 快照） |
| `error` | TEXT | 否 | 失败原因 |
| `cancel_requested` | INTEGER | 是 | 0/1；取消是状态标记，不删除记录 |
| `delivered_at` | TEXT | 预留 | 结果回投到 `reply_to_session_id` 的时间；**本期不实现投递**，恒为 NULL |
| `created_at` / `started_at` / `finished_at` | TEXT | 是/否/否 | |

规则：

- 失败与取消都保留历史行（status + error/cancelled 标记），不删记录。
- `parent_run_id` 链上的所有 run 必须同 `user_id`；`reply_to_session_id`
  必须是同用户会话。**执行边界与投递目标分开**：`session_id` 决定上下文
  与租约，`reply_to_session_id` 只描述结果去向。
- 状态机：`createRun` 缺省建 `queued`，`startImmediately` 可在创建时原子
  置 `running`（同写 `started_at`）；`startRun` 仅 queued → running；
  `finishRun` 仅 queued/running → 终态，**终态不可相互覆盖**（已终态
  再写 → `invalid_state`）。`cancelled` 终态要求此前已
  `requestCancelRun`（`cancel_requested=1`），否则 `invalid_state`；
  `requestCancelRun` 对已终态 run 返回 false，不覆盖。
- 写者重开/恢复时：会话内遗留的 `queued`/`running` run 统一标记
  `failed`（上一写者崩溃或租约丢失），不留永远 running 的行。
- 消息通过 `session_records.run_id` / `source_run_id` 关联到 run；
  `run_id` 必须与消息同会话，`source_run_id` 同用户即可。
- 递归深度不设上限（数据层面），仓库 API 支持任意层级创建与逐层
  关联查询（`listRunsByParent`），不硬编码"只能 1 层"。
- 请求级幂等（上层运行时的约定用法）：调用方在 `input` 中携带
  `requestId`，首轮 user 消息以 `request:{requestId}` 为 `dedupe_key`；
  同会话同 `requestId` 重放直接返回既有 run 的持久化结果，同键不同
  文本是调用方错误 → 明确 `conflict`/拒绝，不建 run 不写消息。

## 7. 恢复与压缩流程

### 7.1 有效上下文重建

```text
恢复输入：sessions 行 + 该会话记录（均在会话写租约内执行）
0. 校验会话归属用户；把遗留 queued/running run 标 failed（见 §6）。
1. 增量加载 message_seq 大于本地已知的 message 记录；
   尾部未闭环的工具批次补 isError 的 toolResult（补全中断，不重跑工具）。
2. 取最新一条**合法** compaction（仓库按写入时前缀逐条校验，
   任一已存记录非法 → corrupt 报错）。
3. 有效消息 = 摘要消息（由该 compaction 合成） + 全部
   message_seq >= first_kept_message_seq 的原始消息。
   —— 按 message_seq 边界重建：无论这些原始消息在 seq 上位于检查点
      之前（保留尾部）还是之后（检查点后新增），一律重放。
4. 无合法 compaction 时，有效消息 = 全部原始消息。
5. system 提示、工具声明、规划状态注入节由当前配置重建，永远不回放
   旧配置；注入的规划节进 system section、进预算，但不进 raw/不落库。
6. 规划状态：kind='main' 对话会话读 current_itinerary_record_id → 取该 record 的
   plan 元信息恢复 confirmed constraints 与行程；child 会话不读指针，
   从自身最新一条 completed 且结果为 itinerary 的 run 恢复**候选**
   规划（见 §7.3）。
```

示例（接 §5.3）：恢复后发往模型的是
`当前 system（含规划节） + 摘要(覆盖 message_seq 1–39) + 原文 message_seq 31–40`；
`message_seq 40` 是检查点之后的新消息，照样保留。

合法 compaction 校验（对齐 Rudy `validCheckpoint` 思路）：summary 非空、
first_kept ∈ `[最小 message_seq + 1, 最大 message_seq + 1]`、
first_kept 指向的消息不是 toolResult（不切断工具批次）、
first_kept 不小于上一条有效检查点的边界。**每条检查点都按它写入时的
记录前缀校验**，不按最终全历史——检查点之后追加的消息不影响其合法性。
非法记录报错（`corrupt`）而非静默跳过。

### 7.2 压缩提交（写路径）

```text
生成并校验摘要 → 检查压缩后预算（确有缩减且容得下一次请求+输出）
→ 事务内追加 compaction record（seq 分配、through==当时最大 message_seq、
  边界校验都在同一事务）→ 成功后切换运行上下文；失败保留原上下文并报告
```

模型调用不占长事务；追加写盘失败不切换内存上下文、不重新花请求。
检查点记录只推进 `updated_at`，不刷新 `last_activity_at`。

### 7.3 规划状态（无 session_states 表）

`current_itinerary_record_id` + 该消息 `payload.plan` 即"已确认规划状态"：

- 只有 `validateItinerary` 通过的那条 assistant 消息才被标注并设为指针；
  失败候选、追问、压缩都不覆盖。
- 指针单调推进到更新的已验证消息；会话恢复时读指针恢复
  `PlannerSession.constraints` / `itinerary`，并由运行时把已确认状态渲染进
  system 的 `confirmed_itinerary` section 显式注入，而不是靠摘要记。
- **child 会话无正式指针**：其"候选规划"只来自本 session 最新一条
  `completed` 且结果为 itinerary 的 run；failed/cancelled/追问轮与无法
  解析的结果不覆盖更早的成功候选。候选经 `candidate_itinerary`
  section 注入并明确标注候选身份——绝不更新 main 对话会话的指针、
  不冒充 main 的正式行程，main 与 child 的规划状态完全独立。"最新"必须由
  **确定性次序**判定：时间戳（含同毫秒并列）与随机 `run_id` 不构成
  次序依据，须以单调序号（如关联记录的 `message_seq`）决胜——
  当前实现的并列决胜仍可能选中旧候选，属已记录 P2 待修项
  （见 [session-persistence-acceptance.md](session-persistence-acceptance.md)
  §3 第 3 项）。
- 新需求版本管理、未确认约束的异步冲突检测：本期数据结构**不覆盖**，
  标为待扩展（见 §9），不假装实现。

## 8. 并发与一致性规则

- 同一会话的写操作（追加消息、提交检查点、推进指针、归档、run 状态
  推进）必须在租约持有下进行；同会话并发请求第一版返回"正在处理"，
  不隐式并发；不同会话可并行。
- `dedupe_key` 非空撞键：内容一致 ⇒ 幂等返回既有记录；内容不同 ⇒
  `conflict`，不重复追加。
- 用户初始化与对话创建、消息追加（seq/message_seq/last_activity_at）、
  检查点提交、plan 标注+指针推进、租约变更、run 创建/状态推进均为单事务；
  长模型调用放在事务外。
- **关闭/取消语义**（运行时层）：在会话操作的异步链（含 Agent 事件
  回调）内调 `close()` 明确 reject 且不改变状态——要中止当轮用
  `cancel()`，`close()` 由该操作之外的调用方执行；外部 `close()` 等待
  在途整轮（含验证/纠正/run 收尾）真正结束后才退订、停心跳、放租约；
  并发 `close()` 共享同一个收尾 Promise。
- **已提交优先**：plan 提交（`commitValidatedPlan` 返回）或 run 结果落库
  是线性化点，此后到达的 cancel/close 不能再把已完成的 run 抹成
  cancelled；run 终态不可相互覆盖。
- 请求级幂等：同会话同 `requestId` 重放返回既有 run 的持久化结果，
  与 `/run`/`result` 记录一致；同 `requestId` 不同文本 → 明确冲突。
- 跨归属检查：session→user、parent→同用户、run→同用户、
  reply_to→同用户、itinerary 指针→同会话且 main、record/run 关联→
  同会话/同用户，均在仓库层断言。
- 归档会话只读；任意 active 会话（含 main 对话会话）可归档，归档后
  写与租约操作一律拒绝（`archived`）。

## 9. 本期实现范围 vs 明确暂不做

**本期（任务 02–04 + 评审修复）实现：**

- `node:sqlite` 持久仓库：users/sessions/session_records/runs/user_memory
  五表（user_memory 存跨会话蒸馏的长期记忆文档与游标）、
  幂等建表（含老库 `idx_sessions_main` 索引 DROP 兼容）、
  全方法 userId 归属校验、`createUser` 幂等初始化与
  `createConversation` 多对话会话创建（对话即 main，每用户可有多个）、
  单写者租约（owner+epoch+expiry、过期抢占、不可复活）、消息去重
  与冲突、孤立 toolResult 拒绝、run 状态机与终态保护、
  任意 active 会话可归档。
- 对话即 main 会话模型与同步子 Agent 编排：`delegate_task` 派发工具
  建 `kind='child'` 任务会话与子 run（`parent_run_id` /
  `reply_to_session_id` / `root_run_id` 写全），结构化结果回传父 Agent
  ——详见
  [conversations-and-orchestration.md](conversations-and-orchestration.md) §5。
- 独立压缩核心：自动（每次模型请求前，含工具循环续跑）与手动 compact、
  同一模型独立摘要预算（初始 8192）、安全工具批次切分、有限重试、取消、
  检查点落库成功才切换上下文；摘要提示词保留城市规划日期/约束/
  活动 ID/已拒选项；参数沿 Rudy 默认可调。
- Planner/CLI 接入与持久运行时：恢复（死 run 标记、中断批次补全、
  检查点投影、main 指针 / child 候选）、message_end 逐条落库、
  prepareRequest 压缩钩子、plan 标注、请求级幂等重放、
  规划状态 system section 注入、长期记忆 `memory_context` 注入与
  main 会话 close 机会蒸馏、close/cancel 语义、
  离线（faux provider）集成测试。

**数据支持但本期不实现（不假装已实现）：**

- 异步多 Agent 调度：`delegate_task` 同步派发已落地；runs/父子会话
  层级支持递归创建与关联查询。本期不做 queued run 后台执行器、
  后台唤醒与向 `reply_to_session_id` 的结果投递、`delivered_at` 标记
  （字段保留，恒为 NULL）。
- 历史分页读取工具（`read_session_history` 类）：数据具备条件，
  工具入口另行设计，未实现前摘要提示不得承诺可调用。
- 新需求版本化、未确认约束的异步冲突解决、长期用户偏好表、
  认证/登录、数据保留与删除策略。
- 前端/web 界面：由独立工作流推进，不在本期范围，本文不覆盖其验收。

**已知代价与边界（如实记录）：**

- SQLite 单文件适合**同主机**多进程共享（靠 DB 租约协调）；跨主机/
  远端部署需替换仓库实现，接口已按 Promise 预留。
- `latestCompaction`（按写入前缀逐条校验）、`listRecords`、按
  `requestId` 找 run 目前都按会话全历史扫描；超大历史需索引/分页，
  属后续优化项。
- CLI 的 `userId` 默认 `"local"` 是本地演示标识，**不是认证**。
- `src/agent/persistent/` 长模块（如 runtime.ts）超出"单文件 ≤200 行"
  的仓库口径，已登记为维护性改进项，不代表已达标。

## 10. 验收清单（实现任务须覆盖）

1. 用户间隔离：任何读/写不能跨 `user_id`；pointer、parent、run、
   reply_to 的跨用户/跨会话注入被拒绝。
2. 并发初始化：并发 `createUser` 幂等只产生一个用户行；对话会话由
   `createConversation` 按需创建，同一用户可建多个 `kind='main'`。
3. 单写者：两个"写者"竞争租约只有一个成功；过期租约可抢占且不可
   复活；旧 epoch 的写被拒绝。
4. 重启恢复：摘要 + 保留边界 + 后续消息重建正确；无检查点会话正常；
   含非法 compaction 明确报错；遗留 running run 被标 failed；尾部
   未闭环工具批次被补全。
5. 连续多次压缩：边界单调推进，原文仍在，不产生无效检查点。
6. 工具批次：边界不切在 assistant toolCall 与其 toolResult 之间；
   孤立 toolResult 拒绝；消息去重键撞键幂等、异内容冲突。
7. plan 标注与指针同事务；失败校验不覆盖已确认状态；指针只前进；
   重启后 confirmed constraints 恢复；child 只恢复自身候选不动 main。
8. 取消/失败：run 行与消息历史保留；取消不提交未完成摘要，
   已提交检查点不回滚；已提交结果不被迟到 cancel/close 抹成
   cancelled；终态不可相互覆盖。
9. 压缩触发覆盖工具循环内续跑；摘要请求不递归触发压缩；
   摘要输出预算独立于普通回复（8192 vs 4096），自定义端点声明的
   maxTokens 不钳死摘要预算。
