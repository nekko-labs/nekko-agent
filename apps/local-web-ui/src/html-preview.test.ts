import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTML_PREVIEW_CHANNELS } from '@nekko-agent/shared';
import { localHtmlPreview } from './html-preview.js';

const dirs: string[] = [];
const previews: ReturnType<typeof localHtmlPreview>[] = [];
afterEach(async () => {
  for (const p of previews.splice(0)) await p.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function page() {
  const root = mkdtempSync(join(tmpdir(), 'nekko-web-preview-'));
  dirs.push(root);
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, 'site', 'index.html'), '<!doctype html><p>hi</p>');
  return join(root, 'site', 'index.html');
}

describe('Local Web UI html preview', () => {
  it('answers at the host name the browser used, on its own port', async () => {
    const preview = localHtmlPreview({ host: '127.0.0.1', home: join(tmpdir(), 'nekko-not-home') });
    previews.push(preview);
    const served = await preview.call(HTML_PREVIEW_CHANNELS.serve, [page(), { internet: false }], 'localhost:1440');
    expect(served?.url).toMatch(new RegExp(`^http://localhost:\\d+/${served?.id}/index\\.html$`));
    expect(served?.url).not.toContain(':1440/');
    const res = await fetch(served!.url.replace('localhost', '127.0.0.1'));
    expect(res.status).toBe(200);
    await preview.call(HTML_PREVIEW_CHANNELS.release, [served!.id], 'localhost:1440');
    expect((await fetch(served!.url.replace('localhost', '127.0.0.1'))).status).toBe(404);
  });

  it('keeps an IPv6 host in brackets and refuses without one', async () => {
    const preview = localHtmlPreview({ host: '127.0.0.1', home: join(tmpdir(), 'nekko-not-home') });
    previews.push(preview);
    const served = await preview.call(HTML_PREVIEW_CHANNELS.serve, [page(), {}], '[::1]:1440');
    expect(served?.url).toMatch(/^http:\/\/\[::1\]:\d+\//);
    await expect(preview.call(HTML_PREVIEW_CHANNELS.serve, [page(), {}], undefined)).rejects.toThrow(/address/);
  });

  it('passes on a refusal and only allows the internet when asked with true', async () => {
    const preview = localHtmlPreview({ host: '127.0.0.1', home: join(tmpdir(), 'nekko-not-home') });
    previews.push(preview);
    await expect(preview.call(HTML_PREVIEW_CHANNELS.serve, ['/nope/page.css', {}], 'localhost:1440')).rejects.toThrow(/Only \.html/);
    const served = await preview.call(HTML_PREVIEW_CHANNELS.serve, [page(), { internet: 'yes' }], 'localhost:1440');
    const policy = (await fetch(served!.url.replace('localhost', '127.0.0.1'))).headers.get('content-security-policy');
    expect(policy).not.toContain('https:');
  });
});
