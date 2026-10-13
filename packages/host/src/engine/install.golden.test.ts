import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, expect, it, vi } from 'vitest';
import type { EnginePlatform, GpuStats } from '@nekko-agent/shared';
import type { GpuAdapter } from '../gpu-adapters.js';
import { parseWindowsAdapters } from '../gpu-adapters.js';
import { allBuilds, buildsFor, cudaSupportFrom, cudaUpgrade, matchAsset, matchCompanion, type CudaSupport } from './builds.js';
import { diffusionBuilds, matchDiffusionAsset, matchDiffusionCompanion } from './diffusion.js';
import { createDownloads } from './download.js';
import { createEngineInstaller } from './install.js';
import { createMlxRuntime } from './mlx.js';
import { RUNTIME_RELEASES } from './runtime-releases.js';

/**
 * Getting a runtime onto the machine (`engine:install`, `engine:uninstall`,
 * `engine:installPreview`, and the `detect` every status read makes) as the
 * TS host does it, which the engine daemon's port (crates/nekko-engine
 * `builds`, `gpu_adapters`, `install`, `mlx`) must reproduce as text, key
 * order included: which builds a machine is offered and in what order, which
 * release assets they are, the OS's adapter list, and the llama.cpp,
 * stable-diffusion.cpp and MLX installers driven through scripted GitHub
 * answers, archive tools and PATH lookups, with every request and command
 * they make and the files they leave. Paths are recorded below `<root>` with
 * `/` separators. Writes crates/nekko-engine/tests/golden/install.json;
 * fails if it is stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-engine', 'tests', 'golden', 'install.json');
const NOW = 1_700_000_000_000;

function norm(root: string, v: unknown): unknown {
  if (typeof v === 'string') return v.split(root).join('<root>').replace(/\\/g, '/');
  if (Array.isArray(v)) return v.map((x) => norm(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, norm(root, x)]));
  return v;
}

function denorm(root: string, v: unknown): unknown {
  if (typeof v === 'string') return v.split('<root>').join(root);
  if (Array.isArray(v)) return v.map((x) => denorm(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, denorm(root, x)]));
  return v;
}

const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/* ------------------------------------------------------------- the builds */

const nvidia = (devices = 1): GpuStats => ({
  source: 'nvidia-smi',
  devices: Array.from({ length: devices }, (_, i) => ({ name: `RTX ${i}`, memoryTotalMB: 24_000, memoryUsedMB: 1000, memoryFreeMB: 23_000 })),
  totalMB: 24_000 * devices,
  usedMB: 1000 * devices,
  freeMB: 23_000 * devices,
});
const GPUS: Record<string, GpuStats | null> = {
  none: null,
  nvidia: nvidia(),
  nvidiaEmpty: nvidia(0),
  other: { ...nvidia(), source: 'llama-server' as never },
};
const ADAPTERS: Record<string, GpuAdapter[]> = { none: [], amd: [{ vendor: 'amd', name: 'Radeon' }], other: [{ vendor: 'other', name: 'Mystery' }] };
const CUDA: Record<string, CudaSupport | undefined> = {
  unknown: undefined,
  yes: { supported: true },
  no: { supported: false, reason: 'The NVIDIA driver here is older than 580; update it to run the CUDA build.' },
};

