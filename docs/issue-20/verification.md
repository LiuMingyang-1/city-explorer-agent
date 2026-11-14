# Issue #20 验证记录 — 全局右上角「记忆＋头像」入口

## 范围与职责

编码者 C：回归验证、截图证据、测试。`before/` 为 git 基线 `0a6a146` 的
只读导出（`git archive`，未 checkout 共享工作树）捕获；`after/` 为
A（index.html/style.css/motion-buttons.css）＋B（auth.js）落地后的
工作树实测，两者由同一工具产出。

## 运行命令

```bash
# 基线导出（只读，不触碰共享工作树）
mkdir -p /tmp/issue20-baseline && git archive 0a6a146 frontend | tar -x -C /tmp/issue20-baseline

# 截图与布局度量（自带静态服务 + CDP 驱动，无第三方依赖）
node test/issue20-capture.mjs --root /tmp/issue20-baseline/frontend --out docs/issue-20/before
node test/issue20-capture.mjs --root frontend --out docs/issue-20/after

# 回归测试与静态检查
node --test test/frontend-auth.test.ts test/frontend-account-entry.test.ts
npm run check          # typecheck + 全部 node 测试
npm run check:frontend # 前端脚本语法检查
```

## Mock 范围

- 由 `test/issue20-capture.mjs` 内嵌服务 mock：`/api/me`、`/api/login`、
  `/api/logout`（Cookie 会话，账号 `demo`/`demo-pass`，display_name「明轩」）、
  `/api/memory`（按身份的内存文档，访客与账号内容不同）。
- `/api/events`、`/api/map-config` 返回 404，页面走真实回退路径
  （`/data/demo-events.json`、OSM 栅格瓦片）。
- 未 mock 的真实外网：地图瓦片（openfreemap/OSM）、open-meteo 天气、
  nominatim 地理编码。截图中的底图与天气为真实网络结果。
- 详情面板复核尝试过真实 POI 点击（`.place-dot` → `openNearby`）：本
  harness 中 `/api/map-config` 为 404、`WanderAMap.convert` 不可用，
  `openNearby` 的 GCJ-02 距离匹配恒失配（3 次真实点击均为空态，已记录）。
  因此带按钮详情改经 `WanderActivities.openEvents`＋`/data/demo-events.json`
  真实活动对象打开——与 pin 点击调用的为同一函数路径，非合成 DOM 占位；
  按钮计数为 0 时断言仍会 FAIL。Reviewer 已用有效活动独立复核按钮
  y246–284 通过，与本结果一致。

## 截图清单（before/after 同名）

| 文件 | 内容 |
|---|---|
| desktop-logged-out.png | 1440×900 未登录全貌 |
| desktop-login-dialog.png | 头像点开登录对话框 |
| desktop-logged-in.png | 1440×900 已登录（头像显「明」） |
| desktop-account-menu.png | 已登录点开账号菜单（登出入口） |
| desktop-memory-panel.png | 记忆（偏好）面板打开（账号档内容） |
| desktop-detail-overlap.png | 真实 POI 详情面板与入口组几何关系 |
| narrow-logged-in/out.png | 390×844 已登录/未登录 |
| narrow-account-menu.png | 390×844 账号菜单 |
| narrow-memory-panel.png | 390×844 记忆面板全屏（入口组已让位） |
| wideshort-logged-out.png | 1440×600 宽矮窗口 |
| detail-with-actions.png | 1440×600 带操作按钮的活动详情 |
| short-detail-actions.png | 1280×320 宽矮窗口详情按钮可达性 |

`metrics.json` 记录布局矩形、可访问名、重叠/对齐度量及显式断言
（`assert: pass/FAIL` 字段；脚本有任一失败即以 exit 1 退出并打印
`FAILED:` 列表，`waitFor` 超时直接抛错中止本轮验证）。

## Before 基线要点（0a6a146）

- `登录`按钮与偏好齿轮位于左侧卡片内右上方（x≈286/344，卡片 28–489），
  `pairOverlapsCard=true`；页面右侧无入口。
- Tab 序：地图容器及其内部在前，入口对位于第 25/26 步；
  Enter 打开对话框、Escape 关闭并归还焦点（`keyboard-*` 条目）。

## After 实测结论

