// Real daemon routes, isolated profile, no provider or user data. The native
// tool mutation/approval tests live in crates/nekko-tools/tests/recovery.rs.
// Usage: node scripts/itest-file-recovery.mjs [path/to/nekkod]
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNekkod } from './itest-nekkod.mjs';

const root = mkdtempSync(join(tmpdir(), 'nekko-file-recovery-'));
const file = join(root, 'source.txt');
let daemon;
let checks = 0;
const pass = (name) => { checks++; console.log(`PASS ${name}`); };
const start = () => startNekkod({
  nekkod: process.argv[2], root, label: 'file-recovery',
  // No configured providers, accounts, connectors, watches or remote services.
  env: { APPDATA: join(root, 'home'), LOCALAPPDATA: join(root, 'home') },
});
try {
  daemon = await start();
  const saved = await daemon.call('session:create');
  const id = saved.id;
  assert.equal(typeof id, 'string');
  const sidecar = join(daemon.dataDir, 'changes', `${id}.json`);
  writeFileSync(file, 'original\r\nα');
  await daemon.call('changes:record', id, file);
  writeFileSync(file, 'changed');
  assert.equal(existsSync(sidecar), true);
  await daemon.stop();
  daemon = await start();
  const changes = await daemon.call('changes:list', id);
  assert.deepEqual(changes, [{ path: file, original: 'original\r\nα', current: 'changed' }]);
  pass('original survives actual daemon restart');

  await daemon.call('changes:accept', id, file);
  assert.equal(existsSync(sidecar), false);
  assert.deepEqual(await daemon.call('changes:list', id), []);
  pass('accept removes durable original');

  await daemon.call('changes:record', id, file);
  await daemon.call('session:setOptions', id, { incognito: true });
  assert.equal(existsSync(sidecar), false);
  writeFileSync(file, 'private');
  await daemon.call('changes:record', id, file);
  writeFileSync(file, 'private edit');
  assert.equal(existsSync(sidecar), false);
  assert.equal((await daemon.call('changes:list', id))[0].original, 'private');
  await daemon.stop();
  daemon = await start();
  assert.deepEqual(await daemon.call('changes:list', id), []);
  pass('incognito discards saved original and remains memory-only across restart');

  await daemon.call('session:setOptions', id, { incognito: false });
  await daemon.call('changes:record', id, file);
  await daemon.call('session:delete', id);
  assert.equal(existsSync(sidecar), false);
  assert.deepEqual(await daemon.call('changes:list', id), []);
  await assert.rejects(daemon.call('changes:record', id, file), /deleted/);
  pass('deletion removes sidecar and rejects recreation');

  const corrupt = await daemon.call('session:create');
  await daemon.call('changes:record', corrupt.id, file);
  const snapshot = join(daemon.dataDir, 'changes', `${corrupt.id}.json`);
  writeFileSync(snapshot, 'invalid snapshot');
  await daemon.stop();
  daemon = await start();
  await assert.rejects(daemon.call('changes:list', corrupt.id), /snapshot/);
  await daemon.call('changes:acceptAll', corrupt.id);
  assert.equal(existsSync(snapshot), false);
  pass('corrupt snapshot fails visibly and explicit accept-all clears it');
  console.log(`${checks} recovery journeys passed`);
} finally {
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
}
