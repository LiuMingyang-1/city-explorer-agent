import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { collectionCredentials, geocodingKey } from "../src/collection/config.ts";
import { cachedXhsDocuments } from "../src/collection/cached-input.ts";
import { createDeepSeekExtractor, processCollection } from "../src/collection/pipeline.ts";
import { createGeocoder } from "../src/collection/geocoding.ts";
import { redact } from "../src/collection/pilot-api.ts";
import { inspectRelease, publishRelease } from "../src/collection/releases.ts";
import { isCalendarDate } from "../src/itinerary/constraints.ts";
import type { Attempt } from "../src/collection/pilot-api.ts";

// Default mode only audits cached input. --live is required for paid API requests.
async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (args.some(a => a !== "--live" && !/^--(?:input|output|date|publish-root)=.+$/.test(a))) throw new Error("INVALID_PROCESS_ARGUMENTS");
  const date = value("date"), input = value("input"), output = value("output"), publication = value("publish-root");
  if (!date || !isCalendarDate(date) || !input || !output || publication && !args.includes("--live")) throw new Error("PROCESS_ARGUMENTS_REQUIRED");
  const privatePath = (path: string) => {
    const full = resolve(path), child = relative(resolve(".local-data"), full);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("PATH_MUST_BE_PRIVATE");
    return full;
  };
  const destination = privatePath(output), source = privatePath(input), publishRoot = publication ? privatePath(publication) : undefined;
  const all = cachedXhsDocuments(JSON.parse(readFileSync(source, "utf8")));
  const selected = all.slice(0, 10);
  if (!args.includes("--live")) {
    mkdirSync(destination);
    const report = { mode: "offline-input-audit", input_documents: all.length, selected_documents: selected.length,
      api_calls: 0, events_written: 0, unverified_sources: selected.length, next_step: "live extraction, field completion and geocoding required" };
    writeFileSync(join(destination, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report)); return;
  }
  process.loadEnvFile(resolve(".env"));
  const credentials = collectionCredentials(), mapKey = geocodingKey();
  const prior = publishRoot && existsSync(join(publishRoot, "CURRENT")) ? inspectRelease(publishRoot) : undefined;
  mkdirSync(destination);
  let attempts = 0;
  const save = (name: string, data: unknown) => writeFileSync(join(destination, name), JSON.stringify(redact(data, [credentials.deepseekKey, mapKey]), null, 2) + "\n");
  const record = (attempt: Attempt) => save(`api-${++attempts}.json`, attempt);
  const asOf = new Date().toISOString();
  const result = await processCollection(selected.map(document => ({ document })), { asOf, baseDate: date, now: () => new Date().toISOString(),
    identities: prior?.sidecar.identities, modelBudget: 10, eventLimit: 10,
    invoke: createDeepSeekExtractor({ deepseekKey: credentials.deepseekKey, model: credentials.extractionModel, record, extractLimit: 10, searchLimit: 0 }),
    geocoder: createGeocoder({ key: mapKey, now: () => new Date().toISOString(), requestLimit: 10 }),
  });
  save("dataset.json", result.prepared.dataset); save("rejected.json", result.rejected);
  save("metrics.json", result.metrics); save("metadata.json", result.prepared.metadata); save("validation-documents.json", [...result.prepared.documents]);
  if (publishRoot && result.prepared.dataset.events.length) await publishRelease(publishRoot, result.prepared, { batchId: `batch-${Date.now()}`, asOf: new Date().toISOString() });
  console.log(JSON.stringify({ mode: "live-cached-processing", prepared_events: result.prepared.dataset.events.length, rejected: result.rejected.length,
    release_requested: !!publishRoot, api_attempts: attempts, default_database_modified: false }));
}

main().catch(error => {
  const message = error instanceof Error && /^[A-Z_]+(?::[A-Z_]+)?$/.test(error.message) ? error.message : "CACHED_PROCESSING_FAILED";
  console.error(message); process.exitCode = 1;
});
