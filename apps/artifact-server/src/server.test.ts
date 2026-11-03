import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactPolicy, buildArtifactServer, DEFAULT_LIMITS, randomId, tokenEntry, type Limits } from './server.js';
import { DiskStorage, MemoryStorage, type Storage } from './storage.js';
import { contentType, ID_PATTERN, pathProblem } from './files.js';

const TOKEN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const PUBLIC = 'https://artifacts.test';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const page = (html: string) => ({ files: [{ path: 'index.html', data: b64(html) }] });
const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

function server(limits: Partial<Limits> = {}, storage: Storage = new MemoryStorage()) {
  let ids = 0;
  const { api, content } = buildArtifactServer({
    storage,
    tokens: [tokenEntry('owner', TOKEN, { ...DEFAULT_LIMITS, ...limits }), tokenEntry('someone-else', OTHER)],
    publicUrl: `${PUBLIC}/`,
    now: () => 1_700_000_000_000 + ids,
    newId: () => `${'a'.repeat(25)}${'bcdefghijk'[ids++]}`,
  });
  opened.push(api, content);
  return { api, content, storage };
}

/** The path `content` serves for a published URL. */
const pathOf = (url: string) => url.slice(PUBLIC.length);

describe('publishing', () => {
  it('publishes a page at a URL that serves it', async () => {
    const { api, content } = server();
    const res = await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { title: 'Report', ...page('<h1>Hi</h1>') } });
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({ title: 'Report', visibility: 'unlisted', version: 1, entry: 'index.html', files: 1, bytes: 11 });
    expect(a.url).toBe(`${PUBLIC}/${a.id}/`);
    const served = await content.inject({ method: 'GET', url: pathOf(a.url) });
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe('<h1>Hi</h1>');
    expect(served.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('republishes under the same URL as a new version, and serves the newest', async () => {
    const { api, content } = server();
    const first = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { title: 'Plan', ...page('one') } })).json();
    const res = await api.inject({ method: 'PUT', url: `/v1/artifacts/${first.id}`, headers: auth(), payload: page('two') });
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second).toMatchObject({ id: first.id, url: first.url, version: 2, title: 'Plan' });
    expect(second.versions.map((v: { n: number }) => v.n)).toEqual([1, 2]);
    expect((await content.inject({ method: 'GET', url: pathOf(first.url) })).body).toBe('two');
  });

  it('keeps only the newest versions, and deletes the files of the others', async () => {
    const { api, storage } = server({ keepVersions: 2 });
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('1') })).json();
    for (const text of ['2', '3']) await api.inject({ method: 'PUT', url: `/v1/artifacts/${a.id}`, headers: auth(), payload: page(text) });
    const got = (await api.inject({ method: 'GET', url: `/v1/artifacts/${a.id}`, headers: auth() })).json();
    expect(got.versions.map((v: { n: number }) => v.n)).toEqual([2, 3]);
    expect((await storage.list(`objects/${a.id}/`)).sort()).toEqual([`objects/${a.id}/2/index.html`, `objects/${a.id}/3/index.html`]);
  });

  it('serves the files a page loads, folders and odd names included', async () => {
    const { api, content } = server();
    const files = [
      { path: 'index.html', data: b64('<img src="img/a b%.png">') },
      { path: 'img/a b%.png', data: b64('png') },
      { path: 'docs/index.html', data: b64('docs') },
    ];
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { files } })).json();
    const img = await content.inject({ method: 'GET', url: `/${a.id}/img/a%20b%25.png` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await content.inject({ method: 'GET', url: `/${a.id}/docs/` })).body).toBe('docs');
    expect((await content.inject({ method: 'GET', url: `/${a.id}/missing.png` })).statusCode).toBe(404);
  });

  it('opens a single non-HTML file directly, and the bare id redirects to the folder', async () => {
    const { api, content } = server();
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { files: [{ path: 'chart.svg', data: b64('<svg/>') }] } })).json();
    expect(a.url).toBe(`${PUBLIC}/${a.id}/chart.svg`);
    expect((await content.inject({ method: 'GET', url: `/${a.id}/` })).headers['content-type']).toBe('image/svg+xml');
    const bare = await content.inject({ method: 'GET', url: `/${a.id}` });
    expect(bare.statusCode).toBe(301);
    expect(bare.headers.location).toBe(`./${a.id}/`);
  });

  it('answers a repeat request with 304 while the file is unchanged', async () => {
    const { api, content } = server();
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('x') })).json();
    const first = await content.inject({ method: 'GET', url: pathOf(a.url) });
    expect(first.headers['cache-control']).toBe('no-cache');
    const again = await content.inject({ method: 'GET', url: pathOf(a.url), headers: { 'if-none-match': String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });

  it('deletes an artifact: its URL is gone and its files with it', async () => {
    const { api, content, storage } = server();
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('x') })).json();
    expect((await api.inject({ method: 'DELETE', url: `/v1/artifacts/${a.id}`, headers: auth() })).statusCode).toBe(204);
    expect((await content.inject({ method: 'GET', url: pathOf(a.url) })).statusCode).toBe(404);
    expect(await storage.list('objects/')).toEqual([]);
    expect(await storage.list('meta/')).toEqual([]);
  });

  it('lists what this token published, newest first, and its usage', async () => {
    const { api } = server({ maxArtifacts: 5 });
    await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { title: 'Old', ...page('12') } });
    await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { title: 'New', ...page('345') } });
    await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(OTHER), payload: { title: 'Theirs', ...page('x') } });
    const list = (await api.inject({ method: 'GET', url: '/v1/artifacts', headers: auth() })).json();
    expect(list.artifacts.map((a: { title: string }) => a.title)).toEqual(['New', 'Old']);
    const usage = (await api.inject({ method: 'GET', url: '/v1/usage', headers: auth() })).json();
    expect(usage).toMatchObject({ artifacts: 2, bytes: 5, limits: { maxArtifacts: 5 } });
  });
});

