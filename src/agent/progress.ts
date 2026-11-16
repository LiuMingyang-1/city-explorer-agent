/**
 * 规划过程事件契约（issue #39 骨架，docs/issue-39/coordination.md 有完整说明）。
 *
 * 一轮规划对外透出的全部真实过程事件统一为 PlannerProcessEvent 联合，
 * 经 SSE `progress` 帧直发前端（单一通道、天然保序）：
 *
 * - 既有 4 个 stage 事件（PlannerProgress）：wire 形状恒为
 *   {stage,message,plan_ids}——不带 type 键，字节级向后兼容，旧前端文案
 *   与既有测试断言不受影响；消费端用 `event.type ?? "stage"` 归一判别。
 * - 新事件均带 type 判别键 + message 单行文案：旧前端逐帧覆盖展示
 *   progress.message，故 message 必须恒非空——事件一律经本文件 builders
 *   构造，禁止手写对象绕过（旧前端兼容硬约定见 coordination.md §1）。
 *
 * 边界约定：
 * - 所有文本字段（title/task_summary/args_summary/summary/message）经
 *   clipText 裁剪成单行 ≤PROGRESS_TEXT_LIMIT 码点——SSE 帧恒单行，
 *   控制字符/换行一律压平。
 * - 事件只透摘要：args_summary 为参数白名单单行、result_count 为命中数；
 *   不回传完整工具入参/结果（帧大小与信息面都需控制）。
 * - 终态一致性：subagent_done.status 即回传父模型的 DelegateTaskDetails.status；
 *   child_run_status 如实抄录子 run 持久化终态——父取消/子超时按真实落库
 *   结果区分，不凭主观猜测。
 * - sink 是观察者：safeEmit 吞掉回调异常，进度透出绝不拖垮规划主链路。
 */

import type { RunStatus } from "../session/types.ts";

/**
 * 既有阶段枚举（语义不变）：由工具执行事件与校验时机推导——
 * search_events → searching_events、delegate_task → exploring_plans、
 * 校验/纠正 → validating_schedule、legs 算路 → routing（service 装配点）。
 */
export type PlannerProgressStage =
  | "searching_events"
  | "exploring_plans"
  | "routing"
  | "validating_schedule";

/** 过程事件文本字段统一裁剪上限（码点）；与旧前端气泡的 160 截断对齐。 */
export const PROGRESS_TEXT_LIMIT = 160;

/**
 * 既有 stage 进度事件：保持旧 wire 形状（无 type 键）。
 * type 声明为可选的 "stage" 仅为联合判别与文档化——发射端一律省略；
 * 若将来在 wire 上补发 type:"stage" 同样合法（消费端按 ?? "stage" 归一）。
 */
export interface PlannerProgress {
  /** 判别字段：恒省略以保持旧帧字节级不变。 */
  type?: "stage";
  stage: PlannerProgressStage;
  message: string;
  plan_ids: string[];
  /** 源自被派发子会话时盖章为 child sessionId；父会话原生事件省略。 */
  subagent_id?: string;
}

/** 子任务派发终态：与回传父模型的 DelegateTaskDetails.status 同枚同义。 */
export type SubagentDoneStatus = "completed" | "failed" | "cancelled";

/** 子会话创建成功即发射：分身入场，含 title 供前端气泡/分身头顶展示。 */
export interface SubagentSpawnedEvent {
  type: "subagent_spawned";
  /** 子会话 ID（createChildSession 落库即得；同轮唯一，done/tool_call 据此关联）。 */
  subagent_id: string;
  /** 父轮按 delegate_task 派发序分配的方案标号（"A"/"B"…）；取不到为 null。 */
  plan_id: string | null;
  /** 父会话当前 run ID（run 树的父指针，与 runs.parent_run_id 一致）。 */
  parent_run_id: string;
  /** 子任务标题：入参 title，缺省取 task 裁剪（≤40 码点）。 */
  title: string;
  /** 自包含子任务说明的单行裁剪版（≤160 码点）。 */
  task_summary: string;
  message: string;
}

