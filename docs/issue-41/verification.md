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

产物：`results-{stub,fallback,real}.json`、`shots/`（36 张关键帧）、
驱动脚本 `e2e-capture.ts`（可复跑）。

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
