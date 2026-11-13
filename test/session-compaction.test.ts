import { afterResource } from "./resource-cleanup-fixture.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { isSessionError } from "../src/session/types.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import {
  assistantMessage,
  compactionPayload,
  makeUser,
  mustAcquire,
  openMemoryRepo,
  seedMessages,
  tempDbPath,
  toolResultMessage,
  userMessage,
} from "./session-fixture.ts";

test("latestCompaction returns undefined when the session has none", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-none");
  const writer = await mustAcquire(repo, "u-none", main.sessionId);
  assert.equal(await repo.latestCompaction("u-none", main.sessionId), undefined);
  await seedMessages(repo, writer, "u-none", main.sessionId, ["一", "二"]);
  assert.equal(await repo.latestCompaction("u-none", main.sessionId), undefined);
});

test("compaction commit validates through, bounds, and non-regression", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-cp");
  const writer = await mustAcquire(repo, "u-cp", main.sessionId);
  await seedMessages(repo, writer, "u-cp", main.sessionId, ["m1", "m2", "m3", "m4"]);

  // 无消息会话不能压缩：先拒绝再补写。through 必须等于当前最大 message_seq。
  await assert.rejects(
    repo.appendCompaction(writer, "u-cp", main.sessionId, {
      payload: compactionPayload(3, 3), // through=3 < max=4：用了旧截止
    }),
    (e) => isSessionError(e, "conflict"),
  );
  await assert.rejects(
    repo.appendCompaction(writer, "u-cp", main.sessionId, {
      payload: compactionPayload(5, 3), // through=5 > max=4：用了未来消息
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // first_kept 越界：< min+1 或 > max+1。
  await assert.rejects(
    repo.appendCompaction(writer, "u-cp", main.sessionId, {
      payload: compactionPayload(4, 1),
    }),
    (e) => isSessionError(e, "conflict"),
  );
  await assert.rejects(
    repo.appendCompaction(writer, "u-cp", main.sessionId, {
      payload: compactionPayload(4, 6),
    }),
    (e) => isSessionError(e, "conflict"),
  );

  const cp = await repo.appendCompaction(writer, "u-cp", main.sessionId, {
    payload: compactionPayload(4, 3),
  });
  assert.equal(cp.type, "compaction");
  assert.equal(cp.messageSeq, null);
  assert.equal(cp.seq, 5); // seq 继续增长，message_seq 不受影响

  // 边界不得回退（可以持平）。
  await assert.rejects(
    repo.appendCompaction(writer, "u-cp", main.sessionId, {
      payload: compactionPayload(4, 2),
    }),
    (e) => isSessionError(e, "conflict"),
  );

  const latest = await repo.latestCompaction("u-cp", main.sessionId);
  assert.equal(latest?.record.recordId, cp.recordId);
  assert.equal(latest?.payload.first_kept_message_seq, 3);
  assert.equal(latest?.payload.source_through_message_seq, 4);
});

test("first_kept cannot cut inside a tool call batch; empty tail is allowed", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-batch");
  const writer = await mustAcquire(repo, "u-batch", main.sessionId);

  // 消息布局：1=user, 2=assistant(toolCall), 3=toolResult, 4=user
  await seedMessages(repo, writer, "u-batch", main.sessionId, [
    userMessage("查一下"),
    assistantMessage("调用工具", { toolCalls: [{ id: "c-1" }] }),
    toolResultMessage("c-1"),
    userMessage("换一个"),
  ]);

  // first_kept=3 指向 toolResult：切断 assistant 调用与结果之间 → 拒绝。
  await assert.rejects(
    repo.appendCompaction(writer, "u-batch", main.sessionId, {
      payload: compactionPayload(4, 3),
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // first_kept=2 切在 assistant 之前是安全的；空尾部 5 = max+1 也合法。
  const kept = await repo.appendCompaction(writer, "u-batch", main.sessionId, {
    payload: compactionPayload(4, 2),
  });
  assert.equal(kept.type, "compaction");

  await seedMessages(repo, writer, "u-batch", main.sessionId, ["m5"]);
  const emptyTail = await repo.appendCompaction(writer, "u-batch", main.sessionId, {
    payload: compactionPayload(5, 6), // 无近期原文：first_kept = 当时最大 message_seq + 1
  });
  assert.equal(emptyTail.type, "compaction");

  const latest = await repo.latestCompaction("u-batch", main.sessionId);
  assert.equal(latest?.payload.first_kept_message_seq, 6);
});

test("checkpoint cannot cross an unclosed tool batch; keeping the batch head is legal", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-open");
  const writer = await mustAcquire(repo, "u-open", main.sessionId);

  // 消息布局：1=user, 2=assistant(toolCall，结果尚未写库——崩溃/中断的合法状态)。
  await seedMessages(repo, writer, "u-open", main.sessionId, [
    userMessage("查一下"),
    assistantMessage("调用工具", { toolCalls: [{ id: "c-1" }] }),
  ]);

  // 空尾 first_kept=3 越过未闭环调用：日后补齐的 toolResult 会落在边界之后，
  // 保留区出现没有对应调用的 toolResult → 拒绝。
  await assert.rejects(
    repo.appendCompaction(writer, "u-open", main.sessionId, {
      payload: compactionPayload(2, 3),
    }),
    (e) => isSessionError(e, "conflict"),
  );

  // first_kept=2 把整个未完成批次留在原文里 → 合法。
  const kept = await repo.appendCompaction(writer, "u-open", main.sessionId, {
    payload: compactionPayload(2, 2),
  });
  assert.equal(kept.type, "compaction");

  // 结果到齐后可以跨过完整批次（空尾）。
  await seedMessages(repo, writer, "u-open", main.sessionId, [toolResultMessage("c-1")]);
  const crossed = await repo.appendCompaction(writer, "u-open", main.sessionId, {
    payload: compactionPayload(3, 4),
  });
  assert.equal(crossed.type, "compaction");
});

test("multi-tool batch must be fully closed before the boundary crosses it", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-multi-tool");
  const writer = await mustAcquire(repo, "u-multi-tool", main.sessionId);

  // 1=user, 2=assistant(c-1 + c-2), 3=toolResult(c-1)：c-2 未闭环。
  await seedMessages(repo, writer, "u-multi-tool", main.sessionId, [
    userMessage("并行查"),
    assistantMessage("两个调用", { toolCalls: [{ id: "c-1" }, { id: "c-2" }] }),
    toolResultMessage("c-1"),
  ]);

  // 空尾越过仍在等结果的批次 → 拒绝。
  await assert.rejects(
    repo.appendCompaction(writer, "u-multi-tool", main.sessionId, {
      payload: compactionPayload(3, 4),
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // 指向批次内 toolResult 照旧拒绝。
  await assert.rejects(
    repo.appendCompaction(writer, "u-multi-tool", main.sessionId, {
      payload: compactionPayload(3, 3),
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // 保住 assistant 头 → 合法。
  await repo.appendCompaction(writer, "u-multi-tool", main.sessionId, {
    payload: compactionPayload(3, 2),
  });
});

test("boundary inside a closed batch is rejected even when it does not point at a toolResult", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-inside");
  const writer = await mustAcquire(repo, "u-inside", main.sessionId);

  // 异常布局：1=user, 2=assistant(c-1), 3=user, 4=toolResult(c-1)。
  await seedMessages(repo, writer, "u-inside", main.sessionId, [
    userMessage("查一下"),
    assistantMessage("调用工具", { toolCalls: [{ id: "c-1" }] }),
    userMessage("插队消息"),
    toolResultMessage("c-1"),
  ]);

  // first_kept=3 指向 user：保留区里 toolResult(4) 的调用(2)被摘要覆盖 → 拒绝。
  await assert.rejects(
    repo.appendCompaction(writer, "u-inside", main.sessionId, {
      payload: compactionPayload(4, 3),
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // 批次整体保留或整体跨过都合法。
  await repo.appendCompaction(writer, "u-inside", main.sessionId, {
    payload: compactionPayload(4, 2),
  });
  await repo.appendCompaction(writer, "u-inside", main.sessionId, {
    payload: compactionPayload(4, 5),
  });
});

test("a reused toolCallId counts as open again after a later call", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-reuse");
  const writer = await mustAcquire(repo, "u-reuse", main.sessionId);

  // 1=user, 2=assistant(c-1), 3=toolResult(c-1), 4=assistant(再次调用 c-1，未闭环)。
  await seedMessages(repo, writer, "u-reuse", main.sessionId, [
    userMessage("第一轮"),
    assistantMessage("调用一", { toolCalls: [{ id: "c-1" }] }),
    toolResultMessage("c-1"),
    assistantMessage("调用二", { toolCalls: [{ id: "c-1" }] }),
  ]);

  // 已闭环的历史不代表当前闭环：新一轮调用还挂着 → 空尾拒绝。
  await assert.rejects(
    repo.appendCompaction(writer, "u-reuse", main.sessionId, {
      payload: compactionPayload(4, 5),
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // first_kept=4 保留新批次头 → 合法。
  await repo.appendCompaction(writer, "u-reuse", main.sessionId, {
    payload: compactionPayload(4, 4),
  });
});

test("a checkpoint that crossed an unclosed batch stays corrupt after results arrive", async (t) => {
  const dbPath = tempDbPath(t);
  const repo = createSqliteSessionRepository(dbPath);
  const { main } = await makeUser(repo, "u-stale");
  const writer = await mustAcquire(repo, "u-stale", main.sessionId);
  // 1=user, 2=assistant(toolCall 未闭环)。
  await seedMessages(repo, writer, "u-stale", main.sessionId, [
    userMessage("查一下"),
    assistantMessage("调用工具", { toolCalls: [{ id: "c-1" }] }),
  ]);
  repo.close();

  // 绕过仓库补一条旧版本会接受的检查点（空尾越过未闭环批次），
  // 再把缺失的 toolResult 直接插进日志。按最终历史看似闭环，
  // 但检查点只能按它写入时的前缀判定——永远非法。
  const raw = new DatabaseSync(dbPath);
  afterResource(t, () => raw.close());
  const state = raw
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS s, COALESCE(MAX(message_seq), 0) AS m FROM session_records WHERE session_id = ?",
    )
    .get(main.sessionId) as { s: number; m: number };
  raw
    .prepare(
      `INSERT INTO session_records (record_id, session_id, seq, type, message_seq, payload, created_at)
       VALUES ('stale-cp', ?, ?, 'compaction', NULL, ?, '2026-11-11T09:00:00Z')`,
    )
    .run(
      main.sessionId,
      state.s + 1,
      JSON.stringify({ summary: "伪造", source_through_message_seq: 2, first_kept_message_seq: 3 }),
    );
  raw
    .prepare(
      `INSERT INTO session_records (record_id, session_id, seq, type, message_seq, payload, created_at)
       VALUES ('late-tr', ?, ?, 'message', ?, ?, '2026-11-11T09:00:01Z')`,
    )
    .run(
      main.sessionId,
      state.s + 2,
      state.m + 1,
      JSON.stringify({
        message: {
          role: "toolResult",
          toolCallId: "c-1",
          toolName: "search_events",
          content: [{ type: "text", text: "{}" }],
          isError: true,
          timestamp: 1_700_000_000_000,
        },
      }),
    );

  const repo2 = createSqliteSessionRepository(dbPath);
  afterResource(t, () => repo2.close());
  await assert.rejects(repo2.latestCompaction("u-stale", main.sessionId), (e) =>
    isSessionError(e, "corrupt"),
  );
});

test("multiple compactions advance the boundary monotonically; originals stay", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-multi");
  const writer = await mustAcquire(repo, "u-multi", main.sessionId);
  await seedMessages(repo, writer, "u-multi", main.sessionId, ["m1", "m2", "m3", "m4"]);

  await repo.appendCompaction(writer, "u-multi", main.sessionId, {
    payload: compactionPayload(4, 2),
  });
  await seedMessages(repo, writer, "u-multi", main.sessionId, ["m5", "m6"]);
  const second = await repo.appendCompaction(writer, "u-multi", main.sessionId, {
    payload: compactionPayload(6, 4),
  });
  const latest = await repo.latestCompaction("u-multi", main.sessionId);
  assert.equal(latest?.record.recordId, second.recordId);
  assert.equal(latest?.payload.first_kept_message_seq, 4);

  // 原文永不删除：全部 6 条消息 + 2 个检查点都在。
  const records = await repo.listRecords("u-multi", main.sessionId);
  assert.equal(records.length, 8);
  assert.deepEqual(
    records.filter((r) => r.type === "message").map((r) => r.messageSeq),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    records.map((r) => r.seq),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test("compaction on an empty session is refused", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-empty");
  const writer = await mustAcquire(repo, "u-empty", main.sessionId);
  await assert.rejects(
    repo.appendCompaction(writer, "u-empty", main.sessionId, {
      payload: compactionPayload(1, 1),
    }),
    (e) => isSessionError(e, "conflict"),
  );
});

test("dedupe_key on compaction is idempotent, conflicts on different payloads", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-cdedup");
  const writer = await mustAcquire(repo, "u-cdedup", main.sessionId);
  await seedMessages(repo, writer, "u-cdedup", main.sessionId, ["m1", "m2"]);

  const first = await repo.appendCompaction(writer, "u-cdedup", main.sessionId, {
    payload: compactionPayload(2, 2),
    dedupeKey: "cp-1",
  });
  const retry = await repo.appendCompaction(writer, "u-cdedup", main.sessionId, {
    payload: compactionPayload(2, 2),
    dedupeKey: "cp-1",
  });
  assert.equal(retry.recordId, first.recordId);
  // 同键不同 payload 拒绝，不静默复用。
  await assert.rejects(
    repo.appendCompaction(writer, "u-cdedup", main.sessionId, {
      payload: compactionPayload(2, 3, { summary: "另一份摘要" }),
      dedupeKey: "cp-1",
    }),
    (e) => isSessionError(e, "conflict"),
  );
});

test("invalid stored records surface as corrupt, never silently skipped", async (t) => {
  const dbPath = tempDbPath(t);
  const repo = createSqliteSessionRepository(dbPath);
  const { main } = await makeUser(repo, "u-corrupt");
  const writer = await mustAcquire(repo, "u-corrupt", main.sessionId);
  await seedMessages(repo, writer, "u-corrupt", main.sessionId, ["m1", "m2", "m3"]);
  const good = await repo.appendCompaction(writer, "u-corrupt", main.sessionId, {
    payload: compactionPayload(3, 2),
  });
  repo.close();

  // 绕过仓库手写一条非法检查点（through 与当时前缀不符）。
  const raw = new DatabaseSync(dbPath);
  afterResource(t, () => raw.close());
  const maxSeq = (
    raw
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM session_records WHERE session_id = ?")
      .get(main.sessionId) as { s: number }
  ).s;
  raw
    .prepare(
      `INSERT INTO session_records (record_id, session_id, seq, type, message_seq, payload, created_at)
       VALUES ('bad-cp', ?, ?, 'compaction', NULL, ?, '2026-11-11T09:00:00Z')`,
    )
    .run(
      main.sessionId,
      maxSeq + 1,
      JSON.stringify({ summary: "伪造", source_through_message_seq: 99, first_kept_message_seq: 2 }),
    );

  const repo2 = createSqliteSessionRepository(dbPath);
  afterResource(t, () => repo2.close());
  // 最新一条非法 → 明确报错而非跳过回退到旧检查点。
  await assert.rejects(repo2.latestCompaction("u-corrupt", main.sessionId), (e) =>
    isSessionError(e, "corrupt"),
  );
  // 合法检查点本身仍在日志里（报错不等于丢数据）。
  const records = await repo2.listRecords("u-corrupt", main.sessionId);
  assert.ok(records.some((r) => r.recordId === good.recordId));
});

test("orphan toolResult inside stored history is reported as corrupt on read", async (t) => {
  const dbPath = tempDbPath(t);
  const repo = createSqliteSessionRepository(dbPath);
  const { main } = await makeUser(repo, "u-o2");
  const writer = await mustAcquire(repo, "u-o2", main.sessionId);
  await seedMessages(repo, writer, "u-o2", main.sessionId, ["m1", "m2"]);
  repo.close();

  // 直接写一条孤立 toolResult 记录（payload 合法但引用不存在的调用）。
  const raw = new DatabaseSync(dbPath);
  afterResource(t, () => raw.close());
  const seq = (
    raw
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s, COALESCE(MAX(message_seq), 0) AS m FROM session_records WHERE session_id = ?")
      .get(main.sessionId) as { s: number; m: number }
  );
  raw
    .prepare(
      `INSERT INTO session_records (record_id, session_id, seq, type, message_seq, payload, created_at)
       VALUES ('orphan-tr', ?, ?, 'message', ?, ?, '2026-11-11T09:00:00Z')`,
    )
    .run(
      main.sessionId,
      seq.s + 1,
      seq.m + 1,
      JSON.stringify({
        message: {
          role: "toolResult",
          toolCallId: "no-such-call",
          toolName: "search_events",
          content: [{ type: "text", text: "{}" }],
          isError: false,
          timestamp: 1_700_000_000_000,
        },
      }),
    );

  const repo2 = createSqliteSessionRepository(dbPath);
  afterResource(t, () => repo2.close());
  await assert.rejects(repo2.latestCompaction("u-o2", main.sessionId), (e) =>
    isSessionError(e, "corrupt"),
  );
});
