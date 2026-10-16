import { execFile, spawn, type ChildProcess } from 'child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createServer as createProbe } from 'net';
import { basename, dirname, join } from 'path';
import type {
  EngineSettings,
  GpuStats,
  LoadingModel,
  LoadParams,
  LoadResult,
  LocalModel,
  ResidentModel,
  StopResult,
} from '@nekko-agent/shared';
import { defaultContextTokens, MODEL_FOLDER_PROVIDERS, unsupportedLoadReason } from '@nekko-agent/shared';
import { DAEMON_PORT, type EngineDaemon } from './daemon.js';
import { mlxArgs } from './mlx.js';
import { diffusionArgs } from './diffusion.js';
import { ensureVcRuntime, isMissingDllExit, missingDllMessage } from './vc-runtime.js';

/**
 * The Nekko engine's server: one address, several models.
 *
 * `llama-server` serves exactly one model per process. LM Studio parity needs
 * several models resident behind one endpoint, so this is a small router in front
 * of a child process per loaded model. The router is what the user (and any other
 * tool on the machine) points at; the children are an implementation detail that
 * never appears in a URL.
 *
 *   router :11500/v1  ->  llama-server :49xxx   (qwen3-8b)
 *                     ->  llama-server :49xxx   (gemma3-12b)
 *
 * Three behaviours come from being the router rather than a wrapper: a request
 * for a model that is not loaded can load it (JIT, as LM Studio does), an idle
 * model can be evicted on a timer, and the endpoint stays valid across loads and
 * unloads, so a chat configured once keeps working.
 *
 * It is OpenAI-compatible because llama-server already is: bodies are streamed
 * through untouched in both directions, which is what keeps token streaming and
 * tool calls working without this file knowing what either looks like.
 */

/** A cold start of a large model off a slow disk is genuinely slow. */
const LOAD_BUDGET_MS = 600_000;
const HEALTH_INTERVAL_MS = 400;
/** How often idle models are checked against their TTL. */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * How long to let the GPU reading catch up before measuring a load.
 *
 * `llama-server` answers /health the moment it can serve, but the driver's free
 * figure lags the allocation by a beat, so a reading taken on that instant
 * reports that a 7 GB model took nothing. Waiting is worth it: this measurement
 * is what reconciles the projection and feeds the calibration record, and a
 * wrong one is worse than none.
 */
const MEASURE_SETTLE_MS = 1500;
const LOG_LINES = 200;
/** How often the free-VRAM reading is taken while a load runs, for progress. */
const LOAD_PROGRESS_MS = 800;

interface Child {
  modelId: string;
  /** The process, when this module spawned it (no daemon). */
  child?: ChildProcess;
  /** Its pid, when the engine daemon spawned it. */
  pid?: number;
  port: number;
  params: LoadParams;
  promptCaching?: boolean;
  startedAt: number;
  lastUsedAt: number;
  log: string[];
  /** Measured GPU memory this load took, when a probe could measure it. */
  vramBytes?: number;
  sizeBytes: number;
  contextTokens?: number;
  /** The model's layer count, and how many of them the load put on the GPU. */
  totalLayers?: number;
  gpuLayers?: number;
  /** Where it runs: `gpu` fully offloaded, `cpu` not at all, `gpu+cpu` split. */
  loadedOn?: 'gpu' | 'gpu+cpu' | 'cpu';
  activeRequests: number;
}

/**
 * Quitting Nekko Agent must not leave orphaned model servers holding VRAM.
 *
 * One process-level hook for the module rather than one per engine: a listener
 * per instance is a slow leak in anything that constructs more than one, and the
 * set makes the cleanup order explicit.
 */
const liveKillers = new Set<() => void>();
process.once('exit', () => {
  for (const kill of liveKillers) kill();
});

export interface EngineServerDeps {
  settings: () => EngineSettings;
  promptCaching?: () => boolean;
  /** Absolute path to `llama-server`, or undefined when none is installed. */
  binPath: () => Promise<string | undefined>;
  diffusionBinPath?: () => Promise<string | undefined>;
  /** `mlx_lm.server`, on an Apple Silicon Mac with MLX installed. */
  mlxBinPath?: () => Promise<string | undefined>;
  findModel: (id: string) => Promise<LocalModel | undefined>;
  listModels: () => Promise<LocalModel[]>;
  getGpuStats: () => Promise<GpuStats | null>;
  /**
   * A writable directory for files we generate (a chat template extracted from
   * a repo's JSON config), needed because a borrowed model folder may be
   * read-only.
   */
  workDir?: () => string;
  /**
   * The nekko-owned sidecar directory for one model: where fetched companions
   * (a projector, a template) live when the model itself is in a folder we do
   * not write to.
   */
  companionsDir?: (modelId: string) => string;
  /** The shared directory the image panel downloads text encoders and VAEs into. */
  imageCompanionsDir?: () => string;
  spawnFn?: typeof spawn;
  /** Which flags the binary accepts; defaults to asking it (`probeFlags`). */
  flagSupport?: (bin: string) => Promise<FlagSupport>;
  /**
   * Whether the installed engine can put layers on a GPU at all. Undefined
   * means "assume it can": the row then reports placement from the requested
   * offload rather than claiming CPU from ignorance.
   */
  gpuCapable?: () => Promise<boolean>;
  /**
   * The engine daemon, when this host runs under one. It then owns the model
   * server processes and the OpenAI-compatible port; this module keeps the
   * policy (what to load, with which arguments, when to evict) and asks it.
   */
  daemon?: EngineDaemon;
}

/** How often residency (last use, requests in flight) is read back from the daemon. */
const DAEMON_SYNC_MS = 3000;

/** Why a LAN bind is refused without a key (the UI shows this verbatim). */
export const LAN_NEEDS_KEY =
  'Set an API key before making the engine reachable from your network. Without one anything on the network could use these models.';

/**
 * The listen configuration from the engine settings, or the reason the engine
 * must not listen. `bind: 'lan'` binds `0.0.0.0`, and the router only checks a
 * Bearer token when a key is set, so a LAN bind with an empty key is refused
 * here rather than served open (#549). Mirrored by `serve_config` in
 * crates/nekko-engine/src/server.rs.
 */
