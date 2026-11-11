import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { ValidatedPlan } from "../../session/types.ts";

const CONFIRMED_PLAN_SECTION = "confirmed_itinerary";
const CANDIDATE_PLAN_SECTION = "candidate_itinerary";

/** 注入 system section 的规划状态来源：main=DB 指针已确认；child=最新成功 run 的候选。 */
export type InjectedPlanKind = "confirmed" | "candidate";

function confirmedSectionText(plan: ValidatedPlan): string {
  return (
    "## 已确认的规划状态（服务端持久数据，权威来源）\n" +
    `生效约束：${JSON.stringify(plan.constraints)}\n` +
    `当前行程：${JSON.stringify(plan.itinerary)}\n` +
    "用户之后的修改请求在这份行程上产出完整的新行程；摘要不得丢失此节内容。"
  );
}

function candidateSectionText(plan: ValidatedPlan): string {
  return (
    "## 本会话最新候选行程（仅该子会话内有效的工作参考，不是主会话的正式行程）\n" +
    `参考约束：${JSON.stringify(plan.constraints)}\n` +
    `候选行程：${JSON.stringify(plan.itinerary)}\n` +
    "它是本会话最近一次校验通过的产出；后续请求在这份约束上产出完整新行程，摘要不得丢失此节内容。"
  );
}

/**
 * 当前权威 system 消息：基础提示 + 规划状态 section；永不进 raw。
 * 恢复与 plan 提交后重建一次，使之后的每个模型请求都携带最新规划状态，
 * 而不是指望压缩摘要记住它。main 注入已确认指针状态，child 注入候选
 * （明确标注候选身份，绝不冒充 main 的正式行程）。
 */
export function runtimeSystemMessage(
  base: SystemMessage | undefined,
  plan: ValidatedPlan | undefined,
  kind: InjectedPlanKind = "confirmed",
): AgentMessage {
  const baseSystem = base ?? ({ role: "system", content: "", timestamp: 0 } as SystemMessage);
  const sections: Record<string, string | null> = { ...(baseSystem.sections ?? {}) };
  sections[CONFIRMED_PLAN_SECTION] =
    kind === "confirmed" && plan ? confirmedSectionText(plan) : null;
  if (kind === "candidate") {
    sections[CANDIDATE_PLAN_SECTION] = plan ? candidateSectionText(plan) : null;
  }
  return { ...baseSystem, sections } as AgentMessage;
}
