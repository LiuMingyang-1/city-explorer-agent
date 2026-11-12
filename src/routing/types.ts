/**
 * 站间算路的共享内部类型（camelCase，非线上契约）；
 * 线上 PlanLeg 契约（snake_case）见 ./legs.ts。
 */

/** GCJ-02 坐标点；全链路不做坐标转换。 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** 站间出行方式；与线上 PlanLeg.mode 一致。 */
export type TravelMode = "walking" | "transit";

/** GeoJSON LineString（[lng,lat] 对，GCJ-02）。 */
export interface LegGeometry {
  type: "LineString";
  coordinates: [number, number][];
}

/** 一次算路请求。 */
export interface RouteRequest {
  origin: GeoPoint;
  destination: GeoPoint;
  mode: TravelMode;
}

/** 算路成功结果；geometry 可能为空（接口未给轨迹点）。 */
export interface RoutedLeg {
  durationSeconds: number;
  distanceMeters: number;
  geometry: LegGeometry | null;
}

/**
 * 算路器接缝：高德客户端与测试桩都实现它。
 * 实现方失败时抛错（高德实现抛带 code 的 AmapRoutingError），
 * signal 用于上层取消透传（可选）。
 */
export interface RouteComputer {
  route(request: RouteRequest, signal?: AbortSignal): Promise<RoutedLeg>;
}
