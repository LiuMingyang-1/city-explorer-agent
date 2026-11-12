import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { ExplorerConfig } from "../config.ts";
import type { EventRepository } from "../data/repository.ts";
import { createExplorerModels } from "./model.ts";
import { buildSystemPrompt, localToday } from "./prompt.ts";
import { createSearchEventsTool } from "./tools.ts";

export interface ExplorerAgentOptions {
  config: ExplorerConfig;
  repository: EventRepository;
  /**
   * "今天"（YYYY-MM-DD），写进系统提示用于解释相对日期；
   * 缺省取本机当前日期，测试可固定。
   */
  currentDate?: string;
  /**
   * 覆盖默认的模型流式实现（缺省 models.streamSimple + maxTokens 钳制）。
   * 离线集成测试注入 pi-ai 的 faux provider 流即可跑通真实工具链。
   */
  streamFn?: StreamFn;
  /**
   * 追加挂载的工具（编排层在 depth<上限 时注入 delegate_task）；
   * 缺省只挂 search_events。
   */
  extraTools?: AgentTool<any, any>[];
  /**
   * 系统提示是否附加 delegate_task 派发准则；应与 extraTools 里实际
   * 是否挂了 delegate_task 保持一致，避免提示词提到不存在的工具。
   */
  canDelegate?: boolean;
}

/**
 * 组装 Pi Agent：模型接入走 src/agent/model.ts 的 createExplorerModels
 * （与本机 Rudy 已跑通的方式一致），getApiKey 直接回配置里的密钥。
 * 只挂 search_events 一个工具；输出契约由系统提示固定。
 * 多轮输入用 prompt()；运行中追加用 steer()；等当前轮结束用 followUp()。
 */
export async function createExplorerAgent(options: ExplorerAgentOptions): Promise<Agent> {
  const { config } = options;
  const { models, model } = createExplorerModels(config);
  const streamFn: StreamFn =
    options.streamFn ??
    ((m, context, streamOptions) =>
      models.streamSimple(m, context, {
        ...streamOptions,
        maxTokens: streamOptions?.maxTokens ?? Math.min(config.maxTokens, m.maxTokens),
      }));
  return new Agent({
    initialState: {
      model,
      systemPrompt: buildSystemPrompt(options.currentDate ?? localToday(), {
        canDelegate: options.canDelegate,
      }),
      tools: [createSearchEventsTool(options.repository), ...(options.extraTools ?? [])],
    },
    streamFn,
    getApiKey: () => config.apiKey,
  });
}
