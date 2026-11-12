export type Platform = "web" | "xiaohongshu" | "douyin" | "weibo" | "wechat" | "bilibili" | "douban" | "huodongxing" | "showstart" | "damai" | "maoyan" | "bendibao" | "ctrip" | "mafengwo" | "publisher";
export interface SearchRequest { date?: string; category?: string; keyword?: string; mode?: "local" | "external" | "hybrid"; platforms?: Platform[]; limit?: number; freshness?: "cached" | "refresh"; cursor?: string; }
export type NormalRequest = SearchRequest & { mode: "local" | "external" | "hybrid"; limit: number; freshness: "cached" | "refresh" };
export interface Context { signal: AbortSignal; deadlineAt: number; scopeKey: string; }
export interface Clock { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void>; }
export interface SearchHit { platform: Platform; platformContentId: string | null; url: string; title: string; snippet: string; author: string | null; publishedAt: string | null; retrievedAt: string; rank: number; }
export interface AdapterQuery { keyword?: string; category?: string; date?: string; city: "西安市"; platforms: Platform[]; limit: number; providerCursor?: string; }
export interface AdapterPage { hits: SearchHit[]; nextProviderCursor: string | null; appliedFilters: string[]; limitations: string[]; }
export interface SearchAdapter { capabilities: { channel: string; platforms: Platform[]; filters: string[]; pagination: boolean; maxPageSize: number; maxConcurrency: number; state: "unverified" | "enabled" | "disabled" }; search(query: AdapterQuery, context: Context): Promise<AdapterPage>; }
export interface SearchErrorView { channel: string | null; code: string; retryable: boolean; }
export interface Coverage { platform: string; channel: string; mode: "local" | "cache" | "web_search" | "platform_search"; status: "success" | "timeout" | "error" | "unsupported" | "cancelled"; count: number; cache_age_seconds: number | null; applied_filters: string[]; limitations: string[]; }
export interface DocumentResult { kind: "document"; result_id: string; document_id: string; platform: string; title: string; url: string; snippet: string; author: string | null; published_at: string | null; retrieved_at: string; channels: string[]; city_status: "unknown"; date_status: "unknown"; plannable: false; limitations: string[]; event: null; }
export interface SearchResponse { schema_version: "1.0"; search_id: string; status: "success" | "partial" | "failed" | "cancelled"; city: "西安市"; timezone: "Asia/Shanghai"; effective_request: NormalRequest; results: DocumentResult[]; coverage: Coverage[]; partial: boolean; errors: SearchErrorView[]; truncated: boolean; next_cursor: string | null; }
export interface CollectedHit { hit: SearchHit; channel: string; query: string; priority: number; }
export class SearchRequestError extends Error { code: string; constructor(code = "INVALID_REQUEST") { super(code); this.code = code; } }
export class SearchStorageError extends Error { constructor(options?: ErrorOptions) { super("SEARCH_STORAGE_ERROR", options); } }
export class ChannelError extends Error { code: string; retryAfterMs: number; constructor(code: string, retryAfterMs = 0) { super(code); this.code = code; this.retryAfterMs = retryAfterMs; } }
