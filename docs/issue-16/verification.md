# Issue #16 验证记录 — 「更多历史规划」展开上滑渐显 / 收起下滑渐隐

## 范围与职责

浏览器验收与录屏（子任务 C）。`before/` 为 git 基线 `main`（`c993f38`，经
`git archive` 只读导出）捕获；`after/` 为最终产品 **HEAD `ab00ec5`
`fix(frontend): make history animation frame-accurate under interruption`**
（含 `49e53f8 feat`、`7d44e9e`/`acdb250` 测试；`frontend/history.js` blob
`407d4a8`）实测 —— 验收时产品工作树零未提交改动。两者由同一
`capture.mjs` 驱动，断言口径一致；录屏由 `record.mjs` 在同一 HEAD 产出。

`p2-evidence.json` 为 A 侧在 `ab00ec5` 上的真实探针归档（三段：A 反转
同节点连续、B 入场途中收起单调、C 展开态 setIdentity 同步）；`capture.mjs`
内置的 `p2-*` 断言以**自动化逐帧采样**复现同一组不变量，可复跑。

## 运行命令

```bash
# 基线导出（只读，不触碰共享工作树）
mkdir -p /tmp/issue16-baseline && git archive main frontend | tar -x -C /tmp/issue16-baseline

# 截图 + CSS 中间帧采样断言（自带静态服务 + CDP，零第三方依赖）
node docs/issue-16/capture.mjs --root /tmp/issue16-baseline/frontend --out docs/issue-16/before
node docs/issue-16/capture.mjs --root frontend --out docs/issue-16/after

# 录屏（headed Chrome + CDP screencast + ffmpeg 合成；窗口短暂出现约 20s）
node docs/issue-16/record.mjs --root frontend --out docs/issue-16/video

# 回归
npm run check          # typecheck + 全部 node 测试
npm run check:frontend # 前端脚本语法检查
```

## Mock 范围

- `capture.mjs`/`record.mjs` 内嵌服务 mock：`/api/me`、`/api/login`、
  `/api/logout`（Cookie 会话，`demo`/`demo-pass` → `u-demo`/明轩），
  `/api/memory` 内存文档。其余 `/api/*` 一律 404，页面走真实回退
  （`/data/demo-events.json`、OSM 瓦片）。
- 历史数据不经任何 API：`Page.addScriptToEvaluateOnNewDocument` 向
  localStorage 写入两个身份桶 —— `wander.chat-history.v1.guest`（6 条，
  标题为真实示例名，g3 用户消息含「验收标记T3」供恢复断言）、
  `wander.chat-history.v1.u-u-demo`（3 条，标题前缀 `账号·`，验证
  身份桶隔离）。`pending` 桶留空，首进 `/api/me` 后按真实
  `setIdentity('guest')` 路径解析。
- 未 mock 的真实外网：地图瓦片、open-meteo 天气、nominatim 地理编码
  （截图中的底图与天气为真实网络结果），与 issue-20 口径一致。
- 聊天发送路径未覆盖：本验收不含 `/api/chat`，`capture()` 的
  sessionId/planIndex 落盘字段未在浏览器端断言（由 node 单测覆盖）。

## 断言方法（真实 CSS 中间帧，而非仅终态）

`capture.mjs` 在每次点击后以 40–50ms 间隔对 `#history-list` 全量探测：
每行 `getComputedStyle` 的 `opacity`/`transform(translateY)`/`getBoundingClientRect`、
`dataset.p2n` 节点标记与 `history-enter`/`history-exit` 类名；容器
`opacity`/`transform`/高度，以及 `expanded`/`aria-expanded`/
`#messages.hidden`。采样序列原样写入 `metrics.json`（`expand-series`、
`collapse-series`、`p2A-reversal-series`、`p2B-enterExit-series`、
`narrow-expand-series` 等）。逐样本行比较一律带双截止：`expanded`
边界（`expanded===false` 即退出阶段结束）+ `dataset.p2n` **同节点门限**
（样本对节点标记不一致即跳过 —— 旧版无门限曾把 teardown 后重建行
的正常入场上升 0→.197 误判为回跳）。签名提取：

