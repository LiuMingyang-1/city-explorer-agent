import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAMap, type AMapEnvironment } from './amap.ts';

/** Return true when a map endpoint handled the request. Never log upstream URLs. */
export async function handleAMapNode(
  req: IncomingMessage, res: ServerResponse, env: AMapEnvironment = process.env, fetcher: typeof fetch = fetch,
): Promise<boolean> {
  let url: URL;
  try { url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost')); } catch { return false; }
  if (url.pathname !== '/api/map-config' && !url.pathname.startsWith('/_AMapService/')) return false;
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.writeHead(405, {Allow: 'GET, HEAD'});res.end();return true;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
  const response = await handleAMap(new Request(url, { method: req.method || 'GET', headers }), env, fetcher);
  if (!response) return false;
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));return true;
}
