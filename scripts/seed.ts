import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasCollectionMarker, SEED_DAYS, seedDatabase } from "../src/data/seed.ts";

/**
 * 种子入口：`node scripts/seed.ts [--date=YYYY-MM-DD] [--force]`。
 * 不需要模型 API key；库路径取 EXPLORER_DB_PATH，缺省 data/events.db。
 * --date 指定生成基准日（默认今天），固定该参数可得到可重复的相同数据。
 * 重复执行会先清空 events 表再写入，条数不会累积。
 * 目标库带 _collection_metadata 表（采集交付库标记）时拒绝执行，
 * 防止误清真实数据；确认要重置须显式加 --force。
 */

const dateArg = process.argv.find((a) => a.startsWith("--date="))?.slice("--date=".length);
const force = process.argv.includes("--force");
const dbPath = resolve(process.env.EXPLORER_DB_PATH?.trim() || "data/events.db");

if (!force && existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let marked = false;
  try {
    marked = hasCollectionMarker(db);
  } finally {
    db.close();
  }
  if (marked) {
    console.error(
      `拒绝执行：${dbPath} 是采集交付数据库（含 _collection_metadata 表），` +
        "seed 会先清空 events 再写入 mock，将销毁真实采集数据。确认要重置请显式加 --force。",
    );
    process.exit(1);
  }
}

const count = seedDatabase(dbPath, dateArg);
console.log(`Seeded ${count} mock events (${SEED_DAYS} days) into ${dbPath}`);
