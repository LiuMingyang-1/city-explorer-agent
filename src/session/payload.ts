import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { constraintProblems, isCalendarDate, isClockTime } from "../itinerary/constraints.ts";
import type { PlanningConstraints } from "../itinerary/types.ts";
import {
  SessionRepositoryError,
  type CompactionPayload,
  type MessagePayload,
  type ValidatedPlan,
} from "./types.ts";

/**
 * payload 列的边界校验与序列化。仓库只校验结构合法（含 role 范围、plan
 * schema、compaction 数值边界），不理解压缩语义；语义不变量（through、
 * first_kept、工具批次）在 impl/records.ts 的日志扫描里。
 * message 校验沿用 Rudy src/session/records.ts isMessage 的思路
 * （pi 1.4.0 MIT），去掉 system 角色——system 是运行时配置，不落库。
 */

type Fail = (message: string) => never;
const invalidInput: Fail = (message) => {
  throw new SessionRepositoryError("invalid_payload", message);
};
const corruptData: Fail = (message) => {
  throw new SessionRepositoryError("corrupt", message);
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const show = (value: unknown) => JSON.stringify(value) ?? "undefined";

const ASSISTANT_STOP_REASONS = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** 结构合法的 user/assistant/toolResult 消息；其余 role（system/custom/...）拒收。 */
export function isStorableMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
    return false;
  }
  const role = value.role;
  const content = value.content;
  if (typeof content === "string") return role === "user";
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (!isRecord(part)) return false;
    switch (part.type) {
      case "text":
        if (typeof part.text !== "string") return false;
        break;
      case "image":
        if (role === "assistant" || typeof part.data !== "string" || typeof part.mimeType !== "string")
          return false;
        break;
      case "thinking":
        if (role !== "assistant" || typeof part.thinking !== "string") return false;
        break;
      case "toolCall":
        if (
          role !== "assistant" ||
          typeof part.id !== "string" ||
          part.id.length === 0 ||
          typeof part.name !== "string" ||
          !isRecord(part.arguments)
        )
          return false;
        break;
      default:
        return false;
    }
  }
  switch (role) {
    case "user":
      return true;
    case "toolResult":
      return (
        typeof value.toolCallId === "string" &&
        value.toolCallId.length > 0 &&
        typeof value.toolName === "string" &&
        typeof value.isError === "boolean"
      );
    case "assistant": {
      if (
        typeof value.api !== "string" ||
        typeof value.provider !== "string" ||
        typeof value.model !== "string" ||
        !ASSISTANT_STOP_REASONS.has(String(value.stopReason)) ||
        !isRecord(value.usage) ||
        !isRecord(value.usage.cost)
      )
        return false;
      const usage = value.usage;
      const cost = usage.cost;
      return (
        isRecord(cost) &&
        USAGE_FIELDS.every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key])) &&
        COST_FIELDS.every((key) => typeof cost[key] === "number" && Number.isFinite(cost[key]))
      );
    }
    default:
      return false;
  }
}

/** plan 标注结构校验：constraintProblems + 行程形状（不含活动窗口语义）。 */
export function planProblems(value: unknown): string[] {
  if (!isRecord(value)) return [`plan 必须是包含 constraints/itinerary 的对象，得到 ${show(value)}`];
  const problems: string[] = [];
  const constraints = value.constraints;
  if (!isRecord(constraints)) {
    problems.push(`plan.constraints 必须是对象，得到 ${show(constraints)}`);
  } else {
    problems.push(
      ...constraintProblems(constraints as unknown as PlanningConstraints).map(
        (m) => `plan.${m}`,
      ),
    );
  }
  const itinerary = value.itinerary;
  if (!isRecord(itinerary)) {
    problems.push(`plan.itinerary 必须是对象，得到 ${show(itinerary)}`);
    return problems;
  }
  if (!isCalendarDate(itinerary.date)) {
    problems.push(`plan.itinerary.date 必须是真实日期 "YYYY-MM-DD"，得到 ${show(itinerary.date)}`);
  }
  if (typeof itinerary.summary !== "string") {
    problems.push(`plan.itinerary.summary 必须是字符串，得到 ${show(itinerary.summary)}`);
  }
  if (!Array.isArray(itinerary.stops)) {
    problems.push(`plan.itinerary.stops 必须是数组，得到 ${show(itinerary.stops)}`);
    return problems;
  }
  itinerary.stops.forEach((stop, index) => {
    const where = `plan.itinerary.stops[${index}]`;
    if (!isRecord(stop)) {
      problems.push(`${where} 必须是对象，得到 ${show(stop)}`);
      return;
    }
    if (typeof stop.event_id !== "string" || stop.event_id.length === 0) {
      problems.push(`${where}.event_id 必须是非空字符串，得到 ${show(stop.event_id)}`);
    }
    for (const field of ["arrive_at", "leave_at"] as const) {
      if (!isClockTime(stop[field])) {
        problems.push(`${where}.${field} 必须是 "HH:MM" 时钟时间，得到 ${show(stop[field])}`);
      }
    }
    if (typeof stop.reason !== "string") {
      problems.push(`${where}.reason 必须是字符串，得到 ${show(stop.reason)}`);
    }
    if (
      isClockTime(stop.arrive_at) &&
      isClockTime(stop.leave_at) &&
      (stop.leave_at as string) <= (stop.arrive_at as string)
    ) {
      problems.push(`${where} 的 leave_at 必须晚于 arrive_at`);
    }
  });
  if (
    isCalendarDate(itinerary.date) &&
    isRecord(constraints) &&
    isCalendarDate(constraints.date) &&
    itinerary.date !== constraints.date
  ) {
    problems.push("plan.itinerary.date 与 plan.constraints.date 不一致");
  }
  return problems;
}

