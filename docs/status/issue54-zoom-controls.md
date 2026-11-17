# Issue #54：地图缩放控件定位修复

2026-11-17

## 原因与修改

`#map` 已被放入 `#map-shell`，但 `syncAttribution()` 仍把 `amap-attribution-layout` 挂到直接父节点。版权带变量定义在 `.canvas.amap-attribution-layout`，因而没有生效；引用该变量的工具栏 `bottom` 无法计算，最终落到右上角。

改为查找最近的 `.canvas`，保留原有版权高度 ResizeObserver 与销毁清理。ToolBar 使用官方支持的 `position: 'RB'`、`offset: [28, 80]`；CSS 明确重置 top/left、保持 +/- 竖排，并统一两个地图 provider 的右侧及底部间距。刷新、尺寸变化和行程态切换通过 CSS 自动重新计算。样式、脚本 URL 更新版本号。

宽屏打开活动/偏好面板时将控件左移到面板外；紧凑屏幕面板覆盖剩余地图时，控件暂时隐藏，关闭面板后恢复，沿用原移动端面板覆盖策略。

## 验证

- `npm run check`：类型检查及 1024 项测试通过。
- `npm run check:frontend`：通过。
- 回归用例使用真实页面的 map -> map-shell -> canvas 层级，确认布局类挂在 canvas，且版权高度观察器在 dispose 后不再更新。
- Safari 真实高德 SDK：修复前复现右上角头像遮挡；修复后桌面 +/- 竖排位于高德 logo 上方；点击放大后地图标记变化，右上角入口未遮挡。
- Safari 桌面偏好面板打开：控件移到面板左侧，完整可见；关闭恢复。
- Safari 响应式 390×844：高德控件位于聊天卡上方的地图右侧；打开已有行程详情，控件位于缩小后的地图内、高德标识上方，无头像遮挡。
- Safari 390×844 备用地图（临时静态前端，不提供高德配置）：Leaflet +/- 竖排位于聊天卡上方的地图右侧。

官方 API 参数参考：https://lbs.amap.com/api/maps-javascript-api/reference/control/toolbar
