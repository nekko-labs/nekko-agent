import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureVcRuntime, isMissingDllExit, missingDllMessage, VC_RUNTIME_DLLS } from './vc-runtime.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

/** An engine folder, the app's runtime folder, and a fake System32. */
async function machine(system: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'nekko-vcrt-'));
  dirs.push(root);
  const bin = join(root, 'engine');
  const runtime = join(root, 'resources-bin');
  const sys = join(root, 'System32');
  for (const d of [bin, runtime, sys]) await mkdir(d, { recursive: true });
  for (const dll of VC_RUNTIME_DLLS) await writeFile(join(runtime, dll), `app ${dll}`);
  for (const dll of system) await writeFile(join(sys, dll), `system ${dll}`);
  return { bin, runtime, sys };
}

describe('the Visual C++ runtime beside an engine', () => {
  it('copies the whole set when Windows has no redistributable', async () => {
    const m = await machine([]);
    const copied = await ensureVcRuntime(m.bin, { platform: 'win32', runtimeDir: m.runtime, systemDir: m.sys });
    expect(copied.sort()).toEqual([...VC_RUNTIME_DLLS].sort());
    expect(await readFile(join(m.bin, 'msvcp140.dll'), 'utf8')).toBe('app msvcp140.dll');
    // Run again: everything is already there.
    expect(await ensureVcRuntime(m.bin, { platform: 'win32', runtimeDir: m.runtime, systemDir: m.sys })).toEqual([]);
  });

  it('copies nothing when Windows has the redistributable, so a newer system runtime is not shadowed', async () => {
    const m = await machine(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
    expect(await ensureVcRuntime(m.bin, { platform: 'win32', runtimeDir: m.runtime, systemDir: m.sys })).toEqual([]);
    expect(await readdir(m.bin)).toEqual([]);
  });

  it('treats a partial system install as missing', async () => {
    const m = await machine(['vcruntime140.dll']);
    const copied = await ensureVcRuntime(m.bin, { platform: 'win32', runtimeDir: m.runtime, systemDir: m.sys });
    expect(copied).toContain('msvcp140.dll');
  });

  it('leaves a file the engine already carries alone', async () => {
    const m = await machine([]);
    await writeFile(join(m.bin, 'vcruntime140.dll'), 'engine own');
    await ensureVcRuntime(m.bin, { platform: 'win32', runtimeDir: m.runtime, systemDir: m.sys });
    expect(await readFile(join(m.bin, 'vcruntime140.dll'), 'utf8')).toBe('engine own');
  });

  it('does nothing off Windows or without the app-local copy', async () => {
    const m = await machine([]);
    expect(await ensureVcRuntime(m.bin, { platform: 'linux', runtimeDir: m.runtime, systemDir: m.sys })).toEqual([]);
    expect(await ensureVcRuntime(m.bin, { platform: 'win32', runtimeDir: join(m.runtime, 'nope'), systemDir: m.sys })).toEqual([]);
    expect(await readdir(m.bin)).toEqual([]);
  });

  it('recognises STATUS_DLL_NOT_FOUND however the exit code is printed', () => {
    expect(isMissingDllExit('The server exited with code -1073741515.')).toBe(true);
    expect(isMissingDllExit('The model server exited (code 3221225781).')).toBe(true);
    expect(isMissingDllExit('exit status: 0xc0000135')).toBe(true);
    expect(isMissingDllExit('The server exited with code 1.')).toBe(false);
    expect(isMissingDllExit('code -10737415150')).toBe(false);
    expect(isMissingDllExit(null)).toBe(false);
    expect(missingDllMessage()).toMatch(/Visual C\+\+ Runtime.*aka\.ms.*not need Visual Studio/);
  });
});
