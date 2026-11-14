# Issue #24 验证记录 — 规划卡片横向独立容器化

## 范围与职责

验证者 B（SWE-2-Max）：独立浏览器验收、before/after 截图与验证报告。
产品实现 A：`issue24-plan-card` 分支，产品 SHA `f2c2ace`（base
`c993f38`）。`before/` 为该基线的 `git archive` 只读导出捕获，
`after/` 为 `f2c2ace` 工作树实测，同一驱动产出、同场景同视口。
本文档只覆盖 Issue #24；「更多历史规划」上滑渐显动画属 PR #27
范围，不在本分支，未验证。

## 运行命令

```bash
# 基线导出（只读，不触碰工作树）
mkdir -p /tmp/issue24-baseline && git archive c993f38 frontend docs/mocks/day0 | tar -x -C /tmp/issue24-baseline

# 截图与布局度量（自带静态服务 + CDP 驱动，无第三方依赖）
node docs/issue-24/capture.mjs --root /tmp/issue24-baseline/frontend --mocks /tmp/issue24-baseline/docs/mocks/day0 --profile before --out docs/issue-24/before
node docs/issue-24/capture.mjs --root frontend --mocks docs/mocks/day0 --profile after --out docs/issue-24/after

# 定向补拍（390px 卡片曾低于消息视口折叠线；scrollIntoView 后重拍同名图）
node docs/issue-24/capture.mjs --root <frontend> --mocks <day0> --profile <before|after> --only=narrow --out <dir>
```

两次完整运行 exit 0；`--profile before` 只跑几何/交互断言（图标、
圆角、无包边等新结构断言仅 `after` 生效）。全量测试与 Reviewer
断言由他人负责，未重复执行。

## Mock 范围

- 页面以 `?mock=comparison` / `?mock=single` 运行，走产品真实
  `WanderTransport` mock transport，数据为仓库
  `docs/mocks/day0` fixtures（SSE 流式与 JSON 两种格式都覆盖）。
- `docs/issue-24/capture.mjs` 内嵌服务：`/__mocks/day0/` 别名至
  `--mocks`；`/api/me` 恒返回 `{authenticated:false}`（guest）；
  其余 `/api/*` 404，页面走真实回退（`/data/demo-events.json`、
  OSM 栅格瓦片）。
- fixtures 原样为 GCJ-02（生产后端配高德）；本 harness 无高德 key，
  服务端传输层将 `coordinate_system` 运行时改写为 WGS84，使
  真实 Leaflet 绘路/选路高亮路径可执行（仅坐标系声明改写，
  事件与轨迹数据不变）。
- 历史条目通过 `Page.addScriptToEvaluateOnNewDocument` 预置
  `wander.chat-history.v1.demo.guest` 桶（2 条无方案会话），
  与运行中真实 `capture()` 生成条目叠加，保证「更多历史规划」
  展开有新增行可见；恢复路径走真实 `WanderHistory.open()`。
- 未 mock 的真实外网：地图瓦片（OpenFreeMap/OSM）、open-meteo
  天气、nominatim。截图底图与天气为真实网络结果。

## 截图清单（before/after 同名）

| 文件 | 内容 |
|---|---|
| desktop-plan-card.png | 1440×900 双方案卡片新生成 |
| desktop-plan-detail.png | 卡片展开详情（方案 A/B tab） |
| desktop-plan-card-long.png | 注入 108 字符无空格标题+超长中文标题 |
| desktop-history-expanded.png | 「更多历史规划」展开 3 行 |
| desktop-plan-restored.png | 历史条目点击恢复，卡片重建 |
| desktop-plan-card-single.png | `?mock=single` 单方案卡片 |
| narrow-plan-card.png | 390×844 卡片完整可见（已 scrollIntoView 补拍） |
| narrow-plan-detail.png | 390×844 详情全屏覆盖 |

## 断言清单（capture 自动判定；after 31/31 pass，exit 0）

| 断言 | 语义 | 结果 |
|---|---|---|
| card-present | 表单发送后 `.plan-preview` 出现 | pass |
| card-in-viewport / card-no-text-overflow | 桌面卡片不越视口、无横向溢出 | pass |
| card-icon | `.plan-preview-icon` 存在且 ≥36px（实测 46×46，`flex:0 0`） | pass |
| card-large-radius | 卡片圆角 ≥15px（实测 19px） | pass |
| card-no-bubble-frame | 外层 `.plan-bubble` padding/背景/边框全 0 | pass |
| detail-opens | Enter 展开 `#plan-detail`，`aria-expanded=true` | pass |
| ab-switch-selects-b | 方案 B tab 切换 `aria-selected` 与摘要同步 | pass |
| escape-restores-focus | Esc 关闭且焦点归还 `.plan-preview` | pass |
| back-button-returns | `←返回对话` 关闭且焦点归还卡片 | pass |
| long-title-*（5 项） | 注入超长/无空格标题后卡片不溢出且结构断言同上 | pass |
| more-history-expands / collapses | `aria-expanded` 切换、行数 2→3、消息区隐藏/恢复 | pass |
| history-restore-card / restored-*（5 项） | 历史恢复卡片存在且同构同断言 | pass |
| single-*（5 项） | 单方案卡片同构无溢出 | pass |
| narrow-no-overflow | 390 宽 `docScrollW≤391`、卡片在视口内 | pass |
| narrow-icon-not-squeezed | 窄屏图标 ≥36px（实测 40×40） | pass |
| narrow-detail-fits | 390 宽详情面板不越界 | pass |

before 基线几何断言同步通过；结构基线对照：`.plan-preview` 纵向
卡片嵌于 `.bubble.plan-bubble`（padding 13px、半透明背景），无图标
——metrics.json 留有 before/after 全量度量供 diff。

## 已知边界（非缺陷）

- 底图/天气/地理编码为真实网络；无高德 key，`WanderAMap.ready`
  恒 false，绘路走 Leaflet 回退（经坐标系改写，见 Mock 范围）。
- 程序 `.click()` 不转移焦点；键盘路径经真实
  `Input.dispatchKeyEvent` 验证（Enter 展开、Esc 焦点归还）。
- mock 数据带「示例行程 · 非真实活动」徽标，为 fixture 固有。
- 历史条目滚动到位经 `scrollIntoView` 补拍窄屏图；before/after
  同参数同流程，可复跑。

## 最终检查状态

- [x] after 浏览器断言 31/31 pass（exit 0）；before 几何断言全过
- [x] before/after 同场景同视口截图 8+8，全部打开视觉核查
- [x] 单/双方案、新生成与历史恢复外观一致；点击/键盘/返回、A/B
      与地图联动照常
- [x] 窄屏长标题/无空格文本不溢出，图标不压缩
- [x] 外层气泡包边移除（padding/背景/边框均为 0）
- [x] 未修改产品/test；改动仅 `docs/issue-24/`（capture.mjs +
      before/ + after/ + 本文档）
