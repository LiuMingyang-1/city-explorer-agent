# Issue #40 集成验证（I40-F3）

- 分支 `issue40-mascot-states`，固定 base `93b2eee`（card-mascot-preview）；契约 `1bb09c7` → R1 修订 `048f0d1` → 本次集成提交。
- 交付面：`frontend/mascot-team.js`（编排层）+ `frontend/mascot-team-preview.{html,css,js}`（离线排练场）+ `test/frontend-mascot-team.test.ts` + 契约/计划/验证文档。生产 `index.html`/`chat.js`/`mascot-card.*`/`wander-mascot*`/`assets/vendor/**`/`src/**` 零改动。
- QA 证据：`team-preview-qa/{capture.mjs,results.json,report.md,shots/}`（2.0MB，全部为状态性截图，无重复空白图）。

## 检查执行（本 worktree 实跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `npm run check`（tsc --noEmit + `node --test "test/**/*.test.ts"`） | **933 pass / 0 fail** |
| 编排层单测 | `node --test test/frontend-mascot-team.test.ts` | **16 pass / 0 fail**（F2a 15 + 集成新增「在途退场让位」1） |
| 语法 | `node --check` × mascot-team.js、mascot-team-preview.js、mascot-team-preview.css 不适用（CSS 无需）；另 preview js 经浏览器实载 | 通过 |
| 空白 | `git diff --check` | 干净 |
| 浏览器 QA | `node docs/issue-40/team-preview-qa/capture.mjs`（本地静态服务 + headless Chromium CDP，`--force-device-scale-factor=1`，场景步骤器真实点击，无自动剧本） | **37 assert / 0 fail**，18 张截图重出 |

## 契约符合性核对（逐项）

- round token：`begin()→{round,mainFace:'thinking'}`（递增整数）；`applyEvent/settle/cancel` 缺 token **抛 TypeError**、stale/destroyed/closed 返回 `null` 零副作用；`snapshot().round` 正确；`destroy()` 永闭合（容器清空、之后一切 noop）。测试与 QA 双覆盖。
- stage 不回收：重复 `exploring_plans`/`routing`/`validating_schedule` 到达时 pending 分身保持存活（测试 + shot 02）；validating 与 pending 并存合法。
- 清理唯一依据：同 id `subagent_done`、settle/cancel/reset、`destroy()`；settle 时遗留分身按「轮次关闭」移除不记 done。
- done-before-spawn 墓碑 + 重复 spawn/done 幂等；未知盖章 tool_call 入孤儿聚合，spawned 到达同源转正。
- 嵌套：首个顶层 spawned 的 `parent_run_id` 为根参照，异源 spawned/done/tool_call 计 `nested` 聚合（真实 id），不建顶层分身（shot 09）。
- **可见 ≤3 含在途退场**：done 后槽位立即释放给补位，DOM 内可见 boop-face 恒 ≤`maxVisible`——若补位真实到达时在途退场元素仍占 DOM，立即让位移除（集成修正，`mount()` 内 `domFaces()` 闸 + 新单测）；无补位需求时装饰退场正常播完 ≤380ms。shot 05/06 实证溢出→补位全程 3 脸。
- tool_call 仅作结束事件：徽标 `data-activity` 脉冲 + note「已检索 N」/「调用出错」，不切 searching、不举镜；`result_count` 取真实值。
- 徽标字母 = plan_id ?? 派发序（「派发序」文案，不宣称最终 label）；title 真实 `spawned.title` textContent 省略号；注入面仅 textContent（单测断言无 innerHTML）。
- RM：`reduced` 注入/`motion="reduce"`/系统偏好三路 → 入退场即静态、done 即移除；cancel/settle/destroy 清全部在途 DOM/定时器（enter/exit/pulse 一律 clearTimeout）/vendor rAF 随元素移除停止。
- 主脸只是建议：`{mainFace}` 由调用方落地，`{}`/`null` 保持现状；团队层无主脸 DOM。

## 实际字节与性能边界

| 资产 | raw | gzip |
| --- | --- | --- |
| `mascot-team.js` | 12,702 B（≤16KB 上限，契约 §5 已订正） | ≈4.6KB |
| `mascot-team-preview.js`（预览资产，不计运行时预算） | 22,641 B | ≈7.1KB |
| 既有：`wander-mascot.js`+motion | 12.6KB（≤20KB） | — |
| 既有：vendored BoopFace Lite | 192KB（≤350KB） | — |

- 帧率/内存为 **headless Chromium + dsf=1** 实测（report.md）：4 脸并存 59.8fps/3.21MB，仅主脸 60.2fps/2.85MB，分身增量 ≈+0.12MB/脸。**不是真机宣称值**；真机数据待 #41 接线后笔记本 DevTools 复测。
- 320 CSS px 无横溢（`scrollWidth=320`），title 省略号生效（shot 16）。

## 已签署截图（实际目检）

`01-combo-3`（主+3 分身/帽色/徽标/title）、`05-overflow-5`（3 可见 + `+2` 池）、`06-overflow-backfill`（补位 D/E + C，恒 3 脸）、`07-partial-fail`（B 失败退场、A/C 续跑、主脸不 confused）、`09-nested-done`（聚合并清场）、`12-disconnect-confused`（清场后 confused）、`15-rm-3clones`（RM 静态 3 分身）、`16-320-3clones`（320px 无横溢）。其余 10 张为断言同场景存档，未逐张目检。

## 边界与后续（不误称完成）

- **未接生产**：`index.html`/`chat.js` 无 `mascot-team` 引用；真实 SSE 事件流接法见 `mascot-states.md` §6，归 #41。
- **无地图坐标**：契约事件不含候选点/位置，分身不做地图落位（#43 事项）。
- headless 性能值仅趋势参考；`child_run_status` 非终态快照场景靠契约约束（无法从 SSE 复现验证）。
- completion-plan.md 已将 F2 部分收口为已交付；#41/#43 仅列交接点。
