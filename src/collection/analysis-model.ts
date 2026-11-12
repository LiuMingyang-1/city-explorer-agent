import { createPilotApi } from "./pilot-api.ts";
import type { ApiOptions } from "./pilot-api.ts";
import type { ActivityFacts, Extractor } from "./extraction.ts";
import { venueRequestKey } from "./geocoding.ts";
import type { VerifiedLocation } from "./geocoding.ts";
import { locationQueryForFacts } from "./preparation.ts";

export interface MapPlace { id: string; name: string; address: string; adcode: string; district: string; latitude: number; longitude: number; }
export interface MapSearch { search(keywords: string): Promise<MapPlace[]>; }
const tool = { type: "function", function: { name: "amap_search", description: "在西安市搜索高德地点。可修改关键词，选择正确分店；返回原始GCJ-02坐标，不证明活动正在举办。", parameters: { type: "object", additionalProperties: false, required: ["keywords"], properties: { keywords: { type: "string", minLength: 1, maxLength: 100 } } } } };

/** Fixed-city bounded search, including pacing and one retry for a QPS refusal.
 * No local venue-name equality is used to choose a candidate: the model chooses. */
export function createAmapSearch(options: { key: string; fetch?: typeof fetch; requestLimit?: number; now?: () => string; onRequest?: (event: { elapsed_ms: number; code: string }) => void }): MapSearch {
  let requests = 0, last = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, MapPlace[]>();
  return { search(keywords) {
    const work = queue.then(async () => {
      if (typeof keywords !== "string" || !keywords.trim() || keywords.length > 100) throw new Error("INVALID_MAP_KEYWORDS");
      if (cache.has(keywords)) return structuredClone(cache.get(keywords)!);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (requests++ >= (options.requestLimit ?? 30)) throw new Error("MAP_BUDGET_EXHAUSTED");
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - last))));
        last = Date.now(); const started = last;
        const url = new URL("https://restapi.amap.com/v3/place/text");
        for (const [k,v] of Object.entries({key:options.key,keywords,city:"610100",citylimit:"true",offset:"10",page:"1",extensions:"all"})) url.searchParams.set(k,v);
        let code = "NETWORK_ERROR";
        try {
          const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
          if (!response.ok) throw new Error("MAP_HTTP_ERROR");
          const reader = response.body?.getReader(); if (!reader) throw new Error("MAP_EMPTY_RESPONSE");
          let bytes = 0; const chunks: Uint8Array[] = [];
          try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 1024*1024) { await reader.cancel(); throw new Error("MAP_RESPONSE_TOO_LARGE"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          code = String(data.infocode ?? "INVALID_RESPONSE");
          if (data.status !== "1") { if (code === "10021" && attempt === 0) continue; throw new Error(code === "10021" ? "MAP_RATE_LIMITED" : "MAP_API_REJECTED"); }
          const places: MapPlace[] = (Array.isArray(data.pois) ? data.pois : []).flatMap((p: any) => {
            const coords = typeof p.location === "string" ? p.location.split(",").map(Number) : [];
            if (!p.id || typeof p.name !== "string" || typeof p.address !== "string" || !p.address.trim() || !/^6101\d{2}$/.test(String(p.adcode)) || p.cityname !== "西安市" || coords.length !== 2 || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1]) || coords[0] < 107 || coords[0] > 110.5 || coords[1] < 33 || coords[1] > 35.5) return [];
            return [{id:p.id,name:p.name,address:`西安市${p.adname}${p.address}`,adcode:String(p.adcode),district:p.adname,longitude:coords[0],latitude:coords[1]}];
          });
          cache.set(keywords, places); return structuredClone(places);
        } finally { options.onRequest?.({elapsed_ms:Date.now()-started,code}); }
      }
      return [];
    });
    queue = work.catch(() => undefined); return work;
  } };
}

/** Registry is scoped to this extraction, never trusting model-provided coordinates.
 * A result selected under another document cannot be borrowed. */
export function createToolAnalysisExtractor(options: ApiOptions & {model?: string; map: MapSearch; now?: () => string; maxRounds?: number; maxToolCalls?: number}): Extractor {
  const api = createPilotApi(options);
  const registry = new Map<string, Map<string, MapPlace>>();
  const clock = options.now ?? (() => new Date().toISOString());
  const invoke: Extractor = async (system, input) => {
    const places = new Map<string, MapPlace>(); registry.set(input.source_url, places);
    const messages: any[] = [{role:"system",content:system},{role:"user",content:JSON.stringify(input)}];
    let calls = 0;
    for (let round = 0; round < (options.maxRounds ?? 5); round++) {
      const final = round === (options.maxRounds ?? 5)-1 || calls >= (options.maxToolCalls ?? 6);
      if (final) messages.push({role:"user",content:"本轮地点搜索已结束。现在必须输出最终JSON；能确定的字段正常填写，无法确认的地点ID和坐标填null，时间不完整写time_note。不能因查不到地点而继续搜索或编造。"});
      const response = await api.chat(options.model ?? "deepseek-flash", messages, [tool], final);
      const choice = response?.choices?.[0], message = choice?.message;
      if (!message || !["stop","tool_calls"].includes(choice.finish_reason)) throw new Error("INCOMPLETE_MODEL_RESPONSE");
      if (!message.tool_calls?.length) {
        if (typeof message.content !== "string") throw new Error("EMPTY_MODEL_RESPONSE");
        // Some tool-capable models wrap final JSON in a code fence.
        return message.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      }
      if (final || message.tool_calls.length > 20) throw new Error("ANALYSIS_ROUND_BUDGET_EXHAUSTED");
      messages.push({role:"assistant",content:message.content ?? null,tool_calls:message.tool_calls});
      for (const call of message.tool_calls) {
        let result: unknown;
        try {
          if (calls++ >= (options.maxToolCalls ?? 6)) throw new Error("MAP_TOOL_BUDGET_EXHAUSTED");
          if (call.function?.name !== "amap_search") throw new Error("UNKNOWN_TOOL");
          const args = JSON.parse(call.function.arguments);
          if (!args || Object.keys(args).some(k => k !== "keywords") || typeof args.keywords !== "string" || !args.keywords.trim() || args.keywords.length > 100) throw new Error("INVALID_MAP_KEYWORDS");
          const found = await options.map.search(args.keywords);
          for (const p of found) places.set(p.id, p);
          result = {places:found};
        } catch (error) { result = {error:error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "MAP_TOOL_FAILED"}; }
        messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});
      }
    }
    throw new Error("ANALYSIS_ROUND_BUDGET_EXHAUSTED");
  };
  invoke.locationFor = (url: string, facts: ActivityFacts): VerifiedLocation | null => {
    const p = facts.amap_poi_id ? registry.get(url)?.get(facts.amap_poi_id) : null;
    if (!p || facts.latitude !== p.latitude || facts.longitude !== p.longitude) return null;
    return {request_key:venueRequestKey(locationQueryForFacts(facts)),venue_name:facts.venue_name,address:p.address,poi_id:p.id,adcode:p.adcode,district:p.district,latitude:p.latitude,longitude:p.longitude,original:{lat:p.latitude,lng:p.longitude},input_system:"GCJ-02",system:"GCJ-02",conversion:null,source_url:"https://restapi.amap.com/v3/place/text",verified_at:clock(),method:"poi"};
  };
  return invoke;
}
