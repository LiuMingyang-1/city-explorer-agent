import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SOCIAL_PLATFORMS, ENABLED_SOCIAL_PLATFORMS, normalizeMediaCrawlerRow, importMediaCrawlerJsonl } from "../src/collection/mediacrawler.ts";
import type { SocialPlatform } from "../src/collection/mediacrawler.ts";

const fetched = "2026-11-12T02:00:00Z";
const published = "2026-11-11T02:00:00.000Z";
const seconds = Date.parse(published) / 1000;
const cases: [SocialPlatform, Record<string, unknown>, string][] = [
  ["xhs", { note_id: "abc123", desc: "西安展览公告", time: seconds * 1000 }, "https://www.xiaohongshu.com/explore/abc123"],
  ["dy", { aweme_id: "12345", desc: "西安市集预告", create_time: seconds }, "https://www.douyin.com/video/12345"],
  ["ks", { video_id: "abc123", desc: "西安演出预告", create_time: seconds * 1000 }, "https://www.kuaishou.com/short-video/abc123"],
  ["bili", { video_id: "12345", desc: "西安活动说明", create_time: seconds }, "https://www.bilibili.com/video/av12345"],
  ["wb", { note_id: "12345", content: "西安活动公告", create_time: seconds }, "https://m.weibo.cn/detail/12345"],
  ["tieba", { note_id: "12345", desc: "西安活动介绍", publish_time: "2026-11-11 10:00" }, "https://tieba.baidu.com/p/12345"],
  ["zhihu", { content_id: "12345", content_type: "answer", question_id: "67890", content_text: "西安近期活动", created_time: seconds }, "https://www.zhihu.com/question/67890/answer/12345"],
];

for (const [platform, row, url] of cases) test(`MediaCrawler ${platform} export maps IDs, canonical URL and publication units`, () => {
  const before = structuredClone(row);
  const doc = normalizeMediaCrawlerRow(platform, row, fetched);
  assert.equal(doc.platform, platform); assert.equal(doc.url, url);
  assert.equal(doc.published_at, published); assert.equal(doc.fetched_at, fetched);
  assert.equal(doc.content_sha256, createHash("sha256").update(doc.text).digest("hex"));
  assert.equal(doc.updated_at, null);
  assert.deepEqual(row, before);
});

test("export modification timestamp is never substituted for publication or verification", () => {
  const doc = normalizeMediaCrawlerRow("xhs", { note_id: "abc", desc: "历史活动", last_modify_ts: seconds * 1000 }, fetched);
  assert.equal(doc.published_at, null); assert.equal(doc.updated_at, null);
  assert.equal("verified_at" in doc, false);
  const tieba = normalizeMediaCrawlerRow("tieba", { note_id: "123", desc: "活动", publish_time: "11-11 10:00" }, fetched);
  assert.equal(tieba.published_at, null);
});

test("canonical URLs exclude access tokens and exports exclude cookies and personal handles", () => {
  const result = normalizeMediaCrawlerRow("xhs", {
    note_id: "abc", desc: "活动", note_url: "https://www.xiaohongshu.com/explore/abc?xsec_token=sensitive",
    xsec_token: "sensitive", cookies: "sensitive", nickname: "private-handle", creator_hash: "hashed-creator",
    image_list: "https://img.museum.cn/one.jpg,https://img.museum.cn/two.jpg",
  }, fetched);
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
  assert.equal(JSON.stringify(result).includes("private-handle"), false);
  assert.equal(result.creator_hash, "hashed-creator"); assert.equal(result.image_urls.length, 2);
});

test("truncated exports and video descriptions carry explicit content scope", () => {
  for (const platform of ["ks", "bili"] as const) assert.equal(normalizeMediaCrawlerRow(platform, { video_id: "123", desc: "可能截断的简介" }, fetched).content_scope, "possibly_truncated");
  assert.equal(normalizeMediaCrawlerRow("dy", { aweme_id: "123", desc: "仅视频说明" }, fetched).content_scope, "caption_only");
});

test("JSONL imports isolate bad rows and comments, deduplicate unchanged content and retain revisions", () => {
  const row = { note_id: "abc", desc: "活动第一版" };
  const input = [JSON.stringify(row), JSON.stringify(row), "{broken", JSON.stringify({ ...row, desc: "活动第二版" }), JSON.stringify({ ...row, comment_id: "c" })].join("\r\n");
  const result = importMediaCrawlerJsonl("xhs", "\uFEFF" + input, fetched);
  assert.equal(result.documents.length, 2); assert.equal(result.duplicates, 1);
  assert.deepEqual(result.rejected, [{ line: 3, code: "INVALID_JSON_LINE" }, { line: 5, code: "COMMENTS_NOT_SUPPORTED" }]);
});

test("Zhihu excerpts, missing content and unsafe numeric IDs never become valid documents", () => {
  assert.throws(() => normalizeMediaCrawlerRow("zhihu", { content_id: "123", content_type: "article", desc: "只有摘要" }, fetched), /MISSING_EXPORTED_TEXT/);
  assert.throws(() => normalizeMediaCrawlerRow("wb", { note_id: Number.MAX_SAFE_INTEGER + 1, content: "活动" }, fetched), /UNSAFE_SOURCE_ID/);
  assert.throws(() => normalizeMediaCrawlerRow("xhs", { note_id: "../bad", desc: "活动" }, fetched), /INVALID_SOURCE_ID/);
  assert.equal(SOCIAL_PLATFORMS.length, 7);
  assert.deepEqual([...ENABLED_SOCIAL_PLATFORMS], ["xhs"]);
});
