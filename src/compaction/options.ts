// Environment loading and normalization for compaction options.
import type { CompactionOptions } from "./compact.ts";

/**
 * The env-configurable part of CompactionOptions. `maxTokens` is the normal
 * reply budget — it is filled by the caller (ExplorerConfig.maxTokens), never
 * read from env here, so this type does not pretend to carry it.
 */
export type CompactionEnvOptions = Omit<CompactionOptions, "maxTokens">;

export const compactionDefaults: CompactionEnvOptions = {
  compactionThreshold: 0.8,
  compactionKeepRecentTokens: 20_000,
  compactionMaxTokens: 8_192,
};

/** Read EXPLORER_COMPACTION_* env values; does not issue model requests. */
export function loadCompactionOptions(
  env: NodeJS.ProcessEnv = process.env,
): CompactionEnvOptions {
  const compactionThreshold = Number(
    env.EXPLORER_COMPACTION_THRESHOLD?.trim() || compactionDefaults.compactionThreshold,
  );
  if (
    !Number.isFinite(compactionThreshold) ||
    compactionThreshold <= 0 ||
    compactionThreshold >= 1
  )
    throw new Error("EXPLORER_COMPACTION_THRESHOLD must be greater than 0 and less than 1.");
  return {
    compactionThreshold,
    compactionKeepRecentTokens: positiveInteger(
      env,
      "EXPLORER_COMPACTION_KEEP_RECENT_TOKENS",
      compactionDefaults.compactionKeepRecentTokens,
    ),
    compactionMaxTokens: positiveInteger(
      env,
      "EXPLORER_COMPACTION_MAX_TOKENS",
      compactionDefaults.compactionMaxTokens,
    ),
  };
}

/**
 * Normalize the optional/partial `compaction` field on ExplorerConfig into a
 * complete CompactionOptions. Missing `maxTokens` falls back to the caller's
 * normal reply budget (`config.maxTokens`); other missing fields fall back to
 * compactionDefaults. Explicit values get the same range checks as env values.
 */
export function resolveCompactionOptions(source: {
  maxTokens: number;
  compaction?: Partial<CompactionOptions>;
}): CompactionOptions {
  const overrides = source.compaction ?? {};
  const resolved: CompactionOptions = {
    compactionThreshold:
      overrides.compactionThreshold ?? compactionDefaults.compactionThreshold,
    compactionKeepRecentTokens:
      overrides.compactionKeepRecentTokens ?? compactionDefaults.compactionKeepRecentTokens,
    compactionMaxTokens:
      overrides.compactionMaxTokens ?? compactionDefaults.compactionMaxTokens,
    maxTokens: overrides.maxTokens ?? source.maxTokens,
  };
  if (
    !Number.isFinite(resolved.compactionThreshold) ||
    resolved.compactionThreshold <= 0 ||
    resolved.compactionThreshold >= 1
  )
    throw new Error("compactionThreshold must be greater than 0 and less than 1.");
  for (const key of ["compactionKeepRecentTokens", "compactionMaxTokens", "maxTokens"] as const) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${key} must be a positive safe integer.`);
  }
  return resolved;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return number;
}
