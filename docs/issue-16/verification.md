# Issue #16 验证记录 — 「更多历史规划」展开上滑渐显 / 收起下滑渐隐

## 范围与职责

浏览器验收与录屏（子任务 C）。`before/` 为 git 基线 `main`（`c993f38`，经
`git archive` 只读导出）捕获；`after/` 为实现在**最终工作树状态**的实测：
已提交 `49e53f8 feat(frontend)` + `7d44e9e test`（上游所述 `ec5d0e1` 为
中间 amend，已被 `49e53f8` 取代）**加上尚未提交的产品增量**
（`collapseNow` 同步拆除、`rowMeta` 原地反转、退出动画
`getAnimations().cancel()` + `fill:'both'`）。两者由同一 `capture.mjs`
驱动，断言口径一致；录屏由 `record.mjs` 在同一最终状态产出。

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

`capture.mjs` 在每次点击后以 ~50ms 间隔对 `#history-list` 全量探测：
每行 `getComputedStyle` 的 `opacity`/`transform(translateY)`/`getBoundingClientRect`，
容器 `opacity`/`transform`/高度，以及 `expanded`/`aria-expanded`/
`#messages.hidden`。采样序列原样写入 `metrics.json`（`expand-series`、
`collapse-series`、`narrow-expand-series`），签名提取：

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
| rapid-even-consistent | 10 连点 @60ms 后折叠终态、零残留 | pass | pass |
| rapid-odd-consistent | 9 连点后展开终态、零残留 | pass | pass |
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

结果：before 5 FAIL（恰为动画存在性断言），after **26/26 pass**，exit 0。

## after 实测要点（取自 metrics.json 采样序列）

- **展开上滑渐显**：行以 30ms 封顶阶梯（`history-rise`，
  translateY 14px→0）逐条上浮渐显；样本中 o:0→1、y:503→489 等
  连续变化，`visCount` 0→1→3→5→6 渐进。
- **收起下滑渐隐到完成再隐藏**：`history-expanded` 类保留至渐隐结束
  （样本 t=0–370ms `exp:true` 且行 o 逐样本降、y 逐样本升 +12px 下沉），
  t≈423ms 才 `finishClose` 移除类并重建折叠列表；重建的 2 行同样以
  rise 动画入场（o 0.51→1、y 772→758）。首隐藏样本 t=316ms > 80ms 阈值。
- **退出动画取自实时样式**：`history-exit` 的 WAAPI keyframe 从每行
  当前 computed opacity/transform 起播，且先 `getAnimations().cancel()`
  再 `fill:'both'` —— 入场途中被收起的行从半途透明度继续下沉，
  既不闪回不透明也不在阶梯 delay 内回漂（针对闪烁/回弹的设计点）。
- **快速连点**：收起中途再展开走 `reversible` 路径 —— 同一批行节点
  （`rowMeta` 比对 id+title）移除 `history-exit` 并从当前透明度
  原地回升，不重建 DOM。10/9 连点两组终态均一致，`visCount`/aria/
  `msgsHidden` 无错位，可见行全部 `o===1,ty===0`，`extraKids=0`。
- **收起中程序化复位同步拆除**：`open`/`newChat`/`setIdentity` 统一走
  `collapseNow()`（同步 `closing=false`、移除展开类、重建折叠列表、
  `messages` 立即可见）——实测渐隐途中点击新会话或切换身份后
  **下一个采样（<60ms）**即见旧行清空、折叠两行就位、消息区已显示，
  不等 400ms 退出定时器。真实登录/登出面板流同验。
- **历史选择**：展开态点击第 3 条（兵马俑华清池一日）→ 会话恢复
  （用户消息含「验收标记T3」）、该条转为活动项退出历史列表、
  折叠干净、焦点回 `message-input`。
- **身份切换边界**：展开动画进行中（点击后 110ms）提交登录 →
  `setIdentity('u-u-demo')` 折叠并渲染 `账号·` 桶 3 条；展开中登出 →
  回 guest 桶。两向均无残留。
- **窄屏 390×844**：底部抽屉卡内展开/收起动画签名一致，行全部在
  视口内（无纵向溢出）。
- **prefers-reduced-motion**：`Emulation.setEmulatedMedia` reduce 下
  `still()` 走同步路径，`history-enter` 动画关闭；450ms 内落终态，
  8 连点终态一致。

## 录屏清单（docs/issue-16/video/）

| 文件 | 内容 | 规格 |
|---|---|---|
| expand-collapse-desktop.mp4 | 1440×900：展开→收起→10 连点风暴→展开选第 3 条恢复 | ~8.6s, 30fps, 1280 宽, ~125KB |
| expand-collapse-desktop.gif | 桌面录屏前 ~4.2s（一个完整展开/收起循环） | 760 宽, 12fps, ~205KB |
| expand-collapse-narrow.mp4 | 390×844：展开→收起→8 连点 | ~5.3s, 30fps, ~47KB |
| *.frames.json | 各段 screencast 帧时间戳清单（节奏可复核） | — |

合成方式：`Page.startScreencast` 原始帧 → ffconcat 按帧时间戳还原真实
节奏 → `fps=30,scale≤1280` → libx264(crf28,yuv420p)。已抽帧复核：
t≈0.55/0.60s 见逐条上浮渐显中间帧（第 2/4 行半透明），t≈2.1s 见
顶行先行隐去的阶梯渐隐中间帧 —— 录屏内容为真实 CSS 中间帧。

## 录屏技术说明（复现须知）

Chrome 必须 **headed**：headless 模式下合成器仅在页面产生 damage 时
出帧，本特性的 WAAPI transform/opacity 动画为合成器驱动、不触发
damage —— 实测 headless screencast 在整个编排中只交付 4 帧/6.7s；
改为 headed 后 ~22–60fps 连续帧。`screencapture -v` 备选方案因终端
无 Screen Recording 权限（TCC）不可用。headed 录制会在屏幕上短暂
弹出 Chrome 窗口（~20s，窗口置于 40,40 不遮挡桌面大部）。

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
- [x] before/after 全场景截图 + 采样序列 metrics（26 断言：before 5 FAIL
      对照，after 26/26 pass，exit 0）
- [x] 桌面+窄屏录屏，真实中间帧已抽帧复核
- [x] 快速连点（10/9/8 三组风暴）、历史选择同步恢复、**收起渐隐途中**
      新会话/身份切换同步拆除、reduced-motion 边界全部覆盖
- 验证对象 = `49e53f8` + `7d44e9e` + 未提交产品增量（`collapseNow`/
  `rowMeta`/`cancel()+fill:'both'`）；`ec5d0e1` 系中间 amend。
  若产品增量另有提交，其内容与本文已验证状态一致（同一工作树）
