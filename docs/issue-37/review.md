# Issue #37 独立审查

2026-11-15，独立 reviewer。结论：**发现的 P1 已由编码者修复并独立复验；当前无已知未修复代码阻断项。P2 语法检查接线也已补齐；真实 SDK 验收仍未完成，不能给出完整高德验收通过结论**。仅写此报告，未修改产品代码、提交、切换分支、合并或部署。分支 `feat/itinerary-main-view` 保留为实验；未来 PR 必须 Draft 并注明“实验预览，禁止合入 main”。

## 已修复 P1：详情态 reset 会重新装回旧地图模型

位置：`frontend/itinerary-map.js:69–90`，以及 `frontend/plans.js:178–195,255`（并发编辑可能使行号变化）。

`itinerary-map.js` 先于 `plans.js` 加载，reset listener 先清空 fullModel；随后 plans 的 reset listener 调用 closeDetail，仍用旧 currentView.model 发布 leaving。控制器 onFocus 又把旧模型装回并 redraw，最后 explore 的 null 模型没有清除它。history.clearConversation 后续清理地图图层不能清除控制器的私有模型。新聊天虽显示空白对话，下一次容器 resize 仍按旧行程 fit。

独立 VM 与真实 Chromium + Leaflet 均复现。真实浏览器先进入详情，再执行：

```js
document.getElementById('new-chat').click();
map.setView([31.23, 121.47], 10, {animate:false});
const before = map.getCenter();
window.WanderItineraryMap.sync({force:true}); // resize 调用的同一产品路径
const after = map.getCenter();
```

结果：`state.latestPlan=null`、focus=`{active:false,phase:'explore',model:null}`；fitBounds 仍被调用一次，中心从 `[31.23,121.47]` 跳回 `[34.2555000134,108.9562003174]`。真实浏览器原始记录 `/tmp/issue37-reset-browser/metrics.json`，驱动 `/tmp/issue37-reset-browser.mjs`；独立 VM `/tmp/issue37-review-repro.ts` 修复前也产生一次旧方案 fit。浏览器驱动使用真实 Leaflet 与产品 JS、mock 行程，不是 SDK mock。尚未据此声称已复现真实 AMap 或延迟 palette 的旧图层复活。

编码者随后在 onFocus 加入 `focus.model && (focus.active || fullModel)` 防止 reset 后 leaving 重新装回旧模型。reviewer 已用相同 VM 及真实 Chromium + Leaflet 复验：旧方案 draw/fit 为 0，平移后未跳回西安。修复后浏览器记录 `/tmp/issue37-reset-browser-fixed/metrics.json`。容器 invalidateSize 会调整同一区域中心，故这里只确认旧行程不再驱动 fit，未声称地图中心像素完全不变。新增 `test/frontend-itinerary-map-reset.test.ts` 已按 controller 先于 plans 的顺序测试延迟 palette 在 reset 后不再附加旧图层，最新独立前端测试 117/117 通过。真实 AMap 异步转换仍是未覆盖边界。

## 已修复 P2：新地图控制器未进入常规语法检查

位置：`package.json:21`、`test/frontend-itinerary-focus.test.ts`、`test/frontend-fixture.ts:84` 附近。

`check:frontend` 没有 `frontend/itinerary-map.js`。新增的两项 focus 测试使用 setup({api:true})，fixture 加载 plans 等脚本但没有加载 itinerary-map；因此不能覆盖这个实验最关键的过滤、resize、fit、异步取消和 reset 监听顺序。114 项前端测试全绿而 P1 稳定复现，说明缺口具有实际影响。审查期间 C 新增 controller 集成回归，延迟 palette/reset 缺口已补一项并通过；另新增圆形安全区测试。随后 package.json 已加入新控制器，reviewer 独立重跑 `npm run check:frontend` 通过，接线缺口已解决。 其他快速切换/坐标转换/SDK 行为仍需对应证据。

## 独立验证结果

