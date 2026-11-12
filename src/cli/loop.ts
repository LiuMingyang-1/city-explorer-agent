import type {
  PlannerCompactOutcome,
  PlannerPromptOptions,
  PlannerTurn,
  ToolCallRecord,
} from "../agent/session.ts";

/** 主循环需要的最小会话接口；PlannerSession 天然满足，测试可注入 fake。 */
export interface PlannerLike {
  prompt(text: string, options?: PlannerPromptOptions): Promise<PlannerTurn>;
  /** 已发生的工具调用（按时间顺序）；每轮结束后增量打到 stderr。 */
  readonly toolCalls: readonly ToolCallRecord[];
  /** 持久会话才有：手动压缩上下文；缺省时 /compact 提示不支持。 */
  compact?(): Promise<PlannerCompactOutcome>;
  /** 取消进行中的请求（Ctrl+C 忙时调用）。 */
  cancel?(): void;
  /** 是否有请求进行中；SIGINT 用它决定取消还是退出。 */
  readonly busy?: boolean;
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
 * `/` 开头的是 CLI 命令（目前只有 /compact），由程序解析、不送给模型；
 * 自然语言里的 "compact" 一词不占用、照常进模型。
 */
export async function runTurns(
  planner: PlannerLike,
  lines: AsyncIterable<string> | Iterable<string>,
  io: CliIO,
): Promise<void> {
  let traced = 0;
  const traceNew = () => {
    for (; traced < planner.toolCalls.length; traced++) {
      io.err(traceLine(planner.toolCalls[traced]));
    }
  };
  for await (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    if (EXIT_WORDS.has(text.toLowerCase())) break;
    if (text.startsWith("/")) {
      if (text === "/compact") {
        if (planner.compact === undefined) {
          io.err("[error] 当前会话不支持手动压缩");
        } else {
          const outcome = await planner.compact();
          io.err(
            outcome.error
              ? `[error] ${outcome.error}`
              : outcome.applied
                ? "[compact] 已压缩会话历史"
                : "[compact] 上下文还不需要压缩",
          );
        }
      } else {
        io.err(`[error] 未知命令 ${text}（支持 /compact；自然语言请直接输入）`);
      }
      io.afterTurn?.();
      continue;
    }
    const turn = await planner.prompt(text);
    traceNew();
    if (turn.kind === "itinerary") {
      io.out(JSON.stringify(turn.itinerary));
    } else if (turn.kind === "comparison") {
      // 双方案比选：原样输出方案列表（首个为 active 方案）。
      io.out(JSON.stringify({ mode: "comparison", plans: turn.plans }));
    } else if (turn.kind === "clarification") {
      io.out(JSON.stringify({ question: turn.question }));
    } else {
      io.err(`[error] ${turn.message}`);
    }
    if (turn.kind !== "error" && turn.warning !== undefined) {
      io.err(`[warn] ${turn.warning}`);
    }
    io.afterTurn?.();
  }
}
