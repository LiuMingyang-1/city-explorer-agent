import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { importMediaCrawlerJsonl, ENABLED_SOCIAL_PLATFORMS } from "../src/collection/mediacrawler.ts";
import type { SocialPlatform } from "../src/collection/mediacrawler.ts";

// Local exports only. Does not log in, fetch content, call models or write events.
const [platform, input, output] = process.argv.slice(2);
if (!(ENABLED_SOCIAL_PLATFORMS as readonly string[]).includes(platform) || !input || !output || process.argv.length !== 5) {
  throw new Error("Usage: node scripts/import-mediacrawler.ts xhs <input.jsonl> <.local-data/output.json>");
}
const privateRoot = resolve(".local-data");
const destination = resolve(output);
const child = relative(privateRoot, destination);
if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Output must stay inside .local-data");
const result = importMediaCrawlerJsonl(platform as SocialPlatform, readFileSync(input, "utf8"), new Date().toISOString());
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ documents: result.documents.length, rejected: result.rejected.length, duplicates: result.duplicates }));