export function serveConfig(
  settings: EngineSettings,
): { ok: true; config: { port: number; host: string; apiKey?: string; corsOrigins: string[] } } | { ok: false; message: string } {
  const lan = settings.bind === 'lan';
  if (lan && !(settings.apiKey ?? '').trim()) return { ok: false, message: LAN_NEEDS_KEY };
  return {
    ok: true,
    config: {
      port: settings.port,
      host: lan ? '0.0.0.0' : '127.0.0.1',
      apiKey: settings.apiKey || undefined,
      corsOrigins: (settings.corsOrigins ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    },
  };
}

export function createEngineServer(deps: EngineServerDeps) {
  const spawnFn = deps.spawnFn ?? spawn;
  const children = new Map<string, Child>();
  /**
   * The translated reason the last load of each model failed, kept until the
   * next success. In-memory on purpose: a failure that predates a restart is
   * history, not state.
   */
  const lastLoadErrors = new Map<string, string>();
  /**
   * Loads in flight, queued ones included, so the UI can answer "is it coming"
   * the moment a load is asked for rather than when the file has landed.
   * Progress is the free-VRAM drop measured against the share of the file
   * headed to the GPU; where nothing can be measured it stays absent and the
   * bar runs indeterminate.
   */
  const loading = new Map<string, { phase: LoadingModel['phase']; startedAt: number; progress?: number }>();
  const log: string[] = [];
  let server: Server | null = null;
  /** Under the daemon: its router is listening on our behalf. */
  let serving = false;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let sweeper: ReturnType<typeof setInterval> | null = null;
  let startedAt: number | undefined;
  /** Loads are serialized: two at once make the VRAM measurement meaningless. */
  let loadChain: Promise<unknown> = Promise.resolve();

  const killAll = () => {
    for (const c of children.values()) {
      try {
        c.child?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
  liveKillers.add(killAll);

  /* ------------------------------------------------------------- lifecycle */

  async function start(): Promise<{ ok: boolean; message: string }> {
    if (server || serving) return { ok: true, message: 'The engine is already running.' };
    const bin = await deps.binPath() || await deps.diffusionBinPath?.();
    if (!bin) {
      return { ok: false, message: 'No engine is installed yet. Install one from the Models tab first.' };
    }
    const settings = deps.settings();
    const cfg = serveConfig(settings);
    if (!cfg.ok) return cfg;
    const { host } = cfg.config;

    if (deps.daemon) {
      const res = await deps.daemon.serve(cfg.config);
      if (!res.ok) return res;
      beginServing();
      push(`Engine listening on http://${host}:${settings.port}/v1 (served by the engine daemon)`);
      void adopt().then(() => autoload());
      return { ok: true, message: `The engine is serving on port ${settings.port}.` };
    }

    const next = createServer((req, res) => {
      void handle(req, res).catch((e: Error) => fail(res, 502, e.message));
    });
    // A model load can take minutes and a long generation longer; the default
    // two-minute socket timeout would cut both off mid-stream.
    next.requestTimeout = 0;
    next.headersTimeout = 0;
    next.setTimeout(0);

    const bound = await new Promise<string | null>((resolve) => {
      next.once('error', (e: NodeJS.ErrnoException) => {
        resolve(
          e.code === 'EADDRINUSE'
            ? `Port ${settings.port} is already in use. Pick another port for the engine.`
            : e.message,
        );
      });
      next.listen(settings.port, host, () => resolve(null));
    });
    if (bound) return { ok: false, message: bound };

    server = next;
    startedAt = Date.now();
    liveKillers.add(killAll);
    sweeper = setInterval(() => void sweepIdle(), SWEEP_INTERVAL_MS);
    sweeper.unref?.();
    push(`Engine listening on http://${host}:${settings.port}/v1`);
    void autoload();
    return { ok: true, message: `The engine is serving on port ${settings.port}.` };
  }

  /**
   * The models configured to come up with the engine.
   *
   * Fired rather than awaited: each load can take minutes and the endpoint is
   * already answering (and JIT-loading) by then. Loads serialize through the
   * same chain interactive loads use, so a request mid-startup joins the queue
   * rather than racing the autoload list. A model that fails lands in
   * `lastLoadErrors`; the rest keep coming.
   */
  async function autoload(): Promise<void> {
    for (const id of deps.settings().autoload ?? []) {
      const model = await deps.findModel(id).catch(() => undefined);
      if (!model) {
        push(`Autoload skipped ${id}: it is no longer in the library.`);
        continue;
      }
      const res = await load(id, model.preset ?? {});
      if (res.ok) push(`Autoloaded ${id}.`);
      else push(`Autoload ${id} failed: ${res.message}`);
    }
  }

  /** Under the daemon: mark the endpoint up and start following residency. */
  function beginServing(): void {
    serving = true;
    startedAt ??= Date.now();
    if (!sweeper) {
      sweeper = setInterval(() => void sweepIdle(), SWEEP_INTERVAL_MS);
      sweeper.unref?.();
    }
    if (!syncTimer) {
      syncTimer = setInterval(() => void sync(), DAEMON_SYNC_MS);
      syncTimer.unref?.();
    }
  }

  /**
   * Read residency back from the daemon: when each model was last used, what
   * is in flight, and which ones are gone (a model server that crashed).
   */
  async function sync(): Promise<void> {
    if (!deps.daemon || !serving) return;
    const live = await deps.daemon.list().catch(() => null);
    if (!live) return;
    const byId = new Map(live.map((c) => [c.modelId, c]));
    for (const [id, entry] of children) {
      const c = byId.get(id);
      if (!c) {
        children.delete(id);
        push(`${id} stopped.`);
        continue;
      }
      entry.lastUsedAt = Math.max(entry.lastUsedAt, c.lastUsedAt);
      entry.activeRequests = c.activeRequests;
    }
  }

  /**
   * Take over model servers the daemon is already running: this backend was
   * restarted, and the models it had loaded kept serving through the daemon
   * in the meantime.
   */
  async function adopt(): Promise<void> {
    if (!deps.daemon) return;
    const live = await deps.daemon.list().catch(() => [] as Awaited<ReturnType<EngineDaemon['list']>>);
    const gpuCapable = (await deps.gpuCapable?.().catch(() => undefined)) ?? true;
    for (const c of live) {
      if (children.has(c.modelId)) continue;
      const model = await deps.findModel(c.modelId).catch(() => undefined);
      const params = model?.preset ?? {};
      children.set(c.modelId, {
        modelId: c.modelId,
        pid: c.pid,
        port: c.port,
        params,
        // An adopted process's launch policy is unknown until explicitly reloaded.
        promptCaching: undefined,
        startedAt: c.startedAt,
        lastUsedAt: c.lastUsedAt,
        log: [],
        sizeBytes: model?.sizeBytes ?? 0,
        ...(model ? placementFor(model, params, gpuCapable) : {}),
        activeRequests: c.activeRequests,
      });
      push(`${c.modelId} was still loaded; carrying on with it.`);
    }
  }

  /** On creation under a daemon that is already serving (this backend restarted). */
  async function reattach(): Promise<void> {
    if (!deps.daemon) return;
    const listening = await deps.daemon.serving().catch(() => null);
    if (!listening) return;
    beginServing();
    await adopt();
  }

  /**
   * Under the daemon, apply new endpoint settings (port, binding, key, CORS)
   * by re-serving: the listener restarts, the loaded models stay loaded.
   */
  async function reconfigure(): Promise<{ ok: boolean; message: string }> {
    if (!deps.daemon || !serving) return { ok: true, message: 'Nothing to reconfigure.' };
    const cfg = serveConfig(deps.settings());
    if (!cfg.ok) return cfg;
    return deps.daemon.serve(cfg.config);
  }

  async function stop(): Promise<StopResult> {
    if (!server && !serving) return { ok: true, message: 'The engine was not running.' };
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    for (const id of [...children.keys()]) await unload(id);
    if (serving) {
      await deps.daemon?.stopServing().catch(() => {});
      serving = false;
    }
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    startedAt = undefined;
    liveKillers.delete(killAll);
    push('Engine stopped.');
    return { ok: true, message: 'Stopped the engine.' };
  }

  /* ------------------------------------------------------------ load state */

  /**
   * Load a model into its own `llama-server`.
   *
   * Serialized against other loads, both so two large models cannot race each
   * other into VRAM and so the before/after GPU reading that measures this load
   * is not polluted by another one landing halfway through.
   */
  function load(modelId: string, params: LoadParams = {}): Promise<LoadResult> {
    loading.set(modelId, { phase: 'queued', startedAt: Date.now() });
    const run = loadChain.then(() => doLoad(modelId, params)).finally(() => loading.delete(modelId));
    loadChain = run.catch(() => {});
    return run;
  }

  async function doLoad(modelId: string, params: LoadParams): Promise<LoadResult> {
    const inflight = loading.get(modelId);
    if (inflight) inflight.phase = 'loading';
    const existing = children.get(modelId);
    if (existing) {
      // A load with different settings is a reload, which is what the drawer's
      // "Reload with these settings" means.
      if (sameParams(existing.params, params) && existing.promptCaching === (deps.promptCaching?.() ?? true)) {
        existing.lastUsedAt = Date.now();
        // The TTL is residency policy, not load configuration: a new value
        // applies to the resident process rather than forcing a reload.
        existing.params = { ...existing.params, ttlSeconds: params.ttlSeconds };
        return { ok: true, message: `${modelId} is already loaded.` };
      }
      await unload(modelId);
    }

    const model = await deps.findModel(modelId);
    if (!model) return { ok: false, message: `${modelId} is not in the library.` };
    const image = model.modality === 'image';
    const mlx = model.format === 'mlx';
    const bin = image ? await deps.diffusionBinPath?.() : mlx ? await deps.mlxBinPath?.() : await deps.binPath();
    if (!bin) {
      const message = image
        ? 'Install stable-diffusion.cpp from Nekko Server to run this image-generation model.'
        : mlx
          ? (model.mlxRunnable ? 'Install MLX from Nekko Server to run this model.' : `${model.name} is an MLX model, which runs on Apple Silicon Macs only.`)
          : 'No engine is installed.';
      lastLoadErrors.set(modelId, message);
      return { ok: false, message };
    }

    // Some files are models but not chat models: a diffusion checkpoint, a
    // speech recognizer, a draft head. Spawning llama-server for one only ever
    // ends in its generic "model loading error", so refuse here with the
    // reason, the same one the library row shows instead of a Load button.
    const unsupported = image ? undefined : unsupportedLoadReason(model);
    if (unsupported) {
      lastLoadErrors.set(modelId, unsupported);
      return { ok: false, message: unsupported };
    }

    // A Windows without the Visual C++ Redistributable gets the copy the app
    // ships, beside the engine, before the loader goes looking for it.
    if (!mlx) {
      const copied = await ensureVcRuntime(dirname(bin)).catch(() => [] as string[]);
      if (copied.length) push(`Added the Visual C++ runtime beside the engine (${copied.join(', ')}).`);
    }

    const settings = deps.settings();
    const gpuCapable = (await deps.gpuCapable?.().catch(() => undefined)) ?? true;
    await sync();
    // Make room before spending minutes on a load that would immediately push
    // something else out anyway.
    while (children.size >= Math.max(1, settings.maxLoaded)) {
      const oldest = [...children.values()].filter(c => c.activeRequests === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!oldest) return { ok: false, message: 'All resident models are processing requests. Wait for one to finish or increase the resident limit.' };
      push(`Unloading ${oldest.modelId} to make room for ${modelId}.`);
      await unload(oldest.modelId);
    }

    const companions = image || mlx ? {} : await resolveCompanions(model, deps.workDir?.(), deps.companionsDir?.(model.id));
    if ('error' in companions) return { ok: false, message: companions.error };

    // A draft model is resolved like the model itself; one that is gone or is
    // not a GGUF is dropped with a note rather than failing the load.
    let draftModel: string | undefined;
    if (params.draftModelId) {
      const draft = await deps.findModel(params.draftModelId).catch(() => undefined);
      // A draft has to be the same kind of file as its target: llama.cpp
      // drafts with a GGUF, mlx-lm with an MLX folder.
      if (draft && (draft.format === 'mlx') === (model.format === 'mlx')) draftModel = draft.path;
      else push(`Draft model ${params.draftModelId} is not usable with ${modelId}; loading without it.`);
    }

    // Under the daemon it picks the port and fills it in at spawn time.
    const port: number | string = deps.daemon ? DAEMON_PORT : await freePort();
    // A llama.cpp load always names its context; see defaultContextTokens.
    // The stored params stay as asked, so a reload with the same settings is
    // still recognised as the same load.
    const contextTokens = image || mlx ? params.contextTokens : params.contextTokens ?? defaultContextTokens(model);
    let args: string[];
    try {
      args = image
        ? await diffusionArgs({ ...model, preset: { ...model.preset, ...params } }, port, deps.companionsDir?.(model.id), deps.imageCompanionsDir?.())
        : mlx
          ? mlxArgs(model, port, params, draftModel)
          : buildArgs(model, port, { ...params, contextTokens: contextTokens ?? undefined }, { ...companions, draftModel }, await (deps.flagSupport ?? probeFlags)(bin), deps.promptCaching?.() ?? true);
    } catch (e) {
      const message = (e as Error).message;
      lastLoadErrors.set(modelId, message);
      return { ok: false, message };
    }
    const before = await freeVramBytes();
    // Progress the row can show while the file lands: the free-VRAM figure
    // sinks as tensors arrive, measured against the share of the file headed
    // there. A CPU load or a machine with no GPU probe reports nothing, which
    // the bar shows as indeterminate rather than a number we invented. The
    // sampler stops itself the moment the load leaves `loading`.
    const gpuShare =
      model.modality === 'image'
        ? params.diffusion?.offloadToCpu
          ? 0
          : 1
        : params.gpuLayers !== undefined && model.layers
          ? Math.min(1, Math.max(0, params.gpuLayers / model.layers))
          : gpuCapable
            ? 1
            : 0;
    if (before !== null && gpuShare > 0 && model.sizeBytes > 0) {
      const expected = model.sizeBytes * gpuShare;
      const t = setInterval(() => {
        if (!loading.has(modelId)) {
          clearInterval(t);
          return;
        }
        void freeVramBytes()
          .then((free) => {
            const entry = loading.get(modelId);
            // Capped under full until health agrees it is done: the reading is
            // a ramp, not a finish line, and KV cache lands after the weights.
            if (entry && free !== null) {
              entry.progress = Math.max(0, Math.min(0.95, (before - free) / expected));
            }
          })
          .catch(() => {});
      }, LOAD_PROGRESS_MS);
      t.unref?.();
    }

    if (deps.daemon) {
      const outcome = await deps.daemon
        .spawn({
          modelId,
          bin,
          args,
          kind: image ? 'image' : 'chat',
          // llama.cpp answers /health with "loading model" until it is ready;
          // stable-diffusion.cpp has no /health, and /v1/models means up.
          healthPath: image ? '/v1/models' : '/health',
          healthExpect: image ? undefined : '"ok"',
          budgetSecs: Math.round(LOAD_BUDGET_MS / 1000),
        })
        .catch((e: Error) => ({ status: 'failed' as const, message: e.message, log: [] as string[] }));
      if (outcome.status === 'failed') {
        push(...outcome.log.slice(-4));
        const message = isMissingDllExit(outcome.message) ? missingDllMessage() : explainLoadError(outcome.log) || outcome.message;
        lastLoadErrors.set(modelId, message);
        return { ok: false, message };
      }
      if (before !== null) await sleep(MEASURE_SETTLE_MS);
      const after = await freeVramBytes();
      const measured = before !== null && after !== null && before - after > 0 ? before - after : undefined;
      children.set(modelId, {
        modelId,
        pid: outcome.pid,
        port: outcome.port,
        params,
        promptCaching: deps.promptCaching?.() ?? true,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        log: [],
        vramBytes: measured,
        sizeBytes: measured ?? model.sizeBytes,
        contextTokens,
        ...placementFor(model, params, gpuCapable),
        activeRequests: 0,
      });
      lastLoadErrors.delete(modelId);
      push(`Loaded ${modelId} on port ${outcome.port}.`);
      return { ok: true, message: `Loaded ${modelId}.` };
    }

    const childLog: string[] = [];
    let child: ChildProcess;
    try {
      child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }

    const capture = (buf: Buffer | string) => {
      for (const line of String(buf).split('\n')) {
        if (line.trim()) childLog.push(line.trimEnd());
      }
      if (childLog.length > LOG_LINES) childLog.splice(0, childLog.length - LOG_LINES);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let exited: string | null = null;
    child.on('error', (e) => {
      exited = e.message;
    });
    child.on('exit', (code, signal) => {
      exited = exited ?? `The model server exited (code ${code ?? signal}).`;
      if (children.get(modelId)?.child === child) children.delete(modelId);
    });

    const deadline = Date.now() + LOAD_BUDGET_MS;
    while (Date.now() < deadline) {
      if (exited) {
        // The captured output is the answer: "failed to allocate" and "unknown
        // argument" are different problems with different fixes. llama.cpp's
        // own wording is translated where a pattern is known, because "error
        // loading model" leaves a person nowhere to start.
        push(...childLog.slice(-4));
        const message = isMissingDllExit(exited) ? missingDllMessage() : explainLoadError(childLog) || exited;
        lastLoadErrors.set(modelId, message);
        return { ok: false, message };
      }
      if (await healthy(Number(port), image)) {
        if (before !== null) await sleep(MEASURE_SETTLE_MS);
        const after = await freeVramBytes();
        // Measured, not projected: what the GPU reported before minus after.
        // Absent when there is no GPU probe, which is honest rather than zero.
        const measured =
          before !== null && after !== null && before - after > 0 ? before - after : undefined;
        const entry: Child = {
          modelId,
          child,
          port: Number(port),
          params,
          promptCaching: deps.promptCaching?.() ?? true,
          startedAt: Date.now(),
          lastUsedAt: Date.now(),
          log: childLog,
          vramBytes: measured,
          // What this load actually occupies, which is what every other adapter
          // reports here. The file size is only the floor, and only stands in
          // when nothing could be measured.
          sizeBytes: measured ?? model.sizeBytes,
          contextTokens,
          ...placementFor(model, params, gpuCapable),
          activeRequests: 0,
        };
        children.set(modelId, entry);
        lastLoadErrors.delete(modelId);
        push(`Loaded ${modelId} on port ${port}.`);
        return { ok: true, message: `Loaded ${modelId}.` };
      }
      await sleep(HEALTH_INTERVAL_MS);
    }

    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    lastLoadErrors.set(modelId, 'The model did not finish loading in time.');
    return { ok: false, message: 'The model did not finish loading in time.' };
  }

  async function unload(modelId: string): Promise<LoadResult> {
    const entry = children.get(modelId);
    if (!entry) return { ok: false, message: `${modelId} is not loaded.` };
    children.delete(modelId);
    if (!entry.child) {
      await deps.daemon?.kill(modelId).catch(() => false);
      push(`Unloaded ${modelId}.`);
      return { ok: true, message: `Unloaded ${modelId}.` };
    }
    const proc = entry.child;
    try {
      proc.kill('SIGTERM');
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000);
      timer.unref?.();
    } catch {
      /* already gone */
    }
    push(`Unloaded ${modelId}.`);
    return { ok: true, message: `Unloaded ${modelId}.` };
  }

  /** Evict anything past its TTL. 0 means "stay resident until told otherwise". */
  async function sweepIdle(): Promise<void> {
    await sync();
    const settings = deps.settings();
    const now = Date.now();
    for (const entry of [...children.values()]) {
      const ttl = (entry.params.ttlSeconds ?? settings.idleTtlSeconds) * 1000;
      if (entry.activeRequests === 0 && ttl > 0 && now - entry.lastUsedAt > ttl) {
        push(`${entry.modelId} was idle, unloading.`);
        await unload(entry.modelId);
      }
    }
  }

  /**
   * Change a resident model's idle TTL without a reload.
   *
   * 0 is "keep loaded until I say so", which is the button the residency list
   * offers next to the countdown. Anything else falls back to the server
   * default when the value is left unset.
   */
  function setResidentTtl(modelId: string, ttlSeconds: number | undefined): LoadResult {
    const entry = children.get(modelId);
    if (!entry) return { ok: false, message: `${modelId} is not loaded.` };
    entry.params = { ...entry.params, ttlSeconds };
    return {
      ok: true,
      message:
        ttlSeconds && ttlSeconds > 0
          ? `${modelId} now unloads after ${ttlSeconds}s idle.`
          : `${modelId} stays loaded until you unload it.`,
    };
  }

  function resident(): ResidentModel[] {
    const settings = deps.settings();
    return [...children.values()].map((c) => {
      const ttl = (c.params.ttlSeconds ?? settings.idleTtlSeconds) * 1000;
      return {
        id: c.modelId,
        sizeBytes: c.sizeBytes,
        vramBytes: c.vramBytes,
        contextLength: c.contextTokens,
        gpuLayers: c.gpuLayers,
        totalLayers: c.totalLayers,
        loadedOn: c.loadedOn,
        lastUsedAt: c.lastUsedAt,
        startedAt: c.startedAt,
        expiresAt: ttl > 0 ? c.lastUsedAt + ttl : undefined,
      };
    });
  }

  /* --------------------------------------------------------------- routing */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const settings = deps.settings();
    applyCors(res, settings, req.headers.origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Health is deliberately unauthenticated: it carries nothing, and something
    // has to be able to tell whether the port is ours without a key.
    if (path === '/health' || path === '/') {
      return json(res, 200, { status: 'ok', service: 'nekko-agent-engine', models: children.size });
    }
    if (settings.apiKey && !authorized(req, settings.apiKey)) {
      return json(res, 401, { error: { message: 'Invalid API key.', type: 'invalid_request_error' } });
    }

    if (path === '/v1/models' || path === '/models') return listModelsRoute(res);
    if (path.startsWith('/v1/models/') || path.startsWith('/models/')) {
      const id = decodeURIComponent(path.replace(/^\/(v1\/)?models\//, ''));
      const model = await deps.findModel(id);
      return model
        ? json(res, 200, modelRow(model, children.has(id)))
        : json(res, 404, { error: { message: `No model named ${id}.`, type: 'invalid_request_error' } });
    }

    const inference = /^\/(v1\/)?(chat\/completions|completions|embeddings|rerank|infill|images\/generations)$/.test(path);
    if (!inference) {
      return json(res, 404, { error: { message: `Unknown route ${path}.`, type: 'invalid_request_error' } });
    }

    const body = await readBody(req);
    const requested = pickModelId(body);
    const target = await resolveTarget(requested, path.endsWith('/images/generations'));
    if ('error' in target) return json(res, target.status, { error: { message: target.error, type: 'invalid_request_error' } });

    target.entry.lastUsedAt = Date.now();
    target.entry.activeRequests += 1;
    res.once('close', () => { target.entry.activeRequests -= 1; target.entry.lastUsedAt = Date.now(); });
    proxy(req, res, target.entry.port, path.startsWith('/v1/') ? path : `/v1${path}`, body);
  }

  async function listModelsRoute(res: ServerResponse): Promise<void> {
    const models = await deps.listModels();
    json(res, 200, {
      object: 'list',
      data: models.map((m) => modelRow(m, children.has(m.id))),
    });
  }

  /**
   * Which child should serve this request.
   *
   * A model that is not loaded is loaded here when JIT is on, which is the
   * behaviour that makes the endpoint usable from another app: point Cursor at
   * it, name a model, and it works without visiting our UI first.
   */
  async function resolveTarget(
    requested: string | undefined,
    image = false,
  ): Promise<{ entry: Child } | { error: string; status: number }> {
    if (requested) {
      const model = await deps.findModel(requested);
      if (model && (model.modality === 'image') !== image) return { error: image ? 'This endpoint needs an image-generation model.' : 'Image models use /v1/images/generations, not text inference.', status: 400 };
      const loaded = children.get(requested);
      if (loaded) return { entry: loaded };
      const known = await deps.findModel(requested);
      if (!known) return { error: `No model named ${requested}. Check /v1/models.`, status: 404 };
      if (!deps.settings().jitLoad) {
        return { error: `${requested} is not loaded, and load-on-demand is off.`, status: 409 };
      }
      const result = await load(requested, known.preset ?? {});
      const entry = children.get(requested);
      if (!entry) return { error: result.message ?? `Couldn't load ${requested}.`, status: 503 };
      return { entry };
    }

    // No model named: the most recently used one is the least surprising answer,
    // and a client that names nothing has no expectation to violate.
    const eligible = await Promise.all([...children.values()].map(async entry => ({ entry, model: await deps.findModel(entry.modelId) })));
    const recent = eligible.filter(row => (row.model?.modality === 'image') === image).map(row => row.entry).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (recent) return { entry: recent };
    return { error: 'No model is loaded and the request named none.', status: 409 };
  }

  /**
   * Pipe the request to the child and the reply straight back.
   *
   * Headers and body pass through untouched in both directions, which is what
   * keeps streaming, tool calls, and any field llama.cpp adds later working
   * without this file being taught about them.
   */
  function proxy(req: IncomingMessage, res: ServerResponse, port: number, path: string, body: Buffer): void {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          'content-length': String(body.length),
          accept: req.headers.accept ?? '*/*',
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
        up.pipe(res);
      },
    );
    upstream.setTimeout(0);
    upstream.on('error', (e) => fail(res, 502, `The model server stopped responding: ${e.message}`));
    // A client that hangs up mid-generation should stop the generation too,
    // rather than leaving the model producing tokens nobody will read.
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    upstream.end(body);
  }

  /* ----------------------------------------------------------------- state */

  /**
   * The engine daemon's router asking for a model that is not running: the
   * same answer `resolveTarget` gives for our own listener, without the proxy.
   */
  async function routerLoad(requested: string, image: boolean): Promise<{ ok: boolean; status?: number; message?: string }> {
    await sync();
    const model = await deps.findModel(requested);
    if (!model) return { ok: false, status: 404, message: `No model named ${requested}. Check /v1/models.` };
    if ((model.modality === 'image') !== image) {
      return {
        ok: false,
        status: 400,
        message: image ? 'This endpoint needs an image-generation model.' : 'Image models use /v1/images/generations, not text inference.',
      };
    }
    if (children.has(requested)) return { ok: true };
    if (!deps.settings().jitLoad) {
      return { ok: false, status: 409, message: `${requested} is not loaded, and load-on-demand is off.` };
    }
    const result = await load(requested, model.preset ?? {});
    return result.ok ? { ok: true } : { ok: false, status: 503, message: result.message ?? `Couldn't load ${requested}.` };
  }

  async function routerModels() {
    await sync();
    const models = await deps.listModels();
    return { object: 'list', data: models.map((m) => modelRow(m, children.has(m.id))) };
  }

  async function routerModel(id: string) {
    const model = await deps.findModel(id);
    return model ? modelRow(model, children.has(id)) : null;
  }

  function status() {
    return {
      running: server !== null || serving,
      startedAt,
      resident: resident(),
      loading: [...loading.entries()].map(([id, l]) => ({
        id,
        phase: l.phase,
        startedAt: l.startedAt,
        progress: l.progress,
      })),
      log: log.slice(-40),
      port: deps.settings().port,
    };
  }

  function push(...lines: string[]): void {
    for (const line of lines) log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
  }

  async function freeVramBytes(): Promise<number | null> {
    const gpu = await deps.getGpuStats().catch(() => null);
    return gpu && gpu.devices.length > 0 ? gpu.freeMB * 1024 * 1024 : null;
  }

  return {
    start,
    stop,
    load,
    unload,
    setResidentTtl,
    status,
    resident,
    loadErrorFor: (id: string) => lastLoadErrors.get(id),
    loadErrors: () => [...lastLoadErrors.entries()],
    isRunning: () => server !== null || serving,
    loadedIds: () => [...children.keys()],
    routerLoad,
    routerModels,
    routerModel,
    sync,
    sweepIdle,
    reattach,
    reconfigure,
    servedByDaemon: () => serving,
  };
}

export type EngineServer = ReturnType<typeof createEngineServer>;

/* --------------------------------------------------------------- helpers */

/**
 * The `llama-server` command line for one load.
 *
 * Every flag is conditional on the parameter being set, so an unset control means
 * "llama.cpp's own default" rather than a value we invented. That matters for
 * threads and batch sizes in particular, where the engine's default is tuned to
 * the machine and ours would not be.
 */
/**
 * Files a model needs beside its weights, found by convention rather than by
 * index so a file dropped into the folder by hand counts too.
 */
export interface ModelCompanions {
  /** A vision model's projector (`mmproj-*.gguf`), passed as `--mmproj`. */
  mmproj?: string;
  /** A chat template file, passed as `--chat-template-file` with `--jinja`. */
  chatTemplateFile?: string;
  /** The draft model's file, when the load asked for one (`draftModelId`). */
  draftModel?: string;
}

/**
 * Which flags a `llama-server` build accepts, read from its own `--help`.
 *
 * The engine is installed once and kept, so the binary on a machine can be
 * older than the flags this file knows about, and an unknown flag makes
 * llama-server refuse to start at all. Every flag added after the first engine
 * release goes through this, so an older build simply runs without it.
 */
export type FlagSupport = (flag: string) => boolean;

const flagCache = new Map<string, Promise<FlagSupport>>();

export function probeFlags(bin: string, run: (bin: string) => Promise<string> = helpText): Promise<FlagSupport> {
  let probe = flagCache.get(bin);
  if (!probe) {
    probe = run(bin)
      .then((text) => {
        const known = new Set(text.match(/--[a-z0-9][a-z0-9-]*/g) ?? []);
        return (flag: string) => known.has(flag);
      })
      // A build we cannot ask is treated as knowing none of the newer flags:
      // a slower engine beats one that does not start.
      .catch(() => () => false);
    flagCache.set(bin, probe);
  }
  return probe;
}

function helpText(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--help'], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`;
      if (text.includes('--')) resolve(text);
      else reject(err ?? new Error('llama-server printed no help'));
    });
  });
}

