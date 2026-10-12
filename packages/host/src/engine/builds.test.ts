import { describe, expect, it } from 'vitest';
import type { GpuStats } from '@nekko-agent/shared';
import { buildsFor, cudaUpgrade, hasBinaries, matchAsset, matchCompanion, recommendedBuild } from './builds.js';

/**
 * Picking the wrong build is the most expensive mistake this feature can make:
 * several hundred megabytes downloaded, then a server that will not start. The
 * rule under test is that acceleration is only chosen where there is evidence
 * for it, and CPU is the fallback rather than an afterthought.
 */

const nvidia: GpuStats = {
  source: 'nvidia-smi',
  devices: [{ name: 'RTX 5090', memoryTotalMB: 32607, memoryUsedMB: 1000, memoryFreeMB: 31607 }],
  totalMB: 32607,
  usedMB: 1000,
  freeMB: 31607,
};

const apple: GpuStats = {
  source: 'ioreg',
  devices: [{ name: 'Apple M1 Max', memoryTotalMB: 65536, memoryUsedMB: 20000, memoryFreeMB: 45536 }],
  totalMB: 65536,
  usedMB: 20000,
  freeMB: 45536,
  unified: true,
};

const noGpu: GpuStats = { source: 'none', devices: [], totalMB: 0, usedMB: 0, freeMB: 0 };

describe('build selection', () => {
  it('picks Vulkan, not CUDA, on Windows with an NVIDIA reading', () => {
    // CUDA's build and runtime are about 550 MB against Vulkan's 30 MB; CUDA is
    // the opt-in upgrade once Vulkan runs (cudaUpgrade).
    expect(recommendedBuild('win32', 'x64', nvidia)?.backend).toBe('vulkan');
    expect(recommendedBuild('linux', 'x64', nvidia)?.backend).toBe('vulkan');
  });

  it('does not pick CUDA on Windows without one', () => {
    expect(recommendedBuild('win32', 'x64', noGpu)?.backend).toBe('cpu');
  });

  it('picks Vulkan for a GPU it cannot identify as NVIDIA', () => {
    // An `ioreg`-sourced or otherwise unlabelled device is evidence of a GPU, not
    // evidence of CUDA, and guessing CUDA here downloads a build that cannot run.
    const unknownGpu: GpuStats = { ...apple, source: 'none', unified: false };
    expect(recommendedBuild('win32', 'x64', unknownGpu)?.backend).toBe('vulkan');
  });

  it('picks Metal on Apple Silicon', () => {
    expect(recommendedBuild('darwin', 'arm64', apple)?.backend).toBe('metal');
  });

  it('offers nothing for a platform llama.cpp does not publish for', () => {
    expect(buildsFor('linux', 'mips', nvidia)).toEqual([]);
    expect(recommendedBuild('linux', 'mips', nvidia)).toBeUndefined();
  });

  it('still lists the other builds so the choice can be overridden', () => {
    const backends = buildsFor('win32', 'x64', nvidia).map((b) => b.backend);
    expect(backends).toContain('vulkan');
    expect(backends).toContain('cpu');
    expect(backends.slice(0, 2)).toEqual(['vulkan', 'cuda']);
  });
});

describe('the CUDA upgrade', () => {
  it('is offered to an NVIDIA machine running a managed non-CUDA build', () => {
    expect(cudaUpgrade('win32', 'x64', nvidia, 'vulkan')?.id).toBe('win-x64-cuda');
    expect(cudaUpgrade('linux', 'x64', nvidia, 'cpu')?.id).toBe('linux-x64-cuda');
  });

  it('is not offered without an NVIDIA reading, on CUDA already, or with nothing installed', () => {
    expect(cudaUpgrade('win32', 'x64', noGpu, 'vulkan')).toBeUndefined();
    expect(cudaUpgrade('win32', 'x64', { ...apple, source: 'none', unified: false }, 'vulkan')).toBeUndefined();
    expect(cudaUpgrade('win32', 'x64', nvidia, 'cuda')).toBeUndefined();
    expect(cudaUpgrade('win32', 'x64', nvidia, undefined)).toBeUndefined();
    expect(cudaUpgrade('darwin', 'arm64', nvidia, 'cpu')).toBeUndefined();
  });
});