const TAG = RUNTIME_RELEASES.llama.tag;
const LLAMA_ASSETS = [
  `llama-${TAG}-bin-win-cuda-12.4-x64.zip`,
  `llama-${TAG}-bin-win-cuda-13.4-x64.zip`,
  `llama-${TAG}-bin-win-cuda-13.4-arm64.zip`,
  `llama-${TAG}-bin-win-cuda-9.1-x64.zip`,
  `llama-${TAG}-bin-win-vulkan-x64.zip`,
  `llama-${TAG}-bin-win-cpu-x64.zip`,
  `llama-${TAG}-bin-win-cpu-arm64.zip`,
  `llama-${TAG}-bin-win-rocm-x64.zip`,
  `llama-${TAG}-bin-macos-arm64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-arm64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-rocm-x64.tar.gz`,
  `cudart-llama-bin-win-cuda-12.4-x64.zip`,
  `cudart-llama-bin-win-cuda-13.4-x64.zip`,
  `cudart-llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  'llama-latest.txt',
  `llama-${TAG}-xcframework.zip`,
];
const SD_ASSETS = [
  'sd-master-929-3f8527a-bin-win-cuda12-x64.zip',
  'sd-master-929-3f8527a-bin-win-vulkan-x64.zip',
  'sd-master-929-3f8527a-bin-win-cpu-x64.zip',
  'sd-master-929-3f8527a-bin-win-rocm-6.4-x64.zip',
  'sd-master-929-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip',
  'sd-master-929-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
  'sd-master-929-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-rocm-6.4.zip',
  'sd-master-929-3f8527a-bin-Darwin-macOS-15.6-arm64.zip',
  'cudart-sd-bin-win-cu12-x64.zip',
];

/* ------------------------------------------------------- the installers */

type Reply = { status: number; body?: string } | 'throw';

interface Scenario {
  name: string;
  runtime: 'llama' | 'diffusion';
  platform: EnginePlatform | 'freebsd';
  arch: string;
  gpu: keyof typeof GPUS;
  adapters?: keyof typeof ADAPTERS;
  /** Files below `<root>` before the first op. */
  files?: Record<string, string>;
  external?: string;
  /** What `where`/`which` prints, per server name. */
  onPath?: Record<string, string>;
  smi?: string;
  versionOut?: string;
  /** GitHub and asset answers, by URL. */
  http: Record<string, Reply>;
  /** What unpacking each archive (by file name) leaves, below the destination; absent means every tool fails. */
  archives?: Record<string, string[]>;
  ops: Array<{ op: 'detect' | 'preview' | 'install' | 'uninstall' | 'installedBin'; buildId?: string }>;
}

const API = (repo: string, tag: string) => `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
const release = (tag: string, assets: Array<[string, string, string?]>) =>
  JSON.stringify({
    tag_name: tag,
    assets: [
      ...assets.map(([name, body, digest]) => ({ name, browser_download_url: `https://dl.test/${name}`, size: body.length, ...(digest ? { digest } : {}) })),
      { name: 'no-url.zip', size: 3 },
      { name: 'zero-size.zip', browser_download_url: 'https://dl.test/zero', size: 0 },
    ],
  });
const asset = (name: string, body: string): [string, Reply] => [`https://dl.test/${name}`, { status: 200, body }];

const WIN_CUDA = `llama-${TAG}-bin-win-cuda-13.4-x64.zip`;
const WIN_CUDART = 'cudart-llama-bin-win-cuda-13.4-x64.zip';
const WIN_CPU = `llama-${TAG}-bin-win-cpu-x64.zip`;
const WIN_VULKAN = `llama-${TAG}-bin-win-vulkan-x64.zip`;
const LLAMA_API = API(RUNTIME_RELEASES.llama.repo, TAG);
const fullRelease = release(TAG, [
  [`llama-${TAG}-bin-win-cuda-12.4-x64.zip`, 'old cuda'],
  [WIN_CUDA, 'cuda archive', sha('cuda archive')],
  [WIN_CUDART, 'cuda runtime', sha('cuda runtime')],
  [`cudart-llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`, 'linux runtime'],
  [WIN_VULKAN, 'vulkan archive', sha('vulkan archive')],
  [WIN_CPU, 'cpu archive'],
  [`llama-${TAG}-bin-ubuntu-x64.tar.gz`, 'linux cpu'],
]);
const fullHttp: Record<string, Reply> = Object.fromEntries([
  [LLAMA_API, { status: 200, body: fullRelease }],
  asset(WIN_CUDA, 'cuda archive'),
  asset(WIN_CUDART, 'cuda runtime'),
  asset(WIN_VULKAN, 'vulkan archive'),
  asset(WIN_CPU, 'cpu archive'),
  asset(`llama-${TAG}-bin-ubuntu-x64.tar.gz`, 'linux cpu'),
]);
const cudaArchives = { [WIN_CUDA]: ['llama-server.exe', 'ggml-cuda.dll'], [WIN_CUDART]: ['cublas64_13.dll', 'cudart64_13.dll'], [WIN_VULKAN]: ['build/bin/llama-server.exe', 'build/bin/ggml-vulkan.dll'], [WIN_CPU]: ['llama-server.exe'] };

const SCENARIOS: Scenario[] = [
  {
    name: 'windows nvidia: install CUDA, then remove it',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'nvidia', smi: '8.9, 581.42\n8.6, 581.42\n',
    http: fullHttp, archives: cudaArchives,
    ops: [{ op: 'detect' }, { op: 'preview' }, { op: 'preview', buildId: 'win-x64-vulkan' }, { op: 'preview', buildId: 'nope' }, { op: 'install' }, { op: 'detect' }, { op: 'installedBin' }, { op: 'uninstall' }, { op: 'detect' }, { op: 'uninstall' }],
  },
  {
    name: 'windows nvidia too old for CUDA: Vulkan first, and nested binaries',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'nvidia', smi: '6.1, 581.42',
    http: fullHttp, archives: cudaArchives,
    ops: [{ op: 'detect' }, { op: 'install' }, { op: 'detect' }],
  },
  {
    name: 'a managed CUDA build missing its runtime, and a Vulkan build with a CUDA upgrade',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'nvidia', smi: 'garbage',
    files: {
      'engine/win-x64-cuda/llama-server.exe': 'x',
      'engine/win-x64-cuda/ggml-cuda.dll': 'x',
      'engine/win-x64-vulkan/llama-server.exe': 'x',
      'engine/engine.json': JSON.stringify({ binPath: '<root>/engine/win-x64-cuda/llama-server.exe', backend: 'cuda', buildId: 'win-x64-cuda', version: TAG, installedAt: 5 }),
    },
    http: fullHttp,
    ops: [{ op: 'detect' }],
  },
  {
    name: 'a Vulkan install on a CUDA-capable card',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'nvidia', smi: '12.0, 590.1',
    files: {
      'engine/win-x64-vulkan/llama-server.exe': 'x',
      'engine/engine.json': JSON.stringify({ binPath: '<root>/engine/win-x64-vulkan/llama-server.exe', backend: 'vulkan', buildId: 'win-x64-vulkan', installedAt: 5 }),
    },
    http: fullHttp,
    ops: [{ op: 'detect' }, { op: 'uninstall' }],
  },
  {
    name: 'a binary the user pointed at, and one on PATH',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'none', adapters: 'amd',
    files: { 'mine/llama-server.exe': 'x', 'path/llama-server.exe': 'x' },
    external: '<root>/mine/llama-server.exe',
    versionOut: 'version: 4567 (abcdef0)\nbuilt with MSVC',
    http: fullHttp,
    ops: [{ op: 'detect' }, { op: 'installedBin' }],
  },
  {
    name: 'on PATH only',
    runtime: 'llama', platform: 'linux', arch: 'x64', gpu: 'other',
    files: { 'path/llama-server': 'x' },
    onPath: { 'llama-server': '\n<root>/path/llama-server\n/usr/bin/llama-server\n' },
    versionOut: 'ggml_cuda_init: found 1 device\nversion: 7021 (b7021)\nbuilt with gcc for x86_64',
    http: fullHttp,
    ops: [{ op: 'detect' }, { op: 'installedBin' }, { op: 'uninstall' }],
  },
  {
    name: 'nothing anywhere, and no GitHub',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'none',
    onPath: { 'llama-server': '<root>/missing/llama-server.exe' },
    http: { [LLAMA_API]: 'throw' },
    ops: [{ op: 'detect' }, { op: 'preview' }, { op: 'install' }, { op: 'installedBin' }],
  },
  {
    name: 'a platform with no builds',
    runtime: 'llama', platform: 'freebsd', arch: 'x64', gpu: 'none',
    http: fullHttp,
    ops: [{ op: 'detect' }, { op: 'preview' }, { op: 'install' }],
  },
  {
    name: 'a release that is not the pinned one, then one without the build',
    runtime: 'llama', platform: 'win32', arch: 'arm64', gpu: 'none',
    http: { [LLAMA_API]: { status: 200, body: release('b1', [[WIN_CPU, 'x']]) } },
    ops: [{ op: 'install' }, { op: 'preview' }],
  },
  {
    name: 'the build is missing, then its runtime is',
    runtime: 'llama', platform: 'win32', arch: 'arm64', gpu: 'nvidia',
    http: { [LLAMA_API]: { status: 200, body: release(TAG, [[`llama-${TAG}-bin-win-cuda-13.4-arm64.zip`, 'x'], [WIN_CPU, 'x']]) } },
    ops: [{ op: 'install', buildId: 'win-arm64-cuda' }, { op: 'install', buildId: 'win-arm64-cpu' }, { op: 'preview', buildId: 'win-arm64-cuda' }],
  },
  {
    name: 'a GitHub error',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'none',
    http: { [LLAMA_API]: { status: 503, body: 'down' } },
    ops: [{ op: 'install' }],
  },
  {
    name: 'a checksum that does not match',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'none', adapters: 'other',
    http: { ...fullHttp, ...Object.fromEntries([asset(WIN_VULKAN, 'tampered')]) },
    archives: cudaArchives,
    ops: [{ op: 'install', buildId: 'win-x64-vulkan' }, { op: 'detect' }],
  },
  {
    name: 'no archive tool, then an archive without the server',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'none',
    http: fullHttp,
    ops: [{ op: 'install' }],
  },
  {
    name: 'an archive without the server',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'none',
    http: fullHttp, archives: { [WIN_CPU]: ['README.md', 'deep/a/b/c/d/llama-server.exe'] },
    ops: [{ op: 'install' }],
  },
  {
    name: 'a CUDA runtime that does not match, then one that is gone',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'nvidia', smi: '8.9, 581.0',
    http: { ...fullHttp, ...Object.fromEntries([asset(WIN_CUDART, 'swapped')]) }, archives: cudaArchives,
    ops: [{ op: 'install' }],
  },
  {
    name: 'a CUDA runtime that is gone',
    runtime: 'llama', platform: 'win32', arch: 'x64', gpu: 'nvidia', smi: '8.9, 581.0',
    http: { ...fullHttp, [`https://dl.test/${WIN_CUDART}`]: { status: 404, body: 'gone' } }, archives: cudaArchives,
    ops: [{ op: 'install' }],
  },
  {
    name: 'records that must not be trusted',
    runtime: 'llama', platform: 'linux', arch: 'x64', gpu: 'none',
    files: {
      'engine/linux-x64-cpu/llama-server': 'x',
      'outside/llama-server': 'x',
      'engine/engine.json': JSON.stringify({ binPath: '<root>/outside/llama-server', backend: 'cpu', buildId: 'linux-x64-cpu', installedAt: 1 }),
    },
    http: fullHttp,
    ops: [{ op: 'uninstall' }],
  },
  {
    name: 'a record with a bad build id',
    runtime: 'llama', platform: 'linux', arch: 'x64', gpu: 'none',
    files: { 'engine/engine.json': JSON.stringify({ binPath: '<root>/engine/Bad_ID/llama-server', backend: 'cpu', buildId: 'Bad_ID', installedAt: 1 }) },
    http: fullHttp,
    ops: [{ op: 'uninstall' }],
  },
  {
    name: 'stable-diffusion.cpp on Linux',
    runtime: 'diffusion', platform: 'linux', arch: 'x64', gpu: 'nvidia',
    http: Object.fromEntries([
      [API(RUNTIME_RELEASES.diffusion.repo, RUNTIME_RELEASES.diffusion.tag), { status: 200, body: release(RUNTIME_RELEASES.diffusion.tag, SD_ASSETS.map((n) => [n, `sd ${n}`] as [string, string])) }],
      ...SD_ASSETS.map((n) => asset(n, `sd ${n}`)),
    ]),
    archives: { 'sd-master-929-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip': ['sd-server', 'libstable-diffusion.so'] },
    ops: [{ op: 'detect' }, { op: 'preview' }, { op: 'install' }, { op: 'detect' }, { op: 'uninstall' }],
  },
  {
    name: 'stable-diffusion.cpp with CUDA on Windows',
    runtime: 'diffusion', platform: 'win32', arch: 'x64', gpu: 'nvidia',
    http: Object.fromEntries([
      [API(RUNTIME_RELEASES.diffusion.repo, RUNTIME_RELEASES.diffusion.tag), { status: 200, body: release(RUNTIME_RELEASES.diffusion.tag, SD_ASSETS.map((n) => [n, `sd ${n}`] as [string, string])) }],
      ...SD_ASSETS.map((n) => asset(n, `sd ${n}`)),
    ]),
    archives: { 'sd-master-929-3f8527a-bin-win-cuda12-x64.zip': ['sd-server.exe'], 'cudart-sd-bin-win-cu12-x64.zip': ['cudart64_12.dll'] },
    ops: [{ op: 'preview' }, { op: 'install' }, { op: 'detect' }],
  },
];

async function waitSettled(list: () => Array<{ id: string; state: string }>, id: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const j = list().find((x) => x.id === id);
    if (j && ['done', 'failed', 'cancelled'].includes(j.state)) return j;
    if (Date.now() > deadline) throw new Error(`${id} did not settle`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
      else {
        const text = await readFile(join(dir, e.name), 'utf8');
        let shown = text;
        // A record is JSON with paths in it; everything else is shown as written.
        if (e.name.endsWith('.json')) {
          try {
            shown = JSON.stringify(norm(root, JSON.parse(text)), null, 2);
          } catch {
            /* not JSON after all */
          }
        }
        out.push(`${prefix}${e.name}=${shown}`);
      }
    }
  };
  await walk(root, '');
  return out.sort();
}

