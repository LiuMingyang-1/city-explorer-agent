import { createHash } from "node:crypto";
import { publicUrl } from "./validate.ts";
import { isCalendarDate } from "../itinerary/constraints.ts";

/** Export mappings verified against this upstream revision, not floating main. */
export const MEDIACRAWLER_COMMIT = "306ab4ca26c0e44fb87ede0e40e98748752815a6";
export const SOCIAL_PLATFORMS = ["xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu"] as const;
/** Current user scope: XHS only. Historical platform export parsing stays dormant. */
export const ENABLED_SOCIAL_PLATFORMS = ["xhs"] as const;
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];

export interface CollectedDocument {
  provider: "mediacrawler";
  platform: SocialPlatform;
  source_id: string;
  url: string;
  title: string;
  text: string;
  image_urls: string[];
  published_at: string | null;
  updated_at: string | null;
  fetched_at: string;
  content_sha256: string;
  creator_hash: string | null;
  content_scope: "exported_text" | "caption_only" | "possibly_truncated";
}

type Row = Record<string, unknown>;
const text = (row: Row, key: string): string => typeof row[key] === "string" ? row[key].trim() : "";
const id = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("UNSAFE_SOURCE_ID");
  const result = typeof value === "number" ? String(value) : text(row, key);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) throw new Error("INVALID_SOURCE_ID");
  return result;
};

/** The unit is determined by upstream field semantics, never guessed from magnitude. */
function timestamp(value: unknown, unit: "seconds" | "milliseconds"): string | null {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const numeric = Number(value);
  const milliseconds = unit === "seconds" ? numeric * 1000 : numeric;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > Date.UTC(2100, 0, 1)) return null;
  return new Date(milliseconds).toISOString();
}

function tiebaTimestamp(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value) || !isCalendarDate(value.slice(0, 10))) return null;
  return new Date(value.replace(" ", "T") + (value.length === 16 ? ":00" : "") + "+08:00").toISOString();
}

export function normalizeMediaCrawlerRow(platform: SocialPlatform, value: unknown, fetchedAt: string): CollectedDocument {
  if (!SOCIAL_PLATFORMS.includes(platform)) throw new Error("UNSUPPORTED_PLATFORM");
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(fetchedAt) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("INVALID_FETCH_TIME");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_EXPORT_ROW");
  const row = value as Row;
  if ("comment_id" in row) throw new Error("COMMENTS_NOT_SUPPORTED");
  let sourceId: string, url: string, body: string, published: string | null;
  let updated: string | null = null;
  let scope: CollectedDocument["content_scope"] = "exported_text";
  switch (platform) {
    case "xhs":
      sourceId = id(row, "note_id"); url = `https://www.xiaohongshu.com/explore/${sourceId}`;
      body = text(row, "desc"); published = timestamp(row.time, "milliseconds");
      updated = timestamp(row.last_update_time, "milliseconds");
      scope = row.type === "video" ? "caption_only" : "exported_text"; break;
    case "dy":
      sourceId = id(row, "aweme_id"); url = `https://www.douyin.com/video/${sourceId}`;
      body = text(row, "desc"); published = timestamp(row.create_time, "seconds"); scope = "caption_only"; break;
    case "ks":
      sourceId = id(row, "video_id"); url = `https://www.kuaishou.com/short-video/${sourceId}`;
      body = text(row, "desc"); published = timestamp(row.create_time, "milliseconds"); scope = "possibly_truncated"; break;
    case "bili":
      sourceId = id(row, "video_id"); url = `https://www.bilibili.com/video/${/^\d+$/.test(sourceId) ? "av" : ""}${sourceId}`;
      body = text(row, "desc"); published = timestamp(row.create_time, "seconds"); scope = "possibly_truncated"; break;
    case "wb":
      sourceId = id(row, "note_id"); url = `https://m.weibo.cn/detail/${sourceId}`;
      body = text(row, "content"); published = timestamp(row.create_time, "seconds"); break;
    case "tieba":
      sourceId = id(row, "note_id"); url = `https://tieba.baidu.com/p/${sourceId}`;
      body = text(row, "desc"); published = tiebaTimestamp(text(row, "publish_time")); break;
    case "zhihu": {
      const contentId = id(row, "content_id"), kind = text(row, "content_type");
      sourceId = `${kind}:${contentId}`;
      if (kind === "answer") url = `https://www.zhihu.com/question/${id(row, "question_id")}/answer/${contentId}`;
      else if (kind === "article") url = `https://zhuanlan.zhihu.com/p/${contentId}`;
      else throw new Error("UNSUPPORTED_ZHIHU_CONTENT_TYPE");
      body = text(row, "content_text"); // desc may only be an excerpt: never substitute it.
      published = timestamp(row.created_time, "seconds"); updated = timestamp(row.updated_time, "seconds"); break;
    }
  }
  const title = text(row, "title") || (platform === "wb" ? body.slice(0, 80) : "");
  if (!body) throw new Error("MISSING_EXPORTED_TEXT");
  if (body.length > 200_000) throw new Error("EXPORT_TEXT_TOO_LARGE");
  const combined = [title, body].filter(Boolean).join("\n");
  const images = new Set<string>();
  for (const key of ["image_list", "note_download_url", "cover_url", "video_cover_url"]) {
    // Upstream explicitly serializes these fields as comma-separated URLs.
    for (const image of text(row, key).split(",").filter(Boolean)) if (publicUrl(image)) images.add(image);
  }
  return {
    provider: "mediacrawler", platform, source_id: sourceId, url, title, text: combined,
    image_urls: [...images], published_at: published, updated_at: updated, fetched_at: fetchedAt,
    content_sha256: createHash("sha256").update(combined).digest("hex"),
    creator_hash: text(row, "creator_hash") || null, content_scope: scope,
  };
}

/** Parse exports only, never launch browsers or interpret successful import as source verification. */
export function importMediaCrawlerJsonl(platform: SocialPlatform, input: string, fetchedAt: string) {
  if (Buffer.byteLength(input, "utf8") > 10 * 1024 * 1024) throw new Error("EXPORT_FILE_TOO_LARGE");
  const documents: CollectedDocument[] = [], rejected: { line: number; code: string }[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const [index, line] of input.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      let row: unknown;
      try { row = JSON.parse(line); } catch { throw new Error("INVALID_JSON_LINE"); }
      const document = normalizeMediaCrawlerRow(platform, row, fetchedAt);
      const key = JSON.stringify([document.source_id, document.content_sha256]);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key); documents.push(document);
    } catch (error) {
      // Error codes only: never propagate raw platform content, cookies or signed URLs.
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "INVALID_EXPORT_ROW";
      rejected.push({ line: index + 1, code });
    }
  }
  return { documents, rejected, duplicates };
}
