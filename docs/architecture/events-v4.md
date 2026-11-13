# 活动与景点共表 v4：实现与验收

> 2026-11-13更新：新增时间备注字段及OCR、高德模型工具流程，当前规范见[时间备注与模型高德工具采集](collection-time-notes-and-tools.md)，实际提示词以src/collection/extraction.ts为准。

日期：2026-11-12；独立分支feat/xian-nightly-events。未合并主分支、未推送、未修改正式数据库。

## 范围

已更新实际DeepSeek提示词、模型输出契约、数据库迁移、采集组装/发布、主Agent搜索返回和行程时间校验。没有增加tags、参与方式、预约字段。新数据坐标直接使用高德GCJ-02，不调用WGS-84转换函数。旧数值转换工具仅保留作历史工具，不在新采集链路执行。

## 表与兼容策略

27个业务字段：id、record_type、title、description、category、venue_name、address、city、amap_poi_id、latitude、longitude、valid_from、valid_to、schedule_json、suggested_duration_minutes、budget_min、budget_max、currency、budget_note、guide_url、thumbnail_url、image_urls、status、source_published_at、source_updated_at、fetched_at、updated_at。

当前物理表额外暂留start_at/end_at两列，共29列，用于兼容既有种子、旧接口和旧测试数据。它们不是新增业务概念，新模型不需要输出它们，新记录主要使用日期和规则，导出的业务JSON可排除这两列。新建表定义见[DDL](events-unified-v4.sql)。后续移除兼容列需要与主分支调用方联调，不在本轮直接删列。

- record_type=activity时category使用原活动分类；attraction使用1A至5A或暂无评级，不用用户评分换算等级。
- guide_url直接复制document.url，保留来源；source_published_at、source_updated_at、fetched_at和本地updated_at分别保存，模型不生成来源网址或坐标。
- metadata与原始资料仍在私有来源记录中保留，建议停留估计值可追溯，不宣称为官方建议。
- SQL支持景点与活动不同分类的约束。迁移保留记录、额外列、索引、触发器和外键；重复执行不重复加列，失败回滚。

## 时间规则

schedule_json支持weekly、dates、always_open、unknown；时区Asia/Shanghai，星期1为周一、7为周日。窗口可含last_entry和end_day_offset=1；exceptions支持明确日期闭馆/变更。未知钟点用NULL，不补午夜。

冬夏季规则可在weekly项上保存valid_from/valid_to；不会在生效前或到期后套用旧季节时刻。规则之外为未知，不伪装成景点永久关闭。节假日除外但没有具体日历时只保留备注，不猜节假日开放时段。长期景点没有结束日期不因7天保留规则被删除，景点核验新鲜度当前30天，活动仍为36小时。

14天是默认任务/查询跨度，不再是入库拒绝条件。一个未来月份的真实活动可以先保存。

## 主Agent与接口

search_events仍是唯一搜索工具，可选recordType区分activity/attraction。日期查询先按有效日期及开放规则过滤，再做条数截断；附近检索使用GCJ-02参考点。

新记录返回recordType、validFrom/validTo、schedule、coordinateSystem、availableWindows和availability。存在多个窗口时不会把午休合成一个长窗口；兼容startAt/endAt仅单窗口时填值。无规则时availability=unknown，允许发现，不允许自动排程。

getByIds返回基础规则，行程校验按行程日期重新解析，要求整个到访落在同一窗口且不晚于停止入场时间。旧演示记录没有新规则时仍使用旧窗口。Web视图增加相应可选字段供前端消费。

本轮没有替换前端WGS-84底图、浏览器定位或静态places.js。对接真实地图前必须使前端与GCJ-02契约一致；不能把旧WGS-84数据改个标签混进新库。已存旧坐标不自动重算，新采集或恢复原始高德坐标后再切换数据。

## 提取行为

提示词原文见[新版提示词](collection-extraction-prompt-v4.md)。识别景点与活动；景点A级未知则暂无评级；游客过去参观或历史接待量不等于景点停业；评论中的取消传言不作为硬冲突。正文真实日期冲突仍保留。缺失日期、费用、图片等允许为空，不要求逐字引用。

新数据契约xian-events/4、实验发布契约xian-release/2，旧WGS-84实验快照不会作为新GCJ-02批次直接加载。正式库未触碰。当前API错误分类/自动重试、跨来源语义去重、状态同步等既有未完成范围没有因此宣称解决。

## 测试

- 类型检查通过。
- Node全量513项通过，Python采集适配器5项通过。
- 新增完整链路测试：模型结构->GCJ原始点->独立SQLite->日期查询->行程校验，覆盖两种记录类型、周一闭馆、午休、日期例外、跨午夜、停止入场、季节规则和未知时间。
- 测试了旧v3 CHECK迁移、保留自定义字段/索引/外键、重复迁移，以及准备与发布时间不同时的记录一致性。

## 真实小样本

共使用3份已有真实正文，分轮实际调用模型4次：先2份资料，再对博物馆季节规则补测1次、对明确写出周期开放的展览补测1次。没有新平台抓取。

最终重用这些响应回放后，4条记录（1个景点、3个活动）入独立测试库；另1条谱光者展览也通过独立实测与发布，共5条样本。季节补测曾有两条因名称带第六/第七展厅而定位失败，修复内部展厅清理后回放通过，未靠人工填坐标。

最终4条批次回放与发布1.474秒、5次高德HTTP请求、没有新模型请求。它不是包含模型与平台搜索的全流程耗时。谱光者在2026-11-14返回10:00—17:30，11月16日周一没有可排程结果；博物馆冬季规则在11月15日前不会被套用。

字段与SQLite读回逐项一致，integrity_check=ok，输出坐标逐值等于高德原始点。真实样本、密钥及API响应均留在Git忽略目录：

- `.local-data/xian/runs/unified-final-20261112/all-live-samples-business-27.json`：5条业务样本。
- 同目录preview.md、dated-search.json、exhibition-dated-search.json、summary.json。
- `.local-data/xian/unified-final-acceptance-20261112/releases/final/events.db`：4条独立样本库。

日期、规则和费用仍以来源为准；测试通过不等于已对每条信息做了独立真实性证明。默认应用尚未切换到这些实验样本库，没有部署夜间任务。
