# 前端与后端对齐（2026-11-13）

对齐基线：`main` 的 `f15b237`（含 PR #6 / #7 / #8）与待合并 PR #9 的地图/布局修正。后端接口以 `docs/agent-impl-contracts.md` 为准。本轮不修改 Agent 或服务端协议。

| 交互 | 前端行为 | 接口与数据 |
| --- | --- | --- |
| 附近活动 | 保留气泡、缩略图、详情卡、250ms 视口查询、防遮挡及 404 负缓存 | `GET /api/events`，GCJ-02 bbox |
| 问问这个活动 | 填入询问草稿，用户确认后发送 | 真实活动携带 `referenced_event_id`；修改草稿后清除引用 |
| 加入行程 | 独立按钮，填入“加入我的行程、安排时间并检查顺路”的草稿，保留当前 A/B | 同一聊天端点，不新增后端接口；demo 不发送真实活动 ID |
| 我的偏好 | 右上设置图标打开抽屉；加载、编辑、保存、清空，失败保留草稿 | `GET /api/memory`；`PUT` 严格 `{content}`；`DELETE` 接收 204 |
| 记忆身份 | 使用同源 cookie，前端不发送 userId | `credentials: same-origin` |
| 记忆限制 | trim 后 1–8000 字；空白不发 PUT，清空使用 DELETE；行内再次点击确认清空 | 遵守现有 memory 契约 |

真实模式默认调用同源 `/api/chat/stream`、`/api/events` 和 `/api/memory`。`WANDER_CONFIG.memoryEndpoint` 可以覆盖记忆接口地址；同源部署不需要此项。

Sites 目前作为独立前端演示，未托管真实 Agent/memory 服务。待发布预览配置显式设置 `mockMemory: true`，将演示偏好保存在独立 localStorage key，并在抽屉内显示“演示模式”。不配置该开关时只调用真实接口，404/网络错误不会伪装为保存成功。后端接入时应省略该开关或设为 false。

## 为什么浏览器预览还是旧状态

实测原站点 `https://xian-wander-glass.fernypeony1.chatgpt.site/` 的服务器响应：

- HTML 仍引用 `style.css?v=nearby-3`，没有新偏好抽屉。
- `/activities.js` 没有“加入行程”，仍是旧气泡尺寸。
- `/map-layout.js` 和 `/preferences.js` 均返回 404。
- HTML/JS 响应为 `Cache-Control: no-cache`。

因此缺失的是新构建部署，清浏览器缓存不能取得尚未部署的脚本。GitHub 合并与 Sites 发布是两个动作，GitHub PR 不会自动更新这个独立站点。

本轮调用 Sites 发布凭据接口仍返回：

```text
409 sites_git_client_upgrade_required
Sites Git is not yet enabled for this client.
```

这属于发布客户端能力限制，不是前端代码、地图 Key、账号仓库推送权限或浏览器缓存错误。当前会话无法推送该站点的专用源仓库；没有改变站点身份、域名或私有访问范围，也没有用旧源码 SHA 冒充新版本发布。

## 恢复发布

1. 在已支持 Sites Git 的托管 Work/最新 Codex + Sites 客户端会话继续该站点；若仍返回相同错误，需等待该能力可用，重新安装地图或修改浏览器缓存无效。
2. 保留站点 `.openai/hosting.json` 的 project_id，读取最新 GitHub 分支并同步前端、示例资源和安全代理。
3. 为同一站点获取有效源码推送凭据，推送构建对应的源码状态，再保存并发布该 SHA；保留现有私有受众与运行时 Secrets。
4. 发布后从服务器检查 HTML 的 `aligned-5` 版本、`/preferences.js`、`/map-layout.js` 和“加入行程”按钮，再做浏览器交互验收。真实后端部署还应验证同源 cookie 与 `/api/memory` 三种方法。

本地联调：`npm run dev:web` 使用现有后端；`npm run dev:frontend` 仅提供前端和示例数据，不提供真实偏好服务。若需要纯前端偏好演示，显式配置 `WANDER_CONFIG.mockMemory=true`，不能将本地演示当成账号记忆已保存。
