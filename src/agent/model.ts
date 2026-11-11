import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import type { ExplorerConfig } from "../config.ts";

/** createExplorerModels 的返回值：供 Agent 组装使用。 */
export interface ExplorerModels {
  /** Provider 注册表；Agent 的 streamFn 经 models.streamSimple 发起请求。 */
  models: MutableModels;
  /** 已按 provider/model 解析的聊天模型，用于 Agent.initialState.model。 */
  model: Model<Api>;
}

/**
 * 由配置构建 pi-ai provider 并解析模型；不发起模型请求。
 * 无 baseUrl 时用内置 provider（openai 为 Responses API，anthropic 为
 * Messages API）；有 baseUrl 时按 OpenAI Completions / Anthropic Messages
 * 兼容端点建单模型目录。
 */
export function createExplorerModels(config: ExplorerConfig): ExplorerModels {
  const models = createModels();
  models.setProvider(createExplorerProvider(config));
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`Unknown model: ${config.provider}/${config.model}. Check EXPLORER_MODEL.`);
  }
  return { models, model };
}

function createExplorerProvider(config: ExplorerConfig): Provider {
  if (!config.baseUrl) {
    return config.provider === "anthropic" ? anthropicProvider() : openaiProvider();
  }
  const api = config.provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  return createProvider({
    id: config.provider,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "City Explorer API key",
        resolve: async () => ({ auth: { apiKey: config.apiKey } }),
      },
    },
    models: [
      {
        id: config.model,
        name: config.model,
        provider: config.provider,
        baseUrl: config.baseUrl,
        api,
        input: ["text"],
        reasoning: false,
        // Custom endpoints have no catalog metadata; these are local defaults, not price estimates.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: Math.min(config.contextWindow, config.maxTokens),
      },
    ],
    api: api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
  });
}
