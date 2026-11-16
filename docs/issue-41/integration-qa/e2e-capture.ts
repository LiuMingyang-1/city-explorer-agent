// I41-E 集成 QA：faux provider → 真实 createChatService/HTTP/SSE/SQLite →
// 真实 index.html（headless Chrome + CDP）。后端实际产出
// spawned/tool_call(candidates)/done(stops) 帧驱动卡片+地图全链。
//   node docs/issue-41/integration-qa/e2e-capture.ts                 # stub+fallback 全场景
//   node docs/issue-41/integration-qa/e2e-capture.ts --only=stub
//   node docs/issue-41/integration-qa/e2e-capture.ts --only=fallback
//   node docs/issue-41/integration-qa/e2e-capture.ts --only=real     # 真实高德（读用户 .env，不打印）
// 自有临时库/端口/Chrome profile——绝不动用户 8080 服务/env/DB。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DELEGATE_TASK_TOOL } from "../../../src/agent/delegate.ts";
import { SEARCH_EVENTS_TOOL } from "../../../src/agent/tools.ts";
import type { ExplorerConfig } from "../../../src/config.ts";
import { seedDatabase } from "../../../src/data/seed.ts";
import { createSqliteEventRepository } from "../../../src/data/sqlite.ts";
import type { EventRepository } from "../../../src/data/repository.ts";
import type { Event } from "../../../src/data/types.ts";
import { createSqliteSessionRepository } from "../../../src/session/sqlite.ts";
import { createChatHandler } from "../../../src/web/http.ts";
import { createWebServer } from "../../../src/web/server.ts";
import { createChatService } from "../../../src/web/service.ts";

