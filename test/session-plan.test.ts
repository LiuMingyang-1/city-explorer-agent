import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStoredMessagePayload } from "../src/session/payload.ts";
import { isSessionError, type ValidatedPlan } from "../src/session/types.ts";
import {
  assistantMessage,
  makeUser,
  mustAcquire,
  openMemoryRepo,
  userMessage,
  validPlan,
} from "./session-fixture.ts";

test("commitValidatedPlan annotates the record and moves the pointer atomically", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-plan");
  const writer = await mustAcquire(repo, "u-plan", main.sessionId);
  const message = assistantMessage("行程 JSON");
  const record = await repo.appendMessage(writer, "u-plan", main.sessionId, {
    payload: { message },
  });
  const plan = validPlan();

  await repo.commitValidatedPlan(writer, "u-plan", main.sessionId, record.recordId, plan);

  // 指针指向该记录，原 message 逐字保留，plan 附加在 payload 上。
  const session = await repo.getSession("u-plan", main.sessionId);
  assert.equal(session?.currentItineraryRecordId, record.recordId);
  const stored = parseStoredMessagePayload(
    (await repo.getRecord("u-plan", main.sessionId, record.recordId))!.payload,
    "test",
  );
  assert.deepEqual(stored.message, message);
  assert.deepEqual(stored.plan, plan);

  const current = await repo.getCurrentItinerary("u-plan", main.sessionId);
  assert.equal(current?.record.recordId, record.recordId);
  assert.deepEqual(current?.plan, plan);
});

test("pointer only moves forward to a newer validated message", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-mono");
  const writer = await mustAcquire(repo, "u-mono", main.sessionId);
  const first = await repo.appendMessage(writer, "u-mono", main.sessionId, {
    payload: { message: assistantMessage("第一版") },
  });
  const second = await repo.appendMessage(writer, "u-mono", main.sessionId, {
    payload: { message: assistantMessage("第二版") },
  });

  await repo.commitValidatedPlan(writer, "u-mono", main.sessionId, second.recordId, validPlan());
  // 回退到更老的记录被拒，已确认状态不被失败校验覆盖。
  await assert.rejects(
    repo.commitValidatedPlan(writer, "u-mono", main.sessionId, first.recordId, validPlan()),
    (e) => isSessionError(e, "conflict"),
  );
  assert.equal(
    (await repo.getSession("u-mono", main.sessionId))?.currentItineraryRecordId,
    second.recordId,
  );
  // 同一记录重复标注也被拒（append-only，plan 不可改写）。
  await assert.rejects(
    repo.commitValidatedPlan(writer, "u-mono", main.sessionId, second.recordId, validPlan()),
    (e) => isSessionError(e, "conflict"),
  );
});

test("only main sessions carry the pointer; foreign or non-message records are refused", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-main-only");
  const writer = await mustAcquire(repo, "u-main-only", main.sessionId);
  const child = await repo.createChildSession(writer, "u-main-only", {
    parentSessionId: main.sessionId,
  });
  const childWriter = await mustAcquire(repo, "u-main-only", child.sessionId, "w-c");
  const childRecord = await repo.appendMessage(childWriter, "u-main-only", child.sessionId, {
    payload: { message: assistantMessage("child") },
  });
  // child 会话不能设指针。
  await assert.rejects(
    repo.commitValidatedPlan(childWriter, "u-main-only", child.sessionId, childRecord.recordId, validPlan()),
    (e) => isSessionError(e, "conflict"),
  );
  // 跨会话记录不能给 main 当指针。
  await assert.rejects(
    repo.commitValidatedPlan(writer, "u-main-only", main.sessionId, childRecord.recordId, validPlan()),
    (e) => isSessionError(e, "not_found"),
  );
  // 不存在的记录。
  await assert.rejects(
    repo.commitValidatedPlan(writer, "u-main-only", main.sessionId, "no-such", validPlan()),
    (e) => isSessionError(e, "not_found"),
  );
});

test("only a successful assistant message of this session can be annotated", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-assist");
  const writer = await mustAcquire(repo, "u-assist", main.sessionId);

  const user = await repo.appendMessage(writer, "u-assist", main.sessionId, {
    payload: { message: userMessage("用户消息不能标 plan") },
  });
  await assert.rejects(
    repo.commitValidatedPlan(writer, "u-assist", main.sessionId, user.recordId, validPlan()),
    (e) => isSessionError(e, "conflict"),
  );

  for (const [stopReason, errorMessage] of [
    ["error", "模型出错"],
    ["aborted", undefined],
    ["pending", undefined],
    ["deferred", undefined],
  ] as const) {
    const failed = await repo.appendMessage(writer, "u-assist", main.sessionId, {
      payload: {
        message: assistantMessage("失败回复", { stopReason, errorMessage }),
      },
    });
    await assert.rejects(
      repo.commitValidatedPlan(writer, "u-assist", main.sessionId, failed.recordId, validPlan()),
      (e) => isSessionError(e, "conflict"),
      `stopReason=${stopReason} 不应可标注`,
    );
  }
});

test("plan is schema-validated, not merely JSON-parseable", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-schema");
  const writer = await mustAcquire(repo, "u-schema", main.sessionId);
  const record = await repo.appendMessage(writer, "u-schema", main.sessionId, {
    payload: { message: assistantMessage("回复") },
  });

  const badPlans: unknown[] = [
    {},
    { constraints: { date: "2026-02-30" }, itinerary: validPlan().itinerary },
    { constraints: { date: "2026-11-15", availableStart: "25:00" }, itinerary: validPlan().itinerary },
    {
      constraints: validPlan().constraints,
      itinerary: { date: "2026-11-15", summary: "x", stops: [{ event_id: "", arrive_at: "13:00", leave_at: "14:00", reason: 1 }] },
    },
    {
      constraints: validPlan().constraints,
      itinerary: { date: "2026-11-16", summary: "日期不符", stops: [] },
    },
    "not an object",
  ];
  for (const plan of badPlans) {
    await assert.rejects(
      repo.commitValidatedPlan(writer, "u-schema", main.sessionId, record.recordId, plan as ValidatedPlan),
      (e) => isSessionError(e, "invalid_payload"),
      `应拒绝：${JSON.stringify(plan)}`,
    );
  }
  // 失败的提交不落任何痕迹。
  const stored = parseStoredMessagePayload(
    (await repo.getRecord("u-schema", main.sessionId, record.recordId))!.payload,
    "test",
  );
  assert.equal(stored.plan, undefined);
  assert.equal(await repo.getCurrentItinerary("u-schema", main.sessionId), undefined);
});

test("getCurrentItinerary is undefined without a pointer and for child sessions", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-cur");
  assert.equal(await repo.getCurrentItinerary("u-cur", main.sessionId), undefined);
  await assert.rejects(repo.getCurrentItinerary("other-user", main.sessionId), (e) =>
    isSessionError(e, "not_found"),
  );
});
