# 开发说明（v0）

架构与输出契约见 [overview.md](architecture/overview.md)；活动库字段语义见
[database.md](architecture/database.md)。

## 环境与技术栈

- Node.js `>=22.19.0`（开发实测 v24.11.1）；TypeScript 仅用 erasable 语法，
  `.ts` 由 Node 直接运行，无构建步骤。
- Agent 运行时 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` `1.4.0`；
  `typebox` `1.3.27` 作工具参数 schema。
- SQLite 用 Node 内置 `node:sqlite`，无原生依赖，安装不需要编译或预编译二进制。

## 命令

```sh
npm ci --ignore-scripts             # 新克隆安装
npm run seed                        # 写入 119 条模拟活动（先清空再写入）
npm run seed -- --date=YYYY-MM-DD   # 固定生成基准日，结果可复现
npm run dev                         # 交互式 REPL；-- <需求> 单轮；stdin 逐行批处理
npm run check                       # tsc --noEmit + node --test
```

不走 npm 的等价写法：`node --env-file-if-exists=.env src/cli/main.ts`
（裸 `node` 不读 `.env`）。

## 环境变量

写入 `.env`（不入库，模板见 `.env.example`）。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `EXPLORER_API_KEY` | 模型 API 密钥；缺省回退 `OPENAI_API_KEY`（provider=openai）或 `ANTHROPIC_API_KEY`（anthropic） | 必填 |
| `EXPLORER_PROVIDER` | `openai` / `anthropic` / 自定义 id | `openai` |
| `EXPLORER_MODEL` | 模型 ID；自定义端点必填 | `gpt-5.4` / `claude-sonnet-4-6` |
| `EXPLORER_BASE_URL` | 自定义兼容端点；须为 http(s)，不带凭证、query、fragment | 无 |
| `EXPLORER_CONTEXT_WINDOW` | 自定义端点目录元数据的上下文窗口 | `128000` |
| `EXPLORER_MAX_TOKENS` | 单轮输出上限（按模型上限钳制） | `4096` |
| `EXPLORER_DB_PATH` | SQLite 活动库路径 | `data/events.db` |

provider 行为：不设 `EXPLORER_BASE_URL` 时用内置 provider——openai 走
Responses API、anthropic 走 Messages API；设置后按 OpenAI Completions /
Anthropic Messages 兼容端点建单模型目录。自定义 `EXPLORER_PROVIDER`
必须同时给 `EXPLORER_BASE_URL` 与 `EXPLORER_MODEL`。

## 输入输出约定

- stdout：每轮一个单行 JSON——行程对象或 `{"question": "..."}` 追问，
  可按 NDJSON 逐行解析。
- stderr：启动横幅（provider/model 与库路径，不含密钥）、每轮
  `[tool] search_events {...} -> ok Nms` 轨迹、`[error]`、交互提示符。
- 机器消费 stdout 务必 `npm run --silent dev`：npm 默认把脚本横幅打到
  stdout，`--silent` 去除。
- `exit`/`quit`/`退出`、Ctrl+D（EOF）、Ctrl+C 均优雅退出并关闭 SQLite；
  空行跳过。
- 库不存在或为空时 stderr 提示 `npm run seed` 并以退出码 1 结束：
  缺少库文件时不创建；已有库开库可能建表/补列，但不重写活动数据。

## 数据库与 seed

- `npm run seed` 是破坏性重置：`DELETE` 全部活动后写入 119 条新数据，
  覆盖基准日起 7 天；同一 `--date` 生成结果完全一致。
- 打开旧库时 `ensureEventsSchema` 自动做非破坏幂等迁移（建表/补列，
  既有行保留）——schema 升级不需要重新 seed；seed 只用于首次建库或
  整体重置模拟数据。
- 活动含每人费用区间（分；0=免费、NULL=未知）、攻略链接、缩略图与图片
  地址字段；完整字段语义、CHECK 约束与查询行为以
  [database.md](architecture/database.md) 为准。

## 测试

`npm run check` = `tsc --noEmit` + `node --test "test/**/*.test.ts"`，
当前 82 个测试全部通过。

覆盖面：回复 envelope 与约束补丁解析、约束合并（更新/清除/继承）、
校验各分支（shape/window/stops 分文件，共享 fixture）、数据层与字段
映射、schema 迁移往返、会话提交/纠正/失败不覆盖、CLI 逐轮循环与
stdout/stderr 隔离（注入 fake planner，另含 `--help` 冒烟）、端到端
（pi-ai faux provider 离线驱动真实 Agent + 真实 SQLite 与校验器，
不发真实模型请求）。三种输入模式的完整真实 CLI 行为走下文手动验收，
不在自动测试内。

## 手动验收

```sh
npm ci --ignore-scripts && cp .env.example .env   # 填 EXPLORER_API_KEY
npm run seed                                       # 已有库可跳过（会重置数据）
printf '这周六13点到18点想看展也想逛书店\n第二个不喜欢换一个\n' | npm run --silent dev
```

预期：stdout 两行各为可解析行程 JSON，第二行是完整新行程；stderr 见
`[tool] search_events` 轨迹；日期为本次运行日所在周的周六（按需求中
「这周六」的解释），各站落在活动窗口与 13:00–18:00 内且互不重叠。追问可验：`npm run dev -- 想看展`
（缺日期 → 输出 `{"question": "..."}`）。
