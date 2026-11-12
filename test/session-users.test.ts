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

test("createUser generates ids and does not create any session", async (t) => {
  const repo = openMemoryRepo(t);
  const user = await repo.createUser({ displayName: "测试" });
  assert.ok(user.userId.length > 0);
  assert.equal(user.displayName, "测试");
  // 对话由 createConversation 懒建：建用户本身不产生任何会话行。
  assert.deepEqual(await repo.listSessions(user.userId), []);
});

test("createUser with an existing userId returns the same user idempotently", async (t) => {
  const repo = openMemoryRepo(t);
  const first = await repo.createUser({ userId: "u-1", displayName: "一" });
  const again = await repo.createUser({ userId: "u-1", displayName: "另一个名字" });
  assert.equal(again.userId, "u-1");
  assert.equal(again.displayName, first.displayName);
  assert.equal((await repo.listSessions("u-1")).length, 0);
});

test("two connections initializing the same user produce one user row", async (t) => {
  const dbPath = tempDbPath(t);
  const repoA = openFileRepo(t, dbPath);
  const repoB = openFileRepo(t, dbPath);

  const [userA, userB] = await Promise.all([
    repoA.createUser({ userId: "u-shared" }),
    repoB.createUser({ userId: "u-shared" }),
  ]);
  assert.equal(userA.userId, userB.userId);

  // 跨连接可见同一个用户，且并发初始化不产生任何会话。
  for (const repo of [repoA, repoB]) {
    assert.ok(await repo.getUser("u-shared"));
    assert.equal((await repo.listSessions("u-shared")).length, 0);
  }
});

test("createConversation creates multiple main conversations per user, title optional", async (t) => {
  const repo = openMemoryRepo(t);
  await repo.createUser({ userId: "u-conv" });

  const first = await repo.createConversation("u-conv");
  assert.equal(first.kind, "main");
  assert.equal(first.parentSessionId, null);
  assert.equal(first.title, null);
  assert.equal(first.status, "active");
  assert.equal(first.leaseEpoch, 0);
  assert.equal(first.leaseOwner, null);
  assert.equal(first.currentItineraryRecordId, null);

  const second = await repo.createConversation("u-conv", { title: "周六看展" });
  assert.equal(second.kind, "main");
  assert.equal(second.title, "周六看展");
  assert.notEqual(second.sessionId, first.sessionId);

  const sessions = await repo.listSessions("u-conv");
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.kind === "main"));
});

test("createConversation rejects an unknown user with not_found", async (t) => {
  const repo = openMemoryRepo(t);
  await assert.rejects(repo.createConversation("nobody"), (e) =>
    isSessionError(e, "not_found"),
  );
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

test("archive makes a session read-only; any active session including main can be archived", async (t) => {
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

  // main 对话会话同样可归档，归档后租约字段清除、写与租约获取被拒。
  await repo.archiveSession(writer, "u-arch", main.sessionId);
  const archivedMain = await repo.getSession("u-arch", main.sessionId);
  assert.equal(archivedMain?.status, "archived");
  assert.equal(archivedMain?.leaseOwner, null);
  await assert.rejects(
    repo.appendMessage(writer, "u-arch", main.sessionId, {
      payload: { message: userMessage("再写") },
    }),
    (e) => isSessionError(e, "archived"),
  );
  await assert.rejects(repo.acquireLease("u-arch", main.sessionId, "w3", 1000), (e) =>
    isSessionError(e, "archived"),
  );
});
