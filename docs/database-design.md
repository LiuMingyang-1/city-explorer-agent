# Database Design

> 当前实现已升级为活动/景点共表v4，旧版字段/校验描述作为历史记录。以[统一表实现与验收](unified-events-v4.md)为准。


本文说明活动库的 Schema、字段语义、查询行为、迁移与种子策略。
范围限第一版单进程 CLI 的活动数据；架构与模块分工见 [architecture.md](architecture.md)，
运行命令见 [development.md](development.md)。

## 持久化边界

- 落盘数据只有一个 SQLite 文件：默认 `data/events.db`，经 `EXPLORER_DB_PATH` 覆盖。
- 由 Node 内置 `node:sqlite`（`DatabaseSync`）打开，无原生依赖；`:memory:` 仅供测试。
- 对话上下文与当前行程只保存在进程内存（Pi-core 会话 + `Itinerary` 对象），退出即失，
  不写入本库，也无会话文件。
- 行程 JSON 的 `stops` 只引用 `event_id`；费用、攻略、图片等活动详情经 `getByIds`
  回查本库，不进 stops。
- 规划查询不改活动数据：CLI 启动时检查库文件存在且 `events` 表非空，否则提示
  `npm run seed` 并以退出码 1 结束。库文件存在但结构为旧版时，打开即由
  `ensureEventsSchema` 建表/补列（结构迁移，不改写既有活动行）；`npm run seed`
  才显式替换全部活动数据。

## events 表（18 列）

每行对应**一个活动的一个可参加时段**：同一活动每天一场会展开为多行。

| 列名 | 类型 | 可空 | 默认 | 含义 | TS 字段 |
| --- | --- | --- | --- | --- | --- |
| `id` | TEXT PRIMARY KEY | 否 | — | 活动时段唯一 ID，行程经 `event_id` 引用 | `id` |
| `title` | TEXT | 否 | — | 活动名称 | `title` |
| `description` | TEXT | 否 | — | 活动介绍 | `description` |
| `category` | TEXT | 否 | — | 固定 12 类，见 src/data/categories.ts | `category` |
| `venue_name` | TEXT | 否 | — | 场地名称 | `venueName` |
| `address` | TEXT | 否 | — | 详细地址 | `address` |
| `latitude` | REAL | 是 | NULL | 纬度；最终发布必须补齐 | `latitude` |
| `longitude` | REAL | 是 | NULL | 经度；必须与纬度成对 | `longitude` |
| `start_at` | TEXT | 是 | NULL | 可参加开始时间，未知不等于全天开放 | `startAt` |
| `end_at` | TEXT | 是 | NULL | 可参加结束时间，未知不能自动排程 | `endAt` |
| `suggested_duration_minutes` | INTEGER | 是 | NULL | 建议停留时长（分钟），未知留空 | `suggestedDurationMinutes` |
| `budget_min` | INTEGER | 是 | — | 每人预计费用下限（分） | `budgetMin` |
| `budget_max` | INTEGER | 是 | — | 每人预计费用上限（分） | `budgetMax` |
| `currency` | TEXT | 否 | `'CNY'` | 费用币种代码 | `currency` |
| `budget_note` | TEXT | 是 | NULL | 费用补充说明（票价档位、押金、另计） | `budgetNote` |
| `guide_url` | TEXT | 是 | NULL | 单条攻略链接 | `guideUrl` |
| `thumbnail_url` | TEXT | 是 | NULL | 单张缩略图地址 | `thumbnailUrl` |
| `image_urls` | TEXT | 否 | `'[]'` | 展示图地址，有序 JSON 字符串数组 | `imageUrls` |

前 11 列为初版基础结构，后 7 列为费用与素材扩展列；建表与迁移共用同一份列定义。
数据库列为 snake_case，TS 侧 `Event` 为 camelCase，由 repository 映射。

## 时间语义

- `start_at`/`end_at` 为本地时间 `YYYY-MM-DDTHH:MM`，不带时区，且均含具体日期。
- **时间窗活动**：起止表示可自由参观的开放窗口，`suggested_duration_minutes`
  是建议停留时长（如展览 10:00–18:00 建议停留 90 分钟）。
- **固定场次活动**：起止即该场次实际开演至散场时间，建议留满全程
  （如演出 19:30 开场、时长 100 分钟，建议值等于场次时长）。
- 采集发布按具体场次/每日开放时段展开，每段不超过 24 小时；不能用整个展期冒充连续开放。日期查询仍按重叠判断，以兼容已有跨日数据。

## 费用语义

