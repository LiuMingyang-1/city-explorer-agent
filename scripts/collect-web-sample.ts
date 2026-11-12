import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { collectionCredentials } from "../src/collection/config.ts";
import { createPilotApi } from "../src/collection/pilot-api.ts";
import { documentsFrom } from "../src/collection/pilot-extract.ts";
import { isCalendarDate } from "../src/itinerary/constraints.ts";
import type { Attempt } from "../src/collection/pilot-api.ts";

// Search-only stage 2 sample. Never extracts, geocodes or writes events.
const [date, output] = process.argv.slice(2);
if (!date || !isCalendarDate(date) || !output || process.argv.length !== 4) throw new Error("Usage: node scripts/collect-web-sample.ts YYYY-MM-DD .local-data/output");
const directory = resolve(output), child = relative(resolve(".local-data"), directory);
if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("OUTPUT_MUST_BE_PRIVATE");
process.loadEnvFile(resolve(".env"));
const credentials = collectionCredentials();
mkdirSync(directory, { recursive: false });
const attempts: Attempt[] = [];
let active = 0;
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const api = createPilotApi({ ...credentials, searchLimit: 6, extractLimit: 0, searchResultCount: 5,
  record(attempt) { attempts.push(attempt); save(`search-${active}.json`, attempt); } });
const documents = [], queries = ["展览", "演出", "市集", "读书会", "工作坊", "节庆活动"];
for (const category of queries) {
  active++;
  const query = `西安 ${category} ${date.slice(0, 4)}年${Number(date.slice(5, 7))}月`;
  try {
    const result = await api.search("deepseek", query, date, date);
    documents.push(...documentsFrom("deepseek", result, query).slice(0, 5));
  } catch {
    if (["AUTH_FAILED", "INSUFFICIENT_BALANCE", "HTTP_404"].includes(attempts.at(-1)?.code ?? "")) break;
  }
}
save("documents.json", documents);
const report = { scope: "stage2_search_only", date, requested_queries: 6, result_limit_per_query: 5,
  retained_documents: documents.length, attempts: attempts.map(({ query, code, http_status, elapsed_ms }) => ({ query, code, http_status, elapsed_ms })),
  events_written: 0, extraction_calls: 0 };
save("report.json", report);
console.log(JSON.stringify(report));
if (attempts.length !== 6 || attempts.some(a => a.code !== "OK")) process.exitCode = 1;
