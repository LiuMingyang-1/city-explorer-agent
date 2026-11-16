# I40-F2b 分身排练场 · 浏览器 QA 报告（R1+R2）

- 日期：2026-11-16 · 分支 `issue40-mascot-states`（base 93b2eee + 契约 048f0d1）
- 被测：`frontend/mascot-team.js`（同伴实现，worktree 未提交）经 `frontend/mascot-team-preview.{html,css,js}` 真实驱动
- 方法：临时静态服务（`127.0.0.1` 空闲端口，用完即关）+ headless Chromium CDP（`--force-device-scale-factor=1`），全部事件经**场景步骤器/控制台真实点击**逐条发出。脚本 `capture.mjs`；断言 `results.json`（R2 全量）/ `results-r1.json`（R1 留档）；截图 `shots/`。

## R1（模块首版）：37/37 通过 — 见 `results-r1.json`

覆盖：3 分身独立实例/帽色/title 纯文本、stage 不回收 pending、溢出+2 与补位、部分失败、墓碑、嵌套、round token 隔离（旧 token→null、无 token→抛 TypeError）、cancel 清场、终态表情、RM、320px、日志无 round 键、destroy 永闭合、headless 性能（4 脸 59.8fps/3.21MB vs 1 脸 60.2fps/2.85MB，**非真机宣称**）。

## R2（review 4f336f1 回归）：54/54 通过 — 见 `results.json`

**R1 曾发现的问题**：预览原 CSS 完全没有 module `data-status`/`data-activity` 对应规则——分身入退场/活动无任何视觉反馈。本轮把团队层全部实例样式抽为可复用运行时层 **`frontend/mascot-team.css`**（#41 直接 link；preview.html 已 link，preview.css 只留页面布局），全部规则 scope 在 `.mascot-team`，装饰不动语义。

| R2 真实渲染断言（computed/动画/控制器，非仅 data 属性） | 实测值 | 结果 |
| --- | --- | --- |
| entering 中段 | `animationName=mt-enter`、opacity 0.54 | pass |
| `data-activity=tool` 徽标 | `badgeAnim=mt-pulse` | pass |
| `data-activity=searched` 徽标 | `badgeAnim=mt-pulse` + note「已检索 6」 | pass |
| `data-activity=error` 徽标 | `badgeAnim=none` + `background=rgb(168,84,47)` 静态警示 + note「调用出错」 | pass |
| completed 退场中段 | `anim=mt-exit-happy`、opacity 0.99→淡出中、控制器表情 **wander-state=happy** | pass ×3 |
| failed 退场中段 | `anim=mt-exit-fail`、opacity 0.80、**wander-state=confused**，其余分身继续、主脸不 confused | pass ×3 |
| cancelled 退场中段 | `anim=mt-exit`、opacity 0.83、**wander-state=idle** | pass ×2 |
| 补位 yield | 3 存活 + 退场拍中再 spawn → 文档 `#team-strip boop-face` 恒 3 | pass |
| 手动 RM 开关 | `data-status` 直接 `working`、clone `animationName=none`、face `motion=reduce`、容器 `data-motion=reduce`；done 后 60ms 即 0 脸（即时显隐） | pass ×2 |
| orphan 转正 | 未知盖章 → `⧉1`；同 id 真实 spawn 转正 → ⧉ 消失、`snapshot().nested=0`（核心修复 11:52 落地后验证） | pass ×2 |

控制器表情经每 face 元素直挂 `wander-mascot-state` 监听录制（事件不冒泡），断言的是 controller 真实状态而非 data 标记。退场动画名与 module `EXIT_MS=380` 窗口一致、入场 `mt-enter` 与 `ENTER_MS=220` 一致、脉冲 `mt-pulse` 与 `PULSE_MS=900` 一致；R1 全部断言在 R2 中复跑仍通过（含 token/隔离/清场/320/日志无 round 键）。

## 性能（headless Chromium 实测，**不是**真笔记本宣称值）

同 R1：4 脸 59.8fps/3.21MB vs 1 脸 60.2fps/2.85MB；分身增量 ≈ +0.12MB/脸。真机数据待 #41 接线后复测。

## API 适配记录

- `createMascotTeam` named export；`begin()→{round,mainFace:'thinking'}`，round 本地捕获、每次调用显式传入；无 token 三调用全抛 `TypeError: round token is required`；旧 token 一律 `null` 零副作用。
- 模块把 `.mascot-team` 加在容器自身；实例类 `.mascot-team-clone/-badge/-title/-note/-overflow/-nested` + `data-status`（entering/working/completed/failed/cancelled）+ `data-activity`（searched/tool/error），CSS 全部按实核类名与属性落地。
- `snapshot()` = `{round,phase,beat,clones[{id,title,letter,palette,status,activity}],overflow,nested,active,pending,finished,destroyed}`。
- 模块无主脸 DOM：预览自持 `createWanderMascot`，按每次返回 `{mainFace}` 落地；`{}/null` 保持原表情。部分失败时主脸不因单子任务失败切 confused（断言通过）。

## 关键截图（`shots/`）

`r2-02-completed-exit`（A 中途退场淡出+「已检索 6」）、`r2-03-failed-exit`（B 困惑低垂淡出+「调用出错」）、`r2-01-searched-pulse`、`r2-04-rm-static`、`01-combo-3`、`05-overflow-5`、`07-partial-fail`、`11-cancel-reset`、`16-320-3clones`、`17-320-rm`、`18-log` 等 23 张。

## 限制

- 帧率/内存为 headless Chromium + dsf=1 环境值；页面需静态服务（ES module），无 CDN/新框架；localhost 仅测试临时使用。
- 模块未提交，QA 基于 worktree 实况；核心修复（controller 保存 done→happy/confused/idle、orphan 转正 ⧉ 刷新）已在其 11:52 版本验证通过。