describe('asset matching', () => {
  // Names copied from a real llama.cpp release, including the traps: the same
  // accelerator published for two architectures, CUDA runtime archives per
  // toolkit version, and a marker release that carries no binaries at all.
  const assets = [
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'cudart-llama-bin-win-cuda-13.4-arm64.zip',
    'cudart-llama-bin-win-cuda-13.4-x64.zip',
    'llama-b10996-bin-macos-arm64.tar.gz',
    'llama-b10996-bin-macos-x64.tar.gz',
    'llama-b10996-bin-ubuntu-cuda-13.3-x64.tar.gz',
    'llama-b10996-bin-ubuntu-vulkan-x64.tar.gz',
    'llama-b10996-bin-ubuntu-x64.tar.gz',
    'llama-b10996-bin-win-cpu-arm64.zip',
    'llama-b10996-bin-win-cpu-x64.zip',
    'llama-b10996-bin-win-cuda-12.4-x64.zip',
    'llama-b10996-bin-win-cuda-13.4-arm64.zip',
    'llama-b10996-bin-win-cuda-13.4-x64.zip',
    'llama-b10996-bin-win-vulkan-x64.zip',
    'llama-b10996-xcframework.zip',
  ];

  const buildFor = (platform: 'win32' | 'darwin' | 'linux', arch: string, backend: string) =>
    buildsFor(platform, arch, nvidia).find((b) => b.backend === backend)!;

  it('matches the build regardless of the release tag', () => {
    expect(matchAsset(buildFor('win32', 'x64', 'cuda'), assets)).toBe('llama-b10996-bin-win-cuda-13.4-x64.zip');
  });

  it('never picks an archive for the wrong architecture', () => {
    // `bin-win-cuda` matches the arm64 archive too; downloading it on an x64 box
    // is 143 MB of something that cannot run.
    expect(matchAsset(buildFor('win32', 'x64', 'cuda'), assets)).toContain('-x64');
    expect(matchAsset(buildFor('win32', 'arm64', 'cuda'), assets)).toBe('llama-b10996-bin-win-cuda-13.4-arm64.zip');
    expect(matchAsset(buildFor('win32', 'arm64', 'cpu'), assets)).toBe('llama-b10996-bin-win-cpu-arm64.zip');
  });

  it('compares CUDA toolkit versions numerically, not as strings', () => {
    // A string sort puts cuda-9 above cuda-13.
    const twoDigit = ['llama-b1-bin-win-cuda-9.0-x64.zip', 'llama-b1-bin-win-cuda-13.4-x64.zip'];
    expect(matchAsset(buildFor('win32', 'x64', 'cuda'), twoDigit)).toContain('13.4');
  });

  it('does not mistake the CUDA runtime archive for the build', () => {
    expect(matchAsset(buildFor('win32', 'x64', 'cuda'), assets)).not.toMatch(/^cudart-/);
  });

  it('pairs the runtime archive with the toolkit the build was compiled against', () => {
    // A CUDA 13 runtime beside a CUDA 12 build does not start, so the companion
    // is derived from the chosen asset rather than picked on its own.
    const build = buildFor('win32', 'x64', 'cuda');
    expect(matchCompanion(build, 'llama-b10996-bin-win-cuda-12.4-x64.zip', assets)).toBe(
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
    );
    expect(matchCompanion(build, 'llama-b10996-bin-win-cuda-13.4-x64.zip', assets)).toBe(
      'cudart-llama-bin-win-cuda-13.4-x64.zip',
    );
  });

  it('never pairs a Windows build with the Linux runtime of the same toolkit', () => {
    // The real b11224 release, in the order GitHub lists it. The Ubuntu runtime
    // shares the `cuda-13.4-x64` tail with the Windows one and comes first, and
    // picking it left Windows with `.so` files: llama-server started, found no
    // CUDA device, and ran every model on the CPU without saying so.
    const release = [
      'cudart-llama-b11224-bin-ubuntu-cuda-12.8-x64.tar.gz',
      'cudart-llama-b11224-bin-ubuntu-cuda-13.4-arm64.tar.gz',
      'cudart-llama-b11224-bin-ubuntu-cuda-13.4-x64.tar.gz',
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-13.4-arm64.zip',
      'cudart-llama-bin-win-cuda-13.4-x64.zip',
      'llama-b11224-bin-ubuntu-cuda-12.8-x64.tar.gz',
      'llama-b11224-bin-ubuntu-cuda-13.4-arm64.tar.gz',
      'llama-b11224-bin-ubuntu-cuda-13.4-x64.tar.gz',
      'llama-b11224-bin-win-cuda-12.4-x64.zip',
      'llama-b11224-bin-win-cuda-13.4-arm64.zip',
      'llama-b11224-bin-win-cuda-13.4-x64.zip',
    ];
    const win = buildFor('win32', 'x64', 'cuda');
    const winAsset = matchAsset(win, release)!;
    expect(winAsset).toBe('llama-b11224-bin-win-cuda-13.4-x64.zip');
    expect(matchCompanion(win, winAsset, release)).toBe('cudart-llama-bin-win-cuda-13.4-x64.zip');
    expect(matchCompanion(win, 'llama-b11224-bin-win-cuda-12.4-x64.zip', release)).toBe(
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
    );
    const winArm = buildFor('win32', 'arm64', 'cuda');
    expect(matchCompanion(winArm, 'llama-b11224-bin-win-cuda-13.4-arm64.zip', release)).toBe(
      'cudart-llama-bin-win-cuda-13.4-arm64.zip',
    );

    // And the other way round: Linux keeps its own runtime.
    const linux = buildFor('linux', 'x64', 'cuda');
    const linuxAsset = matchAsset(linux, release)!;
    expect(linuxAsset).toBe('llama-b11224-bin-ubuntu-cuda-13.4-x64.tar.gz');
    expect(matchCompanion(linux, linuxAsset, release)).toBe('cudart-llama-b11224-bin-ubuntu-cuda-13.4-x64.tar.gz');
  });

  it('finds no companion rather than one for another platform', () => {
    // Missing is recoverable (install refuses with a clear message); wrong is a
    // working-looking engine that never touches the GPU.
    const win = buildFor('win32', 'x64', 'cuda');
    const linuxOnly = ['cudart-llama-b11224-bin-ubuntu-cuda-13.4-x64.tar.gz'];
    expect(matchCompanion(win, 'llama-b11224-bin-win-cuda-13.4-x64.zip', linuxOnly)).toBeUndefined();
  });

  it('asks for no companion where the build needs none', () => {
    const vulkan = buildFor('win32', 'x64', 'vulkan');
    expect(matchCompanion(vulkan, 'llama-b10996-bin-win-vulkan-x64.zip', assets)).toBeUndefined();
  });

  it('matches the macOS and Linux tarballs, not just zips', () => {
    expect(matchAsset(buildFor('darwin', 'arm64', 'metal'), assets)).toBe('llama-b10996-bin-macos-arm64.tar.gz');
    expect(matchAsset(buildFor('linux', 'x64', 'cpu'), assets)).toBe('llama-b10996-bin-ubuntu-x64.tar.gz');
    expect(matchAsset(buildFor('linux', 'x64', 'cuda'), assets)).toBe('llama-b10996-bin-ubuntu-cuda-13.3-x64.tar.gz');
  });

  it('returns nothing when the release has no build for us', () => {
    const metal = buildFor('darwin', 'arm64', 'metal');
    expect(matchAsset(metal, ['llama-b10996-bin-win-cpu-x64.zip'])).toBeUndefined();
  });

  it('recognises a marker release as carrying no binaries', () => {
    // `releases/latest` is exactly this, which is why we scan past it.
    expect(hasBinaries(['nightly-tag.txt'])).toBe(false);
    expect(hasBinaries(assets)).toBe(true);
  });
});
