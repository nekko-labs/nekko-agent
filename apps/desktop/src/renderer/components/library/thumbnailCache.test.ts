import { describe, expect, it, vi } from 'vitest';
import { createThumbnailCache, documentThumbnail, thumbnailKind } from './thumbnailCache.js';

const file = (content: string, binary = false) => ({ content, binary, truncated: false });
const sourceOf = (url: string | null) => decodeURIComponent(url!.split(',')[1]);

describe('document first-page thumbnails', () => {
  it('draws source text, headings and lists without interactive markup', () => {
    const svg = sourceOf(documentThumbnail('/report.md', file('# Landing report\n\n## Verified\n- Cached thumbnails\n[Source](https://example.com)')));
    expect(svg).toContain('Landing report');
    expect(svg).toContain('font-size="25" font-weight="700"');
    expect(svg).toContain('• Cached thumbnails');
    expect(svg).not.toMatch(/https:|<a |<script|<foreignObject/);
  });
  it('escapes source, drops Markdown markup and never requests images', () => {
    const svg = sourceOf(documentThumbnail('/report.md', file('# <script>alert(1)</script>\n\n![secret](https://example.com/tracker)\n<&"\' Ω 漢字')));
    expect(svg).not.toMatch(/<script|<image|foreignObject|https:/);
    expect(svg).toContain('&lt;&amp;&quot;&apos; Ω 漢字');
    expect(svg).toContain('secret');
  });
  it('keeps plain text literal, including Markdown syntax, and handles truncated text', () => {
    expect(sourceOf(documentThumbnail('/notes.txt', { ...file('# literal <html>'), truncated: true }))).toContain('# literal &lt;html&gt;');
  });
  it('skips YAML frontmatter, table rules, and limits work and output', () => {
    const svg = sourceOf(documentThumbnail('/report.markdown', file('---\nsecret: metadata\n---\n# Visible\n| A | B |\n| --- | --- |\n' + 'A'.repeat(1_000_000))));
    expect(svg).not.toContain('secret: metadata');
    expect(svg).toContain('Visible');
    expect(svg.length).toBeLessThan(15_000);
    expect(svg.match(/<text/g)!.length).toBeLessThan(40);
  });
  it('falls back for binary, empty and metadata-only documents', () => {
    expect(documentThumbnail('/a.md', file('binary', true))).toBeNull();
    expect(documentThumbnail('/a.md', file(' \n'))).toBeNull();
    expect(documentThumbnail('/a.md', file('---\nkey: value\n---'))).toBeNull();
  });
  it('supports Markdown, plain text and existing image formats, not PDF or office viewers', () => {
    for (const ext of ['md', 'markdown', 'TXT']) expect(thumbnailKind('/r/a.' + ext)).toBe('document');
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) expect(thumbnailKind('/r/a.' + ext)).toBe('image');
    for (const ext of ['pdf', 'docx', 'html', 'json']) expect(thumbnailKind('/r/a.' + ext)).toBeNull();
  });
});

describe('bounded shared thumbnail cache', () => {
  it('deduplicates in-flight reads and reuses the result across consumers', async () => {
    const loader = vi.fn(async () => 'data:thumb');
    const cache = createThumbnailCache(loader);
    const first = cache.load('/A.md', 1);
    expect(cache.load('/A.md', 1)).toBe(first);
    expect(await first).toBe('data:thumb');
    expect(await cache.load('/A.md', 1)).toBe('data:thumb');
    expect(loader).toHaveBeenCalledTimes(1);
    await cache.load('/A.md', 2);
    await cache.load('/a.md', 1);
    expect(loader).toHaveBeenCalledTimes(3);
  });
  it('caps simultaneous reads/decodes, including failed jobs', async () => {
    const releases: Array<() => void> = [];
    let active = 0, peak = 0;
    const cache = createThumbnailCache(async path => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve)); active--;
      if (path === 'bad') throw Error('refused');
      return path;
    }, { concurrency: 2 });
    const requests = ['a', 'bad', 'c', 'd'].map(path => cache.load(path));
    await Promise.resolve(); expect(releases).toHaveLength(2);
    while (releases.length || active) {
      releases.splice(0).forEach(release => release());
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(await Promise.all(requests)).toEqual(['a', null, 'c', 'd']);
    expect(peak).toBe(2);
  });
  it('expires results and retries failures after a shorter TTL', async () => {
    let now = 0;
    const loader = vi.fn(async (path: string) => { if (path === 'bad') throw Error('denied'); return 'ok'; });
    const cache = createThumbnailCache(loader, { now: () => now, ttl: 100, failureTtl: 10 });
    await cache.load('ok'); await cache.load('bad');
    expect(cache.peek('bad')).toBeNull();
    now = 11; expect(cache.peek('bad')).toBeUndefined();
    await cache.load('bad'); expect(loader).toHaveBeenCalledTimes(3);
    expect(cache.peek('ok')).toBe('ok');
    now = 101; await cache.load('ok'); expect(loader).toHaveBeenCalledTimes(4);
  });
  it('evicts least-recently-used results by count and by bytes', async () => {
    const cache = createThumbnailCache(async p => p, { maxEntries: 2, maxBytes: 8 });
    await cache.load('a'); await cache.load('b'); cache.peek('a'); await cache.load('c');
    expect(cache.peek('b')).toBeUndefined();
    expect(cache.peek('a')).toBe('a');
    await cache.load('long');
    expect(cache.peek('a')).toBeUndefined(); expect(cache.peek('c')).toBeUndefined();
    expect(cache.peek('long')).toBe('long');
    await cache.load('oversized'); expect(cache.peek('oversized')).toBeUndefined();
  });
});