function messagePayloadProblems(value: unknown, forbidPlan: boolean): string[] {
  if (!isRecord(value)) return [`message payload 必须是对象，得到 ${show(value)}`];
  const problems: string[] = [];
  if (!isStorableMessage(value.message)) {
    problems.push(
      "payload.message 不是合法的 user/assistant/toolResult 消息（system 等其余 role 不落库）",
    );
  }
  if (value.plan !== undefined) {
    if (forbidPlan) {
      problems.push("payload.plan 不允许在追加时携带，只能经 commitValidatedPlan 附加");
    } else {
      problems.push(...planProblems(value.plan));
    }
  }
  return problems;
}

function compactionPayloadProblems(value: unknown): string[] {
  if (!isRecord(value)) return [`compaction payload 必须是对象，得到 ${show(value)}`];
  const problems: string[] = [];
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    problems.push(`summary 必须是非空字符串，得到 ${show(value.summary)}`);
  }
  for (const field of ["source_through_message_seq", "first_kept_message_seq"] as const) {
    const seq = value[field];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
      problems.push(`${field} 必须是 >=1 的整数，得到 ${show(seq)}`);
    }
  }
  for (const field of ["tokens_before", "tokens_after"] as const) {
    const tokens = value[field];
    if (tokens !== undefined && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)) {
      problems.push(`${field} 必须是非负数值，得到 ${show(tokens)}`);
    }
  }
  if (value.model_ref !== undefined && typeof value.model_ref !== "string") {
    problems.push(`model_ref 必须是字符串，得到 ${show(value.model_ref)}`);
  }
  return problems;
}

function parseJson(json: string, context: string, fail: Fail): unknown {
  try {
    return JSON.parse(json);
  } catch {
    fail(`${context} 不是合法 JSON`);
  }
}

function assertNoProblems(problems: string[], context: string, fail: Fail): void {
  if (problems.length > 0) fail(`${context} 非法：${problems.join("；")}`);
}

/** 追加输入校验 + 序列化；plan 只能经 commitValidatedPlan 附加，这里拒绝。 */
export function serializeMessagePayload(payload: MessagePayload): string {
  assertNoProblems(messagePayloadProblems(payload, true), "message payload", invalidInput);
  return JSON.stringify({ message: payload.message });
}

/** 读取已存记录：parse + 边界校验，非法即 corrupt（调用方传记录上下文）。 */
export function parseStoredMessagePayload(json: string, context: string): MessagePayload {
  const value = parseJson(json, context, corruptData);
  assertNoProblems(messagePayloadProblems(value, false), context, corruptData);
  return value as MessagePayload;
}

export function serializeCompactionPayload(payload: CompactionPayload): string {
  assertNoProblems(compactionPayloadProblems(payload), "compaction payload", invalidInput);
  return JSON.stringify(payload);
}

export function parseStoredCompactionPayload(json: string, context: string): CompactionPayload {
  const value = parseJson(json, context, corruptData);
  assertNoProblems(compactionPayloadProblems(value), context, corruptData);
  return value as CompactionPayload;
}

/** commitValidatedPlan 的入参校验。 */
export function assertValidPlan(plan: unknown): asserts plan is ValidatedPlan {
  assertNoProblems(planProblems(plan), "plan", invalidInput);
}

/** 已存 payload.plan 的校验。 */
export function parseStoredPlan(value: unknown, context: string): ValidatedPlan {
  assertNoProblems(planProblems(value), context, corruptData);
  return value as ValidatedPlan;
}

/**
 * dedupe 幂等判定的规范化 JSON：对象键排序、丢弃 undefined，
 * 使语义等价的 payload 得到同一字符串。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const body = Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** assistant 消息里出现的 toolCall id 列表。 */
export function toolCallIds(message: AgentMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter(
      (part): part is ToolCall =>
        isRecord(part) && part.type === "toolCall" && typeof part.id === "string",
    )
    .map((part) => part.id);
}

/**
 * “成功”的 assistant 消息：完成生成（stop/toolUse/length）且无 errorMessage。
 * pending/deferred/error/aborted 都不算成功，plan 只标注成功回复。
 */
export function isSuccessfulAssistant(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "stop" ||
      message.stopReason === "toolUse" ||
      message.stopReason === "length") &&
    message.errorMessage === undefined
  );
}
