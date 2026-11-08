// A local mirror for electron-builder's tool downloads (NSIS, AppImage, icons,
// winCodeSign...). It answers ELECTRON_BUILDER_BINARIES_MIRROR's
// /<release>/<file> requests through the release-assets API, because GitHub's
// browser-download URLs can 504 for hours while the API still serves the same
// files (v0.9.5, 2026-11-08). electron-builder still checks its own pinned
// checksum on every file; this also checks GitHub's sha256 digest when present.
//
// Usage: node scripts/release-builder-binaries.mjs   (prints the mirror URL once listening)
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'electron-userland/electron-builder-binaries';
const NAME = /^[0-9A-Za-z][0-9A-Za-z._@+-]*$/;

/** `/nsis-3.0.4.1/nsis-3.0.4.1.7z` -> { release, file }; null for anything else. */
export function parseRequest(url) {
  const parts = decodeURIComponent(new URL(url, 'http://mirror').pathname).split('/').slice(1);
  if (parts.length !== 2 || !parts.every(part => NAME.test(part) && !part.includes('..'))) return null;
  return { release: parts[0], file: parts[1] };
}

/** The verified bytes of one release asset. */
export async function fetchAsset({ release, file, token, request = fetch }) {
  // Authentication goes only to api.github.com; fetch drops it on the cross-origin asset redirect.
  const get = async (endpoint, accept) => {
    const response = await request(`https://api.github.com/repos/${REPO}/${endpoint}`, {
      headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
    return response;
  };
  const meta = await (await get(`releases/tags/${encodeURIComponent(release)}`, 'application/vnd.github+json')).json();
  if (meta.tag_name !== release || meta.draft) throw new Error(`Unexpected release identity for ${release}`);
  const matches = meta.assets.filter(asset => asset.name === file);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) throw new Error(`Missing or ambiguous asset ${release}/${file}`);
  const asset = matches[0];
  const bytes = Buffer.from(await (await get(`releases/assets/${asset.id}`, 'application/octet-stream')).arrayBuffer());
  if (bytes.length !== asset.size) throw new Error(`${release}/${file}: size mismatch`);
  if (asset.digest && asset.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) throw new Error(`${release}/${file}: digest mismatch`);
  return bytes;
}

export function startMirror({ token, request } = {}) {
  const server = createServer(async (req, res) => {
    const target = req.method === 'GET' ? parseRequest(req.url) : null;
    if (!target) { res.writeHead(404).end(); return; }
    try {
      const bytes = await fetchAsset({ ...target, token, request });
      console.error(`mirror: served ${target.release}/${target.file} (${bytes.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }).end(bytes);
    } catch (error) {
      console.error(`mirror: ${target.release}/${target.file} failed: ${error.message}`);
      res.writeHead(502).end();
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startMirror({ token: process.env.GH_TOKEN });
  console.log(`http://127.0.0.1:${server.address().port}/`);
}
