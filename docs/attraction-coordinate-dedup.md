# 景点经纬度去重

规则：只对record_type=attraction的记录按高德GCJ-02坐标去重，默认两点地表距离不超过10米视为同一个景点。活动不参与坐标去重，同一场馆的不同演出、市集和展览继续分别保存。

用球面距离计算实际米数，不按经纬度小数位截断或四舍五入。阈值包含边界；设为0表示仅合并完全相同坐标。prepareCollection、processCollection和publishRelease的attractionDuplicateMeters参数可调整阈值，允许0至100米，正常运行均默认10米。调用方使用自定义阈值时，应在准备和发布两步传入相同值。无效或缺失坐标不参与合并。

同组优先保留时间信息明确、字段更完整的一条完整原始记录；完整度相同时优先来源更新较新的记录，再按ID稳定排序。保留其原有ID、字段和主来源，不将不同来源的字段拼接成一条未经核对的数据。被合并记录的ID、保留ID、实际距离以及两者来源链接单独保存。

批次准备时同步清理被合并记录的provenance、metadata和witness，保留合并审计。发布前再与旧快照中的景点比较，覆盖不同夜间批次间的重复。每个新候选只与最终保留的代表点比较，避免同一轮A距B很近、B距C很近，就将A与较远的C连锁合并。

合并属于去重，不归为数据不合格：processCollection返回deduplicated列表，prepareCollection结果中为prepared.attraction_duplicates，发布库provenance.json旁路元数据中保存attraction_duplicates。现有events表不增加字段。process-cached-activities.ts额外输出attraction-duplicates.json。

## 验证

- 新增7项测试覆盖近坐标、不同名称和POI、同地点活动不合并、距离边界、可配置阈值、无效坐标、连锁邻近、批次内与跨夜间发布、重复来源再次采集。
- TypeScript检查通过；全部533项Node测试通过。
- 对“西交创新港”原批次8条结果离线回放：7条相同校区坐标合并为1条，另1条不同坐标保留，最终2条。合并6条，距离均为0米，没有新增API请求。
- 另一条是前次已经识别出的西电未来信息港在建项目误收。坐标去重不解决主题相关性、景点适用性或定位精度问题，不将它称为合格游览地点。
- 输出在.local-data/xian/runs/chuangxingang-five-each-20261113/coordinate-dedup/，含events.json、merged-sources.json、summary.json、events.db。SQLite完整性检查通过，正式数据库未修改。

采用坐标作为判据意味着共用同一地图中心点的不同校园内部景点也可能被合并。这是本次约定的规则；目前不额外用名称或POI差异阻止合并。
