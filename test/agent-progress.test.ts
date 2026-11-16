/**
 * 过程事件契约骨架（src/agent/progress.ts）的最小验证：
 * 裁剪边界、参数摘要白名单、事件构造字段、safeEmit 吞错、
 * 旧 stage 帧形状不含 type 键（线上字节级兼容）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROGRESS_TEXT_LIMIT,
  clipText,
  safeEmit,
  stageProgress,
  stampSubagent,
  subagentDoneEvent,
  subagentSpawnedEvent,
  summarizeToolArgs,
  toolCallEvent,
  toolResultCount,
} from "../src/agent/progress.ts";

test("clipText：压平空白、按码点截断补省略号、不切碎 surrogate pair", () => {
  assert.equal(clipText("a\nb\tc  d"), "a b c d");
  const emoji = "😀".repeat(200);
  const clipped = clipText(emoji, 10);
  assert.equal([...clipped].length, 10);
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipText("短"), "短");
});

test("stageProgress：旧帧形状 {stage,message,plan_ids}，无 type 键", () => {
  assert.deepEqual(stageProgress("searching_events", []), {
    stage: "searching_events",
    message: "正在检索活动",
    plan_ids: [],
  });
  assert.deepEqual(stageProgress("exploring_plans", ["A", "B"]).message, "正在并行探路方案 A 与方案 B");
  // plan_ids 是拷贝：改返回数组不影响入参数组。
  const ids = ["A"];
  const event = stageProgress("validating_schedule", ids);
  event.plan_ids.push("B");
  assert.deepEqual(ids, ["A"]);
});

test("summarizeToolArgs：白名单摘要且单行有界", () => {
  assert.equal(
    summarizeToolArgs("search_events", { date: "2026-11-14", category: "展览", keyword: "光影" }),
    "date=2026-11-14 类别=展览 词=光影",
  );
  assert.equal(summarizeToolArgs("delegate_task", { task: "x".repeat(300), title: "方案A" }), "方案A");
  assert.equal(
    summarizeToolArgs("estimate_travel", { from_event_id: "e1", to_event_id: "e2", mode: "walking" }),
    "e1→e2 walking",
  );
  assert.equal(summarizeToolArgs("web_search", { query: "闭馆 时间" }), "query=闭馆 时间");
  assert.equal(summarizeToolArgs("unknown_tool", { a: 1 }), '{"a":1}');
  assert.equal(summarizeToolArgs("search_events", {}), "全部活动");
  const long = summarizeToolArgs("search_events", { keyword: "k".repeat(500) });
  assert.ok([...long].length <= PROGRESS_TEXT_LIMIT);
  assert.ok(!long.includes("\n"));
});

test("toolResultCount：仅 details.count 有限数透出", () => {
  assert.equal(toolResultCount({ details: { count: 7 } }), 7);
  assert.equal(toolResultCount({ details: { count: Number.NaN } }), null);
  assert.equal(toolResultCount({ details: {} }), null);
  assert.equal(toolResultCount(null), null);
});

test("toolCallEvent：name/args_summary/result_count/status/duration_ms", () => {
  const event = toolCallEvent({
    toolCallId: "tc1",
    name: "search_events",
    args: { date: "2026-11-14" },
    result: { details: { count: 12 } },
    isError: false,
    durationMs: 33.7,
  });
  assert.equal(event.type, "tool_call");
  assert.equal(event.tool_call_id, "tc1");
  assert.equal(event.result_count, 12);
  assert.equal(event.status, "completed");
  assert.equal(event.duration_ms, 34);
  assert.equal(event.subagent_id, undefined);
  const failed = toolCallEvent({
    toolCallId: "tc2",
    name: "search_events",
    args: {},
    isError: true,
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.result_count, null);
  assert.equal(failed.duration_ms, undefined);
});

test("subagent_spawned/done：关联 id、终态、摘要裁剪与 message", () => {
  const spawned = subagentSpawnedEvent({
    subagentId: "sess_child",
    planId: "B",
    parentRunId: "run_parent",
    task: "t".repeat(300),
  });
  assert.equal(spawned.type, "subagent_spawned");
  assert.equal(spawned.subagent_id, "sess_child");
  assert.equal(spawned.plan_id, "B");
  assert.equal(spawned.parent_run_id, "run_parent");
  assert.ok([...spawned.title].length <= 40);
  assert.ok([...spawned.task_summary].length <= PROGRESS_TEXT_LIMIT);

  const done = subagentDoneEvent({
    subagentId: "sess_child",
    planId: "B",
    status: "completed",
    kind: "itinerary",
    stopsCount: 3,
    summary: "曲江看展线",
    childRunId: "run_child",
    childRunStatus: "completed",
  });
  assert.equal(done.stops_count, 3);
  assert.equal(done.child_run_status, "completed");
  assert.ok(done.message.includes("3 站"));

  const cancelled = subagentDoneEvent({
    subagentId: "sess_child",
    planId: null,
    status: "cancelled",
    summary: "父请求已取消",
    childRunId: null,
  });
  assert.equal(cancelled.stops_count, null);
  assert.equal(cancelled.child_run_status, null);
  assert.ok(!("kind" in cancelled));
});

test("stampSubagent：保留原字段并盖章 subagent_id", () => {
  const stamped = stampSubagent(stageProgress("searching_events", []), "sess_child");
  assert.equal(stamped.subagent_id, "sess_child");
  assert.equal((stamped as { stage: string }).stage, "searching_events");
});

test("safeEmit：sink 缺省空转、回调抛错吞掉", () => {
  safeEmit(undefined, stageProgress("routing", []));
  assert.doesNotThrow(() =>
    safeEmit(
      () => {
        throw new Error("observer bug");
      },
      stageProgress("routing", []),
    ),
  );
  const seen: string[] = [];
  safeEmit((e) => seen.push(e.type ?? "stage"), stageProgress("routing", []));
  assert.deepEqual(seen, ["stage"]);
});
