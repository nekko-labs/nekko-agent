/**
 * The renderer's production build, as the Local Web UI serves it
 * (apps/desktop/out/renderer, from electron-vite): total JavaScript bytes and
 * a per-chunk listing, so code splitting can be judged later.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Sizes of every .js file (and the .css total) under `dir`; null when there is no build. */
export function rendererBuildSizes(dir) {
  let files;
  try { if (!statSync(dir).isDirectory()) return null; files = walk(dir); } catch { return null; }
  const chunks = files.filter((f) => /\.m?js$/.test(f)).map((f) => {
    const buf = readFileSync(f);
    return { file: relative(dir, f).split('\\').join('/'), bytes: buf.length, gzipBytes: gzipSync(buf).length };
  }).sort((a, b) => b.bytes - a.bytes);
  const css = files.filter((f) => f.endsWith('.css')).reduce((n, f) => n + statSync(f).size, 0);
  return {
    dir,
    count: chunks.length,
    totalBytes: chunks.reduce((n, c) => n + c.bytes, 0),
    totalGzipBytes: chunks.reduce((n, c) => n + c.gzipBytes, 0),
    cssBytes: css,
    chunks,
  };
}

/** Mark each chunk loaded at startup, from the page's resource-timing URLs. */
export function markLoaded(chunks, loadedUrls) {
  const names = new Set(loadedUrls.map((u) => { try { return new URL(u).pathname; } catch { return u; } }));
  return chunks.map((c) => ({ ...c, loadedAtStartup: [...names].some((n) => n.endsWith(`/${c.file}`) || basename(n) === basename(c.file)) }));
}
