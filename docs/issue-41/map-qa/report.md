# I41-D 地图候选层 + 分身锚点 QA 报告

范围：`frontend/candidate-preview.js` + `frontend/candidate-preview.css` +
`frontend/amap.js` 窄候选 renderer（`WanderAMap.candidates`）+
`test/frontend-candidates.test.ts`。卡片 facade / team / chat / index.html
为同伴 I41-C 文件；本层只暴露 `window.WanderCandidates` 全局 API。

## 接口落地

- `WanderCandidates.begin(round) / applyEvent(evt,round,ctx?) / sync(round,ctx) / settle(result,round) / cancel(round) / dispose() / snapshot()`
  —— 缺 token 抛 TypeError，stale/closed 返回 null 零副作用；`begin` 用 facade 本地 round。
- ctx `{clones:[{id,title,letter,palette}],origin:{left,top,width,height}}`：
  身份只认 facade 传的 team 实际 snapshot；无 ctx 时先裸记录事件（snapshot 中 letter/palette=null），
  `sync` 回填真实身份重绘。等待池/未知盖章 id → 中性点 + `aggregate` 计数，不造头像。
- `WanderAMap.candidates`（窄接口，非整个 native）：
  `render({dots,anchors,onAnchor})`（幂等 reconcile，独立 marker 集合 + epoch，过 `convert(points,'GCJ-02')` 单一入口）、
  `clear()`、`refresh()`、`point(position)`（FLIP 用视口坐标）。不动 routes/activities/scenes/selected/fitLayers，不触发 fit/pan。
- 锚点 = 同分身已收真实候选的质心；仅 ctx.clones 内且 ≥1 候选才落位（spawn 无坐标不飞）。
  marker 内容 = 真实 `<boop-face>`（动态 `import('./wander-mascot.js')` 独立实例）+ 派发字母 chip + 任务 title；
  离屏/focus/未就绪 → `wander:candidate-anchor {round,subagent_id,anchored:false}`，卡片保留头像。
- `done(completed+itinerary)`：stops 真实点高亮一拍（480ms）后锚点收回，候选点保留到 settle；
  `settle`：`∪plans[].itinerary.stops[].event_id`（含 `result.itinerary`）采纳 id 即刻移除移交路线层，
  落选灰显 ≤450ms 整层回收；answer/clarification/error/null 即时全清；新 begin/cancel 打断旧淡出。
- 上限：候选 ≤32/分身、全局 ≤96、stops ≤24（防御性，`dropped` 计数入 snapshot）。

## 单元回归（node --test test/frontend-candidates.test.ts，12 项全过）

- token 纪律（缺抛/旧 noop/closed 拒收）×2；真实身份取色 + 质心锚点；
  未知 id 聚合无头像、sync 转正补色；done 高亮节拍→收锚、候选留场；
  settle 采纳移交+落选灰显+整层回收；非方案 settle/cancel 即清、begin 打断淡出；
  单分身 32 / 全局 96 上限；地图缺席只记录不画 + wander:reset 清理；
  renderer：id reconcile 不重挂、epoch 挡 stale render、GCJ-02 走 convert 零 SDK 调用、
  视口/focus 锚点可见性只报真实跳变、clear/dispose 全释放并回报 anchored=false。

## 真实 Chromium QA（headless Chrome，CDP；`capture.mjs`）

驱动真实 `index.html`：`?mock=comparison` 回放 `docs/mocks/day0/stream.sse`
（spawn×2 → 盖章 search_events candidates → done stops → result plans），
`WANDER_CONFIG.mockDelay=650` 放慢便于观察。自有临时服务器/端口/Chrome profile，
未触碰用户 8080 服务/env/DB。

**如实标注：地图 SDK 为 stub**（CDP Fetch.fulfill 注入 `amap-stub.js`，实现
Map/Marker/convertFrom 最小面并落真实 DOM），不等于真实高德验证；真实高德路径
需用户侧配置复验，本工单不动用户 env。

- stub 模式 18/18 过（results-stub.json）：
  - 候选点 2 个落图（sand 帽色=team snapshot 真实 palette）；锚点在质心挂载，
    内嵌**真实 boop-face**（shadowRoot 验证）+「A」字母 +「曲江看展方案」title；
  - `wander:candidate-anchor` 真实往返：`sess_mock_child_a` true→false；
    无候选的 child_b 从未 anchored（卡片头像保留）；
  - 跨层契约：卡片 clone `data-anchored="true"` 且脸隐藏（伙伴接线联动成立）；
  - settle：采纳 id 移交路线层（native-route-dot×4），候选层归零、subs 清空；
  - 第二轮 `wander:reset`：层全清 + 锚点释放 false；
  - reduced-motion：锚点仍在但无 flip-enter；320px：锚点在、无横向滚动；
  - 页面零 JS 错误。
- fallback（map-config disabled → Leaflet）5/5 过（results-fallback.json）：
  subs/stops 如实记录（points 保留、aggregate=4），零绘制零锚点声明零错误——
  诚实降级成立。

## 截图（shots/）

`20/21` 候选点+boop-face 锚点（卡片 A 分身脸已隐藏）、`22/23` settle 路线接管、
`30` 取消后、`40` RM、`50` 320px、`60/61` fallback。

## 已知限制 / 交接注意

- FLIP 入场为纯装饰（marker 地理锚定，move/resize 不漂）；缺 origin 时跳过，不构成验收依据。
- 锚点 boop-face 依赖 `wander-mascot.js` 动态 import 成功；失败时锚点退为字母 chip+title（非假脸）。
- `tool_call` 为结束事件，本层不呈"检索中"；waiting/nested 分身只出中性点不造头像。
- 缺坐标/越界点在 ingest 即丢弃（单测覆盖），不会画出。
- 未做：真实高德 SDK 环境复测（需用户配置，超出工单边界）；faux 后端全量联调归最终集成。
