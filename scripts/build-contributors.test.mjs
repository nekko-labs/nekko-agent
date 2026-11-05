import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContributors, writeContributors } from './build-contributors.mjs';

test('mobile contributor tooltips size to their names, with a bounded wrapping width', () => {
  const styles = readFileSync(new URL('../apps/website/styles.css', import.meta.url), 'utf8');
  const mobile = styles.slice(styles.indexOf('@media (max-width: 600px)', styles.indexOf('/* Contributor wall:')));
  assert.match(mobile, /\.contributor-name\s*\{[^}]*width:\s*max-content;/);
  assert.match(mobile, /\.contributor-name\s*\{[^}]*max-width:\s*88px;/);
  assert.match(mobile, /\.contributor-name\s*\{[^}]*overflow-wrap:\s*anywhere;/);
});

const person = (login, extra = {}) => ({ login, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/1?v=4`, ...extra });
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('paginates, excludes bots and unsafe names, deduplicates case-insensitively', async () => {
  const calls = [];
  const people = await loadContributors(async (url, options) => {
    calls.push([url, options]);
    return json(calls.length === 1 ? Array.from({ length: 100 }, (_, i) => person(`person${i}`)) : [person('PERSON0'), person('next'), person('robot', { type: 'Bot' }), person('../bad')]);
  }, 'private-token');
  assert.equal(people.length, 101);
  assert.match(calls[1][0], /page=2$/);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer private-token');
  assert.equal(people.at(-1).url, 'https://github.com/next');
});

test('rejects API failures and malformed responses; accepts empty repos', async () => {
  await assert.rejects(loadContributors(async () => new Response('', { status: 403 })), /403/);
  await assert.rejects(loadContributors(async () => json({ error: 'bad' })), /Invalid/);
  assert.deepEqual(await loadContributors(async () => new Response(null, { status: 204 })), []);
});

test('caches raster images first-party, never sends token to images, keeps initials on image failure', async () => {
  const site = mkdtempSync(join(tmpdir(), 'nekko-contributors-'));
  const imageCalls = [];
  try {
    await writeContributors(site, { token: 'secret', fetcher: async (url, options) => {
      if (url.startsWith('https://api.github.com/')) return json([person('ok'), person('missing', { avatar_url: 'https://evil.example/a.png' })]);
      imageCalls.push(options);
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    } });
    const data = JSON.parse(readFileSync(join(site, 'contributors.json')));
    assert.match(data.contributors[0].avatar, /^\/contributors\/ok-[a-f0-9]{16}\.png$/);
    const cachedAvatar = join(site, data.contributors[0].avatar.slice(1));
    assert.equal(data.contributors[1].avatar, undefined);
    assert.equal(imageCalls.length, 1);
    assert.equal(imageCalls[0].headers, undefined);
    assert.equal(imageCalls[0].redirect, 'error');
    assert.ok(existsSync(cachedAvatar));
    await writeContributors(site, { fetcher: async () => { throw new Error('offline'); } });
    assert.deepEqual(JSON.parse(readFileSync(join(site, 'contributors.json'))), { available: false, contributors: [] });
    assert.equal(existsSync(cachedAvatar), false);
  } finally { rmSync(site, { recursive: true, force: true }); }
});

test('unsupported image content, oversized avatars and image errors fall back without losing credit', async () => {
  for (const response of [() => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }), () => new Response(new Uint8Array(1_000_001), { headers: { 'content-type': 'image/png' } }), () => new Response('', { status: 404 })]) {
    const site = mkdtempSync(join(tmpdir(), 'nekko-contributors-'));
    try {
      await writeContributors(site, { fetcher: async url => url.startsWith('https://api.github.com/') ? json([person('one')]) : response() });
      const data = JSON.parse(readFileSync(join(site, 'contributors.json')));
      assert.equal(data.contributors.length, 1);
      assert.equal(data.contributors[0].avatar, undefined);
    } finally { rmSync(site, { recursive: true, force: true }); }
  }
});