const argv = process.argv.slice(2); const args: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) { const a = argv[i].replace(/^--/, ""); const eq = a.indexOf("=");
  if (eq > 0) args[a.slice(0, eq)] = a.slice(eq + 1); else args[a] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(HERE, "../../..");
const shotsDir = join(HERE, "shots");
mkdirSync(shotsDir, { recursive: true });
const stubSource = readFileSync(join(HERE, "../map-qa/amap-stub.js"), "utf8");
const CHROME = (args.chrome as string | undefined) || [
  "/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
if (!CHROME) { console.error("no chromium found"); process.exit(2); }

const BASE = "2026-11-11";
const DAY1 = "2026-11-14";
const SUMMARY_DOC = "## 摘要\n- 已确认约束与行程要点已保留";

// ---------- faux streamFn：按请求内容纯决策，不排队（跨轮/跨场景可重入） ----------
const lastUserText = (context: { messages: AgentMessage[] }): string => {
  const users = context.messages.filter((m) => m.role === "user");
  const content = users.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
};
const firstUserText = (context: { messages: AgentMessage[] }): string => {
  const first = context.messages.find((m) => m.role === "user");
  return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
};
const hasToolResult = (context: { messages: AgentMessage[] }): boolean =>
  context.messages.some((m) => m.role === "toolResult");
const isDistill = (context: { messages: AgentMessage[] }): boolean =>
  typeof context.messages.find((m) => m.role === "user")?.content === "string" &&
  (context.messages.find((m) => m.role === "user")!.content as string).startsWith("<memory>");
const isSummary = (context: { messages: AgentMessage[] }): boolean =>
  context.messages.some((m) => m.role === "user" &&
    (typeof m.content === "string" ? m.content.includes("<conversation>") : JSON.stringify(m.content).includes("<conversation>")));

const reply = (step: FauxResponseStep): StreamFn => (model, context, options) => {
  const core = createFauxCore({}); core.setResponses([step]);
  return core.streamSimple(model, context, options);
};
// QA 减速：让真实生命周期在浏览器里可视（真实事件不变，只拖慢模型响应）。
const SLOW_MS = Number(args.slow ?? 350);
const slowed = (step: FauxResponseStep): FauxResponseStep =>
  async (context: unknown, streamOptions: unknown, state: unknown, model: unknown) => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    return typeof step === "function" ? (step as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<AssistantMessage>)(context, streamOptions, state, model) : step;
  };
const slowReply = (step: FauxResponseStep): StreamFn => (model, context, options) => {
  const core = createFauxCore({}); core.setResponses([slowed(step)]);
  return core.streamSimple(model, context, options);
};
const failStream: StreamFn = () => { const core = createFauxCore({}); core.setResponses([
  async () => { throw new Error("child 模型故障（QA 注入）"); }]); return core.streamSimple as never; };
const hangStream: StreamFn = (_model, _context, options) => { const core = createFauxCore({});
  core.setResponses([(_c: unknown, streamOptions: { signal?: AbortSignal }) =>
    new Promise<AssistantMessage>((_res, rej) => {
      const t = setTimeout(() => rej(new Error("挂起未被中止")), 30_000);
      (streamOptions?.signal ?? options?.signal)?.addEventListener("abort", () => {
        clearTimeout(t); const r = (streamOptions?.signal ?? options?.signal)?.reason;
        rej(r instanceof Error ? r : new Error(String(r ?? "aborted")));
      }, { once: true });
    })]);
  return core.streamSimple(_model, _context, options); };

const envelope = (itinerary: unknown, constraints: Record<string, unknown>): string =>
  JSON.stringify({ type: "itinerary", constraints, itinerary });
const comparison = (plans: { label: "A" | "B"; title: string; itinerary: unknown }[]): string =>
  JSON.stringify({ type: "comparison", constraints: { date: DAY1, availableStart: "12:00", availableEnd: "21:00" }, plans });
const stop = (event_id: string, arrive_at: string, leave_at: string, reason = "联调") => ({ event_id, arrive_at, leave_at, reason });

interface Ev { a1: Event; a2: Event; b1: Event; b2: Event; c1: Event }
async function pickEvents(repository: EventRepository): Promise<Ev> {
  const on = async (category: string, part: string) => {
    const found = (await repository.search({ date: DAY1, category })).find((e) => e.title.includes(part));
    if (!found) throw new Error(`种子活动缺失：${category}/${part}`);
    return found;
  };
  return {
    a1: await on("展览", "时间的形状"), a2: await on("展览", "江南织物考"),
    b1: await on("市集", "独立出版"), b2: await on("书店活动", "江边日记"),
    c1: await on("书店活动", "江边日记"),
  };
}

function buildStream(ev: Ev): StreamFn {
  const itinA = { date: DAY1, summary: "曲江看展线", stops: [stop(ev.a1.id, "13:00", "14:30"), stop(ev.a2.id, "15:00", "16:00")] };
  const itinB = { date: DAY1, summary: "市集+签售", stops: [stop(ev.b1.id, "12:30", "14:00"), stop(ev.b2.id, "19:00", "20:30")] };
  const itinC = { date: DAY1, summary: "书店慢读", stops: [stop(ev.c1.id, "16:00", "17:30")] };
  const titleA = "曲江看展探路方案", titleB = "城南市集签售探路方案", titleC = "城南旧巷书店咖啡慢逛长名探路方案";
  const delegate = (task: string, title: string) => fauxToolCall(DELEGATE_TASK_TOOL, { task, title });
  const parentToolCalls = (msg: string): AssistantMessage => {
    if (msg.includes("单线")) return fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "展览" })], { stopReason: "toolUse" });
    if (msg.includes("三方案")) return fauxAssistantMessage([
      delegate("看展片区探路", titleA), delegate("市集片区探路", titleB), delegate("书店片区探路", titleC),
    ], { stopReason: "toolUse" });
    if (msg.includes("败")) return fauxAssistantMessage([
      delegate("看展片区探路", titleA), delegate("市集片区探路[fail]", titleB),
    ], { stopReason: "toolUse" });
    if (msg.includes("hang")) return fauxAssistantMessage([
      delegate("看展片区探路", titleA), delegate("市集片区探路[hang]", titleB),
    ], { stopReason: "toolUse" });
    return fauxAssistantMessage([delegate("看展片区探路", titleA), delegate("市集片区探路", titleB)], { stopReason: "toolUse" });
  };
  const parentFinal = (msg: string): AssistantMessage => {
    if (msg.includes("单线")) return fauxAssistantMessage(envelope(itinA, { date: DAY1, availableStart: "13:00", availableEnd: "18:00" }));
    if (msg.includes("败") || msg.includes("hang")) return fauxAssistantMessage(comparison([
      { label: "A", title: "看展线（市集探路失败已剔除）", itinerary: itinA },
      { label: "B", title: "备用看展线", itinerary: { ...itinA, summary: "备用" } },
    ]));
    return fauxAssistantMessage(comparison([
      { label: "A", title: "曲江看展一日行", itinerary: itinA },
      { label: "B", title: "城南市集签售一日行", itinerary: itinB },
    ]));
  };
  return (model, context, options) => {
    if (isDistill(context)) return reply(fauxAssistantMessage("UNCHANGED"))(model, context, options);
    if (isSummary(context)) return reply(fauxAssistantMessage(SUMMARY_DOC))(model, context, options);
    const tools = getCurrentTools(context.messages).map((t) => t.name);
    if (tools.includes(DELEGATE_TASK_TOOL)) {
      const msg = lastUserText(context);
      if (msg.includes("追问")) return slowReply(fauxAssistantMessage('{"type":"clarify","question":"想上午出发还是下午出发？"}'))(model, context, options);
      return slowReply(hasToolResult(context) ? parentFinal(msg) : parentToolCalls(msg))(model, context, options);
    }
    const task = firstUserText(context);
    if (task.includes("[hang]")) return hangStream(model, context, options);
    if (task.includes("[fail]") && hasToolResult(context)) return failStream(model, context, options);
    if (!hasToolResult(context)) {
      const cat = task.includes("书店") ? "书店活动" : task.includes("市集") ? "市集" : "展览";
      return slowReply(fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: cat })], { stopReason: "toolUse" }))(model, context, options);
    }
    const itin = task.includes("书店") ? itinC : task.includes("市集") ? itinB : itinA;
    return slowReply(fauxAssistantMessage(envelope(itin, { date: DAY1, availableStart: "12:00", availableEnd: "21:00" })))(model, context, options);
  };
}

