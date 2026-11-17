# I41 入场飞行动画修复验证（fix/mascot-flight）

基线：`main` 8ab08e7。修复对象：候选分身从卡片脸飞向地图质心的入场动画。
旧实现（FLIP_MS=60 + anchor 类 transition）被 SDK 根 transform/overflow 吞掉，
真实 app 全程不可见。现实现：**固定 overlay proxy 承载锚点真实 visual + WAAPI**
（560ms，`cubic-bezier(.3,.7,.25,1)`），marker 地理锚定与 anchored 上报完全不动。

## 实测数据（真实 Chromium + CDP）

**stub SDK（`flight-probe.mjs` → results-flight-stub.json）25/25 过（P3 后口径：采样 boop-face 脸心）**
- 起飞脸心 = 分身 strip 脸心，**startGap 0.0px**；终点 keyframe vs geo **0.00px**；
  落地 visual 单元中心 vs geo **0.0px**；face 交接跳变 **0.1px**；落地脸心在
  geo 上方 8.0px（faceDy=−8 锚定设计）
- 帧采样全程 opacity=1，位移 756px、16 段移动帧，单发、落地后 proxy 移除、visual 归回 anchor
- wander:viewport 中飞即落位（proxies=0、visual 已归回）；RM 无飞行直接显示；
  320px 飞行+落点正常、无横向滚动；零页面错误

**真实 webapi.amap.com（`flight-probe-real.mjs` → results-flight-real.json，P3 前那次运行）14/14 过**
- `real-flight-endpoint-vs-geo` **0.00px**：WAAPI 终点 translate(657.191,422.811)
  = `WanderAMap.candidates.point(anchorPos)` = SDK 自身投影 geo 点
- `real-face-center-error` **0.01px**：落地后 visual **单元**在真实 anchor 内的
  中心 = geo 点（当时口径为单元中心，非 boop-face——见下方 P3 纠正）
- `real-touchdown-jump` **0.01px**：动画终点与归位中心无跳变
- 全程 opacity=1（32 帧）、无残留 proxy/animation、settle 后层干净、零页面错误

### "SDK 空壳中心误差" 实锤为测量伪影

旧结果 `endGap=29` 的来源：飞行中 anchor 外壳为空（72×0），真实高德对
`anchor:'center'` 按 marker 创建时内容尺寸（72×58）缓存像素偏移，空壳
rect 中心 = geo.y − visH/2 = 422.8 − 29 = 393.8。探针曾拿它当落点基准。
现探针对 `candidates.point(anchorPos)` 独立定位 geo 点 + MutationObserver
锁存 visual 归位中心，三处测量互相印证（终点/落位/geo 全同一点）。

## 本次收尾增补

- `flight.pos` 记录起飞时质心；render 后若质心已变（新候选到达→marker 跳位），
  立即 endFlight 落回真实锚点，杜绝过期落点（单测覆盖）。
- `.wander-candidate-flight{transform-origin:0 0}`：visual 以盒原点为中心，
  缩放帧脸心始终于 keyframe 坐标（stub startGap 8.3→0.0）。
- `snapshot().subs[].anchorPos` 暴露原始质心，供探针独立校验 geo 点。
- 真实探针度量重写：消除 rAF 采样/settle 竞态，终点用 WAAPI keyframe +
  归位锁存 + SDK 投影三重核对。

## review P3：face 起点补偿与测量口径纠正（bd1fff7 之后）

6.1-sol 复审指出两处口径问题，已最小修复：

1. **起点误差**：旧 keyframes 把 **visual 单元**（脸+字母+标题，72×~58）中心
   放在 strip 脸心上，boop-face 实际脸心在其上方 `faceDy≈−6.5~−8px`，
   起飞脸与 strip 脸有可见小跳。现按实测 `faceDy = face中心 − visual中心`
   以起始 scale(.82) 反算起始 translate：`sy = from.y − s0·faceDy`。
   终点 keyframe 不变（marker 以整个单元锚 geo，脸居上是锚定设计）。
   不可测量时 faceDy=0 退化为旧行为。单测覆盖补偿数学与退化。
2. **报告口径**：此前"脸中心误差 0.01px"实测的是 visual 单元中心，
   非 boop-face。现两探针采样全部改为 `boop-face` rect 中心，并拆分指标：
   - `*-starts-at-clone-face` / `*-face-start-gap`：起飞脸心 vs strip 脸心
   - `*-endpoint-vs-geo`：WAAPI 终点（visual 单元中心）vs `candidates.point(anchorPos)`
   - `*-visual-lands-on-geo`：落地 visual 中心 vs geo（marker 单元锚定精度）
   - `*-face-continuity`：最后飞行脸心 vs 锚内落地脸心（交接跳变）
   - `*-face-rest-offset`：落地脸心 − geo.y（设计值 ≈faceDy，非误差）

**新实测（stub 重跑，25/25 过）**：face 起点误差 **0.0px**；终点 vs geo
**0.00px**；落地 visual on geo **0.0px**；face 交接跳变 **0.1px**；
落地脸心在 geo 上方 **8.0px**（faceDy=−8，锚定设计，非误差）。

真实 SDK：沿用前轮真实高德证据（旧探针 14/14 + 复审方独立 16/16，
实际 face 落地跳变 .043px）；flight-probe-real.mjs 已同步为 face 口径供
复跑使用，`results-flight-real.json` 保留 P3 前那次运行，未冒称 face 口径。

## 生命周期边界（单测 25/25 覆盖要点）

- RM / 无 WAAPI / 缺 origin / 距离<24px → 直接显示，无 proxy。
- cancel/reset/settle/un-anchor/viewport/focus/done 中飞 → animation cancel +
  proxy 移除 + visual 归回 anchor；finished 晚到不复活。
- `sub.entered` 幂等：重复 render / 重新 anchored 不重复入场。
- 快速 done → retire → un-anchor → 装饰即刻取消，不延后业务语义。

## 未做 / 边界

- 真实高德只跑了一次定向复验（读 .env 只读、自有端口、mock 流）；
  全量 1000+ 测试未重跑（与本改动无关路径）。
- 飞行途中地图若被拖动，wander:viewport 直接落位（防过期落点），不重跟路径。
