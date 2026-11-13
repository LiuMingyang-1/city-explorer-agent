import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { publicUrl } from "./validate.ts";
import type { ActivityFacts, ExtractionDocument } from "./extraction.ts";
import { createPilotApi } from "./pilot-api.ts";
import type { ApiOptions } from "./pilot-api.ts";

export function isPublicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
export function trustedPublisher(url: string, extraHosts: readonly string[] = []): boolean {
  try {
    const parsed = new URL(url), host = parsed.hostname.toLowerCase();
    return publicUrl(url) && parsed.protocol === "https:" && (!parsed.port || parsed.port === "443")
      && (host.endsWith(".gov.cn") || ["www.sxhm.com", "sxhm.com", ...extraHosts].includes(host));
  } catch { return false; }
}

export function articleText(html: string): string {
  const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, "\n")
    .replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
      if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? whole;
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
    }).replace(/[\t \r]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
}

/** Only fetch recognized public publishers, pin a validated A record for each hop,
 * preserve TLS host verification, and bound redirects/body/time. No browser login.
 */
export async function fetchPrimaryText(initial: string, extraHosts: readonly string[] = []): Promise<{ url: string; text: string }> {
  let current = initial;
  for (let hop = 0; hop < 4; hop++) {
    if (!trustedPublisher(current, extraHosts)) throw new Error("PRIMARY_HOST_NOT_ALLOWED");
    const url = new URL(current);
    let addresses, dnsTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([lookup(url.hostname, { all: true, family: 4 }), new Promise<never>((_resolve, reject) => {
        dnsTimer = setTimeout(() => reject(new Error("PRIMARY_DNS_FAILED")), 3000);
      })]);
    } catch { throw new Error("PRIMARY_DNS_FAILED"); }
    finally { clearTimeout(dnsTimer); }
    if (!addresses.length || addresses.some(a => !isPublicIPv4(a.address))) throw new Error("PRIMARY_PRIVATE_TARGET");
    const address = addresses[0].address;
    const result = await new Promise<{ redirect?: string; text?: string }>((resolve, reject) => {
      const req = request(url, { family: 4, lookup: (_host, _opts, cb) => cb(null, address, 4),
        headers: { "User-Agent": "CityExplorerActivityCollector/0.1", Accept: "text/html,text/plain" } }, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) { const target = response.headers.location; response.destroy(); finish({ redirect: target }); return; }
        if (status !== 200) { response.destroy(); fail(); return; }
        const mime = response.headers["content-type"] ?? "";
        if (!/^text\/(?:html|plain)/i.test(mime) || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); fail(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data", (part: Buffer) => { bytes += part.length; if (bytes > 2 * 1024 * 1024) { req.destroy(); fail(); } else chunks.push(part); });
        response.on("error", fail);
        response.on("end", () => {
          try {
            const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(mime)?.[1].toLowerCase() ?? "utf-8";
            if (!["utf-8", "utf8", "gbk", "gb2312", "gb18030"].includes(charset)) { fail(); return; }
            const decoded = new TextDecoder(charset.startsWith("gb") ? "gb18030" : "utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            finish({ text: /^text\/html/i.test(mime) ? articleText(decoded) : decoded });
          } catch { fail(); }
        });
      });
      const timer = setTimeout(() => { req.destroy(); fail(); }, 10000);
      function finish(value: { redirect?: string; text?: string }) { clearTimeout(timer); resolve(value); }
      function fail() { clearTimeout(timer); reject(new Error("PRIMARY_FETCH_FAILED")); }
      req.on("error", fail); req.end();
    });
    if (result.redirect) { current = new URL(result.redirect, current).href; continue; }
    if (!result.text?.trim() || result.text.length > 30000) throw new Error("PRIMARY_TEXT_UNUSABLE");
    return { url: current, text: result.text };
  }
  throw new Error("PRIMARY_TOO_MANY_REDIRECTS");
}

/** One search round, at most two direct publisher fetches, then the pipeline re-extracts
 * and compares facts. Search-provider summaries never become primary evidence.
 */
export function createPrimaryResolver(options: ApiOptions & { asOf: () => string; extraHosts?: readonly string[]; fetchDocument?: typeof fetchPrimaryText }) {
  const api = createPilotApi({ ...options, searchResultCount: 5, extractLimit: 0 });
  const normalize = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
  return async (facts: ActivityFacts): Promise<ExtractionDocument | null> => {
    const query = [...`西安 ${facts.title.slice(0, 60)} ${facts.venue_name.slice(0, 30)} 官方 活动`].slice(0, 128).join("");
    const response = await api.search("deepseek", query, "", "");
    const rows = Array.isArray(response?.results) ? response.results : [];
    let fetched = 0;
    for (const row of rows) {
      if (fetched >= 2) break;
      if (typeof row?.url !== "string" || !trustedPublisher(row.url, options.extraHosts)) continue;
      fetched++;
      try {
        const doc = await (options.fetchDocument ?? fetchPrimaryText)(row.url, options.extraHosts);
        if (!trustedPublisher(doc.url, options.extraHosts) || !normalize(doc.text).includes(normalize(facts.title)) || !normalize(doc.text).includes(normalize(facts.venue_name))) continue;
        return { url: doc.url, text: doc.text, published_at: null, fetched_at: options.asOf(), authority: "publisher", content_scope: "exported_text", image_urls: [] };
      } catch { /* Bounded source failure: try the next allowed result, never bypass access. */ }
    }
    return null;
  };
}