- `fade`：任一行或容器出现 0.05<opacity<0.95 的采样；
- `slide`：同序号行的 bounding y 逐样本下降（展开上移）；
- `grow`：列表盒高逐样本增长。

`consistent()` 终态不变量：`expanded` 与 `aria-expanded`、`visCount`
（可见行数）、`msgsHidden` 三者一致；`extraKids=0`；所有可见行
`opacity===1 && translateY===0`（无残留中间态/卡死类名）。

## 断言清单

| 断言 | 语义 | before | after |
|---|---|---|---|
| seed-initial-collapsed | 6 条 guest 历史，折叠可见 2 条 | pass | pass |
| expand-final-state | 展开后 6 行、aria/label/msgsHidden 一致 | pass | pass |
| expand-fade-observed | 展开中采到中间透明度（渐显） | FAIL | pass |
| expand-slide-observed | 展开中行 y 逐样本上升/列表增长（上滑） | FAIL | pass |
| collapse-final-state | 收起后 2 行、aria/msgsHidden 一致 | pass | pass |
| collapse-lingers-before-hide | 收起后 >80ms 内仍可见 >2 行（非瞬隐） | FAIL | pass (t=309ms) |
| collapse-fade-observed | 收起中采到中间透明度（渐隐） | FAIL | pass |
| collapse-slide-down | 收起中同布局样本内行 y 逐样本**下移**（真·下滑，非纯渐隐；teardown 边界样本不计） | pass | pass |
| collapse-unmount-after-fade | 卸载时序：先采到「行仍挂载且 o≤0.05」（t=369ms），之后 rowCount≤2（t=423ms）——渐隐完成再移除，非 >80ms 笼统阈值 | pass | pass |
| rapid-even-consistent | 10 连点 @60ms 后折叠终态、零残留 | pass | pass |
| rapid-odd-consistent | 9 连点后展开终态、零残留 | pass | pass |
| p2-reversal-same-node | 收起 200ms 再展开：重开后每行仍带点击前写入的 `dataset.p2n` 节点标记 → **同一批 DOM 节点原地反转**，pre 样本 6 行均带 `history-exit` | — | pass |
| p2-reversal-instant | 反转瞬间逐行比对：首个重开后样本 o 不得骤降 >0.08 或骤升 >0.35，ty 跳变 ≤5px —— 即复核的 `.69→0 / ty3.7→14` 类闪烁 | — | pass |
| p2-reversal-monotonic | 反转后逐样本单调收敛至 o=1/ty=0（|ty| 不增、o 不跌，容差 0.03/1px），覆盖第 6 行 ~110ms stagger delay 保持窗 | — | pass |
| p2-enterexit-monotonic | 入场 170ms 收起：飞行中每行 o 单调降、|ty−12| 单调收敛（低于 12 的行下沉、高于 12 的入场行回落），delay 只许保持不许回跳 —— 即复核的 `.772→.876→.772` 类回跳 | — | pass |
| p2-identity-sync | 稳态展开 `setIdentity('u-u-demo')`：同步样本与 +100ms 复采样均**不含任何旧桶标题**，折叠两行已为新桶 | — | pass |
| select-sync-restore | 点选后**同一任务内**会话恢复+拆除（collapseNow） | pass | pass |
| select-restores-conversation | 点第 3 条历史恢复会话（含验收标记T3） | pass | pass |
| select-collapses-clean | 选中后折叠干净、无残行 | pass | pass |
| select-excludes-active | 活动条不再出现于历史列表 | pass | pass |
| select-focus-input | 焦点归还 `message-input` | pass | pass |
| newchat-midexit-sync | **收起渐隐途中**新会话→同步拆除+聚焦（采样先于 400ms 定时器） | pass | pass |
| newchat-collapses-clean | 新会话后折叠终态一致 | pass | pass |
| identity-midexit-teardown | **收起渐隐途中** `setIdentity`→旧行立即清空、`账号·` 桶就位 | pass | pass |
| identity-restores-guest | 切回 guest 桶终态一致 | pass | pass |
| login-collapses-and-switches | 展开动画进行中登录→折叠+切 `账号·` 桶 | pass | pass |
| logout-collapses-and-restores | 展开中登出→折叠+回 guest 桶 | pass | pass |
| narrow-expand-final | 390×844 展开终态一致、无纵向溢出 | pass | pass |
| narrow-expand-animated | 窄屏展开采到动画签名 | FAIL | pass |
| narrow-collapse-final | 窄屏收起终态一致 | pass | pass |
| rm-expand-consistent | reduced-motion 展开 450ms 内落终态 | pass | pass |
| rm-collapse-consistent | reduced-motion 收起 450ms 内落终态 | pass | pass |
| rm-rapid-consistent | reduced-motion 8 连点终态一致 | pass | pass |

