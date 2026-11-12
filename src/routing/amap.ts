/**
 * 高德 Web 服务算路客户端：步行 v3/direction/walking、
 * 公交 v3/direction/transit/integrated。实现 ./types.ts 的 RouteComputer
 * 接缝；单请求硬超时默认 8s（契约要求单 leg ≤8s），可注入 fetch 桩离线测试。
 */
import type { GeoPoint, LegGeometry, RouteComputer, RouteRequest } from "./types.ts";

/** 高德 REST 端点前缀。 */
const DEFAULT_BASE_URL = "https://restapi.amap.com";
const WALKING_PATH = "/v3/direction/walking";
const TRANSIT_PATH = "/v3/direction/transit/integrated";
/** 单次算路请求硬超时缺省（毫秒），契约上限 8s。 */
export const DEFAULT_AMAP_TIMEOUT_MS = 8_000;

/**
 * 算路失败错误：code 是稳定的机读错误码，写入 PlanLeg.error_code /
 * estimate_travel 的 error_code——timeout / aborted / network_error /
 * http_error / amap_error / no_path / bad_response。
 */
export class AmapRoutingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AmapRoutingError";
    this.code = code;
  }
}

export interface AmapRouterOptions {
  /** 高德 Web 服务 REST key。 */
  key: string;
  /**
   * 公交接口的必填 city 参数（城市名或 citycode，如 "西安"/"029"）；
   * 缺省不带该参数——步行不受影响，公交多半报 MISSING_REQUIRED_PARAMS
   * 并降级为 error leg。部署按演示城市配置。
   */
  city?: string;
  /** fetch 实现注入点（测试桩）；缺省全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 单次请求硬超时（毫秒）；缺省 8000。 */
  timeoutMs?: number;
  /** REST 端点前缀；缺省 https://restapi.amap.com。 */
  baseUrl?: string;
}

/** 高德 polyline 字段 "lng,lat;lng,lat;…" → GeoJSON coordinates（GCJ-02 直用）；坏点跳过。 */
export function decodePolyline(text: string): [number, number][] {
  const points: [number, number][] = [];
  for (const pair of text.split(";")) {
    const [lng, lat] = pair.split(",");
    const x = Number(lng);
    const y = Number(lat);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

/** 递归收集响应里全部字符串 polyline 字段（walking steps / buslines / railway 等）。 */
function collectPolylines(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPolylines(item, out);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "polyline" && typeof value === "string") out.push(value);
      else collectPolylines(value, out);
    }
  }
}

function geometryOf(node: unknown): LegGeometry | null {
  const polylines: string[] = [];
  collectPolylines(node, polylines);
  const coordinates: [number, number][] = [];
  // 分段 polyline 首尾相接处坐标重复，去掉连续重复点拼成一条线。
  for (const point of polylines.flatMap(decodePolyline)) {
    const last = coordinates.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) coordinates.push(point);
  }
  return coordinates.length > 0 ? { type: "LineString", coordinates } : null;
}

/** 高德要求经纬度小数点 ≤6 位。 */
function fmtPoint(point: GeoPoint): string {
  return `${Number(point.lng.toFixed(6))},${Number(point.lat.toFixed(6))}`;
}

function firstEntry(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === "object") {
    return value[0] as Record<string, unknown>;
  }
  return undefined;
}

function numericField(node: Record<string, unknown>, key: string): number {
  const value = Number(node[key]);
  if (!Number.isFinite(value) || value < 0) {
    throw new AmapRoutingError("bad_response", `高德响应 ${key} 字段非法`);
  }
  return value;
}

/**
 * 建高德算路器。key 缺失时不要调用——装配层按 config.amapKey 决定是否
 * 挂载/启用，客户端本身不做降级（降级语义在 legs.ts / travel-tool.ts）。
 */
export function createAmapRouter(options: AmapRouterOptions): RouteComputer {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AMAP_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!options.key) {
    throw new AmapRoutingError("bad_response", "createAmapRouter 需要非空高德 key");
  }

  async function getJson(url: string, timeout: AbortSignal, signal?: AbortSignal) {
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response: Response;
    try {
      response = await fetchFn(url, { signal: combined });
    } catch (error) {
      if (timeout.aborted) {
        throw new AmapRoutingError("timeout", `高德算路超时（${Math.round(timeoutMs / 1000)}s）`);
      }
      if (combined.aborted) {
        throw new AmapRoutingError("aborted", "请求已取消");
      }
      throw new AmapRoutingError("network_error", `高德请求失败：${String(error)}`);
    }
    if (!response.ok) {
      throw new AmapRoutingError("http_error", `高德 HTTP ${response.status}`);
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new AmapRoutingError("bad_response", "高德响应不是合法 JSON");
    }
  }

  function requestUrl(path: string, request: RouteRequest): string {
    const params = new URLSearchParams({
      key: options.key,
      origin: fmtPoint(request.origin),
      destination: fmtPoint(request.destination),
    });
    if (request.mode === "transit" && options.city) params.set("city", options.city);
    return `${baseUrl}${path}?${params.toString()}`;
  }

  async function route(request: RouteRequest, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const path = request.mode === "walking" ? WALKING_PATH : TRANSIT_PATH;
    const json = await getJson(requestUrl(path, request), timeout, signal);
    if (json.status !== "1") {
      const detail = [json.infocode, json.info].filter(Boolean).join(" ");
      throw new AmapRoutingError("amap_error", `高德返回错误：${detail || "未知"}`);
    }
    const container = (json.route ?? {}) as Record<string, unknown>;
    // walking: route.paths[0]；transit: route.transits[0]，无方案时同样记 no_path。
    const leg = firstEntry(request.mode === "walking" ? container.paths : container.transits);
    if (!leg) {
      throw new AmapRoutingError("no_path", "高德没有返回可用路线");
    }
    const duration = leg.duration ?? container.duration;
    const distance = leg.distance ?? container.distance;
    const durationSeconds = numericField({ duration }, "duration");
    const distanceMeters = numericField({ distance }, "distance");
    return {
      durationSeconds,
      distanceMeters,
      geometry: geometryOf(leg),
    };
  }

  return {
    route: (request: RouteRequest, signal?: AbortSignal) => route(request, signal),
  };
}

/** 方便外部判定算路失败类别；非 AmapRoutingError 一律当 "route_error"。 */
export function routingErrorCode(error: unknown): string {
  return error instanceof AmapRoutingError ? error.code : "route_error";
}
