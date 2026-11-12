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

test("putUserMemory rejects invalid payloads with invalid_payload", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-mem");
  const base = { content: "ok", sourceSessionId: main.sessionId, throughMessageSeq: 1 };
  const rejects = (input: Parameters<typeof repo.putUserMemory>[1]) =>
    assert.rejects(repo.putUserMemory("u-mem", input), (e) =>
      isSessionError(e, "invalid_payload"),
    );

  // content：非空字符串且 ≤8000 字符
  await rejects({ ...base, content: "" });
  await rejects({ ...base, content: "x".repeat(8_001) });
  await rejects({ ...base, content: 42 as unknown as string });
  // throughMessageSeq：非负整数
  await rejects({ ...base, throughMessageSeq: -1 });
  await rejects({ ...base, throughMessageSeq: 1.5 });
  await rejects({ ...base, throughMessageSeq: Number.NaN });
  // sourceSessionId：string 或 null
  await rejects({ ...base, sourceSessionId: 7 as unknown as string });

  // 边界值合法：8000 字符、游标 0、null 源会话
  await repo.putUserMemory("u-mem", {
    content: "x".repeat(8_000),
    sourceSessionId: null,
    throughMessageSeq: 0,
  });
  const memory = await repo.getUserMemory("u-mem");
  assert.equal(memory?.content.length, 8_000);
  assert.equal(memory?.throughMessageSeq, 0);
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

test("putUserMemory 版本 CAS：expectedVersion 匹配才写入，不匹配抛 conflict 且不落库", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-mem");
  await repo.putUserMemory("u-mem", {
    content: "旧文",
    sourceSessionId: main.sessionId,
    throughMessageSeq: 5,
  });
  assert.equal((await repo.getUserMemory("u-mem"))?.version, 1);

  // 版本不符（期望无行基线 0）→ conflict，原行原封不动。
  await assert.rejects(
    repo.putUserMemory("u-mem", {
      content: "蒸馏结果",
      sourceSessionId: main.sessionId,
      throughMessageSeq: 9,
      expectedVersion: 0,
    }),
    (e) => isSessionError(e, "conflict"),
  );
  assert.equal((await repo.getUserMemory("u-mem"))?.content, "旧文");

  // 版本相符 → 写入并把版本推进到 2。
  await repo.putUserMemory("u-mem", {
    content: "蒸馏结果",
    sourceSessionId: main.sessionId,
    throughMessageSeq: 9,
    expectedVersion: 1,
  });
  const written = await repo.getUserMemory("u-mem");
  assert.equal(written?.content, "蒸馏结果");
  assert.equal(written?.version, 2);

  // DELETE 写墓碑：读路径当无记忆，version 继续递增留在行上。
  await repo.deleteUserMemory("u-mem");
  assert.equal(await repo.getUserMemory("u-mem"), undefined);
  // 蒸馏拿旧版本基线写回 → conflict，墓碑不被复活。
  await assert.rejects(
    repo.putUserMemory("u-mem", {
      content: "蒸馏结果",
      sourceSessionId: main.sessionId,
      throughMessageSeq: 10,
      expectedVersion: 2,
    }),
    (e) => isSessionError(e, "conflict"),
  );
  assert.equal(await repo.getUserMemory("u-mem"), undefined);
  // 期望墓碑当前版本 → 复活写入成功，版本继续推进。
  await repo.putUserMemory("u-mem", {
    content: "新蒸馏",
    sourceSessionId: main.sessionId,
    throughMessageSeq: 10,
    expectedVersion: 3,
  });
  assert.equal((await repo.getUserMemory("u-mem"))?.content, "新蒸馏");
  assert.equal((await repo.getUserMemory("u-mem"))?.version, 4);
});

test("deleteUserMemory 对从未写过记忆的用户也留墓碑（版本 1，读作无记忆）", async (t) => {
  const repo = openMemoryRepo(t);
  await makeUser(repo, "u-mem");
  await repo.deleteUserMemory("u-mem");
  // 读路径与"从未写过"不可区分；墓碑使"蒸馏期被删"能被 CAS 检出。
  assert.equal(await repo.getUserMemory("u-mem"), undefined);
  await assert.rejects(
    repo.putUserMemory("u-mem", {
      content: "蒸馏结果",
      sourceSessionId: null,
      throughMessageSeq: 1,
      expectedVersion: 0, // 拿"无行"基线 → 与墓碑 version 1 不符
    }),
    (e) => isSessionError(e, "conflict"),
  );
  // 用户本身不存在仍是静默 no-op（FK 保护，不建墓碑）。
  await repo.deleteUserMemory("ghost");
  assert.equal(await repo.getUserMemory("ghost"), undefined);
});
