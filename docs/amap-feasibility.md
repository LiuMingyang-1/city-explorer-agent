# 高德地图替换可行性调研

调研日期：2026-11-12。对应当前西安漫游前端；本次交付包含聊天布局和本机历史入口，地图尚未切换，也没有用未授权的瓦片地址替换底图。

## 结论

1. **可以替换为高德。** 建议将地图渲染层改为官方高德 JS API 2.0，搜索、地理编码和真实道路路线逐步统一到高德。左侧玻璃卡片、历史规划和对话逻辑可复用。
2. **可以保持接近现有的简洁浅色风格。** 可先用 `amap://styles/light`（月光银）或 `amap://styles/whitesmoke`（远山黛），再在高德自定义地图平台调整颜色和要素、发布样式 ID。现有 OpenFreeMap 样式 JSON 不能直接导入；道路几何、字体和标注规则不同，不能承诺像素级一致。
3. 正式接入需要开发者账号、JS API Key、安全配置及部署域名；本次没有提供这些配置，因此不做带真实 Key 的加载、速度或配额验证。原有可用地图继续保留。

这与 [Day 0 约定](day0-contracts.md) 的“高德方向已确认、切换待实施”一致。

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

高德支持 `bg`（区域面）、`point`（兴趣点）、`road`（道路及标注）、`building`（建筑物）的显示控制。下面是后续实施时的配置起点，**不是本次已启用的运行代码**：

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

- 当前 `frontend/app.js` 使用 Leaflet 初始化、标记、折线、视野控制和 Nominatim 搜索；需逐项适配为 AMap API，不能只换一个瓦片 URL 就得到官方样式和完整搜索能力。
- 高德搜索/路线返回 GCJ-02；现有 OSM/Nominatim、浏览器 GPS 以及样例中的 WGS-84 坐标必须按来源处理。GPS 使用官方 `AMap.convertFrom(points, 'gps', callback)` 转换一次，高德返回的数据不再重复转换。
- AMap 常用坐标顺序是 `[lng, lat]`，当前 Leaflet 常用 `[lat, lng]`，迁移时需同时处理顺序。
- 前后端统一坐标契约后，可以直接绘制后端高德 POI 和路径结果，减少偏移和二次转换。后端不依赖地图底图库本身；统一坐标和返回数据才是对接关键。
- 当前服务器接口校验较严格，不应单方面增加坐标系字段。字段与数据迁移需遵循 Day 0 约定并与后端一起确认；数据库不因地图切换而重建。
- JS API Key 是浏览器 SDK 的公开标识，应设置域名限制；安全密钥建议留在服务器，通过官方 `serviceHost` / `/_AMapService` 代理配置使用。后端 Web 服务 Key 与模型密钥不放入静态前端或 Git 仓库。
- Open-Meteo 接收经纬度查询；切换到 GCJ-02 后应保留原始 GPS/WGS-84 天气查询坐标，或独立改用高德天气。不能把现有天气、定位、景点数据的坐标系标识直接改名。

## 实施顺序与验收

1. 配置 Key、安全代理、域名与样式 ID，先验证官方 SDK 及自定义样式可以加载。
2. 替换地图适配层；保留卡片、搜索点常驻名称、景区标签和聊天逻辑。
3. 校验现有景点、定位与后端活动坐标的来源，转换后绘制，确认几个已知地标没有明显偏移。
4. 接入高德搜索与实际道路路线；同一条路线检查点位顺序、折线、视野和名称。
5. 在用户实际网络与设备上测量首屏、拖动和缩放表现；国内可用性可能更合适，但不以更换供应商代替实测。

免费额度、账号类型、自定义样式权限及商业使用要求以控制台当时的套餐与官方条款为准，不在本次承诺永久免费或固定调用额度。地图版权、Logo 和必要的底图标注按官方要求保留。

## 官方依据

- [自定义地图与官方浅色主题](https://developer.amap.com/api/javascript-api-v2/guide/map/map-style)：主题、发布自定义样式 ID、要素控制。
- [Map 参考](https://lbs.amap.com/api/maps-javascript-api/reference/amap-map/map)：`features`、`showLabel`、`mapStyle`。
- [JS API 安全密钥与代理](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)：JS Key、安全密钥、`serviceHost`。
- [其他坐标转高德坐标](https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom)：GCJ-02、WGS-84 与官方转换方式。
- [地理编码与逆地理编码](https://lbs.amap.com/api/javascript-api-v2/guide/services/geocoder)：搜索与地址定位能力。
