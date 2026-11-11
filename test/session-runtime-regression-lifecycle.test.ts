import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EventRepository } from "../src/data/repository.ts";
import {
  DAY1,
  afternoonPlan,
  envelope,
  exhibition,
  makePersistent,
  makeRepo,
  stopsAt,
} from "./e2e-fixture.ts";
import { messageRecords, sleep, until } from "./persistent-fixture.ts";
import { openMemoryRepo } from "./session-fixture.ts";

/**
 * 统一审查回归（二）：close 必须等整轮（含验证/纠正）收尾；
 * 落在验证阶段的取消不得提交新行程、不得继续纠正。
 */

/** 包一层 getByIds：arm() 之后的校验读取被闸门扣住，release() 放行。 */
function gateGetByIds(repo: EventRepository) {
  let armed = false;
  let entered = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped: EventRepository = {
    search: (input) => repo.search(input),
    getByIds: async (ids) => {
      if (!armed) return repo.getByIds(ids);
      entered = true;
      await gate;
      return repo.getByIds(ids);
    },
    close: () => repo.close(),
  };
  return {
    repo: wrapped,
    arm() {
      armed = true;
    },
    entered: () => entered,
    release: () => release(),
  };
}

test("close waits for the in-flight turn; a blocked validation cannot resume corrections", async (t) => {
  const sessions = openMemoryRepo(t);
  const events = await makeRepo(t);
  const gated = gateGetByIds(events);
  const { session, faux } = await makePersistent(t, [], {
    sessions,
    repository: gated.repo,
  });
  faux.setResponses([
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "bad",
          stops: [
            { event_id: "evt_nope", arrive_at: "13:00", leave_at: "14:00", reason: "r" },
          ],
        },
        { date: DAY1 },
      ),
    ),
    fauxAssistantMessage('{"type":"clarify","question":"不该发生的纠正"}'),
  ]);
  gated.arm();
  const pending = session.prompt("安排不存在的活动");
  await until(gated.entered, "validation getByIds entered");

  let settled = false;
  const closing = session.close().then(() => {
    settled = true;
  });
  await sleep(50);
  assert.equal(settled, false, "验证未完成时 close 不得返回");
  assert.equal(session.busy, true);

  gated.release();
  const turn = await pending;
  await closing;
  assert.equal(turn.kind, "error");
  assert.equal(
    faux.state.callCount,
    1,
    "关闭中的验证失败不得再触发纠正模型调用",
  );
  const sid = session.sessionId as string;
  const run = (await sessions.listRunsBySession("u-test", sid)).at(-1);
  assert.equal(run?.status, "cancelled");
  assert.equal((await messageRecords(sessions, sid)).length, 2);
  assert.equal(session.busy, false);
  const w = await sessions.acquireLease("u-test", sid, "post-close", 1_000);
  assert.ok(w, "close 收尾后租约必须已释放");
  await sessions.releaseLease(w, "u-test", sid);
});

test("cancel during validation keeps the previous itinerary and cancels the run", async (t) => {
  const sessions = openMemoryRepo(t);
  const events = await makeRepo(t);
  const gated = gateGetByIds(events);
  const { session, faux } = await makePersistent(t, [], {
    sessions,
    repository: gated.repo,
  });
  const ev = await exhibition(events, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const first = await session.prompt("第一轮");
  assert.equal(first.kind, "itinerary");
  const sid = session.sessionId as string;
  const committed = session.itinerary;
  const pointer = await sessions.getCurrentItinerary("u-test", sid);
  assert.ok(pointer);

  // 第二轮是另一版合法行程；取消落在验证读取中。
  faux.setResponses([
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "换时段", stops: [stopsAt(ev.id)("15:30", "17:00")] },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);
  gated.arm();
  const pending = session.prompt("改到傍晚");
  await until(gated.entered, "validation getByIds entered");
  session.cancel();
  gated.release();
  const turn = await pending;
  assert.equal(turn.kind, "error");
  assert.deepEqual(session.itinerary, committed, "取消不得更新已确认行程");
  const after = await sessions.getCurrentItinerary("u-test", sid);
  assert.equal(after?.record.recordId, pointer.record.recordId, "行程指针不得推进");
  const run = (await sessions.listRunsBySession("u-test", sid)).at(-1);
  assert.equal(run?.status, "cancelled");
});

test("concurrent close calls share one shutdown; new work is refused", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, faux } = await makePersistent(t, [], { sessions });
  faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"q"}')]);
  const turn = await session.prompt("一轮");
  assert.equal(turn.kind, "clarification");

  const runtime = session.runtime;
  assert.ok(runtime);
  const first = runtime.close();
  const second = runtime.close();
  assert.strictEqual(first, second, "并发 close 必须复用同一个收尾 Promise");
  await Promise.all([first, second, session.close()]);

  const refused = await session.prompt("关了还说");
  assert.equal(refused.kind, "error");
  if (refused.kind === "error") assert.match(refused.message, /已关闭/);
});
