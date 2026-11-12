import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeRequest, assertResponse } from "../src/search/contract.ts";
const cases = JSON.parse(readFileSync(new URL("../docs/search-stage-0/examples.json", import.meta.url), "utf8"));
for (const c of cases) test(`stage 0 fixture: ${c.name}`, () => { normalizeRequest(c.request); assertResponse(c.response); });
test("reject bad requests and normalize defaults without mutating input", () => {
  for (const bad of [{date:"2026-02-30"},{limit:51},{keyword:"  "},{platforms:["fake"]},{city:"北京"}]) assert.throws(() => normalizeRequest(bad));
  assert.deepEqual(normalizeRequest({}), {mode:"hybrid",limit:20,freshness:"cached"});
  const input = {keyword:" 展览 ",platforms:["web","web"]};
  assert.equal(normalizeRequest(input).keyword,"展览"); assert.equal(input.keyword," 展览 ");
});
test("reject invalid response combinations", () => {
  let b = structuredClone(cases[1].response); b.results[0].plannable=true; assert.throws(()=>assertResponse(b));
  b=structuredClone(cases[2].response); b.results[0].event.source_url=null; assert.throws(()=>assertResponse(b));
  b=structuredClone(cases[0].response); b.next_cursor="hidden"; assert.throws(()=>assertResponse(b));
});
