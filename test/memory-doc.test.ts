import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyMemoryDoc,
  MEMORY_SECTIONS,
  normalizeMemoryDoc,
  parseDistillOutput,
} from "../src/memory/doc.ts";

test("emptyMemoryDoc 产出三个固定小节的空文档", () => {
  const doc = emptyMemoryDoc();
  assert.equal(doc, "## 用户\n\n## 偏好\n\n## 足迹\n");
  for (const name of MEMORY_SECTIONS) assert.match(doc, new RegExp(`## ${name}`));
});

test("normalizeMemoryDoc 剥掉杂言、按固定顺序重排并补齐缺失小节", () => {
  const raw = "好的，以下是更新后的文档：\n## 偏好\n偏爱展览\n## 用户\n常驻西安\n";
  const doc = normalizeMemoryDoc(raw, 4_000);
  assert.ok(doc);
  assert.equal(doc, "## 用户\n常驻西安\n\n## 偏好\n偏爱展览\n\n## 足迹\n");
});

test("normalizeMemoryDoc 保留固定小节之外的多余小节", () => {
  const doc = normalizeMemoryDoc("## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n\n## 其他\nextra\n", 4_000);
  assert.ok(doc);
  assert.match(doc, /## 其他\nextra/);
  assert.ok(doc.indexOf("## 足迹") < doc.indexOf("## 其他"));
});

test("normalizeMemoryDoc 全文无 ## 判为不可修复", () => {
  assert.equal(normalizeMemoryDoc("没有小节的垃圾输出", 4_000), undefined);
  assert.equal(normalizeMemoryDoc("### 只有三级标题\n内容", 4_000), undefined);
});

test("normalizeMemoryDoc 超长截尾到 maxChars", () => {
  const raw = `## 用户\n${"长".repeat(100)}\n`;
  const doc = normalizeMemoryDoc(raw, 20);
  assert.ok(doc);
  assert.equal(doc.length, 20);
});

test("parseDistillOutput：UNCHANGED 字面量去空白后命中最优先", () => {
  assert.deepEqual(parseDistillOutput("UNCHANGED"), { kind: "unchanged" });
  assert.deepEqual(parseDistillOutput("  UNCHANGED  \n"), { kind: "unchanged" });
  assert.deepEqual(parseDistillOutput("U N C H A N G E D"), { kind: "unchanged" });
});

test("parseDistillOutput：空白输出 invalid，其余 updated", () => {
  assert.deepEqual(parseDistillOutput("  \n\n"), { kind: "invalid" });
  const parsed = parseDistillOutput("\n## 用户\n常驻西安\n");
  assert.deepEqual(parsed, { kind: "updated", content: "## 用户\n常驻西安" });
});
