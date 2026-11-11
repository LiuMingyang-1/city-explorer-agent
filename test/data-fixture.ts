import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";

/** data*.test.ts 共用的种子库 fixture；不是测试文件（无 .test 后缀）。 */

export const BASE = "2026-11-11";
export const LAST_DAY = "2026-11-17"; // BASE + SEED_DAYS - 1

export function seededRepo(t: TestContext, baseDate = BASE) {
  const dir = mkdtempSync(join(tmpdir(), "explorer-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  const inserted = seedDatabase(dbPath, baseDate);
  const repo = createSqliteEventRepository(dbPath);
  t.after(() => repo.close());
  return { repo, inserted };
}

export const dayOf = (e: { startAt: string }) => e.startAt.slice(0, 10);
