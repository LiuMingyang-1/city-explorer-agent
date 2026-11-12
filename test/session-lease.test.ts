import assert from "node:assert/strict";
import { test } from "node:test";
import { isSessionError } from "../src/session/types.ts";
import {
  fakeClock,
  makeUser,
  mustAcquire,
  openFileRepo,
  openMemoryRepo,
  tempDbPath,
  userMessage,
} from "./session-fixture.ts";

test("two writers contending one session: only the first acquire succeeds", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-lease");
  const first = await repo.acquireLease("u-lease", main.sessionId, "w-1", 60_000);
  assert.ok(first);
  assert.equal(first.epoch, 1);
  // 他人持有未过期 → undefined，不是等待也不是抢占。
  assert.equal(await repo.acquireLease("u-lease", main.sessionId, "w-2", 60_000), undefined);
  // 伪造就绪凭证写也会被 fencing 拒绝。
  await assert.rejects(
    repo.appendMessage({ owner: "w-2", epoch: 1 }, "u-lease", main.sessionId, {
      payload: { message: userMessage("越权写") },
    }),
    (e) => isSessionError(e, "lease_lost"),
  );
});

test("expired lease can be preempted; stale epoch writes are fenced", async (t) => {
  const clock = fakeClock();
  const repo = openMemoryRepo(t, clock.now);
  const { main } = await makeUser(repo, "u-exp");
  const stale = await mustAcquire(repo, "u-exp", main.sessionId, "w-old", 1_000);

  clock.advance(1_500); // 租约过期但还没人抢占：旧 owner 写同样被拒。
  await assert.rejects(
    repo.appendMessage(stale, "u-exp", main.sessionId, {
      payload: { message: userMessage("过期写") },
    }),
    (e) => isSessionError(e, "lease_lost"),
  );

  // 新 owner 抢占，epoch 推进；旧 worker 因 epoch 不符无法再写。
  const fresh = await mustAcquire(repo, "u-exp", main.sessionId, "w-new", 60_000);
  assert.equal(fresh.epoch, 2);
  await assert.rejects(
    repo.appendMessage(stale, "u-exp", main.sessionId, {
      payload: { message: userMessage("旧纪元写") },
    }),
    (e) => isSessionError(e, "lease_lost"),
  );
  await repo.appendMessage(fresh, "u-exp", main.sessionId, {
    payload: { message: userMessage("新纪元写") },
  });
  assert.equal((await repo.listRecords("u-exp", main.sessionId)).length, 1);
});

test("renew extends only a live lease and cannot resurrect an expired one", async (t) => {
  const clock = fakeClock();
  const repo = openMemoryRepo(t, clock.now);
  const { main } = await makeUser(repo, "u-renew");
  const writer = await mustAcquire(repo, "u-renew", main.sessionId, "w-1", 1_000);

  clock.advance(500);
  assert.equal(await repo.renewLease(writer, "u-renew", main.sessionId, 5_000), true);

  clock.advance(6_000); // 过期后 renew 不复活租约。
  assert.equal(await repo.renewLease(writer, "u-renew", main.sessionId, 5_000), false);
  // epoch 不匹配的旧凭证也不能 renew。
  const fresh = await mustAcquire(repo, "u-renew", main.sessionId, "w-2", 5_000);
  assert.equal(await repo.renewLease(writer, "u-renew", main.sessionId, 5_000), false);
  assert.equal(await repo.renewLease(fresh, "u-renew", main.sessionId, 5_000), true);
});

test("release frees the lease but cannot clear a newer owner's lease", async (t) => {
  const clock = fakeClock();
  const repo = openMemoryRepo(t, clock.now);
  const { main } = await makeUser(repo, "u-rel");
  const w1 = await mustAcquire(repo, "u-rel", main.sessionId, "w-1", 1_000);

  clock.advance(2_000);
  const w2 = await mustAcquire(repo, "u-rel", main.sessionId, "w-2", 60_000);
  // 旧 owner 调 release：WHERE owner+epoch 不匹配，清不掉 w2 的租约。
  await repo.releaseLease(w1, "u-rel", main.sessionId);
  const after = await repo.getSession("u-rel", main.sessionId);
  assert.equal(after?.leaseOwner, "w-2");
  assert.equal(after?.leaseEpoch, w2.epoch);
  await repo.appendMessage(w2, "u-rel", main.sessionId, {
    payload: { message: userMessage("仍持有") },
  });

  // 当前 owner release 后租约为空，他人可获取。
  await repo.releaseLease(w2, "u-rel", main.sessionId);
  const cleared = await repo.getSession("u-rel", main.sessionId);
  assert.equal(cleared?.leaseOwner, null);
  const w3 = await repo.acquireLease("u-rel", main.sessionId, "w-3", 60_000);
  assert.equal(w3?.epoch, w2.epoch + 1);
});

test("same owner may re-acquire while holding; epoch always increments", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-reacq");
  const first = await mustAcquire(repo, "u-reacq", main.sessionId, "w-1", 60_000);
  const second = await mustAcquire(repo, "u-reacq", main.sessionId, "w-1", 60_000);
  assert.equal(second.epoch, first.epoch + 1);
  // 重新获取后旧 epoch 作废。
  await assert.rejects(
    repo.appendMessage(first, "u-reacq", main.sessionId, {
      payload: { message: userMessage("旧凭证") },
    }),
    (e) => isSessionError(e, "lease_lost"),
  );
});

test("lease fencing works across two repository connections", async (t) => {
  const clock = fakeClock();
  const dbPath = tempDbPath(t);
  const repoA = openFileRepo(t, dbPath, clock.now);
  const repoB = openFileRepo(t, dbPath, clock.now);
  const { main } = await makeUser(repoA, "u-conn");
  // 另一连接可见同一对话会话。
  assert.ok(await repoB.getSession("u-conn", main.sessionId));

  const wA = await mustAcquire(repoA, "u-conn", main.sessionId, "worker-A", 1_000);
  assert.equal(await repoB.acquireLease("u-conn", main.sessionId, "worker-B", 1_000), undefined);

  clock.advance(2_000);
  const wB = await mustAcquire(repoB, "u-conn", main.sessionId, "worker-B", 60_000);
  // A 的旧凭证写：epoch 已被 B 推进，拒绝。
  await assert.rejects(
    repoA.appendMessage(wA, "u-conn", main.sessionId, {
      payload: { message: userMessage("A 的过期写") },
    }),
    (e) => isSessionError(e, "lease_lost"),
  );
  await repoB.appendMessage(wB, "u-conn", main.sessionId, {
    payload: { message: userMessage("B 写") },
  });
  assert.equal((await repoA.listRecords("u-conn", main.sessionId)).length, 1);
});
