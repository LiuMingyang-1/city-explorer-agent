import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { PlannerTurn, ToolCallRecord } from "../src/agent/session.ts";
import type { CliIO, PlannerLike } from "../src/cli/loop.ts";
import { runTurns } from "../src/cli/loop.ts";
import type { Itinerary } from "../src/itinerary/types.ts";

const execFileAsync = promisify(execFile);

const ITINERARY: Itinerary = {
  date: "2026-11-14",
  summary: "看展",
  stops: [{ event_id: "evt_001", arrive_at: "13:00", leave_at: "14:30", reason: "r" }],
};

/** 收集输出的 CliIO；turns 记录 afterTurn 次数（交互模式重显提示）。 */
function capture(): CliIO & { stdout: string[]; stderr: string[]; turns: number } {
  const io = {
    stdout: [] as string[],
    stderr: [] as string[],
    turns: 0,
    out(text: string) {
      io.stdout.push(text);
    },
    err(text: string) {
      io.stderr.push(text);
    },
    afterTurn() {
      io.turns += 1;
    },
  };
  return io;
}

/** fake planner：按序返回 turns，记录输入文本，可按轮追加 toolCalls。 */
function fakePlanner(
  turns: PlannerTurn[],
  trace: ToolCallRecord[][] = [],
): PlannerLike & { calls: string[] } {
  const toolCalls: ToolCallRecord[] = [];
  const planner = {
    calls: [] as string[],
    toolCalls,
    async prompt(text: string): Promise<PlannerTurn> {
      planner.calls.push(text);
      toolCalls.push(...(trace[planner.calls.length - 1] ?? []));
      return turns[planner.calls.length - 1] ?? { kind: "error", message: "exhausted" };
    },
  };
  return planner;
}

async function* lineSource(lines: string[]): AsyncGenerator<string> {
  yield* lines;
}

test("stdin lines run sequentially: multi-turn outputs land on stdout until EOF", async () => {
  const planner = fakePlanner([
    { kind: "itinerary", itinerary: ITINERARY, constraints: { date: "2026-11-14" } },
    { kind: "clarification", question: "想哪天去？" },
  ]);
  const io = capture();
  await runTurns(planner, lineSource(["帮我安排看展", "", "   ", "换个时间"]), io);
  assert.deepEqual(planner.calls, ["帮我安排看展", "换个时间"]); // 空行跳过，顺序保持
  assert.equal(io.stdout.length, 2);
  assert.equal(JSON.parse(io.stdout[0]).stops[0].event_id, "evt_001");
  assert.deepEqual(JSON.parse(io.stdout[1]), { question: "想哪天去？" });
  assert.equal(io.turns, 2);
});

test("stdout stays machine JSON: tool traces and error turns go to stderr", async () => {
  const planner = fakePlanner(
    [
      { kind: "itinerary", itinerary: ITINERARY, constraints: { date: "2026-11-14" } },
      { kind: "error", message: "模型请求失败" },
      { kind: "clarification", question: "q" },
    ],
    [
      [{ toolName: "search_events", args: { date: "2026-11-14", category: "展览" }, isError: false, durationMs: 3 }],
      [],
      [{ toolName: "search_events", args: {}, isError: true }],
    ],
  );
  const io = capture();
  await runTurns(planner, lineSource(["a", "b", "c"]), io);
  assert.equal(io.stdout.length, 2);
  for (const line of io.stdout) JSON.parse(line);
  const trace = io.stderr.filter((l) => l.startsWith("[tool]"));
  assert.equal(trace.length, 2); // 两轮各新增一条，按序增量打印
  assert.ok(trace[0].includes('"date":"2026-11-14"') && trace[0].includes("ok 3ms"));
  assert.ok(trace[1].includes("error"));
  assert.ok(io.stderr.some((l) => l.includes("[error] 模型请求失败")));
});

test("exit word ends the loop before remaining input", async () => {
  const planner = fakePlanner([{ kind: "clarification", question: "q" }]);
  const io = capture();
  await runTurns(planner, lineSource(["hi", "exit", "never read"]), io);
  assert.deepEqual(planner.calls, ["hi"]);
});

test("node src/cli/main.ts --help prints usage without an API key", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, ["src/cli/main.ts", "--help"], {
    cwd: root,
    env: {},
  });
  assert.match(stdout, /用法/);
  assert.match(stdout, /npm run seed/);
});
