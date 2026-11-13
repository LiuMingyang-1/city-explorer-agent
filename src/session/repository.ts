import type {
  AppendCompactionInput,
  AppendMessageInput,
  CreateChildSessionInput,
  CreateConversationInput,
  CreateRunInput,
  CreateUserInput,
  CurrentItinerary,
  LeaseWriter,
  PutUserMemoryInput,
  Run,
  RunFinishOutcome,
  Session,
  SessionRecord,
  User,
  UserMemory,
  ValidatedCompaction,
  ValidatedPlan,
} from "./types.ts";

/**
 * 会话持久仓库接口（docs/architecture/sessions.md）。首版实现见 ./sqlite.ts。
 *
 * 归属模型：所有会话级读写都显式携带 userId——仓库不只靠 FK 关联，
 * 而是逐方法校验 "会话/记录/run 属于该 userId"：
 * - 单实体读取（getSession/getRun）：不属于该用户一律按不存在返回 undefined；
 * - 范围读取（list 系列 / latestCompaction / getRecord / getCurrentItinerary）：
 *   范围实体（session、parent run）不存在或不属于该用户 → not_found；
 * - 写路径：跨用户 → cross_user，实体缺失 → not_found；
 * - 会话级写（records、归档、run 生命周期）还要求有效租约 LeaseWriter：
 *   owner+epoch 匹配、租约未过期、会话 active，否则 lease_lost/archived。
 *
 * 实现是同步 SQLite，方法签名保持 Promise 以便替换远端实现。
 */
export interface SessionRepository {
  // ---- users / 初始化 ----
  /** 幂等：userId 已存在返回既有用户；否则只插入 users 行，不附带建会话。 */
  createUser(input: CreateUserInput): Promise<User>;
  getUser(userId: string): Promise<User | undefined>;

  // ---- sessions ----
  /**
   * 建一条用户面对话会话（kind='main'、无父）。不需要 LeaseWriter——
   * 无父会话就无树完整性要保护，归属由 userId 保证；用户不存在 → not_found。
   */
  createConversation(userId: string, input?: CreateConversationInput): Promise<Session>;
  getSession(userId: string, sessionId: string): Promise<Session | undefined>;
  /** 该用户全部会话（main 对话 + child 任务），last_activity_at 降序。 */
  listSessions(userId: string): Promise<Session[]>;
  /** 需持父会话租约；父会话必须同用户且 active。 */
  createChildSession(
    writer: LeaseWriter,
    userId: string,
    input: CreateChildSessionInput,
  ): Promise<Session>;
  /** 任意 active 会话（含 main 与 child）可归档；归档后会话只读，租约字段清除。 */
  archiveSession(writer: LeaseWriter, userId: string, sessionId: string): Promise<void>;

  // ---- 单写者租约 ----
  /**
   * 获取会话写租约：无 owner/已过期（expires < now）/同 owner 时可得，
   * 成功 lease_epoch+1；他人持有未过期返回 undefined。
   */
  acquireLease(
    userId: string,
    sessionId: string,
    owner: string,
    ttlMs: number,
  ): Promise<LeaseWriter | undefined>;
  /** 续期：owner+epoch 匹配且未过期才延长；已过期租约不能复活 → false。 */
  renewLease(
    writer: LeaseWriter,
    userId: string,
    sessionId: string,
    ttlMs: number,
  ): Promise<boolean>;
  /** 释放：只清除 owner+epoch 匹配的租约，不会误清新 owner。 */
  releaseLease(writer: LeaseWriter, userId: string, sessionId: string): Promise<void>;

