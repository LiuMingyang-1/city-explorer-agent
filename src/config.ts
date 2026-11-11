import { resolve } from "node:path";

export interface ExplorerConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  /** 自定义端点目录元数据的本地默认；标准 provider 用其自带目录。 */
  contextWindow: number;
  maxTokens: number;
  /** SQLite 活动库文件路径。 */
  dbPath: string;
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
  return {
    provider,
    model: model || (provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.4"),
    baseUrl,
    apiKey,
    contextWindow: positiveInteger(env, "EXPLORER_CONTEXT_WINDOW", 128000),
    maxTokens: positiveInteger(env, "EXPLORER_MAX_TOKENS", 4096),
    dbPath: resolve(env.EXPLORER_DB_PATH?.trim() || "data/events.db"),
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
