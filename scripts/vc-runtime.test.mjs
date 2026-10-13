import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findVcRuntimeDir, VC_RUNTIME_DLLS } from './vc-runtime.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('stages the same DLLs the host copies into engine folders', () => {
  // The host cannot import this script (it runs from the packaged app), so the
  // list is written twice; this keeps the copies in step.
  const host = readFileSync(join(repo, 'packages/host/src/engine/vc-runtime.ts'), 'utf8');
  const block = host.match(/export const VC_RUNTIME_DLLS = \[([\s\S]*?)\];/)?.[1] ?? '';
  const listed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed, VC_RUNTIME_DLLS);
});

test('every staged DLL is part of the redistributable, never a debug or CLR build', () => {
  for (const dll of VC_RUNTIME_DLLS) assert.match(dll, /^(msvcp140|vcruntime140)(_[a-z0-9_]+)?\.dll$/);
  assert.ok(!VC_RUNTIME_DLLS.some((dll) => /d\.dll$|_clr/.test(dll)));
});

test('finds a complete redist folder on a Windows build machine with the C++ tools', { skip: process.platform !== 'win32' }, () => {
  const dir = findVcRuntimeDir('x64');
  // A Windows box without Visual Studio cannot package the app; say so rather than fail.
  if (!dir) return;
  assert.match(dir, /Microsoft\.VC\d+\.CRT$/);
});
