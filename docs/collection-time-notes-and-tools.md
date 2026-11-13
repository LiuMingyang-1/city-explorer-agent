# 时间备注与模型高德工具采集

本次调整在 `feat/xian-nightly-events` 分支实施，不合并主分支。

景点新增默认10米的坐标去重，批次内及跨夜间发布均执行；活动不参与。具体阈值、保留策略及来源审计见[景点经纬度去重](attraction-coordinate-dedup.md)。

2026-11-13完成本轮Demo结构设计收尾验收，结果和已知限制见[最终小样本验收](collection-final-acceptance.md)。后续优先修正数据质量，不继续扩展当前表结构。

分析模型现可用同一个DeepSeek Key补查景点A级，查不到回退“等级未知”，不新增表字段，见[景点等级搜索工具](scenic-level-search-tool.md)。

## 表字段

在现有 events 表新增两列，其他字段保留，包括临时兼容的 start_at/end_at。共 29 个业务字段，物理表含兼容字段共 31 列。

| 字段 | 定义 | 用途 |
| --- | --- | --- |
| time_note | TEXT DEFAULT NULL | 保存时间原文、未能结构化的内容、缺失和冲突说明 |
| time_status | TEXT NOT NULL DEFAULT 'unknown' | complete、partial、unknown、conflicting |

迁移通过现有 ensureEventsSchema 幂等加列，不清表，不删除旧数据。旧记录默认 unknown，不自动宣称其时间经过新流程确认。

valid_from、valid_to、schedule_json 均可为空。结构化时间合法则保留；格式错误、跨多天连续窗口等无法使用的时间字段转成 time_note，字段清空。冲突时清空有冲突的具体时段，不任意选择某套规则。time_note 是信息说明，不可被当作已经确认的机器排程窗口。

complete 表示可用于计算时间窗口；partial 表示只有部分时间；unknown 表示暂无可靠时间；conflicting 表示待解决冲突。status 仍表示对象本身是否有效，二者互不替代。

明确全部日期场次已过期、已取消或已暂停的活动不作为当前可用数据保留。缺少结束日期、来源旧、时间格式不能解析，不再单独触发整条拒绝。夜间复核时效仍保留，不能用旧抓取结果冒充刚复核。

景点没有必须结束的展期。音乐喷泉、长期游览设施归 attraction；某届喷泉节、限期灯光秀归 activity。A级等级仅根据来源明示填写，不用地图用户评分代替。

## 数据处理

1. MediaCrawler 导出帖子正文、图片地址和发布时间，网页通过 DeepSeek 搜索返回文本。
2. 小红书图片使用本地 RapidOCR 识别，保留图片编号、识别错误及耗时。每篇最多 10 张；超出数量或识别失败必须记录。OCR 文本是可能含错字的来源资料，不是指令。
3. 正文与 OCR 文本合并交给 DeepSeek 分析模型，最多提取 3 个对象。
4. 分析模型可以调用 amap_search，在西安市范围搜索地点，也可以修改关键词再次搜索。返回正式名称、地址、地点 ID 与原始 GCJ-02 坐标。由模型理解场馆简称、商场内部区域及分店身份，选择匹配地点。
5. 模型返回结构化数据，包含所选地点 ID 和坐标。程序在本次文档的工具结果登记表中核对三者一致，只采用高德地址和坐标。来源网址仍是原帖子或网页。
6. 无法识别对象、没有确认地点、坐标与工具不一致、非西安、分类或金额等必要字段不合法时拒绝。时间字段能降级则降级，保留备注。
7. 通过项写入隔离发布库，并逐字段读回及执行 SQLite integrity_check。

地图工具固定高德接口与西安城市限制，默认最多 6 次工具调用、5 轮模型响应；HTTP 另有批次预算。请求串行限速，10021 限流最多重试一次。模型没有文件读取、任意联网或数据库写入工具。

正文和 OCR 最多约 30000 字符；OCR 每图片最大下载 12MB，仅请求小红书 CDN，不转发登录 Cookie，不上传图片到新服务。OCR 本地 CPU 运行，不增加付费 API。

## 使用

在现有隔离 Python 环境安装 `scripts/requirements-ocr.txt`。保留本地 `.env` 中 DEEPSEEK_API_KEY、EXPLORER_COLLECTION_MODEL 和 AMAP_WEB_KEY，密钥不写入数据或提交。

已有 `scripts/process-cached-activities.ts --live` 已切换为正文＋OCR＋模型地图工具。默认不带 --live 时仍只检查输入，不访问付费 API。未确认的时间保留在库中供检索和阅读备注，自动规划不能把它当作全天开放。

`scripts/test-collection-sample.ts <小红书规范导出JSON> <新建的.local-data结果目录>` 执行 5 篇小红书＋5 份网页的真实小样本验收，包含真实 API 调用。结果目录必须新建，原始响应、OCR、候选、样本库均保留在 Git 忽略目录，正式数据库只做前后哈希比较。