describe('who may publish', () => {
  it('refuses a missing or wrong token', async () => {
    const { api } = server();
    expect((await api.inject({ method: 'POST', url: '/v1/artifacts', payload: page('x') })).statusCode).toBe(401);
    const wrong = await api.inject({ method: 'GET', url: '/v1/artifacts', headers: auth('c'.repeat(40)) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('unauthorized');
  });

  it("treats another token's artifact as not found", async () => {
    const { api, content } = server();
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('mine') })).json();
    for (const method of ['GET', 'DELETE'] as const) {
      expect((await api.inject({ method, url: `/v1/artifacts/${a.id}`, headers: auth(OTHER) })).statusCode).toBe(404);
    }
    expect((await api.inject({ method: 'PUT', url: `/v1/artifacts/${a.id}`, headers: auth(OTHER), payload: page('theirs') })).statusCode).toBe(404);
    expect((await content.inject({ method: 'GET', url: pathOf(a.url) })).body).toBe('mine');
  });
});

describe('limits and bad uploads', () => {
  it('stops at the artifact limit with a clear message', async () => {
    const { api } = server({ maxArtifacts: 1 });
    expect((await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('1') })).statusCode).toBe(201);
    const res = await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('2') });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'limit_reached', message: 'This server allows 1 published artifacts; delete one to publish another.' });
  });

  it('refuses an upload over the size or file limit', async () => {
    const { api } = server({ maxArtifactBytes: 10, maxFiles: 2 });
    const big = await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('x'.repeat(11)) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('too_large');
    const files = ['index.html', 'a.css', 'b.js'].map((path) => ({ path, data: b64('x') }));
    const many = await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { files } });
    expect(many.statusCode).toBe(413);
    expect(many.json().error).toBe('too_many_files');
  });

  it.each([
    ['../escape.html', 'bad_path'],
    ['/abs.html', 'bad_path'],
    ['a//b.html', 'bad_path'],
    ['.env', 'bad_path'],
    ['site/.git/config', 'bad_path'],
    ['a\\b.html', 'bad_path'],
  ])('refuses the path %s', async (path, error) => {
    const { api, storage } = server();
    const res = await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { files: [{ path, data: b64('x') }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(await storage.list('')).toEqual([]);
  });

  it('refuses no files, bad base64, a duplicate path and a missing entry', async () => {
    const { api } = server();
    const post = (payload: object) => api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload });
    expect((await post({ files: [] })).json().error).toBe('no_files');
    expect((await post({ files: [{ path: 'index.html', data: 'not base64!' }] })).json().error).toBe('bad_data');
    expect((await post({ files: [{ path: 'index.html', data: b64('1') }, { path: 'index.html', data: b64('2') }] })).json().error).toBe('duplicate_path');
    expect((await post({ files: [{ path: 'a.html', data: b64('1') }, { path: 'b.html', data: b64('2') }] })).json().error).toBe('bad_entry');
    expect((await post({ entry: 'b.html', files: [{ path: 'a.html', data: b64('1') }, { path: 'b.html', data: b64('2') }] })).statusCode).toBe(201);
    expect((await post({ visibility: 'secret', ...page('x') })).json().error).toBe('bad_visibility');
  });
});