export function buildArgs(
  model: LocalModel,
  port: number | string,
  params: LoadParams,
  companions?: ModelCompanions,
  supports: FlagSupport = () => false,
  promptCaching = true,
): string[] {
  const args = [
    '--model', model.path,
    '--alias', model.id,
    '--host', '127.0.0.1',
    '--port', String(port),
  ];
  if (companions?.mmproj) args.push('--mmproj', companions.mmproj);
  if (companions?.chatTemplateFile) {
    // `--jinja` is what makes the template (and tool-call parsing) apply; a
    // file without it is read and ignored by the chat path.
    args.push('--chat-template-file', companions.chatTemplateFile, '--jinja');
  }
  if (params.contextTokens) args.push('--ctx-size', String(params.contextTokens));
  if (params.gpuLayers !== undefined) args.push('--n-gpu-layers', String(params.gpuLayers));
  if (params.parallelSlots && params.parallelSlots > 1) args.push('--parallel', String(params.parallelSlots));
  if (params.batchSize) args.push('--batch-size', String(params.batchSize));
  if (params.ubatchSize) args.push('--ubatch-size', String(params.ubatchSize));
  if (params.threads) args.push('--threads', String(params.threads));
  if (params.kvCacheDtype && params.kvCacheDtype !== 'f16') {
    // llama.cpp names the KV types the same way it names quantizations, and K
    // and V are set separately.
    args.push('--cache-type-k', params.kvCacheDtype, '--cache-type-v', params.kvCacheDtype);
  }
  if (params.flashAttention !== undefined) args.push('--flash-attn', params.flashAttention ? 'on' : 'off');
  // llama.cpp folded mmap/mlock/direct-io into one `--load-mode` enum, and on
  // builds that have it the old flags hard-fail the launch ("invalid
  // argument"). Builds from before that change still take the pair, so the
  // probe decides which dialect this binary speaks. `none` is what no-mmap
  // meant; pinning without a map no longer exists, so mmap-off wins.
  if (supports('--load-mode')) {
    const loadMode = params.mmap === false ? 'none' : params.mlock ? 'mmap+mlock' : undefined;
    if (loadMode) args.push('--load-mode', loadMode);
  } else {
    if (params.mmap === false) args.push('--no-mmap');
    if (params.mlock) args.push('--mlock');
  }
  if (params.ropeFreqBase) args.push('--rope-freq-base', String(params.ropeFreqBase));
  if (params.ropeFreqScale) args.push('--rope-freq-scale', String(params.ropeFreqScale));
  if (params.seed !== undefined) args.push('--seed', String(params.seed));
  // Embedding models answer /v1/embeddings only in embedding mode, and a chat
  // request to one is a mistake worth failing loudly rather than serving.
  const embedding = Boolean(model.architecture && /bert|embed/i.test(model.architecture));
  if (embedding) {
    args.push('--embedding');
    return args;
  }

  // The agent-speed defaults, each measured against llama.cpp's own defaults
  // on the same model (docs/benchmarks.md), and each only where the installed
  // build knows the flag.
  //
  // An edited prompt (a tool result replaced, a message trimmed) reuses the
  // cached chunks around the edit instead of re-reading from the change on.
  if (supports('--cache-reuse')) args.push('--cache-reuse', promptCaching ? '256' : '0');
  // RAM only. Never configure slot-save paths or disk prompt caches.
  if (!promptCaching && supports('--cache-ram')) args.push('--cache-ram', '0');
  // llama.cpp copies every idle slot out to its RAM prompt cache when a new
  // request arrives. Keeping them in place instead cut the first turn of a
  // new chat from 2.3 s to 1.7 s and a revisit of an evicted chat from 1.7 s
  // to 0.8 s; the RAM cache still catches what a slot really loses.
  if (supports('--no-cache-idle-slots')) args.push('--no-cache-idle-slots');
  if (params.speculative !== false && supports('--spec-default')) {
    // N-gram lookup from the conversation: 117 -> 506 tok/s on an edit that
    // repeats its input, and faster on ordinary replies too. Works with a
    // vision projector loaded as well (measured 633 tok/s on the same edit);
    // llama.cpp only drops --cache-reuse for those, with a warning.
    args.push('--spec-default');
    if (companions?.draftModel && supports('--spec-draft-model')) {
      args.push('--spec-draft-model', companions.draftModel, '--spec-draft-ngl', 'all', '--spec-type', 'draft-simple');
    }
  }
  return args;
}

