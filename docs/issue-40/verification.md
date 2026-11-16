# Issue #40 集成验证（I40-F3 集成 + R1/R2 修复回归）

**状态：已修待独立复审**（非自称 review pass）。

- 分支 `issue40-mascot-states`，固定 base `93b2eee`（card-mascot-preview）；栈：`1bb09c7` 契约 → `048f0d1` R1 修订 → `4f336f1` F3 集成 → 本次 R3 集成提交。
- 交付面：`frontend/mascot-team.js`（编排层）+ `frontend/mascot-team.css`（运行时样式层）+ `frontend/mascot-team-preview.{html,css,js}`（离线排练场）+ `test/frontend-mascot-team.test.ts` + 契约/计划/验证文档。生产 `index.html`/`chat.js`/`mascot-card.*`/`wander-mascot*`/`assets/vendor/**`/`src/**` 零改动。
- QA 证据：`team-preview-qa/{capture.mjs,results.json,results-r1.json,report.md,shots/}`（R1 37 断言留档 + R2 54 断言全量 + 23 张截图）。

## 评审历史

| 轮次 | 发现 → 处理 |
| --- | --- |
| F1 review（R1 契约） | ① stage 误回收 pending → 改「仅同 id done / 轮次终结 / destroy 可清理」；② mutator 无 round 隔离 → 全 API 必填 token，缺 token 抛错、stale 返回 null |
| F3 集成（首轮，2P2 发现） | ① 预览 CSS 完全缺 `data-status`/`data-activity` 规则——入退场/活动无视觉反馈；② done 时槽位即释放但退场 DOM 仍在 → 补位可出现第 4 脸 → `mount()` 加 `domFaces()` 闸，在途退场为真实补位让位 |
| R1/R2 修复（本轮） | ① 预览样式抽为 `frontend/mascot-team.css` 运行时层（#41 直接 link）；② done 退场 controller 收真实终结表情 completed→happy/failed→confused/cancelled→idle（`rec.mascot` 持有 + api 保护）；③ orphan 转正后 ⧉ 徽标不消失 → `orphans.delete(id)` 后 `renderNested()`；④ 等待池分身不再实例化 controller；⑤ settle/cancel 清全部在途 enter/exit/pulse 定时器；⑥ 集成修正：`r2-completed-exit-real-fade` 探针边界——`mt-exit-happy` 上跳段刻意 opacity=1，real-fade 断言移至 ~310ms 淡出段（动画/表情断言仍在 150ms），稳定通过 |

## 检查执行（本 worktree 实跑，本轮）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `npm run check`（tsc --noEmit + 全量 node test） | **937 pass / 0 fail** |
| 编排层单测 | `node --test test/frontend-mascot-team.test.ts` | **20 pass / 0 fail**（F2a 15 + F3 退场让位 1 + R1 修复 4） |
| 语法 | `node --check` × mascot-team.js、mascot-team-preview.js、capture.mjs | 通过 |
| 空白 | `git diff --check` | 干净 |
| 浏览器 QA | `node docs/issue-40/team-preview-qa/capture.mjs`（本地静态服务 + headless Chromium CDP，手动点击发事件） | **54 assert / 0 fail**（复跑，含上述探针修正） |

## 契约符合性核对（逐项，R2 后）

