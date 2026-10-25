import { describe, it, expect } from 'vitest';
import { chatArtifacts, fileUrlPath, livePreview } from './chatArtifacts.js';

describe('chat artifacts', () => {
  it('uses descriptive labels and resolves local paths once', () => {
    expect(chatArtifacts('[Disk audit and cleanup proposal](reports/disk-audit/README.md)\n[Again](reports/disk-audit/README.md)', 'C:/project')).toEqual([{ path: 'C:/project/reports/disk-audit/README.md', title: 'Disk audit and cleanup proposal', filename: 'README.md' }]);
  });
  it('gives generic names a useful folder-based title', () => {
    expect(chatArtifacts('[README.md](/reports/disk-audit/README.md)')[0].title).toBe('Disk audit');
  });
  it('ignores remote resources, executable files and code', () => {
    expect(chatArtifacts('[Remote](https://example.com/a.md) [Run](/a.exe) ![Image](https://example.com/image.svg) ` [Code](/a.md)`\n```\n[Code](/b.md)\n```')).toEqual([]);
    expect(chatArtifacts('[Relative](report.md)')).toEqual([]);
  });
  it('accepts file:// links as local artifacts, percent-decoded', () => {
    expect(chatArtifacts('[Prototype](file:///C:/Users/me/My%20Designs/pricing/index.html)')).toEqual([{ path: 'C:/Users/me/My Designs/pricing/index.html', title: 'Prototype', filename: 'index.html' }]);
    expect(chatArtifacts('[Notes](file:///home/me/notes.md) [Same](/home/me/notes.md)')).toHaveLength(1);
    expect(chatArtifacts('[Local host](file://localhost/tmp/report.pdf)')[0].path).toBe('/tmp/report.pdf');
  });
  it('turns a file:// image into a card, since the reply cannot draw it inline', () => {
    expect(chatArtifacts('![Chart](file:///C:/out/chart.png)')).toEqual([{ path: 'C:/out/chart.png', title: 'Chart', filename: 'chart.png' }]);
    expect(chatArtifacts('![Chart](C:/out/chart.png)')[0].inlineImage).toBe(true);
  });
  it('rejects network file URLs and malformed ones', () => {
    expect(fileUrlPath('file://server/share/a.md')).toBeNull();
    expect(fileUrlPath('file:///C:/a%ZZ.md')).toBeNull();
    expect(fileUrlPath('file:///C:/a%00.md')).toBeNull();
    expect(fileUrlPath('https://example.com/a.md')).toBeNull();
    expect(chatArtifacts('[Share](file://server/share/a.md)')).toEqual([]);
  });
  it('makes a live preview card for a preview server on this machine', () => {
    expect(chatArtifacts('Running at [the dev server](http://localhost:5173/pricing?tab=team).')).toEqual([{
      path: 'http://localhost:5173/pricing?tab=team', title: 'the dev server', filename: 'localhost:5173/pricing?tab=team',
      live: { url: 'http://localhost:5173/pricing?tab=team', host: 'localhost:5173', route: '/pricing?tab=team' },
    }]);
    for (const url of ['http://127.0.0.1:8000/', 'https://[::1]:3000/app', 'http://LOCALHOST:4321']) expect(livePreview(url)).not.toBeNull();
    expect(livePreview('http://0.0.0.0:8080/x')).toEqual({ url: 'http://localhost:8080/x', host: 'localhost:8080', route: '/x' });
  });
  it('only treats loopback hosts as live previews', () => {
    for (const url of ['https://example.com/', 'http://localhost.example.com:3000/', 'http://192.168.1.4:3000/', 'http://user:pw@localhost:3000/', 'ftp://localhost:21/']) expect(livePreview(url)).toBeNull();
    expect(chatArtifacts('[Site](https://example.com:5173/)')).toEqual([]);
  });
  it('picks up bare localhost URLs once, and the link label wins', () => {
    expect(chatArtifacts('Server running at http://localhost:5173/. Open it.')).toEqual([expect.objectContaining({ path: 'http://localhost:5173/', title: 'Live preview', filename: 'localhost:5173' })]);
    expect(chatArtifacts('[Docs site](http://127.0.0.1:4000/docs) also at http://127.0.0.1:4000/docs')).toEqual([expect.objectContaining({ title: 'Docs site' })]);
  });
  it('ignores localhost and file URLs inside code', () => {
    expect(chatArtifacts('`http://localhost:3000` `[a](file:///C:/a.html)`\n```\nnpm run dev # http://localhost:5173\n[b](http://localhost:8080)\n```')).toEqual([]);
  });
});
