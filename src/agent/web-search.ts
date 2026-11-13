/**
 * web_search 工具：DeepSeek 联网搜索（POST /v1/tools/search），仅用于
 * 本地库查不到的长尾需求或排队/预约/临时闭馆/口碑等实时主观信息补盲；
 * 活动发现仍走 search_events。与 src/collection/ 夜间采集管线无关——
 * 这是面向主 Agent 的自包含小客户端，不 import 任何采集代码。
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** 工具名：web_search。 */
export const WEB_SEARCH_TOOL = "web_search";

/** DeepSeek 搜索接口固定端点（与聊天补全同一 base，Bearer 认证共用）。 */
const SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
/** 单次搜索硬超时缺省：联网调用只是补盲，不能拖住整个排期轮次。 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 请求/回传条数上限：宁少勿多，防脏上下文灌进主会话。 */
const MAX_RESULTS = 10;
const DEFAULT_COUNT = 5;
/** 单条摘录硬截断（字符）：DeepSeek 的 summary 通常 600–800 字，截到 500。 */
const MAX_SNIPPET_CHARS = 500;
/** DeepSeek query 上限 128 字符；超出本地截断，不白跑一次 400。 */
const MAX_QUERY_CHARS = 128;

/** 收口后回给模型的单条结果。 */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** 工具结果载荷（content 为它的 JSON 序列化，details 同源）。 */
export interface WebSearchDetails {
  query?: string;
  results?: WebSearchResultItem[];
  error?: string;
}

export interface WebSearchToolOptions {
  /** DeepSeek API key；缺省时工具仍可挂载，execute 返回未配置 isError。 */
  apiKey?: string;
  /** 可注入的 fetch 实现（测试桩）；缺省全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 整体硬超时（毫秒）；缺省 10_000。 */
  timeoutMs?: number;
}

const webSearchParameters = Type.Object({
  query: Type.String({
    description:
      "搜索查询（1–128 字符）：写成具体的中文检索词并带上城市名与关键对象" +
      '（如"西安 陕历博 预约 需要提前几天"），支持 site:/"引号短语"/after: 等操作符。',
  }),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_RESULTS,
      description: `返回条数 1–${MAX_RESULTS}；缺省 ${DEFAULT_COUNT}，超出会被收敛。`,
    }),
  ),
});

function toResult(details: WebSearchDetails): AgentToolResult<WebSearchDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    structuredContent: details as unknown as JsonValue,
    isError: details.error !== undefined,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** 摘录清洗：压平空白防整页换行灌入，再硬截断。 */
function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SNIPPET_CHARS
    ? `${collapsed.slice(0, MAX_SNIPPET_CHARS)}…`
    : collapsed;
}

/**
 * 响应收口：results 必须是数组，否则视为响应畸形；缺 title/url 的条目丢弃；
 * 摘录优先取面向模型阅读的 summary，退 snippet/content；总数 ≤10。
 */
function parseResults(body: unknown): WebSearchResultItem[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return undefined;
  const items: WebSearchResultItem[] = [];
  for (const raw of results) {
    if (items.length >= MAX_RESULTS) break;
    if (typeof raw !== "object" || raw === null) continue;
    const { title, url, summary, snippet, content } = raw as Record<string, unknown>;
    if (typeof title !== "string" || typeof url !== "string" || !title || !url) continue;
    items.push({ title, url, snippet: excerpt(firstText(summary, snippet, content)) });
  }
  return items;
}

/**
 * 组装 web_search 工具：query/count → DeepSeek 搜索 → 收口 JSON。
 * 无 key、HTTP 非 2xx、超时/取消、网络错误、响应畸形一律 isError +
 * 简明 error 字段，绝不 throw 污染父 Agent；模型据此按无搜索结果降级。
 */
export function createWebSearchTool(
  options: WebSearchToolOptions = {},
): AgentTool<typeof webSearchParameters, WebSearchDetails> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: WEB_SEARCH_TOOL,
    label: "Web search",
    description:
      "联网搜索（DeepSeek）。仅当本地活动库查不到的长尾需求，或需要排队/预约/" +
      "临时闭馆/口碑避雷等实时主观信息时使用；发现活动、挑选行程站点一律用 search_events，" +
      "搜索结果不得当作活动排进 itinerary。" +
      "返回 {query, results:[{title,url,snippet}]}；带 error 时按无搜索结果处理。",
    parameters: webSearchParameters,
    execute: async (_toolCallId, params, signal) => {
      const rawQuery = typeof params.query === "string" ? params.query.trim() : "";
      if (!rawQuery) return toResult({ error: "query 不能为空" });
      const query = rawQuery.slice(0, MAX_QUERY_CHARS);
      const apiKey = options.apiKey?.trim();
      if (!apiKey) {
        return toResult({ query, error: "联网搜索未配置（缺 EXPLORER_WEB_SEARCH_KEY）" });
      }
      const rawCount =
        typeof params.count === "number" && Number.isFinite(params.count)
          ? params.count
          : DEFAULT_COUNT;
      const count = Math.min(Math.max(Math.trunc(rawCount), 1), MAX_RESULTS);
      const fetchFn = options.fetchFn ?? fetch;
      // 本地硬超时与调用方 signal（用户取消/断连）联合；事后按各自
      // aborted 标记区分超时还是取消，文案分开写。
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        const response = await fetchFn(SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          // need_content=false：整页正文太大，summary/snippet 已够补盲。
          body: JSON.stringify({ query, count, need_content: false }),
          signal: combined,
        });
        if (!response.ok) {
          return toResult({ query, error: `联网搜索失败（HTTP ${response.status}）` });
        }
        const results = parseResults(await response.json());
        if (results === undefined) {
          return toResult({ query, error: "联网搜索响应格式异常" });
        }
        return toResult({ query, results });
      } catch (error) {
        return toResult({
          query,
          error: timeout.aborted
            ? `联网搜索超时（${Math.round(timeoutMs / 1000)}s）`
            : signal?.aborted
              ? "搜索请求已取消"
              : `联网搜索失败：${errorText(error)}`,
        });
      }
    },
  };
}