结果：before 5 FAIL（恰为动画存在性断言），after **33/33 pass**，exit 0。
（`p2-*` 为本轮新增帧级断言，before 不适用故列「—」。）

## after 实测要点（取自 metrics.json 采样序列）

- **展开上滑渐显**：行以 30ms 封顶阶梯（`history-rise`，
  translateY 14px→0）逐条上浮渐显；样本中 o:0→1、y:503→489 等
  连续变化，`visCount` 0→1→3→5→6 渐进。
- **收起下滑渐隐到完成再隐藏**：`history-expanded` 类保留至渐隐结束
  （样本 t=0–370ms `exp:true` 且行 o 逐样本降、y 逐样本升 +12px 下沉，
  `collapse-slide-down` 采到飞行中 +3.7px 样本级下移），t=369ms 全部
  退出行已 o≤0.05 仍挂载 → t=423ms 才 `finishClose` 移除类并重建折叠
  列表（`collapse-unmount-after-fade` 记录两个时刻的先后序）。重建的
  2 行同样以 rise 动画入场。
- **退出动画取自实时样式**：`history-exit` 的 WAAPI keyframe 从每行
  当前 computed opacity/transform 起播；起帧先把样式**物化**进普通
  对象再 `getAnimations().cancel()`（`CSSStyleDeclaration` 是活对象，
  取消后读会拿到终值）、`fill:'both'` 钉住截获帧 —— 入场途中被
  收起的行从半途透明度继续下沉，不闪回不透明、不在阶梯 delay 内回漂。
- **快速连点与反转帧级连续性**：收起中途再展开走 `reversible` 路径 ——
  `dataset.p2n` 节点标记证明**同一批 DOM 节点**原地反转（pre 样本 6 行
  均带 `history-exit`，重开后零未标记节点）；反转瞬间逐行 o/ty 与
  截获帧一致（无 `.69→0`、`ty3.7→14` 类跳变），随后单调收敛 o→1/ty→0
  （含 row5 ~110ms delay 保持窗）。收起中途入场被打断的行同理：
  o 单调降、ty 向 +12 单调收敛（`p2-enterexit-monotonic`，覆盖
  `.772→.876→.772` 类回跳）。10/9 连点两组终态均一致，`extraKids=0`。
- **收起中程序化复位同步拆除**：`open`/`newChat`/`setIdentity` 统一走
  `collapseNow()`（同步 `closing=false`、移除展开类、重建折叠列表、
  `messages` 立即可见）——实测渐隐途中点击新会话或切换身份后
  **下一个采样（<60ms）**即见旧行清空、折叠两行就位、消息区已显示，
  不等 400ms 退出定时器。真实登录/登出面板流同验。
- **历史选择**：展开态点击第 3 条（兵马俑华清池一日）→ 会话恢复
  （用户消息含「验收标记T3」）、该条转为活动项退出历史列表、
  折叠干净、焦点回 `message-input`。
- **身份切换边界**：稳态展开调 `setIdentity('u-u-demo')` → 同步样本与
  +100ms 复采样均零旧桶标题（`p2-identity-sync`）；渐隐途中切身份 →
  下一采样旧行清空、`账号·` 桶就位（`identity-midexit-teardown`）；
  展开动画进行中（点击后 110ms）真实登录/登出面板流同验，两向无残留。
- **窄屏 390×844**：底部抽屉卡内展开/收起动画签名一致，行全部在
  视口内（无纵向溢出）。
- **prefers-reduced-motion**：`Emulation.setEmulatedMedia` reduce 下
  `still()` 走同步路径，`history-enter` 动画关闭；450ms 内落终态，
  8 连点终态一致。

