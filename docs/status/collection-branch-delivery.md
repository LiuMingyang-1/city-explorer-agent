# 采集分支交付说明

交付日期：2026-11-13。分支：`feat/xian-nightly-events`，不合并主分支。

## 包含内容

- 统一采集入口、初始景点构建与定向复查、关键词库与定时调度配置。
- 小红书MediaCrawler适配、本地OCR、DeepSeek理解与搜索、高德工具定位、时间备注降级、去重和同库事务写入。
- 对应自动测试、docs/architecture/collection.md、实际初始构建/修复/两轮定时写入报告。
- **唯一真实工作库data/events.db**：265条，其中245条景点、20条活动；坐标GCJ-02，events共31列。
- data/events.manifest.json：文件SHA-256、大小、永久database_id、表名、记录数及当前限制。

数据库同时包含_collection_metadata表，保存来源证据、时效信息、批次写入回执和历史时间纠错记录；这是采集继续运行所需的信息，应与events一起保留。没有另建第二份交付数据库，也没有把历史快照提交进来。

## 使用方式

拉取本分支后，应用默认读取data/events.db；无需再次运行模拟seed。表字段、环境变量、采集命令及第三方本地环境准备见[采集README](../architecture/collection.md)。

后续采集继续更新同一个数据库文件。因为该文件已纳入Git，运行采集后出现数据库工作区改动是正常情况；需要交付更新数据时重新生成清单中的统计与SHA-256。现有清单只证明本次版本的文件内容，不能用于验证后续已更新的工作库。

API Key、.env、Cookie、浏览器登录目录、原始采集正文/OCR/API响应、任务状态文件、SQLite临时日志、会话数据库和历史数据库快照不在交付范围内。新机器需自行配置Key及本地平台登录；已入库数据读取不要求采集Key。

## 验证与限制

交付前检查SQLite integrity_check=ok、数据库元信息与事件ID一致、记录统计正确、无已配置密钥值；源代码590项Node测试、6项Python测试及TypeScript检查通过。数据库SHA-256见同目录清单。

采集测试中的失败也保留在报告中：两轮定时入口均成功累计写入，整体状态为partial。第二轮小红书出现登录失效；Windows系统定时触发器尚未安装，配置默认关闭。

数据不是对所有营业信息的实时保证。部分time_status为partial、unknown或conflicting，需要结合time_note使用；即使complete也只是提取结果。例如随机抽样的“太平万花山风景区”采用08:00–17:00，但备注还列有未采用的08:30–18:00，应进一步核对取舍依据。此次提交保留该数据库原值，没有为交付改写事实。

详细运行记录：

- [初始构建报告](initial-attractions-build-report-20261113.md)
- [前期修复报告](initial-data-repair-report-20261113.md)
- [两轮定时写入测试](scheduled-two-rounds-report-20261113.md)
