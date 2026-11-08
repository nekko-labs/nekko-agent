import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { toolsFor, validateInstalledTools, selectToolAsset, seedBuilderTools } from './release-builder-tools.mjs';

const bytes = Buffer.from('official packaging tool fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const item = { release: 'tool@1.0.0', name: 'tool.tar.gz', sha256 };
const asset = { id: 42, name: item.name, size: bytes.length, digest: `sha256:${sha256}` };
const release = { tag_name: item.release, assets: [asset] };
const scratch = async fn => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'builder-tools-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const request = async url => url.includes('/tags/') ? Response.json(release) : new Response(bytes);

test('covers exact native release platforms and rejects others', () => {
  assert.equal(toolsFor('linux', 'x64').length, 4);
  assert.equal(toolsFor('darwin', 'arm64').length, 3);
  assert.equal(toolsFor('win32', 'x64').length, 5);
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'arm64'], ['../linux', 'x64']]) assert.throws(() => toolsFor(platform, arch));
  const all = ['linux/x64', 'darwin/arm64', 'win32/x64'].flatMap(key => toolsFor(...key.split('/')));
  for (const tool of all) assert.match(tool.sha256, /^[a-f0-9]{64}$/);
  const copy = toolsFor('linux', 'x64'); copy[0].name = 'mutated';
  assert.notEqual(toolsFor('linux', 'x64')[0].name, 'mutated');
});

test('pins match installed locked builder sources, including all platform tools', async () => {
  const require = createRequire(import.meta.url);
  for (const key of ['linux/x64', 'darwin/arm64', 'win32/x64']) await validateInstalledTools(require, toolsFor(...key.split('/')));
  const changedVersion = () => ({ version: '26.18.0' });
  await assert.rejects(validateInstalledTools(changedVersion, []), /changed/);
  await assert.rejects(validateInstalledTools(require, [{ ...toolsFor('linux', 'x64')[0], sha256: '0'.repeat(64) }]), /pin changed/);
});

test('requires exact official release and unique positive asset metadata', () => {
  assert.equal(selectToolAsset(release, item).id, 42);
  for (const bad of [{ ...release, draft: true }, { ...release, tag_name: 'tool@2.0.0' }, { ...release, assets: [] }, { ...release, assets: [asset, asset] }, { ...release, assets: [{ ...asset, id: -1 }] }, { ...release, assets: [{ ...asset, size: 1.5 }] }]) assert.throws(() => selectToolAsset(bad, item));
});

test('rejects traversal or missing pins before any HTTP request', () => scratch(async directory => {
  for (const bad of [{ ...item, name: '../tool.7z' }, { ...item, release: '../tag' }, { ...item, release: '..' }, { ...item, name: '.' }, { ...item, sha256: '' }]) {
    await assert.rejects(seedBuilderTools({ tools: [bad], directory, request: () => assert.fail('must not request') }), /Unsafe/);
  }
}));

test('seeds only verified archives into upstream release-name/filename cache layout', () => scratch(async directory => {
  const urls = [];
  await seedBuilderTools({ tools: [item], directory, token: 'test-token', request: async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/electron-userland/electron-builder-binaries/'));
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    urls.push(url); return request(url);
  } });
  assert.equal(urls.length, 2);
  assert.ok(urls[0].endsWith('/tags/tool%401.0.0'));
  assert.deepEqual(await readFile(path.join(directory, item.release, item.name)), bytes);
  await assert.rejects(readFile(path.join(directory, item.release, item.name + '.part')), { code: 'ENOENT' });
}));

test('corruption, size or API digest mismatches fail closed and remove stale/partial archives', () => scratch(async directory => {
  const destination = path.join(directory, item.release, item.name);
  for (const metadata of [{ ...asset, digest: 'sha256:bad' }, { ...asset, size: 1 }, asset]) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'stale');
    const badBytes = metadata === asset ? Buffer.from('corrupt archive') : bytes;
    await assert.rejects(seedBuilderTools({ tools: [item], directory, request: async url => url.includes('/tags/') ? Response.json({ ...release, assets: [metadata] }) : new Response(badBytes) }), /mismatch/);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    await assert.rejects(readFile(destination + '.part'), { code: 'ENOENT' });
  }
}));

test('old assets without API digests still require the upstream pinned checksum', () => scratch(async directory => {
  await seedBuilderTools({ tools: [item], directory, request: async url => url.includes('/tags/') ? Response.json({ ...release, assets: [{ ...asset, digest: null }] }) : new Response(bytes) });
  assert.deepEqual(await readFile(path.join(directory, item.release, item.name)), bytes);
}));

test('HTTP failures are actionable with no retry loop or browser fallback', () => scratch(async directory => {
  let calls = 0;
  await assert.rejects(seedBuilderTools({ tools: [item], directory, request: async () => { calls++; return new Response('', { status: 504 }); } }), /HTTP 504/);
  assert.equal(calls, 1);
}));

test('workflow loads current tools, seeds before packaging and keeps signing gates', async () => {
  const require = createRequire(import.meta.url);
  const workflow = require('js-yaml').load(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.release.steps;
  assert.match(steps.find(s => s.name === 'Check out release tooling').with['sparse-checkout'], /scripts\/release-builder-tools\.mjs/);
  const seed = steps.findIndex(s => s.name === 'Download and verify packaging tools');
  assert.ok(seed > steps.findIndex(s => s.run === 'npm ci'));
  assert.ok(seed < steps.findIndex(s => s.name === 'Build and publish installers'));
  assert.equal(steps[seed].run, 'node .release-tools/scripts/release-builder-tools.mjs');
  assert.equal(workflow.jobs['publish-release'].needs, 'release');
  assert.ok(steps.some(s => s.name === 'Verify the signed app'));
  assert.ok(steps.some(s => s.name === 'Verify the signed installer'));
});
