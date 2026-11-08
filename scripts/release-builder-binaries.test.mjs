import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseRequest, fetchAsset, startMirror } from './release-builder-binaries.mjs';

const bytes = Buffer.from('nsis archive fixture');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const meta = { tag_name: 'nsis-3.0.4.1', assets: [{ id: 7, name: 'nsis-3.0.4.1.7z', size: bytes.length, digest }] };
const fake = (overrides = {}) => async url => {
  if (url.endsWith('/releases/tags/nsis-3.0.4.1')) return new Response(JSON.stringify({ ...meta, ...overrides }));
  if (url.endsWith('/releases/assets/7')) return new Response(bytes);
  return new Response('', { status: 404 });
};

test('parses only plain /<release>/<file> paths', () => {
  assert.deepEqual(parseRequest('/nsis-3.0.4.1/nsis-3.0.4.1.7z'), { release: 'nsis-3.0.4.1', file: 'nsis-3.0.4.1.7z' });
  assert.deepEqual(parseRequest('/icons%401.2.3/icons-bundle.tar.gz'), { release: 'icons@1.2.3', file: 'icons-bundle.tar.gz' });
  for (const bad of ['/', '/a', '/a/b/c', '/../x', '/a/..%2Fb', '/a/%2e%2e', '/.x/y']) assert.equal(parseRequest(bad), null, bad);
});

test('returns the asset bytes when size and digest match', async () => {
  assert.deepEqual(await fetchAsset({ release: 'nsis-3.0.4.1', file: 'nsis-3.0.4.1.7z', request: fake() }), bytes);
});

test('fails closed on a wrong digest, size, release or missing asset', async () => {
  const args = { release: 'nsis-3.0.4.1', file: 'nsis-3.0.4.1.7z' };
  await assert.rejects(fetchAsset({ ...args, request: fake({ assets: [{ ...meta.assets[0], digest: 'sha256:00' }] }) }), /digest/);
  await assert.rejects(fetchAsset({ ...args, request: fake({ assets: [{ ...meta.assets[0], size: 1 }] }) }), /size/);
  await assert.rejects(fetchAsset({ ...args, request: fake({ tag_name: 'other' }) }), /identity/);
  await assert.rejects(fetchAsset({ ...args, file: 'missing.7z', request: fake() }), /Missing/);
});

test('serves verified bytes over HTTP, 502 on failure, 404 on bad paths', async () => {
  const server = await startMirror({ request: fake() });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/nsis-3.0.4.1/nsis-3.0.4.1.7z`);
    assert.equal(ok.status, 200);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), bytes);
    assert.equal((await fetch(`${base}/nsis-3.0.4.1/missing.7z`)).status, 502);
    assert.equal((await fetch(`${base}/a/b/c`)).status, 404);
  } finally { server.close(); }
});
