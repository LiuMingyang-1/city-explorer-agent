export const DEFAULT_COLLECTION_MODEL = "deepseek-flash";
export interface CollectionCredentials { deepseekKey: string; extractionModel: string; }
/** No file IO, network, logging, or fallback to the planner's unrelated API key. */
export function collectionCredentials(env: NodeJS.ProcessEnv = process.env): CollectionCredentials {
 const read = (name:string) => {
  const raw=env[name];
  if(!raw?.trim())throw new Error(`MISSING_COLLECTION_CONFIG:${name}`);
  if(/[\r\n\x00]/.test(raw))throw new Error(`INVALID_COLLECTION_CONFIG:${name}`);
  return raw.trim();
 };
 return {
  deepseekKey:read("DEEPSEEK_API_KEY"),
  extractionModel:env.EXPLORER_COLLECTION_MODEL?.trim()?read("EXPLORER_COLLECTION_MODEL"):DEFAULT_COLLECTION_MODEL,
 };
}
