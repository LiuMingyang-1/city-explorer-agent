/**
 * 过程事件契约骨架（src/agent/progress.ts）的最小验证：
 * 裁剪边界、参数摘要白名单、事件构造字段、safeEmit 吞错、
 * 旧 stage 帧形状不含 type 键（线上字节级兼容）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROGRESS_CANDIDATE_LIMIT,
  PROGRESS_POINT_ID_MAX,
  PROGRESS_POINTS_BYTE_LIMIT,
  PROGRESS_STOP_LIMIT,
  PROGRESS_TEXT_LIMIT,
  clipText,
  type ToolCallEvent,
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

const eventRow = (id: string, latitude = 34.2, longitude = 108.9) => ({ id, title: id, latitude, longitude });

test("toolCallEvent candidates：仅成功 search_events 透真实候选，有序去重有界", () => {
  const events = [
    eventRow("evt_1"),
    eventRow("evt_2", 34.3, 108.8),
    eventRow("evt_1"), // 重复 id 去重
    { id: "", latitude: 34.2, longitude: 108.9 }, // 空 id 跳过
    { id: "evt_bad_lat", latitude: 91, longitude: 108.9 }, // 非法纬度跳过
    { id: "evt_bad_lng", latitude: 34.2, longitude: 181 }, // 非法经度跳过
    { id: "evt_nan", latitude: Number.NaN, longitude: 108.9 },
    { latitude: 34.2, longitude: 108.9 }, // 缺 id 跳过
    eventRow("evt_3"),
  ];
  const call = toolCallEvent({
    toolCallId: "tc_c",
    name: "search_events",
    args: {},
    result: { details: { count: events.length }, structuredContent: { events } },
    isError: false,
  });
  assert.deepEqual(
    call.candidates,
    [
      { event_id: "evt_1", latitude: 34.2, longitude: 108.9 },
      { event_id: "evt_2", latitude: 34.3, longitude: 108.8 },
      { event_id: "evt_3", latitude: 34.2, longitude: 108.9 },
    ],
  );

  // 超过 16 条按结果原序截断；字节预算独立兜底（≤8KiB）。
  const many = Array.from({ length: 40 }, (_, i) => eventRow(`evt_${i}`));
  const capped = toolCallEvent({
    toolCallId: "tc_cap",
    name: "search_events",
    args: {},
    result: { details: { count: 40 }, structuredContent: { events: many } },
    isError: false,
  });
  assert.equal(capped.candidates?.length, PROGRESS_CANDIDATE_LIMIT);
  assert.equal(capped.candidates?.[0].event_id, "evt_0");
  assert.ok(
    new TextEncoder().encode(JSON.stringify(capped.candidates)).length <=
      PROGRESS_POINTS_BYTE_LIMIT,
  );
  // 极端长真实 id：不截断冒充身份——超过 ID_MAX 整条跳过；
  // 多条多字节 id 顶到字节预算即停，绝不超帧。
  const fat = Array.from({ length: 20 }, (_, i) =>
    eventRow(`长_${"界".repeat(PROGRESS_POINT_ID_MAX)}_${i}`),
  ).concat([eventRow("evt_tail")]);
  const fatCall = toolCallEvent({
    toolCallId: "tc_fat",
    name: "search_events",
    args: {},
    result: { structuredContent: { events: fat } },
    isError: false,
  });
  assert.deepEqual(
    fatCall.candidates?.map((c) => c.event_id),
    ["evt_tail"],
  );
  const huge = Array.from({ length: 20 }, (_, i) =>
    eventRow(`长_${"界".repeat(200)}_${i}`),
  ); // 每条 ~670B，20 条 >8KiB
  const hugeCall = toolCallEvent({
    toolCallId: "tc_huge",
    name: "search_events",
    args: {},
    result: { structuredContent: { events: huge } },
    isError: false,
  });
  assert.ok((hugeCall.candidates?.length ?? 0) < 20);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(hugeCall.candidates)).length <=
      PROGRESS_POINTS_BYTE_LIMIT,
  );
});

test("toolCallEvent candidates：error/非 search/缺 structuredContent 一律省略", () => {
  const events = [eventRow("evt_1")];
  const errored = toolCallEvent({
    toolCallId: "tc1",
    name: "search_events",
    args: {},
    result: { structuredContent: { events } },
    isError: true,
  });
  assert.equal("candidates" in errored, false);
  const otherTool = toolCallEvent({
    toolCallId: "tc2",
    name: "web_search",
    args: {},
    result: { structuredContent: { events } },
    isError: false,
  });
  assert.equal("candidates" in otherTool, false);
  const noStructured = toolCallEvent({
    toolCallId: "tc3",
    name: "search_events",
    args: {},
    result: { details: { count: 3 } },
    isError: false,
  });
  assert.equal("candidates" in noStructured, false);
  // structuredContent.events 全被校验跳过 → 字段整体省略，不冒充空集合语义。
  const allBad = toolCallEvent({
    toolCallId: "tc4",
    name: "search_events",
    args: {},
    result: { structuredContent: { events: [{ id: "x" }, "junk", null] } },
    isError: false,
  });
  assert.equal("candidates" in allBad, false);
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

test("subagentDoneEvent stops：仅 completed+itinerary 透出，行程序/去重/有界/终态 gate", () => {
  const stops = [
    { event_id: "evt_a", latitude: 34.2, longitude: 108.9 },
    { event_id: "evt_b", latitude: 34.3, longitude: 108.8 },
    { event_id: "evt_a", latitude: 34.2, longitude: 108.9 }, // 重复站去重
    { event_id: "evt_bad", latitude: -91, longitude: 108.9 }, // 非法坐标跳过
    { event_id: "x".repeat(PROGRESS_POINT_ID_MAX + 1), latitude: 34.2, longitude: 108.9 },
  ];
  const done = subagentDoneEvent({
    subagentId: "sess_child",
    planId: "A",
    status: "completed",
    kind: "itinerary",
    stopsCount: 4,
    stops,
    title: "方案",
    summary: "s",
    childRunId: "run_c",
    childRunStatus: "completed",
  });
  assert.deepEqual(done.stops, [
    { event_id: "evt_a", latitude: 34.2, longitude: 108.9 },
    { event_id: "evt_b", latitude: 34.3, longitude: 108.8 },
  ]);

  // close 降级/取消/追问：stops 入参即便已给也随终态省略，不漏进失败帧。
  for (const [status, kind] of [
    ["failed", undefined],
    ["cancelled", undefined],
    ["completed", "clarification"],
  ] as const) {
    const gated = subagentDoneEvent({
      subagentId: "s",
      planId: null,
      status,
      ...(kind !== undefined ? { kind } : {}),
      stops,
      title: "t",
      summary: "x",
      childRunId: null,
    });
    assert.equal("stops" in gated, false);
  }

  // completed+itinerary 但无 stops 入参/全部校验失败 → 字段省略而非空数组。
  const empty = subagentDoneEvent({
    subagentId: "s",
    planId: null,
    status: "completed",
    kind: "itinerary",
    title: "t",
    summary: "x",
    childRunId: null,
  });
  assert.equal("stops" in empty, false);
  const allBad = subagentDoneEvent({
    subagentId: "s",
    planId: null,
    status: "completed",
    kind: "itinerary",
    stops: [{ event_id: "", latitude: 1, longitude: 1 }],
    title: "t",
    summary: "x",
    childRunId: null,
  });
  assert.equal("stops" in allBad, false);

  // 条数与字节双上限：24 条封顶；超长 id 顶到 8KiB 即停。
  const many = Array.from({ length: 40 }, (_, i) => ({
    event_id: `evt_${i}`,
    latitude: 34.2,
    longitude: 108.9,
  }));
  const capped = subagentDoneEvent({
    subagentId: "s",
    planId: null,
    status: "completed",
    kind: "itinerary",
    stops: many,
    title: "t",
    summary: "x",
    childRunId: null,
  });
  assert.equal(capped.stops?.length, PROGRESS_STOP_LIMIT);
  const fat = Array.from({ length: 24 }, (_, i) => ({
    event_id: `长_${"界".repeat(200)}_${i}`,
    latitude: 34.2,
    longitude: 108.9,
  }));
  const fatDone = subagentDoneEvent({
    subagentId: "s",
    planId: null,
    status: "completed",
    kind: "itinerary",
    stops: fat,
    title: "t",
    summary: "x",
    childRunId: null,
  });
  assert.ok((fatDone.stops?.length ?? 0) < 24);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(fatDone.stops)).length <=
      PROGRESS_POINTS_BYTE_LIMIT,
  );
});

test("stampSubagent：未归属实体事件补盖 child id", () => {
  const call = toolCallEvent({
    toolCallId: "tc1",
    name: "search_events",
    args: {},
    isError: false,
  });
  const stamped = stampSubagent(call, "sess_child");
  assert.equal(stamped.subagent_id, "sess_child");
  assert.equal((stamped as ToolCallEvent).tool_call_id, "tc1");
});

test("stampSubagent：已归属实体 ID 不覆盖、stage 不盖章", () => {
  // 多层派发：孙会话事件已盖 sess_grand，外层转发不得改写成 sess_child。
  const grand = stampSubagent(
    toolCallEvent({ toolCallId: "tc_g", name: "search_events", args: {}, isError: false }),
    "sess_grand",
  );
  const again = stampSubagent(grand, "sess_child");
  assert.equal(again.subagent_id, "sess_grand");
  assert.equal(again, grand); // 已归属事件原样透传（同一对象，零篡改）。
  // spawned/done 恒带自身 subagent_id：外层转发同样保真。
  const spawned = subagentSpawnedEvent({
    subagentId: "sess_grand",
    planId: "A",
    parentRunId: "run_c",
    task: "孙任务",
  });
  assert.equal(stampSubagent(spawned, "sess_child").subagent_id, "sess_grand");
  // stage 是本轮私有叙事：不盖章（含无 type 键的旧帧形状）。
  const stage = stageProgress("searching_events", []);
  const unstamped = stampSubagent(stage, "sess_child");
  assert.equal(unstamped.subagent_id, undefined);
  assert.equal(unstamped, stage);
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