async function runScenario(root: string, s: Scenario) {
  for (const [rel, text] of Object.entries(s.files ?? {})) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, (denorm(root.replace(/\\/g, '\\\\'), text) as string));
  }
  const requests: unknown[] = [];
  const runs: string[][] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers ?? {} });
    const reply = s.http[url];
    if (!reply) return new Response('missing', { status: 404 });
    if (reply === 'throw') throw new TypeError('fetch failed');
    return new Response(reply.body ?? '', { status: reply.status });
  }) as unknown as typeof fetch;
  const run = async (cmd: string, args: string[]): Promise<string | null> => {
    runs.push(norm(root, [cmd, ...args]) as string[]);
    if (cmd === 'where' || cmd === 'which') {
      const out = s.onPath?.[args[0]];
      return out === undefined ? null : (denorm(root, out) as string);
    }
    if (cmd === 'nvidia-smi') return s.smi ?? null;
    if (args[0] === '--version') return s.versionOut ?? null;
    if (cmd === 'tar' && s.archives) {
      const archive = args[1];
      const dest = args[args.indexOf('-C') + 1];
      const name = archive.split(/[\\/]/).pop() as string;
      const leaves = s.archives[name];
      if (!leaves) return null;
      for (const leaf of leaves) {
        await mkdir(dirname(join(dest, leaf)), { recursive: true });
        await writeFile(join(dest, leaf), `from ${name}`);
      }
      return '';
    }
    return null;
  };
  const downloads = createDownloads({ fetch: fetchFn });
  const stops: string[] = [];
  const installer = createEngineInstaller({
    runtime: s.runtime,
    engineDir: () => join(root, 'engine'),
    downloads,
    getGpuStats: async () => GPUS[s.gpu],
    getGpuAdapters: async () => ADAPTERS[s.adapters ?? 'none'],
    fetch: fetchFn,
    platform: s.platform as EnginePlatform,
    arch: s.arch,
    run,
    externalPath: () => (s.external ? (denorm(root, s.external) as string) : undefined),
    beforeReplace: async () => { stops.push('stop'); },
  });
  const outs: string[] = [];
  for (const op of s.ops) {
    let out: unknown;
    switch (op.op) {
      case 'detect': out = await installer.detect(); break;
      case 'preview': out = await installer.preview(op.buildId); break;
      case 'installedBin': out = await installer.installedBin(); break;
      case 'uninstall': out = await installer.uninstall(); break;
      case 'install': {
        const res = await installer.install(op.buildId);
        const job = res.jobId ? await waitSettled(downloads.list, res.jobId) : undefined;
        out = { res, job };
        break;
      }
    }
    outs.push(JSON.stringify(norm(root, out ?? null)));
  }
  return { outs, requests: norm(root, requests), runs, stops, left: await files(root) };
}

