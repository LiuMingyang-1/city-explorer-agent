import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { ExplorerConfig } from "../config.ts";
import type { EventRepository } from "../data/repository.ts";
import { createAmapRouter } from "../routing/amap.ts";
import type { RouteComputer } from "../routing/types.ts";
import { createExplorerModels } from "./model.ts";
import { buildSystemPrompt, localToday } from "./prompt.ts";
import { createSearchEventsTool } from "./tools.ts";
import { createEstimateTravelTool } from "./travel-tool.ts";
import { createWebSearchTool } from "./web-search.ts";

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
   * 缺省不追加。
   */
  extraTools?: AgentTool<any, any>[];
  /**
   * 系统提示是否附加 delegate_task 派发准则；应与 extraTools 里实际
   * 是否挂了 delegate_task 保持一致，避免提示词提到不存在的工具。
   */
  canDelegate?: boolean;
  /**
   * 站间算路器注入点：测试可注入桩实现，或显式 null 强制关闭算路；
   * 缺省（undefined）按 config.amapKey 自动建高德客户端——有 key 挂
   * estimate_travel 工具并附系统提示算路准则；无 key 两者都不挂
   * （全链路降级，模型按无算路留缓冲，不阻塞规划）。
   */
  travelRouter?: RouteComputer | null;
  /**
   * 联网搜索 fetch 注入点：测试可注入桩实现，或显式 null 强制关闭；
   * 缺省（undefined）按 config.webSearchKey 决定——有 key 挂 web_search
   * 工具并附系统提示搜索准则；无 key 两者都不挂（实时信息诉求由模型
   * 自行说明无法核实，不阻塞规划）。key 仍缺时挂载的工具 execute
   * 返回未配置 isError，不 throw。
   */
  webSearchFetch?: typeof fetch | null;
}

/**
 * 组装 Pi Agent：模型接入走 src/agent/model.ts 的 createExplorerModels
 * （与本机 Rudy 已跑通的方式一致），getApiKey 直接回配置里的密钥。
 * 必挂 search_events；estimate_travel/web_search 按 key 降级挂载。
 * 输出契约由系统提示固定。
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
  // 算路降级链：显式注入优先；缺省按 config.amapKey 自动建高德客户端，
  // 无 key → 不挂工具且提示词维持「无路线计算工具」旧段落。
  const router =
    options.travelRouter !== undefined
      ? options.travelRouter
      : config.amapKey
        ? createAmapRouter({ key: config.amapKey, city: config.amapTransitCity })
        : null;
  const travelTool = router
    ? createEstimateTravelTool({
        router,
        repository: options.repository,
        transitThresholdM: config.routeTransitThresholdM,
      })
    : undefined;
  // 联网搜索降级链同算路：显式注入优先；缺省按 config.webSearchKey
  // 挂载，无 key → 不挂工具，提示词也不出现该工具说明。
  const searchFetch =
    options.webSearchFetch !== undefined
      ? options.webSearchFetch
      : config.webSearchKey
        ? fetch
        : null;
  const webSearchTool = searchFetch
    ? createWebSearchTool({ apiKey: config.webSearchKey, fetchFn: searchFetch })
    : undefined;
  return new Agent({
    initialState: {
      model,
      systemPrompt: buildSystemPrompt(options.currentDate ?? localToday(), {
        canDelegate: options.canDelegate,
        canEstimateTravel: router !== null,
        canWebSearch: webSearchTool !== undefined,
      }),
      tools: [
        createSearchEventsTool(options.repository),
        ...(travelTool ? [travelTool] : []),
        ...(webSearchTool ? [webSearchTool] : []),
        ...(options.extraTools ?? []),
      ],
    },
    streamFn,
    getApiKey: () => config.apiKey,
  });
}
