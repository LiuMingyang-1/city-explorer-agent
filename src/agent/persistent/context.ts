import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { ValidatedPlan } from "../../session/types.ts";

const CONFIRMED_PLAN_SECTION = "confirmed_itinerary";
const CANDIDATE_PLAN_SECTION = "candidate_itinerary";
const LOCATION_SECTION = "location_context";

/** 注入 system section 的规划状态来源：main=DB 指针已确认；child=最新成功 run 的候选。 */
export type InjectedPlanKind = "confirmed" | "candidate";

/** 每轮透传的用户位置：坐标 + 可选语义锚点文案（就近场馆，由调用方生成）。 */
export interface LocationContext {
  lat: number;
  lng: number;
  /** 语义锚点（如"距「某场馆」约 N 公里"）；无就近场馆或解析失败时缺省。 */
  anchor?: string;
}

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
 * 位置 section：只呈现坐标与锚点文案；位置怎么影响规划行为写在 prompt.ts
 * 的系统提示里，这里不加行为规则。
 */
function locationSectionText(location: LocationContext): string {
  const lines = [
    "## 用户当前位置（背景信息，非硬约束）",
    `纬度：${location.lat.toFixed(5)}；经度：${location.lng.toFixed(5)}`,
  ];
  if (location.anchor) lines.push(`锚点参考：${location.anchor}`);
  return lines.join("\n");
}

/**
 * 当前权威 system 消息：基础提示 + 规划状态/用户位置 section；永不进 raw。
 * 恢复与 plan 提交后重建一次，使之后的每个模型请求都携带最新规划状态，
 * 而不是指望压缩摘要记住它。main 注入已确认指针状态，child 注入候选
 * （明确标注候选身份，绝不冒充 main 的正式行程）。位置与会话类型无关，
 * main/child 注入同一份（该轮没透传位置时 location 为 undefined → 无该节）。
 */
export function runtimeSystemMessage(
  base: SystemMessage | undefined,
  plan: ValidatedPlan | undefined,
  kind: InjectedPlanKind = "confirmed",
  location?: LocationContext,
): AgentMessage {
  const baseSystem = base ?? ({ role: "system", content: "", timestamp: 0 } as SystemMessage);
  const sections: Record<string, string | null> = { ...(baseSystem.sections ?? {}) };
  sections[CONFIRMED_PLAN_SECTION] =
    kind === "confirmed" && plan ? confirmedSectionText(plan) : null;
  if (kind === "candidate") {
    sections[CANDIDATE_PLAN_SECTION] = plan ? candidateSectionText(plan) : null;
  }
  sections[LOCATION_SECTION] = location ? locationSectionText(location) : null;
  return { ...baseSystem, sections } as AgentMessage;
}
