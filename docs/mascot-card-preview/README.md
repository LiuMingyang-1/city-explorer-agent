# 卡片常驻主形象 · 第一版预览（M1）

分支 `card-mascot-preview`，基线为 PR#55 `lody/animated-face`（432432f）。
目标：把 PR55 的圆脸渔夫帽形象常驻到聊天卡片左上角，跟随**真实**请求生命周期变化。

## 接入方式

- `frontend/mascot-card.js`：同步门面 `window.WanderMascot`（`begin/progress/finish/fail/idle`），
  动态 `import('./wander-mascot.js')` 创建 `<boop-face class="card-mascot">`（moss 帽、
  `motion="auto"`、关按压/触角拖拽、关自动睡眠、idle 时指针跟随）。
  门面先于模块就绪，异步期间的状态请求缓存为 pending，挂载后回放最新值；加载失败只记
  `console.error`，对话与文字进度照常（测试覆盖）。
- `frontend/mascot-card.css`：`.glass-card` 上 `--mascot-w/--mascot-left/--mascot-top` 变量驱动
  boop-face 的 `--face-size`。欢迎态约 64–88px（`clamp(64,4.11vw+26,88)`，随标题字号对应的
  可用空间缩放），对话态/历史展开态 52px；移动端欢迎 60px、对话 48px。
  `prefers-reduced-motion` 下尺寸过渡即时生效。
- 问候排版（M4/M5 修）：`.greet-line` 块包问候+句号，首行 `text-indent` 让出头像；
  `padding-right:80px` 预留右上「新聊天」位。问候语在**全部视口**统一单行
  `nowrap + overflow:hidden + text-overflow:ellipsis`——welcome 块高度恒定，
  无论问候多长都不推挤 weather/composer（M5 产品决策：900×800 窄高视口下
  自由折行曾把 weather 压进绝对定位的 composer 38px，P2）。
  约束视口（`max-height:700px` 桌面 / `max-width:700px` 移动端）下头像底缘会越过第二行，
  此时 h1 整体 `padding-left`（= 头像右缘+6px-卡片左内边距，`--card-pad-l` 变量镜像
  style.css 各断点），问候列改为头像右侧通排的两行 lockup、零纵向增长。
- `chat.js` 四个挂点（全部在既有 `isCurrent()` 代际守卫内）：
  `deliver` 开始 `begin()`→thinking；`onProgress` 按 `stage` 映射
  `searching_events→searching、exploring_plans/routing→thinking、validating_schedule→validating`；
  结果 `finish(kind)`：`plans/itinerary/answer→happy、clarification→asking`；
  `showSendError`→`fail()`→confused。`wander:reset`（新聊天/历史切换/身份切换）→idle。
- 未知 `progress.stage` 不重置当前表情；无 search-start 事件不伪造搜索区间；
  不以时钟推进业务；结果表情保留到下一次真实交互。未引入 #39 后端/旧 issue40 资产。
- M3 小修：stage/kind 映射表改 null-prototype + `Object.hasOwn` 守卫，挂载 pending 回放
  走同一受控 `commit`——`toString`/`__proto__`/`constructor` 等继承键与普通未知值
  一律保持既有状态、不进入 pending、不移除形象（含成功挂载回归）。

## Mock 边界

截图与走查使用 `?mock=comparison|clarification|error|answer`（`docs/mocks/day0` + `frontend/data`），
`window.WANDER_CONFIG.mockDelay=1400` 拉长每帧以便抓拍。mock 只覆盖 4 个粗粒度 stage；
真实后端的进度密度/取消/超时形态 QA 时另行验证。地图/天气为真实外部服务，可能为空。

## 验证记录（真实 Chrome headless CDP，1440×900 与 320×568）