- 桌面 1440×900：`记忆`胶囊 (1276.2,28,83.8×40)＋头像 (1372,28,40×40)，
  与卡片顶对齐 Δ=0，右留白 28px，无溢出、不与卡片/详情重叠。
- 宽矮 1440×600：入口组按媒体查询收缩至 y=20，对齐 Δ=0，无溢出。
- 窄屏 390×844：入口组 (257,12)–(378,48) 无溢出；卡片为底部抽屉，
  入口置视口顶属预期适配。
- 详情面板：真实 POI 点击打开（`via:.place-dot`，西安城墙），
  面板 (968,86,446×441) 位于入口组下方，`pairOverlapsDetail=false`；
  × 按钮正常关闭。
- 窄屏记忆面板：开启时入口组 `opacity:0/visibility:hidden` 让位
  （`@media≤700px` 设计行为），`preferences-close` 可关闭并恢复入口
  （`restoredAfterClose: visible`）。
- 记忆读写：登录后 `/api/memory` 返回账号档（明轩示例），登出后为访客档，
  与身份隔离测试一致。
- 键盘：Tab 序与基线完全一致（入口对第 25/26 步，位于地图内部控件之后、
  卡片控件之前）；Enter 开框、Escape 关框且焦点归还 `auth-open`。
- 可访问名：未登录 `登录账号`，已登录 `账号菜单：明轩`，头像 span
  `aria-hidden` + `is-initial` 首字渲染。

## 断言清单（capture 脚本自动判定）

| 断言 | 语义 | 结果 |
|---|---|---|
| desktop-entry-aligned | 入口组顶与卡片顶对齐 Δ≤4px | pass (0) |
| desktop-entry-clear | 不溢出视口、不与卡片重叠 | pass |
| desktop-entry-names | `登录账号` / `记忆` | pass |
| keyboard-entries-tabbable | 两入口均在 Tab 序且相邻（mem→auth） | pass (25/26) |
| keyboard-enter-opens / keyboard-escape-restores | Enter 开框、Esc 关且焦点归还 | pass |
| signedin-accessible-name / avatar-initial | `账号菜单：明轩` / 首字「明」 | pass |
| detail-no-entry-overlap | 详情面板与入口组无重叠 | pass |
| narrow-entry-no-overflow | 390 宽不溢出 | pass |
| narrow-panel-yields-entry / close-restores | 面板开启入口让位、关闭恢复 | pass |
| wideshort-entry-clear | 1440×600 无溢出重叠、对齐 Δ≤4 | pass (0) |
| short-detail-actions-in-viewport | 1280×320 详情操作按钮在视窗内 | pass（按钮 y246–284；经由 openEvents+真实 demo 活动，见下注） |
| narrow-memory-focus-restored | 关记忆面板后焦点归还 `preferences-open` | pass（activeElement=preferences-open） |
| narrow-memory-focus-restored-reduced-motion | 同上，`prefers-reduced-motion: reduce` 下 | pass |

## 已知边界（非缺陷）

- 程序化 `.click()` 不转移焦点；键盘路径用真实 `Input.dispatchKeyEvent`
  验证，焦点归还按真实键序复核通过。
- `.global-entry` 在窄屏右侧面板打开时让位为刻意设计；桌面上面板从
  y=86 起在入口下方展开，二者不重叠。

## 最终检查状态

- [x] `npm run check`：typecheck + 855 tests 全过
- [x] `npm run check:frontend`：通过
- [x] `frontend-auth.test.ts` 13/13 + `frontend-account-entry.test.ts` 8/8
- [x] before/after 全场景截图与 metrics（登录/未登录/窄屏/宽矮/菜单/面板/详情）
- [x] 键盘可达性、窄屏让位与可关闭性、真实 POI 详情复核完成
- [x] Reviewer P2-1（1280×320 详情操作按钮）断言并通过
      （`min-height:min(300px,calc(100dvh-96px))` 生效；按钮 y246–284）
- [x] Reviewer P2-2（窄屏关闭记忆面板焦点归还）断言并通过：
      常规模式与 `prefers-reduced-motion` 下 `restoredFocus` 均为
      `preferences-open`（motion-buttons.css 已移除 visibility 过渡）
- [x] A 第二轮修复后最终重跑：浏览器断言 16/16 pass，exit 0；
      `npm run check` 855/855、`check:frontend` 通过
