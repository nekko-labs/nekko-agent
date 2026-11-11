import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTML_PREVIEW_CHANNELS } from '@nekko-agent/shared';
const handle = vi.hoisted(() => vi.fn());
const quit = vi.hoisted(() => ({ hooks: [] as Array<() => void> }));
vi.mock('electron', () => ({ ipcMain: { handle }, app: { once: (_e: string, cb: () => void) => quit.hooks.push(cb) } }));
import { registerHtmlPreview } from './htmlPreview.js';

const dirs: string[] = [];
const handler = (channel: string) => handle.mock.calls.find(([c]) => c === channel)![1];
const frame = {};
const event = { sender: { mainFrame: frame }, senderFrame: frame };

beforeEach(() => handle.mockReset());
afterEach(async () => {
  for (const hook of quit.hooks.splice(0)) hook();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function page() {
  const root = mkdtempSync(join(tmpdir(), 'nekko-main-preview-'));
  dirs.push(root);
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, 'site', 'index.html'), '<!doctype html><p>hi</p>');
  return join(root, 'site', 'index.html');
}

describe('html preview in the main process', () => {
  it('answers only an application main frame', async () => {
    registerHtmlPreview(() => false);
    await expect(handler(HTML_PREVIEW_CHANNELS.serve)(event, page(), {})).rejects.toThrow('main frame');
    handle.mockReset();
    registerHtmlPreview(() => true);
    await expect(handler(HTML_PREVIEW_CHANNELS.serve)({ sender: { mainFrame: {} }, senderFrame: {} }, page(), {})).rejects.toThrow('main frame');
    await expect(handler(HTML_PREVIEW_CHANNELS.release)({ sender: { mainFrame: {} }, senderFrame: {} }, 'x')).rejects.toThrow('main frame');
  });

  it('serves on loopback, internet only for a literal true, and releases', async () => {
    registerHtmlPreview(() => true);
    const served = await handler(HTML_PREVIEW_CHANNELS.serve)(event, page(), { internet: 'yes' });
    expect(served.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${served.id}/index\\.html$`));
    const res = await fetch(served.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).not.toContain('https:');
    await handler(HTML_PREVIEW_CHANNELS.release)(event, served.id);
    expect((await fetch(served.url)).status).toBe(404);
  });

  it('passes a refusal on in words, never a stack', async () => {
    registerHtmlPreview(() => true);
    await expect(handler(HTML_PREVIEW_CHANNELS.serve)(event, '/nope/style.css', {})).rejects.toThrow(/^Only \.html/);
  });
});
