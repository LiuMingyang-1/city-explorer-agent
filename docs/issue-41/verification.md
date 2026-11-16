# Issue #41 集成验证报告（I41-E）

范围：`issue41-live-mascot` 分支上 B/C/D 三子任务的统一集成验证。
后端 HEAD `2e680c3`（候选/stops 契约），前端卡片 facade、地图候选层与本文档未提交项由本报告一并收口。

## 验证口径

- **真实链**：faux provider（`@earendil-works/pi-ai/providers/faux`，零真实模型调用）
  → 真实 `createChatService` + `createPersistentPlanner` + `delegate_task` →
  真实 HTTP `/api/chat/stream` SSE → 真实 `frontend/index.html`（headless Chrome + CDP）。
- **数据**：临时 `seedDatabase` 活动库 + 临时会话库（tmpdir），事件 id/坐标全部真实 GCJ-02。
- **地图三模式**：
  - `stub`：`map-config enabled` + CDP Fetch 注入 `map-qa/amap-stub.js`（非真实高德，标注）；
  - `fallback`：`map-config {enabled:false}` → Leaflet 路径，候选层诚实降级；
  - `real`：真实高德 JS SDK（用户 `.env` 的 `AMAP_JS_KEY`/`AMAP_SECURITY_JSCODE` 只读注入
    `mapEnv`，密钥未打印未复制；`/_AMapService` 走同源代理真实上行）。
- **模型减速**：faux 每步 +350ms（`--slow` 可调），让真实生命周期在浏览器可视；
  不改变任何事件内容与顺序。
- **隔离**：自有临时端口/DB/Chrome profile，按确切 PID 清理；
  未触碰用户 8080 服务（PID 24818）、其 DB/env、旧预览端口。

## 结果汇总

| 模式 | 断言 | 结果 |
|---|---|---|
| `stub`（amap-stub.js） | 47 | 全过 |
| `fallback`（Leaflet） | 42 | 全过 |
| `real`（真实高德 SDK） | 47 | 全过 |
| `npm run check`（tsc + 全部测试） | 1003 | 全过 |
| `npm run check:frontend` | 20 文件语法 | 全过 |

产物：`results-{stub,fallback,real}-r1.json`（首轮，含复审基线）、
`shots/`（36 张关键帧）、驱动脚本 `e2e-capture.ts`（可复跑）。

## 关键真实断言（非 mock）

1. **分身数量/title 真实**：`subagent_spawned` ×2（后接 ×3/超时/失败变体）→
   strip 出现 2/3 个 `.mascot-team-clone`，`data-subagent-id`= 真实子会话 id，
   title=派发 title，徽标 A/B/C 按派发序。
2. **候选点真实**：子 `search_events` 完成帧 `candidates`（实际抓到 5 与 1 条）
   → `.wander-candidate-dot` 落图，tone=team snapshot 真实 palette。
3. **锚点真实身份**：锚点 DOM = 真实 `<boop-face>`（独立实例）+字母 chip+title，
   位置=该分身候选质心；`wander:candidate-anchor` 载荷真实往返
   `{round,subagent_id,anchored:true→false}`（dispatch 侧捕获）。
4. **卡片-地图同一身份**：锚定中卡片分身 `data-anchored="true"`、
   脸部 `visibility:hidden`（徽标/title/note 保留）；锚点收回即恢复。
5. **done stops 真实行程序**：`subagent_done.stops`（2 站真实 id+坐标）→
   高亮短拍后锚点收回，候选点保留至 settle。
6. **settle 采纳真实 id**：`result.plans[].itinerary.stops[].event_id` ∪ 移交
   路线层（`native-route-dot` 4 个），落选点灰显淡出，候选层归零、subs 清空、
   strip `hidden`+卡片 `team-live` 移除、零克隆残留。
7. **0 派发**：单线轮 strip 全程 hidden、无克隆——无幽灵分身。
8. **部分失败**：`[fail]` 子任务模型故障 → `done failed`，A 正常收敛、
   层按终态清理、无伪造成功。
9. **超时**：`subagentTimeoutMs=3500` + 挂起子任务 → ~4.3s 内 `done` 终态、
   settle 正常、无致命错误（real 模式走 30s 子流兜底 reject，同收敛）。
10. **reset**：`wander:reset` 中途 → 层全清、strip 隐、锚点释放 false、
    新一轮 token 隔离（旧帧 stale no-op 由单测覆盖）。
11. **追问（非 plans）**：clarification settle → 层即刻清、strip 恒隐。
12. **布局**：1440/1024×600/800×480/320 四视口 3 分身+长 title：
    strip 与 header/location-status/messages/composer 零重叠、
    无横向滚动（`scrollWidth≤innerWidth`）、settle 后原布局恢复。
    welcome 态条 hidden 零占位（DOM 序自然位，无独立轨道）。
13. **降级**：fallback 模式零点零锚零错误，`subs` 如实记录；
    真实高德与 stub 行为一致（同一断言集同过）。

## 本轮集成修复（I41-E 新增，均记录在案）

- `frontend/mascot-card.css`：移除对 flex 容器无效的 `grid-template-rows/grid-row`
  死规则；strip 依 DOM 序在 location-status 与 messages 间自然占位，
  `hidden`/`:empty` 零足迹（行为不变，消除死代码误导）。
- `package.json` `check:frontend`：补入 `mascot-team.js`、`candidate-preview.js`
  两个新增 JS 的语法检查（C/D 交付时未接线）。
