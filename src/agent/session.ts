import { Agent } from "@earendil-works/pi-agent-core";
import type { EventRepository } from "../data/repository.ts";
import type { Event } from "../data/types.ts";
import { mergeConstraints } from "../itinerary/constraints.ts";
import type { Itinerary, PlanningConstraints } from "../itinerary/types.ts";
import { validateItinerary } from "../itinerary/validation.ts";
import type { ValidationIssue, ValidationResult } from "../itinerary/validation.ts";
import { createExplorerAgent } from "./explorer-agent.ts";
import type { ExplorerAgentOptions } from "./explorer-agent.ts";
import {
  extractEventIds,
  lastAssistantText,
  parsePlannerResponse,
  PlannerResponseError,
} from "./response.ts";

/** 一轮规划的结果：新行程 / 追问 / 失败（当前行程不变）。 */
export type PlannerTurn =
  | { kind: "itinerary"; itinerary: Itinerary; constraints: PlanningConstraints }
  | { kind: "clarification"; question: string }
  | { kind: "error"; message: string };

/** 一次工具执行记录；真实工具链经 Agent 事件流记下，可供 CLI/测试检查。 */
export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  isError: boolean;
  durationMs?: number;
}

export interface PlannerSessionOptions {
  agent: Agent;
  repository: EventRepository;
  /** 校验函数，缺省为 src/itinerary/validation.ts 的 validateItinerary（测试可注入）。 */
  validate?: (
    candidate: unknown,
    constraints: PlanningConstraints,
    events: Map<string, Event>,
  ) => ValidationResult;
  /** 校验/格式失败后的纠正轮上限；默认 2，防无界重试。 */
  maxCorrections?: number;
}

function issuesText(issues: ValidationIssue[]): string {
  return issues.map((i) => `- [${i.code}] ${i.event_id ? `${i.event_id}: ` : ""}${i.message}`).join("\n");
}

/**
 * 进程内规划会话：包着 Pi Agent，代 CLI 做"自然语言进 → 行程 JSON 出"。
 * 历史与当前行程都在 Agent transcript + 本对象里，退出即结束。
 * 每轮：prompt → 解析 envelope → clarify 直接回传追问；
 * itinerary 则把模型上报的约束补丁合并到已确认约束（缺省字段沿用、
 * null 显式清除、显式值覆盖），取活动详情、跑 validateItinerary，
 * **只通过才更新当前行程与已确认约束**。
 * 失败时把原需求、生效约束和问题回喂给模型纠正，最多 maxCorrections 轮。
 */
export class PlannerSession {
  /** 已发生的工具调用链（含参数与成败），按时间顺序。 */
  readonly toolCalls: ToolCallRecord[] = [];
  private readonly options: PlannerSessionOptions;
  private current?: Itinerary;
  private confirmed?: PlanningConstraints;
  private readonly validate: NonNullable<PlannerSessionOptions["validate"]>;
  private readonly maxCorrections: number;

  constructor(options: PlannerSessionOptions) {
    this.options = options;
    this.validate = options.validate ?? validateItinerary;
    this.maxCorrections = options.maxCorrections ?? 2;
    const pending = new Map<string, { toolName: string; args: unknown }>();
    options.agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        pending.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        const start = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        this.toolCalls.push({
          toolName: event.toolName,
          args: start?.args,
          isError: event.isError,
          durationMs: event.durationMs,
        });
      }
    });
  }

  /** 当前已确认的行程（未通过校验的输出不会污染它）。 */
  get itinerary(): Itinerary | undefined {
    return this.current;
  }

  /** 当前已确认的用户约束（同上，只在校验通过时更新）。 */
  get constraints(): PlanningConstraints | undefined {
    return this.confirmed;
  }

  /** 送一轮自然语言给 Agent，返回 PlannerTurn。 */
  async prompt(text: string): Promise<PlannerTurn> {
    let outgoing = text;
    let lastError = "没有得到可用回复";
    for (let attempt = 0; attempt <= this.maxCorrections; attempt++) {
      const reply = await this.ask(outgoing);
      if (reply.error !== undefined || reply.text === undefined) {
        return { kind: "error", message: reply.error ?? "模型没有给出回复" };
      }
      try {
        const parsed = parsePlannerResponse(reply.text);
        if (parsed.type === "clarify") {
          return { kind: "clarification", question: parsed.question };
        }
        // 补丁合并到已确认约束：纠正回复漏带字段不会放宽已确认的限制。
        const effective = mergeConstraints(this.confirmed, parsed.constraints);
        const events = await this.options.repository.getByIds(extractEventIds(parsed.candidate));
        const result = this.validate(parsed.candidate, effective, events);
        if (result.ok && result.itinerary) {
          this.current = result.itinerary;
          this.confirmed = effective;
          return { kind: "itinerary", itinerary: result.itinerary, constraints: effective };
        }
        lastError = `行程未通过校验：${result.issues.map((i) => i.message).join("；") || "未知问题"}`;
        outgoing =
          `用户的原始要求："${text}"\n` +
          "上一版行程未通过校验：\n" +
          issuesText(result.issues) +
          `\n当前生效约束：${JSON.stringify(effective)}\n` +
          "请按原始要求和生效约束修正，重新输出完整的 itinerary JSON（保留 type/constraints/itinerary 结构，constraints 填当前生效约束）。";
      } catch (error) {
        lastError =
          error instanceof PlannerResponseError
            ? `回复格式不符：${error.message}`
            : `处理回复时出错：${error instanceof Error ? error.message : String(error)}`;
        outgoing =
          `用户的原始要求："${text}"\n` +
          `你的回复不符合输出契约（${lastError}）。请重新只输出一个约定的 JSON 对象。`;
      }
    }
    return { kind: "error", message: lastError };
  }

  /** 单轮请求：prompt() 不 reject 模型错误，改查 state/末条消息。 */
  private async ask(text: string): Promise<{ text?: string; error?: string }> {
    const { agent } = this.options;
    if (agent.state.isStreaming) {
      return { error: "Agent 正在处理上一轮；等它结束或用 steer()/followUp()。" };
    }
    try {
      await agent.prompt(text);
    } catch (error) {
      return { error: `prompt 失败：${error instanceof Error ? error.message : String(error)}` };
    }
    const messages = agent.state.messages;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") {
      return { error: agent.state.errorMessage ?? "模型没有给出回复" };
    }
    if (last.stopReason === "error" || last.stopReason === "aborted") {
      return { error: last.errorMessage ?? agent.state.errorMessage ?? "模型请求失败" };
    }
    const reply = lastAssistantText(messages);
    if (reply === undefined) return { error: "模型回复为空" };
    return { text: reply };
  }
}

/**
 * 一步到位：建 Agent + PlannerSession。CLI 只需拿这个对象循环 prompt()。
 * repository 由调用方创建并负责 close()。
 */
export async function createPlanner(
  options: ExplorerAgentOptions & Omit<PlannerSessionOptions, "agent" | "repository">,
): Promise<PlannerSession> {
  const agent = await createExplorerAgent(options);
  return new PlannerSession({
    agent,
    repository: options.repository,
    validate: options.validate,
    maxCorrections: options.maxCorrections,
  });
}
