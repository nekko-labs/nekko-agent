import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { archiveName, selectAssets, expectedChecksum, verifyArchive, downloadElectron } from './release-electron.mjs';

const bytes = Buffer.from('official archive fixture');
const digest = createHash('sha256').update(bytes).digest('hex');
const name = archiveName('45.0.0', 'linux', 'x64');
const sums = Buffer.from(`${digest} *${name}\n`);
const release = { tag_name: 'v45.0.0', assets: [
  { id: 1, name, size: bytes.length, digest: `sha256:${digest}` },
  { id: 2, name: 'SHASUMS256.txt', size: sums.length },
] };
const scratch = async fn => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'release-electron-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('names supported platform archives and rejects unsafe input', () => {
  assert.equal(archiveName('45.0.0', 'darwin', 'arm64'), 'electron-v45.0.0-darwin-arm64.zip');
  assert.equal(archiveName('45.0.0', 'win32', 'x64'), 'electron-v45.0.0-win32-x64.zip');
  for (const args of [['../45', 'linux', 'x64'], ['45.0.0', '../linux', 'x64'], ['45.0.0', 'linux', 'ia32']]) assert.throws(() => archiveName(...args));
});
test('requires matching official release and unique existing assets', () => {
  assert.equal(selectAssets(release, '45.0.0', name)[0].id, 1);
  for (const r of [{ ...release, tag_name: 'v44.0.0' }, { ...release, draft: true }, { ...release, assets: [] }, { ...release, assets: [...release.assets, release.assets[0]] }]) assert.throws(() => selectAssets(r, '45.0.0', name));
});
test('checksum lookup is exact and unambiguous', () => {
  assert.equal(expectedChecksum(sums.toString(), name), digest);
  assert.throws(() => expectedChecksum(sums.toString(), name + '.other'));
  assert.throws(() => expectedChecksum(sums.toString().repeat(2), name));
});
test('verifies size, checksum and optional GitHub digest', () => scratch(async dir => {
  const file = path.join(dir, 'archive.zip');
  await writeFile(file, bytes);
  assert.equal(await verifyArchive(file, release.assets[0], digest), digest);
  for (const asset of [{ ...release.assets[0], size: 1 }, { ...release.assets[0], digest: 'sha256:bad' }]) await assert.rejects(verifyArchive(file, asset, digest));
  await assert.rejects(verifyArchive(file, release.assets[0], '0'.repeat(64)));
}));
test('downloads only official API endpoints and verifies before publishing ZIP', () => scratch(async dir => {
  const urls = [];
  const request = async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/electron/electron/'));
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    urls.push(url);
    return url.endsWith('/tags/v45.0.0') ? Response.json(release) : new Response(url.endsWith('/2') ? sums : bytes);
  };
  const result = await downloadElectron({ version: '45.0.0', platform: 'linux', arch: 'x64', directory: dir, token: 'test-only', request });
  assert.deepEqual(await readFile(result), bytes);
  assert.equal(urls.length, 3);
  await assert.rejects(readFile(result + '.part'), { code: 'ENOENT' });
}));
test('fails closed and removes partial archive on checksum mismatch', () => scratch(async dir => {
  const request = async url => url.endsWith('/tags/v45.0.0') ? Response.json(release) : new Response(url.endsWith('/2') ? sums : Buffer.from('corrupt'));
  await assert.rejects(downloadElectron({ version: '45.0.0', platform: 'linux', arch: 'x64', directory: dir, request }), /mismatch/);
  await assert.rejects(readFile(path.join(dir, name)), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(dir, name + '.part')), { code: 'ENOENT' });
}));
test('reports HTTP failure without retry loops', () => scratch(async dir => {
  let calls = 0;
  await assert.rejects(downloadElectron({ version: '45.0.0', platform: 'linux', arch: 'x64', directory: dir, request: async () => { calls++; return new Response('', { status: 504 }); } }), /HTTP 504/);
  assert.equal(calls, 1);
}));
test('rejects corrupted checksum-file metadata', () => scratch(async dir => {
  const r = structuredClone(release); r.assets[1].digest = 'sha256:bad';
  await assert.rejects(downloadElectron({ version: '45.0.0', platform: 'linux', arch: 'x64', directory: dir,
    request: async url => url.endsWith('/tags/v45.0.0') ? Response.json(r) : new Response(sums) }), /checksum file digest mismatch/);
}));
test('recovery workflow checks out tag source and retains signing/publication gates', async () => {
  const require = createRequire(import.meta.url);
  const yaml = require('js-yaml');
  const text = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const workflow = yaml.load(text);
  assert.equal(workflow.env.RELEASE_TAG, '${{ inputs.release_tag || github.ref_name }}');
  const steps = workflow.jobs.release.steps;
  const validation = steps.find(s => s.name === 'Validate release tag').run;
  // x.xx.xxxx from the 0.10 line (docs/decisions/0080); older 0.x tags still rebuild.
  for (const tag of ['v0.9.5', 'v0.10.1000', 'v0.10.1004', 'v1.12.1003-rc.1']) assert.equal(spawnSync('bash', ['-c', validation], { env: { ...process.env, RELEASE_TAG: tag } }).status, 0, tag);
  for (const tag of ['main', '../v0.9.5', 'v0.9', 'v0.9.5;echo bad', 'v0.9.5\nother', 'v0.10.0', 'v1.0.0', 'v1.2.3-rc.1', 'v0.100.1000']) assert.notEqual(spawnSync('bash', ['-c', validation], { env: { ...process.env, RELEASE_TAG: tag } }).status, 0, tag);
  assert.equal(steps.find(s => s.uses === 'actions/checkout@v7').with.ref, 'refs/tags/${{ env.RELEASE_TAG }}');
  assert.equal(steps.find(s => s.name === 'Check out release tooling').with.ref, '${{ github.sha }}');
  const build = steps.find(s => s.name === 'Build and publish installers');
  assert.match(build.run, /-c\.electronDist=\$ELECTRON_DIST/);
  assert.match(build.run, /-c\.mac\.notarize=true/);
  assert.ok(steps.some(s => s.name === 'Verify the signed app'));
  assert.ok(steps.some(s => s.name === 'Check the virtualization entitlement'));
  assert.equal(workflow.jobs['publish-release'].needs, 'release');
  assert.match(workflow.jobs['publish-release'].steps[0].run, /tag_name=\$RELEASE_TAG/);
  for (const job of ['nekkod-npm', 'publish-web', 'publish-cli']) assert.equal(workflow.jobs[job].if, '${{ !inputs.release_tag }}');
});