/**
 * The inputs a chat with this model can carry: always text, images only when
 * the projector is there to see them. Rows that are not chat models (image
 * generation, speech, embeddings, drafts) say nothing, as before.
 */
export function inputModalities(model: Pick<LocalModel, 'modality' | 'hasProjector'>): string[] | undefined {
  const modality = model.modality ?? 'chat';
  if (modality !== 'chat' && modality !== 'vision') return undefined;
  return model.hasProjector ? ['text', 'image'] : ['text'];
}

function modelRow(model: LocalModel, loaded: boolean) {
  return {
    id: model.id,
    object: 'model',
    created: Math.floor(model.addedAt / 1000),
    owned_by: 'nekko-agent',
    // Extras beyond the OpenAI schema, which compatible clients ignore and ours
    // uses to show state without a second request.
    state: loaded ? 'loaded' : 'not-loaded',
    // The picker leads with the name and the file beneath it; the id is a path
    // in itself and reads badly as a label.
    name: model.name,
    path: model.path,
    location: model.folderProvider ? MODEL_FOLDER_PROVIDERS[model.folderProvider].label : undefined,
    modality: model.modality ?? 'chat',
    // What a load of this file can take, in OpenRouter's shape so the composer
    // and the turn read it the same way. Images need the projector: a vision
    // model without its mmproj answers text and rejects every picture, which
    // would leave each later turn of the chat failing on the one it already holds.
    input_modalities: inputModalities(model),
    max_context_length: model.maxContext,
    quantization: model.quantization,
    size_bytes: model.sizeBytes,
  };
}

