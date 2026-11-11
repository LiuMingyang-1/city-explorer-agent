import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isCalendarDate, isClockTime } from "../itinerary/constraints.ts";
import type { ConstraintsPatch } from "../itinerary/constraints.ts";

/**
 * 模型每轮回复的 envelope（见 prompt.ts 的输出契约）：
 * clarify 表示信息不足在追问；itinerary 携带约束补丁与候选行程。
 * constraints 是 ConstraintsPatch：字符串设置字段、null 显式清除、
 * 缺省沿用会话已确认值（由 PlannerSession 合并后再校验）。
 * candidate 保持未校验的原始值，交给 validateItinerary 做结构检查。
 */
export type PlannerResponse =
  | { type: "clarify"; question: string }
  | { type: "itinerary"; constraints: ConstraintsPatch; candidate: unknown };

/** 回复不是约定 envelope 时抛出，message 可直接回喂给模型修正。 */
export class PlannerResponseError extends Error {}

/** 取最后一条 assistant 消息的全部文本块；没有则 undefined。 */
export function lastAssistantText(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") return undefined; // 最新一条不是 assistant 说明轮次未结束
    const text = m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || undefined;
  }
  return undefined;
}

function extractJson(text: string): unknown {
  // 允许 ```json ... ``` 围栏；否则取第一个 { 到最后一个 } 的子串再解析。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body);
  } catch {
    throw new PlannerResponseError("回复不是可解析的 JSON 对象");
  }
}

function parseConstraints(raw: unknown): ConstraintsPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlannerResponseError('itinerary 形态必须带 "constraints" 对象');
  }
  const c = raw as Record<string, unknown>;
  if (!isCalendarDate(c.date)) {
    throw new PlannerResponseError('constraints.date 必须是用户要求的真实出行日期 "YYYY-MM-DD"；用户没给日期请改用 clarify 追问');
  }
  const out: ConstraintsPatch = { date: c.date };
  for (const field of ["availableStart", "availableEnd"] as const) {
    const value = c[field];
    if (value === undefined) continue;
    if (value === null) {
      out[field] = null; // 用户明确放开该时段限制 → 显式清除
      continue;
    }
    if (!isClockTime(value)) {
      throw new PlannerResponseError(`constraints.${field} 必须是真实时钟 "HH:MM"（或 null 表示清除该限制），得到 ${JSON.stringify(value)}`);
    }
    out[field] = value;
  }
  if (isClockTime(out.availableStart) && isClockTime(out.availableEnd) && out.availableStart >= out.availableEnd) {
    throw new PlannerResponseError("constraints.availableStart 必须早于 availableEnd");
  }
  return out;
}

/** 把模型回复文本解析成 PlannerResponse；解析失败抛 PlannerResponseError。 */
export function parsePlannerResponse(text: string): PlannerResponse {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlannerResponseError("回复必须是一个 JSON 对象");
  }
  const type = (raw as Record<string, unknown>).type;
  if (type === "clarify") {
    const q = (raw as Record<string, unknown>).question;
    if (typeof q !== "string" || !q.trim()) {
      throw new PlannerResponseError('clarify 形态必须带非空 "question" 字符串');
    }
    return { type: "clarify", question: q.trim() };
  }
  if (type === "itinerary") {
    const obj = raw as Record<string, unknown>;
    if (!("itinerary" in obj)) {
      throw new PlannerResponseError('itinerary 形态必须带 "itinerary" 行程对象');
    }
    return { type: "itinerary", constraints: parseConstraints(obj.constraints), candidate: obj.itinerary };
  }
  throw new PlannerResponseError('"type" 必须是 "clarify" 或 "itinerary"');
}

/** 从未校验的候选行程里收集 event_id 列表，供 repository.getByIds 批量取详情。 */
export function extractEventIds(candidate: unknown): string[] {
  if (!candidate || typeof candidate !== "object") return [];
  const stops = (candidate as { stops?: unknown }).stops;
  if (!Array.isArray(stops)) return [];
  const ids: string[] = [];
  for (const s of stops) {
    const id = s && typeof s === "object" ? (s as { event_id?: unknown }).event_id : undefined;
    if (typeof id === "string" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