describe('isolation of published pages', () => {
  it('runs every page sandboxed in an opaque origin, limited to its own folder', async () => {
    const { api, content } = server();
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('<script>x</script>') })).json();
    const b = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('other') })).json();
    const res = await content.inject({ method: 'GET', url: pathOf(a.url) });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toBe(artifactPolicy(`${PUBLIC}/${a.id}/`));
    expect(csp).toMatch(/^sandbox allow-scripts /);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain(b.id);
    expect(csp).toContain(`connect-src ${PUBLIC}/${a.id}/;`);
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/https:(?!\/\/artifacts\.test\/)/);
  });

  it('sets no cookie, lets a sandboxed page read its own files and sends the hardening headers', async () => {
    const { api, content } = server();
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('x') })).json();
    for (const url of [pathOf(a.url), '/nothing-here']) {
      const res = await content.inject({ method: 'GET', url, headers: { origin: 'https://evil.test', cookie: 'session=1' } });
      expect(res.headers['set-cookie']).toBeUndefined();
      // The page's origin is opaque, so its own data.json is a cross-origin read; nothing is credentialed.
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(String(res.headers['content-security-policy'])).toContain('sandbox');
    }
  });

  it('serves an unknown type as a download, never rendered', async () => {
    const { api, content } = server();
    const files = [{ path: 'index.html', data: b64('x') }, { path: 'tool.exe', data: b64('MZ') }];
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { files } })).json();
    const res = await content.inject({ method: 'GET', url: `/${a.id}/tool.exe` });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''tool.exe");
  });

  it('keeps unlisted pages out of search engines, and lets public ones in', async () => {
    const { api, content } = server();
    const hidden = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('x') })).json();
    const shown = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { visibility: 'public', ...page('y') } })).json();
    expect((await content.inject({ method: 'GET', url: pathOf(hidden.url) })).headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await content.inject({ method: 'GET', url: pathOf(shown.url) })).headers['x-robots-tag']).toBeUndefined();
  });

  it('serves nothing but published files on the content origin', async () => {
    const { api, content } = server();
    await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: page('x') });
    expect((await content.inject({ method: 'GET', url: '/v1/artifacts' })).statusCode).toBe(404);
    expect((await content.inject({ method: 'GET', url: '/meta/x.json' })).statusCode).toBe(404);
    expect((await content.inject({ method: 'POST', url: '/anything' })).statusCode).toBe(404);
  });
});

describe('files', () => {
  it('names types by extension, and anything else is a download', () => {
    expect(contentType('a/b.HTML')).toBe('text/html; charset=utf-8');
    expect(contentType('x.woff2')).toBe('font/woff2');
    expect(contentType('Makefile')).toBe('application/octet-stream');
    expect(contentType('.png')).toBe('application/octet-stream');
  });

  it('accepts plain relative paths only', () => {
    expect(pathProblem('a/b/c.html')).toBeNull();
    expect(pathProblem('a b/é.png')).toBeNull();
    expect(pathProblem('x\u0000.html')).toMatch(/control character/);
    expect(pathProblem('a/'.repeat(16) + 'x')).toMatch(/folders deep/);
  });

  it('makes unguessable ids', () => {
    const ids = new Set(Array.from({ length: 200 }, randomId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
  });
});

describe('disk storage', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses a key that would leave its folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nekko-artifacts-'));
    const storage = new DiskStorage(join(dir, 'data'));
    for (const key of ['../outside', 'objects/../../outside', 'a/../../b']) {
      await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(/outside the data folder/);
      await expect(storage.get(key)).rejects.toThrow(/outside the data folder/);
      await expect(storage.deletePrefix(`${key}/`)).rejects.toThrow(/outside the data folder/);
    }
    await expect(storage.get('objects/ok')).resolves.toBeNull();
  });

  it('publishes and serves through a real folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nekko-artifacts-'));
    const { api, content, storage } = server({}, new DiskStorage(dir));
    const files = [{ path: 'index.html', data: b64('hi') }, { path: 'css/site.css', data: b64('body{}') }];
    const a = (await api.inject({ method: 'POST', url: '/v1/artifacts', headers: auth(), payload: { files } })).json();
    expect((await storage.list(`objects/${a.id}/`)).sort()).toEqual([`objects/${a.id}/1/css/site.css`, `objects/${a.id}/1/index.html`]);
    expect((await content.inject({ method: 'GET', url: `/${a.id}/css/site.css` })).body).toBe('body{}');
    await api.inject({ method: 'DELETE', url: `/v1/artifacts/${a.id}`, headers: auth() });
    expect(await storage.list('objects/')).toEqual([]);
    expect(await storage.get(`meta/${a.id}.json`)).toBeNull();
  });
});
