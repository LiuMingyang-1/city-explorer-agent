# I40-F2b 分身排练场 · 浏览器 QA 报告

- 日期：2026-11-16 · 分支 `issue40-mascot-states`（base 93b2eee + 契约 048f0d1）
- 被测：`frontend/mascot-team.js`（同伴实现，worktree 未提交）经 `frontend/mascot-team-preview.{html,css,js}` 真实驱动
- 方法：临时静态服务（`127.0.0.1` 空闲端口，用完即关）+ headless Chromium CDP（`--force-device-scale-factor=1`），全部事件经**场景步骤器真实点击**逐条发出，无自动剧本。脚本：`capture.mjs`；原始断言：`results.json`；截图：`shots/`。

## 结论：37 项断言全部通过，0 失败

| 组 | 断言 | 结果 |
| --- | --- | --- |
| 组合 | 3 分身 3 个独立 boop-face + 独立 shadowRoot；帽色 crown = sand `#cfb88c`→clay `#ba8e77`→moss `#82916f`；title/徽标纯 textContent（无子元素）；主脸 spawn 期保持 thinking；tool_call 脉冲后分身 DOM 同一实例 | pass ×7 |
| stage 不回收 | `routing`/`validating_schedule`/重复 `exploring_plans` 到达时 `sub-a` 仍 `status:working`；phase=validating 与 pending 并存合法；主脸=validating | pass ×2 |
| 溢出 | spawn×5 → 可见 3 + 等待池 `+2`；2 个 done 后按 spawn 序补位（可见 = sub-d/sub-e/sub-c），等待 0 | pass ×3 |
| 部分失败 | done(B,failed) 后 A、C 仍 working；主脸不切 confused | pass ×2 |
| 墓碑 | done 先于 spawn 到达 → 迟到 spawn 不复活，`snapshot().finished=1` | pass |
| 嵌套 | 异 `parent_run_id` spawn 计入 `nested=1` 聚合，不建顶层分身（可见仅 sub-a） | pass |
| round token | begin 递增（r1=9→r2=10）；旧 token `applyEvent`/`settle` 全返回 null 零副作用；**无 token 调用三者全部抛 `TypeError: round token is required`**（严格拒绝，非静默）；`snapshot().round` 正确 | pass ×4 |
| 取消 | cancel 清场（0 分身）、主脸 idle、全文档只剩主脸 1 个 boop-face | pass ×3 |
| 终态 | 断连→confused；clarification→asking；零分身直通→done/happy；乱序 done 全部就位→done | pass ×5 |
| RM | 手动开关后 4 个 boop-face 全部 `motion="reduce"`；RM 下分身仍真实入场 | pass ×2 |
| 清场回归 | 再次 cancel 后文档 boop-face 数=1（无线留实例） | pass |
| 布局 | layout viewport=320 CSS px（与 DPR 无混）：`scrollWidth=320` 无横溢；title 省略号生效（sw 100 > cw 84/70） | pass ×2 |
| 日志诚实 | wire JSON 逐键对 #39 契约；`round` 仅作独立徽章，**不出现在任何日志 JSON 键中** | pass |
| destroy | 清空容器；之后 applyEvent 返回 null、0 分身（永闭合） | pass ×2 |

## 性能（headless Chromium 实测，**不是**真笔记本宣称值）

| 场景 | fps（rAF 采样 2s） | usedJSHeapSize |
| --- | --- | --- |
| 主脸+3 分身（4 脸并存） | 59.8 | 3.21 MB |
| 仅主脸 | 60.2 | 2.85 MB |

分身增量 ≈ +0.12 MB/脸（headless 值）。装饰入退场 ≤400ms、徽标脉冲 ≤900ms，均不推进业务相位。

## API 适配记录（预览驱动器 ↔ 模块）

- `createMascotTeam` ES named export ✓；`begin()→{round,mainFace:'thinking'}`，round 存驱动器本地变量，此后每次 `applyEvent/settle/cancel` 显式传入；stale 注入走专用步骤携带旧 token。
- 模块把 `.mascot-team` 类加在**容器元素自身**；`.mascot-team-clone/-badge/-title/-note/-overflow/-nested` 与契约一致，预览宿主样式已按实际类核对。
- `snapshot()` = `{round,phase,beat,clones[{id,title,letter,palette,status,activity}],overflow,nested,active,pending,finished,destroyed}`——比契约多出 `active/pending/finished/destroyed` 四个只读键，预览如实展示。
- 模块无主脸 DOM：预览自持有 `createWanderMascot`，对每次调用返回的 `{mainFace}` 落地；`{}`/`null` 均保持原表情。

## 限制与备注

- 帧率/内存为 headless Chromium + dsf=1 环境值，真机数据需 `#41` 接线后在笔记本 DevTools 复测。
- `tool_call` 结束事件规范呈现为徽标脉冲 + 真实 result_count（note「已检索 N」/「调用出错」），无伪「正在检索」举镜——符合 R1 契约。
- 页面运行需静态服务（ES module import），无 CDN/图片/新框架；localhost 仅为测试临时使用。
