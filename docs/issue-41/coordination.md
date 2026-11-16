# Issue #41 协调文档：分身生产接线 + 候选位置契约（I41-A 审计交付）

> 范围：把 #39 事件流接进 #40 编排层，并按 issue #41 验收补齐「真实候选位置 → 片区落位/点亮 → 终态收敛」所需的最小数据契约。
> 本文只做接口与分工锁定，不含产品实现。依据 HEAD `cf93342`（main，#39/#40 已合入，#38 未做——最终输出仍固定单/双方案，与分身数 1–3 无关）。

## 0. 核心结论（先看这段）

- **分身生命周期事件已齐备，缺的不是事件而是坐标**：`subagent_spawned`/`subagent_done` 不含位置；候选坐标的真实数据源有两处且都已到达现有发射点——
  1. `search_events` 的 `result.structuredContent.events`（完整 `Event[]`，`id`/`latitude`/`longitude` 恒 GCJ-02 且非空，`src/agent/tools.ts:53-59`、`src/data/types.ts:14-46`；`getByIds`/`search` 均 `latitude IS NOT NULL` 过滤，`src/data/sqlite.ts:116,190`），在 `tool_execution_end` 已传入 `toolCallEvent({result})`（`src/agent/session.ts:234-264`，`event.result` 即 `AgentToolResult` 含 `details`+`structuredContent`，pi-agent-core `types.d.ts:369-389`）；
  2. `delegate_task` 终局时 `itinerary.stops[].event_id` + 同作用域 `eventsById`（`src/agent/delegate.ts:531-552`），可在 done 发射时携带真实站点坐标。
- **采纳/落选不需后端新数据**：最终 `result` 帧已含 `plans[].itinerary.stops[].event_id` 与 `events: EventView[]`（`latitude/longitude`，`src/web/types.ts:23-32`），前端用真实 id 比对即可区分留下/灰显。
- **最小方案 = 给两个既有事件加 optional 字段**，不新增事件类型、不动 stage 帧、不动模型侧工具结果。

## 1. 候选位置契约（向后兼容增量）

### 1.1 `tool_call` 增加 `candidates`（可选键）

```json
{"type":"tool_call","tool_call_id":"tc_7","name":"search_events",
 "args_summary":"date=2026-11-14 类别=展览","result_count":12,"status":"completed",
 "duration_ms":21,"subagent_id":"sess_child_a",
 "candidates":[{"event_id":"evt_…","latitude":34.21,"longitude":108.95}, …≤16 条],
 "message":"search_events …：12 条"}
```

- 仅 `name==="search_events"` 且 `status==="completed"` 时填充；从 `result.structuredContent.events` 取 `{id→event_id, latitude, longitude}`，**校验有限数**，按结果原序取前 **N≤16**（search 上限 100，帧增量 ≈16×45B；真实总数已由 `result_count` 表达，不另加 total 字段）。同帧内 `event_id` 去重。提取不出 → 键整体省略。
- 父会话原生 `search_events` 同样携带 `candidates`（无 `subagent_id`）；#41 前端只消费盖章帧做分身落位，未盖章帧忽略（父无分身，不为它画点——最小边界）。
- `subagent_id` 盖章规则不变（最深层真实 id）；未知盖章 id 的 candidates 本期忽略（聚合指示照旧，`maxDepth=1` 下嵌套本不可能，路径仅防御保留）。

### 1.2 `subagent_done` 增加 `stops`（可选键）

```json
{"type":"subagent_done","subagent_id":"sess_child_a","plan_id":"A",
 "status":"completed","kind":"itinerary","stops_count":3,
 "stops":[{"event_id":"evt_…","latitude":…,"longitude":…}, …行程序],
 "title":"曲江看展方案","summary":"…","child_run_id":"…","child_run_status":"completed","message":"…"}
```

- 仅 `completed+itinerary` 填充：按 `itinerary.stops` 原序、以 `event_id` 经 `eventsById` 取真实经纬度；查无坐标的站如实跳过（绝不编点）。上限 ≤24（实际 stops ≤10）。
- `failed`/`cancelled`/`clarification` 恒省略；`stops_count` 语义不变。
- **不改 `DelegatedEventMeta`**：模型回传的 `details.events` 维持现状，坐标只进 SSE 事件——发射点在 `emitDone` 所在作用域已持 `eventsById`（`delegate.ts:531-552`），把 stops 数组随 `finish → emitDone → subagentDoneEvent({stops})` 透传即可，无新查询。
- **坐标系**：两个字段恒 GCJ-02（与 events 表/result.events 同源，契约 §0 全局锁定），不逐帧标 `coordinate_system`、不做二次转换。

### 1.3 实现约束

