import type { SessionRepository } from "../../session/repository.ts";
import type { LeaseWriter, Run, ValidatedPlan } from "../../session/types.ts";
import type { PlannerTurn } from "../session.ts";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RunTerminalStatus = "completed" | "failed" | "cancelled";

/**
 * 写 run 终态；失败返回警告文本而不是抛错——租约失效时终态可能写不进，
 * 只如实报告，绝不覆盖新 worker 的数据。cancelled 必须先 requestCancelRun。
 */
export async function settleRun(
  repo: SessionRepository,
  writer: LeaseWriter | undefined,
  userId: string,
  runId: string | undefined,
  status: RunTerminalStatus,
  result: unknown,
  error?: string,
): Promise<string | undefined> {
  if (!runId || !writer) return "run 终态无法写入（会话租约已失效）";
  try {
    if (status === "cancelled") {
      await repo.requestCancelRun(writer, userId, runId);
    }
    const outcome =
      status === "completed"
        ? { status: "completed" as const, result }
        : status === "failed"
          ? { status: "failed" as const, error: error ?? "运行失败" }
          : { status: "cancelled" as const, ...(error !== undefined ? { error } : {}) };
    await repo.finishRun(writer, userId, runId, outcome);
    return undefined;
  } catch (finishError) {
    return `run 终态写入失败：${errorText(finishError)}`;
  }
}

/** 会话内按 run.input.requestId 找既有 run（请求级幂等定位）。 */
export async function findRunByRequestId(
  repo: SessionRepository,
  userId: string,
  sessionId: string,
  requestId: string,
): Promise<Run | undefined> {
  for (const run of await repo.listRunsBySession(userId, sessionId)) {
    try {
      const input = JSON.parse(run.input) as { requestId?: string };
      if (input?.requestId === requestId) return run;
    } catch {
      // 非 JSON 输入（旧数据/非请求 run）不参与幂等判定。
    }
  }
  return undefined;
}

/** run.input 中随 prompt 保存的原始请求文本；非对话输入（如手动压缩）→ undefined。 */
export function requestInputText(run: Run): string | undefined {
  try {
    const input = JSON.parse(run.input) as { text?: unknown };
    return typeof input?.text === "string" ? input.text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * run.input 中随请求快照保存的用户位置坐标；该轮没带 location 或
 * 形状不符 → undefined（继续往更早的 run 找，不是清除）。
 */
export function requestInputLocation(run: Run): { lat: number; lng: number } | undefined {
  try {
    const input = JSON.parse(run.input) as { location?: unknown };
    const location = input?.location;
    if (typeof location !== "object" || location === null) return undefined;
    const { lat, lng } = location as { lat?: unknown; lng?: unknown };
    if (typeof lat !== "number" || !Number.isFinite(lat)) return undefined;
    if (typeof lng !== "number" || !Number.isFinite(lng)) return undefined;
    return { lat, lng };
  } catch {
    return undefined;
  }
}

/** 同 requestId 重放：直接返回既有 run 的结果，不再生成一套新消息。 */
export function replayedTurn(run: Run): PlannerTurn {
  switch (run.status) {
    case "completed": {
      const turn = parseStoredTurn(run.result);
      return turn ?? { kind: "error", message: "相同请求的历史结果无法还原" };
    }
    case "failed":
      return { kind: "error", message: `相同请求已失败：${run.error ?? "未知错误"}` };
    case "cancelled":
      return { kind: "error", message: `相同请求已被取消${run.error ? `：${run.error}` : ""}` };
    default:
      return { kind: "error", message: "相同请求仍在处理中" };
  }
}

function parseStoredTurn(result: string | null): PlannerTurn | undefined {
  if (!result) return undefined;
  try {
    const turn = (JSON.parse(result) as { turn?: PlannerTurn }).turn;
    if (!turn || typeof turn !== "object") return undefined;
    if (turn.kind === "itinerary" && turn.itinerary && turn.constraints) return turn;
    if (
      turn.kind === "comparison" &&
      Array.isArray(turn.plans) &&
      turn.plans.length > 0 &&
      turn.constraints
    ) {
      return turn;
    }
    if (turn.kind === "clarification" && typeof turn.question === "string") return turn;
    if (turn.kind === "error" && typeof turn.message === "string") return turn;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 会话最近一轮产出的 PlannerTurn：倒序找首个 completed 且 result 可解析
 * 为 turn 的 run（run 列表按 (created_at, run_id) 升序传入）；全部失败/
 * 无对话 run → undefined。用于"最近一轮是否为 comparison"等消费判定。
 */
export function latestProducedTurn(runs: Run[]): PlannerTurn | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run.status !== "completed") continue;
    const turn = parseStoredTurn(run.result);
    if (turn !== undefined) return turn;
  }
  return undefined;
}

/**
 * child 会话的"最新候选规划"：本 session 最近一次 completed 且结果为
 * itinerary/comparison 的 run 所记录的 turn（生效约束 + 行程；
 * comparison 取首个 plan）。child 不设正式指针，
 * 候选就是它的工作规划状态；failed/cancelled/追问轮与无法解析的
 * result 一律跳过，不覆盖更早的成功候选。
 * 新旧次序以该 run 已落库消息的最大 message_seq 判定（单调递增，真实
 * 时钟同毫秒也不并列）；无消息记录的 run 兜底按列表靠前者更旧——
 * 列表按 (created_at, run_id) 升序传入，run_id 随机故只做平局次序。
 */
export function latestCandidatePlan(
  runs: Run[],
  seqByRun: ReadonlyMap<string, number>,
): ValidatedPlan | undefined {
  let best: { seq: number; index: number; plan: ValidatedPlan } | undefined;
  runs.forEach((run, index) => {
    if (run.status !== "completed") return;
    const turn = parseStoredTurn(run.result);
    // comparison 轮的候选取首个（active）plan——与 main 指针的提交语义一致。
    const plan =
      turn?.kind === "itinerary"
        ? { constraints: turn.constraints, itinerary: turn.itinerary }
        : turn?.kind === "comparison" && turn.plans[0] !== undefined
          ? { constraints: turn.constraints, itinerary: turn.plans[0].itinerary }
          : undefined;
    if (plan === undefined) return;
    const seq = seqByRun.get(run.runId) ?? -1;
    if (best === undefined || seq > best.seq || (seq === best.seq && index > best.index)) {
      best = { seq, index, plan };
    }
  });
  return best?.plan;
}
