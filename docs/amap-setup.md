# 切换高德前需要准备什么

核对日期：2026-11-12。已加入高德提供方和同源安全代理，配置后启用；不配置时继续使用原有底图。可行性和配色说明见 [amap-feasibility.md](amap-feasibility.md)。

## 准备清单

| 项目 | 从哪里取得 | 是否必须 |
| --- | --- | --- |
| JS API Key | 高德控制台 → 应用管理 → 我的应用 → 创建新应用/选择已有应用 → 添加 Key；服务平台选择 **Web端（JS API）** | 展示高德地图必须 |
| 对应的 `securityJsCode` | 上述 JS API Key 创建后的安全配置；与该 Key 配套 | 新申请的 JS Key 需要 |
| 部署网址和开发地址 | 使用实际网站域名，可沿用现有 Sites 预览域名；本地为 localhost/127.0.0.1 | 用于域名限制及部署配置 |
| 安全代理地址 `serviceHost` | 当前 Web/开发服务器已提供同源 `/_AMapService`；预览站点由 Worker 提供，服务器注入安全密钥 | 已实现，生产环境通过此代理使用 |
| Web 服务 Key | 同一应用下再添加一个 Key，服务平台选择 **Web服务** | 后端要调用高德 HTTP 搜索、地理编码或算路时需要；与 JS Key 分开 |
| 自定义地图样式 ID | 高德自定义地图平台创建、编辑并发布样式后复制 ID | 可选；第一版可以先用 `amap://styles/light`，不必等调色 |

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
AMAP_WEB_SERVICE_KEY=
AMAP_STYLE=amap://styles/light
```

JS Key 是浏览器 SDK 的公开应用标识；安全密钥留在服务器，前端使用官方 `serviceHost` 代理方式。Web 服务 Key 也只留在后端。额度和商用权限以当前账号控制台为准。

地图适配层已使用官方 `AMap.convertFrom` 处理已有 GPS/WGS-84 数据。现有 19 个景点、浏览器定位、后台活动和路线都要核对来源；高德返回的 GCJ-02 不重复转换。

## 官方参考

- [申请 Web端 JS Key 的官方步骤](https://developer.amap.com/api/skill/developer-skills/jsapi-skills)
- [Web服务 Key 创建](https://lbs.amap.com/api/webservice/create-project-and-key)
- [安全密钥及服务端代理](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [自定义地图与浅色主题](https://developer.amap.com/api/javascript-api-v2/guide/map/map-style)
- [坐标转换](https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom)

## 已实现的运行入口

地图接入已加入：同时配置 `AMAP_JS_KEY` 与 `AMAP_SECURITY_JSCODE` 后，前端通过 `/api/map-config` 获取公开 JS 标识和同源代理地址，再加载高德 JS API 2.0。安全密钥只由 `/_AMapService` 代理注入；浏览器与静态文件不包含安全密钥。

`npm run dev:frontend` 与 `npm run dev:web` 都支持这些地图端点；前者现在会读取根目录 `.env`。没有地图配置时保留原有 OpenFreeMap，配置失败时尽量回退，不显示全屏加载遮罩。

前端高德选点和地图坐标为 GCJ-02；GPS/现有 OSM 景点、WGS 示例轨迹通过官方转换，转换结果缓存。原生高德返回值不再转换。天气使用高德 JS 天气插件按所选地区获取，避免把 GCJ 传给 WGS 天气接口。

当前真实后端仍按 WGS-84 接收位置，因此默认只发送已有原始 WGS 坐标（GPS/静态景点）；原生高德搜索得到的 GCJ 选点没有原始 WGS 值时，不向旧接口冒充 WGS。后端位置契约与活动数据实际统一 GCJ-02 后，再配置 `AMAP_BACKEND_COORDINATE_SYSTEM=GCJ02`。这个设置不替代数据库数据转换。

`AMAP_WEB_SERVICE_KEY` 仍留给后端 REST 算路，本次没有把 JS Key 当 Web 服务 Key 使用。仓库只记录环境变量名，实际凭据通过部署环境管理。
