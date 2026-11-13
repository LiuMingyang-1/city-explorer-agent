# 西安漫游前端

独立静态前端，AI 对话通过同源 `/api/chat/stream` 接口调用仓库 Agent 后端，不在浏览器保存模型密钥。

## 运行

在仓库根目录运行：

```sh
npm run dev:frontend
```

打开 http://127.0.0.1:5173 。要求 Node.js >=22.19，无需安装 npm 依赖、运行 seed 或创建 `.env`。
端口被占用时可使用 `FRONTEND_PORT`，绑定地址通过 `FRONTEND_HOST` 配置，默认只监听本机。
也可将本目录部署到任意 HTTPS 静态托管服务。入口是 `index.html`，不需要构建。

## 功能与边界

- 全屏西安地图，默认 WGS-84 坐标 `[34.27, 108.95]`、缩放 11，支持拖动、滚轮和缩放控件。
- 深色半透明玻璃卡片、按本机时间变化的中文问候、地点搜索、浏览器定位、实时天气。
- 定位拒绝、超时或不支持时，静默保留西安市中心。浏览器定位要求 localhost 或 HTTPS。
- 19 个主要 4A/5A 景点标注点（含联合景区内的独立参观点），标签自动避让；搜索结果常驻显示名称。
- 回车或发送按钮与后端 Agent 对话；消息自动滚到底部。地图虚线按后端返回的活动坐标表示推荐游玩顺序，不是实际道路导航。
- 输入框位于卡片中部；右上角“新聊天”会清空当前对话和路线，取消在途请求，并开始新的后端会话。
- 底部显示最近两条历史规划与“更多历史规划”，点击可恢复消息、路线和既有 `session_id` 继续对话。历史快照保存在当前浏览器 localStorage（最多 20 段、每段最近 60 条消息）；不是跨设备的服务端历史列表。无历史时显示空状态，不填充虚构记录。
- 每次打开页面默认开始新对话，不自动恢复旧会话；浏览器禁止存储时仍可在当前页面使用历史。跨对话长期记忆仍由后端维护。
- `npm run dev:frontend` 只托管静态文件，不代理 `/api/*`；单独运行时对话不可用，需由后端同源托管本目录。

## 地图和外部服务

| 用途 | 服务 | 说明 |
| --- | --- | --- |
| 地图交互 | Leaflet 1.9.4 | 本地打包，开源 |
| 矢量底图渲染 | MapLibre GL JS 5.6.1 + Leaflet adapter 0.1.3 | 本地打包，开源；依赖 WebGL |
| 地图数据 | OpenFreeMap / OpenMapTiles / OpenStreetMap | `assets/quiet-map.json` 自定义浅色样式；无需 API Key |
| 地图失败兜底 | OpenStreetMap 标准栅格瓦片 | 矢量加载失败或不可用时自动切换 |
| 地点搜索及逆地理编码 | Nominatim | 提交时查询，串行限速并缓存 |
| 实时天气 | Open-Meteo | 自动随所选地点更新；失败显示暂不可用 |

地图、搜索、天气需要网络。无高德配置时使用 WGS-84；启用高德后，外部 WGS 点与轨迹通过官方入口转换为 GCJ-02。
保留页面内的地图版权标注，遵守各服务的使用政策；正式大规模部署需配置适合流量的服务。
第三方库许可证见 `assets/*LICENSE.txt`。

景区等级依据西安市文旅局《西安市A级旅游景区信息表》（截至 2026-02-25）：
https://wlj.xa.gov.cn/wlml/lyjq/1.html 。坐标来自 OpenStreetMap/Nominatim，静态内置；这是精选点位，不是完整实时名录。

## P0 组件与样例联调

活动卡、A/B 对比、提供的道路轨迹与通勤时间、SSE 阶段接收已接入。
运行 `npm run dev:frontend` 后访问 `http://127.0.0.1:5173/?mock=comparison`，发送一条需求即可使用 `docs/mocks/day0/` 的样例演示，无需模型密钥。更多样例、API 兼容与未完成联调项见 [P0 前端交付](../docs/p0-frontend.md)。

## Agent 接口

对话逻辑在 `chat.js`：发送默认走 `POST /api/chat/stream`（body 为 `{message}`，带 `location` 与既有
`session_id` 时一并发送），成功返回 `{kind:'clarification',session_id,question}` 或
`{kind:'itinerary',session_id,itinerary,events}`，前端记下 `session_id` 续用同一对话，
非 2xx 返回 `{error}`；`GET /api/chat/history?session_id=…` 可显式还原指定对话
（不带参数返回空历史，不产生任何服务端记录）。接口为同源相对路径，依赖同源 cookie 会话。

## 检查

```sh
npm run check:frontend
```

手动验收：地图显示和缩放、定位允许/拒绝、搜索地址后名称标签、放大镜范围内的圆角悬停效果、
天气更新、连续发送消息、窄屏布局，以及 WebGL 不可用时的栅格地图兜底。

## 地图替换调研

高德 JS API 2.0 可替换当前地图，并通过浅色主题、自定义样式和要素控制接近现有画面；正式切换需配置 Key、安全代理并处理 GCJ-02 坐标。已支持配置后启用高德，无配置时使用 OpenFreeMap。详见 [高德可行性调研](../docs/amap-feasibility.md)。

高德切换所需配置和获取入口见 [高德准备清单](../docs/amap-setup.md)。

## 高德地图运行配置

填写根目录 `.env` 中的 `AMAP_JS_KEY` 和 `AMAP_SECURITY_JSCODE` 后，`npm run dev:frontend` 会启用原生高德地图、搜索、定位转换和天气。默认 `AMAP_STYLE=amap://styles/fresh`。不配置则保留原有底图；安全密钥通过同源代理使用，不写入网页。P0 方案可显示 WGS84 或 GCJ-02 轨迹，前者在入口转换一次。后端位置契约的兼容边界见 [高德准备清单](../docs/amap-setup.md#已实现的运行入口)。

地图活动假数据已随前端提供，执行 `npm run mock:events` 可从仓库种子模板重新生成当天起 7 天的数据，不必下载或修改数据库。`-- --date=YYYY-MM-DD` 可固定日期。活动点点击打开右上角预览；聊天方案入口点击后覆盖左卡，左上角返回对话。演示配图与活动均有标识；默认读取 `/api/events`（GCJ-02）；独立静态开发环境没有该 API 时回退演示数据。`WANDER_CONFIG.eventsEndpoint` 可替换活动列表地址，字段见 `docs/p0-frontend.md`。
