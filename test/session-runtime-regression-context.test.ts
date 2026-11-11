import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { parseStoredMessagePayload } from "../src/session/payload.ts";
import { DAY1, DAY2, makePersistent } from "./e2e-fixture.ts";
import { TINY, compactionRecords, messageRecords } from "./persistent-fixture.ts";
import { openMemoryRepo } from "./session-fixture.ts";

/**
 * 统一审查回归（一）：压缩切换后的数组所有权。
 * onPrepareRequest 不能把 agent.state.messages 的活动数组交给 Pi 循环，
 * 否则循环内的上下文追加与 message_end 事件追加会写进同一个数组，
 * 让同一条 toolCall/toolResult 出现两次（DB 仍各一条）。
 */

const toolCallsFor = (messages: AgentMessage[], id: string) =>
  messages.filter(
    (m) =>
      m.role === "assistant" &&
      m.content.some((part) => part.type === "toolCall" && part.id === id),
  );
const toolResultsFor = (messages: AgentMessage[], id: string) =>
  messages.filter((m) => m.role === "toolResult" && m.toolCallId === id);

test("compaction inside a tool loop never duplicates messages in the next request", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, faux, summary } = await makePersistent(t, [], {
    sessions,
    config: TINY,
  });
  // 观察每次 prepareRequest 拿到的循环上下文（压缩切换正发生在这里）。
  const agent = session.agent;
  const chained = agent.prepareRequest;
  const contexts: AgentMessage[][] = [];
  agent.prepareRequest = (request, signal) => {
    contexts.push([...request.context.messages]);
    return chained?.(request, signal);
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY1 }, { id: "call-1" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY2 }, { id: "call-2" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage('{"type":"clarify","question":"查完了"}'),
  ]);
  const turn = await session.prompt("先查展览再查演出");
  assert.ok(summary && summary.calls() >= 1, "工具循环内应触发自动压缩");
  assert.equal(contexts.length, 3);

  // 压缩切换后的第三个请求：call-2 的调用与结果各出现一次。
  const third = contexts[2];
  assert.equal(toolCallsFor(third, "call-2").length, 1);
  assert.equal(toolResultsFor(third, "call-2").length, 1);
  assert.equal(turn.kind, "clarification");
  // 有效上下文（agent.state.messages）不允许出现重复消息对象。
  const state = session.agent.state.messages;
  assert.equal(new Set(state).size, state.length);

  // DB 与有效 state 匹配：同一 toolCallId 调用/结果各一条，本会话共 6 条消息。
  const stored = (await messageRecords(sessions, session.sessionId as string)).map(
    (r) => parseStoredMessagePayload(r.payload, r.recordId).message,
  );
  assert.equal(stored.length, 6);
  assert.equal(toolCallsFor(stored, "call-1").length, 1);
  assert.equal(toolCallsFor(stored, "call-2").length, 1);
  assert.equal(toolResultsFor(stored, "call-1").length, 1);
  assert.equal(toolResultsFor(stored, "call-2").length, 1);
  assert.ok(
    (await compactionRecords(sessions, session.sessionId as string)).length >= 1,
    "应留下至少一条压缩检查点",
  );
});

test("a plain clarification turn also keeps exactly one copy per message", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session } = await makePersistent(
    t,
    [fauxAssistantMessage('{"type":"clarify","question":"哪一天？"}')],
    { sessions },
  );
  const turn = await session.prompt("帮我安排一下");
  assert.equal(turn.kind, "clarification");
  const state = session.agent.state.messages;
  assert.equal(new Set(state).size, state.length);
  assert.deepEqual(
    state.map((m) => m.role),
    ["system", "user", "assistant"],
  );
  assert.equal(
    (await messageRecords(sessions, session.sessionId as string)).length,
    2,
  );
});
