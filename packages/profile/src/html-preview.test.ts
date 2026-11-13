import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_SHIM, createHtmlPreviewServer, HtmlPreviewRefusal, MAX_SERVED_PAGES, previewPolicy, STORAGE_SHIM, withStorageShim, type HtmlPreviewServer } from './html-preview.js';

const dirs: string[] = [];
const servers: HtmlPreviewServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function design() {
  const root = mkdtempSync(join(tmpdir(), 'nekko-preview-'));
  dirs.push(root);
  const site = join(root, 'site');
  mkdirSync(join(site, 'assets'), { recursive: true });
  mkdirSync(join(site, '.git'));
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/app.css"></head><body>Hi</body></html>');
  writeFileSync(join(site, 'assets', 'app.css'), 'body{color:red}');
  writeFileSync(join(site, 'assets', 'my file.js'), 'console.log(1)');
  writeFileSync(join(site, '.env'), 'SECRET=1');
  writeFileSync(join(site, '.git', 'config'), '[remote]');
  writeFileSync(join(site, 'server.key'), 'KEY');
  writeFileSync(join(site, 'notes.exe'), 'MZ');
  writeFileSync(join(root, 'outside.css'), 'body{}');
  return { root, site };
}

function server() {
  const s = createHtmlPreviewServer({ home: join(tmpdir(), 'nekko-not-home') });
  servers.push(s);
  return s;
}

const get = (port: number, path: string, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method });
/** A request whose path is sent exactly as written (fetch would fold `..`). */
const raw = (port: number, path: string) => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
});

