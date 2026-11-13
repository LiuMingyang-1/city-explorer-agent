# 活动数据准备：最新仓库核对

核对日期：2026-11-12（Asia/Shanghai）。当前分工以用户最新说明为准：只准备西安市 `events` 表的真实数据，不继续实时搜索系统建设。此前搜索阶段文档与实现保留作已有工作，不作为当前继续推进的任务。

## 获取版本及方式

- 仓库：https://github.com/LiuMingyang-1/city-explorer-agent
- GitHub API 查询到的最新主分支提交：`25c736635a371eeb7e0f08c9b0cf9561e7032309`。
- 提交时间：2026-11-12 10:50:34（上海），主题为位置感知行程规划（location context + nearby search，PR #3）。
- 当前工作目录没有 `.git`，无法直接 pull；两次独立 clone 因 GitHub 连接问题失败。改用 GitHub 官方 API 下载该提交源码快照，放在 `.upstream-review/`，版本记在其中 `UPSTREAM-REVISION.txt`。
- 未将快照覆盖到当前工作区，未自动合并，也没有执行 seed 改动真实数据库。该目录是源码快照，不是正常 Git checkout。

## 与分工直接有关的进度

| 项目 | 最新代码状态 | 对数据工作的影响 |
| --- | --- | --- |
| 活动表 | 仍是原来的 18 列，schema 未变 | 继续按现有字段准备资料 |
| 来源网址 | 仍叫 guide_url / guideUrl，未改 source_url | 新采集保留真实 source_url，导入前需明确迁移，不能假定后端已支持 |
| 本地搜索 | 支持 date/category/keyword，并新增 near/radiusKm | 经度、纬度准确性直接影响召回与排序 |
| 距离 | 查询时派生 distanceKm，不是数据库列 | 数据文件不用填写 distanceKm |
| 场馆位置锚点 | 默认从活动库找最近地点，30km 内才提供锚点 | 数据既影响推荐，也影响定位上下文的地点解释 |
| 数据内容 | 仍由 seed 生成 119 条模拟活动；场馆和坐标为上海示例 | 首批西安真实数据仍未完成 |
| 导入 | 只有模拟 seed 写入，没有真实 JSON 导入命令；EventRepository 仍只有读接口 | 应单独准备校验与导入入口，避免用 seed 覆盖真实数据 |
| 采集 | 没有 Qovia / DeepSeek 采集代码 | 作为本地数据准备工具另行做，不改主 Agent tool |

注意：near/radiusKm 使用球面距离，不是实际道路或交通耗时；radiusKm 只有随 near 传入才生效。类型按精确值匹配，数据类别需统一。活动每个可参加时段单独一行，时间格式与金额单位仍沿用现有定义。

## 本次实际检查

- 阅读快照的 data schema/types/repository/sqlite/seed/templates、agent tool/prompt/session、Web 位置请求接口及相关变更。
- 对比当前本地数据模块：schema、seed、repository 接口没有变化；types 与 sqlite 的主要新增为距离查询。
- 在临时 SQLite 中运行最新 seed 并查询：总计 119 条，2026-11-14 有 17 条；以 `[34.27, 108.95]` 为参考点、30km 半径查询得到 0 条。不设半径时，最近条目为上海“苏州河步道广场（模拟）”，约 1213.32km。
- 最新快照 TypeScript 检查通过：`node node_modules/typescript/bin/tsc --noEmit -p .upstream-review/tsconfig.json`。
- 本次为接口与数据状态核对，没有运行最新快照的全量测试，不能将之前本地阶段 1 的测试结果视为这次上游版本的全量验收。

## 当前应交付的内容

1. 西安真实活动数据文件：名称、介绍、统一类型、场馆、地址、准确坐标、具体时段、停留时长、每人费用、信息来源与素材链接。
2. 本地采集与清洗工具：Qovia 作为社交资料入口、DeepSeek 作为网页搜索入口；保留原始响应，事实缺失不编造。
3. 数据校验与导入工具：先校验，再写 events；不建设新的实时搜索服务、不接入主 Agent。
4. 接口衔接事项：source_url 迁移、统一 WGS-84、活动场次展开和稳定 ID。distanceKm 不入库。

当前尚未配置本地 `.env`（仅检查文件存在性，没有读取或输出密钥）。真实 API 采集与首批真实数据仍未执行。
