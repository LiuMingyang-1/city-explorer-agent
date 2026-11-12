import { textHash } from "./preparation.ts";
import { publicUrl } from "./validate.ts";
import type { ExtractionDocument } from "./extraction.ts";

/** Cache metadata is not a source-authority assertion. All XHS imports start unverified. */
export function cachedXhsDocuments(value: unknown): ExtractionDocument[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as any).documents)) throw new Error("INVALID_CACHED_EXPORT");
  return (value as any).documents.map((row: any) => {
    if (row?.platform !== "xhs" || row.provider !== "mediacrawler" || typeof row.text !== "string" || !row.text.trim()
      || typeof row.url !== "string" || !publicUrl(row.url) || new URL(row.url).hostname !== "www.xiaohongshu.com"
      || row.content_sha256 !== textHash(row.text) || typeof row.fetched_at !== "string"
      || !(row.published_at === null || typeof row.published_at === "string") || !Array.isArray(row.image_urls)
      || !["exported_text", "caption_only", "possibly_truncated"].includes(row.content_scope)) throw new Error("INVALID_OR_DISABLED_SOURCE_DOCUMENT");
    return { url: row.url, text: row.text, published_at: row.published_at, updated_at: typeof row.updated_at === "string" ? row.updated_at : null, fetched_at: row.fetched_at,
      authority: "unverified", content_scope: row.content_scope, image_urls: row.image_urls.filter((url: unknown): url is string => typeof url === "string" && publicUrl(url)) };
  });
}
