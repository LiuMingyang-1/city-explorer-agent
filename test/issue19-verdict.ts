/**
 * Issue #19 真实验证脚本的指针契约纯判定（无副作用，供脚本与离线单测共用）：
 * - expect "plan"：turn 必须是 itinerary/comparison 且行程指针发生推进；
 * - expect "answer"：turn 必须是 answer 且行程指针保持不变。
 * 首轮 answer（尚无已提交方案）before/after 均为 null，"不变"判定成立。
 */
export type StepExpectation = "plan" | "answer";

export function verdict(
  expect: StepExpectation,
  kind: string,
  before: string | null,
  after: string | null,
): boolean {
  const isPlan = kind === "itinerary" || kind === "comparison";
  return expect === "plan"
    ? isPlan && before !== after
    : kind === "answer" && before === after;
}
