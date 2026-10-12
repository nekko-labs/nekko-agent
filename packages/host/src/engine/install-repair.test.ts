import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createEngineInstaller } from './install.js';
import { createDownloads } from './download.js';
import { RUNTIME_RELEASES } from './runtime-releases.js';

/**
 * A Windows CUDA engine that installed fine, starts fine, and never touches the
 * GPU. Earlier installs paired the Windows build with the Linux CUDA runtime, so
 * `ggml-cuda.dll` could not load and llama.cpp ran every model on the CPU. Chats
 * sat on "working" for minutes per reply and nothing said why. These tests pin
 * the two halves of putting that right without the user knowing what CUDA is:
 * the install is reported as broken, and reinstalling clears the old files.
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function managedCuda(files: string[]) {
  const engineDir = await mkdtemp(join(tmpdir(), 'nekko-repair-')); dirs.push(engineDir);
  const buildDir = join(engineDir, 'win-x64-cuda');
  await mkdir(buildDir, { recursive: true });
  for (const f of files) {
    const path = join(buildDir, f);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'fixture');
  }
  const binPath = join(buildDir, 'llama-server.exe');
  await writeFile(join(engineDir, 'engine.json'), JSON.stringify({ binPath, backend: 'cuda', buildId: 'win-x64-cuda', version: 'b11224', installedAt: 1 }));
  return { engineDir, buildDir };
}

const installerFor = (engineDir: string, extra: Partial<Parameters<typeof createEngineInstaller>[0]> = {}) =>
  createEngineInstaller({ engineDir: () => engineDir, downloads: createDownloads({}), getGpuStats: async () => null, run: async () => null, platform: 'win32', arch: 'x64', ...extra });

describe('a CUDA engine without its runtime', () => {
  it('is reported as a problem with a one-click repair, in words a non-expert can act on', async () => {
    // Exactly what the broken installs look like on disk.
    const { engineDir } = await managedCuda([
      'llama-server.exe',
      'ggml-cuda.dll',
      'cudart-llama-b11224-bin-ubuntu-cuda-13.4-x64/libcublas.so.13',
      'cudart-llama-b11224-bin-ubuntu-cuda-13.4-x64/libcudart.so.13',
    ]);
    const install = await installerFor(engineDir).detect();
    expect(install.binPath).toBeDefined();
    expect(install.problem?.repairBuildId).toBe('win-x64-cuda');
    expect(install.problem?.message).toMatch(/graphics card/);
    expect(install.problem?.message).not.toMatch(/cuda|cublas|dll/i);
  });

  it('is not reported once the Windows runtime is there', async () => {
    const { engineDir } = await managedCuda(['llama-server.exe', 'ggml-cuda.dll', 'cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll']);
    expect((await installerFor(engineDir).detect()).problem).toBeUndefined();
  });

  it('is only a question for managed Windows CUDA builds', async () => {
    const { engineDir } = await managedCuda(['llama-server.exe']);
    // Linux and macOS builds carry their runtime differently; a missing DLL
    // there means nothing.
    expect((await installerFor(engineDir, { platform: 'linux' }).detect()).problem).toBeUndefined();
    await writeFile(join(engineDir, 'engine.json'), JSON.stringify({ binPath: join(engineDir, 'win-x64-cuda', 'llama-server.exe'), backend: 'vulkan', buildId: 'win-x64-vulkan', installedAt: 1 }));
    expect((await installerFor(engineDir).detect()).problem).toBeUndefined();
  });
});

describe('reinstalling a build', () => {
  it('replaces the old folder, stopping the server only once the new build is downloaded', async () => {
    const { engineDir, buildDir } = await managedCuda([
      'llama-server.exe',
      'ggml-cuda.dll',
      'cudart-llama-b11224-bin-ubuntu-cuda-13.4-x64/libcudart.so.13',
    ]);
    const tag = RUNTIME_RELEASES.llama.tag;
    const main = `llama-${tag}-bin-win-cuda-13.4-x64.zip`;
    const runtime = 'cudart-llama-bin-win-cuda-13.4-x64.zip';
    const release = {
      tag_name: tag,
      assets: [
        { name: `cudart-llama-${tag}-bin-ubuntu-cuda-13.4-x64.tar.gz`, browser_download_url: 'https://example.test/linux-runtime.tgz', size: 10 },
        { name: runtime, browser_download_url: 'https://example.test/win-runtime.zip', size: 10 },
        { name: main, browser_download_url: 'https://example.test/main.zip', size: 10 },
      ],
    };
    const requested: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      requested.push(String(url));
      return String(url).includes('api.github.com') ? new Response(JSON.stringify(release)) : new Response('archive bytes');
    }) as typeof fetch;

    // Stand-in for tar: "unpacking" an archive drops the files it would hold.
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== 'tar') return null;
      const archive = args[1]!;
      const dest = args[args.indexOf('-C') + 1]!;
      if (archive.endsWith(main)) for (const f of ['llama-server.exe', 'ggml-cuda.dll']) await writeFile(join(dest, f), 'new');
      if (archive.endsWith(runtime)) for (const f of ['cublas64_13.dll', 'cudart64_13.dll']) await writeFile(join(dest, f), 'new');
      return '';
    });
    const order: string[] = [];
    const beforeReplace = vi.fn(async () => { order.push(`stop:${(await readdir(buildDir)).includes(main)}`); });

    const downloads = createDownloads({ fetch: fetchFn });
    const installer = installerFor(engineDir, { downloads, fetch: fetchFn, run, beforeReplace });
    expect((await installer.detect()).problem).toBeDefined();

    const res = await installer.install('win-x64-cuda');
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(downloads.list()[0]?.state).toBe('done'));

    // The Windows runtime was fetched, never the Linux one.
    expect(requested).toContain('https://example.test/win-runtime.zip');
    expect(requested).not.toContain('https://example.test/linux-runtime.tgz');
    // The server was stopped after the archive arrived, not before.
    expect(order).toEqual(['stop:true']);
    // Nothing of the old install survives, and the result is a healthy engine.
    const after = await readdir(buildDir);
    expect(after).not.toContain('cudart-llama-b11224-bin-ubuntu-cuda-13.4-x64');
    expect(after).toEqual(expect.arrayContaining(['llama-server.exe', 'cublas64_13.dll']));
    expect((await installer.detect()).problem).toBeUndefined();
  });
});