// ---------- 后端：真实 service + 真实 HTTP/SSE + 临时 SQLite ----------
async function startBackend(opts: { subagentTimeoutMs?: number; mapEnv?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), "i41e-"));
  const dbPath = join(dir, "events.db");
  seedDatabase(dbPath, BASE);
  const repository = createSqliteEventRepository(dbPath);
  const sessions = createSqliteSessionRepository(join(dir, "sessions.db"));
  const config: ExplorerConfig = {
    provider: "openai", model: "gpt-5.4", apiKey: "qa-no-key",
    contextWindow: 128_000, maxTokens: 4096, dbPath,
    subagentTimeoutMs: opts.subagentTimeoutMs,
  };
  const ev = await pickEvents(repository);
  const service = createChatService({ config, repository, sessions, streamFn: buildStream(ev), currentDate: BASE });
  const server = createWebServer({
    apiHandler: createChatHandler(service, {}),
    mapEnv: opts.mapEnv ?? { AMAP_JS_KEY: "qa-stub", AMAP_SECURITY_JSCODE: "qa-stub", AMAP_BACKEND_COORDINATE_SYSTEM: "GCJ02" },
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res()); });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async close() { await service.shutdown(); server.close(); sessions.close(); repository.close(); },
  };
}

// ---------- CDP ----------
async function launchChrome(port: number) {
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1", "--disable-extensions", "--mute-audio",
    `--user-data-dir=${tmpdir()}/i41e-chrome-${port}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise<string>((res, rej) => { let buf = ""; chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); }); chrome.on("exit", () => rej(new Error("chrome exited"))); setTimeout(() => rej(new Error("ws timeout")), 15000); });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0; const pending = new Map<number, { res: (v: never) => void; rej: (e: Error) => void }>(); const events = new Map<string, ((p: never) => void)[]>();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method) (events.get(m.method) || []).forEach((f) => f(m.params)); });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<never>((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const on = (m: string, f: (p: never) => void) => events.set(m, [...(events.get(m) || []), f]);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
  const cdp = (m: string, p?: Record<string, unknown>) => send(m, p, sessionId);
  await cdp("Page.enable"); await cdp("Runtime.enable");
  const evaluate = async (expr: string, awaitPromise = true) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }) as { result?: { value?: unknown } }).result?.value;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr: string, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(`Boolean(${expr})`).catch(() => false)) return true; await sleep(140); } return false; };
  const shot = async (name: string) => { const { data } = await cdp("Page.captureScreenshot", { format: "png" }) as { data: string }; writeFileSync(join(shotsDir, name + ".png"), Buffer.from(data, "base64")); };
  const viewport = (w: number, h: number) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  return { chrome, ws, cdp, on, send, evaluate, sleep, waitFor, shot, viewport, targetId, sendRaw: send };
}

type Metrics = Record<string, unknown>;
interface RunCtx { failures: string[]; metrics: Metrics }
const expect = (ctx: RunCtx, name: string, cond: unknown, info: Record<string, unknown> = {}) => {
  ctx.metrics[name] = { assert: cond ? "pass" : "FAIL", ...info }; if (!cond) ctx.failures.push(name); };

// ---------- 场景 ----------
async function runMode(mode: "stub" | "fallback" | "real", mapEnv: Record<string, string> | undefined) {
  const ctx: RunCtx = { failures: [], metrics: {} };
  const backend = await startBackend(mode === "real" ? {} : { subagentTimeoutMs: 3500 });
  // fallback 与 stub 用同一后端（mapEnv 由 mode 决定）；real 后端由下方重开。
  let active = backend;
  if (mode === "fallback") { await backend.close(); active = await startBackend({ subagentTimeoutMs: 3500, mapEnv: {} }); }
  if (mode === "real" && mapEnv) { await backend.close(); active = await startBackend({ mapEnv }); }
  const driver = await launchChrome(active.port);
  const { cdp, evaluate, waitFor, shot, viewport, on } = driver;
  if (mode === "stub") {
    await cdp("Fetch.enable", { patterns: [{ urlPattern: "*webapi.amap.com*" }] });
    on("Fetch.requestPaused", (p: { requestId: string }) => cdp("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript" }], body: Buffer.from(stubSource).toString("base64") }).catch(() => {}));
  }
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__anchorLog = []; window.__qaErrors = []; window.__progressLog = []; window.__dispatched = [];
    const __de = window.dispatchEvent.bind(window);
    window.dispatchEvent = (e) => { __dispatched.push(e && e.type === 'wander:candidate-anchor' ? {t: e.type, d: e.detail} : e && e.type); return __de(e); };
    const __patch = setInterval(() => {
      if (!window.WanderMascot) return;
      clearInterval(__patch);
      window.__cloneLog = [];
      const strip = document.getElementById('mascot-team-strip');
      if (strip) new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) __cloneLog.push({t: performance.now()|0, cls: n.className, html: strip.innerHTML.length}); }).observe(strip, {childList: true, subtree: true});
      const f = window.WanderMascot.applyEvent.bind(window.WanderMascot);
      window.WanderMascot.applyEvent = (e, tok) => { window.__progressLog.push({type: e.type ?? 'stage', stage: e.stage, id: e.subagent_id, name: e.name, cand: Array.isArray(e.candidates) ? e.candidates.length : undefined, stops: Array.isArray(e.stops) ? e.stops.length : undefined, status: e.status}); return f(e, tok); };
    }, 10);
    addEventListener('error', e => __qaErrors.push(String(e.message || e.error)));
    addEventListener('unhandledrejection', e => __qaErrors.push('rejection: ' + String(e.reason)));
    const __ce = console.error.bind(console); console.error = (...a) => {__qaErrors.push(a.map(String).join(' ')); __ce(...a);};` });
  const nav = () => cdp("Page.navigate", { url: `http://127.0.0.1:${active.port}/` });
  const snap = () => evaluate("window.WanderCandidates?.snapshot()") as Promise<Record<string, never> | undefined>;
  const dots = () => evaluate("document.querySelectorAll('.wander-candidate-dot').length") as Promise<number>;
  const anchors = () => evaluate("document.querySelectorAll('.wander-candidate-anchor').length") as Promise<number>;
  const clones = () => evaluate("[...document.querySelectorAll('#mascot-team-strip .mascot-team-clone')].map(el => ({id: el.getAttribute('data-subagent-id'), status: el.getAttribute('data-status'), anchored: el.getAttribute('data-anchored'), faceHidden: el.querySelector('boop-face') ? getComputedStyle(el.querySelector('boop-face')).visibility === 'hidden' : null}))") as Promise<{ id: string; status: string; anchored: string; faceHidden: boolean | null }[]>;
  const stripInfo = () => evaluate("({hidden: document.getElementById('mascot-team-strip').hidden, live: document.querySelector('.glass-card').classList.contains('team-live'), h: document.getElementById('mascot-team-strip').getBoundingClientRect().height})") as Promise<{ hidden: boolean; live: boolean; h: number }>;
  const consoleErrs = () => evaluate("window.__qaErrors.filter(e => !/favicon|net::|404/.test(e))") as Promise<string[]>;
  const sendMsg = (text: string) => evaluate(`window.sendMessage(${JSON.stringify(text)})`, false);
  const mapReadyExpr = mode === "fallback" ? 'window.L && document.querySelector(".leaflet-container")' : "window.WanderAMap && window.WanderAMap.ready";

  try {
    // ===== S1：双分身全链（spawn→candidates→anchor→done stops→settle 采纳） =====
    await viewport(1280, 800); await nav();
    expect(ctx, "map-ready", await waitFor(mapReadyExpr, 25000), { mode });
    await sendMsg("双方案联调：看展与市集");
    expect(ctx, "clones-mounted", await waitFor("document.querySelectorAll('#mascot-team-strip .mascot-team-clone').length >= 2", 20000), { clones: await clones() });
    await shot(`${mode}-10-two-clones`);
    if (mode !== "fallback") {
      expect(ctx, "candidates-drawn", await waitFor("document.querySelectorAll('.wander-candidate-dot').length > 0", 20000), { dots: await dots() });
      expect(ctx, "anchor-mounted", await waitFor("document.querySelectorAll('.wander-candidate-anchor').length > 0", 10000), { anchors: await anchors() });
      await shot(`${mode}-11-candidates-anchor`);
      const mid = await snap() as { subs?: { id: string; letter: string | null; palette: string | null; anchored: boolean }[] };
      ctx.metrics["mid-snapshot"] = mid;
      expect(ctx, "anchor-identity-real", mid?.subs?.some((s) => s.letter === "A" && s.palette), { subs: mid?.subs });
      const cardSync = await clones();
      expect(ctx, "card-clone-anchored", cardSync.some((c) => c.anchored === "true" && c.faceHidden === true), { clones: cardSync });
      await shot(`${mode}-12-anchor-face`);
    } else {
      // Leaflet：候选层诚实降级——不画点不锚，卡片分身照常。
      expect(ctx, "fallback-no-dots", (await dots()) === 0 && (await anchors()) === 0, { dots: await dots() });
      await shot("fallback-11-clones");
    }
    // settle：plans 到达 → 采纳移交路线层、候选层回收、分身退场、strip 归零
    expect(ctx, "settle-done", await waitFor("window.WanderCandidates.snapshot().closed === true", 30000));
    ctx.metrics["progress-frames"] = await evaluate("window.__progressLog");
    ctx.metrics["clone-dom-log"] = await evaluate("window.__cloneLog");
    ctx.metrics["strip-html"] = await evaluate("document.getElementById('mascot-team-strip').outerHTML.slice(0,400)");
    await driver.sleep(900);
    const post = await snap() as { subs?: unknown[]; dots?: number };
    const si = await stripInfo();
    expect(ctx, "post-settle-layer-clean", (post?.subs?.length ?? -1) === 0, { post });
    expect(ctx, "post-settle-strip-hidden", si.hidden === true && si.live === false, { strip: si });
    expect(ctx, "post-settle-clones-zero", (await clones()).length === 0);
    if (mode !== "fallback") {
      const routeDots = await evaluate("document.querySelectorAll('.native-route-dot,.leaflet-overlay-pane circle').length") as number;
      ctx.metrics["route-markers"] = routeDots;
      expect(ctx, "adopted-handed-off", routeDots >= 1, { routeDots });
      // wander:candidate-anchor 载荷以 dispatch 侧真实捕获为准（facade 侧
      // data-anchored 已独立证实投递）；注入期 addEventListener 在 headless
      // 里观测不可靠，不作为判定依据。
      const log = (await evaluate("window.__dispatched")) as ({ d?: { subagent_id?: string; anchored?: boolean } } | string)[];
      const anchorsSeen = log.filter((e) => typeof e === "object" && e.d).map((e) => (e as { d: { subagent_id: string; anchored: boolean } }).d);
      ctx.metrics["dispatched"] = await evaluate("window.__dispatched");
      ctx.metrics["anchor-events"] = anchorsSeen;
      expect(ctx, "anchor-roundtrip", anchorsSeen.some((e) => e.anchored === true) && anchorsSeen.some((e) => e.anchored === false), { log: anchorsSeen });
    }
    expect(ctx, "plans-rendered", await waitFor("document.querySelectorAll('.plan-card,.itinerary-card,[class*=plan]').length > 0 || document.querySelector('#messages').textContent.length > 40", 10000));
    await shot(`${mode}-13-settled`);
    const errs1 = await consoleErrs();
    expect(ctx, "s1-no-errors", errs1.length === 0, { errs: errs1 });

    // ===== S2：单线（0 派发）→ strip 恒隐 =====
    await evaluate("document.getElementById('new-chat').click()");
    await driver.sleep(300);
    await sendMsg("单线联调：只看展");
    expect(ctx, "single-round-done", await waitFor("window.WanderMascot.state !== 'thinking' && window.WanderCandidates.snapshot().closed === true", 30000));
    await driver.sleep(600);
    const si2 = await stripInfo();
    expect(ctx, "single-strip-never-shown", si2.hidden === true && si2.live === false, { strip: si2 });
    expect(ctx, "single-no-clones", (await evaluate("document.querySelectorAll('#mascot-team-strip .mascot-team-clone').length")) === 0);
    await shot(`${mode}-20-single`);

    // ===== S3：部分失败（B 子任务模型故障）→ done failed、A 正常收敛 =====
    await evaluate("document.getElementById('new-chat').click()");
    await driver.sleep(300);
    await sendMsg("部分失败联调：B 败");
    expect(ctx, "partial-clones", await waitFor("document.querySelectorAll('#mascot-team-strip .mascot-team-clone').length >= 2", 20000));
    expect(ctx, "partial-settled", await waitFor("window.WanderCandidates.snapshot().closed === true", 35000));
    await driver.sleep(800);
    const partSnap = await snap() as { subs?: { status: string }[] };
    const partClones = await clones();
    ctx.metrics["partial-clones"] = partClones;
    expect(ctx, "partial-layer-clean", (partSnap?.subs?.length ?? -1) === 0, { partSnap });
    expect(ctx, "partial-no-errors", (await consoleErrs()).filter((e) => !/child 模型故障|QA 注入/.test(e)).length === 0, { errs: await consoleErrs() });
    await shot(`${mode}-30-partial`);

    // ===== S4：中途 wander:reset → 全清且新一轮隔离 =====
    await evaluate("document.getElementById('new-chat').click()");
    await driver.sleep(300);
    await sendMsg("双方案联调：重置轮");
    await waitFor("document.querySelectorAll('#mascot-team-strip .mascot-team-clone').length >= 1", 20000);
    await evaluate("window.dispatchEvent(new Event('wander:reset'))");
    await driver.sleep(700);
    const resetSnap = await snap() as { subs?: unknown[]; dots?: number };
    const si4 = await stripInfo();
    expect(ctx, "reset-layer-clear", (resetSnap?.subs?.length ?? -1) === 0, { resetSnap });
    expect(ctx, "reset-strip-hidden", si4.hidden === true, { strip: si4 });
    await shot(`${mode}-40-reset`);

    // ===== S5：追问 settle（非 plans）→ 层即刻清 =====
    await evaluate("document.getElementById('new-chat').click()");
    await driver.sleep(300);
    await sendMsg("追问联调");
    expect(ctx, "clarify-settled", await waitFor("window.WanderCandidates.snapshot().closed === true", 30000));
    await driver.sleep(400);
    expect(ctx, "clarify-strip-hidden", (await stripInfo()).hidden === true);
    await shot(`${mode}-50-clarify`);

    // ===== S6：三分身长名 + 四视口布局 =====
    for (const [w, h, tag] of [[1440, 900, "1440"], [1024, 600, "1024"], [800, 480, "800"], [320, 700, "320"]] as const) {
      await viewport(w, h);
      await evaluate("document.getElementById('new-chat').click()");
      await driver.sleep(350);
      await sendMsg("三方案联调：三分身长标题");
      const live = await waitFor("document.querySelectorAll('#mascot-team-strip .mascot-team-clone').length >= 3", 25000);
      expect(ctx, `layout-${tag}-three-clones`, live, { clones: await clones() });
      await driver.sleep(400);
      const lay = await evaluate(`(() => {
        const r = el => el ? el.getBoundingClientRect() : null;
        const strip = r(document.getElementById('mascot-team-strip'));
        const msg = r(document.getElementById('messages'));
        const comp = r(document.querySelector('.composer-area'));
        const status = r(document.getElementById('location-status'));
        const card = r(document.querySelector('.glass-card'));
        const overlap = (a,b) => a&&b ? !(a.bottom<=b.top||b.bottom<=a.top||a.right<=b.left||b.right<=a.left) : false;
        return {strip,msg,comp,status,card,
          overlapStripMsg: overlap(strip,msg), overlapStripComp: overlap(strip,comp),
          overlapStripStatus: status && status.height>0 ? overlap(strip,status) : false,
          stripInsideCard: strip&&card ? strip.left>=card.left-1 && strip.right<=card.right+1 : null,
          scrollW: document.scrollingElement.scrollWidth, innerW: window.innerWidth};
      })()`) as { strip: { height: number } | null; overlapStripMsg: boolean; overlapStripComp: boolean; overlapStripStatus: boolean; stripInsideCard: boolean | null; scrollW: number; innerW: number };
      ctx.metrics[`layout-${tag}`] = lay;
      expect(ctx, `layout-${tag}-no-overlap`, live ? !lay.overlapStripMsg && !lay.overlapStripComp && !lay.overlapStripStatus : true, lay as unknown as Record<string, unknown>);
      expect(ctx, `layout-${tag}-strip-inside-card`, live ? lay.stripInsideCard === true : true);
      expect(ctx, `layout-${tag}-no-xscroll`, lay.scrollW <= lay.innerW + 1, { scrollW: lay.scrollW, innerW: lay.innerW });
      await shot(`${mode}-60-layout-${tag}`);
      // 收尾恢复布局
      await waitFor("window.WanderCandidates.snapshot().closed === true", 35000);
      await driver.sleep(600);
      const back = await stripInfo();
      expect(ctx, `layout-${tag}-restore`, back.hidden === true && back.live === false, { back });
    }

    // ===== S7：子任务超时（subagentTimeoutMs=3.5s，hang 子任务） =====
    await viewport(1280, 800);
    await evaluate("document.getElementById('new-chat').click()");
    await driver.sleep(300);
    const t0 = Date.now();
    await sendMsg("双方案联调：hang 超时");
    expect(ctx, "timeout-settled", await waitFor("window.WanderCandidates.snapshot().closed === true", 45000), { ms: Date.now() - t0 });
    await driver.sleep(500);
    const errsT = await consoleErrs();
    expect(ctx, "timeout-no-fatal", errsT.filter((e) => !/挂起|abort/i.test(e)).length === 0, { errs: errsT.slice(0, 5) });
    await shot(`${mode}-70-timeout`);
    expect(ctx, "final-no-errors", (await consoleErrs()).length === 0, { errs: (await consoleErrs()).slice(0, 8) });
  } catch (error) {
    ctx.failures.push("driver: " + (error as Error).message);
    ctx.metrics["driver-error"] = { assert: "FAIL", error: String(error) };
  }

  writeFileSync(join(HERE, `results-${mode}.json`), JSON.stringify({ mode, at: new Date().toISOString(), metrics: ctx.metrics, failures: ctx.failures }, null, 2));
  console.log(JSON.stringify({ mode, pass: Object.values(ctx.metrics).filter((m) => (m as { assert?: string }).assert === "pass").length, fails: ctx.failures }, null, 1));
  try { await driver.sendRaw("Target.closeTarget", { targetId: driver.targetId }); } catch { /* noop */ }
  driver.chrome.kill();
  await active.close();
  return ctx.failures.length;
}

const only = (args.only as string | undefined) ?? "all";
let failed = 0;
if (only === "all" || only === "stub") failed += await runMode("stub", undefined);
if (only === "all" || only === "fallback") failed += await runMode("fallback", {});
if (only === "real") {
  // 真实高德尝试：只读用户 .env 取 JS key/jscode（绝不打印）；缺则跳过。
  let env: Record<string, string> = {};
  try {
    const raw = readFileSync("/Users/lmy/Documents/code/city-explorer-agent/.env", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*(AMAP_JS_KEY|AMAP_SECURITY_JSCODE|AMAP_STYLE|AMAP_BACKEND_COORDINATE_SYSTEM)\s*=\s*(.+)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch { /* unreadable → skip */ }
  if (env.AMAP_JS_KEY && env.AMAP_SECURITY_JSCODE) failed += await runMode("real", env);
  else console.log(JSON.stringify({ mode: "real", skipped: "no AMAP_JS_KEY/AMAP_SECURITY_JSCODE in .env" }));
}
process.exit(failed ? 1 : 0);
