/**
 * 用户长期记忆文档的结构约定与模型输出解析（纯函数，无 IO）。
 * 文档是带固定小节的 markdown；蒸馏提示词与这里的常量保持一致。
 */

/** 固定小节（顺序即文档结构；蒸馏提示词与此一致）。 */
export const MEMORY_SECTIONS = ["用户", "偏好", "足迹"] as const;
/** 保留小节目：历史上是写库侧审计节（已移除）；normalize 丢弃同名节防复活。 */
export const AUDIT_SECTION_NAME = "蒸馏记录";
/** 模型输出此字面量（去空白/换行后比较，大小写不敏感）= 无需更新。 */
export const UNCHANGED = "UNCHANGED";

/** 空文档：三个固定小节标题，无内容。 */
export function emptyMemoryDoc(): string {
  return MEMORY_SECTIONS.map((name) => `## ${name}\n`).join("\n");
}

interface DocSections {
  /** 固定小节目名 → 正文（同名重复出现时首段保留、后续内容并入）。 */
  fixed: Map<string, string>;
  /** 固定小节之外的多余小节（出现顺序保持）。 */
  extras: Array<{ name: string; body: string }>;
}

/**
 * 把 markdown 按 `## ` 标题切成小节：固定小节目的同名重复并内容，其余收进
 * extras；含蒸馏包裹分隔符的行整行剥掉（防止污染后续蒸馏请求的包裹结构）。
 */
function splitDocSections(text: string): DocSections {
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
    } else if (current.name !== AUDIT_SECTION_NAME) {
      // 「蒸馏记录」是保留名：模型输出或既有文档 extras 里的同名节一律
      // 丢弃，防止历史审计节复活进新文档。
      extras.push({ name: current.name, body });
    }
    current = undefined;
  };
  for (const line of text.split("\n")) {
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
  return { fixed, extras };
}

/** 固定三节 + extras 按约定顺序拼装成整篇文档。 */
function assembleDoc(
  bodies: Array<{ name: string; lines: string[] }>,
  extras: Array<{ name: string; body: string }>,
): string {
  const sections = bodies.map((section) =>
    `## ${section.name}\n${section.lines.join("\n")}`.trimEnd(),
  );
  for (const extra of extras) {
    sections.push(`## ${extra.name}\n${extra.body}`.trimEnd());
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * 修剪模型输出为合法文档：剥掉首个 `## ` 之前的杂言、按固定顺序重排
 * 三个小节（缺的从 currentDoc 继承内容——空补会抹除旧节记忆，故不补空）、
 * 多余小节附在最后。
 * 校验契约：至少含一个固定小节，否则视为垃圾输出 → undefined。
 * 超过 maxChars 也整体拒绝 → undefined——持久层不做内容剪裁：不按长度
 * 猜测重要性、不丢多余小节、不截断正文，由上层保留原文与游标。
 */
export function normalizeMemoryDoc(
  raw: string,
  maxChars: number,
  currentDoc = "",
): string | undefined {
  const firstHeading = /^## /m.exec(raw);
  if (!firstHeading) return undefined;
  const { fixed, extras } = splitDocSections(raw.slice(firstHeading.index));
  const hasFixed = [...fixed.keys()].some((name) =>
    (MEMORY_SECTIONS as readonly string[]).includes(name),
  );
  if (!hasFixed) return undefined;
  if (currentDoc !== "") {
    const prior = splitDocSections(currentDoc).fixed;
    for (const name of MEMORY_SECTIONS) {
      if (!fixed.has(name) && prior.has(name)) fixed.set(name, prior.get(name)!);
    }
  }
  const bodies = MEMORY_SECTIONS.map((name) => {
    const body = (fixed.get(name) ?? "").trimEnd();
    return { name, lines: body === "" ? [] : body.split("\n") };
  });
  const doc = assembleDoc(bodies, extras);
  return doc.length <= maxChars ? doc : undefined;
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
