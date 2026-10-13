import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('.shots/ask-transcript-fixture');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/gallery.html' : pathname));
    if (!file.startsWith(root + sep) || !['.html', '.png', '.json', '.log'].includes(extname(file))) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.png': 'image/png', '.json': 'application/json', '.log': 'text/plain' })[extname(file)]);
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(0, '127.0.0.1', () => console.log(`Gallery: http://127.0.0.1:${server.address().port}/`));