- 已读 issue 正文、完整 tracked diff、新增 CSS/JS/测试、README 和文档索引；仓库未发现 AGENTS.md。未以编码者结论代替源码核查。
- `node --test 'test/frontend-*.test.ts'`：初轮114/114通过，最新新增回归后 **117/117 通过**；相关51项子集也通过。中间曾遇并发写入中的新测试 makeMessage 未定义，最终重跑已消失，不列为产品缺陷。
- `npm run check:frontend`、单独 `node --check frontend/itinerary-map.js`、`git diff --check` 通过。
- `npm run typecheck` 无法运行：`tsc: command not found`，未安装依赖、未宣称类型检查通过。
- 独立执行 `node docs/issue-37/capture.mjs --out /tmp/issue37-independent-browser --port 5449`，74 项浏览器断言通过，failures=[]。实际检查 Enter/Escape、Tab 不进入 inert 会话卡、A/B、快速反转、历史恢复、reduced-motion、桌面/390px 无横向溢出。该通用驱动先正常返回再新聊天，没有覆盖 P1 的详情直接 reset。
- 独立打开上述桌面/窄屏详情截图：详情内容居主，右圆地图辅助，柔边和阴影可见，当前 mock 两站路线在圆内。实际源码已采用单一真实地图容器的 left/top/width/height 动画，没有用 scale 拉伸地图。不能把单张截图作为全程帧率证明。
- 已读 C 的 verification.md 与其 ui-resize、process-sampling 记录；截至本次审查，文件明确真实 AMap、业务点集合和最终哈希绑定仍有待验收。其过程版 clip-only 问题已被真实尺寸方案替代，不作为当前缺陷。

## 既有要求与证据边界

- 路线绘制 1 秒要求在当前分支尚不满足：`frontend/route-visuals.js:83` 仍是 1800–3600ms，测试也按 3600ms 结束。HEAD 基线相同，**这是已有要求差异，不是本 diff 引入的动画时长回归**；需主持人明确安排，不能写成“维持 ≤1 秒已通过”。页面形态转换不受此上限约束。
- 本轮实际浏览器为 Leaflet/OpenFreeMap，行程使用仓库 mock 且只改坐标系声明为 WGS84，不能证明真实坐标准确性、在线生成或真实 AMap。尚无本 reviewer 的真实高德 SDK resize/fit/异步转换/连续帧证据。
- 业务点隐藏逻辑从源码看由全局 active 控制、模型保留全部 plans、详情 draw 过滤 active_plan；但未用真实高德业务集合探针验证全部附近点恢复及延迟 feed/转换回调，不能把通用截图数量当集合证明。
- 产品仍在并发修改。浏览器 74 项结论属于执行时工作树；随后 plans/controller 又有稳定判定调整，故不把该轮作为最终定版验收。最新 VM、定向真实浏览器和117项测试已重跑确认 P1 修复。

本次最终源码复核时关键哈希：

```text
plans.js          ed31e36b58c30d3045f213afc67686eb9ca5f5e2f99e4bbb60c1e8550cf145ee
itinerary-map.js  dca6bc3e810b9eb36748b5ec8b1a6ff2ce44234803ce6fb0c237f4756b587df6
map-layout.js     d624716f13b8c5504944dee293fd702484862665fc28f3c6a6b0a8df3f9b1170
```

Nowledge 检索仅作背景：MCP memory_search，query=`issue 37 行程详情 主视图 地图`，normal（请求未指定 mode），服务返回 strict/default；第1项 `605cdb68-5b44-4686-9e78-71cdbcbd0f92`，标题“行程详情 UI 与地图组的最终集成接口”，score=.99。其余结果无关，未采用；接口以实际文件为准。图工具未证明相同空间权限限制，按技能要求跳过图展示。


## 最终圆内 fit 与相机稳定补验

收到主持人关于 `ui-pass/desktop-detail.png` 与 `narrow-detail.png` 路线丢失的补充后，重新检查最新状态，没有用容器尺寸正确替代地图行为验证。首轮图为旧全屏 clip-only 过程版，不能用于最终结论。

独立运行最新 `sample.mjs`，输出 `/tmp/issue37-review-final-fit/samples.json`，1440/390/320px 的进入和返回各采样16帧。进入后1000–1500ms中心、zoom、站点屏幕坐标各只有一个唯一值，未发现结束后二次跳动。重新打开最新320px截图确认两站及完整折线路径可见。

另用独立 CDP 探针 `/tmp/issue37-final-route-camera.mjs` 读取**真实 Leaflet routeLayer 中全部 track 顶点和 station 点**，不是只检查目标框或模型数据。分别在1440/390/320px进入详情后切换 A/B，读取稳定时刻、再100ms、再400ms的相机和所有投影点。原始数据 `/tmp/issue37-final-route-camera/metrics.json`，failures=[]。

| 宽度 | 方案 | 实际 track / 顶点 / 站点 | 最远点距圆心 / 半径 | 三次相机及全部点坐标 |
|---|---|---|---|---|
| 1440 | A | 1 / 4 / 2 | .2476 | 完全一致 |
| 1440 | B | 1 / 4 / 2 | .2803 | 完全一致 |
| 390 | A | 1 / 4 / 2 | .7133 | 完全一致 |
| 390 | B | 1 / 4 / 2 | .7276 | 完全一致 |
| 320 | A | 1 / 4 / 2 | .7666 | 完全一致 |
| 320 | B | 1 / 4 / 2 | .7285 | 完全一致 |

