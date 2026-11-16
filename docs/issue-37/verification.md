# Issue #37 验证记录

截至 2026-11-15，**真实 Chrome + Leaflet 回退路径验收通过；真实高德 SDK 补验已跑完且 failures=[]（见 `real-amap/` 与 `real-amap-final/`，`.env` 配置后 `hasSDK:true`，覆盖桌面/390/320 三档、A/B切换、快速反转、reduced-motion、reset、历史恢复）。** UI浏览器断言76/76、最新业务/路线断言26/26、reset补验10/10、全部测试897/897通过（其中前端120项）。类型检查和check:frontend通过。（注：此节写于真实高德补验完成前；`real-amap-final/metrics.json` 为该补验的最终证据。）

`feat/itinerary-main-view` 是独立设计实验，禁止合并 main、部署正式环境和自动删除分支。验证者 C 只修改 `test/` 和 `docs/issue-37/`，未提交代码。不能据此报告认定已获用户采纳或上线授权。

## 当前实现与证据

当前产品采用 **#map-shell 实际 left/top/width/height/border-radius 动画**，唯一 #map 随容器尺寸变化。早期全屏画布 clip-only 方案已经被替代，不应再按旧接口评价最终版本。地图控制器根据实际尺寸逐帧 resize、即时 fit；没有通过 transform scale 拉伸地图。

| 证据 | 用途与结果 |
|---|---|
| `final-ui-active/metrics.json` | 76/76：1440×900、390×844；进入/返回、A/B、焦点、快速反转、历史恢复、reduced motion |
| `final-ui-active/*.png` | 生成、进入中间态、详情A/B、返回、恢复；最新完整 UI 截图集 |
| `final-sampling/samples.json` | 1440/390/320×844，进入与返回各1500ms连续rAF采样；实际尺寸、相机、canvas、站点、旧卡片位置 |
| `final-sampling/*-detail.png` | 桌面、390、320详情截图；已打开视觉核查 |
| `final-business/metrics.json` | 22/22：业务集合、方案筛选、异步feed、快速切换/resize、返回、新聊天清理 |
| `final-business/*.png` | 探索、A/B详情、窄屏中断切换、返回和新聊天；已打开B、返回和reset截图核查 |
| `*/product-sha256.json` | 运行结束时的产品文件哈希；产品之后再变更应复跑 |

`baseline/` 是 HEAD `535826d2b7d632e2e8430852f84680b785d22ff8` 的只读导出对照。`after/`、`ui-pass/`、`business-leaflet/` 保留早期联调和失败证据，**不能作为最终通过截图**。

## UI、状态与键盘

- 生成方案后保持 explore，没有自动进入详情；主动 Enter/点击才进入。
- `WanderItineraryFocus` 与 `wander:itinerary-focus` 同步，监听器能立即读到对应全局状态。entering/detail携带完整 normalized 双方案模型，切换B后 active_plan同步；leaving为false带模型，最终explore为false/null。
- 返回按钮获得进入焦点；旧卡 inert/aria-hidden。Tab不会进入隐藏会话卡，Escape/返回将焦点归还预览卡。
- 进入→80ms后离开→80ms后再进入并选B，最终detail/B一致；无残留transition。
- 新聊天同步退出focus；历史恢复保持explore，主动重开保留B选择。
- reduced-motion在390px进入/返回100ms内收敛；无横向溢出。
- 详情主次、圆边渐隐、轻阴影、标题与辅助地图的关系已在桌面及320/390截图核查。fixture图片可能显示“图片暂缺”，这是example.com资源回退。

## 动画、尺寸与相机

连续采样在浏览器单次异步evaluate内运行rAF，避免截图命令等待改变中间态时间。约每100ms记录一次，保留完整1500ms序列。

| 视口 | #map起始→详情真实尺寸 | 稳定站点map-local坐标 |
|---|---|---|
| 1440×844 | 1440×844 → 590.8×590.8 | (238,338)、(355,253) |
| 390×844 | 390×844 → 202.8×202.8 | (44,145)、(161,60) |
| 320×844 | 320×844 → 166.4×166.4 | (32,120)、(135,46) |

