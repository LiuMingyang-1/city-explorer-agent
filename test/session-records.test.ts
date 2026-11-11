import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isSessionError } from "../src/session/types.ts";
import {
  assistantMessage,
  fakeClock,
  makeUser,
  mustAcquire,
  openMemoryRepo,
  toolResultMessage,
  userMessage,
} from "./session-fixture.ts";

test("append assigns independent seq and message_seq; records are ordered", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-seq");
  const writer = await mustAcquire(repo, "u-seq", main.sessionId);

  const a = await repo.appendMessage(writer, "u-seq", main.sessionId, {
    payload: { message: userMessage("一") },
  });
  const b = await repo.appendMessage(writer, "u-seq", main.sessionId, {
    payload: { message: assistantMessage("二") },
  });
  assert.deepEqual([a.seq, a.messageSeq], [1, 1]);
  assert.deepEqual([b.seq, b.messageSeq], [2, 2]);
  assert.equal(a.type, "message");

  const records = await repo.listRecords("u-seq", main.sessionId);
  assert.equal(records.length, 2);
  // listMessagesFrom 只取 message 行，按 message_seq。
  const tail = await repo.listMessagesFrom("u-seq", main.sessionId, 2);
  assert.deepEqual(
    tail.map((r) => r.messageSeq),
    [2],
  );
  assert.equal(tail[0].recordId, b.recordId);
  await assert.rejects(repo.listMessagesFrom("u-seq", main.sessionId, 0), (e) =>
    isSessionError(e, "invalid_payload"),
  );
});

test("dedupe_key returns the same record idempotently; mismatched content is rejected", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-dedup");
  const writer = await mustAcquire(repo, "u-dedup", main.sessionId);
  const message = userMessage("请求一");

  const first = await repo.appendMessage(writer, "u-dedup", main.sessionId, {
    payload: { message },
    dedupeKey: "req-1",
  });
  // 同键同内容：幂等返回既有记录，不追加。
  const retry = await repo.appendMessage(writer, "u-dedup", main.sessionId, {
    payload: { message },
    dedupeKey: "req-1",
  });
  assert.equal(retry.recordId, first.recordId);
  assert.equal((await repo.listRecords("u-dedup", main.sessionId)).length, 1);

  // 同键不同 payload → conflict，不无声重用不相关记录。
  await assert.rejects(
    repo.appendMessage(writer, "u-dedup", main.sessionId, {
      payload: { message: userMessage("完全不同的内容") },
      dedupeKey: "req-1",
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // 同键不同 run 关联同样拒绝。
  await assert.rejects(
    repo.appendMessage(writer, "u-dedup", main.sessionId, {
      payload: { message },
      dedupeKey: "req-1",
      runId: "some-run",
    }),
    (e) => isSessionError(e, "conflict"),
  );
});

test("message payload boundary: system role and upfront plan are refused", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-shape");
  const writer = await mustAcquire(repo, "u-shape", main.sessionId);

  const system = { role: "system", content: "提示词", timestamp: Date.now() } as AgentMessage;
  await assert.rejects(
    repo.appendMessage(writer, "u-shape", main.sessionId, { payload: { message: system } }),
    (e) => isSessionError(e, "invalid_payload"),
  );
  await assert.rejects(
    repo.appendMessage(writer, "u-shape", main.sessionId, {
      payload: { message: { role: "user", timestamp: Date.now() } as AgentMessage },
    }),
    (e) => isSessionError(e, "invalid_payload"),
  );
  // plan 只能经 commitValidatedPlan 附加。
  await assert.rejects(
    repo.appendMessage(writer, "u-shape", main.sessionId, {
      payload: {
        message: assistantMessage("带 plan"),
        plan: {
          constraints: { date: "2026-11-15" },
          itinerary: { date: "2026-11-15", summary: "x", stops: [] },
        },
      },
    }),
    (e) => isSessionError(e, "invalid_payload"),
  );
});

test("orphan toolResult without a matching assistant toolCall is refused", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-orphan");
  const writer = await mustAcquire(repo, "u-orphan", main.sessionId);

  await assert.rejects(
    repo.appendMessage(writer, "u-orphan", main.sessionId, {
      payload: { message: toolResultMessage("call-missing") },
    }),
    (e) => isSessionError(e, "invalid_payload"),
  );

  // 正常工具批次：assistant(toolCall) → toolResult 可写。
  await repo.appendMessage(writer, "u-orphan", main.sessionId, {
    payload: { message: assistantMessage("调工具", { toolCalls: [{ id: "call-1" }] }) },
  });
  const result = await repo.appendMessage(writer, "u-orphan", main.sessionId, {
    payload: { message: toolResultMessage("call-1") },
  });
  assert.equal(result.messageSeq, 2);
  // 别的 toolCallId 仍是孤立的。
  await assert.rejects(
    repo.appendMessage(writer, "u-orphan", main.sessionId, {
      payload: { message: toolResultMessage("call-2") },
    }),
    (e) => isSessionError(e, "invalid_payload"),
  );
});

