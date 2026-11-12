# 西安漫游前端

独立静态前端，AI 对话通过同源 `/api/chat` 接口调用仓库 Agent 后端，不在浏览器保存模型密钥。

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
- 每次打开页面即开启一段新对话（后端按 `session_id` 落库，历史不自动恢复）；跨对话连续性由后端长期记忆提供。
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

地图、搜索、天气需要网络。浏览器定位坐标与底图统一为 WGS-84。
保留页面内的地图版权标注，遵守各服务的使用政策；正式大规模部署需配置适合流量的服务。
第三方库许可证见 `assets/*LICENSE.txt`。

景区等级依据西安市文旅局《西安市A级旅游景区信息表》（截至 2026-02-25）：
https://wlj.xa.gov.cn/wlml/lyjq/1.html 。坐标来自 OpenStreetMap/Nominatim，静态内置；这是精选点位，不是完整实时名录。

## Agent 接口

对话逻辑在 `chat.js`：发送走 `POST /api/chat`（body 为 `{message}`，带 `location` 与既有
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