- 两字段一律在 `progress.ts` 的 `toolCallEvent`/`subagentDoneEvent` builders 内构造（保持「message 恒非空、不许手写事件」硬约定）；`summarizeToolArgs` 不变。可选键不破坏 `event.type ?? "stage"` 归一与旧消费端。
- 发射仍走 `safeEmit`；构造异常不进主链路（builders 内部对 structuredContent 做防御性取值，不抛）。

## 2. 前端事件/token 纪律（接线契约）

- `mascot-team.js` 已交付严格 token：`begin()` 发 round，`applyEvent/settle/cancel` 缺 token 抛 TypeError、stale 返回 `null`（`mascot-team.js:211-215`）。生产接线规则：
  - `deliver` 闭包内 `const {round}=facade.begin()`（facade 内嵌 `createMascotTeam`，惰性初始化一次）；
  - `onProgress` → `facade.applyEvent(progress, round)`：内部先 `team.applyEvent`，把返回 `{mainFace}` commit 到主脸控制器；再 fan-out 同帧给 `window.WanderCandidates?.applyEvent?.(progress, round)`；
  - `result` → `facade.settle(kind, round)`（kind = `data.kind`：plans/itinerary/answer/clarification 走 SETTLE_FACE；**`error` 终态 settle('error')**）；
  - 请求失败/超时/断连（isCurrent 内）→ `settle('error', round)` + `WanderCandidates.settle(null, round)`；
  - `wander:reset`/新会话/历史代际切换 → `facade.cancel(round)` + `WanderCandidates.cancel(round)`——transport 层 `isCurrent()` 已挡旧代帧，round token 是第二道闸。
- 主脸表情仍只由真实父 stage/settle 驱动（team 返回建议值，facade commit）；盖章 `tool_call` 结束事件只脉冲徽标+真实 `result_count`/`candidates` 数，**不举镜、不切 searching**。`child_run_status` 快照不参与任何前端判断（done.status 才是派发终态）。
- `plan_id` 徽标语义恒为「派发序」；最终方案归属只看 result，**不得用 plan_id 当 final plan 绑定**。

## 3. 地图候选层接口（单一坐标入口 + 图层隔离）

- **唯一转换入口**：所有候选/锚点经纬度经 `WanderAMap.convert(points, 'GCJ-02')`（现 pass-through，`amap.js:37-51`）；禁别处手拼坐标或双转。Leaflet 后备图无 GCJ→WGS 转换能力（`plans.js:78` `compatibleCoordinates` 已拒绘 GCJ-02 路线）→ **后备图下候选层整体跳过绘制**（分身在卡片侧照常，诚实降级，不画错位置）。
- **图层隔离**：候选层独立 marker 集合 + 独立 epoch，不动 `routes/routeStrokes/activityMarkers/scenes/fitLayers/selectedMarker`、不进 `updatePlaces` 标签避让体系（纯点无标签）。zIndex 带落在场景点（150）与路线标记（200/300）之间：候选点 ~160、分身锚 ~180。
- **行为**（均由真实事件驱动，无定时器业务进度）：
  - 盖章 `tool_call.candidates` 到达 → 按 `subagent_id` 归并该分身候选集（`event_id` 去重），点亮候选点；**锚点 = 该分身全部已收候选的质心**，首帧有候选时锚点（帽色点+派发序字母 chip+title tooltip）落位，后续批次 `setPosition` 更新——spawn 时无位置不飞，先留卡片；
  - `subagent_done`（completed+itinerary）→ 该分身 `stops` 短暂高亮节拍（≤600ms 装饰）；
  - `settle(result)`：`adoptedIds = ∪ plans[].itinerary.stops[].event_id`（result 真实值）→ 采纳 id 的候选点即刻移交路线层绘制（候选层移除，避免与路线点重影）；其余候选点灰显后退场；`stops` 中未被采纳者同灰显；
  - `settle(answer/clarification/error)`/`cancel`/新一轮 `begin`/`wander:reset`/`dispose` → 全量清除，不留幽灵点；
  - `WanderItineraryFocus.active`（详情视图）期间隐藏候选层（复用 `visibility()` 模式）；SDK marker 地理锚定，resize/moveend 无需重排、不泄漏。
- 「分身飞向片区」最小实现 = 锚点标记按真实候选质心落位（含落位入场动画）；克隆 DOM 跨屏 FLIP 属可选装饰增强，不作验收依据。

## 4. 卡片布局（strip）