## 录屏清单（docs/issue-16/video/）

| 文件 | 内容 | 规格 |
|---|---|---|
| expand-collapse-desktop.mp4 | 1440×900：展开→收起→10 连点风暴→展开选第 3 条恢复 | 415 帧 / 6.9s, 30fps, 1280 宽, 88KB |
| expand-collapse-desktop.gif | 桌面录屏前 ~4.2s（一个完整展开/收起循环） | 760 宽, 12fps, 218KB |
| expand-collapse-narrow.mp4 | 390×844：展开→收起→8 连点 | 281 帧 / 4.7s, 30fps, 48KB |
| *.frames.json | 各段 screencast 帧时间戳+间隔统计（节奏可复核） | — |

合成方式：`Page.startScreencast` 原始帧 → ffconcat 按**真实 compositor
时间戳**逐帧还原节奏（帧时长 = 相邻帧时间戳差，截断上限 1.0s 并计数）
→ `fps=30,scale≤1280` → libx264(crf28,yuv420p)。每条剪辑录制前先跑一段
**预热展开/收起**（丢弃），消除管线冷启动造成的首帧大间隔 —— 本次录制
`maxGap≈22ms`、`clampedGaps=0`、帧时间戳跨度与 MP4 时长一致（桌面
6.95s/418 帧），即真实连续帧而非补帧拉伸。fps=30 重采样仅按帧时长
复制已有帧，不虚构新帧。已抽帧复核：t≈0.55s 见逐条上浮渐显中间帧，
t≈2.1s 见顶行先行隐去的阶梯渐隐中间帧。

## 录屏技术说明（复现须知）

Chrome 必须 **headed**：headless 模式下合成器仅在页面产生 damage 时
出帧，本特性的 WAAPI transform/opacity 动画为合成器驱动、不触发
damage —— 实测 headless screencast 在整个编排中只交付 4 帧/6.7s；
改为 headed 后 ~60fps 连续帧（本次 maxGap 22ms）。`screencapture -v`
备选方案因终端无 Screen Recording 权限（TCC）不可用。headed 录制会在
屏幕上短暂弹出 Chrome 窗口（~20s，窗口置于 40,40 不遮挡桌面大部）。
早期录屏曾出现 6s 级首帧间隔与 MP4 时长缩水（ffconcat 2s 截断），本轮
已通过录制前预热 screencast/截图管线消除（clampedGaps=0）。

## 已知边界 / 局限（非缺陷）

- 渐隐期间行带 `.history-exit{pointer-events:none}`，不可点选 ——
  设计行为，防止收起点穿；收起中途点「更多历史规划」走原地反转。
- 折叠列表重建时 2 行同样播放入场动画（`finishClose→render(true)`，
  新节点 rise 入场），视觉无硬切。
- 采样断言依赖真实过渡计时；slow CI 机器上若采样首样本晚于动画结束，
  `*-observed` 断言可能假阴性 —— 本机实测两次均稳定 pass。
- `.env` 中密钥不参与本验收；localStorage seed 固定 epoch，可复现。

## 最终检查状态

- [x] `npm run check`：typecheck + **871/871** node 测试通过（exit 0）
- [x] `npm run check:frontend`：通过
- [x] before/after 全场景截图 + 采样序列 metrics（33 断言：before 5 FAIL
      对照，after 33/33 pass，exit 0）
- [x] `p2-*` 帧级断言与 `p2-evidence.json` 归档一致（同节点反转无跳变、
      入场收起单调收敛、setIdentity 同步零旧标题、渐隐完成再卸载）
- [x] 桌面+窄屏录屏，真实连续帧（clampedGaps=0，maxGap≈22ms）已抽帧复核
- [x] 快速连点（10/9/8 三组风暴）、历史选择同步恢复、**收起渐隐途中**
      新会话/身份切换同步拆除、reduced-motion 边界全部覆盖
- 验证对象 = HEAD **`ab00ec5`**（`frontend/history.js` blob `407d4a8`），
  验收时产品工作树零未提交改动；`after/`、`video/`、`metrics.json`
  均为该 HEAD 上的干净重跑。若产品再改动需重跑两脚本
