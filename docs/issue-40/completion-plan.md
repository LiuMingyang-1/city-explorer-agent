# #40 补齐计划（I40-F1 交付）

契约与状态机见同目录 `mascot-states.md`（#39 最终协议版）。本文件给出剩余验收差距与下一子任务 **I40-F2** 的精确文件归属/接口，后续编码者可直接实施；更后续的生产接线归 #41，地图涟漪归 #43。

## 1. 剩余验收差距（对照 issue #40）

- 「分身形态 2–3 个差异化小精灵」：资产层已具备（同圆脸+帽色槽位），**组合编排层缺失** → F2 交付 `mascot-team.js` + 预览验证。
- 「状态机规范可被动画实现 issue 直接照做」：`mascot-states.md` §2 已按 #39 最终事件一一落地 → 待 review 确认即可勾选。
- 「资产可直接被前端消费（分身独立图层/实例化）」：`createWanderMascot` 本就按元素实例化；F2 预览以 4 个独立 boop-face 实证。
- 工程约束：SVG+CSS ✓、reduced-motion ✓、素材上限已实测达标（见 §预算）；F2 需补 4 脸并存实测帧率/内存记录。

## 2. I40-F2：分身组合预览页 + 编排层

### 2.1 文件归属（新建 5 个，禁止清单另列）

| 文件 | 责任 |
| --- | --- |
| `frontend/mascot-team.js` | 编排层唯一实现：`createMascotTeam(container, opts)`，契约见 `mascot-states.md` §3.4。`begin()`→`{round,mainFace:'thinking'}`；`applyEvent(evt,round)`/`settle(kind,round)`/`cancel(round)` 必填 token，≠当前则返回 `null` 零副作用；`snapshot()` 含 `round`；`destroy()` 永闭合。持有分身 Map、等待池、嵌套/孤儿集、墓碑集；管理克隆 DOM（boop-face + DOM 徽标/title）与槽位轮换。 |
| `frontend/mascot-team-preview.html` | 独立预览页骨架：主脸区、分身条（3 槽+`+N` 池徽标）、事件控制台、场景步骤器、事件日志、RM 开关、「离线模拟·非真实后端」横幅。 |
| `frontend/mascot-team-preview.css` | 预览页独立样式（仿 `mascot-preview.css` 自洽，不改全局）。 |
| `frontend/mascot-team-preview.js` | 驱动器：`createWanderMascot` 注入 `createMascotTeam`；`begin()` 返回的 `round` 存进本地变量，之后**每次** `applyEvent/settle/cancel` 都显式带上（token 是本地参数，不进 SIM_* payload）；`cancel`/`begin` 后重新捕获。本地 `SIM_*` 事件构造器（逐字段仿 `progress.ts` wire 形状，`type`/缺省 `type` 都与契约一致）；按钮与场景步骤点击时即时发事件，并把事件 JSON 追加进日志列表。 |
| `test/frontend-mascot-team.test.ts` | 编排层单测，仿 `test/frontend-mascot-card.test.ts` 的 vm fixture 模式，`createMascot` 注入假实现断言 DOM/返回值。 |

**可复用 import**：`wander-mascot.js`（`createWanderMascot`、`HAT_PALETTES`）、`wander-mascot-motion.js`（无需直接引用）。
**禁止改动**：`index.html`、`chat.js`、`transport.js`、`mascot-card.js/.css`、`wander-mascot*.js`、`mascot-preview.*`、`assets/vendor/**`、任何 `src/` 后端文件。

### 2.2 预览页结构

```
[离线模拟 · 非真实后端] 横幅
主脸区:    boop-face ~200px + 相位chip + beat标记（dispatching/merging 闪烁点）
分身条:    slot×3（帽色 sand/clay/moss）+ 「+N 等待池」徽标 + 每分身 title 单行
控制台:    生命周期: 发送请求 | 结果 plans/itinerary/answer/clarification | 失败 | 取消
          stage:   searching_events / exploring_plans / routing / validating_schedule
          分身:    spawn(title,plan_id) 预设×3+自定义 | done(id,completed/failed/cancelled)
          tool_call: 盖章search_events | 盖章其他 | error | 未知id
场景步骤器: 8 个预设剧本（下表），每步一个按钮，点击只发那一步的事件
日志:      <ol> 逐条渲染所发事件 JSON（可对照契约字段）
RM 开关:   checkbox 给全部 boop-face 置 motion="reduce"
```