describe('html preview server', () => {
  it('serves the page with its folder, and a policy that keeps it local', async () => {
    const { site } = design();
    const s = server();
    const served = await s.serve(join(site, 'index.html'), { internet: false });
    expect(served.path).toBe(`/${served.id}/index.html`);
    const page = await get(served.port, served.path);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toBe(previewPolicy(false));
    expect(page.headers.get('access-control-allow-origin')).toBe('*');
    expect(await page.text()).toBe(`<!doctype html>${STORAGE_SHIM}<html><head><link rel="stylesheet" href="assets/app.css"></head><body>Hi</body></html>`);
    const css = await get(served.port, `/${served.id}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toBe('body{color:red}');
    expect((await get(served.port, `/${served.id}/assets/my%20file.js`)).status).toBe(200);
    expect((await get(served.port, `/${served.id}/`)).status).toBe(200);
  });

  it('refuses hidden, secret, unknown-type and outside files, and unknown pages', async () => {
    const { site } = design();
    const s = server();
    const { id, port } = await s.serve(join(site, 'index.html'), { internet: false });
    for (const path of ['.env', '.git/config', 'server.key', 'notes.exe']) {
      expect((await get(port, `/${id}/${path}`)).status, path).toBe(403);
    }
    expect((await get(port, `/${id}/..%2Foutside.css`)).status).toBe(400);
    // fetch folds `%2e%2e` into `..` before sending; either way nothing outside is served.
    expect((await get(port, `/${id}/%2e%2e/outside.css`)).status).not.toBe(200);
    expect(await raw(port, `/${id}/../outside.css`)).toBe(400);
    expect(await raw(port, `/${id}/assets/../../outside.css`)).toBe(400);
    expect((await get(port, `/${id}/missing.css`)).status).toBe(404);
    expect((await get(port, '/not-a-page/index.html')).status).toBe(404);
    expect((await get(port, `/${id}/index.html`, 'POST')).status).toBe(405);
  });

  it.skipIf(process.platform === 'win32')('refuses a link that leaves the folder', async () => {
    const { root, site } = design();
    symlinkSync(join(root, 'outside.css'), join(site, 'link.css'));
    const s = server();
    const { id, port } = await s.serve(join(site, 'index.html'), { internet: false });
    expect((await get(port, `/${id}/link.css`)).status).toBe(403);
  });

  it('allows the internet only when asked, and only https and wss', async () => {
    const { site } = design();
    const s = server();
    const { id, port } = await s.serve(join(site, 'index.html'), { internet: true });
    const policy = (await get(port, `/${id}/index.html`)).headers.get('content-security-policy') ?? '';
    expect(policy).toBe(previewPolicy(true));
    expect(policy).toContain('https:');
    expect(policy).toContain('wss:');
    expect(policy).not.toMatch(/\bhttp:|\bws:|\*/);
    expect(previewPolicy(false)).not.toMatch(/https:|wss:/);
  });

  it('forgets a released page, and the oldest past the cap', async () => {
    const { site } = design();
    const s = server();
    const first = await s.serve(join(site, 'index.html'), { internet: false });
    s.release(first.id);
    expect((await get(first.port, first.path)).status).toBe(404);
    const kept = [];
    for (let i = 0; i <= MAX_SERVED_PAGES; i++) kept.push(await s.serve(join(site, 'index.html'), { internet: false }));
    expect((await get(first.port, kept[0].path)).status).toBe(404);
    expect((await get(first.port, kept[MAX_SERVED_PAGES].path)).status).toBe(200);
  });

  it('refuses non-HTML, missing pages and pages in the home folder', async () => {
    const { root, site } = design();
    const s = createHtmlPreviewServer({ home: root });
    servers.push(s);
    writeFileSync(join(root, 'home.html'), '<p>home</p>');
    await expect(s.serve(join(site, 'assets', 'app.css'), { internet: false })).rejects.toBeInstanceOf(HtmlPreviewRefusal);
    await expect(s.serve(join(site, 'gone.html'), { internet: false })).rejects.toBeInstanceOf(HtmlPreviewRefusal);
    await expect(s.serve(join(root, 'home.html'), { internet: false })).rejects.toThrow(/home folder/);
  });
});

describe('viewer control script', () => {
  it('is added only to a page served for the design canvas, after the storage stand-in', async () => {
    const { site } = design();
    const s = server();
    const plain = await s.serve(join(site, 'index.html'), { internet: false });
    expect(await (await get(plain.port, plain.path)).text()).not.toContain('nekkoPreview');
    const canvas = await s.serve(join(site, 'index.html'), { internet: false, controls: true });
    const page = await (await get(canvas.port, canvas.path)).text();
    expect(page.startsWith(`<!doctype html>${STORAGE_SHIM}${CONTROL_SHIM}<html>`)).toBe(true);
    // Its other files are untouched, and the policy is the same as any served page's.
    expect(await (await get(canvas.port, `/${canvas.id}/assets/app.css`)).text()).toBe('body{color:red}');
    expect((await get(canvas.port, canvas.path)).headers.get('content-security-policy')).toBe(previewPolicy(false));
  });

  it('answers only its own viewer, and reports nothing but size and motion', () => {
    // One inline classic script, safe to splice after a doctype.
    expect(CONTROL_SHIM.startsWith('<script>') && CONTROL_SHIM.endsWith('</script>')).toBe(true);
    expect(CONTROL_SHIM.slice(8, -9)).not.toContain('</script');
    expect(() => new Function(CONTROL_SHIM.slice(8, -9))).not.toThrow();
    expect(CONTROL_SHIM).toContain('e.source!==window.parent');
    expect(CONTROL_SHIM).toContain('if(window.parent===window)return');
    for (const leak of ['cookie', 'localStorage', 'location', 'innerHTML', 'fetch(', 'XMLHttpRequest']) expect(CONTROL_SHIM).not.toContain(leak);
  });

  it('pauses and resumes animations, frame loops and media, and counts them', () => {
    const sent: Array<Record<string, unknown>> = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    const animation = { playState: 'running', pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; } };
    const video = { paused: false, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
    const still = { paused: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
    const ran: string[] = [];
    const queue: Array<() => void> = [];
    const parent = { postMessage: (m: Record<string, unknown>) => { sent.push(m); } };
    const win = {
      parent,
      requestAnimationFrame: (cb: () => void) => { queue.push(cb); return queue.length; },
      cancelAnimationFrame: () => {},
    } as Record<string, unknown>;
    const document = {
      documentElement: { scrollWidth: 2400, scrollHeight: 1300 }, body: { scrollWidth: 1440, scrollHeight: 1800 },
      getAnimations: () => [animation, { playState: 'finished' }],
      querySelectorAll: () => [video, still],
    };
    new Function('window', 'document', 'addEventListener', CONTROL_SHIM.slice(8, -9))(win, document, (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; });
    const say = (nekkoPreview: string, source: unknown = parent) => listeners.message({ source, data: { nekkoPreview } });
    const raf = win.requestAnimationFrame as (cb: () => void) => number;

    listeners.load({});
    expect(sent.at(-1)).toEqual({ nekkoPreview: 'state', animations: 1, media: 2, frames: 0, paused: false, width: 2400, height: 1800 });
    raf(() => ran.push('before'));
    expect(queue).toHaveLength(1);

    // A message from anywhere but the viewer is ignored.
    say('pause', {});
    expect(animation.playState).toBe('running');

    say('pause');
    expect([animation.playState, video.paused, sent.at(-1)!.paused]).toEqual(['paused', true, true]);
    const heldId = raf(() => ran.push('held'));
    const dropped = raf(() => ran.push('cancelled'));
    (win.cancelAnimationFrame as (id: number) => void)(dropped);
    expect(heldId).toBeLessThan(0);
    expect(queue).toHaveLength(1);

    say('play');
    expect([animation.playState, video.paused, still.paused, sent.at(-1)!.paused]).toEqual(['running', false, true, false]);
    queue.forEach((cb) => cb());
    expect(ran).toEqual(['before', 'held']);
    say('probe');
    expect(sent.at(-1)).toMatchObject({ frames: 3, animations: 1 });
    expect(sent.every((m) => Object.keys(m).sort().join() === 'animations,frames,height,media,nekkoPreview,paused,width')).toBe(true);
  });
});

describe('storage stand-in', () => {
  it('goes after the doctype so the page keeps standards mode', () => {
    expect(withStorageShim('﻿<!-- a -->\n<!DOCTYPE html><p>x')).toBe(`﻿<!-- a -->\n<!DOCTYPE html>${STORAGE_SHIM}<p>x`);
    expect(withStorageShim('<p>x')).toBe(`${STORAGE_SHIM}<p>x`);
    expect(withStorageShim('<!-- open <!doctype html>')).toBe(`${STORAGE_SHIM}<!-- open <!doctype html>`);
    expect(withStorageShim('<!doctype html')).toBe(`${STORAGE_SHIM}<!doctype html`);
  });

  it('stays linear on hostile input', () => {
    const hostile = '<!--' + '--><!--'.repeat(200_000);
    const start = performance.now();
    expect(withStorageShim(hostile).startsWith(STORAGE_SHIM)).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
