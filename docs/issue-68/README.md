# Issue #68 验证记录

## 问题与修复

复现：游客打开页面后输入聊天内容，点击发送，或通过快捷提问、地点操作提交。此前前端不校验登录；后端将 chat_uid 匿名身份直接交给规划服务。

现在游客可以浏览公开活动与地图，聊天普通/流式入口必须持有有效的 chat_session。历史及偏好 GET/PUT/DELETE 同样要求登录，防止仅凭 chat_uid 访问账号私有数据。认证未配置时也拒绝这些请求。

前端在发送和重试的共同入口检查登录；初始化未确认、刷新失败、退出期间均不能发起请求。401 会撤销前端登录态、引导重新登录并恢复聊天草稿。身份切换保留输入文字和地点标签；偏好写入也检查登录。更新脚本版本参数以避免继续使用旧守卫代码。

## 自动化验证

- TypeScript `tsc --noEmit`、四个修改脚本的 `node --check` 通过。
- 前端与相关后端回归：294 项通过，包括真实 HTTP、真实 SQLite AuthStore、普通/流式聊天及会话端到端测试。
- 最终补充认证刷新失败/直接重试守卫后，认证与偏好前端测试 26 项通过。
- 新增后端守卫测试覆盖无 cookie、仅匿名 cookie（包括冒用账号 ID）、伪造 token、真实会话过期、退出后重用 token；拒绝请求不调用规划/偏好写服务，SSE 返回 JSON 401；有效登录可发送，公开活动仍可读。
- 协议与服务旧测试通过明确的测试会话 fixture 提供已登录调用者；认证策略测试使用未包装的生产 handler 和真实 AuthStore。

## 全量检查限制

完整执行未全绿：Windows 下 `events-api.test.ts` 的临时数据库目录在 after hook 中删除时报 EPERM，测试进程未正常结束，已停止。单项 TAP 诊断显示 failureType 为 hookFailed，位置 test/events-api.test.ts:106。

排除该文件后，其余 1019 项中 1018 通过、1 项失败：`session-schema.test.ts` 的旧库迁移测试也在资源清理 hook 删除临时目录时报 EPERM（test/session-fixture.ts:45）。这些测试及清理文件未在本 PR 修改；未将清理问题混入本分支，也不将此次检查报告为全量通过。

## 浏览器交互

Windows / Edge headless，1440×900；真实前端脚本与 Leaflet。登录、聊天和活动 API 使用测试桩，未调用真实 LLM。真实会话及鉴权由上述 HTTP 测试覆盖。

验证通过：游客发送不产生聊天 POST；登录弹窗可见且保留文字；登录后保留原草稿并只提交一次；退出后再次发送不增加聊天请求。

- [游客发送引导登录截图](guest-login-required.png)
- [登录后发送截图](logged-in-send.png)
- [退出后再次拦截截图](logged-out-blocked.png)
- [交互录屏](login-guard.webm)
- [请求记录与断言](browser-results.json)
- [浏览器验证脚本](verify-browser.py)：从仓库根目录运行，需要 Python playwright、Edge 与 playwright ffmpeg，端口 8770。

合并前等待审查；由 PR 的 Closes #68 在合并后关闭 issue。