/* -------------------------------------------------------------------- MLX */

interface MlxScenario {
  name: string;
  platform: string;
  arch: string;
  which?: string;
  http: Record<string, Reply>;
  /** Whether `uv tool install` puts the server where uv puts tools. */
  installs?: boolean;
  /** An exec that fails, with this output. */
  execFails?: string;
  ops: Array<'detect' | 'preview' | 'install' | 'uninstall' | 'binPath'>;
}

const UV_API = 'https://api.github.com/repos/astral-sh/uv/releases/tags/0.12.21';
const uvRelease = (digest?: string) => JSON.stringify({ assets: [{ name: 'uv-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://dl.test/uv.tgz', ...(digest ? { digest } : {}) }, { name: 'other.tgz', browser_download_url: 'https://dl.test/other' }] });
const MLX: MlxScenario[] = [
  { name: 'a Mac, installed and removed', platform: 'darwin', arch: 'arm64', installs: true, http: { [UV_API]: { status: 200, body: uvRelease(sha('uv bytes')) }, 'https://dl.test/uv.tgz': { status: 200, body: 'uv bytes' } }, ops: ['detect', 'preview', 'binPath', 'install', 'detect', 'binPath', 'install', 'uninstall', 'detect'] },
  { name: 'a Mac where uv puts the server elsewhere', platform: 'darwin', arch: 'arm64', installs: false, http: { [UV_API]: { status: 200, body: uvRelease() }, 'https://dl.test/uv.tgz': { status: 200, body: 'uv bytes' } }, ops: ['install', 'detect'] },
  { name: 'a Mac where uv fails', platform: 'darwin', arch: 'arm64', execFails: 'error: no network\nline two\nline three\nline four', http: { [UV_API]: { status: 200, body: uvRelease() }, 'https://dl.test/uv.tgz': { status: 200, body: 'uv bytes' } }, ops: ['install', 'detect'] },
  { name: 'a Mac with a bad uv download', platform: 'darwin', arch: 'arm64', http: { [UV_API]: { status: 200, body: uvRelease(sha('other bytes')) }, 'https://dl.test/uv.tgz': { status: 200, body: 'uv bytes' } }, ops: ['install', 'detect'] },
  { name: 'a Mac without GitHub', platform: 'darwin', arch: 'arm64', http: { [UV_API]: { status: 500 } }, ops: ['install'] },
  { name: 'a Mac with the server on PATH', platform: 'darwin', arch: 'arm64', which: '/opt/homebrew/bin/mlx_lm.server', http: {}, ops: ['detect', 'binPath', 'uninstall'] },
  { name: 'a PC', platform: 'win32', arch: 'x64', http: {}, ops: ['detect', 'preview', 'install', 'binPath', 'uninstall'] },
];

