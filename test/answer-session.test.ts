/**
 * Issue #19 多轮状态保护回归（C2，内存会话层）：生成方案后，信息问答
 * （{"type":"answer","text":…}）必须只追加聊天记录——当前行程、已确认约束
 * 不被更新，校验器不被调用；随后的"换成室内的"仍能在原方案上下文上
 * 正常产出新行程。持久化与恢复见 answer-persistent.test.ts / web-e2e-answer.test.ts。
 */
import { afterResource } from "./resource-cleanup-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import { PlannerSession } from "../src/agent/session.ts";
import type { PlannerTurn } from "../src/agent/session.ts";
import type { ExplorerConfig } from "../src/config.ts";
import { seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { Event } from "../src/data/types.ts";
import type { Itinerary, PlanningConstraints } from "../src/itinerary/types.ts";
import type { ValidationResult } from "../src/itinerary/validation.ts";
import { answerEnvelope, DAY1, envelope } from "./e2e-fixture.ts";

const BASE = "2026-11-11";

const CONFIG: ExplorerConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "k",
  contextWindow: 128_000,
  maxTokens: 4096,
  dbPath: "unused.db",
};

/** answer 轮的本地期望（实现落地前 PlannerTurn 尚无此成员）。 */
interface AnswerTurn {
  kind: "answer";
  text: string;
  warning?: string;
}

/** 断言本轮是普通回答轮并取出文本；实现未落地时在此失败。 */
function asAnswerTurn(turn: PlannerTurn): AnswerTurn {
  assert.equal(turn.kind, "answer", `期望普通回答轮，得到 ${JSON.stringify(turn)}`);
  const answer = turn as unknown as AnswerTurn;
  assert.equal(typeof answer.text, "string", "answer 轮必须带 text 字符串");
  assert.ok(answer.text.trim().length > 0, "answer.text 不应为空");
  return answer;
}

/** 与 agent-session.test.ts 同款最小真实校验；calls 计数供"answer 不校验"断言。 */
function makeCheck(calls: { n: number }) {
  return (candidate: unknown, constraints: PlanningConstraints, events: Map<string, Event>): ValidationResult => {
    calls.n += 1;
    const fail = (code: string, message: string, event_id?: string): ValidationResult => ({
      ok: false,
      issues: [{ code: code as never, message, event_id }],
    });
    const c = candidate as Partial<Itinerary> | null;
    if (!c || typeof c.date !== "string" || typeof c.summary !== "string" || !Array.isArray(c.stops)) {
      return fail("invalid_shape", "结构不对");
    }
    if (c.date !== constraints.date) {
      return fail("date_mismatch", `行程日期 ${c.date} 与要求 ${constraints.date} 不符`);
    }
    for (const s of c.stops) {
      if (!events.has(s.event_id)) return fail("unknown_event", `未知活动 ${s.event_id}`, s.event_id);
    }
    return { ok: true, issues: [], itinerary: candidate as Itinerary };
  };
}

async function makeSession(
  t: TestContext,
  options: { config?: ExplorerConfig; webSearchFetch?: typeof fetch | null } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "explorer-answer-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  seedDatabase(dbPath, BASE);
  const repo = createSqliteEventRepository(dbPath);
  afterResource(t, () => repo.close());

  const faux = createFauxCore({});
  const streamFn: StreamFn = (model, context, options) => faux.streamSimple(model, context, options);
  const agent = await createExplorerAgent({
    config: options.config ?? CONFIG,
    repository: repo,
    streamFn,
    currentDate: BASE,
    ...(options.webSearchFetch !== undefined ? { webSearchFetch: options.webSearchFetch } : {}),
  });
  const calls = { n: 0 };
  return {
    session: new PlannerSession({ agent, repository: repo, validate: makeCheck(calls) }),
    repo,
    faux,
    agent,
    validateCalls: calls,
  };
}

