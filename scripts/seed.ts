import { resolve } from "node:path";
import { SEED_DAYS, seedDatabase } from "../src/data/seed.ts";

/**
 * 种子入口：`node scripts/seed.ts [--date=YYYY-MM-DD]`。
 * 不需要模型 API key；库路径取 EXPLORER_DB_PATH，缺省 data/events.db。
 * --date 指定生成基准日（默认今天），固定该参数可得到可重复的相同数据。
 * 重复执行会先清空 events 表再写入，条数不会累积。
 */

const dateArg = process.argv.find((a) => a.startsWith("--date="))?.slice("--date=".length);
const dbPath = resolve(process.env.EXPLORER_DB_PATH?.trim() || "data/events.db");

const count = seedDatabase(dbPath, dateArg);
console.log(`Seeded ${count} mock events (${SEED_DAYS} days) into ${dbPath}`);