/**
 * Where a load actually lives. `params.gpuLayers` is what was asked; when it is
 * absent llama.cpp offloads what it can on a GPU-capable build (its `--fit`
 * default) and nothing on a CPU-only one, so the installed backend decides the
 * default. MLX models live on the GPU by definition (unified memory); an image
 * model's diffusion flags say the same thing in their own words.
 */
function placementFor(
  model: LocalModel,
  params: LoadParams,
  gpuCapable: boolean,
): Pick<Child, 'gpuLayers' | 'totalLayers' | 'loadedOn'> {
  const totalLayers = model.layers;
  if (model.format === 'mlx') return { totalLayers, gpuLayers: totalLayers, loadedOn: 'gpu' };
  if (model.modality === 'image') {
    const split = Boolean(params.diffusion?.clipOnCpu);
    return { loadedOn: params.diffusion?.offloadToCpu ? 'cpu' : split ? 'gpu+cpu' : 'gpu' };
  }
  if (!gpuCapable) return { totalLayers, gpuLayers: 0, loadedOn: 'cpu' };
  const gpuLayers = params.gpuLayers ?? totalLayers;
  const loadedOn =
    gpuLayers === undefined
      ? 'gpu'
      : gpuLayers <= 0
        ? 'cpu'
        : totalLayers !== undefined && gpuLayers < totalLayers
          ? 'gpu+cpu'
          : 'gpu';
  return { totalLayers, gpuLayers, loadedOn };
}