/** 派发终了即发射：分身退场；终态与回传父模型的结果及持久化子 run 一致。 */
export interface SubagentDoneEvent {
  type: "subagent_done";
  subagent_id: string;
  plan_id: string | null;
  /** 派发终态（父视角）：与 DelegateTaskDetails.status 一致——completed/failed/cancelled。 */
  status: SubagentDoneStatus;
  /** completed 时的产出形态；非 completed 省略。 */
  kind?: "itinerary" | "clarification";
  /** completed+itinerary 时为站点数；其余情形 null。 */
  stops_count: number | null;
  /** 单行摘要：行程 summary / 追问问题 / 失败或取消原因（≤160 码点）。 */
  summary: string;
  /** 子会话本次派发的 run ID（查无则 null）。 */
  child_run_id: string | null;
  /** 子 run 持久化终态（DB 权威；查无则 null）。 */
  child_run_status: RunStatus | null;
  message: string;
}

/** 单次工具执行结束即发射：检索涟漪与工具统计的事件源。 */
export interface ToolCallEvent {
  type: "tool_call";
  /** Pi agent 的本次调用 ID（tool_execution_start/end 配对键，会话内唯一）。 */
  tool_call_id: string;
  /** 工具名（search_events/delegate_task/estimate_travel/web_search…）。 */
  name: string;
  /** 参数白名单单行摘要（≤160 码点；不回传完整入参）。 */
  args_summary: string;
  /** 命中/产出条目数：结果 details.count 为有限数时透出，其余 null。 */
  result_count: number | null;
  status: "completed" | "error";
  /** execute 耗时（单调时钟毫秒）；工具未运行时缺省。 */
  duration_ms?: number;
  /** 源自被派发子会话时盖章为 child sessionId；父会话原生事件省略。 */
  subagent_id?: string;
  message: string;
}

/** 过程事件联合；经 ProgressSink/SSE progress 帧透出。 */
export type PlannerProcessEvent =
  | PlannerProgress
  | SubagentSpawnedEvent
  | SubagentDoneEvent
  | ToolCallEvent;

/** 过程事件观察回调：轮内可多次同步触发；异常由 safeEmit 吞掉。 */
export type ProgressSink = (event: PlannerProcessEvent) => void;

/**
 * 单行裁剪：压平换行/制表/多余空白为单空格，按码点截断并补 "…"
 * （总长 ≤max，绝不切碎 surrogate pair）。SSE data 必须单行。
 */
export function clipText(text: string, max = PROGRESS_TEXT_LIMIT): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/** 各阶段对外文案；exploring_plans 按已派发方案动态拼（自 session.ts 迁入，文案不变）。 */
export function stageMessage(stage: PlannerProgressStage, planIds: string[]): string {
  switch (stage) {
    case "searching_events":
      return "正在检索活动";
    case "exploring_plans": {
      const names = planIds.map((id) => `方案 ${id}`);
      return names.length > 1
        ? `正在并行探路${names.join(" 与")}`
        : `正在探路${names[0] ?? "候选方案"}`;
    }
    case "routing":
      return "正在获取站间道路路线";
    case "validating_schedule":
      return "正在校验路线时间";
  }
}

/** stage 事件构造：message 由 stageMessage 推导；plan_ids 拷贝防外部改共享数组。 */
export function stageProgress(
  stage: PlannerProgressStage,
  planIds: readonly string[],
): PlannerProgress {
  return { stage, message: stageMessage(stage, [...planIds]), plan_ids: [...planIds] };
}

/** 观察发射：sink 缺省空转；回调抛错吞掉——进度透出是观察者，不得影响业务。 */
export function safeEmit(sink: ProgressSink | undefined, event: PlannerProcessEvent): void {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    // 观察回调抛错不拖垮本轮规划。
  }
}

/**
 * 工具入参 → 单行摘要（白名单字段，≤160 码点）：键名与 tools.ts /
 * travel-tool.ts / web-search.ts / delegate.ts 的参数 schema 对应；
 * 未知工具退化为整参 JSON 裁剪——参数均为模型产出标量，不含密钥，
 * 但仍经 clipText 控制帧大小。
 */
