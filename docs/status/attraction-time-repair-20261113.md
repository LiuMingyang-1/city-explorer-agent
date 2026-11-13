# 景点时间与现有资料修复批次

已写入唯一数据库data/events.db。58条高德时间结果重校验，4条季节端点错误检查未来14天可用性。不存在余额不足错误后继续静默丢弃的情况；所有API返回仍逐条校验。

API请求70次（含重试），单次P50 1735毫秒、P95 3370毫秒。

修复前：{"records":265,"time_statuses":{"complete":165,"partial":26,"conflicting":4,"unknown":50},"budget_missing":53}。

修复后：{"records":265,"time_statuses":{"complete":208,"partial":32,"conflicting":4,"unknown":1},"budget_missing":53}。

活动原行保持不变：true。高德原始抓取时间保持不变，另存normalized_at，不把重新规范当成重新核验全部事实。

## 现有资料纠正

- 曲江寒窑遗址公园：移除以优惠票25元充当成人预算上限的错误
- 红色葛牌景区（葛牌古镇）：区分古镇公共区域和馆内时间，不把馆内信息缺失扩大为整个古镇未知
- 西安常宁宫休闲山庄：移除住宿套餐误作参观费用的数值，保留原套餐说明
- 王府井奥莱·临潼小镇（临潼奥特莱斯景区）：原有明确免费说明落实为基础入场0元
- 易俗社文化旅游景区：原有明确免费说明落实为基础入场0元

## 逐条变更

|景点|原时间状态|新时间状态|修改字段|
|---|---|---|---|
|华清宫（陕西华清宫文化旅游景区）|partial|complete|time_note、time_status、schedule_json、updated_at|
|翠华山景区（陕西翠华山国家地质公园）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|曲江海洋极地公园|partial|partial|time_note、schedule_json、updated_at|
|西安关中民俗艺术博物院|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安秦岭野生动物园|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安博物院（小雁塔）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安浐灞国家湿地公园|unknown|complete|time_note、time_status、schedule_json、updated_at|
|朱雀国家森林公园|partial|partial|time_note、schedule_json、updated_at|
|陕西自然博物馆|unknown|partial|time_note、time_status、schedule_json、updated_at|
|白鹿原影视城|partial|partial|time_note、schedule_json、updated_at|
|白鹿原·白鹿仓景区|unknown|partial|time_note、time_status、schedule_json、updated_at|
|秦岭国家植物园|unknown|complete|time_note、time_status、schedule_json、updated_at|
|蓝田猿人遗址（蓝田猿人遗址博物馆）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安市青龙寺遗址景区|unknown|complete|time_note、time_status、schedule_json、updated_at|
|王府井奥莱·临潼小镇（临潼奥特莱斯景区）|unknown|complete|time_note、time_status、schedule_json、updated_at、budget_min、budget_max、budget_note|
|吉利汽车西安制造基地旅游景区|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安碑林博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|仙游寺博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安大唐西市博物馆|unknown|partial|time_note、time_status、schedule_json、updated_at|
|陕西师范大学博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西北大学博物馆|unknown|partial|time_note、time_status、schedule_json、updated_at|
|长安大学地质博物馆|unknown|partial|time_note、time_status、schedule_json、updated_at|
|西安建筑科技大学贾平凹文学艺术馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安市秦阿房宫遗址博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|陕西汉唐石刻博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安美都艺术博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|陕西唐三彩艺术博物馆|partial|complete|time_note、time_status、schedule_json、updated_at|
|西安曲江富陶国际陶艺博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|大明宫遗址博物馆|complete|complete|time_note、schedule_json、updated_at|
|大明宫国家遗址公园丹凤门遗址博物馆|complete|complete|time_note、schedule_json、updated_at|
|临潼区鸿门宴博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|空军军医大学第三附属医院国际口腔医学博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安市大唐青铜镜博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安交通大学博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安市非物质文化遗产博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安市水墨长安艺术博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安市起良蔡侯纸博物馆|complete|complete|time_note、schedule_json、updated_at|
|西安市明清皮影艺术博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安市羊文化博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|陕西科技大学中国轻工业博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安植物园（新区）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安城墙|unknown|partial|time_note、time_status、schedule_json、updated_at|
|大雁塔（大慈恩寺内）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|骊山国家森林公园|unknown|complete|time_note、time_status、schedule_json、updated_at|
|楼观台国家森林公园|partial|complete|time_note、time_status、schedule_json、updated_at|
|阿房宫遗址公园|complete|complete|time_note、schedule_json、updated_at|
|杨虎城将军止园别墅（西安事变纪念馆旧址）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|长安十二时辰主题街区|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安万象城·生命之树|unknown|complete|time_note、time_status、schedule_json、updated_at|
|丝路欢乐世界|unknown|complete|time_note、time_status、schedule_json、updated_at|
|大明宫国家遗址公园|unknown|partial|time_note、time_status、schedule_json、updated_at|
|秦始皇帝陵博物院（秦始皇兵马俑博物馆·丽山园）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安高家大院（高岳崧故居）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|陕西体育博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|交大西迁博物馆|unknown|complete|time_note、time_status、schedule_json、updated_at|
|中国唐苑|unknown|complete|time_note、time_status、schedule_json、updated_at|
|大唐芙蓉园|unknown|partial|time_note、time_status、schedule_json、updated_at|
|小雁塔（荐福寺塔）|unknown|partial|time_note、time_status、schedule_json、updated_at|
|曲江寒窑遗址公园|complete|complete|updated_at、budget_min、budget_max、budget_note|
|红色葛牌景区（葛牌古镇）|unknown|complete|time_note、time_status、schedule_json、updated_at|
|西安常宁宫休闲山庄|complete|complete|updated_at、budget_min、budget_max、budget_note|
|易俗社文化旅游景区|complete|complete|updated_at、budget_min、budget_max、budget_note|

本批未处理的地点、图片、门票补查等问题见更新后的黄金数据分类清单，不以本次时间处理成功宣称全部数据达标。