旧卡片桌面x依次28、-190、-344、-419、-455；opacity依次1、.779、.424、.198、.075。窄屏同样连续左移并渐隐，地图与其同步收缩。真实resize后站点坐标为map-local，应加上#map左上偏移再与页面圆框比较。

进入后1000–1500ms所有采样的center、zoom及站点坐标完全相同；本次Leaflet路径未发现终点二次跳动。canvas CSS/backing尺寸随容器适配，序列保留供reviewer检查；不依靠截图观感推断尺寸。当前样本路线与两个重要站点完整落在圆内。

## 业务点与异步回归

业务脚本额外mock `/api/events` 为固定WGS84 feed：比较fixture的四个活动，加一个“验收专用·行程外活动”。地图SDK、布局、图层绘制与产品JS都是真实执行。生成前后及返回后设为相同1440px视野 `[34.25,108.95], zoom=13`，避免把相机变化误判成业务过滤。

- 生成前/后/返回的13个附近景点marker标题集合完全一致，行程外feed活动保持可见。
- 探索有A/B两条路线、4个站点；A详情仅A的2站/1路线，B详情仅B的2站/1路线。
- 详情附近景点和活动气泡隐藏，底图标签不在业务图层统计内。
- 详情中真实执行 `WanderActivities.reload()`，异步feed完成不会重新暴露行程外标记。
- 进入中快速A/B并resize至390px后，最终只剩B的2站/1路线；返回原集合及双路线恢复。
- 进入后立即新聊天并等1500ms，phase仍explore、activePlanId=null，旧路线与站点均为0。

曾发现两个联调问题，均已直接反馈B并复验：早期全屏clip的相机目标错位导致站点被裁；reset监听器清模型后，UI的leaving事件重新带回旧模型并异步重绘旧路线。当前真实尺寸方案和reset保护后均不复现。旧失败JSON保留以便对照。

## 自动化回归

```bash
node --test 'test/frontend-*.test.ts'
npm run check:frontend
node --check frontend/itinerary-map.js
```

全部测试897/897通过（其中前端120项）；前端语法与新增控制器语法通过；按明确授权执行npm ci安装锁定依赖后，npm run typecheck通过。早期缺tsc的环境阻塞已解除。

新增8项有意义回归：

- `test/frontend-itinerary-focus.test.ts`：生成/完整模型/同步事件；历史恢复；快速反转旧timer失效；reset同步退出后旧timer不得回detail；fallback时间已过但实际尺寸未到位时，不得发布detail。
- `test/frontend-itinerary-map-reset.test.ts`：保持生产脚本加载顺序（控制器在plans前），让进入/离开的调色板回调在reset后完成，验证不能重新挂载旧路线图层。它覆盖浏览器发现的异步重生路径，不只验证UI状态。

- `test/frontend-itinerary-amap-contract.test.ts`：真实adapter+controller+plans配SDK mock，验证唯一native实例、resize/immediate fit/圆内padding/业务筛选恢复及迟到palette取消。仅验证API契约，不证明真实高德画布视觉。

## 本地复现与预览

```bash
# 产品本地预览；打开URL后发送任意规划请求
npm run dev:frontend
# http://127.0.0.1:5173/?mock=comparison

# 下列脚本自带静态服务与无头Chrome/CDP，无第三方测试依赖
node docs/issue-37/capture.mjs --root frontend --out /tmp/issue37-ui --port 5441
node docs/issue-37/sample.mjs --root frontend --out /tmp/issue37-samples --port 5440
node docs/issue-37/business.mjs --root frontend --out /tmp/issue37-business --port 5443
```

脚本自动查找已安装Chrome；可传 `--chrome <可执行文件>`。截图服务仅绑定127.0.0.1。基线是 `git archive HEAD frontend docs/mocks/day0` 只读导出至 `/tmp/issue37-baseline`，复用 `docs/issue-24/capture.mjs --profile before`；其历史折叠断言只等260ms、早于当前动画结束而失败。已有history-motion测试通过；最终本任务以等待稳定态为准，没有削弱消息恢复要求。

