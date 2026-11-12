/** Stage 0 design artifact: not imported by application runtime. */
export type Platform = "web" | "xiaohongshu" | "douyin" | "weibo" | "wechat" |
  "bilibili" | "douban" | "huodongxing" | "showstart" | "damai" | "maoyan" |
  "bendibao" | "ctrip" | "mafengwo" | "publisher";
export interface AdapterCapabilities {
  channel: string;
  platforms: Platform[];
  filters: ("keyword" | "category" | "date" | "city")[];
  pagination: boolean;
  maxPageSize: number;
  maxConcurrency: number;
  state: "unverified" | "enabled" | "disabled";
}
export interface AdapterQuery {
  keyword?: string;
  category?: string;
  date?: string;
  city: "西安市";
  platforms: Platform[];
  limit: number;
  providerCursor?: string;
}
export interface SearchHit {
  platform: Platform;
  platformContentId: string | null;
  url: string;
  title: string;
  snippet: string;
  author: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  rank: number;
}
export interface AdapterContext {
  signal: AbortSignal;
  deadlineAt: number; // Unix milliseconds; child deadline must not exceed parent.
}
export interface AdapterPage {
  hits: SearchHit[];
  nextProviderCursor: string | null;
  appliedFilters: string[];
  limitations: string[];
}
export interface SearchAdapter {
  readonly capabilities: AdapterCapabilities;
  search(query: AdapterQuery, context: AdapterContext): Promise<AdapterPage>;
}
/** Dependency boundary. Adapters never write SQL or generate planner event IDs. */
export interface SearchService<Request, Response> {
  search(request: Request, context: AdapterContext): Promise<Response>;
}
/** Implement at stage 5; transaction includes evidence, activities and time slots. */
export interface ActivityPublisher<PublicationBatch> {
  publish(batch: PublicationBatch, context: AdapterContext): Promise<{ eventIds: string[] }>;
}
// Expected adapter errors: TIMEOUT, RATE_LIMITED, AUTH_FAILED, UPSTREAM_ERROR,
// UNSUPPORTED_FILTER, INVALID_RESPONSE. Cancellation propagates AbortError.
// Retry scheduling, caches and publication belong to orchestrator, not adapters.