  // ---- records（统一追加日志） ----
  /**
   * 追加消息记录：分配 seq/message_seq、推进 last_activity_at，单事务。
   * dedupeKey 撞键且 type/payload.message/run 关联一致 → 幂等返回既有记录；
   * 内容不同 → conflict。toolResult 必须引用本会话已有的 toolCallId（拒孤立）。
   */
  appendMessage(
    writer: LeaseWriter,
    userId: string,
    sessionId: string,
    input: AppendMessageInput,
  ): Promise<SessionRecord>;
  /**
   * 追加压缩检查点：through 必须等于当前最大 message_seq；
   * first_kept ∈ [min+1, max+1]、不指向 toolResult、不小于上一检查点边界；
   * 只推进 updated_at（不动 last_activity_at）。单事务。
   */
  appendCompaction(
    writer: LeaseWriter,
    userId: string,
    sessionId: string,
    input: AppendCompactionInput,
  ): Promise<SessionRecord>;
  /**
   * 标注 plan + 推进 current_itinerary_record_id，单事务。
   * 仅 main 会话；record 必须是本会话的成功 assistant 消息且未带 plan；
   * 指针只能前进（新记录 seq 必须大于当前指针记录）。原 message 不变。
   */
  commitValidatedPlan(
    writer: LeaseWriter,
    userId: string,
    sessionId: string,
    recordId: string,
    plan: ValidatedPlan,
  ): Promise<void>;
  /** 全部记录按 seq 升序。 */
  listRecords(userId: string, sessionId: string): Promise<SessionRecord[]>;
  /** message 记录中 message_seq >= firstMessageSeq 的部分，按 message_seq 升序。 */
  listMessagesFrom(
    userId: string,
    sessionId: string,
    firstMessageSeq: number,
  ): Promise<SessionRecord[]>;
  /**
   * 最新一条合法 compaction；无 → undefined；任一已存记录非法
   * （payload 校验失败、边界违反、孤立 toolResult）→ corrupt 抛错，不静默跳过。
   * 每条检查点都按它写入时的记录前缀校验，不按最终全历史。
   */
  latestCompaction(userId: string, sessionId: string): Promise<ValidatedCompaction | undefined>;
  getRecord(
    userId: string,
    sessionId: string,
    recordId: string,
  ): Promise<SessionRecord | undefined>;
  /** 主会话指针恢复：无指针 → undefined；指针数据损坏 → corrupt。 */
  getCurrentItinerary(
    userId: string,
    sessionId: string,
  ): Promise<CurrentItinerary | undefined>;

  // ---- runs ----
  /** 需持 session 租约；session 须同用户且 active；parent/reply_to 同用户。 */
  createRun(writer: LeaseWriter, userId: string, input: CreateRunInput): Promise<Run>;
  getRun(userId: string, runId: string): Promise<Run | undefined>;
  listRunsBySession(userId: string, sessionId: string): Promise<Run[]>;
  /** 直接子 run；父 run 不存在或跨用户 → not_found。递归层级逐层调用。 */
  listRunsByParent(userId: string, parentRunId: string): Promise<Run[]>;
  listRunsByUser(userId: string): Promise<Run[]>;
  /** queued → running；其余状态 → invalid_state。需持 run.sessionId 租约。 */
  startRun(writer: LeaseWriter, userId: string, runId: string): Promise<void>;
  /**
   * queued/running → 终态；已终态 → invalid_state（终态不可相互覆盖）。
   * cancelled 终态要求此前已 requestCancelRun（cancel_requested=1）。
   */
  finishRun(
    writer: LeaseWriter,
    userId: string,
    runId: string,
    outcome: RunFinishOutcome,
  ): Promise<void>;
  /** 非终态 → 置 cancel_requested 并返回 true；已终态 → false（不覆盖）。 */
  requestCancelRun(writer: LeaseWriter, userId: string, runId: string): Promise<boolean>;

  // ---- user_memory（用户级；蒸馏是 close 时的机会性写入，写方不持会话租约，故不校验租约） ----
  /** 无行 / 删除墓碑（content=""）→ undefined，不报错。 */
  getUserMemory(userId: string): Promise<UserMemory | undefined>;
  /**
   * 含墓碑行的原始读：蒸馏取 version 做 CAS 基线、手工 PUT 保游标用；
   * 墓碑行 content=""，消费方自行判定。
   */
  getUserMemoryRaw(userId: string): Promise<UserMemory | undefined>;
  /**
   * upsert 整行：content 与游标作为一致对原子写入、不撕裂；并发 close 的
   * 竞争写最坏 last-writer-wins，v1 接受。用户不存在 → not_found；
   * content 必须非空且 ≤8000 字符、throughMessageSeq 必须非负整数、
   * sourceSessionId 为 string 或 null，否则 → invalid_payload。单事务。
   */
  putUserMemory(userId: string, input: PutUserMemoryInput): Promise<void>;
  /**
   * 删除该用户的记忆：写墓碑行（content=""、version+1），蒸馏游标
   * （sourceSessionId/throughMessageSeq）保留——已蒸过的消息不应因手工
   * 删除而被重新蒸馏回偏好。用户不存在时幂等 no-op（外键）。
   */
  deleteUserMemory(userId: string): Promise<void>;

  /** 释放底层连接；进程内单例使用。 */
  close(): void;
}
