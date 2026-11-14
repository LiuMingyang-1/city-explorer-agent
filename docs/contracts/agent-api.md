# Agent 侧实现契约（2026-11-12 定稿）

本文是 docs/planning/roadmap.md 中 Agent 同学 P0/P1 任务的实施契约，
四个并行工作流共同遵守；Mock 见 docs/mocks/day0/，语义以此文为准
（Mock 中 schema_version / request_id / revision / base_revision / STALE_PLAN
等扩展字段本期不实现）。

## 0. 坐标系

- 全链路统一 **GCJ-02**：events 表经纬度、API 出入参、轨迹 polyline 一律 GCJ-02。
- 前端传入的 `location` 视为已由前端转成 GCJ-02；后端不做坐标转换。
- 响应中固定带 `coordinate_system: "GCJ-02"`。

## 1. POST /api/chat 请求体扩展

在现有 `{message, location?, session_id?}` 上新增两个可选字段：

```json
{
  "message": "就选 B，但把最后一站换个室内的",
  "session_id": "sess_…",
  "active_plan": "B",
  "referenced_event_id": "evt_123"
}
```

- `active_plan`：当前滑块选中的 plan_id（"A" 或 "B"）。服务端把它注入本轮
  prompt 上下文（类似 location_context 的 system section），消歧“改一下/第二站”
  等指代。仅在会话最近一轮产出过 comparison 时有意义；否则忽略。
- `referenced_event_id`：地图气泡点选带入的活动 id。服务端查库取标题/场馆后
  注入 prompt 上下文（“用户从地图点选了活动 …”）；查无此 id → 400 或忽略，
  取**忽略并继续**（点选是弱上下文，不该让请求失败）。

字段校验与现有 parseChatSend 一致风格：多出其他键仍拒绝；两个新字段均为
可选 string（trim 后 1..128 字符）。

## 2. POST /api/chat 响应（ChatResult）

```ts
type ChatResult =
  | { kind: "clarification"; session_id: string; question: string }
  | { kind: "answer"; session_id: string; text: string; warnings?: string[] }
  | {
      kind: "plans";
      session_id: string;
      mode: "single" | "comparison";
      active_plan: string;              // 当前生效 plan_id，默认 "A"
      plans: Plan[];
      events: EventView[];              // 全部 plan 引用活动的去重并集
      coordinate_system: "GCJ-02";
      warnings?: string[];
    };

interface Plan {
  plan_id: string;                      // 与 label 同值："A" 或 "B"；single 恒 "A"
  label: "A" | "B";
  title: string;                        // 方案一句话标题，如“曲江看展阅读线”
  itinerary: Itinerary;                 // 既有 {date, summary, stops[]}
  legs: PlanLeg[];                      // stops 相邻两站间的道路段，stops-1 条
  validation: { status: "passed" | "issues"; scope: "inter_stop"; issues: unknown[] };
  warnings: string[];
}

interface PlanLeg {
  from_event_id: string;
  to_event_id: string;
  mode: "walking" | "transit";
  status: "ok" | "error" | "skipped";
  provider: "amap" | "none";
  duration_seconds: number | null;
  distance_meters: number | null;
  buffer_seconds: number;               // 默认 300
  geometry: { type: "LineString"; coordinates: [number, number][] } | null; // [lng,lat] GCJ-02
  error_code: string | null;
}
```

- `kind:"answer"` 是普通问答/讨论（Issue #19）：只携带 `text` 回答文本；
  服务端不装配方案、不触发 legs 算路与校验、不更新当前行程
  （committed itinerary 指针）与已确认约束；前端渲染为普通聊天气泡，
  不新增行程卡片、不重绘地图。
- `mode:"single"` 时 plans 恰 1 条（label "A"，title 可取 itinerary.summary）。
- 原 `kind:"itinerary"` 响应形态废弃，统一走 `kind:"plans"`。
- legs 由服务端在模型输出校验通过后计算（模型不输出 legs）；算路失败
  不阻塞响应：该 leg `status:"error"`、`provider:"none"`、geometry null，
  并在 plan.warnings / 顶层 warnings 说明。
