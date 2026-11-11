import type { PlannerTurn, ToolCallRecord } from "../agent/session.ts";

/** 主循环需要的最小会话接口；PlannerSession 天然满足，测试可注入 fake。 */
export interface PlannerLike {
  prompt(text: string): Promise<PlannerTurn>;
  /** 已发生的工具调用（按时间顺序）；每轮结束后增量打到 stderr。 */
  readonly toolCalls: readonly ToolCallRecord[];
}

/** 输出隔离：out → stdout（每轮一个 JSON），err → stderr（提示/轨迹/错误）。 */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** 交互模式一轮结束后重显输入提示；批处理/单轮模式可省略。 */
  afterTurn?(): void;
}

const EXIT_WORDS = new Set(["exit", "quit", "退出"]);

function traceLine(call: ToolCallRecord): string {
  const ms = call.durationMs !== undefined ? ` ${call.durationMs}ms` : "";
  const status = call.isError ? "error" : "ok";
  return `[tool] ${call.toolName} ${JSON.stringify(call.args ?? {})} -> ${status}${ms}`;
}

/**
 * 逐行处理自然语言输入：await 上一轮结束才读下一行（批处理验收需要严格顺序）。
 * 行程 → stdout 单行 JSON；追问 → stdout {"question":...}；错误 → stderr。
 * 输入 exit/quit/退出 提前结束；输入耗尽（EOF）正常结束。
 */
export async function runTurns(
  planner: PlannerLike,
  lines: AsyncIterable<string> | Iterable<string>,
  io: CliIO,
): Promise<void> {
  let traced = 0;
  for await (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    if (EXIT_WORDS.has(text.toLowerCase())) break;
    const turn = await planner.prompt(text);
    for (; traced < planner.toolCalls.length; traced++) {
      io.err(traceLine(planner.toolCalls[traced]));
    }
    if (turn.kind === "itinerary") {
      io.out(JSON.stringify(turn.itinerary));
    } else if (turn.kind === "clarification") {
      io.out(JSON.stringify({ question: turn.question }));
    } else {
      io.err(`[error] ${turn.message}`);
    }
    io.afterTurn?.();
  }
}
