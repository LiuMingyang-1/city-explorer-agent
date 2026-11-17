# I41 入场飞行动画修复验证（fix/mascot-flight）

基线：`main` 8ab08e7。修复对象：候选分身从卡片脸飞向地图质心的入场动画。
旧实现（FLIP_MS=60 + anchor 类 transition）被 SDK 根 transform/overflow 吞掉，
真实 app 全程不可见。现实现：**固定 overlay proxy 承载锚点真实 visual + WAAPI**
（560ms，`cubic-bezier(.3,.7,.25,1)`），marker 地理锚定与 anchored 上报完全不动。

## 实测数据（真实 Chromium + CDP）

**stub SDK（`flight-probe.mjs` → results-flight-stub.json）22/22 过**
- 起点 = 分身 strip 脸心，startGap **0.0px**；终点 = geo 点，endGap **0.1px**
- 26 帧采样全程 opacity=1，位移 760px，单发、落地后 proxy 移除、visual 归回 anchor
- wander:viewport 中飞即落位（proxies=0、visual 已归回）；RM 无飞行直接显示；
  320px 飞行+落点正常、无横向滚动；零页面错误

**真实 webapi.amap.com（`flight-probe-real.mjs` → results-flight-real.json）14/14 过**
- `real-flight-endpoint-vs-geo` **0.00px**：WAAPI 终点 translate(657.191,422.811)
  = `WanderAMap.candidates.point(anchorPos)` = SDK 自身投影 geo 点
- `real-face-center-error` **0.01px**：落地后 visual 在真实 anchor 内的中心 = geo 点
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

## 生命周期边界（单测 24/24 覆盖要点）

- RM / 无 WAAPI / 缺 origin / 距离<24px → 直接显示，无 proxy。
- cancel/reset/settle/un-anchor/viewport/focus/done 中飞 → animation cancel +
  proxy 移除 + visual 归回 anchor；finished 晚到不复活。
- `sub.entered` 幂等：重复 render / 重新 anchored 不重复入场。
- 快速 done → retire → un-anchor → 装饰即刻取消，不延后业务语义。

## 未做 / 边界

- 真实高德只跑了一次定向复验（读 .env 只读、自有端口、mock 流）；
  全量 1000+ 测试未重跑（与本改动无关路径）。
- 飞行途中地图若被拖动，wander:viewport 直接落位（防过期落点），不重跟路径。