- GET /api/chat/history 扩展：`{messages, itinerary, plans?, mode?, active_plan?, events?}`。
  `itinerary` 始终为当前生效（committed）行程，保持向后兼容；
  `plans`/`mode`/`active_plan` 由会话最近一个**非 answer** 轮决定——
  该轮为 comparison 或 itinerary 时还原方案视图（为 clarification 等
  其他终态时不还原，与既有行为一致）。answer 轮以普通 assistant
  消息进入 `messages` 照常持久化恢复，不参与上述判定——普通回答后
  当前行程仍是此前有效方案。

## 3. 模型输出契约（envelope）扩展

现有 `clarify` / `itinerary` 两形态不变，新增第三形态：

```json
{"type":"comparison",
 "constraints":{"date":"YYYY-MM-DD","availableStart":"HH:MM","availableEnd":"HH:MM"},
 "plans":[
   {"label":"A","title":"…","itinerary":{"date":"…","summary":"…","stops":[…]}},
   {"label":"B","title":"…","itinerary":{"date":"…","summary":"…","stops":[…]}}]}
```

- 仅当用户诉求开放/多方向比选时使用（通常由并行 delegate_task 子任务产出后
  汇总）；明确诉求仍用单 itinerary 形态，不强凑双方案。
- plans 恒 2 条、label 恰为 "A"/"B"；共享同一 constraints。
- 服务端校验：每个 plan.itinerary 独立跑 validateItinerary；两个都过 →
  comparison 轮成功；只过一个 → 降级为 single（取通过者，附 warning）；
  都不过 → 按现有纠正循环回喂（错误信息标注是哪个 plan 的问题）。
- PlannerTurn 新增 `{kind:"comparison", plans:[{label,title,itinerary}…], constraints, warning?}`。
- 提交语义：comparison 轮把 **active（首个）plan** 的 itinerary 提交到
  current_itinerary 指针，保证“当前行程”始终有定义；用户后续轮次收敛为
  single 后正常覆盖。

Issue #19 起新增第四形态 answer（普通问答）：

```json
{"type":"answer","text":"用中文完整回答"}
```

- 意图选择：询问信息、解释原因、讨论现有方案 → answer；明确要求生成、
  修改或替换行程 → itinerary/comparison；意图不清、无法判断是否要求
  修改行程 → clarify。历史上生成过行程不代表后续每轮都必须出卡片。
- answer 轮可先调用 web_search / search_events 等工具核实再答（天气、
  营业、预约等实时问题先查再答，`text` 给出必要来源）；联网未配置、
  查询失败或无可靠结果时如实说明无法核实，不编造、不借机输出新行程。
- 执行边界由代码保证：answer 只追加聊天记录，不更新当前行程、已确认
  约束与规划历史，不新增方案卡片/规划条目，不触发算路与地图重定位；
  该轮照常持久化，刷新/重开会话可恢复；后续修改行程仍基于原方案上下文。
- PlannerTurn 新增 `{kind:"answer", text, warning?}`；委派子任务返回
  answer 视为未完成（按 failed 回报并附回答摘要），父 Agent 按既有
  降级准则自行兜底。

## 4. POST /api/chat/stream（SSE）

请求体与 POST /api/chat 完全相同；响应 `Content-Type: text/event-stream`，
`Cache-Control: no-store`。事件序列：

```
event: meta      data: {"session_id":"…"}                    // 会话确定后立即发
event: progress  data: {"stage":"searching_events","message":"正在检索活动","plan_ids":[]}
event: progress  data: {"stage":"exploring_plans","message":"正在并行探路方案 A 与方案 B","plan_ids":["A","B"]}
event: progress  data: {"stage":"routing","message":"正在获取站间道路路线","plan_ids":[…]}
event: progress  data: {"stage":"validating_schedule","message":"正在校验路线时间","plan_ids":[…]}
event: result    data: <ChatResult JSON，同 /api/chat 响应>
event: error     data: {"error":{"code":"…","message":"…","retryable":false}}
```

- stage 枚举：`searching_events` | `exploring_plans` | `routing` | `validating_schedule`。
  由服务端从 Agent 工具执行事件推导：search_events 首次调用 → searching_events；
  delegate_task 执行中 → exploring_plans；行程校验/纠正 → validating_schedule；
  legs 算路 → routing。clarification/answer 轮可不发 progress；轮内
  工具调用仍按上表推导（web_search 无对应 stage）。