function sameParams(a: LoadParams, b: LoadParams): boolean {
  const keys: Array<keyof LoadParams> = [
    'contextTokens', 'gpuLayers', 'kvCacheDtype', 'parallelSlots', 'batchSize',
    'ubatchSize', 'threads', 'flashAttention', 'mmap', 'mlock', 'ropeFreqBase',
    'ropeFreqScale', 'seed', 'speculative', 'draftModelId',
  ];
  return keys.every((k) => a[k] === b[k]) && JSON.stringify(a.diffusion ?? {}) === JSON.stringify(b.diffusion ?? {});
}

function pickModelId(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function authorized(req: IncomingMessage, key: string): boolean {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === key || req.headers['x-api-key'] === key;
}

/**
 * CORS, off unless asked for.
 *
 * A browser page that can reach this port can also read whatever it generates,
 * so the allowed origins are a setting rather than a default, and `*` is
 * something the user types.
 */
function applyCors(res: ServerResponse, settings: EngineSettings, origin?: string): void {
  const allowed = (settings.corsOrigins ?? '').trim();
  if (!allowed) return;
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  const value = list.includes('*') ? '*' : origin && list.includes(origin) ? origin : null;
  if (!value) return;
  res.setHeader('access-control-allow-origin', value);
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

/** Headers that describe one hop and must not be copied to the next. */
function stripHopByHop(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  json(res, status, { error: { message, type: 'server_error' } });
}

async function healthy(port: number, image = false): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${image ? 'v1/models' : 'health'}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    if (image) return true;
    const body = (await res.json()) as { status?: string };
    // llama-server reports `loading model` before it is ready to serve.
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/** Ask the OS for a free port by binding one and letting go. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbe();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('could not reserve a port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* --------------------------------------------------------- model companions */

/**
 * The files a model needs beside its weights, resolved at load time.
 *
 * Looked up by convention in the model's own directory rather than carried on
 * the library row, because the files are the truth there too: a sidecar a user
 * drops in by hand should count, and one deleted outside the app should stop
 * counting without an index update.
 *
 * Returns `{error}` for the one companion problem worth failing a load over:
 * a split model missing a shard. Everything else absent is simply not passed.
 */
export async function resolveCompanions(
  model: LocalModel,
  workDir?: string,
  companionsDirPath?: string,
): Promise<ModelCompanions | { error: string }> {
  const dir = dirname(model.path);
  const file = basename(model.path);

  // `name-00001-of-00005.gguf` is only the first fifth; llama.cpp opens the
  // rest by name and dies on the first absent one, so check here and name it.
  const shard = file.match(/-00001-of-(\d{5})\.gguf$/i);
  if (shard) {
    const total = Number(shard[1]);
    for (let n = 2; n <= total; n += 1) {
      const part = file.replace(/-00001-of-(\d{5})\.gguf$/i, `-${String(n).padStart(5, '0')}-of-$1.gguf`);
      if (!(await exists(join(dir, part)))) {
        return {
          error: `${model.name} is split into ${total} files and ${part} is missing. Re-download it so every piece lands.`,
        };
      }
    }
  }

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return {}; // An unreadable directory fails on --model itself, which says so.
  }

  const companions: ModelCompanions = {};

  // Sidecars we fetched for the model when its own folder is read-only. The
  // model's directory wins: a file somebody dropped beside the weights is the
  // one they meant to use.
  const fetched: string[] = companionsDirPath
    ? await readdir(companionsDirPath).catch(() => [] as string[])
    : [];

  const isMmproj = (e: string) => /mmproj/i.test(e) && e.toLowerCase().endsWith('.gguf');
  const isJinja = (e: string) => e.toLowerCase().endsWith('.jinja');
  const isTemplate = (e: string) => /chat[-_]?template.*\.jinja$/i.test(e);

  // A vision model's projector. Without --mmproj the weights load fine and
  // every image request fails, which is the failure mode worth wiring up.
  const localProj = entries.find(isMmproj);
  const fetchedProj = fetched.find(isMmproj);
  if (localProj) companions.mmproj = join(dir, localProj);
  else if (fetchedProj && companionsDirPath) companions.mmproj = join(companionsDirPath, fetchedProj);

  // A chat template turns messages into a prompt; a GGUF converted without one
  // answers chat requests with a template error. Repos ship it as a `.jinja`
  // file or inside a JSON config, and either works for us.
  const localJinja = entries.find(isTemplate) ?? entries.find(isJinja);
  const fetchedJinja = fetched.find(isTemplate) ?? fetched.find(isJinja);
  if (localJinja) {
    companions.chatTemplateFile = join(dir, localJinja);
  } else if (fetchedJinja && companionsDirPath) {
    companions.chatTemplateFile = join(companionsDirPath, fetchedJinja);
  } else if (workDir) {
    companions.chatTemplateFile =
      (await extractTemplate(dir, entries, file, workDir)) ??
      (companionsDirPath ? await extractTemplate(companionsDirPath, fetched, file, workDir) : undefined);
  }
  return companions;
}

/**
 * Pull `chat_template` out of a repo's JSON config into a `.jinja` file
 * llama.cpp can take on the command line.
 *
 * Written under the engine's own work dir, not beside the model: a borrowed
 * folder (LM Studio's, the HF cache) is read-only territory and a file we
 * leave there is litter nobody asked for.
 */
async function extractTemplate(
  dir: string,
  entries: string[],
  modelFile: string,
  workDir: string,
): Promise<string | undefined> {
  const sources = ['chat_template.json', 'chat-template.json', 'tokenizer_config.json'];
  for (const name of sources) {
    if (!entries.some((e) => e.toLowerCase() === name)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        chat_template?: unknown;
      };
      const raw = parsed?.chat_template;
      const template =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.find((t) => typeof t?.template === 'string')?.template
            : undefined;
      if (!template) continue;
      const dest = join(workDir, `${modelFile.replace(/\.gguf$/i, '')}.chat_template.jinja`);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, template, 'utf8');
      return dest;
    } catch {
      // A config that will not parse is skipped, not fatal: the GGUF's own
      // template (or llama.cpp's default) still applies.
    }
  }
  return undefined;
}

