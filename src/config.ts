import { resolve } from "node:path";
import { loadCompactionOptions } from "./compaction/options.ts";
import type { CompactionOptions } from "./compaction/compact.ts";

export interface ExplorerConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  /** 自定义端点目录元数据的本地默认；标准 provider 用其自带目录。 */
  contextWindow: number;
  maxTokens: number;
  /**
   * 压缩参数；loadConfig 总是填入完整值。手工构造的 config 可省略或只给部分
   * 字段——使用方经 resolveCompactionOptions(config) 归一化，缺的
   * maxTokens 回退普通回复预算 config.maxTokens。
   */
  compaction?: Partial<CompactionOptions>;
  /** SQLite 活动库文件路径。 */
  dbPath: string;
  /**
   * SQLite 会话库文件路径，与活动库相互独立（loadConfig 总是填入；
   * 手工构造的 config 可省略，调用方给默认 data/sessions.db）。
   */
  sessionDbPath?: string;
  /**
   * 本地演示用户标识（EXPLORER_USER_ID；缺省/空白 → "local"）。
   * 仅本地 CLI 演示用途，不是 Web 认证；后端接入时由调用方传认证后的 userId。
   */
  userId?: string;
  /**
   * CLI 钉住恢复的会话 ID（EXPLORER_SESSION_ID；缺省/空白 → undefined，
   * 每次启动新建对话）。调试/回归用途，Web 会话由请求参数指定。
   */
  sessionId?: string;
  /**
   * 蒸馏单请求输入总长上限（字符，EXPLORER_MEMORY_INPUT_CHARS；缺省 64_000，
   * 模型窗口折算更小者生效）。手工构造的 config 可省略，蒸馏层有同值缺省。
   */
  memoryInputChars?: number;
  /**
   * close 机会蒸馏的硬超时（毫秒，EXPLORER_MEMORY_DISTILL_TIMEOUT_MS；
   * 缺省 90_000）。手工构造的 config 可省略，运行时按同值缺省。
   */
  memoryDistillTimeoutMs?: number;
  /**
   * 无新确认方案时触发蒸馏的保底新增 user 消息条数
   * （EXPLORER_MEMORY_MIN_USER_MESSAGES；缺省 3）。手工构造的 config 可省略，
   * 蒸馏层有同值缺省。
   */
  memoryMinUserMessages?: number;
  /**
   * 子 Agent 进程级并发信号量上限（EXPLORER_SUBAGENT_MAX_CONCURRENT；
   * 缺省 8）。手工构造的 config 可省略，编排层按同值缺省。
   */
  subagentMaxConcurrent?: number;
  /**
   * 单次子 Agent 派发超时（毫秒，EXPLORER_SUBAGENT_TIMEOUT_MS；
   * 缺省 120_000，自进入 execute 含信号量排队起算）。手工构造的 config
   * 可省略，编排层按同值缺省。
   */
  subagentTimeoutMs?: number;
  /**
   * 高德 Web 服务 REST key（EXPLORER_AMAP_KEY）；缺省/空白 → undefined，
   * 站间算路全链路降级（不挂 estimate_travel 工具、legs 全记 skipped），
   * 不阻塞规划。手工构造的 config 可省略。
   */
  amapKey?: string;
  /**
   * 公交算路接口的必填 city 参数（EXPLORER_AMAP_TRANSIT_CITY；城市名或
   * citycode，如 "西安"/"029"）。缺省 → 公交请求不带 city（多半报错降级），
   * 部署时按演示城市配置。手工构造的 config 可省略。
   */
  amapTransitCity?: string;
  /**
   * 站间直线距离阈值（米，EXPLORER_ROUTE_TRANSIT_THRESHOLD_M；缺省 3000）：
   * ≤ 阈值选 walking 算路，否则 transit。手工构造的 config 可省略。
   */
  routeTransitThresholdM?: number;
}

/** 读取 EXPLORER_* 环境配置并做基本检查；不发起模型请求。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExplorerConfig {
  const provider = env.EXPLORER_PROVIDER?.trim() || "openai";
  const baseUrl = env.EXPLORER_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
  if (baseUrl) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("EXPLORER_BASE_URL must be a valid HTTP(S) base URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("EXPLORER_BASE_URL must be HTTP(S), without credentials, query or fragment.");
    }
  } else if (provider !== "openai" && provider !== "anthropic") {
    throw new Error("Custom EXPLORER_PROVIDER requires EXPLORER_BASE_URL and EXPLORER_MODEL.");
  }
  const model = env.EXPLORER_MODEL?.trim();
  if (baseUrl && !model) {
    throw new Error("Set EXPLORER_MODEL to the model ID offered by EXPLORER_BASE_URL.");
  }
  const fallbackKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const apiKey = env.EXPLORER_API_KEY?.trim() || env[fallbackKey]?.trim();
  if (!apiKey) {
    throw new Error(`Set EXPLORER_API_KEY or ${fallbackKey}; see .env.example.`);
  }
  const maxTokens = positiveInteger(env, "EXPLORER_MAX_TOKENS", 4096);
  return {
    provider,
    model: model || (provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.4"),
    baseUrl,
    apiKey,
    contextWindow: positiveInteger(env, "EXPLORER_CONTEXT_WINDOW", 128000),
    maxTokens,
    // compaction.maxTokens 就是普通回复预算，不是摘要预算（compactionMaxTokens）。
    compaction: { ...loadCompactionOptions(env), maxTokens },
    dbPath: resolve(env.EXPLORER_DB_PATH?.trim() || "data/events.db"),
    sessionDbPath: resolve(env.EXPLORER_SESSION_DB_PATH?.trim() || "data/sessions.db"),
    userId: env.EXPLORER_USER_ID?.trim() || "local",
    sessionId: env.EXPLORER_SESSION_ID?.trim() || undefined,
    memoryInputChars: positiveInteger(env, "EXPLORER_MEMORY_INPUT_CHARS", 64_000),
    memoryDistillTimeoutMs: positiveInteger(
      env,
      "EXPLORER_MEMORY_DISTILL_TIMEOUT_MS",
      90_000,
    ),
    memoryMinUserMessages: positiveInteger(env, "EXPLORER_MEMORY_MIN_USER_MESSAGES", 3),
    subagentMaxConcurrent: positiveInteger(env, "EXPLORER_SUBAGENT_MAX_CONCURRENT", 8),
    subagentTimeoutMs: positiveInteger(env, "EXPLORER_SUBAGENT_TIMEOUT_MS", 120_000),
    amapKey: env.EXPLORER_AMAP_KEY?.trim() || undefined,
    amapTransitCity: env.EXPLORER_AMAP_TRANSIT_CITY?.trim() || undefined,
    routeTransitThresholdM: positiveInteger(
      env,
      "EXPLORER_ROUTE_TRANSIT_THRESHOLD_M",
      3000,
    ),
  };
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return number;
}
