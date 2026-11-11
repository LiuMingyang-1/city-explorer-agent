# AI 城市探索地图

`city-explorer-agent`：以地图为入口、用自然语言规划城市一日出行的 Personal Agent。
当前已交付命令行 v0 和独立地图前端原型；前端对话为模拟交互，尚未接入真实 Agent。后续规划见
[docs/product-plan.md](docs/product-plan.md)。计划参加
[传智杯 AI WEB 赛道](https://www.boxuegu.com/matchTrack/detail/?id=10037)。

## v0 命令行能力

自然语言输入出行需求 → Agent 调用 `search_events` 查 SQLite 活动库 →
输出可解析的行程 JSON → 同一会话内继续用自然语言修改（换一站、晚出发、少一站等）。

- stdout 每轮一个单行 JSON：行程对象或 `{"question": "..."}` 追问，可按 NDJSON
  解析；输入提示、`search_events` 工具轨迹和错误走 stderr。
- 缺日期等关键条件时先追问；信息足够才生成行程，输出经代码校验通过后才提交。
- 边界：活动为内置模拟数据（119 条，覆盖运行日起 7 天）；还没有交通路线与
  通勤时间计算；对话与行程只保存在进程内，退出即清空。

## 地图前端（独立原型）

使用 Node.js `>=22.19`，无需安装 npm 依赖、配置模型密钥或初始化活动库：

```sh
npm run dev:frontend
```

打开 http://127.0.0.1:5173 。包含西安地图、地点搜索、定位、天气与模拟对话。
前端说明、地图数据来源和后续接口接入点见 [frontend/README.md](frontend/README.md)。

## CLI 快速开始

要求 Node.js `>=22.19`（开发实测 v24）。

```sh
npm ci --ignore-scripts       # 新克隆安装；无原生依赖，可安全跳过安装脚本
cp .env.example .env          # 填 EXPLORER_API_KEY（缺省回退 OPENAI_API_KEY/ANTHROPIC_API_KEY）
npm run seed                  # 首次写入模拟活动；先清空再写入，已有库请勿重复执行
npm run dev                   # 交互式 REPL
npm run check                 # typecheck + 全部测试
```

已有 `data/events.db` 时无需重新 seed——打开旧库会自动补齐新增列，原有数据保留；
`npm run seed` 是破坏性重置，只用于首次建库或重造数据。

三种输入：交互 REPL、`npm run dev -- <需求>` 单轮、stdin 逐行批处理。
脚本消费 stdout 用 `npm run --silent dev`（npm 默认把脚本横幅打到 stdout）；
不走 npm 可用 `node --env-file-if-exists=.env src/cli/main.ts`（裸 `node` 不读 `.env`）。

## 交互示例

```text
> 这周六 13:00 到 18:00 想看展，也想逛书店，别太赶
{"date":"2026-11-14","summary":"下午安排一场展览","stops":[{"event_id":"evt_004","arrive_at":"13:00","leave_at":"14:30","reason":"展览主题吻合"}]}

> 这个不喜欢，换一个
（返回一行同结构的完整新行程 JSON，对应站已替换）
```

输入 `exit`/`quit`/`退出`，或 Ctrl+D / Ctrl+C 结束会话。

## 文档

- [docs/architecture.md](docs/architecture.md) — 分层职责、会话与校验、模型输出契约
- [docs/development.md](docs/development.md) — 环境、配置、命令、测试与手动验收
- [docs/product-plan.md](docs/product-plan.md) — 产品愿景、数据方案与不做事项
- [docs/database-design.md](docs/database-design.md) — 活动库表结构、字段语义、查询与迁移策略