test("run and source_run references are checked for session/user ownership", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-refs");
  const writer = await mustAcquire(repo, "u-refs", main.sessionId);

  const child = await repo.createChildSession(writer, "u-refs", {
    parentSessionId: main.sessionId,
  });
  const childWriter = await mustAcquire(repo, "u-refs", child.sessionId, "w-c");
  const run = await repo.createRun(childWriter, "u-refs", {
    sessionId: child.sessionId,
    input: { task: "子任务" },
  });

  // run_id 必须属于本会话；source_run_id 同用户即可。
  const echo = await repo.appendMessage(writer, "u-refs", main.sessionId, {
    payload: { message: assistantMessage("子任务回报") },
    sourceRunId: run.runId,
  });
  assert.equal(echo.sourceRunId, run.runId);
  await assert.rejects(
    repo.appendMessage(writer, "u-refs", main.sessionId, {
      payload: { message: userMessage("错会话") },
      runId: run.runId, // run 在 child 会话，不在 main
    }),
    (e) => isSessionError(e, "conflict"),
  );
  await assert.rejects(
    repo.appendMessage(writer, "u-refs", main.sessionId, {
      payload: { message: userMessage("无 run") },
      runId: "missing-run",
    }),
    (e) => isSessionError(e, "not_found"),
  );

  // source_run_id 跨用户拒绝。
  const { main: otherMain } = await makeUser(repo, "u-other");
  const otherWriter = await mustAcquire(repo, "u-other", otherMain.sessionId, "w-o");
  const foreignRun = await repo.createRun(otherWriter, "u-other", {
    sessionId: otherMain.sessionId,
    input: {},
  });
  await assert.rejects(
    repo.appendMessage(writer, "u-refs", main.sessionId, {
      payload: { message: userMessage("跨用户来源") },
      sourceRunId: foreignRun.runId,
    }),
    (e) => isSessionError(e, "cross_user"),
  );
});

test("last_activity_at advances on messages but not on pure compaction", async (t) => {
  const clock = fakeClock();
  const repo = openMemoryRepo(t, clock.now);
  const { main } = await makeUser(repo, "u-act");
  const writer = await mustAcquire(repo, "u-act", main.sessionId, "w-1", 60_000);

  await repo.appendMessage(writer, "u-act", main.sessionId, {
    payload: { message: userMessage("消息一") },
  });
  const activity1 = (await repo.getSession("u-act", main.sessionId))!.lastActivityAt;
  assert.equal(activity1, clock.now().toISOString());

  clock.advance(10_000);
  await repo.appendCompaction(writer, "u-act", main.sessionId, {
    payload: {
      summary: "摘要",
      source_through_message_seq: 1,
      first_kept_message_seq: 2,
    },
  });
  const after = (await repo.getSession("u-act", main.sessionId))!;
  // 纯压缩不伪装成最近交互：activity 不动，updated_at 前进。
  assert.equal(after.lastActivityAt, activity1);
  assert.ok(after.updatedAt > activity1);

  // 新消息推进 activity。
  clock.advance(10_000);
  await repo.appendMessage(writer, "u-act", main.sessionId, {
    payload: { message: userMessage("消息二") },
  });
  assert.ok((await repo.getSession("u-act", main.sessionId))!.lastActivityAt > activity1);
});