export function summarizeToolArgs(toolName: string, args: unknown): string {
  if (args === null || typeof args !== "object") {
    return clipText(args === undefined || args === null ? "" : String(args));
  }
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "search_events": {
      const near = a.near as { lat?: unknown; lng?: unknown } | undefined;
      const parts = [
        typeof a.recordType === "string" ? a.recordType : "",
        typeof a.date === "string" ? `date=${a.date}` : "",
        typeof a.category === "string" ? `类别=${a.category}` : "",
        typeof a.keyword === "string" ? `词=${a.keyword}` : "",
        near && typeof near.lat === "number" && typeof near.lng === "number"
          ? `near=${near.lat.toFixed(4)},${near.lng.toFixed(4)}`
          : "",
        typeof a.radiusKm === "number" ? `${a.radiusKm}km内` : "",
      ].filter((p) => p !== "");
      return clipText(parts.join(" ") || "全部活动");
    }
    case "delegate_task":
      return clipText(
        typeof a.title === "string" && a.title.trim() !== ""
          ? a.title
          : typeof a.task === "string"
            ? a.task
            : "",
      );
    case "estimate_travel":
      return clipText(
        `${typeof a.from_event_id === "string" ? a.from_event_id : "?"}→` +
          `${typeof a.to_event_id === "string" ? a.to_event_id : "?"}` +
          `${typeof a.mode === "string" ? ` ${a.mode}` : ""}`,
      );
    case "web_search":
      return clipText(`query=${typeof a.query === "string" ? a.query : ""}`);
    default:
      return clipText(JSON.stringify(args) ?? "");
  }
}

/** tool_execution_end.result（AgentToolResult）→ 命中数：仅 details.count 为有限数时透出。 */
export function toolResultCount(result: unknown): number | null {
  if (result === null || typeof result !== "object") return null;
  const count = (result as { details?: { count?: unknown } }).details?.count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

/** tool_execution_end → tool_call 事件（args 由对应的 start 事件捕获传入）。 */
export function toolCallEvent(input: {
  toolCallId: string;
  name: string;
  args: unknown;
  result?: unknown;
  isError: boolean;
  durationMs?: number;
  subagentId?: string;
}): ToolCallEvent {
  const argsSummary = summarizeToolArgs(input.name, input.args);
  const resultCount = input.isError ? null : toolResultCount(input.result);
  const message = input.isError
    ? `${input.name} 失败`
    : `${input.name}${argsSummary !== "" ? ` ${argsSummary}` : ""}` +
      `${resultCount !== null ? `：${resultCount} 条` : ""}`;
  return {
    type: "tool_call",
    tool_call_id: input.toolCallId,
    name: input.name,
    args_summary: argsSummary,
    result_count: resultCount,
    status: input.isError ? "error" : "completed",
    ...(input.durationMs !== undefined ? { duration_ms: Math.round(input.durationMs) } : {}),
    ...(input.subagentId !== undefined ? { subagent_id: input.subagentId } : {}),
    message: clipText(message),
  };
}

/** createChildSession 成功 → subagent_spawned 事件。 */
export function subagentSpawnedEvent(input: {
  subagentId: string;
  planId: string | null;
  parentRunId: string;
  title?: string;
  task: string;
}): SubagentSpawnedEvent {
  const title = clipText(input.title?.trim() || input.task, 40);
  return {
    type: "subagent_spawned",
    subagent_id: input.subagentId,
    plan_id: input.planId,
    parent_run_id: input.parentRunId,
    title,
    task_summary: clipText(input.task),
    message: clipText(`正在派发子任务「${title}」`),
  };
}

/** 派发终了 → subagent_done 事件；status/summary 由调用方按真实结果填入。 */
export function subagentDoneEvent(input: {
  subagentId: string;
  planId: string | null;
  status: SubagentDoneStatus;
  kind?: "itinerary" | "clarification";
  stopsCount?: number | null;
  summary: string;
  childRunId: string | null;
  childRunStatus?: RunStatus | null;
}): SubagentDoneEvent {
  const summary = clipText(input.summary);
  const stopsCount = input.stopsCount ?? null;
  const message =
    input.status === "completed"
      ? `子任务完成${stopsCount !== null ? `：${stopsCount} 站` : ""}${
          summary !== "" ? ` ${summary}` : ""
        }`
      : input.status === "cancelled"
        ? `子任务已取消${summary !== "" ? `（${summary}）` : ""}`
        : `子任务失败${summary !== "" ? `：${summary}` : ""}`;
  return {
    type: "subagent_done",
    subagent_id: input.subagentId,
    plan_id: input.planId,
    status: input.status,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    stops_count: stopsCount,
    summary,
    child_run_id: input.childRunId,
    child_run_status: input.childRunStatus ?? null,
    message: clipText(message),
  };
}

/**
 * 子会话透传盖章：child 内部事件（stage/tool_call）经 dispatch 上下文
 * 转发到父 sink 时标上其 subagent_id（= child sessionId），父会话原生
 * 事件不带此字段。消费端据此归属事件来源。
 */
export function stampSubagent(
  event: PlannerProcessEvent,
  subagentId: string,
): PlannerProcessEvent {
  return { ...event, subagent_id: subagentId };
}
