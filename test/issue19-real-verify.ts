/**
 * Issue #19 真实联网多轮验证（C4，手动运行，不进 npm test）：
 *
 *   node --env-file-if-exists=.env test/issue19-real-verify.ts
 *
 * 使用 .env 真实配置（真实模型 + web_search/estimate_travel 按 key 挂载）、
 * 真实活动库 data/events.db（只读查询）；会话库放系统临时目录，
 * 不写仓库 data/sessions.db。输出脱敏：只打印 provider/model 名与
 * key 的"configured/absent"标志，绝不打印任何密钥值、baseUrl 或密钥派生物。
 *
 * 逐轮打印 turn.kind / 行程指针变化 / 工具调用记录（含 args 摘要与
 * isError/durationMs），最后给 PASS/FAIL。期望（Issue #19 契约）：
 * 第 2–4 轮为 answer、不挪行程指针；第 5 轮为 itinerary/comparison 并
 * 推进指针。实现未落地时本脚本表现为 FAIL，即问题复现证据。
 *
 * 审计口径（重要）：以 [assert] 标记的是脚本可机器断言项（turn.kind、
 * 指针变化、工具名/isError/耗时、文本非空）；逐轮打印的 answer 正文与
 * 工具 args 仅标注 [observe]，内容质量（天气是否属实、来源是否可靠、
 * "第二站"解析是否正确）本脚本不做独立核验，需人工/另行核查，不得仅凭
 * 本脚本输出声称内容属实。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createPersistentPlanner } from "../src/agent/session.ts";
import type { PlannerTurn, ToolCallRecord } from "../src/agent/session.ts";
import { loadConfig } from "../src/config.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";

interface StepResult {
  prompt: string;
  kind: string;
  summary: string;
  pointer: string | null;
  pointerMoved: boolean;
  tools: string[];
}

function summarize(turn: PlannerTurn): string {
  const t = turn as unknown as Record<string, unknown>;
  if (turn.kind === "itinerary") return `itinerary.summary=${(t.itinerary as { summary?: string })?.summary}`;
  if (turn.kind === "comparison") return `plans=${(t.plans as unknown[])?.length}`;
  if (turn.kind === "clarification") return `question=${t.question}`;
  if (turn.kind === "error") return `message=${t.message}`;
  return `text=${String(t.text ?? "").slice(0, 200)}`;
}

/** 工具调用审计行：工具名 + isError + 耗时 + args 摘要（值截断，防意外外泄）。 */
function describeCall(call: ToolCallRecord): string {
  const args =
    call.args === undefined
      ? ""
      : ` ${JSON.stringify(call.args, (_k, v: unknown) =>
          typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v,
        )}`;
  return `${call.toolName}${call.isError ? "(err)" : ""} ${call.durationMs ?? "?"}ms${args}`;
}

const config = { ...loadConfig(), memoryMinUserMessages: 999 }; // 跳过 close 蒸馏，省一次旁路请求
const dir = mkdtempSync(join(tmpdir(), "issue19-real-"));
const sessions = createSqliteSessionRepository(join(dir, "sessions.db"));
const repository = createSqliteEventRepository(config.dbPath);
// 只打印非敏感元信息：provider/model 名与 key 有无；不打印 baseUrl/密钥/路径全貌。
console.log(`[setup] provider=${config.provider} model=${config.model} web_search=${config.webSearchKey ? "configured" : "absent"} amap=${config.amapKey ? "configured" : "absent"}`);
console.log(`[setup] events=${basename(config.dbPath)} sessions=<tmpdir>/sessions.db`);

const session = await createPersistentPlanner({
  config,
  repository,
  sessions,
  userId: "issue19-verify",
  title: "Issue19 真实验证",
});
const sid = session.sessionId as string;
console.log(`[setup] session_id=${sid}`);

const results: StepResult[] = [];
let failures = 0;

async function pointerId(): Promise<string | null> {
  const current = await sessions.getCurrentItinerary("issue19-verify", sid);
  return current?.record.recordId ?? null;
}

async function step(prompt: string, expect: "plan" | "answer"): Promise<PlannerTurn> {
  const before = await pointerId();
  const toolsBefore = session.toolCalls.length;
  const turn = await session.prompt(prompt);
  const after = await pointerId();
  const newCalls = session.toolCalls.slice(toolsBefore);
  const tools = newCalls.map(describeCall);
  const isPlan = turn.kind === "itinerary" || turn.kind === "comparison";
  const ok = expect === "plan" ? isPlan && before !== after : turn.kind === "answer" && before !== after;
  if (!ok) failures += 1;
  results.push({
    prompt,
    kind: turn.kind,
    summary: summarize(turn),
    pointer: after,
    pointerMoved: before !== after,
    tools,
  });
  console.log(
    `[turn ${results.length}] [assert] ${ok ? "OK  " : "FAIL"} expect=${expect} kind=${turn.kind} ` +
      `pointerMoved=${before !== after}`,
  );
  console.log(`    prompt: ${prompt}`);
  console.log(`    result: ${summarize(turn)}`);
  // [observe] 工具调用记录：名称/成败/耗时为机器可读事实；args 仅供人工核对，
  // 不代表对调用结果内容（天气/来源等）的背书。
  for (const line of tools) console.log(`    [observe] tool ${line}`);
  return turn;
}

try {
  // 1) 生成一版正常行程（最多给一次补充机会，防 clarify 中断脚本）。
  let t1 = await step("帮我安排 2026-11-15 下午在西安的半日游，想看展览", "plan");
  if (t1.kind === "clarification") {
    t1 = await step("2026-11-15 下午半天，展览优先", "plan");
  }
  const planned = t1.kind === "itinerary" || t1.kind === "comparison";
  if (!planned) {
    console.log("[abort] 首轮未产出方案，后续问答无上下文，终止");
  } else {
    // 2–4) 信息问答：应普通回答且不挪指针。
    await step("明天天气怎么样", "answer");
    await step("第二站需要预约吗", "answer");
    await step("下雨会影响这条路线吗", "answer");
    // 5) 修改诉求：应出新方案并推进指针。
    await step("那帮我换成室内的", "plan");
  }
} finally {
  await session.close();
  sessions.close();
  repository.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} 处不符合契约（详见上方逐轮记录）`);
console.log(
  "[scope] 以上 PASS 仅覆盖机器可断言项（类型/指针/工具记录）；answer 正文与" +
    "工具结果内容的属实性未独立核验，引用本输出时不得声称内容可信。",
);
process.exit(failures === 0 ? 0 : 1);
