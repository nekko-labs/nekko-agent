import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { access, mkdir, readdir, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import type { EngineBuild, EngineInstall, EngineInstallPreview, LoadParams, LocalModel } from '@nekko-agent/shared';
import type { Downloads } from './download.js';

/**
 * MLX, Apple's array framework, as a third runtime beside llama.cpp and
 * stable-diffusion.cpp: on Apple Silicon it is usually the fastest way to run
 * a model, and LM Studio's MLX downloads are already on many Macs.
 *
 * It ships as a Python package (`mlx-lm`, whose `mlx_lm.server` speaks the
 * OpenAI API), so the install is uv (one static binary from its GitHub
 * release) installing a pinned `mlx-lm` into its own Python under the engine
 * folder: nothing touches the system Python, and uninstalling is deleting the
 * folder. As with every runtime, nothing is downloaded until the user asks.
 */

/** Pinned so an install is reproducible; bumped by PR like the llama.cpp tag. */
export const MLX_LM_VERSION = '0.31.3';
export const UV_VERSION = '0.12.21';
const UV_ASSET = 'uv-aarch64-apple-darwin.tar.gz';
/** uv, a Python, mlx and mlx-lm with their wheels: measured roughly, for the consent sentence. */
const APPROX_INSTALL_BYTES = 420 * 1024 * 1024;
const SERVER = 'mlx_lm.server';

export function mlxSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

/** The synthetic "build" MLX has, so it can share the install surfaces. */
export const MLX_BUILD: EngineBuild = {
  id: 'mlx-lm',
  platform: 'darwin',
  arch: 'arm64',
  backend: 'metal',
  label: 'MLX (Apple Silicon)',
  requires: 'An Apple Silicon Mac.',
  assetPattern: 'mlx-lm',
} as EngineBuild;

export interface MlxRuntimeDeps {
  /** `<engineDir>/mlx`. */
  dir: () => string;
  downloads: Downloads;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
  /** Run a command to completion; resolves its combined output, rejects on failure. */
  exec?: (cmd: string, args: string[], env: Record<string, string>) => Promise<string>;
  /** Looks for a user-installed `mlx_lm.server` on PATH. */
  which?: (name: string) => Promise<string | null>;
}

export function createMlxRuntime(deps: MlxRuntimeDeps) {
  const supported = () => mlxSupported(deps.platform, deps.arch);
  const exec = deps.exec ?? defaultExec;
  const which = deps.which ?? defaultWhich;
  const managedBin = () => join(deps.dir(), 'bin', SERVER);
  let lastError: string | undefined;

  async function binPath(): Promise<string | undefined> {
    if (!supported()) return undefined;
    if (await isFile(managedBin())) return managedBin();
    return (await which(SERVER)) ?? undefined;
  }

  async function detect(): Promise<EngineInstall> {
    if (!supported()) {
      return { available: [], reason: 'MLX runs on Apple Silicon Macs only.' };
    }
    if (await isFile(managedBin())) {
      return { binPath: managedBin(), source: 'managed', version: `mlx-lm ${MLX_LM_VERSION}`, available: [MLX_BUILD], recommended: MLX_BUILD };
    }
    const external = await which(SERVER);
    if (external) return { binPath: external, source: 'external', available: [MLX_BUILD], recommended: MLX_BUILD };
    return { available: [MLX_BUILD], recommended: MLX_BUILD, reason: lastError ?? 'MLX is not installed yet.' };
  }

  async function preview(): Promise<EngineInstallPreview | null> {
    if (!supported()) return null;
    return {
      runtime: 'mlx',
      version: `mlx-lm ${MLX_LM_VERSION} (uv ${UV_VERSION})`,
      build: MLX_BUILD,
      sizeBytes: APPROX_INSTALL_BYTES,
      files: [
        { name: UV_ASSET, sizeBytes: 17 * 1024 * 1024 },
        { name: `Python + mlx-lm ${MLX_LM_VERSION}`, sizeBytes: APPROX_INSTALL_BYTES - 17 * 1024 * 1024 },
      ],
    };
  }

  /**
   * Download uv (a tracked, cancellable job like any engine download), then
   * have it install `mlx-lm` into the engine folder.
   */
  async function install(): Promise<{ ok: boolean; message: string; jobId?: string }> {
    if (!supported()) return { ok: false, message: 'MLX runs on Apple Silicon Macs only.' };
    if (await isFile(managedBin())) return { ok: true, message: 'MLX is already installed.' };
    const doFetch = deps.fetch ?? globalThis.fetch;
    const release = await doFetch(`https://api.github.com/repos/astral-sh/uv/releases/tags/${UV_VERSION}`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as { assets?: Array<{ name: string; browser_download_url: string; digest?: string }> } | null;
    const asset = release?.assets?.find((a) => a.name === UV_ASSET);
    if (!asset) return { ok: false, message: `Could not read uv ${UV_VERSION}'s release. Check the connection and try again.` };

    const dir = deps.dir();
    await mkdir(join(dir, 'uv'), { recursive: true });
    const archive = join(dir, 'uv', UV_ASSET);
    lastError = undefined;
    const job = await deps.downloads.start({
      id: 'engine:mlx:mlx-lm',
      kind: 'engine',
      label: `MLX (mlx-lm ${MLX_LM_VERSION})`,
      target: MLX_BUILD.id,
      url: asset.browser_download_url,
      dest: archive,
      verify: async (path) => (asset.digest ? await verifySha256(path, asset.digest) : null),
      after: async (path, signal) => {
        try {
          signal.throwIfAborted();
          await exec('tar', ['-xzf', path, '-C', join(dir, 'uv'), '--strip-components', '1'], {});
          const uv = join(dir, 'uv', 'uv');
          // Everything uv writes stays under the engine folder, so the install
          // is self-contained and removing the folder removes all of it.
          const env = {
            UV_TOOL_DIR: join(dir, 'tools'),
            UV_TOOL_BIN_DIR: join(dir, 'bin'),
            UV_PYTHON_INSTALL_DIR: join(dir, 'python'),
            UV_CACHE_DIR: join(dir, 'cache'),
            UV_NO_MODIFY_PATH: '1',
          };
          signal.throwIfAborted();
          await exec(uv, ['tool', 'install', '--python', '3.12', `mlx-lm==${MLX_LM_VERSION}`], env);
          if (!(await isFile(managedBin()))) return `mlx-lm installed but ${SERVER} was not where uv puts tools.`;
          // The package cache is only for installing; it is most of the bytes.
          await rm(join(dir, 'cache'), { recursive: true, force: true });
          return null;
        } catch (e) {
          lastError = `MLX install failed: ${(e as Error).message}`;
          return lastError;
        }
      },
    });
    return { ok: true, message: 'Installing MLX.', jobId: job.id };
  }

  async function uninstall(): Promise<{ ok: boolean; message: string }> {
    if (!(await isFile(managedBin()))) {
      return { ok: false, message: 'Only an MLX install made here can be removed here; one on your PATH is yours.' };
    }
    await rm(deps.dir(), { recursive: true, force: true });
    return { ok: true, message: 'Removed MLX. Models are kept.' };
  }

  return { binPath, detect, preview, install, uninstall, supported };
}

export type MlxRuntime = ReturnType<typeof createMlxRuntime>;

/** The MLX runtime under the engine daemon, which installs it (`NEKKOD_OWNS` `runtimes`). */
export function daemonMlxRuntime(call: <T>(channel: string, ...args: unknown[]) => Promise<T>): MlxRuntime {
  const detect = () => call<EngineInstall>('engine:detect', 'mlx');
  return {
    binPath: async () => (await detect()).binPath,
    detect,
    preview: () => call('engine:installPreview', 'mlx', null),
    install: () => call('engine:install', null, 'mlx'),
    uninstall: () => call('engine:uninstall', 'mlx'),
    supported: () => mlxSupported(),
  };
}

/** `mlx_lm.server` arguments for one load; `port` may be the daemon's placeholder. */
export function mlxArgs(model: LocalModel, port: number | string, params: LoadParams, draftPath?: string): string[] {
  const args = ['--model', model.path, '--host', '127.0.0.1', '--port', String(port)];
  // mlx-lm's own speculative decoding takes a draft model; without one it
  // runs plainly (it has no n-gram lookup of its own).
  if (draftPath && params.speculative !== false) args.push('--draft-model', draftPath, '--num-draft-tokens', '3');
  return args;
}

/* ----------------------------------------------------------- library scan */

export interface MlxModelInfo {
  architecture?: string;
  quantization?: string;
  maxContext?: number;
  vision: boolean;
  sizeBytes: number;
}

/**
 * Whether a directory is an MLX model, and what it is.
 *
 * An MLX model is a folder with a `config.json` and `.safetensors` weights.
 * A plain Hugging Face transformers checkpoint looks the same, so one more
 * sign is required: MLX's quantization block in the config, or `mlx` in the
 * folder's name or its parent's (mlx-community, LM Studio's MLX downloads).
 */
export async function readMlxModel(dir: string): Promise<MlxModelInfo | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const weights = entries.filter((e) => e.toLowerCase().endsWith('.safetensors'));
  if (!entries.includes('config.json') || weights.length === 0) return null;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  const quant = (config.quantization ?? config.quantization_config) as { bits?: number; group_size?: number } | undefined;
  const mlxQuant = quant && typeof quant.group_size === 'number' && typeof quant.bits === 'number';
  // The folder's own name or its publisher's (`mlx-community/<model>`), not
  // anywhere up the path: a models folder called "mlx" does not make every
  // checkpoint inside it one.
  const near = dir.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  if (!mlxQuant && !/mlx/i.test(near)) return null;
  let sizeBytes = 0;
  for (const w of weights) sizeBytes += await stat(join(dir, w)).then((s) => s.size).catch(() => 0);
  const text = (config.text_config ?? {}) as Record<string, unknown>;
  const maxContext = (config.max_position_embeddings ?? text.max_position_embeddings) as number | undefined;
  return {
    architecture: typeof config.model_type === 'string' ? config.model_type : undefined,
    quantization: mlxQuant ? `${quant!.bits}-bit` : undefined,
    maxContext: typeof maxContext === 'number' ? maxContext : undefined,
    vision: Boolean(config.vision_config),
    sizeBytes,
  };
}

/* ------------------------------------------------------------------ util */

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function defaultExec(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      if (err) reject(new Error(out.trim().split('\n').slice(-3).join(' ') || err.message));
      else resolve(out);
    });
  });
}

function defaultWhich(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [name], { timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

async function verifySha256(path: string, digest: string): Promise<string | null> {
  const want = digest.replace(/^sha256:/i, '').toLowerCase();
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', () => resolve()).on('error', reject);
  });
  return hash.digest('hex') === want ? null : 'uv download checksum did not match.';
}
