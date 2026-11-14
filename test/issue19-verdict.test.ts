/**
 * issue19-real-verify.ts 指针契约纯判定的离线单测（不执行真实脚本）：
 * reviewer 发现 answer 分支曾把 before===after 写反为 before!==after——
 * 此类判定从此有独立离线断言兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { verdict } from "./issue19-verdict.ts";

test("answer：指针不变判 PASS，指针变化判 FAIL", () => {
  assert.equal(verdict("answer", "answer", "rec-1", "rec-1"), true);
  assert.equal(verdict("answer", "answer", "rec-1", "rec-2"), false, "answer 挪指针必须 FAIL");
  assert.equal(verdict("answer", "answer", null, null), true, "首轮无方案问答：null→null 也算不变");
  assert.equal(verdict("answer", "answer", null, "rec-1"), false, "answer 建立指针必须 FAIL");
});

test("answer：非 answer kind 一律 FAIL（含 itinerary/comparison/error/clarification）", () => {
  for (const kind of ["itinerary", "comparison", "error", "clarification"]) {
    assert.equal(verdict("answer", kind, "r", "r"), false, `${kind} 不应按 answer 通过`);
  }
});

test("plan：指针推进判 PASS，原地不动或 kind 不符判 FAIL", () => {
  assert.equal(verdict("plan", "itinerary", null, "rec-1"), true, "首轮建指针");
  assert.equal(verdict("plan", "itinerary", "rec-1", "rec-2"), true, "修改轮推进指针");
  assert.equal(verdict("plan", "comparison", "rec-1", "rec-2"), true);
  assert.equal(verdict("plan", "itinerary", "rec-1", "rec-1"), false, "plan 未推进必须 FAIL");
  assert.equal(verdict("plan", "answer", "rec-1", "rec-2"), false, "answer kind 不能当 plan 通过");
  assert.equal(verdict("plan", "clarification", null, null), false);
  assert.equal(verdict("plan", "error", null, null), false);
});
