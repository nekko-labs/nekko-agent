import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../apps/website/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

// The same lookups as Vercel's cleanUrls in vercel.json: /docs serves
// docs/index.html and /docs/cli serves docs/cli.html.
function candidates(pathname) {
  if (pathname.endsWith('/')) return [`${pathname}index.html`];
  if (extname(pathname)) return [pathname];
  return [`${pathname}.html`, `${pathname}/index.html`, pathname];
}

export function createWebsiteServer() {
  const inside = root.endsWith(sep) ? root : root + sep;
  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    for (const candidate of candidates(pathname)) {
      const file = resolve(root, `.${candidate}`);
      if (!file.startsWith(inside)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EISDIR' && error.code !== 'ENOTDIR') {
          res.writeHead(500).end();
          return;
        }
      }
    }
    res.writeHead(404).end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 8080);
  const server = createWebsiteServer();
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Marketing website: http://127.0.0.1:${server.address().port} (Ctrl+C to stop)`));
}
