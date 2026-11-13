# 活动费用与素材字段独立验收

日期：2026-11-11（Asia/Shanghai）。验收对象为当前工作区，非仅已提交 HEAD。
只读源码与测试，临时验证放在 `/tmp`；仓库仅写本报告。未修改源码、测试、
旧 v0 验收报告，未 seed 实际库、修改原活动、commit、push 或再委派。

## 结论

**最终验收通过。** 费用/素材字段功能、实际库保留、工具链路及真实模型冒烟
均通过；初次发现的单文件超行数问题已由 SWE 拆分并独立复验关闭。

初次发现：`test/data.test.ts` 为 225 行。最终为 `data.test.ts` 136 行、
`data-metadata.test.ts` 81 行、共享 `data-fixture.ts` 23 行。对照前次读取内容，
原有 9 项数据测试及新增 3 项字段测试、断言与真实库 fixture 语义均保留，
仅拆分文件和调整导入；Reviewer 未自行修改源码或测试。
最终 `src/`、`scripts/`、`test/` TS 文件全部不超过 200 行（最长 181 行）。
未发现阻塞本次字段扩展交付的实际缺陷，也未引入不必要框架。

## 检查结果与证据

- 拆分前后独立执行 `npm run check` 均退出码 0，TypeScript 检查通过，
  **82/82 测试通过**，无失败、跳过或取消；最终日志为
  `/tmp/event-metadata-final-check.log`。
- 另有 **16 组独立运行检查通过**：临时脚本 14 组、种子旧字段与库完整性
  1 组、真实模型 CLI 结果独立审计 1 组。文件行数检查另计，初次失败 1 项，最终已复验通过。
- 临时脚本：`/tmp/event-metadata-review.mts`；临时库目录：
  `/tmp/event-metadata-accept-9Etki0`。该脚本实际执行生产迁移、seed、
  repository 与 `createSearchEventsTool`，未替换查询或字段映射实现。

| 检查 | 实际结果 |
| --- | --- |
| 11 列旧库迁移两次 | 恰好 18 列；自定义旧行全部 11 列逐值保留 |
| 迁移默认值 | 费用/说明/攻略/缩略图 NULL，币种 CNY，图片 `[]` |
| 已填新字段再迁移 | 全部 18 列逐值不变 |
| 费用约束 | 负数、小数、上下限倒置被拒；免费 0 与未知 null 保持区别 |
| 图片约束 | 非 JSON、非数组被拒；混合元素数组在 search/getByIds 读取边界报错 |
| 真实工具往返 | 攻略、缩略图、说明、费用与 `['z','a','z']` 图片顺序及重复项保留 |
| 新库及旧 11 列库 seed | 各连续执行两次，均为 119 条，全部 Event 字段完整往返 |
| 种子稳定性 | 固定基准日结果相同；全部 119 条旧 11 列与实际库基线逐值一致 |
| 实际库工具链路 | 按 11-11 至 11-17 七天调用真实 search_events，119 条新字段逐项匹配 SQLite |

`image_urls` 存 TEXT JSON，repository 解析为有序 `string[]`；数据库 CHECK
保证 JSON 数组，元素字符串类型由读边界检查，符合当前实现契约。

## 实际库终验

已读取 SWE 补齐完成回执，并独立验证 `data/events.db`：

- 119 行 / 18 列，日期覆盖 **2026-11-11 至 2026-11-17**；
  `PRAGMA integrity_check` 为 `ok`。
- 已知费用 110 条，其中付费 64、免费 46；未知 9 条。
- 全部 119 条有攻略和缩略图，各有 1–3 张图片，共 239 个图片地址。
- 旧 11 列按 id 排序，经 `sqlite3 -json` 输出计算 SHA256，验证前后均为：
  `203aae4b0be2d2f8c8fa5420d40b34e6df1b085112cd22a57176b38380c1a041`。
  与统筹提供的迁移前基线完全一致，未丢行或改变原字段。

## 真实模型 CLI 冒烟

请求：这周六 13:00 到 18:00 想看展，也想逛书店，别太赶。
使用项目现有环境配置运行 CLI，未查看或打印密钥。
沙箱内首次连接失败；获得网络执行授权后重跑成功，模型为 deepseek-flash。

- 两次真实 `search_events`：2026-11-14 的展览、书店活动。
- stdout 单行行程 JSON：`evt_004` 13:00–14:30，`evt_064` 15:15–16:15。
- 输出将库内展览每人 8000–12000 分表述为 80–120 元，书店活动免费。
- 独立审计通过：日期、ID、活动窗口、用户时段、离开晚于到达、无重叠；
  最终 JSON 仍仅 date/summary/stops，stop 字段结构保持原契约。
- 证据：`/tmp/event-metadata-smoke.stdout`、`/tmp/event-metadata-smoke.stderr`。

## 契约、文档与范围

已核对 types/schema/sqlite/seed/seed-templates/seed-extras、工具与提示词，
以及 README、agent-v0-plan、v0-development。每人费用分单位、0 免费/null
未知、币种/说明、单攻略/单缩略图、有序图片数组的描述与实现一致。
`docs/v0-acceptance.md` 保留旧版 73 项验收历史，本次字段扩展以本报告为准。
已核对开发说明顶部、字段扩展节及 README 均链接本报告，目标文件存在；
开发说明明确标注旧 v0 报告为原 73 项历史验收。

遵守用户最新范围：普通示例价格与 URL 均可，不因未查证价格或无效示例链接
判缺陷，不做 URL 访问验证，也不要求新增模拟/占位等警示。既有活动自带的
模拟字样未改。整趟预算约束、价格筛选、图片下载、缩略图生成均不在本次范围。
真实模型冒烟是本次采样证据；未在最低 Node 版本另测。

检索记录：Nowledge MCP，query=`city-explorer-agent budgetMin imageUrls`，
默认 normal 请求、strict/default 空间、limit=1、无其他过滤；唯一结果为
`8a6e0105-e640-44d1-b580-6b85f79e1c97`（后续 v1 数据范围，score=0.99），
未用于替代本次字段契约。图谱因无法确认同空间权限而跳过。

最终复验补记：测试拆分后再次核对实际库旧 11 列 SHA256，仍与原基线一致。
本轮 Nowledge MCP 定向查询 `city-explorer-agent event metadata 验收 200行`，
strict/default、limit=1，返回数据源调研记忆
`60683220-462f-46c9-b5fa-2c6e83d9a8bb`（score=0.99），与本次拆分无直接关系，
未用作验收依据；同空间图谱权限仍无法确认，跳过图谱。