test("生成方案后连续问答：answer 不更新行程/约束、不跑校验；改行程仍可用", async (t) => {
  const { session, repo, faux, validateCalls } = await makeSession(t);
  const ev = (await repo.search({ date: DAY1, category: "展览" }))[0];
  const talk = (await repo.search({ date: DAY1, category: "讲座" }))[0];
  assert.ok(ev && talk, "种子库应有展览与讲座");
  const constraintsV1 = { date: DAY1, availableStart: "13:00", availableEnd: "18:00" };
  const planV1 = {
    date: DAY1,
    summary: "初版：下午看展",
    stops: [{ event_id: ev.id, arrive_at: "13:00", leave_at: "14:00", reason: "r" }],
  };
  const planV2 = {
    date: DAY1,
    summary: "改后：看展再听室内讲座",
    stops: [
      { event_id: ev.id, arrive_at: "13:00", leave_at: "13:50", reason: "压缩看展" },
      { event_id: talk.id, arrive_at: "14:00", leave_at: "15:30", reason: "室内讲座" },
    ],
  };
  const weatherText = "明天西安多云转阴，18–24℃，户外活动基本不受影响。";
  const bookingText = "第二站为公益讲座，免费但需提前预约，建议今天内登记。";
  const rainText = "若有雨，首站与讲座均在室内，路线基本不受影响；站间建议带伞。";
  faux.setResponses([
    fauxAssistantMessage(envelope(planV1, constraintsV1)),
    // 天气问答带一次真实工具调用（查库/联网同理，只验证调用链照常记录）。
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY1, category: "展览" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(answerEnvelope(weatherText)),
    fauxAssistantMessage(answerEnvelope(bookingText)),
    fauxAssistantMessage(answerEnvelope(rainText)),
    fauxAssistantMessage(envelope(planV2, { date: DAY1 })),
  ]);

  // 1) 生成方案：正常走校验并提交。
  const t1 = await session.prompt("周六下午想看展");
  assert.equal(t1.kind, "itinerary");
  assert.equal(validateCalls.n, 1);
  const committed = session.itinerary;
  const confirmed = session.constraints;
  assert.deepEqual(committed, planV1 as unknown as Itinerary);
  assert.deepEqual(confirmed, constraintsV1);

  // 2) "明天天气怎么样"：answer 轮，状态完全不动。
  const t2 = asAnswerTurn(await session.prompt("明天天气怎么样"));
  assert.equal(t2.text, weatherText);
  assert.deepEqual(session.itinerary, planV1 as unknown as Itinerary);
  assert.deepEqual(session.constraints, constraintsV1);
  assert.equal(validateCalls.n, 1, "answer 不得触发行程校验");
  // 轮内真实工具调用照常记录（answer 可带查询工具，不因查询自动重排）。
  assert.deepEqual(
    session.toolCalls.map((c) => [c.toolName, c.isError]),
    [["search_events", false]],
  );

  // 3) "第二站需要预约吗" / 4) "下雨会影响这条路线吗"：同样只回答。
  const t3 = asAnswerTurn(await session.prompt("第二站需要预约吗"));
  assert.equal(t3.text, bookingText);
  const t4 = asAnswerTurn(await session.prompt("下雨会影响这条路线吗"));
  assert.equal(t4.text, rainText);
  assert.deepEqual(session.itinerary, planV1 as unknown as Itinerary);
  assert.deepEqual(session.constraints, constraintsV1);
  assert.equal(validateCalls.n, 1);

  // 5) "那帮我换成室内的"：在原方案上下文上正常出新行程。
  const t5 = await session.prompt("那帮我换成室内的");
  assert.equal(t5.kind, "itinerary");
  if (t5.kind !== "itinerary") return;
  assert.deepEqual(t5.itinerary, planV2 as unknown as Itinerary);
  assert.deepEqual(session.itinerary, planV2 as unknown as Itinerary);
  // 补丁只带 date：已确认时段沿用（合并而非重置）。
  assert.deepEqual(session.constraints, constraintsV1);
  assert.equal(validateCalls.n, 2, "修改轮才应再次校验");
});

test("首轮即问答：answer 也能正常返回，无副作用状态可断言", async (t) => {
  const { session, faux, validateCalls } = await makeSession(t);
  faux.setResponses([fauxAssistantMessage(answerEnvelope("今天西安晴，15–22℃。"))]);
  const turn = asAnswerTurn(await session.prompt("今天天气怎么样"));
  assert.equal(turn.text, "今天西安晴，15–22℃。");
  assert.equal(session.itinerary, undefined);
  assert.equal(session.constraints, undefined);
  assert.equal(validateCalls.n, 0);
});

