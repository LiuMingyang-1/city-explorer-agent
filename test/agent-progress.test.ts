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
  assert.equal(summarizeToolArgs("search_events", {}), "全部活动");
  const long = summarizeToolArgs("search_events", { keyword: "k".repeat(500) });
  assert.ok([...long].length <= PROGRESS_TEXT_LIMIT);
  assert.ok(!long.includes("\n"));
});

test("summarizeToolArgs：未知工具给安全默认摘要，不透原参且绝不抛", () => {
  // 只报参数项数：键名/值都不出现在摘要里（原参可能夹带敏感字段）。
  assert.equal(summarizeToolArgs("unknown_tool", { a: 1, b: 2 }), "2 项参数");
  const sensitive = summarizeToolArgs("unknown_tool", { secret_key: "sk-live-123" });
  assert.equal(sensitive, "1 项参数");
  assert.ok(!sensitive.includes("sk-live-123") && !sensitive.includes("secret_key"));
  // 非标量入参按 1 项计；空入参 0 项。
  assert.equal(summarizeToolArgs("unknown_tool", "raw"), "1 项参数");
  assert.equal(summarizeToolArgs("unknown_tool", undefined), "0 项参数");
  // 循环引用/BigInt：旧 JSON.stringify 路径会抛，现路径不抛。
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => summarizeToolArgs("unknown_tool", circular));
  assert.doesNotThrow(() => summarizeToolArgs("unknown_tool", { n: BigInt(9) }));
});

test("toolResultCount：按真实 details 语义推导，推导不出为 null", () => {
  // details.count 为有限数时优先（search_events 及任何如实报数的工具）。
  assert.equal(toolResultCount("search_events", { details: { count: 7 } }), 7);
  assert.equal(toolResultCount("mystery_tool", { details: { count: 4 } }), 4);
  assert.equal(toolResultCount("search_events", { details: { count: Number.NaN } }), null);
  // 已知工具的真实结果形态：web_search.results[]、delegate_task.itinerary.stops[]。
  assert.equal(toolResultCount("web_search", { details: { results: [{}, {}, {}] } }), 3);
  assert.equal(toolResultCount("web_search", { details: { query: "q" } }), null);
  assert.equal(
    toolResultCount("delegate_task", { details: { itinerary: { stops: [{}, {}] } } }),
    2,
  );
  assert.equal(toolResultCount("delegate_task", { details: { status: "completed" } }), null);
  // 无条目数语义 → null，不凑假命中数。
  assert.equal(
    toolResultCount("estimate_travel", { details: { duration_seconds: 900 } }),
    null,
  );
  assert.equal(toolResultCount("search_events", { details: {} }), null);
  assert.equal(toolResultCount("search_events", null), null);
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
  // web_search 无 details.count：命中数按真实 results[] 推导。
  const web = toolCallEvent({
    toolCallId: "tc3",
    name: "web_search",
    args: { query: "闭馆" },
    result: { details: { query: "闭馆", results: [{}, {}] } },
    isError: false,
  });
  assert.equal(web.result_count, 2);
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
    title: "曲江看展方案",
    summary: "曲江看展线",
    childRunId: "run_child",
    childRunStatus: "completed",
  });
  assert.equal(done.stops_count, 3);
  assert.equal(done.title, "曲江看展方案");
  assert.equal(done.child_run_status, "completed");
  assert.ok(done.message.includes("3 站"));

  // title 必填且按 ≤40 码点裁剪（与 spawned 同源）。
  const longTitle = subagentDoneEvent({
    subagentId: "sess_child",
    planId: null,
    status: "failed",
    title: `超长${"题".repeat(80)}`,
    summary: "启动子任务失败：x",
    childRunId: null,
  });
  assert.ok([...longTitle.title].length <= 40);
  assert.ok(longTitle.title.endsWith("…"));

  const cancelled = subagentDoneEvent({
    subagentId: "sess_child",
    planId: null,
    status: "cancelled",
    title: "曲江看展方案",
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
