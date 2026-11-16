# 漫游形象与状态设计（#39 最终协议版）

对应 [#40](https://github.com/LiuMingyang-1/city-explorer-agent/issues/40)，关联 [epic #47](https://github.com/LiuMingyang-1/city-explorer-agent/issues/47)。
事件契约以 #39 交付为准：`src/agent/progress.ts`（分支 `issue39-process-events`@`134f621` / PR56，未 merge）与 `docs/issue-39/coordination.md`。本文不再含「草案待定」内容；分身生产接线属 #41，地图涟漪属 #43。

## 交付状态

- PR55（`lody/animated-face`@`432432f`）：BoopFace Lite 圆脸 + 独立 SVG 渔夫帽/放大镜/小圆手，7 表情控制器——已交付。
- PR57（`card-mascot-preview`@`93b2eee`）：卡片头常驻主形象、真实请求生命周期驱动——已交付（未 merge）。
- 本文（I40-F1）：状态机与分身设计契约、后续分工。`issue40-wander-avatar` 分支探索稿作废，不读取/复用其资产。

## 1. 真实事件源（#39 最终契约）

全部经 SSE `progress` 帧透出，`data` 为 `PlannerProcessEvent` 联合，消费端用 `event.type ?? "stage"` 归一判别。所有文本字段 `clipText` 单行 ≤160 码点，`message` 恒非空；spawn:done 恒 1:1，done 只发一次且只在终局点发出。子会话 stage 不透传（本轮私有叙事），分身可见性只靠实体级事件。

### 1.1 stage（旧 4 阶段，wire 无 type 键）

`{stage, message, plan_ids}`；stage ∈ `searching_events | exploring_plans | routing | validating_schedule`。父流中不出现盖章 stage 帧，所见 stage 均属本轮。

### 1.2 subagent_spawned（子会话创建成功即发射：分身入场）

`{type:"subagent_spawned", subagent_id, plan_id, parent_run_id, title, task_summary, message}`

- `subagent_id`：子会话 sessionId，本轮唯一；done/盖章 tool_call 据此关联。
- `plan_id`：父轮按 delegate_task **派发序**标号（"A"/"B"/"C"），取不到为 null；**不是最终候选 label**（校验可重排/丢弃/降级）。
- `parent_run_id`：派发方 run ID。顶层分身 = 父轮 run ID；嵌套派发 = 中间子会话 run ID。
- `title` ≤40 码点（入参 title，缺省取 task 裁剪）；`task_summary` ≤160 码点。

### 1.3 subagent_done（终局点：分身退场）

`{type:"subagent_done", subagent_id, plan_id, status, kind?, stops_count, title, summary, child_run_id, child_run_status, message}`

- `status` ∈ `completed | failed | cancelled`——父视角派发终态（同 `DelegateTaskDetails.status`）。
- `kind` ∈ `itinerary | clarification`，仅 completed 时出现；`stops_count` 仅 completed+itinerary 为站点数，其余恒 null。
- `child_run_status`：发射瞬间子 run 的 **DB 状态快照**（`queued|running|completed|failed|cancelled`，查无则 null）——竞态下可如实为非终态，**消费端不得据此猜测已终结**，确认终态另行查库。
- `title` 必填、与 spawned 同源（≤40 码点）；`summary` 为行程摘要/追问/失败取消原因（≤160 码点）。

### 1.4 tool_call（工具执行**结束**事件）

`{type:"tool_call", tool_call_id, name, args_summary, result_count, status, duration_ms?, subagent_id?, message}`

- `tool_call_id`：Pi agent 调用 ID（tool_execution_start/end 配对键，会话内唯一）。
- `name`：`search_events / delegate_task / estimate_travel / web_search` 等。
- `args_summary`：白名单单行摘要 ≤160 码点（search_events：type/date/category/keyword/`near=lat,lng`/radiusKm；未知工具只报参数项数）。不回传完整入参/结果。
- `result_count`：真实命中/产出数（`details.count` 有限数或已知结果形态长度），推导不出为 null，绝不虚构；`status:"error"` 时恒 null。
- `status` ∈ `completed | error`；`duration_ms` 真实耗时，可选。
- `subagent_id`：仅子会话内部调用透传时盖章（= 产生它的会话 sessionId；嵌套保留最深层真实 ID，不重盖）。父会话原生事件省略此键。

### 1.5 消费铁律（诚实性约束）

1. `tool_call` 是**结束**事件：只能证明"该次调用已发生"，不能当作"搜索开始"；没有进行中信号就不举镜宣称正在检索。
2. `child_run_status` 只是快照：merging/回收分身 ≠ 所有 child run 已终结。
3. `plan_id` 是派发序标号：徽标字母只能表述为"派发序"，不得宣称为最终方案 label。
4. 事件不含位置/候选点数据：search 的 `near=` 是查询中心且挂在结束事件上 → 分身不做地图落位/片区归属（地图呈现归 #43）。
5. 子侧无 stage 透传：分身"在做什么"只有 spawned / 盖章 tool_call / done 三个真实信号，其余时间呈工作姿态，不编造子阶段。
6. 事件按真实发生序到达、可交错：透传 tool_call 与其 spawned 的相对顺序需容忍，按 id 归属。

## 2. 业务状态机 ↔ 表情映射

`idle → thinking → dispatching → exploring → merging → validating → done` 为相位集合，不要求固定顺序走完：无 delegate 时跳过派出/探索/回收；检索与校验可多次发生；询问/取消/失败可在任何合法位置终结。dispatching/merging 是**过渡节拍**（首/次 spawned 入场瞬间、末位分身退场瞬间），可驻留相位为 `idle|thinking|exploring|validating|done`，节拍以短标记呈现而非独立动画。

语义相位只由真实事件/请求信号驱动；表情姿态循环、眨眼、扫视纯装饰。`animationend`/计时器不得推进 validating/done 等业务相位，视觉退场动画结束只负责移除 DOM。

| 业务相位 | 主脸表情 | 进入信号 |
| --- | --- | --- |
| idle | `idle` | 页面就绪；取消/代际切换清理后；终态提示结束 |
| thinking | `thinking` | 请求已发出（deliver 开始） |
| dispatching（节拍） | `thinking` | 本轮首个 `subagent_spawned` 到达；之后每个 spawned 为一个派出节拍 |
| exploring | `thinking` / `searching` | ≥1 顶层分身存活；主脸表情仍由父侧 stage 驱动 |
| merging（节拍） | `thinking` | 存活顶层分身归零（全部收到 done），或父侧 stage 恢复推进 |
| validating | `validating` | 仅 stage `validating_schedule`；不由计时/动画触发 |
| done | `happy` / `asking` / `confused` | result：`plans/itinerary/answer`→happy、`clarification`→asking；请求失败/超时/断连→confused；用户取消→idle |

speaking：无 token 级流事件，不单设状态；最终响应呈现 + happy 即完成态。

### 2.1 事件 → 行为总表

| 信号 | 主脸 | 团队层（分身） |
| --- | --- | --- |
| 请求发送 | thinking | 开新一轮（round token+1）：清场、清墓碑；此后至 settle/cancel 前的事件才有效 |
| stage `searching_events` | searching（举镜） | — |
| stage `exploring_plans` | thinking | 若仍有 pending 分身：父相位已推进为权威 → 回收存活分身，其迟到 done 落墓碑 |
| stage `routing` | thinking | 同上 |
| stage `validating_schedule` | validating | 同上 |
| `subagent_spawned` | 不变 | 建分身（§3）；重复 `subagent_id` 忽略；`parent_run_id` ≠ 本轮父 run → 记嵌套聚合，不建顶层分身 |
| `tool_call`（无盖章） | 不变 | — |
| `tool_call`（盖章=已知分身，`search_events`） | 不变 | 该分身短节拍举镜（"刚完成一次真实检索"的有界呈现 ≤约1.2s，回工作姿态；非"正在检索"宣称） |
| `tool_call`（盖章=已知分身，其他 name） | 不变 | 该分身活动脉冲（徽标闪点） |
| `tool_call` `status:"error"` | 不变 | 对应分身徽标警示；不切全局失败——单次工具失败可被模型自愈 |
| `tool_call`（未知盖章 id） | 不变 | 计入孤儿/嵌套聚合活动；若其 spawned 随后到达再转正 |
| `subagent_done`（已知分身） | 不变 | 按 status 退场节拍：completed→开心短拍、failed→困惑低垂、cancelled→直接淡出；槽位释放给等待池 |
| `subagent_done`（未知/重复 id） | 不变 | 忽略（墓碑/迟到） |
| 存活顶层分身归零 | 不变 | merging 节拍：不自动推断全部 run 终结，等下一个真实信号 |
| result（plans/itinerary/answer/clarification） | happy / asking | 终局权威：遗留分身随清场一并移除 |
| 请求失败/超时/断连（当前代） | confused | 先清场再呈失败脸（与取消区分） |
| 用户取消 / `wander:reset` / 新会话 / 历史代际切换 | idle | 立即全量拆除，不呈错误脸；旧 round 的一切迟到事件忽略 |

代际隔离与 `WanderHistory.generation()` 语义一致：旧代回包/进度不写回当前团队；重试 = 新一轮（begin → thinking，全新团队）。
部分失败：单分身 failed/cancelled 只影响该分身退场方式，其余继续；主脸不因单子任务失败切 confused——整体成败只认 result/error 终局。
嵌套：保留真实深层 ID，不伪造爷孙连线；无法归属顶层分身的活动计入聚合指示，不重复计为顶层分身、不重复 done。

## 3. 分身（clone）设计契约

### 3.1 形态与辨识

- 与主脸同一 BoopFace 圆脸 + 同一 wander-mascot 配件：独立 `<boop-face>` 元素 + `createWanderMascot` 独立实例（WeakMap 按元素隔离）。不重画头像/装饰。
- 默认 56px（可配）；主脸尺寸随容器（卡片头 88/52px 等）。
- 帽色按**槽位**轮换 `['sand','clay','moss']`（`HAT_PALETTES` 实核三键，每键 crown/band/brim/seam 四色）；实例生命周期内稳定，槽位释放后复用。颜色仅作槽位区分，不绑定美食/文艺等固定角色，不对应最终路线色；3 分身时第三席复用 moss，靠徽标+title 仍可辨。
- 方向辨识双通道（非纯颜色）：
  - **中性色字母徽标**：深墨底浅色字的 DOM 圆徽，字母取 `plan_id`（非 null）否则按派发序 `A/B/C…`；语义为"派发序"，不宣称最终 label。
  - **真实 title**：`spawned.title` 单行省略展示，全量进 `title`/`aria-label`（`分身·{title}·{status}`）。
  - 徽标与 title 均为团队层 DOM，不改 vendored SVG、不改帽子插画。

### 3.2 槽位、溢出与合法形态

- 可见槽位上限 3（对齐 #38 的 1–3 动态候选上限）；#38 未 merge、信号量实为共享池 `DEFAULT_SUBAGENT_MAX_CONCURRENT=8`，>3 并发为真实可能。
- 溢出：超出 3 的存活分身进等待池聚合徽标（`+N`，按 spawned−done 真实计数）；槽位空出按 spawn 先后补位，保留真实 id/title——不丢弃、不虚增。
- 合法形态：无 delegate 零分身、1/2/3 分身、部分失败他者继续、嵌套聚合；每种都是预览必演场景。

### 3.3 生命周期

- 入场：仅真实 `subagent_spawned` 触发；装饰性 scale/fade 入场，reduced-motion 下立即静态呈现。
- 退场：done 后按 status 短节拍 → 移除元素；upstream `disconnectedCallback` 停 rAF，WeakMap 释放控制器。装饰时长固定 ≤400ms，不等待、不阻塞相位。
- 轮次：`begin()` 递增 round token；旧 token 事件/分身一律失效。
- reduced-motion：`motion="reduce"` 或 `prefers-reduced-motion` → 无入退场/扫视/律动，静态表情仍随真实状态切换。

### 3.4 编排接口（F2 实现 `frontend/mascot-team.js`）

```js
const team = createMascotTeam(container, {
  createMascot,                 // 必填注入：(faceEl, {palette, pointerFollow}) => MascotApi
  maxVisible: 3,                // 可见槽位
  palettes: ['sand','clay','moss'],
  cloneSize: 56,                // px
  reduced,                      // 可选 () => boolean
  now,                          // 可选时钟，便于测试
});
team.begin();                   // 新请求：round token+1、清场
team.applyEvent(evt);           // PlannerProcessEvent（内部 type ?? 'stage' 归一）
team.settle(kind);              // 'plans'|'itinerary'|'answer'|'clarification'|'error'
team.cancel();                  // 取消/reset/代际切换：全量拆除 → idle
team.destroy();                 // 移除容器内全部节点
team.snapshot();                // {phase, beat, clones:[{id,title,letter,palette,status}], overflow, nested}
// begin/applyEvent/settle/cancel 均返回 { mainFace?: MASCOT_STATE } | null：
// 建议的主脸表情切换（null=保持），由 facade/预览驱动器落地；团队层不拥有主脸元素。
```

idle 相位下到达的一切事件忽略（旧轮迟到）；`phase` 报可驻留相位，`beat` 报最近 dispatching/merging 节拍供标记展示。

## 4. 前端消费接口（已交付层）

```js
import { createWanderMascot } from './wander-mascot.js';
const mascot = createWanderMascot(document.querySelector('boop-face'), {
  palette: 'moss', pointerFollow: true,
});
mascot.setState('searching');      // idle|thinking|searching|validating|happy|asking|confused
mascot.setPalette('sand');         // moss|sand|clay
mascot.setHat(false);
```

重复设置同状态无副作用；非法状态抛错；元素移除即停帧循环；`wander-mascot-state` CustomEvent 随 setState 派发。控制器只负责视觉：任务 ID 关联、状态优先级与终态提示由 `mascot-team.js`（编排）与 facade 承担。

## 5. 预算与 vendor 边界（实测值）

- vendored BoopFace Lite 目录 192KB（上限 350KB），钉 `ceb0580b5f8ee8b93f206920baba5265d7d7d482`（`assets/vendor/boopface/SOURCE.md`）。
- 自研控制器：`wander-mascot.js` 10.6KB + `wander-mascot-motion.js` 2.0KB ≈12.6KB（上限 20KB）；`mascot-card.js` 2.4KB。
- 团队层 `mascot-team.js` + 徽标目标 ≤8KB；每分身增量 = 1 个 shadow DOM + 共享 extension draw hook（upstream 每脸一条 rAF）。F2 预览页须实测 4 脸并存帧率/内存，不引用编造数字。
- 无运行时 CDN、图片或新框架。
- vendor 边界：控制器依赖钉版 SVG 内部结构（`head`/`headMotion`/`defs`/eyes 顺序）与少量内部接口（`_updateBlink`/`_startMorph`/`_expressionLock`/extension `draw` hook）；upstream 升级须重新验证，不追 latest。

## 6. 后续分工与合入

1. I40-F2：`mascot-team.js` 编排层 + 独立组合预览页（离线模拟事件、手动触发）——文件与接口见 `docs/issue-40/completion-plan.md`。
2. #41：生产接线——`mascot-card.js`/`chat.js` 调 `team.applyEvent(progress)` + 生命周期方法；不经本 issue 提前改生产文件。
3. #43：地图检索涟漪单独接入。
4. 联调覆盖：无分身、1/2/3、>3 溢出、乱序/重复/迟到 done、嵌套、取消/断连/重试/代际切换、reduced-motion。