## Mock与真实高德边界

所有截图使用真实Chrome/真实Leaflet（底图OpenFreeMap/OSM）+仓库mock行程，不是在线AI或真实高德截图。普通capture服务mock guest `/api/me`；其余API404，活动走demo回退。行程fixture坐标系声明GCJ-02→WGS84，仅用于执行Leaflet路径，坐标数字未转换，不能据此证明地理准确性。business脚本的额外feed如上所述。瓦片、天气、地理编码尝试真实外网；不保证每个外部请求成功。

已有5173产品预览 `/api/map-config` 实测200、`enabled:false`、无jsKey，因此本环境无法验证真实高德canvas重排、SDK内部fit动画及渲染连续性。未输出密钥、未改配置。VM图层测试不能替代真实高德视觉验收；这项仍需在配置齐备的独立预览上补验。

`reference.png` 为issue用户原始附件，已打开研究：借鉴左侧阅读主体、右侧辅助地图、宽柔边融合与轻阴影；不复制其世界地图、文案或照片色偏。实验分支保留供用户体验比较，无正式发布结论。


## 最终相位与相机补验

最新 `final-ui-active/metrics.json` 76/76通过，额外检查了每一个稳定detail/explore事件**发布当刻**的shell与目标frame/canvas几何相差<1px；不是等截图完成后才判断。`final-sampling/stability.json` 比较首个稳定detail采样及其后约100/400ms：1440、390、320三个宽度的center、zoom和站点坐标都完全相同。首个稳定采样约915/986/908ms，不代表动画设计时长改变，而是100ms采样粒度和渲染调度的观察值。

诊断中曾出现返回6秒超时，证据保留在 `final-ui/`、`final-ui-recheck/`、`final-ui-foreground/`：另接CDP读到 `document.hidden=true`，performance已过70秒，但CSS动画currentTime停在约99ms，rAF未执行。仅禁用后台timer节流/bringToFront不能解决；脚本现额外 `Emulation.setFocusEmulationEnabled({enabled:true})` 模拟活动页面，复跑通过，没有增加等待超时或弱化几何断言。该环境失败不能算产品返回回归。相位守卫在CSS未到位时维持leaving符合契约。旧失败目录仅供诊断。

## 正式交付核对

收到A/B正式交付通知后再次计算8个产品文件SHA-256：与 `final-ui-active/`、`final-sampling/`、`final-business/` 三份验收manifest全部一致，无新增产品改动，因此未重复执行相同测试。

canvas尺寸证据（CSS实际宽高与backing完全相同；含renderer自身瓦片padding）：1440进入从1584×928变为651×650，390从429×928变为223×224，320从352×928变为183×183。说明实际renderer画布跟随容器resize，未用CSS把旧画布拉伸成圆形。此证据属于Leaflet/MapLibre回退，不能替代高德SDK验收。

站点圆内定量补查：按map偏移+local point计算screen point，两个站点距frame圆心/直径在1440px约.121/.124，390px约.355/.358，320px约.379/.383，全部小于.44；精确值见 `final-sampling/station-circle-check.json`。


## 路线bbox补验（回应旧ui-pass截图）

最新 `final-route-fit/metrics.json`：26/26通过，补充直接读取Leaflet route-track每个实际几何顶点，经 `map.latLngToContainerPoint` 加#map偏移，计算屏幕bbox和圆心距离。A/B详情、异步feed后、窄屏resize快速切换后，所有顶点均距圆心<.44×圆直径。最终图应读 `final-ui-active/desktop-detail.png`、`final-ui-active/narrow-detail.png` 或 `final-route-fit/`，不能使用早期失败的ui-pass。旧目录已增加README说明，入口见本目录README。

## 独立reviewer指定 reset / palette / pan / resize补验

`node docs/issue-37/reset.mjs --root frontend --out docs/issue-37/final-reset --port 5452`：10/10断言通过，实际Chrome/Leaflet路径。

