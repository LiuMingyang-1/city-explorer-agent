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
 *   child_run_status 为发射瞬间子 run 的 DB 状态快照（如实抄录，竞态下
 *   可为非终态，不做 running→终态伪装或追帧）——父取消/子超时按真实
 *   落库结果区分，不凭主观猜测。
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
  /** 子会话 stage 不透传（本轮私有叙事），父流中实际不出现盖章 stage 帧；
   *  字段仅为联合判别一致性保留。父会话原生事件恒省略。 */
  subagent_id?: string;
}

/** 子任务派发终态：与回传父模型的 DelegateTaskDetails.status 同枚同义。 */
export type SubagentDoneStatus = "completed" | "failed" | "cancelled";

/**
 * 一个真实地理位置点（恒 GCJ-02，与 events 表/EventView 同源）：
 * search_events 的命中候选（tool_call.candidates）与子任务终局站点
 * （subagent_done.stops）共用形状；event_id 即 EventView.event_id，
 * 供前端与最终 result 的采纳站点做真实 id 比对。
 */
export interface ProgressPoint {
  event_id: string;
  latitude: number;
  longitude: number;
}

/** tool_call.candidates 单次透出上限（search_events 命中可至 100，只透前 16）。 */
export const PROGRESS_CANDIDATE_LIMIT = 16;
/** subagent_done.stops 透出上限（实际行程站点 ≤10，留足防御余量）。 */
export const PROGRESS_STOP_LIMIT = 24;
/**
 * event_id 字符数上限：真实 id 为短串（evt_…）；超出视为损坏数据
 * **整条跳过**——绝不截断：截断后的 id 会把候选点错认成另一条活动。
 */
export const PROGRESS_POINT_ID_MAX = 256;
/**
 * candidates/stops 数组的 JSON 字节预算（UTF-8）：极端长真实 id 也不突破
 * 单帧增量。与条数上限独立兜底——条数先到先截断，字节先到同样截断。
 */
export const PROGRESS_POINTS_BYTE_LIMIT = 8192;

const pointsEncoder = new TextEncoder();

/**
 * 原始点位 → 有界清单：逐项校验真实身份与坐标（非空/≤ID_MAX 字符串 id、
 * 有限数且 |lat|≤90、|lng|≤180），按原序去重；条数与 JSON 字节双上限，
 * 任一先到即截断。不造点、不改值——缺哪项如实跳哪项。
 */
function boundedPoints(
  raw: Iterable<{
    event_id?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  }>,
  limit: number,
): ProgressPoint[] {
  const out: ProgressPoint[] = [];
  const seen = new Set<string>();
  let bytes = 2; // "[" + "]"
  for (const entry of raw) {
    if (out.length >= limit) break;
    const id = typeof entry.event_id === "string" ? entry.event_id : "";
    if (id === "" || [...id].length > PROGRESS_POINT_ID_MAX || seen.has(id)) continue;
    const lat = entry.latitude;
    const lng = entry.longitude;
    if (typeof lat !== "number" || !Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (typeof lng !== "number" || !Number.isFinite(lng) || Math.abs(lng) > 180) continue;
    const point: ProgressPoint = { event_id: id, latitude: lat, longitude: lng };
    const cost = pointsEncoder.encode(JSON.stringify(point)).length + 1; // 含分隔逗号
    if (bytes + cost > PROGRESS_POINTS_BYTE_LIMIT) break;
    seen.add(id);
    out.push(point);
    bytes += cost;
  }
  return out;
}

/**
 * search_events 成功结果 → 真实命中候选：只认 structuredContent.events
 * （工具真实产出，content 文本不解析、args_summary 的 near= 只作查询中心
 * 不冒充候选）。提取不出 → 空表（调用方据此省略整个字段）。
 */
function searchCandidates(result: unknown): ProgressPoint[] {
  const structured =
    result !== null && typeof result === "object"
      ? (result as { structuredContent?: unknown }).structuredContent
      : undefined;
  const events =
    structured !== null && typeof structured === "object"
      ? (structured as { events?: unknown }).events
      : undefined;
  if (!Array.isArray(events)) return [];
  return boundedPoints(
    events.map((e) => {
      const o = (e !== null && typeof e === "object" ? e : {}) as Record<string, unknown>;
      // Event.id → wire event_id（与 EventView/stops 同键名，供前端真实 id 比对）。
      return { event_id: o.id, latitude: o.latitude, longitude: o.longitude };
    }),
    PROGRESS_CANDIDATE_LIMIT,
  );
}

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

/** 终局点发射：分身退场；status 与回传父模型的结果同源，
 *  child_run_* 为发射瞬间子 run 的 DB 状态快照。 */
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
  /** completed+itinerary 时按行程站序透出的真实站点（GCJ-02，≤24、
   *  id 去重）；failed/cancelled/clarification 恒省略。 */
  stops?: ProgressPoint[];
  /** 子任务标题（与 spawned.title 同源必填，≤40 码点）：前端按 title 归属 done。 */
  title: string;
  /** 单行摘要：行程 summary / 追问问题 / 失败或取消原因（≤160 码点）。 */
  summary: string;
  /** 子会话本次派发的 run ID（查无则 null）。 */
  child_run_id: string | null;
  /** 发射瞬间子 run 的 DB 状态快照（如实抄录，查无则 null；
   *  竞态下可为 running 等非终态，消费者不得据此猜测已终结）。 */
  child_run_status: RunStatus | null;
  message: string;
}

