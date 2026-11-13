# 初始清单与定时补充入口验收

日期：2026-11-13。分支：feat/xian-nightly-events。当前说明书见[采集系统README](../architecture/collection.md)。

## 实现

- 提取共用runCollection，原collect CLI和新collect:task调用同一套采集、OCR、模型地图工具、校验和SQLite发布逻辑。
- 新增实际可运行的collection.bootstrap.json与collection.scheduled.json，不使用历史design稿执行。
- 初始247目标按每批5个拆分，DeepSeek每目标最多2篇；目标上下文与模型明确的target_match/visitable检查进入提取流程，不写入events字段。
- 一篇官方名录可分别支持多个目标，避免全局URL去重漏掉后续目标。
- 定时词库18组68模板，支持固定词与轮换模板，时区、次日日期锚点、周末/跨年、季节和显式节日窗口。
- 记录批次进度、计划与结果，同一计划日不重复执行，共用发布根的任务互斥，失败轮不推进游标。
- Windows安装脚本默认只预览，显式-Install且schedule.enabled=true才注册；默认不覆盖既有任务。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| TypeScript src/test检查 | 通过 |
| 全量Node测试 | 574/574通过，0失败/取消/跳过 |
| Python MediaCrawler适配器单元测试 | 5/5通过 |
| 原手动CLI无联网预览 | 兼容，通过回归测试 |
| 初始与定时CLI的实际预览 | 两者均通过，api_calls=0 |
| Windows脚本不带-Install执行 | 预览通过，未注册任务 |
| 247目标拆批 | 50批，目标不重不漏，最后2个；创新港项存在 |
| 日历与轮换 | 周五、周日、跨年、冬季跨年、节日窗口、14地域覆盖通过 |
| 执行控制 | 同日重复、配置变化、并发锁、部分失败、异常释放锁、显式初始重试通过 |
| 新目标链路到实际SQLite | 注入离线资料与地图结果，写入并读回，31列、integrity_check=ok |

全量Node日志保留于Git忽略目录.local-data/xian/planning/task-regression-test.log。合成测试资料只用于测试，不冒充真实采集结果。

## 尚未在线验收/未做的操作

- 没有使用新入口启动5/247目标的真实付费采集，因此没有新的目标匹配准确率或总耗时结论。
- 没有安装、启用Windows任务，没有让账号夜间无人值守运行。
- 没有修改应用data/events.db，没有替换假数据，也没有合并/推送分支。
- 当前进度是批次级；失败批显式重试可能重复部分请求，不声称已经实现仅失败查询的精确续跑。
- 目标语义仍由分析模型判断；布尔确认和schema只证明输出满足契约，不证明内容一定真实。
- 跨来源景点代表ID可能变化、跨来源活动语义合并、应用正式库替换与全库状态维护仍待后续实现。

README中的两条完整业务样例直接读取已有真实历史文件，不是本轮新调用API生成。源文件为.local-data/xian/runs/scenic-level-verified-20261113/combined-events.json，样例ID逐项比对一致。新增接口、配置和测试不包含真实API Key或Cookie。