async function runMlx(root: string, s: MlxScenario) {
  const requests: unknown[] = [];
  const execs: unknown[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers ?? {} });
    const reply = s.http[url];
    if (!reply) return new Response('missing', { status: 404 });
    if (reply === 'throw') throw new TypeError('fetch failed');
    return new Response(reply.body ?? '', { status: reply.status });
  }) as unknown as typeof fetch;
  const dir = join(root, 'engine', 'mlx');
  const downloads = createDownloads({ fetch: fetchFn });
  const rt = createMlxRuntime({
    dir: () => dir,
    downloads,
    fetch: fetchFn,
    platform: s.platform,
    arch: s.arch,
    which: async () => s.which ?? null,
    exec: async (cmd, args, env) => {
      execs.push(norm(root, { cmd, args, env }));
      if (s.execFails && args[0] === 'tool') throw new Error(s.execFails.trim().split('\n').slice(-3).join(' '));
      if (args[0] === 'tool' && s.installs) {
        await mkdir(join(dir, 'bin'), { recursive: true });
        await writeFile(join(dir, 'bin', 'mlx_lm.server'), '#!/bin/sh\n');
      }
      if (args[0] === 'tool') await mkdir(join(dir, 'cache'), { recursive: true });
      return '';
    },
  });
  const outs: string[] = [];
  for (const op of s.ops) {
    let out: unknown;
    switch (op) {
      case 'detect': out = await rt.detect(); break;
      case 'preview': out = await rt.preview(); break;
      case 'binPath': out = await rt.binPath(); break;
      case 'uninstall': out = await rt.uninstall(); break;
      case 'install': {
        const res = await rt.install();
        const job = res.jobId ? await waitSettled(downloads.list, res.jobId) : undefined;
        out = { res, job };
        break;
      }
    }
    outs.push(JSON.stringify(norm(root, out ?? null)));
  }
  return { outs, requests: norm(root, requests), execs, left: await files(root) };
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

