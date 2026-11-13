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

采集子系统（西安活动/景点采集）：

| 文档 | 内容 |
| --- | --- |
| [collection.md](architecture/collection.md) | 采集系统说明书：配置、入口、命令、环境准备与报告索引 |
| [events-v4.md](architecture/events-v4.md) | 活动/景点共表 v4 现行规范与验收（配 [events-unified-v4.sql](architecture/events-unified-v4.sql) DDL） |
| [collection-downstream-design.md](architecture/collection-downstream-design.md) | 采集后处理：DeepSeek 提取、校验、高德确认与发布流程 |
| [collection-validation.md](architecture/collection-validation.md) | 采集校验规则现状 |
| [collection-demo-policy.md](architecture/collection-demo-policy.md) | Demo 校验规则说明 |
| [collection-extraction-prompt-v4.md](architecture/collection-extraction-prompt-v4.md) | v4 提取提示词原文 |
| [collection-time-notes-and-tools.md](architecture/collection-time-notes-and-tools.md) | 时间备注字段与 OCR、高德模型工具流程 |
| [static-events-collection-design.md](architecture/static-events-collection-design.md) | 静态活动采集实施设计与平台调研 |
| [unified-collection-entry.md](architecture/unified-collection-entry.md) | 统一手动采集入口 |
| [scheduled-keyword-design.md](architecture/scheduled-keyword-design.md) | 定时采集词库原始设计 |
| [attraction-coordinate-dedup.md](architecture/attraction-coordinate-dedup.md) | 景点经纬度去重 |
| [scenic-level-search-tool.md](architecture/scenic-level-search-tool.md) | 景点 A 级补查搜索工具 |
| [mediacrawler/](architecture/mediacrawler/) | MediaCrawler 接入、阶段 2 验收与 requirements lock |

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
| [nightly-static-events-plan.md](planning/nightly-static-events-plan.md) | 夜间静态活动数据方案与平台调研记录 |
| [xian-bootstrap-and-nightly-plan.md](planning/xian-bootstrap-and-nightly-plan.md) | 西安初始构建与夜间采集总体规划 |
| [xian-real-events-data-plan.md](planning/xian-real-events-data-plan.md) | 真实活动数据方案（阶段 A/B） |
| [xian-attraction-seed-list.md](planning/xian-attraction-seed-list.md) | 西安景点目标清单与名称线索来源 |
| [real-events-stage-a/](planning/real-events-stage-a/) | 真实活动阶段 A 交付：验收记录与 events-delivery.sql |

## status/ — 交付与验收记录

时间点快照，记录当时状态，一般不再更新（验收翻篇时更新结论）。

| 文档 | 内容 |
| --- | --- |
| [p0-frontend.md](status/p0-frontend.md) | P0 前端联调交付状态与 Mock 演示入口 |
| [session-implementation-plan.md](status/session-implementation-plan.md) | 会话持久化任务拆分与接口契约 |
| [session-persistence-acceptance.md](status/session-persistence-acceptance.md) | 会话持久化验收状态与评审历史 |
| [event-metadata-acceptance.md](status/event-metadata-acceptance.md) | 活动费用/素材字段独立验收报告 |

采集验收与交付快照：

| 文档 | 内容 |
| --- | --- |
| [collection-branch-delivery.md](status/collection-branch-delivery.md) | 采集分支交付说明与范围 |
| [collection-task-acceptance.md](status/collection-task-acceptance.md) | 定时采集入口验收（2026-11-13） |
| [initial-attractions-build-report-20261113.md](status/initial-attractions-build-report-20261113.md) | 247 目标初始构建真实报告 |
| [initial-data-repair-report-20261113.md](status/initial-data-repair-report-20261113.md) | 前期未入库目标复查修复报告 |
| [scheduled-two-rounds-report-20261113.md](status/scheduled-two-rounds-report-20261113.md) | 两轮定时写入实测 |
| [collection-final-acceptance.md](status/collection-final-acceptance.md) | Demo 结构小样本最终验收 |
| [real-events-pilot-report.md](status/real-events-pilot-report.md) | 真实采集首批实测（DeepSeek/MediaCrawler） |
| [events-upstream-review.md](status/events-upstream-review.md) | 活动上游来源复查 |
| 其余 `collection-*-report.md` / `collection-*-acceptance.md` | 校验修订、定位修复、五样本、OCR 工具等历次测试验收 |

## integrations/ — 外部服务接入

| 文档 | 内容 |
| --- | --- |
| [amap.md](integrations/amap.md) | 高德地图：可行性结论、配色保留、Key 准备与已实现入口 |

## mocks/ — 接口样例

| 目录 | 内容 |
| --- | --- |
| [day0/](mocks/day0/) | Day 0 前后端联调样例（JSON/SSE），测试与前端 dev server 直接引用 |