/**
 * Turn a dead `llama-server`'s last output into a sentence that names the fix.
 *
 * The patterns are the failures a downloaded model actually dies with; each
 * translation exists because the raw log line ("error loading model", a bare
 * open() errno) was reported as a dead end. Unmatched output falls through to
 * the tail of the log, which is still the best honest answer.
 */
export function explainLoadError(log: string[]): string {
  // The whole captured log, not just a tail: the line that says why the load
  // died is often followed by several lines of shutdown noise, and "exiting
  // due to model loading error" is the epilogue rather than the cause.
  const text = log.join('\n');
  if (/unknown (model )?arch|unsupported (model|arch)/i.test(text)) {
    return "This engine build doesn't know this model's architecture. Update the engine under Models → Server, then try again.";
  }
  if (/bad magic|invalid magic|not a (valid )?gguf|gguf.*(version|format)|unsupported format/i.test(text)) {
    return "The file isn't a GGUF this engine can read (it may be an older GGML-format model, or a different file type renamed .gguf).";
  }
  if (/mmproj|projector|clip model|clip_model/i.test(text)) {
    return 'This is a vision model and its projector file (mmproj-*.gguf) is missing next to the model. Fetch it from the model row, or re-download the model so the companion files come with it.';
  }
  if (/chat.?template|template.*not.*(supported|found)/i.test(text)) {
    return 'The model needs a chat template file and none was found. Re-download it (the template downloads with the model now) or pick a different build.';
  }
  if (/missing (required )?tensor|tensor .*missing|wrong number of tensors|check_tensor|unexpected tensor/i.test(text)) {
    return "The file doesn't match what llama.cpp expects (a tensor is missing or unexpected). Re-download it, or pick a different build of the model.";
  }
  if (/out of memory|failed to allocate|insufficient|bad_alloc|CUDA_ERROR_OUT_OF_MEMORY|not enough (free )?memory/i.test(text)) {
    return 'Not enough memory to load it. Lower the context size or GPU layers in the model\'s settings, or unload something else first.';
  }
  const missing =
    text.match(/(?:failed|unable|cannot|could not|error)[^\n]*(?:open|read|load|missing)[^\n'"`]*['"`]([^'"`\n]+\.(?:gguf|jinja|json|model|txt))['"`]/i)?.[1] ??
    text.match(/(?:llama_model_load|error)[^\n]*(?:open|file)[^\n'"`]*['"`]([^'"`\n]+)['"`]/i)?.[1];
  const name = missing ? basename(missing.trim()) : '';
  if (name && name !== '.') {
    return `A file the model needs is missing or unreadable: ${name}. Re-download the model so its companion files come with it.`;
  }
  // A specific error line, cleaned of its log prefix, beats the generic tail.
  const errLine = log.find(
    (l) => /error loading model|failed to load|unable to load|missing tensor|create_model/i.test(l) && !/cleaning up|exiting due to/i.test(l),
  );
  if (errLine) {
    const cleaned = errLine
      .replace(/^[\d.\s]*(?:I|W|E)\s+\S+:\s*/i, '')
      .replace(/^llama_model_load[^:]*:\s*/i, '')
      .replace(/^error loading model[:\s]*/i, '')
      .trim();
    if (cleaned.length > 8) return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  // Nothing recognized: the last substantive lines (shutdown noise removed)
  // are still a better answer than the exit banner.
  const noise = /cleaning up before exit|exiting due to|operator\(\)/i;
  const substantive = log.filter((l) => !noise.test(l) && l.trim());
  return (substantive.length ? substantive : log).slice(-2).join(' ');
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}