- `docs/mocks/day0/stream.sse`（I41-B 已改）：mock 帧补上 `candidates`/`stops`
  真实形态，供 `?mock=comparison` 预览与 D 侧 QA 使用。

## 如实边界

- **模型为 faux**：未做真实 LLM 调用验证（工单禁止付费模型）；事件管线、
  SSE、DB、校验、delegate 编排全部真实。
- **stub 模式**：`amap-stub.js` 非真实高德（其 DOM/projection 为近似实现）；
  `real` 模式为真实高德 SDK，两模式断言集一致、同过。
- 子任务「超时」在 stub/fallback 走真实 `subagentTimeoutMs` 取消路径；
  real 模式（默认 120s 超时不便等）由子流 30s 兜底 reject 等价收敛，
  未重复跑 120s。
- 注入期 `addEventListener` 在 headless 新文档观测 `wander:candidate-anchor`
  不可靠（dispatch 侧 patch 可证事件真实发出+facade 真实响应），
  本报告以 dispatch 捕获+`data-anchored` DOM 双重佐证，未改产品代码。
- Chrome 布局以 DOM rect/scrollWidth 断言为准，截图为辅证；
  既有 800×480 welcome 基线重叠属存量问题，未混入本轮判定。

## 复跑

```bash
node docs/issue-41/integration-qa/e2e-capture.ts            # stub+fallback
node docs/issue-41/integration-qa/e2e-capture.ts --only=real # 真实高德（需 .env key）
node docs/issue-41/integration-qa/e2e-capture.ts --slow=800  # 模型再减速观察
```

---

# 首轮独立 review 与 I41-R3 修复复验（2025-11-16）

## 首轮 review 结论：2 P2 + 2 P3

| # | 级 | 发现 | 修复 |
|---|---|---|---|
| F1 | P2 | `mascot-card.js` 缓冲满时若全部 400 帧皆为生命周期帧（spawn/done），无界保留→ready 后回放残缺/巨量历史 | 新增 `overflowed`：全生命周期饱和即本轮禁用 team、清缓冲、不 begin/回放/sync；非关键帧仍可被淘汰腾位；fanout 每帧一次照旧；下一轮 `begin` 复原 |
| F2 | P2 | `candidate-preview.js` renderer 当轮失败未清层/未释放锚，且 `clear()` 自身抛错会跳过 anchor 释放 | 失败路径 `map.clear()` 独立 try/catch + 全部 `notifyAnchor(false)`；真实点集保留待重试 |
| F3 | P3 | 迟到异步渲染/import 可跨轮串扰：旧 round 的 render promise settle 后清掉新轮图层；迟到 mascot import 给已销毁 sub 装脸 | 引入 `epoch`+round 双校验，渲染前后比对；import 回调解校验 `subs.get(held.id)!==held` 与 face 身份；teardown 清空全部引用 |
| F4 | P3 | 已 `closed` 的轮次再遇 `wander:reset` 不清层/timer，滞留 render 可能重绘 | reset 不再要求 `!closed`，凡有 round 即 teardown+epoch++，滞留 render 失效 |

新增测试 seam `window.__WANDER_MASCOT_MODULE__`（仅首调时读取一次，
生产路径仍走真实动态 `import('./wander-mascot.js')`；单测与探针注入受控替代，
不改变模块对外契约与安全面——只读 `createWanderMascot` 且身份校验先行）。

## R3 复验

| 项 | 结果 |
|---|---|
| `npm run check`（tsc+全量） | **1008/1008**（首轮 1003 + 5 新边界测试） |
| `check:frontend` | 20 文件全过 |
| `git diff --check` | 干净（仓库无 diffcheck 脚本，以此为准） |
| stub 回归 | **47/47**（`results-stub-r3.json`，首轮存 `results-stub-r1.json`） |
| fallback 回归 | **42/42**（`results-fallback-r3.json`） |
| R3 故障注入探针 | **17/17**（`results-probe.json`，`shots/probe-*.png` 4 张） |

真实高德代码路径本轮未改动，沿用首轮 47/47 证据（`results-real-r1.json`），未重跑、不冒称。

## 探针覆盖（真实页面 + 真实 facade/事件流 + stub 地图）

- **P1 帧洪峰**：60 spawn/done 对 + 4 spawn 经 `WanderMascot.applyEvent`
  真实注入 → 3 槽位 +「+1」溢出徽标诚实降级，settle 全回收，零页面错误。
  （402 全生命周期帧→`overflowed` 路径属 import 时序竞争，由单测
  「I41-R1」用 402 帧确定性覆盖。）
- **P2 渲染失败**：真实事件流驱动锚点上屏后，patch `candidates.render`
  为 reject → `failCalls=1` 真实进入失败路径：清层、锚撤销
  （`anchored=[]`、锚元素 0、卡片 `data-anchored=false`）、
  点集保留（`points:3`），恢复后下一帧真实重绘 4 点。
- **P3 迟到 import**：seam 挂起 mascot 模块 → 锚点降级为字母+真名
  （如实退化）；轮结束再 resolve → `subs` 已清、无僵尸脸（`revived=0`）。
- **P4 灰显期 reset**：settle 后 450ms 淡出窗口内 `wander:reset` →
  `subs` 即刻归零、淡出窗口后无重绘（`dotsAfter=0`）。
