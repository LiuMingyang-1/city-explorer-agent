import assert from "node:assert/strict";
import { test } from "node:test";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { isSessionError } from "../src/session/types.ts";
import {
  makeUser,
  mustAcquire,
  openFileRepo,
  openMemoryRepo,
  tempDbPath,
  userMessage,
} from "./session-fixture.ts";

test("createUser generates ids, binds exactly one main session atomically", async (t) => {
  const repo = openMemoryRepo(t);
  const user = await repo.createUser({ displayName: "测试" });
  assert.ok(user.userId.length > 0);
  assert.equal(user.displayName, "测试");
  assert.ok(user.mainSessionId);

  const main = await repo.getMainSession(user.userId);
  assert.equal(main.sessionId, user.mainSessionId);
  assert.equal(main.kind, "main");
  assert.equal(main.parentSessionId, null);
  assert.equal(main.status, "active");
  assert.equal(main.leaseEpoch, 0);
  const sessions = await repo.listSessions(user.userId);
  assert.equal(sessions.length, 1);
});

test("createUser with an existing userId returns the same user and main session", async (t) => {
  const repo = openMemoryRepo(t);
  const first = await repo.createUser({ userId: "u-1", displayName: "一" });
  const again = await repo.createUser({ userId: "u-1", displayName: "另一个名字" });
  assert.equal(again.userId, "u-1");
  assert.equal(again.mainSessionId, first.mainSessionId);
  assert.equal((await repo.listSessions("u-1")).length, 1);
});

test("two connections initializing the same user produce one main session", async (t) => {
  const dbPath = tempDbPath(t);
  const repoA = openFileRepo(t, dbPath);
  const repoB = openFileRepo(t, dbPath);

  const [userA, userB] = await Promise.all([
    repoA.createUser({ userId: "u-shared" }),
    repoB.createUser({ userId: "u-shared" }),
  ]);
  assert.equal(userA.mainSessionId, userB.mainSessionId);

  // 跨连接可见同一份数据，且仍只有一个 main。
  for (const repo of [repoA, repoB]) {
    const sessions = await repo.listSessions("u-shared");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, "main");
  }
});

test("getMainSession reports not_found for unknown user", async (t) => {
  const repo = openMemoryRepo(t);
  await assert.rejects(repo.getMainSession("nobody"), (e) => isSessionError(e, "not_found"));
});

test("users are isolated: sessions and records never leak across user_id", async (t) => {
  const repo = openMemoryRepo(t);
  const { main: mainA } = await makeUser(repo, "u-a");
  const { main: mainB } = await makeUser(repo, "u-b");
  const writerA = await mustAcquire(repo, "u-a", mainA.sessionId);
  await repo.appendMessage(writerA, "u-a", mainA.sessionId, {
    payload: { message: userMessage("A 的消息") },
  });

  // 读：跨用户会话按不存在处理。
  assert.equal(await repo.getSession("u-b", mainA.sessionId), undefined);
  await assert.rejects(repo.listRecords("u-b", mainA.sessionId), (e) =>
    isSessionError(e, "not_found"),
  );
  await assert.rejects(repo.latestCompaction("u-b", mainA.sessionId), (e) =>
    isSessionError(e, "not_found"),
  );
  // B 只能看到自己的会话。
  const sessionsB = await repo.listSessions("u-b");
  assert.deepEqual(
    sessionsB.map((s) => s.sessionId),
    [mainB.sessionId],
  );

  // 写：跨用户一律 cross_user。
  const writerB = await mustAcquire(repo, "u-b", mainB.sessionId);
  await assert.rejects(
    repo.appendMessage(writerB, "u-b", mainA.sessionId, {
      payload: { message: userMessage("越权") },
    }),
    (e) => isSessionError(e, "cross_user"),
  );
  await assert.rejects(repo.acquireLease("u-b", mainA.sessionId, "w-b", 1000), (e) =>
    isSessionError(e, "cross_user"),
  );
  await assert.rejects(
    repo.createChildSession(writerB, "u-b", { parentSessionId: mainA.sessionId }),
    (e) => isSessionError(e, "cross_user"),
  );
});

test("child sessions form a same-user tree; foreign parents are rejected", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-tree");
  const { main: otherMain } = await makeUser(repo, "u-other");
  const writer = await mustAcquire(repo, "u-tree", main.sessionId);

  const child = await repo.createChildSession(writer, "u-tree", {
    parentSessionId: main.sessionId,
    title: "子任务一",
  });
  assert.equal(child.kind, "child");
  assert.equal(child.parentSessionId, main.sessionId);
  assert.equal(child.status, "active");
  assert.equal(child.currentItineraryRecordId, null);

  // 递归：child 可以再派生 child（多级树）。
  const childWriter = await mustAcquire(repo, "u-tree", child.sessionId, "worker-child");
  const grandchild = await repo.createChildSession(childWriter, "u-tree", {
    parentSessionId: child.sessionId,
  });
  assert.equal(grandchild.parentSessionId, child.sessionId);

  // 跨用户父会话拒绝（即使持自己会话的租约也不行）。
  const writerOther = await mustAcquire(repo, "u-other", otherMain.sessionId, "worker-o");
  await assert.rejects(
    repo.createChildSession(writerOther, "u-other", { parentSessionId: main.sessionId }),
    (e) => isSessionError(e, "cross_user"),
  );
  await assert.rejects(
    repo.createChildSession(writerOther, "u-other", { parentSessionId: "missing" }),
    (e) => isSessionError(e, "not_found"),
  );
});

test("archive makes a child session read-only; main cannot be archived", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-arch");
  const writer = await mustAcquire(repo, "u-arch", main.sessionId);
  const child = await repo.createChildSession(writer, "u-arch", {
    parentSessionId: main.sessionId,
  });
  const childWriter = await mustAcquire(repo, "u-arch", child.sessionId, "w-child");

  await repo.archiveSession(childWriter, "u-arch", child.sessionId);
  const archived = await repo.getSession("u-arch", child.sessionId);
  assert.equal(archived?.status, "archived");
  assert.equal(archived?.leaseOwner, null);

  // 归档后写与租约获取都被拒。
  await assert.rejects(
    repo.appendMessage(childWriter, "u-arch", child.sessionId, {
      payload: { message: userMessage("再写") },
    }),
    (e) => isSessionError(e, "archived"),
  );
  await assert.rejects(repo.acquireLease("u-arch", child.sessionId, "w2", 1000), (e) =>
    isSessionError(e, "archived"),
  );
  // 读仍可用（归档会话只读）。
  assert.deepEqual(await repo.listRecords("u-arch", child.sessionId), []);

  // 主会话不可归档。
  await assert.rejects(repo.archiveSession(writer, "u-arch", main.sessionId), (e) =>
    isSessionError(e, "conflict"),
  );
});