it('matches the install golden set the engine daemon replays', { timeout: 60_000 }, async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);

  const builds = [];
  for (const platform of ['win32', 'linux', 'darwin', 'freebsd'] as EnginePlatform[]) {
    for (const arch of ['x64', 'arm64']) {
      for (const gpu of Object.keys(GPUS)) {
        for (const adapters of ['none', 'amd']) {
          for (const cuda of Object.keys(CUDA)) {
            const out = buildsFor(platform, arch, GPUS[gpu], ADAPTERS[adapters], CUDA[cuda]);
            const sd = diffusionBuilds(platform, arch, GPUS[gpu]);
            builds.push({ platform, arch, gpu, adapters, cuda, out: JSON.stringify(out), diffusion: JSON.stringify(sd) });
          }
        }
      }
    }
  }
  const smi = ['', '8.9, 581.42', '8.9, 581.42\n6.1, 581.42', '7.5, 579.99', '7.5, 580.0', 'n/a, 581', '12.0, 590.12.03\r\n', '0, 0', 'garbage', '8.9,'].map((stdout) => ({ stdout, out: cudaSupportFrom(stdout) ?? null }));
  const upgrades = [];
  for (const platform of ['win32', 'linux', 'darwin'] as EnginePlatform[]) {
    for (const installed of [undefined, 'cuda', 'metal', 'vulkan', 'cpu'] as const) {
      for (const gpu of Object.keys(GPUS)) {
        for (const cuda of Object.keys(CUDA)) {
          upgrades.push({ platform, installed: installed ?? null, gpu, cuda, out: cudaUpgrade(platform, 'x64', GPUS[gpu], installed, CUDA[cuda])?.id ?? null });
        }
      }
    }
  }
  const assets = allBuilds().map((b) => {
    const asset = matchAsset(b, LLAMA_ASSETS);
    return { id: b.id, asset: asset ?? null, companion: asset ? (matchCompanion(b, asset, LLAMA_ASSETS) ?? null) : null };
  });
  const sdAssets = [];
  for (const platform of ['win32', 'linux', 'darwin'] as EnginePlatform[]) {
    for (const arch of ['x64', 'arm64']) {
      for (const b of diffusionBuilds(platform, arch, GPUS.nvidia)) {
        const asset = matchDiffusionAsset(b, SD_ASSETS);
        sdAssets.push({ id: b.id, platform, arch, asset: asset ?? null, companion: asset ? (matchDiffusionCompanion(b, asset, SD_ASSETS) ?? null) : null });
      }
    }
  }
  const adapters = [
    'NVIDIA GeForce RTX 5090|PCI\\VEN_10DE&DEV_2B85&SUBSYS_00000000\r\nAMD Radeon(TM) Graphics|PCI\\VEN_1002&DEV_164E\r\n',
    'Microsoft Basic Display Adapter|ROOT\\BasicDisplay\\0000\nParsec Virtual Display Adapter|ROOT\\X\nIntel(R) Arc(TM) A770|PCI\\VEN_8086&DEV_56A0\n',
    'Mystery GPU|PCI\\VEN_1234&DEV_0001\n|PCI\\VEN_10DE\n   |\nNo pnp\nSpacedesk Graphics Adapter|X\nAMD EPYC|PCI\\VEN_1022&DEV_1\n',
    '',
  ].map((text) => ({ text, out: parseWindowsAdapters(text) }));

  const scenarios = [];
  for (const s of SCENARIOS) {
    const root = await mkdtemp(join(tmpdir(), 'nekko-install-golden-'));
    roots.push(root);
    scenarios.push({ ...s, ...(await runScenario(root, s)) });
  }
  const mlx = [];
  for (const s of MLX) {
    const root = await mkdtemp(join(tmpdir(), 'nekko-mlx-golden-'));
    roots.push(root);
    mlx.push({ ...s, ...(await runMlx(root, s)) });
  }

  const expected = {
    note: 'Generated by packages/host/src/engine/install.golden.test.ts. Do not edit by hand.',
    now: NOW,
    releases: RUNTIME_RELEASES,
    gpus: GPUS,
    adapterSets: ADAPTERS,
    cudaSets: CUDA,
    allBuilds: JSON.stringify(allBuilds()),
    builds,
    smi,
    upgrades,
    llamaAssets: LLAMA_ASSETS,
    sdAssetNames: SD_ASSETS,
    assets,
    sdAssets,
    adapters,
    scenarios,
    mlx,
  };
  const text = `${JSON.stringify(expected, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, text);
  }
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
});
