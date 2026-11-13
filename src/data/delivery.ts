import { DatabaseSync } from "node:sqlite";
import { assessFreshness } from "../collection/freshness.ts";
import type { Sidecar } from "../collection/releases.ts";
import type { EventRepository } from "./repository.ts";
import { hasCollectionMarker } from "./seed.ts";
import { createSqliteEventRepository } from "./sqlite.ts";

/**
 * 应用活动库的统一读端。普通库（npm run seed 的模拟库）原样走 SQLite
 * repository；采集交付库（带 _collection_metadata 标记，如 data/events.db）
 * 按库内 state 元数据逐条过 assessFreshness，与发布目录读端
 * createReleasedRepository 同口径：可见性经 SQL 函数在 WHERE 中判定、
 * 先于结果限额生效，过期、已取消或复核超期的记录不会出库。
 *
 * 交付库额外保持一个只读元数据连接：state 与 events 由写入侧在同一事务
 * 提交，每次 search 前复读 state——取消标记与新核验时间即时生效，不要求
 * 进程重启。按 ID 取已引用记录（getByIds）不做新鲜度过滤，口径同上。
 */

/** EventRepository 加读端来源标记，供启动探活区分空库口径（模拟库提示 seed，交付库不提示）。 */
export interface ReadableEventRepository extends EventRepository {
  /** true = 采集交付库（元数据新鲜度过滤生效）；false = 普通模拟库。 */
  readonly collectionDelivery: boolean;
}

function metaValue(db: DatabaseSync, key: string): unknown {
  const row = db.prepare("SELECT value FROM _collection_metadata WHERE key=?").get(key);
  return row ? JSON.parse(String(row.value)) : undefined;
}

/** 读 state 键并校验结构，与写入侧 readState 同口径；每次 search 前重读。 */
function readDeliveryState(db: DatabaseSync): Sidecar {
  const sidecar = metaValue(db, "state") as Sidecar | undefined;
  if (
    sidecar?.schema_version !== "xian-release/2" ||
    !sidecar.events ||
    typeof sidecar.events !== "object" ||
    !Array.isArray(sidecar.identities)
  ) {
    throw new Error("INVALID_COLLECTION_DATABASE_METADATA");
  }
  return sidecar;
}

/** events 表 id 集必须等于 state.events 键集（写入侧同事务保证）。 */
function assertInSync(db: DatabaseSync, sidecar: Sidecar): void {
  const ids = db.prepare("SELECT id FROM events ORDER BY id").all().map((row) => String(row.id));
  if (JSON.stringify(ids) !== JSON.stringify(Object.keys(sidecar.events).sort())) {
    throw new Error("COLLECTION_DATABASE_METADATA_OUT_OF_SYNC");
  }
}

/** 打开活动库读端；now 仅供测试注入固定时钟，缺省取真实当前时间。 */
export function createEventRepository(
  dbPath: string,
  options: { now?: () => string } = {},
): ReadableEventRepository {
  const meta = new DatabaseSync(dbPath, { readOnly: true });
  let metaOpen = true;
  const closeMeta = () => {
    if (metaOpen) {
      metaOpen = false;
      meta.close();
    }
  };
  try {
    if (!hasCollectionMarker(meta)) {
      closeMeta();
      return Object.assign(createSqliteEventRepository(dbPath), { collectionDelivery: false });
    }
    // state 与 events 由写入侧同事务提交；首读把两条 SELECT 放进一个读事务，
    // 避免读到跨提交的不一致组合。之后的 per-search 复读只有单条 SELECT，天然原子。
    meta.exec("BEGIN");
    let state: Sidecar;
    try {
      state = readDeliveryState(meta);
      if (typeof metaValue(meta, "database_id") !== "string") {
        throw new Error("INVALID_COLLECTION_DATABASE_METADATA");
      }
      assertInSync(meta, state);
      meta.exec("COMMIT");
    } catch (error) {
      try {
        meta.exec("ROLLBACK");
      } catch {
        // COMMIT 已成功或事务早已结束：连接随即关闭，无需再回滚。
      }
      throw error;
    }
    const now = options.now ?? (() => new Date().toISOString());
    const include = (id: string): boolean => {
      const row = state.events[id];
      return (
        !!row?.window && assessFreshness(row.window, row.freshness, now()).includeInDiscovery
      );
    };
    const inner = createSqliteEventRepository(dbPath, { readOnly: true, isAvailable: include });
    return {
      collectionDelivery: true,
      async search(input) {
        const current = (state = readDeliveryState(meta));
        const events = await inner.search(input);
        // SQL 函数按 state.window 判过一遍；这里再按记录实际窗口复核，口径与
        // createReleasedRepository 的 decision 一致，防两者脱节时误放行。
        return events.filter((event) => {
          const row = current.events[event.id];
          return (
            !!row &&
            assessFreshness(
              {
                start_at: event.startAt,
                end_at: event.endAt,
                record_type: event.recordType,
                schedule_json: event.schedule,
              },
              row.freshness,
              now(),
            ).includeInDiscovery
          );
        });
      },
      getByIds: (ids) => inner.getByIds(ids),
      close() {
        inner.close();
        closeMeta();
      },
    };
  } catch (error) {
    closeMeta();
    throw error;
  }
}