test("answer 轮不被纠正循环吞掉：一次解析即返回，不多烧模型请求", async (t) => {
  const { session, faux } = await makeSession(t);
  faux.setResponses([fauxAssistantMessage(answerEnvelope("直接回答即可。"))]);
  await session.prompt("问个事");
  assert.equal(faux.state.callCount, 1, "answer 是终态轮，不应触发纠正重试");
});

// ---- C5：联网不可用/失败时的诚实 answer 不更新方案状态（mock 层） ----
// "诚实回答"在 mock 层指：工具结果（未挂载/调用 isError）如实回喂后模型输出
// answer 而非硬凑行程；真实联网问答的端到端证据见 issue19-real-verify.ts。

test("联网未配置：无 web_search 挂载时如实说明无法核实，answer 不动方案", async (t) => {
  const { session, repo, faux, agent } = await makeSession(t);
  const ev = (await repo.search({ date: DAY1, category: "展览" }))[0];
  const constraintsV1 = { date: DAY1, availableStart: "13:00", availableEnd: "18:00" };
  const planV1 = {
    date: DAY1,
    summary: "初版：下午看展",
    stops: [{ event_id: ev.id, arrive_at: "13:00", leave_at: "14:00", reason: "r" }],
  };
  const honestText = "本地没有联网搜索能力，明天的实时天气我无法核实，建议出发前查看气象台预报；已排行程不受影响。";
  faux.setResponses([
    fauxAssistantMessage(envelope(planV1, constraintsV1)),
    fauxAssistantMessage(answerEnvelope(honestText)),
  ]);

  // 未配置搜索 key：web_search 不挂载，提示词里连工具名都不应出现。
  assert.ok(!agent.state.tools.some((tool) => tool.name === "web_search"));
  assert.ok(!agent.state.systemPrompt.includes("web_search"));

  const t1 = await session.prompt("周六下午想看展");
  assert.equal(t1.kind, "itinerary");
  const callsBefore = session.toolCalls.length;
  const t2 = asAnswerTurn(await session.prompt("明天天气怎么样"));
  assert.equal(t2.text, honestText);
  assert.equal(session.toolCalls.length, callsBefore, "未配置时不得凭空发起联网调用");
  assert.deepEqual(session.itinerary, planV1 as unknown as Itinerary);
  assert.deepEqual(session.constraints, constraintsV1);
});

test("联网查询失败：web_search 回 isError 后如实说明，answer 不动方案", async (t) => {
  const failingFetch = (() =>
    Promise.reject(new Error("network unreachable"))) as typeof fetch;
  const { session, repo, faux, agent } = await makeSession(t, {
    config: { ...CONFIG, webSearchKey: "K" },
    webSearchFetch: failingFetch,
  });
  assert.ok(
    agent.state.tools.some((tool) => tool.name === "web_search"),
    "配置 key + 注入 fetch 后应挂载 web_search",
  );
  const ev = (await repo.search({ date: DAY1, category: "展览" }))[0];
  const constraintsV1 = { date: DAY1, availableStart: "13:00", availableEnd: "18:00" };
  const planV1 = {
    date: DAY1,
    summary: "初版：下午看展",
    stops: [{ event_id: ev.id, arrive_at: "13:00", leave_at: "14:00", reason: "r" }],
  };
  const honestText = "联网查询暂时不可用，明天的天气我没法核实，请出发前再确认；已排好的行程不受影响。";
  faux.setResponses([
    fauxAssistantMessage(envelope(planV1, constraintsV1)),
    fauxAssistantMessage([fauxToolCall("web_search", { query: "西安 明天天气" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(answerEnvelope(honestText)),
  ]);

  const t1 = await session.prompt("周六下午想看展");
  assert.equal(t1.kind, "itinerary");
  const t2 = asAnswerTurn(await session.prompt("明天天气怎么样"));
  assert.equal(t2.text, honestText);
  // 查询失败被如实回喂（isError），answer 轮照常成立、方案状态零改动。
  const searchCall = session.toolCalls.at(-1);
  assert.equal(searchCall?.toolName, "web_search");
  assert.equal(searchCall?.isError, true, "失败的联网调用应以 isError 回喂而非吞掉");
  assert.deepEqual(session.itinerary, planV1 as unknown as Itinerary);
  assert.deepEqual(session.constraints, constraintsV1);
});
