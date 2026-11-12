/**
 * 用户长期记忆文档的结构约定与模型输出解析（纯函数，无 IO）。
 * 文档是带固定小节的 markdown；蒸馏提示词与这里的常量保持一致。
 */

/** 固定小节（顺序即文档结构；蒸馏提示词与此一致）。 */
export const MEMORY_SECTIONS = ["用户", "偏好", "足迹"] as const;
/** 模型输出此字面量（去空白/换行后比较）= 无需更新。 */
export const UNCHANGED = "UNCHANGED";

/** 空文档：三个固定小节标题，无内容。 */
export function emptyMemoryDoc(): string {
  return MEMORY_SECTIONS.map((name) => `## ${name}\n`).join("\n");
}

/**
 * 修剪模型输出为合法文档：剥掉首个 `## ` 之前的杂言、按固定顺序重排
 * 三个小节（缺的补空标题、多余小节附在最后）、总长截到 maxChars。
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
      if (!fixed.has(current.name)) fixed.set(current.name, body);
    } else {
      extras.push({ name: current.name, body });
    }
    current = undefined;
  };
  for (const line of raw.slice(start).split("\n")) {
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
  return doc.length > maxChars ? doc.slice(0, maxChars) : doc;
}

export type DistillOutput =
  | { kind: "unchanged" }
  | { kind: "updated"; content: string }
  | { kind: "invalid" };

/**
 * 分类模型原始输出：UNCHANGED 字面量（去空白/换行后比较）命中最优先；
 * 全空白 → invalid；其余按 updated 交给 normalizeMemoryDoc 修剪校验。
 */
export function parseDistillOutput(raw: string): DistillOutput {
  if (raw.replace(/\s+/g, "") === UNCHANGED) return { kind: "unchanged" };
  const content = raw.trim();
  return content === "" ? { kind: "invalid" } : { kind: "updated", content };
}
