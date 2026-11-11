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