- 主脸常驻不动；分身条容器 `#mascot-team-strip` 挂在 `.glass-card` 内**绝对定位**（卡片头行区，主脸右侧、`#new-chat` 左侧），空时 `hidden` 零占位——welcome/天气/messages/composer 完全不因它位移。
- 仅请求期间出现内容；settle/cancel 后容器复空。`≤700px`：clone 56→44px、title ≤72px、gap 10px，3 分身+title 可单行或换行（`flex-wrap` 已有），不挤 `#new-chat`；桌面同。
- 团队 CSS 仅用既有 `mascot-team.css`（`.mascot-team` scope）；strip 容器定位规则可放 `mascot-card.css` 或新增小文件，不改 `style.css` 大结构、不改 welcome。

## 5. 子任务拆分与文件归属（互不重叠）

| 子任务 | 拥有/主改文件 | 只做 | 依赖 |
| --- | --- | --- | --- |
| **I41-B 候选契约（后端）** | `src/agent/progress.ts`、`src/agent/delegate.ts`（done stops 透传）；`test/agent-progress.test.ts`、`test/agent-tool-progress.test.ts`、`test/agent-delegate-progress.test.ts`；`docs/contracts/agent-api.md` §4 样例；可选 `docs/mocks/day0/stream.sse` 补盖章候选帧 | §1 两可选字段 + builders 内构造 | 先落（锁定 wire） |
| **I41-C 卡片接线** | `frontend/mascot-card.js`（facade 内嵌 team：begin/applyEvent/settle/cancel/reset 桥接 + mainFace commit）、`frontend/chat.js`（deliver 闭包 round + onProgress/result/error 调用）、`frontend/index.html`（strip 容器 + `mascot-team.css` link + `mascot-team.js`/`candidate-preview.js` script 标签）、`frontend/mascot-card.css` 或新增 strip 样式、`test/frontend-mascot-team.test.ts`/`frontend-mascot-card.test.ts` 扩展 | §2 接线 + §4 布局 | B 契约定稿后可并行 D；index.html 由本流独占（D 的 script 名先约定） |
| **I41-D 地图候选层 + QA** | `frontend/candidate-preview.js`（新：`window.WanderCandidates` 状态机）、`frontend/amap.js`（候选 marker 集合 + epoch + dispose 清理）、`docs/issue-41/` QA 证据、可选 `test/frontend-candidates.test.ts` | §3 全部 + 验收用例 | B 定稿后；只暴露 window 全局，不改 chat.js/index.html |

`frontend/mascot-team.js` 不改（snapshot 已暴露 id/letter/palette；候选层自看同流事件推导字母，`plan_id ?? 派发序` 规则一致）。`src/agent/session.ts` 发射点不改（`result` 已在传）。

## 6. 真实验收用例（对应 issue #41 勾选框）

1. **faux e2e**（离线模型，禁真实库/付费模型）：流含 spawn×2 → 盖章 `search_events` tool_call（candidates≤16、id 真实）→ done（stops 含坐标）→ result plans ⇒ 分身 2 个 title 正确；锚点落在候选质心片区；候选点 id 与流内一致；result 采纳 id 进路线、其余灰显退场。
2. **单 itinerary 无 delegate**：零分身、零候选点，stage 照常驱动主脸。
3. **取消/超时/断连**：各路径分身按 status/轮次关闭收回；候选层全清；`wander:reset`/新聊天后无幽灵 marker。
4. **退化诚实**：`search_events` error 或 candidates 缺席/坐标缺失 → 分身留卡片工作姿态、无锚点无假点；spawn 后无位置数据期间不宣称已落片区。
5. **>3 并发**（信号量 8 真实上限）：3 可见 + `+N`，存活分身（含等待池）锚点照常落位；done 补位不错乱。
6. **reduced-motion**：静态徽标/点，无入退场与脉冲。
7. **代际**：请求中开历史/新聊天 → generation+round 双重挡旧帧；重试=全新团队与候选层。
8. **Leaflet 后备**：`WanderAMap` 未就绪时候选层静默跳过，不报错不画错位点。

## 7. I41-B 落地纪要（已锁定 wire，分支 issue41-live-mascot）

- `tool_call.candidates`：仅 `search_events`+`status:"completed"`，取自
  `result.structuredContent.events`（Event.id→`event_id`），按结果原序
  ≤`PROGRESS_CANDIDATE_LIMIT`=16、`event_id` 去重；其余工具/error/提取
  不出→字段整体省略。
- `subagent_done.stops`：仅 `completed`+`kind:"itinerary"`，按行程站序取
  真实 `eventsById` 点（`delegate.ts` 复用同一 `getByIds`，无新查询、
  模型侧 details 不增字段），≤`PROGRESS_STOP_LIMIT`=24；终态 gate 在
  emitDone 与 builder 双侧把关——close 降级 failed/取消后绝不带出。
