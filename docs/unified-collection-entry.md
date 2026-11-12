# 统一静态采集入口

统一命令是`npm run collect`，配置文件示例为`configs/collection.example.json`。它负责外部来源采集、正文/OCR分析、高德定位、景点A级补查、时间校验、景点坐标去重及本地发布。没有修改主agent的查库工具，也没有恢复实时混合搜索。

## 配置“小红书和DeepSeek各取5篇”

```json
{
  "city": "西安市",
  "keywords": ["西交创新港"],
  "engines": [
    { "name": "xiaohongshu", "enabled": true, "limit": 5 },
    { "name": "deepseek", "enabled": true, "limit": 5 }
  ],
  "output_dir": ".local-data/xian/unified-runs",
  "processing": {
    "enabled": true,
    "ocr": true,
    "attraction_duplicate_meters": 10
  }
}
```

| 参数 | 含义及默认值 |
| --- | --- |
| city | 当前仅支持西安市；约束提取和高德核验，不代表搜索引擎具有城市硬过滤 |
| keywords | 公共搜索词列表，原样发送，不自动拼接城市、日期或其他搜索词 |
| engines | 引擎列表；新增引擎通过适配器注册接入 |
| engines[].name | 已注册的引擎标识，目前为xiaohongshu、deepseek |
| engines[].enabled | 默认true；设false不执行该引擎，未来尚未接入的引擎也可先关闭 |
| engines[].limit | 该引擎本轮所有关键词合计最多取多少篇来源，默认5，不是events数量 |
| engines[].keywords | 可选，覆盖公共关键词 |
| output_dir | 每次运行目录的父目录，必须在.local-data内；系统自动创建独立run目录 |
| processing.enabled | 默认true；false只搜索并导出来源，不调用分析模型或高德 |
| processing.ocr | 默认true；false时只分析正文，不识别图片 |
| processing.attraction_duplicate_meters | 默认10，景点坐标去重距离阈值；活动不按坐标合并 |
| publish_root | 可选的持久发布目录，必须在.local-data内；省略则使用本次run目录下的release作为隔离样本库 |
| base_date | 可选YYYY-MM-DD，默认北京时间当天，作为采集处理基准；不是搜索引擎的发布时间过滤参数 |
| budgets | 可选调用预算，见下文 |

目前沿用小样本限制：小红书每轮最多5篇，DeepSeek每轮最多20篇。配置超过适配器上限会在搜索前报错，不会静默截断。一个来源最多提取3个对象，因此各取5篇可能产生多于或少于10条候选。

## 两个引擎使用不同关键词

```json
"engines": [
  { "name": "xiaohongshu", "limit": 5, "keywords": ["西安周末去哪"] },
  { "name": "deepseek", "limit": 5, "keywords": ["西安公园开放时间", "西安本周展览"] }
]
```

DeepSeek的5篇会分配为第一个词最多3篇、第二个词最多2篇；不是每个词各5篇。每个配置关键词至少分到1篇配额，因此limit不能小于关键词数量。未取满、重复网址或某个引擎失败会明确报告，不会无限翻页、偷偷更换关键词或声称已经取满。

## 执行

在项目根目录先预览计划：

```powershell
npm run collect -- --config configs/collection.example.json
```

默认预览不读取密钥、不联网、不创建输出目录。执行实际采集：

```powershell
npm run collect -- --config configs/collection.example.json --live
```

沿用本地.env中的DEEPSEEK_API_KEY、EXPLORER_COLLECTION_MODEL、AMAP_WEB_KEY，不把Key写进配置。小红书沿用本地登录及隔离Python环境；当前不支持自动登录。不开启处理且仅使用小红书时，不要求DeepSeek/高德Key。

可选预算默认如下：

```json
"budgets": {
  "model_requests": 80,
  "map_requests": 60,
  "level_searches": 10
}
```

model_requests是主分析HTTP请求上限；等级补查和专门等级核验各自另受level_searches限制。地图请求次数包含其有限重试。源网页搜索次数由关键词列表控制。最终summary会记录实际调用，不能把每篇资料等同一次模型请求。

## 输出与失败处理

每次运行生成独立目录，包含：

- config.json、plan.json：本轮有效参数和实际搜索任务。
- sources.json：两个引擎统一格式的来源正文、图片地址及时间信息。
- coverage.json：各引擎、各关键词要求数量、实际数量、耗时及失败原因。
- duplicate-sources.json：本轮跨引擎重复URL。
- document-N.json、processing.json：各来源的提取、拒绝、合并及OCR结果。
- events.json：最终发布库的完整业务数据；若使用持久publish_root，可能包含以前批次数据，不能当成本轮新增条数。尚无发布库时为[]。
- attraction-duplicates.json：景点坐标合并来源记录。
- summary.json：最终状态、实际样本库位置、数量和调用情况。
- api-N.json、map-N.json、ocr-N.json：本地诊断记录。

单个引擎失败不丢失其他引擎的结果。来源不足或处理异常返回partial；全部未取得来源返回failed。已结束活动等正常数据拒绝单独列出，不等于整个搜索执行失败。主分析最终未产生合法JSON、发布失败或OCR受限会明确标记处理异常。

退出码：0为success，2为partial，1为failed或配置/运行错误。未指定publish_root时只创建隔离样本库，不修改data/events.db；指定后使用原子发布流程更新该目录的CURRENT。

## 扩展引擎

1. 实现CollectionEngineAdapter的search方法，返回统一CollectedSource和warnings，并声明maxLimit。
2. 在src/collection/source-adapters.ts的createDefaultCollectionEngines注册新适配器。
3. 在配置engines列表增加对应name、limit和关键词。

通用配置校验、任务分配、失败隔离、去重和后续分析不包含引擎名分支，无需逐处添加新引擎逻辑。各适配器负责自己的凭据和来源格式转换，不在JSON中接受任意API地址、Cookie或Key。

适配器构造时不联网、不强制要求凭据；在search中校验凭据并设置自身请求超时，保证预览模式不需要账号或Key。

## 验证记录（2026-11-13）

- 新增10项入口测试，包括配置默认值、关键词配额、动态引擎注册、关闭引擎、无效配置、跨引擎重复来源、失败隔离、DeepSeek参数、CLI无联网预览及MediaCrawler输出目录约束。
- TypeScript源码及入口脚本检查通过；551项Node回归测试、5项Python测试通过。
- 实际通过新入口搜索“西安 丰庆公园”，小红书和DeepSeek各取1篇，两引擎搜索均success；提取校验后3条写入隔离样本库，SQLite完整性检查通过。
- 小红书该帖共12张图，识别前10张，剩余2张未识别；最终状态正确标记partial。另有1条候选未绑定高德地点，按正常数据拒绝列出。没有将这次处理宣称为无遗漏的完整成功。
- 初次接入发现适配器提前创建目录与MediaCrawler的exist_ok=False约束冲突，已修复并新增回归测试；复测目录交接正常。
- 实测输出在.local-data/xian/unified-smoke/run-20261112T174715780Z-d77fc552/。目录ID使用UTC以避免跨时区冲突，用户日期与采集基准按Asia/Shanghai计算。
- 正式data/events.db未写入，开发继续保留在独立分支。
