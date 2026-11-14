/**
 * Issue #19 协议校验（C1）：模型输出契约新增普通回答形态
 * {"type":"answer","text":"…"}——问信息/讨论方案时直接回答，
 * 不产出行程卡片。本文件只测 parsePlannerResponse 的协议层：
 * 合法 answer 接受、空/非法 text 拒绝、既有三形态逐字兼容。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlannerResponse, PlannerResponseError } from "../src/agent/response.ts";

/** answer 形态的本地期望（实现落地前 PlannerResponse 尚无此成员）。 */
interface AnswerResponse {
  type: "answer";
  text: string;
}

function asAnswer(raw: string): AnswerResponse {
  const parsed = parsePlannerResponse(raw) as unknown as AnswerResponse;
  assert.equal(parsed.type, "answer", `应解析为 answer：${raw}`);
  return parsed;
}

test("answer：合法 text 解析为普通回答", () => {
  const parsed = asAnswer('{"type":"answer","text":"明天多云转阴，18–24℃，适合出行。"}');
  assert.equal(parsed.text, "明天多云转阴，18–24℃，适合出行。");
});

test("answer：接受 ```json 围栏与首尾空白（与既有形态同口径）", () => {
  const fenced = asAnswer('```json\n{"type":"answer","text":"第二站需要预约。"}\n```');
  assert.equal(fenced.text, "第二站需要预约。");
  // 与 clarify 的 question 同口径：返回文本应 trim。
  const padded = asAnswer('{"type":"answer","text":"  会下雨，建议带伞。  "}');
  assert.equal(padded.text, "会下雨，建议带伞。");
});

test("answer：忽略多余键，只取 text（与 clarify 的宽松度一致）", () => {
  const parsed = asAnswer(
    '{"type":"answer","text":"只是回答","constraints":{"date":"2026-11-15"},"itinerary":{"stops":[]}}',
  );
  assert.equal(parsed.text, "只是回答");
});

test("answer：text 缺失、空串、纯空白、非字符串一律 PlannerResponseError", () => {
  for (const bad of [
    '{"type":"answer"}',
    '{"type":"answer","text":""}',
    '{"type":"answer","text":"   \n\t  "}',
    '{"type":"answer","text":123}',
    '{"type":"answer","text":null}',
    '{"type":"answer","text":{}}',
    '{"type":"answer","text":["a","b"]}',
  ]) {
    assert.throws(() => parsePlannerResponse(bad), PlannerResponseError, `应拒绝：${bad}`);
  }
});

test("answer：解析错误信息应能把模型引回契约（提示 answer 是合法类型）", () => {
  try {
    parsePlannerResponse('{"type":"answer"}');
    assert.fail("非法 answer 不应解析成功");
  } catch (error) {
    assert.ok(error instanceof PlannerResponseError);
    // 回喂给模型的纠错文案应点名 answer 形态的要求。
    assert.match(error.message, /answer|text/i);
  }
  try {
    parsePlannerResponse('{"type":"weather","text":"x"}');
    assert.fail("未知 type 不应解析成功");
  } catch (error) {
    assert.ok(error instanceof PlannerResponseError);
    // 未知类型的报错应列出合法 type（含新增的 answer），帮模型自纠。
    assert.match(error.message, /answer/);
  }
});

test("answer：与既有三形态共存——clarify / itinerary / comparison 解析不变", () => {
  const clarify = parsePlannerResponse('{"type":"clarify","question":"哪天去？"}');
  assert.deepEqual(clarify, { type: "clarify", question: "哪天去？" });

  const itinerary = parsePlannerResponse(
    JSON.stringify({
      type: "itinerary",
      constraints: { date: "2026-11-15" },
      itinerary: { date: "2026-11-15", summary: "s", stops: [] },
    }),
  );
  assert.equal(itinerary.type, "itinerary");

  const comparison = parsePlannerResponse(
    JSON.stringify({
      type: "comparison",
      constraints: { date: "2026-11-15" },
      plans: [
        { label: "A", title: "a", itinerary: { date: "2026-11-15", summary: "a", stops: [] } },
        { label: "B", title: "b", itinerary: { date: "2026-11-15", summary: "b", stops: [] } },
      ],
    }),
  );
  assert.equal(comparison.type, "comparison");

  // 非法输入仍整体拒绝：非 JSON、非对象、未知 type。
  for (const bad of ["not json", "[1,2]", "42", '{"type":"plan","itinerary":{}}']) {
    assert.throws(() => parsePlannerResponse(bad), PlannerResponseError, `应拒绝：${bad}`);
  }
});