/**
 * 单次工具执行结束即发射：#42 思考轨迹面板的工具节点（tool_call_id/subagent_id
 * 归属）与 #43 检索涟漪（args_summary/result_count）同源的真实事件源。
 */
export interface ToolCallEvent {
  type: "tool_call";
  /** Pi agent 的本次调用 ID（tool_execution_start/end 配对键，会话内唯一）。 */
  tool_call_id: string;
  /** 工具名（search_events/delegate_task/estimate_travel/web_search…）。 */
  name: string;
  /** 参数白名单单行摘要（≤160 码点；不回传完整入参）。 */
  args_summary: string;
  /** 命中/产出条目数：按真实 details 语义推导（见 toolResultCount），
   *  推导不出为 null——绝不虚构命中数。 */
  result_count: number | null;
  status: "completed" | "error";
  /** execute 耗时（单调时钟毫秒）；工具未运行时缺省。 */
  duration_ms?: number;
  /** 源自被派发子会话时盖章为 child sessionId；父会话原生事件省略。 */
  subagent_id?: string;
  /** 仅 search_events 成功时透出：structuredContent.events 的真实命中
   *  候选（GCJ-02，≤16、id 去重）；其余工具/error/提取不出恒省略。 */
  candidates?: ProgressPoint[];
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
 * travel-tool.ts / web-search.ts / delegate.ts 的参数 schema 对应。
 * 未知工具不透原参（模型产出可能夹带未预期的敏感字段，键名/值都不回传），
 * 只报参数项数；也不走 JSON.stringify——循环引用/BigInt 会抛，观察路径
 * 必须不抛。
 */
export function summarizeToolArgs(toolName: string, args: unknown): string {
  const a = (args !== null && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
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
      // 安全默认：只报参数项数（标量入参按 1 计），不透键名与值。
      try {
        const count =
          args !== null && typeof args === "object"
            ? Object.keys(a).length
            : args === undefined || args === null
              ? 0
              : 1;
        return clipText(`${count} 项参数`);
      } catch {
        return "";
      }
  }
}

/**
 * tool_execution_end.result（AgentToolResult）→ 命中/产出条目数：按真实
 * details 语义推导——details.count 为有限数直接用（search_events）；其次按
 * 工具已知结果形态（web_search 的 results[]、delegate_task 的
 * itinerary.stops[]）取真实长度；语义不明或缺 details → null，不凑假命中数。
 */
export function toolResultCount(toolName: string, result: unknown): number | null {
  const details =
    result !== null && typeof result === "object"
      ? (result as { details?: unknown }).details
      : undefined;
  if (details === null || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if (typeof d.count === "number" && Number.isFinite(d.count)) return d.count;
  switch (toolName) {
    case "web_search":
      return Array.isArray(d.results) ? d.results.length : null;
    case "delegate_task": {
      const stops = (d.itinerary as { stops?: unknown } | undefined)?.stops;
      return Array.isArray(stops) ? stops.length : null;
    }
    default:
      return null;
  }
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
  const resultCount = input.isError ? null : toolResultCount(input.name, input.result);
  // 仅成功 search_events 透真实候选；其余工具与 error 帧一律省略字段。
  const candidates =
    !input.isError && input.name === "search_events"
      ? searchCandidates(input.result)
      : [];
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
    ...(candidates.length > 0 ? { candidates } : {}),
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

/** 派发终了 → subagent_done 事件；status/summary 由调用方按真实结果填入，
 *  title 必填（与 spawned 同源：入参 title 缺省取 task 裁剪，≤40 码点）。
 *  stops 仅 completed+itinerary 透出（真实 eventsById 行程序站点）——
 *  终态 gate 在 builder 内把关：close 降级/取消后 stops 入参即便存在
 *  也随最终 status 一起省略，绝不漏进失败帧。 */
export function subagentDoneEvent(input: {
  subagentId: string;
  planId: string | null;
  status: SubagentDoneStatus;
  kind?: "itinerary" | "clarification";
  stopsCount?: number | null;
  /** 真实站点原始值（行程序、GCJ-02）；builder 再做校验/去重/有界截断。 */
  stops?: { event_id: string; latitude: number; longitude: number }[];
  title: string;
  summary: string;
  childRunId: string | null;
  childRunStatus?: RunStatus | null;
}): SubagentDoneEvent {
  const summary = clipText(input.summary);
  const title = clipText(input.title, 40);
  const stopsCount = input.stopsCount ?? null;
  const stops =
    input.status === "completed" && input.kind === "itinerary" && input.stops !== undefined
      ? boundedPoints(input.stops, PROGRESS_STOP_LIMIT)
      : [];
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
    ...(stops.length > 0 ? { stops } : {}),
    title,
    summary,
    child_run_id: input.childRunId,
    child_run_status: input.childRunStatus ?? null,
    message: clipText(message),
  };
}

/**
 * 子会话透传盖章：child 内部实体级事件（tool_call；stage 属本轮私有叙事
 * 不透传也不盖章）经 dispatch 上下文转发到父 sink 时标上其 subagent_id
 * （= child sessionId），父会话原生事件不带此字段。
 * 多层派发下事件可能已带更深层归属（孙会话 ID）——保留原值不篡改，
 * 只给未归属的 tool_call 补盖当前 child id；消费端据此把事件精确归属
 * 到产生它的那一层会话。
 */
export function stampSubagent(
  event: PlannerProcessEvent,
  subagentId: string,
): PlannerProcessEvent {
  if (event.type === "stage" || event.type === undefined) return event;
  if (event.subagent_id !== undefined) return event;
  return { ...event, subagent_id: subagentId };
}