- `budget_min`/`budget_max` 为**该活动每人**的预计花费区间，单位分（100 分 = 1 元）。
- `0` = 明确免费；`NULL` = 未知（不是免费）；定价票可退化为 `min = max`。
- 与"整趟预算"不同：后者是行程级约束，本期不做预算校验；行程校验只覆盖
  结构、活动 ID 存在、日期匹配、到访时间落在可参加时段内、各站不重叠。
- `currency` 默认 `CNY`；票价档位、押金、消费另计等细节放 `budget_note`。

## 攻略与图片

- 只存地址（URL 或路径），不存 BLOB 或 base64；不实现图片下载、缩略图生成或
  真实图片服务。
- `guide_url`：每活动至多一条攻略链接，无则为 NULL。
- `thumbnail_url`：至多一张缩略图，无图时为 NULL。
- `image_urls`：展示用完整图片地址列表，JSON 字符串数组，元素顺序即展示顺序；
  无图为 `[]`，列本身 NOT NULL。

## 约束与读取校验

CHECK 覆盖的范围以 `src/data/schema.ts` 实现为准：

- `budget_min`/`budget_max`：NULL 放行，否则必须为非负整数；两者非空时 `min <= max`。
- `image_urls`：CHECK 只保证列值是合法 JSON 数组（`json_valid` 且 `json_type = 'array'`）；
  数组元素全为字符串由 repository 读边界 `parseImageUrls` 检查（CHECK 内不遍历
  `json_each`），库内数据损坏时报错而非静默丢图。
- category 使用共享 12 类枚举 CHECK；基础文本禁止纯空白；坐标成对可空、非空时检查范围和数值类型；建议时长为 1–1440 的整数或 NULL。
- 开放时间的语义、有效性及证据在采集发布边界校验，不由 SQL 推断。

## 查询语义

Agent 只经 `EventRepository` 取数，不直接编写 SQL；`search` 即 `search_events`
工具的参数（`date`/`category`/`keyword` 均可选，AND 组合）。

| 参数 | 语义 |
| --- | --- |
| `date` | `YYYY-MM-DD`；返回可参加时段与该日有交集的活动：`substr(start_at,1,10) <= date AND substr(end_at,1,10) >= date` |
| `category` | 类型精确匹配 |
| `keyword` | 对 `title`、`description` 做 LIKE 包含匹配；`%`、`_`、`\` 经转义，`ESCAPE '\'` |

- 结果 `ORDER BY start_at, id`，`LIMIT 100`；无条件时同样限 100 条，防止整库塞给模型。
- 所有条件值走绑定参数；`getByIds` 以 `id IN (?, …)` 批量回查，不存在的 id 不出现在结果中。

## 迁移与种子

两件事不要混淆：

- **迁移（自动、非破坏、幂等）**：`ensureEventsSchema` 在打开库时执行——表不存在则
  建表，已存在则按 `PRAGMA table_info` 只补缺失列（`ALTER TABLE ADD COLUMN`），
  单事务、可重复执行。既有行回填列默认：费用/攻略/缩略图为 NULL，`currency` 为
  `CNY`，`image_urls` 为 `[]`，旧数据保留，无需重新 seed。
- **种子（显式、整体替换）**：`npm run seed` 先 `DELETE FROM events` 再写入 119 条
  模拟活动（虚构场地与活动，覆盖基准日起 7 天），写入前同样先补结构，重复执行
  条数不变。生成对基准日确定：`--date=YYYY-MM-DD` 固定基准日即可重复得到完全相同
  的数据，缺省取运行当天。
- 种子含免费、付费区间、费用未知（模板省略 budget）样例，以及攻略链接、无图、
  单图与多图样例。

## 夜间真实数据补充：兼容约定

本分支保留原 18 列，start_at/end_at/suggested_duration_minutes 显式 DEFAULT NULL；latitude/longitude 放宽为成对可空，最终发布仍必须补齐，普通 search/getByIds 均不会返回缺坐标行。具体采集规则见 [静态采集实施设计](static-events-collection-design.md)。

旧库自动事务重建以更新约束，保留已有行、自定义列、索引、触发器及外部引用，恢复原外键设置。旧库存在不兼容分类则停止并回滚，不擅自改写记录，不运行 seed。来源和时效元数据仍存 provenance sidecar。

不带日期的发现可返回未知时间但坐标完整的活动；date 查询只匹配完整时间边界。规划器拒绝未知时间边界；未知建议时长不伪装成来源事实。collection/freshness.ts 的时效决策尚需后续发布/读库入口接入。
