import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../frontend');
const mockRoot = resolve(root, '../docs/mocks/day0');
const mockFiles = new Set(['response-comparison.json', 'response-single.json', 'response-partial.json', 'response-clarification.json', 'stream.sse', 'stream-error.sse']);
const host = process.env.FRONTEND_HOST || '127.0.0.1';
const port = Number(process.env.FRONTEND_PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('FRONTEND_PORT must be an integer between 1 and 65535');
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.sse': 'text/event-stream', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    const mockFile = pathname.startsWith('/__mocks/day0/') ? pathname.slice('/__mocks/day0/'.length) : null;
    if (mockFile !== null && !mockFiles.has(mockFile)) {
      res.writeHead(404).end('Not found');
      return;
    }
    const file = mockFile !== null && mockFiles.has(mockFile) ? resolve(mockRoot, mockFile) : resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const allowed = file.startsWith(root + sep) || (mockFile !== null && mockFiles.has(mockFile));
    if (!allowed || !(await stat(file)).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': (mime[extname(file)] || 'application/octet-stream') +
        (/\.(?:html|css|js|json|txt|svg|sse)$/.test(file) ? '; charset=utf-8' : ''),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
server.on('error', error => {
  console.error(`Frontend server: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Frontend: http://${host}:${port}`));