| 场景 | 断言结果 |
| --- | --- |
| 欢迎态 | `idle`，85px，问候行让位、问题行全宽、天气不挤 → `v301-welcome.png` |
| searching_events | `searching` 举镜，52px → `v303-searching.png`、`expr-searching.png` |
| validating_schedule | `validating` → `v304-validating.png`、`expr-validating.png` |
| plans 结果 | `happy` → `v305-happy.png`、`expr-happy.png` |
| 打开行程详情 | 卡片滑出，形象随之离屏（x=-472），不遮挡地图/控件 → `v306-plan-focus.png` |
| 返回对话 | 形象回位，仍是 `happy` 52px → `v307-back-from-plan.png` |
| 新聊天 | 复位 `idle` + 85px 欢迎尺寸 → `v308-reset-welcome.png` |
| 历史恢复 | `idle` + 52px 对话尺寸 → `v309-history-chat.png` |
| clarification | `asking` → `s110-asking.png` |
| error 流 | `confused`；重试→`thinking` → `s111-confused.png` |
| 移动端 320×568 | 欢迎 60px、对话 48px，不与新聊天/标题/滚动区互挡 → `m120/m121/m122` |
| 碰撞检测 | 形象与 #new-chat、.composer-area、#messages 矩形均不相交（CDP 断言 false） |

`expr-*.png` 为 52px 下七表情特写（经 `createWanderMascot(face).setState` 直接驱动）。

## 自动化

`test/frontend-mascot-card.test.ts`（5 例）：SSE 四阶段映射 + 未知帧保持、
clarification/error/retry/newChat、旧代迟到结果与进度的代际隔离、
历史切换复位、挂载失败降级。`npm run typecheck`、`npm run check:frontend`
（已含 `node --check frontend/mascot-card.js`）及 50 个相关前端回归全部通过。

## M4/M5 排版修复（layout-fix/、layout-fix-v2/）

针对 M2 QA 的 F1（第二行标题伸进头像下缘）与 F2（长问候被卡缘硬裁）；M5 收窄为
全视口统一单行省略（reviewer P2：900×800/900×701 折行把 weather 压入 composer）。

- 证据：`layout-fix-v2/verify-layout.mjs` + `metrics.json` + `v*-welcome.png` /
  `v*-long-greeting.png` / `chat-900x800.png`，**62/62** 断言通过；
  `layout-fix/` 为 M4 首轮证据（未覆盖，历史保留）。
- 覆盖视口：900×800、900×701、900×700（媒体断点两侧）、1024×600、800×480、
  1440×900、320×568(DPR2, innerWidth=clientWidth)。
- F1：各视口问候行文字与头像矩形零相交。
- F2：全部视口 `greet-line` 单行 `nowrap+ellipsis`，可视盒右缘在新聊天按钮左缘之前；
  **长问候下 weather/composer/history/messages/location-* 矩形与常态逐值一致**
  （`lg-nothing-moves`），不再把 weather 压入 composer。
- 已知基线（非本分支引入，QA metrics 同值）：800×480 下欢迎态绝对定位的 composer
  与 weather/location-form 框交叠 ~41px、320×568 下 composer 与 messages 交叠 ~11.6px；
  欢迎态 composer 锚在卡片 50% 高度的原布局决策，未在 M5 最小范围改动。
- 流程回归：900×800 welcome→chat `happy` 52px sameNode、新聊天复位 `idle` 64px、
  历史恢复 52px、reduced-motion transition 0s。



## 仍需 QA

- 真实后端流（非 mock）下进度密度、取消/超时/断连的表情形态与恢复。
- `prefers-reduced-motion` 实机走查（代码路径已覆盖，未做系统级截图）。
- 短窗口桌面（高 ~600px）与横屏平板的余量确认；欢迎尺寸在窄桌面收敛到 ~64–70px。
- 历史展开态形象缩到 52px 是否保留（当前随 `.history-expanded` 缩放）。
- 欢迎态 composer 锚定卡片 50% 的原布局在极矮/窄窗口与上方内容交叠（见 M4/M5 节），
  属产品既有取舍；若要根治需改卡片布局方案，超出本任务。