- 逐点校验：`event_id` 非空且 ≤`PROGRESS_POINT_ID_MAX`=256 码点（**超长
  整条跳过，绝不截断冒充身份**）；`latitude` 有限数且 |lat|≤90、
  `longitude` 有限数且 |lng|≤180；缺项如实跳该项。
- 字节预算：每字段 JSON ≤`PROGRESS_POINTS_BYTE_LIMIT`=8192（UTF-8，
  逐条累加含分隔符），条数/字节任一先到即截断。
- 坐标恒 GCJ-02：与 events 表/result.events 同源直出，后端不做坐标
  转换，不把其他坐标系当 GCJ-02 写入。
- 跨作用域：`eventsById` 在行程分支内层，`emitDone/finish` 在外层——
  以 execute 闭包内 `progressStops` 暂存、发射时按最终 details 放行；
  close→DB 快照→唯一 done 与派发 details 同源不变、无多余 DB 查询。

## 8. UI/地图锁定事项落实（I41-C/D 已交付，I41-E 集成验证）

- facade：`begin()` 同步返 `{round}`；异步 import 期间缓冲 ≤400（保 spawn/
  done 优先），team 就绪按序 replay、不重复地图 fanout、末态 face 一次提交；
  `settle(result)` 接完整 result 供采纳收敛；round token 严格
  （缺抛/旧 noop/closed 拒收），`wander:reset` 代际隔离。
- 候选层 `window.WanderCandidates`（`candidate-preview.js`）：同 facade round；
  ctx 仅 team 可见分身 `{id,title,letter,palette}`+主脸 rect；身份不虚构。
  `WanderAMap.candidates` 窄 renderer（独立 marker 集+epoch，
  `convert(points,'GCJ-02')` 单入口，不 fit/pan、不动路线/活动/详情层）。
- 锚点=该分身真实候选质心，marker=真实 `boop-face`+字母 chip+title；
  spawn 无坐标不飞；离屏/focus/SDK 缺席 → `wander:candidate-anchor`
  `{round,subagent_id,anchored:false}`，卡片侧 face 恢复。
- done(completed+itinerary) stops 高亮 480ms 收锚；settle 采纳
  `∪plans[].itinerary.stops[].event_id`（含 `result.itinerary`）移交路线层、
  落选灰显 450ms 整层回收；answer/clarify/error/cancel/新轮 epoch 即刻清。
- 上限：候选 ≤32/分身、≤96 全局、stops ≤24（防御性，dropped 计数）。
- 布局：strip 按 DOM 序落在 location-status/messages 之间（flex column
  自然占位，`hidden`/`:empty` 零足迹），3 分身+长 title 在 1440~320 各
  视口与 header/messages/composer 无重叠、无横向滚动；welcome 零影响。
- reduced-motion：无 flip/脉冲动画，锚点仍真实落位，静帧标记。

## 9. 集成验证结论（I41-E，详见 verification.md）

- **状态：已集成待独立 review。** 真实链（faux provider→真实 service/
  HTTP/SSE/SQLite/delegate→真 index.html + headless Chrome）：
  stub 47/47、fallback 42/42、真实高德 SDK 47/47（`.env` JS key 只读注入，
  未打印）；`npm run check` 1003/1003、`check:frontend` 20 文件全过。
- 产物：`docs/issue-41/integration-qa/`（e2e-capture.ts 可复跑 + results
  JSON + 36 截图）；`docs/issue-41/map-qa/`（D 侧 stub/fallback 23 断言）。
- I41-E 修复：mascot-card.css 移除 flex 容器上的无效 grid 死规则；
  check:frontend 补 mascot-team/candidate-preview 语法检查接线。

## 9.1 首轮独立 review → I41-R3 修复复验

- 首轮 review（6.1-sol）：**2 P2 + 2 P3** —— 生命周期帧缓冲溢出无界、
  renderer 失败清层/锚释放不达、迟到异步渲染/import 跨轮串扰、
  closed 轮 reset 不清层。修复见 verification.md「首轮独立 review」表。
- **状态：已修待独立复审。** 复验：`npm run check` 1008/1008、
  stub/fallback 回归 47/42 全过（results-*-r3.json，首轮存 -r1.json）、
  故障注入探针 17/17（results-probe.json + probe-*.png 4 张）；
  真实高德路径未改，沿用首轮 47/47 未重跑。

## 10. QA 边界（沿用主指挥约束）

- 用户真实 8080 服务与其 DB/配置/密钥一律不碰；联调只用 faux 模型 e2e 与 mock SSE 文件（如临时起 preview 端口，醒目标注「非用户真实入口」）。QA 清理只用自己确切 PID，禁宽匹配 pkill。
