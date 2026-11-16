# I41-R5 同轮 render 竞态修复说明

## 问题

`render()` 用 `round + epoch` 判 stale，只防得住跨轮/ teardown，防不住**同轮内两次并发 render**：

1. applyEvent e1 → render A 开始 await（真实 `WanderAMap.candidates.render` 内部 convert 延迟）。
2. applyEvent e2 → render B 开始，先于 A resolve，画出 2 点 1 锚。
3. A 随后 resolve —— renderer 内部 epoch 已过期，按契约返回 `false`。
4. 旧代码把这次 `false` 当作"当前轮失败"：执行 `map.clear()` + 撤全部锚 → B 的 marker 全消失、卡片头像错误恢复。

## 修法（最小）

`renderSeq` 单调递增；每次 `render()` 取 `seq=++renderSeq`。await 之后的判定为：

```js
if(destroyed||round!==r||epoch!==ep||seq!==renderSeq) return;
```

- `round/epoch`：跨轮、cancel、reset、teardown —— 迟到者不得画、不得清。
- `seq!==renderSeq`：同轮被更新 render 取代 —— 无论其 resolve `true`/`false`/reject，都不得 clear、撤锚或重跑入场装饰；最新一次 render 的失败仍走原有"清层 + anchored=false + 保留真实数据待重绘"路径。
- `notifyAnchor` 不按 seq 过滤：它报告的是 renderer 端真实 marker 可见性跳变，stale spec 在 renderer 内部 epoch 下根本走不到 reconcile，回调只可能来自已应用 spec 的真实状态。

## 定向测试

- `a superseded render resolving late cannot wipe the newer spec`：fixture 内置 renderer 级 epoch（超期调用 resolve `false` 且零副作用），复现 B 先成功、A 迟 `false`——断言无 clear、锚不撤销、数据保留。
- `a superseded render resolving true cannot act on newer state`：迟到 `true` 不得重跑入场装饰（`point()` 探针）或清层。
- 既有 `a stale render failure cannot clear a newer round`（跨轮）继续守护。

## 验证

`frontend-candidates.test.ts` 18/18；`frontend-amap.test.ts` 13/13；`tsc -p tsconfig.json` 0 错；产品改动 +9/-3 行。
