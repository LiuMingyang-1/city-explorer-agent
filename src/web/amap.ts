/** Shared Web/Worker handler: the browser receives only the public JS key. */
export interface AMapEnvironment {
  AMAP_JS_KEY?: string;
  AMAP_SECURITY_JSCODE?: string;
  AMAP_STYLE?: string;
  AMAP_BACKEND_COORDINATE_SYSTEM?: string;
}
const paths = new Map([
  ['/v3/geocode/regeo', 'https://restapi.amap.com'],
  ['/v3/geocode/geo', 'https://restapi.amap.com'],
  ['/v3/place/text', 'https://restapi.amap.com'],
  ['/v3/place/around', 'https://restapi.amap.com'],
  ['/v3/assistant/coordinate/convert', 'https://restapi.amap.com'],
  ['/v3/weather/weatherInfo', 'https://restapi.amap.com'],
  ['/v4/map/styles', 'https://webapi.amap.com'],
]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
export async function handleAMap(
  request: Request, env: AMapEnvironment, fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/map-config' && !url.pathname.startsWith('/_AMapService/')) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const enabled = Boolean(env.AMAP_JS_KEY && env.AMAP_SECURITY_JSCODE);
  if (url.pathname === '/api/map-config') {
    return json(enabled ? {
      enabled: true, jsKey: env.AMAP_JS_KEY, serviceHost: '/_AMapService',
      style: /^amap:\/\/styles\/[\w-]+$/.test(env.AMAP_STYLE ?? '') ? env.AMAP_STYLE : 'amap://styles/light',
      backendCoordinateSystem: env.AMAP_BACKEND_COORDINATE_SYSTEM === 'GCJ02' ? 'GCJ02' : 'WGS84',
    } : { enabled: false });
  }
  if (!enabled) return json({ error: 'Map configuration unavailable' }, 503);
  for (const name of ['Origin', 'Referer']) {
    const value = request.headers.get(name);
    if (value) { try { if (new URL(value).host !== url.host) return json({ error: 'Forbidden' }, 403); } catch { return json({ error: 'Forbidden' }, 403); } }
  }
  const path = url.pathname.slice('/_AMapService'.length), origin = paths.get(path);
  if (!origin) return json({ error: 'Map resource not allowed' }, 404);
  const callback = url.searchParams.get('callback');
  if (callback && !/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(callback)) return json({ error: 'Invalid callback' }, 400);
  const upstream = new URL(path, origin);upstream.search = url.search;
  upstream.searchParams.set('key', env.AMAP_JS_KEY!);upstream.searchParams.set('jscode', env.AMAP_SECURITY_JSCODE!);
  try {
    const response = await fetcher(upstream, {
      // Workers support manual/follow. Reject 3xx below without forwarding credentials.
      method: request.method, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Referer: request.headers.get('Referer') || url.origin + '/' },
    });
    if (!response.ok) {
      console.warn('AMap upstream status', response.status);
      return json({ error: 'Map service unavailable' }, 502);
    }
    return new Response(response.body, { status: response.status, headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    // Never log the upstream URL: its query includes runtime credentials.
    const detail = (error instanceof Error ? error.name + ': ' + error.message : 'Unknown error')
      .replaceAll(env.AMAP_JS_KEY!, '[redacted]').replaceAll(env.AMAP_SECURITY_JSCODE!, '[redacted]');
    console.warn('AMap proxy failure', detail);
    return json({ error: 'Map service unavailable' }, 502);
  }
}