所有折线顶点与站点中心都在圆内，折线段位于凸圆内；320px最小圆仍为站点中心保留约19px的径向边缘余量。此结果验证最新 mock A/B 几何的圆内 fit 和相机稳定，不能外推到任意实景路线或真实高德 SDK。

此轮关键产品哈希与上文最新哈希一致。C 的 `business-recheck/product-sha256.json` 也匹配这些文件，其业务回归 failures=[]；已核对最新 verification.md 将真实高德明确列为未验证。`package.json` 随后已将控制器纳入语法检查，独立执行通过。当前无已知未修复代码阻断项；真实高德、类型检查环境及既有路线1秒要求的差异继续保留为明确边界。

本轮背景检索：MCP memory_search query=`issue 37 圆形地图 fit 最终 验收`，未指定mode，服务返回strict/default；rank1仍为`605cdb68-5b44-4686-9e78-71cdbcbd0f92`，score=.9783540394。以实时源码与浏览器为结论依据；同空间图权限仍无法确认，未展示图。


## 新增待核查边界：最终完整 UI 复跑返回超时

在等待真实高德 SDK 补验期间，发现 C 新增 `final-ui/metrics.json` 和 `final-ui-recheck/metrics.json` 两轮都在 Escape 返回等待 explore 时超时。后者 fatal-state 为 phase=leaving，map=(395.8,72.8,1014.3,754.4)，尚未回到1440×900；先前进入/detail/B已通过。C最新会话明确该失败可重复、连续rAF驱动按钮返回却正常，正在定位真实产品/驱动帧推进差异。

因此上文“无已知未修复代码阻断项”限于已独立证明并修复的reset与语法hook，**当前完整UI最终验收应暂缓**，不能用旧74/74覆盖新失败。尚未将本现象判为确定产品P1；需对照真实可见浏览器和最终高德SDK，确定是否由产品触发、具体复现与影响。用户已授权C配置实验树.env尝试高德，reviewer不读取或输出密钥，等待真实结果后更新。


Reviewer随后独立重跑最新完整capture（端口5455），同样在desktop Escape后等待explore 6000ms超时，exit=1；记录 `/tmp/issue37-review-latest-full/metrics.json`。这是独立复现的新失败，不仅是转述C；根因与真实可见SDK影响仍待定位。


### 返回超时诊断关闭：隐藏页面暂停，活动页面独立复跑通过

C探针确认失败时document.hidden=true，CSS动画currentTime约99ms、rAF不推进，而performance已过70秒。驱动增加 `Emulation.setFocusEmulationEnabled({enabled:true})` 后保持原6000ms等待和严格几何断言，不修改产品代码。Reviewer独立复跑最新驱动，`/tmp/issue37-review-active-final/metrics.json` failures=[]，**76/76通过**。此前返回超时不列为产品阻断项；旧失败继续保留作诊断证据。当前等待C在用户授权.env配置后进行真实高德SDK尝试，再更新最终SDK边界，仍不提前宣称高德通过。


## C最终交付复核（120前端测试）

Reviewer已独立运行 `npm run typecheck`、`npm run check:frontend`、`node --test 'test/frontend-*.test.ts'`，均通过，前端**120/120**。原缺少tsc的环境问题已由主持人授权C执行npm ci解决，不能再沿用“typecheck未执行成功”的旧状态。package-lock无diff，package仍仅新增控制器语法hook。

已读新增SDK mock契约：真实amap.js/controller/plans运行，mock仅位于AMap SDK层。覆盖单native Map、400px圆[76,76,76,76] padding、immediate fit完整track与两站、隐藏/恢复附近业务点、切B及迟到palette取消。它不能证明SDK真实canvas/WebGL/内部fit行为。

独立核对final-ui-active、final-sampling、final-business、final-reset四份product-sha256.json，全与当前产品文件匹配。C全量日志full-tests.log为897/897通过，reviewer已检查日志末尾；这是C执行的全量结果，不冒称reviewer另跑897项。

C本轮仍报告真实高德enabled:false。由于用户随后授权复制.env，仍需C明确这是否为加载复制后.env并重启服务的实际结果；在收到这一配置尝试证据前，保留真实高德SDK待验证，不宣称完整高德验收通过。
