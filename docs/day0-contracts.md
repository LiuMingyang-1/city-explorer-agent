# Day 0 协调要点（简版）

2026-11-12。已确认方向：地图改用高德、保留前端 Mock、数据库不大改。先前扩展成完整协议的方案已撤回；本次未改业务代码，地图切换尚未实施。

## Agent ↔ 爬虫：沿用现有数据库

继续用 `src/data/schema.ts` 的 events 表，不提前重设计。

只对齐现有口径：时间 `YYYY-MM-DDTHH:MM`（本地）；预算单位分，0=明确免费、null=未知；数据库 image_urls 为 JSON 字符串数组。

以后增加小表或可选字段，按实际需求补查询/上下文即可，不作为开工前置。必填放宽为选填通常是小改，但使用该字段的读取、校验或展示需一并处理 null，不能保证自动完全兼容。

## 地图：决定统一改用高德（待实施）

前端地图从 OpenFreeMap/OSM 改为高德 JS API；地点搜索、场馆地理编码和路线规划统一使用高德，相关数据统一 GCJ-02。数据库继续沿用原有经纬度列，无需因此重设计表。

高德返回的坐标直接使用；外部 GPS/WGS-84 来源在入口用官方 `AMap.convertFrom` 转一次。现有坐标须按来源核对和转换，不直接重新贴标签。无需追求测绘精度，用少量点和路线确认没有明显偏移即可。

实施时适配地图初始化、标记、折线、视野控制与地点搜索，并配置 JS API Key/安全密钥。本次仅确定方向，尚未切换运行中的地图。

参考：[高德官方坐标转换](https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom)、[JS API 准备](https://lbs.amap.com/api/javascript-api-v2/prerequisites)。

## Agent ↔ 前端：先用样例开发组件

[Mock 目录](mocks/day0/) 已保留。重点看：

- [双方案](mocks/day0/response-comparison.json)
- [单方案](mocks/day0/response-single.json)
- [SSE 阶段样例](mocks/day0/stream.sse)

前端可以先用样例做活动卡、A/B 切换、地图轨迹。样例里的版本、revision、request_id 等扩展字段暂不作为接口实施要求；不要求现在开发 v2 接口、幂等、版本冲突或历史协议。

样例目前标 WGS84，活动与轨迹均为虚构展示数据。实施高德切换时将样例坐标与标识统一调整为 GCJ-02；真实数据需实际转换，不能只改坐标标签。