### 2.3 场景剧本（每步手动点击，禁止定时连发）

1. 无分身单方案：begin → searching_events → routing → validating_schedule → settle(itinerary)
2. 1 分身：begin → exploring_plans → spawn(A) → 盖章 search_events → done(A,completed,itinerary,stops_count=5) → validating → settle(plans)
3. 3 分身乱序：spawn A/B/C → done(B,failed) → done(A,completed) → 盖章 tool_call(C) → done(C,cancelled) → settle
4. 溢出>3：spawn ×5 → 3 可见+`+2` 池 → done×2 → 补位展示
5. 取消重试：spawn(A) → cancel（主脸 idle、清场）→ begin → settle(answer)
6. 嵌套/未知归属：spawn(A,parent_run_id=r1) → 未知盖章 tool_call → 嵌套 spawn(parent_run_id=r2) → done(A) → 聚合点计数正确
7. 迟到/重复：done(A) 重复、cancel 后注入旧 round spawn → 全忽略
8. 断连失败：spawn(A) → settle('error') → 清场+主脸 confused

### 2.4 诚实性红线（F2 同样适用）

- 事件只由**手动点击**发出；不设 `setTimeout` 驱动的自动剧本，不用计时器伪造业务完成（装饰动画时长属姿态层，不在此列）。
- 页面全程挂「离线模拟」标识；SIM_ 事件构造器只造 `mascot-states.md` §1 列出的真实字段，JSON 键与 #39 契约一一对应，不发明 wire 上没有的键（`round` 是调用参数不是事件字段）。
- `tool_call` 只当结束事件用：分身侧规范呈现 = 徽标「已检索」脉冲 + 真实 `result_count`，**不切 searching、不举镜**；无 spawned 不建分身；`plan_id` 徽标文案写「派发」不写「方案」。
- **stage 无权清理分身**：任何 stage 帧到达都只更新主脸/相位；pending 分身只被同 id `subagent_done` 或 settle/cancel/reset/destroy 移除。validating 时仍有 pending 为合法画面，不伪造完成。

### 2.5 单测要点（`frontend-mascot-team.test.ts`）

- `type ?? "stage"` 归一；spawn:done 配对、重复 spawned/done、未知 id、idle 相位事件忽略
- **round 隔离**：`begin()` 新轮后，旧 round 的 `applyEvent`/`settle`/`cancel` 全返回 `null` 且零副作用；`snapshot().round` 正确；`destroy()` 后一切 noop
- **stage 不回收**：exploring_plans 重复到达/routing/validating 到达时 pending 分身保持存活，仅同 id done 使其退场
- 槽位轮换、>3 溢出计数与补位、嵌套（异 parent_run_id）归入聚合
- cancel/settle 清场与墓碑；settle 时仍 pending 的分身按"轮次关闭"移除（不记 done）
- `applyEvent`/`settle`/`cancel` 返回的 mainFace 建议值全表断言（对照 `mascot-states.md` §2.1 总表）

### 2.6 实测项（交付时记录，不编数）

- 4 脸并存（主+3 分身）普通笔记本 DevTools 帧率与内存增量；vendor+控制器+团队层总字节数对照预算。
- reduced-motion 下分身入退场为瞬时静态；帽色三键实核渲染截图附 `docs/issue-40/`。

## 3. F2 之后（不归本计划执行）

- **#41 生产接线**：`mascot-card.js` facade 内嵌 `createMascotTeam`（容器挂在卡片头主脸旁）；`deliver` 闭包捕获 `const {round}=team.begin()`，`onProgress` 调 `team.applyEvent(progress,round)`，结果/失败调 `team.settle(kind,round)`，`wander:reset` 调 `team.cancel(round)`——旧请求的迟到帧天然被 token 挡掉。旧 `STAGE_STATE` 映射退役由团队层接管。
- **#43**：`tool_call.args_summary` 的 `near=lat,lng` 仅供检索涟漪定位参考，分身不落位。
- **#38 合入后复核**：候选上限落地为 3 时，等待池路径仍保留（信号量 8 的共享池不因 UI 上限收缩）。
