import assert from "node:assert/strict";
import { test } from "node:test";
import { isSessionError } from "../src/session/types.ts";
import { fakeClock, makeUser, openMemoryRepo } from "./session-fixture.ts";

test("getUserMemory returns undefined before any write, even for unknown user", async (t) => {
  const repo = openMemoryRepo(t);
  await makeUser(repo, "u-mem");
  assert.equal(await repo.getUserMemory("u-mem"), undefined);
  // 未创建过的用户同样按无行处理，不抛错。
  assert.equal(await repo.getUserMemory("nobody"), undefined);
});

test("putUserMemory writes the document and cursor, then reads them back", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-mem");
  const content = "# 用户记忆\n\n## 偏好\n- 喜欢博物馆与步行路线\n";

  await repo.putUserMemory("u-mem", {
    content,
    sourceSessionId: main.sessionId,
    throughMessageSeq: 12,
  });

  const memory = await repo.getUserMemory("u-mem");
  assert.ok(memory);
  assert.equal(memory.userId, "u-mem");
  assert.equal(memory.content, content);
  assert.equal(memory.sourceSessionId, main.sessionId);
  assert.equal(memory.throughMessageSeq, 12);
  assert.ok(memory.updatedAt);
});

test("putUserMemory upserts: a second write overwrites all fields and bumps updated_at", async (t) => {
  const clock = fakeClock();
  const repo = openMemoryRepo(t, clock.now);
  const { main } = await makeUser(repo, "u-mem");

  await repo.putUserMemory("u-mem", {
    content: "v1",
    sourceSessionId: main.sessionId,
    throughMessageSeq: 3,
  });
  const first = await repo.getUserMemory("u-mem");
  assert.ok(first);

  clock.advance(1_000);
  await repo.putUserMemory("u-mem", {
    content: "v2 更长",
    sourceSessionId: null,
    throughMessageSeq: 9,
  });
  const second = await repo.getUserMemory("u-mem");
  assert.ok(second);
  assert.equal(second.content, "v2 更长");
  assert.equal(second.sourceSessionId, null);
  assert.equal(second.throughMessageSeq, 9);
  assert.ok(second.updatedAt > first.updatedAt);
});

test("putUserMemory rejects unknown user with not_found", async (t) => {
  const repo = openMemoryRepo(t);
  await assert.rejects(
    repo.putUserMemory("ghost", {
      content: "x",
      sourceSessionId: null,
      throughMessageSeq: 0,
    }),
    (e) => isSessionError(e, "not_found"),
  );
  // 拒绝后不落行。
  assert.equal(await repo.getUserMemory("ghost"), undefined);
});

test("user memories are isolated per user", async (t) => {
  const repo = openMemoryRepo(t);
  await makeUser(repo, "u-a");
  await makeUser(repo, "u-b");

  await repo.putUserMemory("u-a", {
    content: "A 的记忆",
    sourceSessionId: null,
    throughMessageSeq: 5,
  });
  await repo.putUserMemory("u-b", {
    content: "B 的记忆",
    sourceSessionId: null,
    throughMessageSeq: 7,
  });

  const memoryA = await repo.getUserMemory("u-a");
  const memoryB = await repo.getUserMemory("u-b");
  assert.equal(memoryA?.content, "A 的记忆");
  assert.equal(memoryA?.throughMessageSeq, 5);
  assert.equal(memoryB?.content, "B 的记忆");
  assert.equal(memoryB?.throughMessageSeq, 7);

  // 覆盖 A 不影响 B。
  await repo.putUserMemory("u-a", {
    content: "A 的记忆 v2",
    sourceSessionId: null,
    throughMessageSeq: 8,
  });
  assert.equal((await repo.getUserMemory("u-a"))?.content, "A 的记忆 v2");
  assert.equal((await repo.getUserMemory("u-b"))?.content, "B 的记忆");
});
