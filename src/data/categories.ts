/** Shared by SQLite, collection schemas and extraction prompts. */
export const CATEGORIES = [
  "展览", "音乐现场", "演出", "市集", "节庆活动", "书店活动",
  "讲座", "工作坊", "放映", "景点参观", "户外活动", "体育赛事",
] as const;

export type EventCategory = typeof CATEGORIES[number];

export const DEFAULT_SCENIC_LEVEL = "暂无评级" as const;
export const SCENIC_LEVELS = ["1A", "2A", "3A", "4A", "5A", DEFAULT_SCENIC_LEVEL] as const;
/** Read old extractor/cache output without keeping the retired label in new rows. */
export function normalizeScenicLevel(value:unknown):unknown {
  return value==null||value===""||value==="等级未知"?DEFAULT_SCENIC_LEVEL:value;
}
export const COLLECTION_CATEGORIES = [...CATEGORIES, ...SCENIC_LEVELS] as const;
export type CollectionCategory = typeof COLLECTION_CATEGORIES[number];
