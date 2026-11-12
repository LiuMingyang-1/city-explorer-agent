import { test } from "node:test";
import assert from "node:assert/strict";
import { articleText, trustedPublisher, isPublicIPv4, createPrimaryResolver } from "../src/collection/primary-source.ts";
import { extractionFixture } from "./collection-downstream-fixture.ts";

test("primary-source policy rejects social posts, forged host suffixes, private targets and key-bearing URLs", () => {
  assert.equal(trustedPublisher("https://wlj.xa.gov.cn/notice"), true);
  assert.equal(trustedPublisher("https://www.sxhm.com/notice"), true);
  for (const url of ["https://www.xiaohongshu.com/explore/id", "https://sxhm.com.evil.cn/", "http://wlj.xa.gov.cn/", "https://wlj.xa.gov.cn:8443/", "https://127.0.0.1/", "https://wlj.xa.gov.cn/?key=private"]) assert.equal(trustedPublisher(url), false, url);
  for (const ip of ["0.0.0.0", "10.1.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.1.1", "198.18.0.1", "203.0.113.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4("8.8.8.8"), true);
});

test("HTML conversion removes executable/hidden script blocks and preserves article text and entities", () => {
  const html = '<script>secret()</script><style>.x{}</style><!-- old date --><h1>展讯</h1><p>西安&nbsp;展览 &amp; 文化 &#x5c55;</p>';
  const text = articleText(html);
  assert(!text.includes("secret")); assert(!text.includes("old date")); assert(!text.includes(".x"));
  assert(text.includes("西安 展览 & 文化 展"));
});

test("DeepSeek finds sources but direct publisher text supplies the actual evidence", async () => {
  const { facts, document, asOf } = extractionFixture(); let fetches = 0;
  const resolve = createPrimaryResolver({ deepseekKey: "offline-key", searchLimit: 1, record: () => {}, asOf: () => asOf,
    fetch: async () => Response.json({ results: [{ url: "https://www.xiaohongshu.com/explore/id" }, { url: "https://wlj.xa.gov.cn/notice", content: "搜索摘要不能当正文" }] }),
    fetchDocument: async url => { fetches++; return { url, text: document.text }; },
  });
  const primary = await resolve(facts);
  assert.equal(fetches, 1); assert.equal(primary?.text, document.text); assert.equal(primary?.authority, "publisher");
});

test("missing article access, offsite redirects and unmatched activities never gain publisher status", async () => {
  const { facts, asOf } = extractionFixture();
  for (const doc of [null, { url: "https://evil.cn/", text: facts.title + facts.venue_name }, { url: "https://wlj.xa.gov.cn/notice", text: "另一个活动" }]) {
    const resolve = createPrimaryResolver({ deepseekKey: "offline-key", record: () => {}, asOf: () => asOf,
      fetch: async () => Response.json({ results: [{ url: "https://wlj.xa.gov.cn/notice", content: facts.title + facts.venue_name }] }),
      fetchDocument: async () => { if (!doc) throw new Error("no article access"); return doc; },
    });
    assert.equal(await resolve(facts), null);
  }
});

test("a corroboration round makes at most two publisher fetch attempts", async () => {
  const { facts, asOf } = extractionFixture(); let calls = 0;
  const resolve = createPrimaryResolver({ deepseekKey: "offline-key", record: () => {}, asOf: () => asOf,
    fetch: async () => Response.json({ results: [1, 2, 3, 4].map(i => ({ url: `https://wlj.xa.gov.cn/notice/${i}` })) }),
    fetchDocument: async () => { calls++; throw new Error("unavailable"); },
  });
  assert.equal(await resolve(facts), null); assert.equal(calls, 2);
});
