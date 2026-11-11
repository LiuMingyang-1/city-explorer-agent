# 架构（v0 命令行）

本文描述当前实现。运行环境与测试见 [development.md](development.md)，
规划中的前端与数据源见 [product-plan.md](product-plan.md)。

## 处理链路

```
用户输入 → src/cli → PlannerSession → Pi Agent → search_events → SQLite
        → 回复解析 → 约束合并 → 规则校验 → stdout 单行 JSON
```

## 分层职责

| 层 | 模块 | 职责 |
| --- | --- | --- |
| CLI | `cli/main.ts`、`cli/loop.ts` | 读配置、开库、三种输入模式（REPL / argv 单轮 / stdin 批处理）、stdout/stderr 隔离 |
| 会话 | `agent/session.ts` | 包一层 Pi Agent：每轮 prompt → 解析 → 合并约束 → 取活动详情 → 校验 → 仅成功才提交 |
| Agent 接入 | `agent/explorer-agent.ts`、`model.ts`、`prompt.ts` | pi-ai provider/模型解析、系统提示固定输出契约、挂接唯一工具 |
| 数据 | `data/*` | `EventRepository` 接口、SQLite 实现、幂等 schema 迁移、种子生成 |
| 行程 | `itinerary/*` | `PlanningConstraints`/`Itinerary` 类型、约束合并、`validateItinerary` |

依赖方向 `cli → agent → data`；`itinerary` 只依赖 `data` 的类型（校验需要活动详情）。

## 工具

唯一工具 `search_events({ date?, category?, keyword? })`：按日期（与活动可参加
时间窗有交集）、类型、关键词查 SQLite，一轮内可多次调用（如先查展览再查书店）。
Agent 经它取数，不直接写 SQL；返回活动 JSON 含 id、时间窗、建议时长、
每人费用区间与素材链接。

## 模型回复 envelope（内部契约）

模型每轮只回一个 JSON 对象（系统提示约定），两种形态：

- 追问：`{"type":"clarify","question":"…"}`——缺日期等关键条件时使用。
- 行程：`{"type":"itinerary","constraints":{…},"itinerary":{…}}`

`constraints` 是补丁：`date` 每轮必填；`availableStart`/`availableEnd`
填字符串为更新、`null` 为用户明确放开（清除）、省略为沿用已确认值。
`itinerary` 是未校验候选（candidate），由代码接管校验后才生效。

```json
{"type":"itinerary",
 "constraints":{"date":"2026-11-14","availableStart":"13:00","availableEnd":"18:00"},
 "itinerary":{"date":"2026-11-14","summary":"下午先看展再到书店",
   "stops":[{"event_id":"evt_004","arrive_at":"13:00","leave_at":"14:30","reason":"展览主题吻合"}]}}
```

## 最终 stdout 契约

每轮输出一行，二者其一：

- 行程：上例中的 `itinerary` 对象（`date`/`summary`/`stops[]`；stop 仅含
  `event_id`/`arrive_at`/`leave_at`/`reason`，费用等活动详情经 `event_id` 关联）。
- 追问：`{"question":"…"}`。

工具轨迹、提示与错误只走 stderr，与 stdout 隔离。

## 多轮与提交语义

- 会话与当前行程保存在进程内（Agent transcript + session 对象），退出即结束。
- 校验通过才更新「当前行程 + 已确认约束」；解析或校验失败不覆盖既有状态。
- 失败时把原始需求、当前生效约束与具体问题回喂模型纠正，最多
  `maxCorrections` 次（默认 2）。
- 多轮输入走 `session.prompt()`；`steer()`/`followUp()` 是 pi-core Agent 的
  底层 API（运行中追加指令 / 排队下一轮），v0 CLI 未暴露对应命令。

## 代码能验证 / 不保证

代码校验：JSON 结构与字段类型、真实日历日期与时钟（拒绝 02-30、99:00）、
时段先后、`event_id` 存在、行程日期与要求日期一致、到访落在活动窗口与
用户可用时段内、各站时间不重叠。约束合法时允许空 `stops`（无匹配活动）。

不保证：日期、可用时段等约束由模型从自然语言提取，校验只检查收到的结构化
约束本身合法，不能独立保证模型正确理解了用户原意；兴趣匹配与选品质量、
修改意图是否被正确执行（如「换一个」换的是不是用户所指那站）、地理顺路
与通勤可行同样依赖模型与对话上下文，代码只管结构化约束。用户整趟预算不在
v0 范围；活动费用是每人参考区间，不进行程 JSON。
