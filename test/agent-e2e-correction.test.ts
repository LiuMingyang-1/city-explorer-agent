import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BASE, DAY1, envelope, exhibition, makeSession } from "./e2e-fixture.ts";

/**
 * 端到端：单轮内的校验拒绝 → 纠正 → 提交。
 * 约束多轮合并/保留见 agent-e2e-constraints.test.ts。
 */

test("a stop outside the event window is rejected, the fix commits", async (t) => {
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo, BASE);
  const goodStop = {
    event_id: ev.id,
    arrive_at: ev.startAt.slice(11, 16),
    leave_at: ev.endAt.slice(11, 16),
    reason: "r",
  };
  faux.setResponses([
    fauxAssistantMessage(
      envelope({ date: BASE, summary: "s", stops: [{ ...goodStop, arrive_at: "00:01" }] }),
    ),
    (context) => {
      const last = context.messages[context.messages.length - 1];
      assert.ok(JSON.stringify(last.content).includes("outside_event_window"));
      return fauxAssistantMessage(envelope({ date: BASE, summary: "s", stops: [goodStop] }));
    },
  ]);
  const turn = await session.prompt("安排");
  assert.equal(turn.kind, "itinerary");
  if (turn.kind === "itinerary") assert.equal(turn.itinerary.stops[0].event_id, ev.id);
  assert.equal(faux.state.callCount, 2);
});

test("invalid constraint values are rejected and corrected within the turn", async (t) => {
  // P2 回归：模型给出 99:00 → 解析直接拒绝，进入纠正；修好才提交。
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo);
  const feedback: string[] = [];
  faux.setResponses([
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "s",
          stops: [{ event_id: ev.id, arrive_at: "10:00", leave_at: "11:00", reason: "r" }],
        },
        { date: DAY1, availableStart: "99:00", availableEnd: "99:99" },
      ),
    ),
    (context) => {
      const last = context.messages[context.messages.length - 1];
      feedback.push(last.role === "user" ? JSON.stringify(last.content) : "not-user");
      return fauxAssistantMessage(
        envelope(
          {
            date: DAY1,
            summary: "s",
            stops: [{ event_id: ev.id, arrive_at: "10:00", leave_at: "11:00", reason: "r" }],
          },
          { date: DAY1 },
        ),
      );
    },
  ]);
  const turn = await session.prompt("安排看展");
  assert.equal(turn.kind, "itinerary");
  assert.ok(feedback[0].includes("99:00"), feedback[0]);
  assert.equal(faux.state.callCount, 2);
});
