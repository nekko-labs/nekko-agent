import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Minimal disk-cache logic extracted for unit testing without Electron. */

function thumbKey(path: string, revision: string | number): string {
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 32);
  const rev = String(revision).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || '0';
  return `${hash}_${rev}.webp`;
}

function readThumb(dir: string, path: string, revision: string | number): string | null {
  try {
    const { existsSync, readFileSync } = require('node:fs');
    const base = thumbKey(path, revision).replace(/\.(webp|png)$/, '');
    for (const ext of ['png', 'webp'] as const) {
      const file = join(dir, `${base}.${ext}`);
      if (existsSync(file)) {
        const data = readFileSync(file);
        return `data:image/${ext};base64,${data.toString('base64')}`;
      }
    }
    return null;
  } catch { return null; }
}

function writeThumb(dir: string, path: string, revision: string | number, dataUrl: string): void {
  const { writeFileSync } = require('node:fs');
  const match = /^data:image\/(webp|png);base64,(.+)$/s.exec(dataUrl);
  if (!match) return;
  const [, ext, b64] = match;
  const filename = thumbKey(path, revision).replace(/\.(webp|png)$/, `.${ext}`);
  writeFileSync(join(dir, filename), Buffer.from(b64, 'base64'));
}

describe('Library thumbnail disk cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `nekko-thumb-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it('round-trips a thumbnail for a path and revision', () => {
    const path = '/Users/a/designs/checkout.html';
    const revision = 1234567890;
    const pngData = 'data:image/png;base64,iVBORw0KGgo=';
    writeThumb(dir, path, revision, pngData);
    const result = readThumb(dir, path, revision);
    expect(result).toBe(pngData);
  });

  it('returns null for a path not in the cache', () => {
    expect(readThumb(dir, '/nonexistent.md', 42)).toBeNull();
  });

  it('returns null for a different revision of the same path', () => {
    const path = '/a/b.md';
    writeThumb(dir, path, 100, 'data:image/webp;base64,abc=');
    expect(readThumb(dir, path, 999)).toBeNull();
  });

  it('the key is stable and path-safe (no slashes or colons)', () => {
    const key = thumbKey('/Users/philip/work: (spaces)/file.html', '2026-11-19T00:00:00.000Z');
    expect(key).not.toContain('/');
    expect(key).not.toContain(':');
    expect(key).not.toContain(' ');
    expect(key).toMatch(/^[a-f0-9]{32}_[a-zA-Z0-9_-]+\.(webp|png)$/);
  });

  it('a webp data URL is stored with the .webp extension', () => {
    const path = '/a/image.png';
    writeThumb(dir, path, 1, 'data:image/webp;base64,ZGF0YQ==');
    const files = readdirSync(dir);
    expect(files.some(f => f.endsWith('.webp'))).toBe(true);
  });

  it('a png data URL is stored with the .png extension', () => {
    const path = '/a/design.html';
    writeThumb(dir, path, 2, 'data:image/png;base64,ZGF0YQ==');
    const files = readdirSync(dir);
    expect(files.some(f => f.endsWith('.png'))).toBe(true);
  });

  it('ignores data URLs with an unsupported format', () => {
    writeThumb(dir, '/a/b.gif', 1, 'data:image/gif;base64,abc=');
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
