import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  DAY1,
  DAY2,
  afternoonPlan,
  envelope,
  exhibition,
  makeSession,
  stopsAt,
} from "./e2e-fixture.ts";

/**
 * 端到端：已确认约束在多轮间的合并、保留与纠正。
 */

test("confirmed availability survives a reply that drops the time fields", async (t) => {
  // P1 回归：第二轮模型漏带 availableStart/End 并给出 10:00 行程，
  // 必须按已确认的 13:00–18:00 拒绝并纠正，而不是放行。
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo); // 窗口 10:00–18:00
  const stop = stopsAt(ev.id);
  const feedback: string[] = [];
  faux.setResponses([
    afternoonPlan(ev),
    fauxAssistantMessage(
      envelope({ date: DAY1, summary: "s", stops: [stop("10:00", "11:00")] }, { date: DAY1 }),
    ),
    (context) => {
      const last = context.messages[context.messages.length - 1];
      feedback.push(last.role === "user" ? JSON.stringify(last.content) : "not-user");
      return fauxAssistantMessage(
        envelope({ date: DAY1, summary: "s", stops: [stop("13:30", "14:30")] }, { date: DAY1 }),
      );
    },
  ]);
  const first = await session.prompt("这周六13点到18点看展");
  assert.equal(first.kind, "itinerary");

  const second = await session.prompt("换个展览，时间段不变");
  assert.equal(second.kind, "itinerary");
  if (second.kind === "itinerary") {
    assert.equal(second.itinerary.stops[0].arrive_at, "13:30");
    assert.deepEqual(second.constraints, {
      date: DAY1,
      availableStart: "13:00",
      availableEnd: "18:00",
    });
  }
  // 纠正反馈里能看到生效时段和本轮原用户要求，模型据此修回时段内。
  assert.ok(feedback[0].includes("outside_availability"), feedback[0]);
  assert.ok(feedback[0].includes("13:00") && feedback[0].includes("换个展览，时间段不变"));
  assert.equal(faux.state.callCount, 3);
  assert.deepEqual(session.constraints, {
    date: DAY1,
    availableStart: "13:00",
    availableEnd: "18:00",
  });
});

test("a failed turn does not overwrite confirmed constraints or itinerary", async (t) => {
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo);
  const bad = envelope(
    {
      date: DAY1,
      summary: "s",
      stops: [{ event_id: "evt_ghost", arrive_at: "09:30", leave_at: "10:30", reason: "r" }],
    },
    { date: DAY1, availableStart: "09:00" }, // 试图放宽时段，但整轮失败
  );
  faux.setResponses([
    afternoonPlan(ev),
    fauxAssistantMessage(bad),
    fauxAssistantMessage(bad),
    fauxAssistantMessage(bad),
  ]);
  const first = await session.prompt("13到18点看展");
  assert.equal(first.kind, "itinerary");
  const committed = session.itinerary;

  const second = await session.prompt("改成9点开始，去个鬼地方");
  assert.equal(second.kind, "error");
  assert.equal(session.itinerary, committed);
  assert.deepEqual(session.constraints, {
    date: DAY1,
    availableStart: "13:00",
    availableEnd: "18:00",
  });
});

test("an explicit new bound updates the confirmed constraints", async (t) => {
  // "晚一小时"：模型显式给 availableStart=14:00，合并后 end 仍沿用 18:00。
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo);
  const stop = stopsAt(ev.id);
  faux.setResponses([
    afternoonPlan(ev),
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "s", stops: [stop("14:00", "15:00")] },
        { date: DAY1, availableStart: "14:00" },
      ),
    ),
  ]);
  assert.equal((await session.prompt("13到18点看展")).kind, "itinerary");
  const second = await session.prompt("晚一小时出发");
  assert.equal(second.kind, "itinerary");
  if (second.kind === "itinerary") {
    assert.deepEqual(second.constraints, {
      date: DAY1,
      availableStart: "14:00",
      availableEnd: "18:00",
    });
  }
});

test("null explicitly clears a previously confirmed bound", async (t) => {
  // 用户明确放开时段（"全天都行"）：模型把字段填 null，上午行程放行。
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo);
  const stop = stopsAt(ev.id);
  faux.setResponses([
    afternoonPlan(ev),
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "s", stops: [stop("10:00", "11:00")] },
        { date: DAY1, availableStart: null, availableEnd: null },
      ),
    ),
  ]);
  assert.equal((await session.prompt("13到18点看展")).kind, "itinerary");
  const second = await session.prompt("我改成全天都有空，早一点去");
  assert.equal(second.kind, "itinerary");
  if (second.kind === "itinerary") {
    assert.equal(second.itinerary.stops[0].arrive_at, "10:00");
    assert.deepEqual(second.constraints, { date: DAY1 });
  }
  assert.deepEqual(session.constraints, { date: DAY1 });
});

test("moving to another day keeps the confirmed time window", async (t) => {
  // 换日期但未提时段：原 13:00–18:00 继续生效（要改时段需用户明说）。
  const { session, repo, faux } = await makeSession(t, []);
  const ev1 = await exhibition(repo, DAY1);
  const ev2 = await exhibition(repo, DAY2);
  const stop2 = stopsAt(ev2.id);
  faux.setResponses([
    afternoonPlan(ev1),
    // 第二轮：只改日期、漏掉时段，给出 12:00 的次日行程 → 必须被拒
    fauxAssistantMessage(
      envelope({ date: DAY2, summary: "s", stops: [stop2("12:00", "13:00")] }, { date: DAY2 }),
    ),
    fauxAssistantMessage(
      envelope({ date: DAY2, summary: "s", stops: [stop2("13:30", "14:30")] }, { date: DAY2 }),
    ),
  ]);
  assert.equal((await session.prompt("周六13到18点看展")).kind, "itinerary");
  const second = await session.prompt("改到周日去");
  assert.equal(second.kind, "itinerary");
  if (second.kind === "itinerary") {
    assert.equal(second.itinerary.stops[0].arrive_at, "13:30");
    assert.deepEqual(second.constraints, {
      date: DAY2,
      availableStart: "13:00",
      availableEnd: "18:00",
    });
  }
  assert.equal(faux.state.callCount, 3);
});