- 心跳：每 15s 一行 `: ping` 注释。
- 客户端断连 → 与 /api/chat 相同的 abort 语义；正常 result/error 事件后关闭流。
- POST /api/chat 旧端点保留不变（前端可择一接入）。

## 5. GET /api/events（近期活动只读）

`GET /api/events?date=YYYY-MM-DD | from=YYYY-MM-DD&to=YYYY-MM-DD [&bbox=minLng,minLat,maxLng,maxLat] [&limit=N]`

- date 与 from/to 二选一；都不给默认 date=今天（服务端本地日期）。
- bbox 为 GCJ-02 经纬度范围过滤，可选。
- limit 默认 200、上限 500。
- 响应 `{"events": EventView[]}`（EventView 即现有契约，坐标 GCJ-02）。

## 6. /api/memory（user_memory 读写删）

同一 cookie 用户维度：

- `GET /api/memory` → `{"content": string, "updated_at": string|null}`；
  无记录 → `{"content":"", "updated_at":null}`。
- `PUT /api/memory` body `{"content": string}`（trim 后 1..8000 字符）→
  `{"content", "updated_at"}`；覆盖式更新，服务端不解析小节结构。
- `DELETE /api/memory` → 204；清除该用户记忆（可实现为 SessionRepository
  新增 deleteUserMemory，或写回空文档）。
- 写接口与 /api/chat 同样做 Origin 同源校验 + JSON media-type 校验；
  PUT 超 16KiB → 413。

## 7. 高德算路（src/routing/）

- 新增配置：`EXPLORER_AMAP_KEY`（REST key）；缺省时算路全部降级
  （legs status "skipped"/"error"、工具返回不可用），不阻塞规划。
- REST 接口：步行 `https://restapi.amap.com/v3/direction/walking`，
  公交 `https://restapi.amap.com/v3/direction/transit/integrated`；
  单 leg 超时 ≤8s；plan 内多 leg 可并行计算。
- mode 选择：站间直线距离 ≤3km 用 walking，否则 transit
  （阈值可配 `EXPLORER_ROUTE_TRANSIT_THRESHOLD_M`，默认 3000）。
- polyline 字段 "lng,lat;lng,lat;…" 解码为 GeoJSON coordinates（GCJ-02 直用）。
- Agent 工具 `estimate_travel`：参数 `{from_event_id, to_event_id, mode?}`，
  返回 `{duration_seconds, distance_meters, mode}`；供模型排期时核对站间耗时。
  未配置 key 时工具不挂载或返回结构化不可用错误。

## 8. 文件归属约定（减少合并冲突）

| 工作流 | 主要新文件 | 允许修改的共享文件 |
| --- | --- | --- |
| amap-routing | `src/routing/**`、`src/agent/travel-tool.ts`、`test/routing*.test.ts` | config.ts、service.ts（仅 legs 调用点）、explorer-agent.ts/session.ts（仅挂工具）、prompt.ts（仅算路说明段落） |
| plans-contract | `test/plans*.test.ts` 等 | prompt.ts、response.ts、session.ts、itinerary/**、web/types.ts、web/request.ts、web/service.ts、agent/persistent/* |
| sse-progress | `src/web/sse.ts`、`test/*sse*.test.ts` | http.ts（仅 /api/chat/stream 路由）、service.ts（仅 onProgress 参数透传）、session.ts/runtime.ts/delegate.ts（仅进度回调） |
| p1-apis | `test/*events-api*.test.ts`、`test/*memory*.test.ts` | http.ts（仅 /api/events、/api/memory 路由）、request.ts（仅新接口解析）、service.ts（仅 listEvents/memory 方法）、data/**（窗口+bbox 查询）、session/**（deleteUserMemory） |

共享文件只做自己职责内的增量修改；遇到他方已改的相邻区域，保持既有代码
原样，由指挥者合并时整合。所有 `import` 路径与代码风格沿用现有约定
（`.ts` 后缀导入、文件头中文注释块、snake_case 线上契约）。
