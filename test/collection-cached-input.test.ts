import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedXhsDocuments } from "../src/collection/cached-input.ts";
import { normalizeMediaCrawlerRow } from "../src/collection/mediacrawler.ts";

test("cached input only enables XHS and cannot import a publisher authority claim", () => {
  const row = normalizeMediaCrawlerRow("xhs", { note_id: "offline", desc: "西安活动说明" }, "2026-11-12T03:00:00Z");
  const result = cachedXhsDocuments({ documents: [{ ...row, authority: "publisher" }] });
  assert.equal(result[0].authority, "unverified");
  assert.throws(() => cachedXhsDocuments({ documents: [{ ...row, platform: "wb" }] }), /DISABLED_SOURCE/);
  assert.throws(() => cachedXhsDocuments({ documents: [{ ...row, text: "篡改的正文" }] }), /INVALID_OR_DISABLED/);
  assert.throws(() => cachedXhsDocuments({ documents: [{ ...row, url: row.url + "?key=private" }] }), /INVALID_OR_DISABLED/);
});
