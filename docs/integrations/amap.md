# 高德地图接入

调研与核对日期：2026-11-12。对应当前西安漫游前端；已加入可配置的高德 JS API 2.0 提供方和服务端安全代理：配置后启用原生高德地图、搜索和天气，未配置或加载失败时保留原有底图，没有采用未授权的瓦片地址。现有 WGS-84 点和轨迹使用官方转换；原生 GCJ-02 不重复转换。实现遵循 [Day 0 约定](../contracts/day0.md) 的高德方向。

## 结论

1. **可以替换为高德。** 建议将地图渲染层改为官方高德 JS API 2.0，搜索、地理编码和真实道路路线逐步统一到高德。左侧玻璃卡片、历史规划和对话逻辑可复用。
2. **可以保持接近现有的简洁浅色风格。** 可先用 `amap://styles/light`（月光银）或 `amap://styles/whitesmoke`（远山黛），再在高德自定义地图平台调整颜色和要素、发布样式 ID。现有 OpenFreeMap 样式 JSON 不能直接导入；道路几何、字体和标注规则不同，不能承诺像素级一致。
3. 正式接入需要开发者账号、JS API Key、安全配置及部署域名；已完成 SDK 与地址服务的接口连通性验证；浏览器画面、速度和账号配额尚未实测。原有地图作为缺配置/加载失败时的回退。

## 如何保留当前画面

| 当前视觉元素 | 高德实现方式 |
| --- | --- |
| 浅灰绿底色 `#f2f4ef` | 自定义区域面颜色 |
| 浅绿公园 `#dee8d8`、林地 `#e1e9da` | 调整绿地、植被相关要素 |
| 淡蓝水系 `#d3e3e6` | 调整水面、水系颜色 |
| 白色道路、浅灰道路边缘 | 调整道路分类颜色和层级 |
| 隐藏密集商家、建筑和道路编号 | 控制底图要素，并在自定义样式中细化文字与分类规则 |
| 主要景区、搜索点和路线 | 用自定义点标记、文字标注及折线独立绘制 |
| 深色玻璃卡片 | 普通 HTML/CSS 覆盖层，基本不受地图供应商影响 |

高德支持 `bg`（区域面）、`point`（兴趣点）、`road`（道路及标注）、`building`（建筑物）的显示控制。当前使用以下简洁主题配置；发布自定义样式后可替换样式 ID：

```js
const map = new AMap.Map('map', {
  viewMode: '2D',
  center: centerGCJ02, // 已转换/确认的 [lng, lat]，不能直接复用 WGS-84 坐标
  zoom: 11,
  mapStyle: 'amap://styles/light', // 调色完成后换成发布的自定义样式 ID
  features: ['bg', 'road'],
  showLabel: false,
});
```

`showLabel: false` 会一并隐藏内置地名和文字，不只是商家。若希望保留少量城市/区级名称，应使用自定义样式精细控制，或自行补充少量文字标注。主要景区与搜索点名称继续使用覆盖物显示。

## 接入与后端协作

- 原有 Leaflet/Nominatim 路径保留作回退；`frontend/amap.js` 已适配地图初始化、标记、折线、视野控制、高德搜索和天气，并非只换瓦片 URL。
- 高德搜索/路线返回 GCJ-02；现有 OSM/Nominatim、浏览器 GPS 以及样例中的 WGS-84 坐标必须按来源处理。GPS 使用官方 `AMap.convertFrom(points, 'gps', callback)` 转换一次，高德返回的数据不再重复转换。
- AMap 常用坐标顺序是 `[lng, lat]`，当前 Leaflet 常用 `[lat, lng]`，迁移时需同时处理顺序。
- 前后端统一坐标契约后，可以直接绘制后端高德 POI 和路径结果，减少偏移和二次转换。后端不依赖地图底图库本身；统一坐标和返回数据才是对接关键。
- 当前主分支通过 [agent-api 契约](../contracts/agent-api.md) 约定全链路 GCJ-02，支持 `active_plan` 与 `referenced_event_id`。前端遵循该契约，外部 WGS 数据只在地图入口转换，数据库不因底图库切换而重建。
- JS API Key 是浏览器 SDK 的公开标识，应设置域名限制；安全密钥建议留在服务器，通过官方 `serviceHost` / `/_AMapService` 代理配置使用。后端 Web 服务 Key 与模型密钥不放入静态前端或 Git 仓库。
- Open-Meteo 接收经纬度查询；切换到 GCJ-02 后应保留原始 GPS/WGS-84 天气查询坐标，或独立改用高德天气。不能把现有天气、定位、景点数据的坐标系标识直接改名。

## 实施顺序与验收

1. 配置 Key、安全代理、域名与样式 ID，先验证官方 SDK 及自定义样式可以加载。
2. 替换地图适配层；保留卡片、搜索点常驻名称、景区标签和聊天逻辑。
3. 校验现有景点、定位与后端活动坐标的来源，转换后绘制，确认几个已知地标没有明显偏移。
4. 接入高德搜索与实际道路路线；同一条路线检查点位顺序、折线、视野和名称。
5. 在用户实际网络与设备上测量首屏、拖动和缩放表现；国内可用性可能更合适，但不以更换供应商代替实测。

免费额度、账号类型、自定义样式权限及商业使用要求以控制台当时的套餐与官方条款为准，不在本次承诺永久免费或固定调用额度。地图版权、Logo 和必要的底图标注按官方要求保留。

