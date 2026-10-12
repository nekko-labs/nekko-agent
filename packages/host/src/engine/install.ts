import type { GpuAdapter } from '../gpu-adapters.js';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, isAbsolute } from 'path';
import type { EngineBuild, EngineInstall, EnginePlatform, GpuStats } from '@nekko-agent/shared';
import { buildsFor, hasBinaries, matchAsset, matchCompanion, recommendedBuild } from './builds.js';
import { diffusionBuilds, matchDiffusionAsset, matchDiffusionCompanion } from './diffusion.js';
import { RUNTIME_RELEASES } from './runtime-releases.js';
import type { EngineInstallPreview } from '@nekko-agent/shared';
import type { Downloads } from './download.js';

/**
 * Getting an engine onto the machine.
 *
 * Three ways in, in the order they are preferred: one we installed before, one
 * the user already has (on PATH or pointed at by hand), or one we download from
 * llama.cpp's own releases after the user says yes. Nothing multi-hundred-megabyte
 * happens without that yes, which is AN7's standing rule and the reason this is a
 * separate step rather than something the first Start button does quietly.
 */

/**
 * Recent releases, not `releases/latest`.
 *
 * llama.cpp's "latest" is a marker release carrying a single text file that
 * names the current nightly; the archives live on the `bNNNN` build tags behind
 * it. Asking for latest gets a release with no binaries in it, so we take the
 * first recent release that actually has some.
 */
const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
const SERVER_NAMES = ['llama-server', 'llama-server.exe'];
/** Recorded beside the binary so a reinstall can tell what it is replacing. */
const RECORD_FILE = 'engine.json';

interface EngineRecord {
  binPath: string;
  backend: EngineBuild['backend'];
  buildId: string;
  version?: string;
  installedAt: number;
}

export interface EngineInstallerDeps {
  runtime?: 'llama' | 'diffusion';
  /** `<dataDir>/engine`, where managed builds land. */
  engineDir: () => string;
  downloads: Downloads;
  getGpuStats: () => Promise<GpuStats | null>;
  /** GPUs the OS reports, for machines with no stats tool (AMD, Intel). */
  getGpuAdapters?: () => Promise<GpuAdapter[]>;
  fetch?: typeof fetch;
  platform?: EnginePlatform;
  arch?: string;
  run?: (cmd: string, args: string[], timeoutMs?: number) => Promise<string | null>;
  /** A path the user chose by hand, checked before anything is downloaded. */
  externalPath?: () => string | undefined;
  /**
   * Called once a new build has downloaded, just before the old one's files are
   * replaced. Windows will not delete a running `llama-server.exe` or the DLLs
   * it has loaded, so the host stops its server here, and not earlier: the old
   * engine keeps serving for the whole download.
   */
  beforeReplace?: () => Promise<void>;
}

