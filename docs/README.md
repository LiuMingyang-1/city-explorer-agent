# 文档索引

本目录按文档性质分类存放。新文档先判断属于哪一类再落位，文件名统一
英文 kebab-case；一次性记录（验收、交付状态）放入 `status/` 并在标题
注明日期；描述系统现状的文档随实现同步更新，不标"定稿"之外的日期快照。

## 开发入口

| 文档 | 内容 |
| --- | --- |
| [development.md](development.md) | 环境、命令、环境变量、测试与手动验收 |

## architecture/ — 系统现状设计

描述当前实现，随代码演进持续维护。

| 文档 | 内容 |
| --- | --- |
| [overview.md](architecture/overview.md) | 处理链路、分层职责、工具与模型回复契约 |
| [database.md](architecture/database.md) | events 表 schema、字段语义、迁移与种子策略 |
| [sessions.md](architecture/sessions.md) | 用户/会话/records/runs 数据设计语义 |
| [orchestration.md](architecture/orchestration.md) | 对话会话模型与 `delegate_task` 子 Agent 编排 |

## contracts/ — 跨端契约

前后端与多工作流共同遵守的接口约定，改动需各方对齐。

| 文档 | 内容 |
| --- | --- |
| [agent-api.md](contracts/agent-api.md) | `/api/chat` 请求/响应、坐标系、legs 等 Agent 侧契约 |
| [frontend-alignment.md](contracts/frontend-alignment.md) | 前端交互 ↔ 接口对齐表与部署状态 |
| [day0.md](contracts/day0.md) | Day 0 协调要点：数据库口径、高德方向、Mock 用法 |

## planning/ — 产品与分工规划

前瞻内容，不代表已实现。

| 文档 | 内容 |
| --- | --- |
| [product-plan.md](planning/product-plan.md) | 产品定位、目标体验、数据方案与边界 |
| [roadmap.md](planning/roadmap.md) | 下一阶段共识与 Agent/前端/爬虫分工拆解 |

## status/ — 交付与验收记录

时间点快照，记录当时状态，一般不再更新（验收翻篇时更新结论）。

| 文档 | 内容 |
| --- | --- |
| [p0-frontend.md](status/p0-frontend.md) | P0 前端联调交付状态与 Mock 演示入口 |
| [session-implementation-plan.md](status/session-implementation-plan.md) | 会话持久化任务拆分与接口契约 |
| [session-persistence-acceptance.md](status/session-persistence-acceptance.md) | 会话持久化验收状态与评审历史 |
| [event-metadata-acceptance.md](status/event-metadata-acceptance.md) | 活动费用/素材字段独立验收报告 |

## integrations/ — 外部服务接入

| 文档 | 内容 |
| --- | --- |
| [amap.md](integrations/amap.md) | 高德地图：可行性结论、配色保留、Key 准备与已实现入口 |

## mocks/ — 接口样例

| 目录 | 内容 |
| --- | --- |
| [day0/](mocks/day0/) | Day 0 前后端联调样例（JSON/SSE），测试与前端 dev server 直接引用 |
