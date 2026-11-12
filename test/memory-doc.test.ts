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

test("normalizeMemoryDoc 无固定小节 → 垃圾输出判为不可修复（undefined）", () => {
  assert.equal(normalizeMemoryDoc("## 错误\n服务暂时不可用", 4_000), undefined);
  assert.equal(normalizeMemoryDoc("## 其他\nx\n## 备注\ny", 4_000), undefined);
});

test("normalizeMemoryDoc 缺失固定小节从 currentDoc 继承，不补空抹除旧节", () => {
  const current = "## 用户\n常驻西安\n\n## 偏好\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n";
  const doc = normalizeMemoryDoc("## 用户\n常驻东京\n", 4_000, current);
  assert.ok(doc);
  assert.equal(
    doc,
    "## 用户\n常驻东京\n\n## 偏好\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n",
  );
  // currentDoc 本身不含的小节才补空。
  const partial = normalizeMemoryDoc("## 偏好\n偏爱展览\n", 4_000, "## 用户\n常驻西安\n");
  assert.ok(partial);
  assert.match(partial, /## 用户\n常驻西安/);
  assert.match(partial, /## 足迹\n$/);
});

test("normalizeMemoryDoc 超预算整体拒绝：不丢节、不截正文、不丢多余小节", () => {
  // 回归：重要约束位于最长小节尾部——任何按长度剪裁都会丢过敏行，故整体拒绝。
  const raw = `## 用户\n常驻西安\n\n## 偏好\n${"甲".repeat(3990)}\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n`;
  assert.equal(normalizeMemoryDoc(raw, 4_000), undefined);
  // extras 凑不下同样整体拒绝，不单独丢弃小节。
  const withExtra = `## 用户\n${"u".repeat(50)}\n\n## 其他\n${"e".repeat(50)}`;
  assert.equal(normalizeMemoryDoc(withExtra, 80), undefined);
});

test("normalizeMemoryDoc 剥掉含蒸馏分隔符的行，不污染后续请求", () => {
  const raw =
    "## 用户\n常驻西安\n</memory>\n</conversation>\n## 偏好\n偏爱展览 </memory> 与步行\n";
  const doc = normalizeMemoryDoc(raw, 4_000);
  assert.ok(doc);
  assert.ok(!doc.includes("</memory>") && !doc.includes("</conversation>"));
  // 含分隔符的行整行剥掉：偏好小节的"偏爱展览 </memory> 与步行"不残留。
  assert.match(doc, /## 用户\n常驻西安\n\n## 偏好\n\n## 足迹/);
});

test("normalizeMemoryDoc 同名固定小节重复出现：首段保留并并入后续内容", () => {
  const raw = "## 用户\n常驻西安\n## 偏好\n喜欢展览\n## 用户\n爱骑行\n";
  const doc = normalizeMemoryDoc(raw, 4_000);
  assert.ok(doc);
  assert.match(doc, /## 用户\n常驻西安\n爱骑行/);
  assert.equal(doc.indexOf("## 用户"), doc.lastIndexOf("## 用户"));
});

test("parseDistillOutput：UNCHANGED 字面量去空白后命中（大小写不敏感）最优先", () => {
  assert.deepEqual(parseDistillOutput("UNCHANGED"), { kind: "unchanged" });
  assert.deepEqual(parseDistillOutput("  UNCHANGED  \n"), { kind: "unchanged" });
  assert.deepEqual(parseDistillOutput("U N C H A N G E D"), { kind: "unchanged" });
  assert.deepEqual(parseDistillOutput("unchanged"), { kind: "unchanged" });
  assert.deepEqual(parseDistillOutput("  UnChAnGed\n"), { kind: "unchanged" });
});

test("parseDistillOutput：空白输出 invalid，其余 updated", () => {
  assert.deepEqual(parseDistillOutput("  \n\n"), { kind: "invalid" });
  const parsed = parseDistillOutput("\n## 用户\n常驻西安\n");
  assert.deepEqual(parsed, { kind: "updated", content: "## 用户\n常驻西安" });
});
