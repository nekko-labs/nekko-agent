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

/**
 * The URL validator logic used by the capture handler: accepts only URLs
 * issued by the HTML preview server and still being served.
 */
function makeUrlValidator(port: number | undefined, activeIds: Set<string>): (url: string) => boolean {
  return (url: string): boolean => {
    if (port === undefined) return false;
    const prefix = `http://127.0.0.1:${port}/`;
    if (!url.startsWith(prefix)) return false;
    const id = url.slice(prefix.length).split('/')[0];
    return id.length > 0 && activeIds.has(id);
  };
}

describe('Capture URL validator', () => {
  it('rejects when no port is known yet (server never served a page)', () => {
    const v = makeUrlValidator(undefined, new Set(['abc']));
    expect(v('http://127.0.0.1:12345/abc/index.html')).toBe(false);
  });

  it('rejects a non-loopback URL', () => {
    const v = makeUrlValidator(12345, new Set(['abc']));
    expect(v('http://evil.com/abc/index.html')).toBe(false);
    expect(v('https://127.0.0.1:12345/abc/index.html')).toBe(false);
  });

  it('rejects a loopback URL for a different port', () => {
    const v = makeUrlValidator(12345, new Set(['abc']));
    expect(v('http://127.0.0.1:9999/abc/index.html')).toBe(false);
  });

  it('rejects a loopback URL with an ID not in the active set', () => {
    const v = makeUrlValidator(12345, new Set(['known-id']));
    expect(v('http://127.0.0.1:12345/unknown-id/index.html')).toBe(false);
  });

  it('accepts a URL whose ID is in the active set', () => {
    const v = makeUrlValidator(12345, new Set(['abc123def']));
    expect(v('http://127.0.0.1:12345/abc123def/index.html')).toBe(true);
  });

  it('rejects after the page is released from the active set', () => {
    const ids = new Set(['abc123def']);
    const v = makeUrlValidator(12345, ids);
    expect(v('http://127.0.0.1:12345/abc123def/index.html')).toBe(true);
    ids.delete('abc123def');
    expect(v('http://127.0.0.1:12345/abc123def/index.html')).toBe(false);
  });

  it('rejects an empty ID segment', () => {
    const v = makeUrlValidator(12345, new Set(['']));
    expect(v('http://127.0.0.1:12345/')).toBe(false);
  });
});

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