export function createEngineInstaller(deps: EngineInstallerDeps) {
  // `buildsFor` only knows the three platforms llama.cpp publishes for; anything
  // else finds no candidates and is told so, rather than being offered a build
  // that does not exist.
  const platform = deps.platform ?? (process.platform as EnginePlatform);
  const arch = deps.arch ?? process.arch;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const run = deps.run ?? defaultRun;
  const runtime = deps.runtime ?? 'llama';
  const releasePin = RUNTIME_RELEASES[runtime];
  const runtimeName = runtime === 'diffusion' ? 'stable-diffusion.cpp' : 'llama.cpp';
  const serverNames = runtime === 'diffusion' ? ['sd-server', 'sd-server.exe'] : SERVER_NAMES;
  const candidates = (gpu: GpuStats | null, adapters: GpuAdapter[]) =>
    runtime === 'diffusion' ? diffusionBuilds(platform, arch, gpu) : buildsFor(platform, arch, gpu, adapters);
  const selectAsset = runtime === 'diffusion' ? matchDiffusionAsset : matchAsset;
  const selectCompanion = runtime === 'diffusion' ? matchDiffusionCompanion : matchCompanion;

  /** What is usable right now, and what we would install if asked. */
  async function detect(): Promise<EngineInstall> {
    const gpu = await deps.getGpuStats().catch(() => null);
    const adapters = (await deps.getGpuAdapters?.().catch(() => [])) ?? [];
    const available = candidates(gpu, adapters);
    const recommended = available[0];

    const external = deps.externalPath?.();
    if (external && (await isExecutable(external))) {
      return {
        binPath: external,
        source: 'external',
        version: await probeVersion(external),
        available,
        recommended,
      };
    }

    const record = await readRecord();
    if (record && (await isExecutable(record.binPath))) {
      const problem = await missingGpuRuntime(record);
      return {
        binPath: record.binPath,
        source: 'managed',
        backend: record.backend,
        version: record.version,
        installedAt: record.installedAt,
        ...(problem ? { problem } : {}),
        available,
        recommended,
      };
    }

    const onPath = await findOnPath();
    if (onPath) {
      return {
        binPath: onPath,
        source: 'external',
        version: await probeVersion(onPath),
        available,
        recommended,
      };
    }

    return {
      available,
      recommended,
      reason: recommended
        ? 'No engine installed yet. Nekko Agent can download one, or point it at a llama-server you already have.'
        : `No llama.cpp build is published for ${platform}/${arch}. Point Nekko Agent at a llama-server you built yourself.`,
    };
  }

  /**
   * Download and unpack a build. Returns the job id so the caller can follow it;
   * the install itself completes when the download does.
   */
  async function install(buildId?: string): Promise<{ ok: boolean; message: string; jobId?: string }> {
    const gpu = await deps.getGpuStats().catch(() => null);
    const adapters = (await deps.getGpuAdapters?.().catch(() => [])) ?? [];
    const build = buildId
      ? candidates(gpu, adapters).find((b) => b.id === buildId)
      : candidates(gpu, adapters)[0];
    if (!build) return { ok: false, message: 'No engine build matches this machine.' };

    const release = await fetchRelease();
    if (!release) {
      return {
        ok: false,
        message: "Couldn't reach GitHub to find a llama.cpp release. Check the connection and try again.",
      };
    }
    const names = release.assets.map((a) => a.name);
    const assetName = selectAsset(build, names);
    if (!assetName) {
      return { ok: false, message: `The ${release.tag} release has no ${build.backend} build for this machine.` };
    }
    const asset = release.assets.find((a) => a.name === assetName)!;
    const companionName = selectCompanion(build, assetName, names);
    if (build.companionPattern && !companionName) return { ok: false, message: 'The release is missing required runtime libraries.' };
    const companion = companionName ? release.assets.find((a) => a.name === companionName) : undefined;

    const dir = join(deps.engineDir(), build.id);
    const archivePath = join(dir, assetName);

    const job = await deps.downloads.start({
      id: `engine:${runtime}:${build.id}`,
      kind: 'engine',
      label: `${runtimeName} ${release.tag} (${build.backend})`,
      target: build.id,
      url: asset.url,
      dest: archivePath,
      verify: async path => asset.digest ? await verifyDigest(path, asset.digest) : null,
      after: async (path, signal) => {
        // The archive is the download; unpacking it is what makes it an engine,
        // so it happens here, inside the job, and a failure fails the job rather
        // than leaving a downloaded file nobody can use. It runs as `after`
        // rather than `verify` because extracting consumes the archive, and a
        // file consumed before the transfer has renamed it fails the rename.
        try {
          signal.throwIfAborted();
          // A reinstall unpacks into a clean folder, cleared only now that the
          // new archive is safely here, so a failed download still leaves the
          // old engine usable. Unpacking over the old files kept whatever the
          // last install left, such as the Linux runtime a broken CUDA install
          // got by mistake. A file Windows still has locked is left to be
          // overwritten rather than failing the install.
          await deps.beforeReplace?.();
          await clearExcept(dir, path);
          await extract(path, dir, run);
          if (companion) {
            // CUDA's runtime libraries ship separately and the server will not
            // start without them beside it.
            const companionPath = join(dir, companion.name);
            await downloadDirect(companion.url, companionPath, doFetch, signal);
            if (companion.digest && await verifyDigest(companionPath, companion.digest)) throw new Error('Runtime-library checksum verification failed.');
            await extract(companionPath, dir, run);
            await rm(companionPath, { force: true });
          }
          const bin = await findServerBinary(dir, 0, serverNames);
          if (!bin) return `The archive did not contain ${serverNames[0]}.`;
          if (platform !== 'win32') await chmod(bin, 0o755).catch(() => {});
          signal.throwIfAborted();
          await writeRecord({
            binPath: bin,
            backend: build.backend,
            buildId: build.id,
            version: release.tag,
            installedAt: Date.now(),
          });
          return null;
        } catch (e) {
          return `Couldn't unpack the engine: ${(e as Error).message}`;
        }
      },
    });

    return { ok: true, message: `Downloading ${runtimeName} ${release.tag}.`, jobId: job.id };
  }

  /** Remove a managed install. An external binary is never touched. */
  async function uninstall(): Promise<{ ok: boolean; message: string }> {
    const record = await readRecord();
    if (!record) return { ok: false, message: 'No managed engine is installed.' };
    if (!/^[a-z0-9-]+$/.test(record.buildId)) return { ok: false, message: 'Invalid managed-runtime record. No files were removed.' };
    const owned = relative(join(deps.engineDir(), record.buildId), record.binPath);
    if (!owned || owned.startsWith('..') || isAbsolute(owned)) return { ok: false, message: 'The binary is outside its managed install. No files were removed.' };
    await rm(join(deps.engineDir(), record.buildId), { recursive: true, force: true });
    await rm(join(deps.engineDir(), RECORD_FILE), { force: true });
    return { ok: true, message: 'Removed the engine.' };
  }

  /**
   * A managed Windows CUDA build without the CUDA runtime beside it.
   *
   * `ggml-cuda.dll` needs `cublas64_NN.dll`, and without it llama.cpp quietly
   * drops the CUDA backend: the server starts, `/health` is fine, and every
   * model runs on the CPU at a small fraction of the speed. Older installs got
   * the Linux runtime instead of the Windows one, so this is checked on the
   * files rather than trusted from the record. A file check, not a process
   * launch, because `detect` runs on every status poll.
   */
  async function missingGpuRuntime(record: EngineRecord): Promise<EngineInstall['problem']> {
    if (runtime !== 'llama' || platform !== 'win32' || record.backend !== 'cuda') return undefined;
    const names = await readdir(dirname(record.binPath)).catch(() => null);
    if (!names || names.some((n) => /^cublas64_\d+\.dll$/i.test(n))) return undefined;
    return {
      message:
        'The NVIDIA engine is missing its GPU libraries, so models are running on the processor and replies will be very slow or never arrive. Repair it to use your graphics card.',
      repairBuildId: record.buildId,
    };
  }

  async function readRecord(): Promise<EngineRecord | null> {
    try {
      return JSON.parse(await readFile(join(deps.engineDir(), RECORD_FILE), 'utf8')) as EngineRecord;
    } catch {
      return null;
    }
  }

  async function writeRecord(record: EngineRecord): Promise<void> {
    await mkdir(deps.engineDir(), { recursive: true });
    await writeFile(join(deps.engineDir(), RECORD_FILE), JSON.stringify(record, null, 2), 'utf8');
  }

  async function fetchRelease(): Promise<{ tag: string; assets: Array<{ name: string; url: string; size: number; digest?: string }> } | null> {
    try {
      const res = await doFetch(`https://api.github.com/repos/${releasePin.repo}/releases/tags/${releasePin.tag}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'nekko-agent' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const row = await res.json() as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string }> };
      const assets = (row.assets ?? []).filter(a => a.name && a.browser_download_url && a.size)
        .map(a => ({ name: a.name!, url: a.browser_download_url!, size: a.size!, digest: a.digest }));
      return row.tag_name === releasePin.tag ? { tag: row.tag_name, assets } : null;
    } catch {
      return null;
    }
  }

  async function preview(buildId?: string): Promise<EngineInstallPreview | null> {
    const gpu = await deps.getGpuStats().catch(() => null);
    const available = candidates(gpu, (await deps.getGpuAdapters?.().catch(() => [])) ?? []);
    const build = buildId ? available.find(b => b.id === buildId) : available[0];
    const release = await fetchRelease();
    if (!build || !release) return null;
    const names = release.assets.map(a => a.name);
    const asset = selectAsset(build, names);
    if (!asset) return null;
    const companion = selectCompanion(build, asset, names);
    if (build.companionPattern && !companion) return null;
    const files = release.assets.filter(a => a.name === asset || a.name === companion).map(a => ({ name: a.name, sizeBytes: a.size }));
    return { runtime, version: release.tag, build, files, sizeBytes: files.reduce((n, f) => n + f.sizeBytes, 0) };
  }

  /**
   * The binary `detect` would use, found without asking about the GPU.
   *
   * The GPU probe's fallback runs this engine's `--list-devices`, and `detect`
   * itself reads the GPU probe to rank builds, so sharing `detect` would loop.
   */
  async function installedBin(): Promise<string | undefined> {
    const external = deps.externalPath?.();
    if (external && (await isExecutable(external))) return external;
    const record = await readRecord();
    if (record && (await isExecutable(record.binPath))) return record.binPath;
    return (await findOnPath()) ?? undefined;
  }

  async function probeVersion(bin: string): Promise<string | undefined> {
    const out = await run(bin, ['--version'], 8000);
    return out?.match(/b(\d{3,})/)?.[0] ?? out?.match(/version[: ]+(\S+)/i)?.[1];
  }

  async function findOnPath(): Promise<string | null> {
    const finder = platform === 'win32' ? 'where' : 'which';
    for (const name of serverNames) {
      const out = await run(finder, [name], 4000);
      const first = out?.split('\n').map((l) => l.trim()).find(Boolean);
      if (first && (await isExecutable(first))) return first;
    }
    return null;
  }

  return { detect, install, uninstall, preview, installedBin };
}

export type EngineInstaller = ReturnType<typeof createEngineInstaller>;

async function isExecutable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Depth-limited walk: the binary is a couple of levels down, never deeper. */
async function findServerBinary(dir: string, depth = 0, names = SERVER_NAMES): Promise<string | null> {
  if (depth > 3) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && names.includes(entry.name)) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hit = await findServerBinary(join(dir, entry.name), depth + 1, names);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Unpack an archive with whatever the OS already has.
 *
 * Node ships no zip reader and this is not worth a dependency: Windows 10+ and
 * macOS both carry bsdtar, which reads zip, and Linux has `unzip` for the zip
 * assets and tar for the tarballs. Each candidate is tried in turn and the first
 * that exits cleanly wins.
 */
async function extract(
  archive: string,
  dest: string,
  run: (cmd: string, args: string[], timeoutMs?: number) => Promise<string | null>,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const isTar = /\.(tar\.gz|tgz)$/i.test(archive);
  const attempts: Array<[string, string[]]> = isTar
    ? [['tar', ['-xzf', archive, '-C', dest]]]
    : [
        ['tar', ['-xf', archive, '-C', dest]],
        ['unzip', ['-o', '-q', archive, '-d', dest]],
        [
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`],
        ],
      ];

  for (const [cmd, args] of attempts) {
    const out = await run(cmd, args, 300_000);
    if (out !== null) {
      await rm(archive, { force: true });
      return;
    }
  }
  throw new Error('no archive tool available (tried tar, unzip, PowerShell)');
}

/** Empty a build folder of everything but the archive about to be unpacked into it. */
async function clearExcept(dir: string, keep: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .map((name) => join(dir, name))
      .filter((path) => path !== keep)
      .map((path) => rm(path, { recursive: true, force: true }).catch(() => {})),
  );
}

/** A plain fetch-to-file, for the companion archive that has no job of its own. */
async function downloadDirect(url: string, dest: string, doFetch: typeof fetch, signal: AbortSignal): Promise<void> {
  const res = await doFetch(url, { redirect: 'follow', signal });
  if (!res.ok) throw new Error(`companion download failed (HTTP ${res.status})`);
  await mkdir(join(dest, '..'), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function verifyDigest(path: string, digest: string): Promise<string | null> {
  const expected = digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
  if (!expected) return 'The release supplied an unsupported checksum.';
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === expected.toLowerCase() ? null : 'The downloaded runtime checksum does not match its release.';
}

function defaultRun(cmd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`;
      resolve(err ? null : text);
    });
  });
}