先进入稳定详情，拦住真实palette完成回调，再通过新聊天reset；100ms时phase=explore且站点/路线均0。随后释放palette并等待1500ms，仍无旧路线。再手动setView至 `[34.4,109.3], zoom=12`，把视口改1050×780：旧行程fitBounds调用次数为0，zoom仍12，视野保持在手动指定区域，路线与站点仍0。证据见 `final-reset/metrics.json`、`reset-after-late-palette.png`、`pan-resize-after-reset.png`，对应产品哈希同目录。

reviewer所述reset→leaving旧model复活路径曾被C发现并交B修复；当前 `onFocus` 已有 `focus.model&&(focus.active||fullModel)` 保护。`frontend-itinerary-map-reset.test.ts` 明确按生产顺序加载controller→plans→transport→chat，覆盖延迟palette后reset；不要仅用未加载controller的focus契约测试代替此集成回归。

当前package的 `check:frontend` 已包含 `node --check frontend/itinerary-map.js`，实际运行通过。该package改动非C所写。

### #32时间边界

`frontend/route-visuals.js` 当前duration仍为 `clamp(1400+Math.sqrt(total)*20,1800,3600)`，普通运动模式的完整线条动画为1800–3600ms。HEAD基线相同，工作树对此文件无diff。**因此本分支未满足#32的路线绘制≤1秒要求，也没有修复该既有问题；不能把它描述为本次#37引入的回归。** #37页面/容器过渡为另一项行为，不能用其约820ms证明路线绘制满足1秒。


## 依赖、全量与SDK契约收尾

按主持人授权执行 `npm ci --cache /private/tmp/issue37-npm-cache --no-audit --no-fund`，4秒安装95个锁定包；生成node_modules，未改package/lock。当前package相对HEAD的唯一差异是主持人先前加入新控制器语法检查；package-lock无diff。

`npm run typecheck`（含全部新增测试）exit0；`npm run check:frontend` exit0。全量首次在限制环境运行时，99项因 `listen EPERM 127.0.0.1`失败；未修改产品去规避。允许本机监听后重跑 `npm test`：897 tests /897 pass /0 fail /0 skip，约11秒，日志见 `full-tests.log`。全量已包含SDK契约新增2项，前端合计120项。早期114/118项只是中间快照，不是最终计数。

SDK mock通过生产的 `amap.js`、`itinerary-map.js`、`plans.js`，而非直接mock WanderAMap接口：进入/选B/返回不新增native Map；当前400px圆对应 `[76,76,76,76]` padding；逐帧setFitView使用immediate=true与完整轨迹+两站；附近景点/活动在详情隐藏、返回恢复；clearRoutes后迟到palette不会新增layer或fit。它不模拟高德真实渲染器的canvas、WebGL和内部重排，真实高德仍未覆盖。

## reviewer“上海→force sync”原样复验与版本对照

reviewer提供的失败快照controller为 `014782c6…`；当前controller为 `dca6bc3e810b9eb36748b5ec8b1a6ff2ce44234803ce6fb0c237f4756b587df6`，与C先前final-reset manifest一致。plans仍为 `ed31e36b58c30d3045f213afc67686eb9ca5f5e2f99e4bbb60c1e8550cf145ee`。不能把旧controller快照的真实失败外推到当前修复版本。

在当前工作树直接运行reviewer原文件 `/tmp/issue37-reset-browser.mjs --root frontend --out docs/issue-37/reviewer-exact-reset --port 5453`：latestPlan=null、focus=explore/null，平移上海后 `WanderItineraryMap.sync({force:true})` 的oldRouteFitCalls=0；未回到西安旧行程。原脚本不自带失败断言，因此此处依据保存的度量判定，而非仅根据exit0。after center仍在上海附近，resize更新自身中心不等于旧行程fit。

C的 `reset.mjs` 也加入上海 `[31.23,121.47],zoom10` 和显式force sync，再resize。`reset-force-recheck/metrics.json`：10/10通过，包括延迟palette释放后路线0、force+resize后fitCalls=0、仍为zoom10和上海区域、路线/站点0。该目录是reset专项的最新证据；此前final-reset保留为普通pan/resize证据。两个目录各含本次产品哈希，交独立reviewer复跑当前controller。