## 准备清单

| 项目 | 从哪里取得 | 是否必须 |
| --- | --- | --- |
| JS API Key | 高德控制台 → 应用管理 → 我的应用 → 创建新应用/选择已有应用 → 添加 Key；服务平台选择 **Web端（JS API）** | 展示高德地图必须 |
| 对应的 `securityJsCode` | 上述 JS API Key 创建后的安全配置；与该 Key 配套 | 新申请的 JS Key 需要 |
| 部署网址和开发地址 | 使用实际网站域名，可沿用现有 Sites 预览域名；本地为 localhost/127.0.0.1 | 用于域名限制及部署配置 |
| 安全代理地址 `serviceHost` | 当前 Web/开发服务器已提供同源 `/_AMapService`；预览站点由 Worker 提供，服务器注入安全密钥 | 已实现，生产环境通过此代理使用 |
| Web 服务 Key | 同一应用下再添加一个 Key，服务平台选择 **Web服务** | 后端要调用高德 HTTP 搜索、地理编码或算路时需要；与 JS Key 分开 |
| 自定义地图样式 ID | 高德自定义地图平台创建、编辑并发布样式后复制 ID | 可选；第一版可以先用 `amap://styles/fresh`，不必等调色 |

已有后端同学申请过 Web 服务 Key 时，先确认其可用性、权限和存放位置，不需要在聊天中转发密钥或重复申请。

## 申请步骤

1. 登录 [高德开放平台控制台](https://console.amap.com/)，按平台提示注册开发者并完成要求的认证。
2. 进入 **应用管理 → 我的应用**，创建本项目应用或选择已有应用。
3. 添加 **Web端（JS API）** Key，取得该 Key 和配套安全密钥，设置实际使用域名的限制。
4. 若后端也要算路/搜索，再添加 **Web服务** Key。两个服务平台不要选混。
5. 确定部署位置：现有前后端能否同源部署，或者提供已部署的 `/_AMapService` 安全代理地址。
6. 如需完全按当前画面调色，再创建自定义样式；也可以先用官方浅色主题完成接入。

## 怎样提供配置

普通信息可以告诉我：部署网址、代理地址、是否已有 Web 服务 Key、希望先用官方浅色主题还是已有样式 ID。

密钥请通过开发环境的 Secrets/环境设置，或本机已忽略的 `.env` 配置；**不在聊天、GitHub Issue/PR 或提交文件里粘贴安全密钥和 Web 服务 Key**。建议配置名称如下，前两项已由地图端点读取；Web 服务 Key 留给后端算路：

```dotenv
AMAP_JS_KEY=
AMAP_SECURITY_JSCODE=
EXPLORER_AMAP_KEY=
AMAP_STYLE=amap://styles/fresh
```

JS Key 是浏览器 SDK 的公开应用标识；安全密钥留在服务器，前端使用官方 `serviceHost` 代理方式。Web 服务 Key 也只留在后端。额度和商用权限以当前账号控制台为准。

地图适配层已使用官方 `AMap.convertFrom` 处理已有 GPS/WGS-84 数据。现有 19 个景点、浏览器定位、后台活动和路线都要核对来源；高德返回的 GCJ-02 不重复转换。

## 已实现的运行入口

地图接入已加入：同时配置 `AMAP_JS_KEY` 与 `AMAP_SECURITY_JSCODE` 后，前端通过 `/api/map-config` 获取公开 JS 标识和同源代理地址，再加载高德 JS API 2.0。安全密钥只由 `/_AMapService` 代理注入；浏览器与静态文件不包含安全密钥。

`npm run dev:frontend` 与 `npm run dev:web` 都支持这些地图端点；前者现在会读取根目录 `.env`。没有地图配置时保留原有 OpenFreeMap，配置失败时尽量回退，不显示全屏加载遮罩。

前端高德选点和地图坐标为 GCJ-02；GPS/现有 OSM 景点、WGS 示例轨迹通过官方转换，转换结果缓存。原生高德返回值不再转换。天气使用高德 JS 天气插件按所选地区获取，避免把 GCJ 传给 WGS 天气接口。

当前主分支后端已按 `docs/contracts/agent-api.md` 统一 GCJ-02。地图配置默认使用 GCJ02 后端模式，定位先转换后发送，高德搜索点直接发送。仅连接旧 WGS 后端时设置 `AMAP_BACKEND_COORDINATE_SYSTEM=WGS84`；此时原生高德选点缺少原始 WGS 时省略位置。备用 OSM 模式下也不会把 WGS 坐标冒充 GCJ。

`EXPLORER_AMAP_KEY` 仍留给后端 REST 算路，本次没有把 JS Key 当 Web 服务 Key 使用。仓库只记录环境变量名，实际凭据通过部署环境管理。

## 官方参考

- [申请 Web端 JS Key 的官方步骤](https://developer.amap.com/api/skill/developer-skills/jsapi-skills)
- [Web服务 Key 创建](https://lbs.amap.com/api/webservice/create-project-and-key)
- [JS API 安全密钥与服务端代理](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [自定义地图与官方浅色主题](https://developer.amap.com/api/javascript-api-v2/guide/map/map-style)
- [Map 参考](https://lbs.amap.com/api/maps-javascript-api/reference/amap-map/map)
- [坐标转换](https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom)
- [地理编码与逆地理编码](https://lbs.amap.com/api/javascript-api-v2/guide/services/geocoder)
