/**
 * 用户长期记忆文档的结构约定与模型输出解析（纯函数，无 IO）。
 * 文档是带固定小节的 markdown；蒸馏提示词与这里的常量保持一致。
 */

/** 固定小节（顺序即文档结构；蒸馏提示词与此一致）。 */
export const MEMORY_SECTIONS = ["用户", "偏好", "足迹"] as const;
/** 模型输出此字面量（去空白/换行后比较，大小写不敏感）= 无需更新。 */
export const UNCHANGED = "UNCHANGED";

/** 空文档：三个固定小节标题，无内容。 */
export function emptyMemoryDoc(): string {
  return MEMORY_SECTIONS.map((name) => `## ${name}\n`).join("\n");
}

/**
 * 修剪模型输出为合法文档：剥掉首个 `## ` 之前的杂言、按固定顺序重排
 * 三个小节（缺的补空标题、多余小节附在最后）、总长按行截到 maxChars。
 * 全文无 `## ` 视为坏到无法修复 → undefined。
 */
export function normalizeMemoryDoc(raw: string, maxChars: number): string | undefined {
  const firstHeading = /^## /m.exec(raw);
  if (!firstHeading) return undefined;
  const start = firstHeading.index;
  const fixed = new Map<string, string>();
  const extras: Array<{ name: string; body: string }> = [];
  let current: { name: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if ((MEMORY_SECTIONS as readonly string[]).includes(current.name)) {
      const prior = fixed.get(current.name);
      // 同名固定小节重复出现：保留首段，其后片段内容并入首段而非丢弃。
      if (prior === undefined) fixed.set(current.name, body);
      else if (body !== "") fixed.set(current.name, `${prior}\n${body}`);
    } else {
      extras.push({ name: current.name, body });
    }
    current = undefined;
  };
  for (const line of raw.slice(start).split("\n")) {
    // 模型把蒸馏分隔符写进文档会污染后续蒸馏请求的包裹结构：整行剥掉。
    if (line.includes("</memory>") || line.includes("</conversation>")) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { name: heading[1], lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  flush();
  const sections = MEMORY_SECTIONS.map((name) =>
    `## ${name}\n${fixed.get(name) ?? ""}`.trimEnd(),
  );
  for (const extra of extras) sections.push(`## ${extra.name}\n${extra.body}`.trimEnd());
  const doc = `${sections.join("\n\n")}\n`;
  return doc.length > maxChars ? truncateLines(doc, maxChars) : doc;
}

/**
 * 按行截断：保留能凑进 maxChars 的完整行前缀，不硬切字符/surrogate 对。
 * 首行即超限时返回空串（没有可完整保留的行）。
 */
export function truncateLines(text: string, maxChars: number): string {
  let out = "";
  for (const line of text.split("\n")) {
    const next = out === "" ? line : `${out}\n${line}`;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}

export type DistillOutput =
  | { kind: "unchanged" }
  | { kind: "updated"; content: string }
  | { kind: "invalid" };

/**
 * 分类模型原始输出：UNCHANGED 字面量（去空白/换行后比较，大小写不敏感）
 * 命中最优先；全空白 → invalid；其余按 updated 交给 normalizeMemoryDoc 修剪校验。
 */
export function parseDistillOutput(raw: string): DistillOutput {
  if (raw.replace(/\s+/g, "").toUpperCase() === UNCHANGED) return { kind: "unchanged" };
  const content = raw.trim();
  return content === "" ? { kind: "invalid" } : { kind: "updated", content };
}
