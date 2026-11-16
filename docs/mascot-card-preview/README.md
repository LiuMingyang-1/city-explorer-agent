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
  `.welcome h1` 用 `text-indent` 只缩进问候行，问题行保持全宽——不增加纵向占用，
  与右上「新聊天」同一头部区域。`prefers-reduced-motion` 下尺寸过渡即时生效。
- `chat.js` 四个挂点（全部在既有 `isCurrent()` 代际守卫内）：
  `deliver` 开始 `begin()`→thinking；`onProgress` 按 `stage` 映射
  `searching_events→searching、exploring_plans/routing→thinking、validating_schedule→validating`；
  结果 `finish(kind)`：`plans/itinerary/answer→happy、clarification→asking`；
  `showSendError`→`fail()`→confused。`wander:reset`（新聊天/历史切换/身份切换）→idle。
- 未知 `progress.stage` 不重置当前表情；无 search-start 事件不伪造搜索区间；
  不以时钟推进业务；结果表情保留到下一次真实交互。未引入 #39 后端/旧 issue40 资产。

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

## 仍需 QA

- 真实后端流（非 mock）下进度密度、取消/超时/断连的表情形态与恢复。
- `prefers-reduced-motion` 实机走查（代码路径已覆盖，未做系统级截图）。
- 短窗口桌面（高 ~600px）与横屏平板的余量确认；欢迎尺寸在窄桌面收敛到 ~64–70px。
- 历史展开态形象缩到 52px 是否保留（当前随 `.history-expanded` 缩放）。
- 多语言/长问候语下 `text-indent` 的排版余量。
