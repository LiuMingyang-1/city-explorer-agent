/**
 * issue #39 旧前端兼容验收：真实 transport.js + chat.js 消费含新类型帧的
 * SSE 流——chat.js 对每条 progress 帧覆盖 status.textContent
 * （progress.message || stageNames[stage] || '正在整理方案'），本文件录制
 * 全部实际写入，断言无 undefined / 无 '正在整理方案' 兜底回退。
 * 用例：手写新类型帧序列 + 真实 docs/mocks/day0/stream.sse 样例。
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Element, setup } from "./frontend-fixture.ts";

function nodes(root: Element): Element[] {
  return [root, ...root.children.flatMap(nodes)];
}
const find = (root: Element, cls: string) =>
  nodes(root).filter((e) => e.className.split(" ").includes(cls));

/**
 * 驱动 sendMessage 并录制 planning-progress 气泡的全部 textContent 写入
 * （首个 '正在连接城市向导' 在录制前已写，不在断言范围）。
 */
async function deliverAndRecord(
  h: ReturnType<typeof setup>,
  message: string,
): Promise<string[]> {
  const done = h.run(`window.sendMessage(${JSON.stringify(message)})`);
  const pending = h.$("messages").children.at(-1) as Element;
  const status = pending.children.find((c) =>
    c.className.split(" ").includes("planning-progress"),
  ) as Element;
  assert.ok(status, "pending bubble exists");
  const writes: string[] = [];
  let current = status.textContent;
  Object.defineProperty(status, "textContent", {
    configurable: true,
    get: () => current,
    set: (v: string) => {
      current = String(v);
      writes.push(current);
    },
  });
  await done;
  return writes;
}

/** 每条写入都是真实事件文案：非空、不含 undefined、非通用回退。 */
function assertNoFallback(writes: string[]): void {
  for (const text of writes) {
    assert.ok(text.length > 0, "progress text must be non-empty");
    assert.ok(!text.includes("undefined"), `progress text contains undefined: ${text}`);
    assert.notEqual(text, "正在整理方案", "generic fallback leaked through");
  }
}

test("旧前端消费新类型帧：逐帧 message 落地，无兜底/undefined", async () => {
  const h = setup({ api: true });
  const stream = [
    'event: meta\ndata: {"session_id":"sess_fe1"}',
    'event: progress\ndata: {"stage":"searching_events","message":"正在检索活动","plan_ids":[]}',
    'event: progress\ndata: {"type":"tool_call","tool_call_id":"tc1","name":"search_events","args_summary":"date=2026-11-14 类别=展览","result_count":12,"status":"completed","duration_ms":34,"message":"search_events date=2026-11-14 类别=展览：12 条"}',
    'event: progress\ndata: {"type":"subagent_spawned","subagent_id":"sess_c1","plan_id":"A","parent_run_id":"run_p","title":"曲江看展方案","task_summary":"2026-11-14 曲江方向探路","message":"正在派发子任务「曲江看展方案」"}',
    'event: progress\ndata: {"type":"subagent_done","subagent_id":"sess_c1","plan_id":"A","status":"completed","kind":"itinerary","stops_count":2,"title":"曲江看展方案","summary":"曲江看展线","child_run_id":"run_c","child_run_status":"completed","message":"子任务完成：2 站 曲江看展线"}',
    'event: result\ndata: {"kind":"clarification","session_id":"sess_fe1","question":"哪天去？"}',
    "",
  ].join("\n\n");
  h.context.fetch = async () =>
    new Response(stream, { headers: { "Content-Type": "text/event-stream" } });

  const writes = await deliverAndRecord(h, "周六去看展");
  assert.deepEqual(writes, [
    "正在检索活动",
    "search_events date=2026-11-14 类别=展览：12 条",
    "正在派发子任务「曲江看展方案」",
    "子任务完成：2 站 曲江看展线",
  ]);
  assertNoFallback(writes);
});

test("旧前端消费真实 day0 stream.sse：含新事件帧的样例无兜底/undefined", async () => {
  const h = setup({ api: true });
  const sample = readFileSync(
    new URL("../docs/mocks/day0/stream.sse", import.meta.url),
    "utf8",
  );
  h.context.fetch = async () =>
    new Response(sample, { headers: { "Content-Type": "text/event-stream" } });

  const writes = await deliverAndRecord(h, "给我两个方案");
  // 样例帧消息按序落地（stage 4 条 + tool_call 2 条 + spawned 2 条 + done 2 条）。
  assert.deepEqual(writes, [
    "正在检索活动",
    "search_events date=2026-11-14 类别=展览：12 条",
    "正在并行探路方案 A 与方案 B",
    "正在派发子任务「曲江看展方案」",
    "正在派发子任务「城南市集方案」",
    "search_events date=2026-11-14 类别=展览：5 条",
    "子任务完成：2 站 曲江看展阅读线",
    "子任务完成：2 站 城南艺术市集线",
    "正在获取站间道路路线",
    "正在校验路线时间",
  ]);
  assertNoFallback(writes);
  assert.equal(h.run("state.sessionId"), "sess_mock_001");
});