- round token：`begin()→{round,mainFace:'thinking'}`；`applyEvent/settle/cancel` 缺 token **抛 TypeError**、stale/closed/destroyed 返回 `null` 零副作用；`snapshot().round` 正确；`destroy()` 永闭合。
- stage 不回收：重复 `exploring_plans`/`routing`/`validating_schedule` 到达时 pending 分身存活；validating 与 pending 并存合法（shot 02）。
- 清理唯一依据：同 id `subagent_done`、settle/cancel/reset、`destroy()`；settle 遗留按「轮次关闭」移除不记 done。
- done-before-spawn 墓碑、重复 spawn/done 幂等、未知盖章 tool_call 孤儿聚合→同源转正（转正后 ⧉ 徽标消失，R1 修复覆盖）。
- 嵌套：首顶层 spawned 的 `parent_run_id` 为根参照，异源计 `nested` 聚合不建顶层分身；orphan 与真 nested 并存分别计数（单测）。
- **可见 ≤3 含在途退场**：退场拍中真实补位 → 在途退场元素立即让位（F3 修正 + R2 `r2-backfill-yield-3max` 浏览器断言文档 boop-face 恒 3）。
- tool_call 仅结束事件：`data-activity` 徽标脉冲（searched/tool）+ note「已检索 N」/「调用出错」；error 静态 warn 色无动画循环；不切 searching、不举镜；`result_count` 取真实值。
- 终结表情：done 后 controller 实收 `happy`/`confused`/`idle`（R2 经 `wander-mascot-state` 事件录制断言，非仅 data 标记）；`mascot.setState` 抛错静默降级不拖垮编排（badMascot 单测）。
- 徽标字母 = plan_id ?? 派发序（「派发序」文案）；title 纯 textContent 省略号；无 innerHTML。
- RM：入退场即静态/即移除（双通道：系统偏好 + 容器 `data-motion="reduce"`，`mascot-team.css` 动画归零 + face `motion="reduce"`）；cancel/settle/destroy 清全部在途 DOM/定时器/vendor rAF（定时器清零有单测）。
- 运行时 CSS 只 transform/opacity/box-shadow 动画 + 静态色；时长与模块常量一致（enter ≤220ms / exit ≤380ms / pulse ≤900ms），不推进语义。

## 实际字节与性能边界

| 资产（运行时，#41 需携带） | raw | gzip |
| --- | --- | --- |
| `frontend/mascot-team.js` | 13,003 B（≤16KB） | ≈4.7KB |
| `frontend/mascot-team.css` | 4,146 B（≤6KB） | ≈1.8KB |
| **运行时合计** | **≈17.1KB（≤22KB）** | ≈6.5KB |
| 预览资产（另列，不计运行时预算）`mascot-team-preview.{html,css,js}` | ≈40.7KB | js gzip ≈7.1KB |
| 既有：`wander-mascot.js`+motion | 12.6KB（≤20KB） | — |
| 既有：vendored BoopFace Lite | 192KB（≤350KB） | — |

- 帧率/内存为 **headless Chromium + dsf=1** 实测：4 脸 59.8fps/3.21MB vs 1 脸 60.2fps/2.85MB，增量 ≈+0.12MB/脸。**非真机宣称值**，真机待 #41 后复测。
- 320 CSS px 无横溢（`scrollWidth=320`），title 省略号生效。

## 已签署截图（实际目检，本轮）

`r2-02-completed-exit`（A 中段淡出+B 警示徽标+C 续跑）、`r2-03-failed-exit`（B 困惑低垂淡出）、`r2-01-searched-pulse`（「已检索 6」徽标脉冲）、`r2-04-rm-static`（RM 即时清场）、`01-combo-3`（主+3 分身/帽色/徽标/title）、`05-overflow-5`（3 可见+`+2`）、`06-overflow-backfill`（补位恒 3 脸）、`07-partial-fail`（B 失败、A/C 续跑、主脸不 confused）、`09-nested-done`、`12-disconnect-confused`、`15-rm-3clones`、`16-320-3clones`。其余存档断言图未逐张目检。

## 边界与后续（不误称完成）

- **未接生产**：`index.html`/`chat.js` 无 `mascot-team` 引用；#41 按 `mascot-states.md` §6 接 `team.*` + `<link mascot-team.css>`。
- **无地图坐标**：事件不含候选点，分身不落位（#43）。
- headless 性能值仅趋势参考；`child_run_status` 非终态快照仅契约约束。
- 退场 choreo 为设计选择（completed 上跳段保持不透明、末段淡出）；断言按真实关键帧曲线对齐。
