import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { PlannerTurn, ToolCallRecord } from "../src/agent/session.ts";
import { seedDatabase } from "../src/data/seed.ts";
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

test("/compact is parsed by the CLI and never reaches the model", async () => {
  let compacts = 0;
  const planner = {
    ...fakePlanner([{ kind: "clarification", question: "q" }]),
    async compact() {
      compacts += 1;
      return { applied: true };
    },
  };
  const io = capture();
  await runTurns(planner, lineSource(["/compact", "正常提问"]), io);
  assert.equal(compacts, 1);
  assert.deepEqual(planner.calls, ["正常提问"]); // 只有自然语言进模型
  assert.equal(io.stdout.length, 1); // /compact 不产生 stdout 行
  assert.ok(io.stderr.some((l) => l.includes("已压缩")));
});

test("/compact reports when nothing needs compacting or unsupported", async () => {
  const applied = {
    ...fakePlanner([]),
    async compact() {
      return { applied: false };
    },
  };
  const io1 = capture();
  await runTurns(applied, lineSource(["/compact"]), io1);
  assert.ok(io1.stderr.some((l) => l.includes("不需要压缩")));

  const unsupported = fakePlanner([]);
  const io2 = capture();
  await runTurns(unsupported, lineSource(["/compact"]), io2);
  assert.ok(io2.stderr.some((l) => l.includes("不支持")));
});

test("unknown slash command gets a hint; bare 'compact' goes to the model", async () => {
  const planner = fakePlanner([
    { kind: "clarification", question: "q" },
    { kind: "clarification", question: "q" },
  ]);
  const io = capture();
  await runTurns(planner, lineSource(["/foo", "compact"]), io);
  assert.ok(io.stderr.some((l) => l.includes("未知命令 /foo")));
  assert.deepEqual(planner.calls, ["compact"]); // 自然语言单词照常进模型
});

test("node src/cli/main.ts --help prints usage without an API key", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, ["src/cli/main.ts", "--help"], {
    cwd: root,
    env: {},
  });
  assert.match(stdout, /用法/);
  assert.match(stdout, /npm run seed/);
  assert.match(stdout, /EXPLORER_SESSION_ID/, "应说明 EXPLORER_SESSION_ID 恢复指定会话");
  assert.match(stdout, /新建/, "默认每次启动新建对话");
  assert.doesNotMatch(stdout, /延续同一主会话/);
});

/**
 * 会话行为端到端：空 stdin 立即 EOF → main() 只做 createPersistentPlanner
 * （建新对话/恢复指定会话并打印会话 ID）即正常退出，全程不发模型请求。
 * 活动库与会话库都在临时目录，离线可跑。
 */
test("CLI opens a fresh conversation per start, prints its id, and resumes via EXPLORER_SESSION_ID", async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "explorer-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  seedDatabase(dbPath, "2026-11-11");
  const baseEnv = {
    EXPLORER_API_KEY: "k",
    EXPLORER_DB_PATH: dbPath,
    EXPLORER_SESSION_DB_PATH: join(dir, "sessions.db"),
  };
  const run = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["src/cli/main.ts"], {
      cwd: root,
      env: { ...baseEnv, ...env },
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });

  // 无 EXPLORER_SESSION_ID：新建对话并在 stderr 打印会话 ID；两次启动不同会话。
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const sid1 = first.stderr.match(/新对话会话 (\S+)；/)?.[1];
  assert.ok(sid1, `stderr 应打印会话 ID：\n${first.stderr}`);
  assert.match(first.stderr, new RegExp(`EXPLORER_SESSION_ID=${sid1}`));
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const sid2 = second.stderr.match(/新对话会话 (\S+)；/)?.[1];
  assert.ok(sid2 && sid2 !== sid1, "每次启动应新建不同对话");

  // 不存在的会话 ID：明确拒绝，不误建新会话。
  const bad = run({ EXPLORER_SESSION_ID: "sess-missing" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /不存在|not_found/);

  // 合法 ID：恢复指定会话。
  const resumed = run({ EXPLORER_SESSION_ID: sid1 });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, new RegExp(`已恢复会话 ${sid1}`));
});
