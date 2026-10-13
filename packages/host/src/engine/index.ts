import { createMlxRuntime, daemonMlxRuntime, mlxSupported } from './mlx.js';
import { readGgufMetadata } from './gguf.js';
import { daemonCall, daemonOwns, engineDaemon } from './daemon.js';
import type { GpuAdapter } from '../gpu-adapters.js';
import { setEngineBinResolver } from '../gpu.js';
import { freemem, totalmem } from 'os';
import { dirname, join, resolve } from 'path';
import { stat } from 'fs/promises';
import type {
  CatalogModel,
  CatalogModelDetail,
  DownloadJob,
  EngineInstall,
  EngineLoadPreset,
  EngineSettings,
  GpuFit,
  GpuStats,
  HardwareFacts,
  ImageCompanionStatus,
  LoadParams,
  LoadResult,
  LocalModel,
  ModelFacts,
  ModelFolder,
  ModelFolderReport,
  ModelFolderSuggestion,
  ResidentModel,
  StopResult,
} from '@nekko-agent/shared';
import { DEFAULT_ENGINE_SETTINGS, defaultContextTokens, engineBaseUrl, modelModality } from '@nekko-agent/shared';
import { autoFit, computeFit } from '@nekko-agent/core';
import { overheadFloorFor } from '../runtimes/calibration.js';
import { createCatalog, hfFileUrl } from './catalog.js';
import { companionsDir } from './companions.js';
import { companionsBeside, imageCompanionsDir, imageCompanionSetFor, imageCompanionStatus } from './image-companions.js';
import { createDecisions } from './decisions.js';
import { createDownloads, type DownloadRequest } from './download.js';
import { knownFolder, knownFolderCandidates } from './folders.js';
import { createEngineInstaller, daemonInstaller } from './install.js';
import { createLibrary, daemonLibrary, PRIMARY_FOLDER_ID, type Library, type LibraryApi } from './library.js';
import { createEngineServer } from './server.js';

/**
 * The engine, as one object.
 *
 * Four parts that only make sense together: acquire the engine, acquire models,
 * keep them on disk, serve them. Everything above this (the runtime adapter, IPC,
 * the renderer) talks to this facade rather than to the parts, so the split
 * between them can change without a channel changing.
 */

export interface EngineDeps {
  dataDir: () => string;
  getGpuStats: () => Promise<GpuStats | null>;
  /** GPUs the OS reports, for choosing a build on machines with no stats tool. */
  getGpuAdapters?: () => Promise<GpuAdapter[]>;
  /**
   * A reading taken now rather than from the poll cache. The before/after pair
   * around a load is a measurement, and a cached "after" can report that loading
   * a model took nothing.
   */
  getGpuStatsFresh?: () => Promise<GpuStats | null>;
  settings: () => EngineSettings;
  promptCaching?: () => boolean;
  /** Persist a settings change (port, TTL, key). */
  saveSettings: (patch: Partial<EngineSettings>) => Promise<EngineSettings>;
  onDownloadsChanged?: (jobs: DownloadJob[]) => void;
  /**
   * Called with the engine's address whenever it starts serving, so the host can
   * keep a provider entry pointing at it. Without this the engine would run and
   * no chat could pick a model from it, which is the whole point of running it.
   */
  onServing?: (baseUrl: string) => void;
  /** TypeSafe API key for the hosted Jev decision model. */
  typesafeKey?: () => string | undefined;
  /** Decision-model export folders the user added, and how to save the list. */
  decisionFolders?: () => string[];
  saveDecisionFolders?: (dirs: string[]) => void;
  /** Hugging Face token for gated repos, when the user has configured one. */
  hfToken?: () => string | undefined;
  /** A `llama-server` the user pointed at by hand. */
  externalBinPath?: () => string | undefined;
}

export function createEngine(deps: EngineDeps) {
  const modelsDir = () => deps.settings().modelsDir || join(deps.dataDir(), 'models');
  const engineDir = () => join(deps.dataDir(), 'engine');

  const downloads = createDownloads({
    onChange: (jobs) => {
      deps.onDownloadsChanged?.(jobs);
      void onDownloadsChanged(jobs).catch(() => {});
    },
  });
  const localLibrary = createLibrary({ modelsDir, folders: () => deps.settings().modelFolders ?? [] });
  // Under the engine daemon the library is the daemon's: it alone writes the index.
  const daemon = daemonOwns('library') ? daemonCall() : undefined;
  // Model downloads too: this queue keeps only the runtime installs.
  const daemonDownloads = daemonOwns('downloads') ? daemonCall() : undefined;
  const library: LibraryApi = daemon ? daemonLibrary(daemon) : localLibrary;
  const catalog = createCatalog({ token: deps.hfToken, mlx: () => mlxSupported() });
  // The runtimes too: the daemon installs them and writes `<data>/engine`.
  const daemonRuntimes = daemonOwns('runtimes') ? daemonCall() : undefined;
  const installer = daemonRuntimes ? daemonInstaller(daemonRuntimes, 'llama') : createEngineInstaller({
    engineDir,
    downloads,
    getGpuStats: deps.getGpuStats,
    getGpuAdapters: deps.getGpuAdapters,
    externalPath: deps.externalBinPath,
    // A (re)install swaps the files under a running llama-server, which Windows
    // refuses; stop it just before, once the new build is already downloaded.
    beforeReplace: async () => { if (server.isRunning()) await server.stop(); },
  });

  // Lets the GPU probe fall back to this engine's own device list. Only the
  // llama.cpp runtime: it is the one that serves the models being sized.
  setEngineBinResolver(() => installer.installedBin());

  const diffusionInstaller = daemonRuntimes
    ? daemonInstaller(daemonRuntimes, 'diffusion')
    : createEngineInstaller({ runtime: 'diffusion', engineDir: () => join(engineDir(), 'diffusion'), downloads, getGpuStats: deps.getGpuStats });
  const mlxRuntime = daemonRuntimes ? daemonMlxRuntime(daemonRuntimes) : createMlxRuntime({ dir: () => join(engineDir(), 'mlx'), downloads });

  // The model server too: the daemon runs its policy over its own processes,
  // and this host only asks it (`NEKKOD_OWNS` `server`).
  const remote = daemonOwns('server') ? daemonCall() : undefined;
  const server = createEngineServer({
    settings: deps.settings,
    promptCaching: deps.promptCaching,
    binPath: async () => (await installer.detect()).binPath,
    diffusionBinPath: async () => (await diffusionInstaller.detect()).binPath,
    mlxBinPath: () => mlxRuntime.binPath(),
    findModel: (id) => library.find(id),
    listModels: () => library.list(),
    getGpuStats: deps.getGpuStatsFresh ?? deps.getGpuStats,
    workDir: () => join(engineDir(), 'templates'),
    companionsDir: (modelId) => companionsDir(modelsDir(), modelId),
    imageCompanionsDir: () => imageCompanionsDir(modelsDir()),
    gpuCapable: async () => {
      const install = await installer.detect();
      return install.backend !== undefined && install.backend !== 'cpu';
    },
    daemon: remote ? undefined : engineDaemon(),
  });
  // What the daemon's server last said, for the callers that read it synchronously.
  let remoteRunning = false;
  let remoteResident: ResidentModel[] = [];
  if (remote) {
    const poll = () => void remote<boolean>('engine:running').then((r) => { remoteRunning = Boolean(r); }, () => {});
    poll();
    setInterval(poll, 3000).unref?.();
  }
  const decisions = createDecisions({
    modelsDir,
    downloads,
    daemon: engineDaemon,
    typesafeKey: () => deps.typesafeKey?.(),
    folders: () => deps.decisionFolders?.() ?? [],
    saveFolders: (dirs) => deps.saveDecisionFolders?.(dirs),
    directmlDir: () => join(engineDir(), 'directml'),
  });

  // A backend restarted under a daemon that kept serving picks its models up.
  if (!remote) void server.reattach();

  /* ----------------------------------------------------- download follow-up */

  /**
   * What finishing a model download sets up for free.
   *
   * Two things the user would otherwise have to discover: the engine should
   * start with the app now that there is something to serve (`autoStart`), and
   * the model deserves settings planned for this machine rather than the
   * engine's blanket defaults. Only main model jobs fire this; companion files
   * (projectors, extra shards) share the target but change nothing.
   */
  const seenJobStates = new Map<string, DownloadJob['state']>();

  async function onDownloadsChanged(jobs: DownloadJob[]): Promise<void> {
    for (const job of finishedModelJobs(jobs, seenJobStates)) await onModelDownloaded(job);
  }

  async function onModelDownloaded(job: DownloadJob): Promise<void> {
    // A model on disk makes the engine worth starting on its own.
    if (!deps.settings().autoStart) await deps.saveSettings({ autoStart: true });
    const model = downloadedModel(await library.list(), job);
    // An existing preset is a choice somebody made; do not overwrite it.
    if (!model || model.format === 'mlx' || model.preset) return;
    const hw = await hardware().catch(() => undefined);
    // No GPU to fill: the engine defaults already mean CPU.
    if (!hw || hw.devices.length === 0) return;
    const install = await installer.detect();
    const preset = gpuFirstPreset(model, hw, overheadFloorFor('llamacpp', install.version));
    if (preset) await library.savePreset(model.id, preset);
  }

  /* ------------------------------------------------------------ acquisition */

  /**
   * Download one quantization of one catalog model.
   *
   * Companion files (later shards, a vision projector) are queued behind the main
   * file rather than in parallel: a split model is unusable until every shard has
   * landed, so finishing one at a time is both simpler to report and kinder to a
   * shared connection.
   */
  async function downloadModel(
    modelId: string,
    quantLabel: string,
  ): Promise<{ ok: boolean; message: string; jobId?: string }> {
    const plan = await modelDownloadPlan(await catalog.model(modelId), modelId, quantLabel, modelsDir(), landed);
    if (!plan.ok) return { ok: false, message: plan.message };
    const job = await downloads.start({
      ...plan.main,
      verify: plan.verifyGguf
        ? async (path) => {
            // A GGUF that will not parse is a failed download wearing the right
            // extension, and catching it here means the library never lists one.
            return (await readGgufMetadata(path)) ? null : 'The downloaded file is not a readable GGUF.';
          }
        : undefined,
    });
    for (const extra of plan.extras) void downloads.start(extra);
    return { ok: true, message: plan.message, jobId: job.id };
  }

  /**
   * Fetch the files a model already on disk is missing: a vision projector
   * first, then the small configs its repo ships.
   *
   * This is the fix for the weights arriving without them (a manual download,
   * a file copied out of another app). Managed models get the files beside the
   * weights, where any tool can see them; a borrowed folder is read-only, so
   * the files land in the nekko-owned companions dir the server also reads.
   */
  async function downloadCompanions(modelId: string): Promise<{ ok: boolean; message: string }> {
    const model = await library.find(modelId);
    if (!model) return { ok: false, message: 'That model is not in the library.' };
    const repo = sourceRepoFor(model);
    if (!repo) {
      return {
        ok: false,
        message: `Cannot tell which Hugging Face repo ${model.name} came from, so there is nowhere to fetch its companion files from.`,
      };
    }
    const plan = await companionsPlan(model, repo, await catalog.companions(repo), modelsDir(), landed);
    for (const request of plan.requests) void downloads.start(request);
    return { ok: plan.ok, message: plan.message };
  }

  /** An image model's text encoders and VAE: which are on disk and what the rest weighs. */
  async function imageCompanions(modelId: string): Promise<ImageCompanionStatus | null> {
    const model = await library.find(modelId);
    if (!model || model.modality !== 'image') return null;
    const beside = await companionsBeside(model, [companionsDir(modelsDir(), model.id)]);
    return imageCompanionStatus(model, imageCompanionsDir(modelsDir()), beside, Boolean(deps.hfToken?.()));
  }

  /**
   * Fetch the text encoders and VAE an image model lacks into the shared image
   * companions directory. A gated VAE (SD3.5's, FLUX.1's) is fetched with the
   * user's Hugging Face token when there is one, and otherwise its small
   * ungated approximation (TAESD) stands in so the model still runs.
   */
  async function downloadImageCompanions(modelId: string): Promise<{ ok: boolean; message: string }> {
    const model = await library.find(modelId);
    if (!model) return { ok: false, message: 'That model is not in the library.' };
    const plan = imageCompanionsPlan(model, await imageCompanions(modelId), deps.hfToken?.(), modelsDir());
    for (const request of plan.requests) void downloads.start(request);
    return { ok: plan.ok, message: plan.message };
  }

  /* --------------------------------------------------------- model folders */

  /**
   * The folder list, plus the known layouts on this machine nobody has added.
   *
   * Suggestions are probed rather than merely tested for existence, because an
   * empty Ollama folder is not worth a row and "LM Studio (0 models)" is an
   * invitation to wonder what went wrong.
   */
  async function folders(): Promise<ModelFolderReport> {
    if (daemon) return daemon('engine:folders');
    return folderReport(localLibrary, knownFolderCandidates());
  }

  /** Replace the folder list. The primary folder is not in it and never moves here. */
  async function saveFolders(next: ModelFolder[]): Promise<ModelFolderReport> {
    if (daemon) return daemon('engine:foldersSave', next);
    await deps.saveSettings({ modelFolders: next.filter((f) => f.id !== PRIMARY_FOLDER_ID) });
    return folders();
  }

  /**
   * Adopt every known folder on this machine that has models in it.
   *
   * Run once, the first time the engine starts with no folder list at all, so a
   * machine that already has models through Ollama or LM Studio shows them
   * without anybody having to know this screen exists. Everything it adds stays
   * editable and switchable off, and it never runs again: a folder removed on
   * purpose should stay removed.
   */
  async function seedFolders(): Promise<void> {
    // Under the engine daemon the library is its own, and it seeds the list.
    if (daemon) return;
    if (deps.settings().modelFolders !== undefined) return;
    await deps.saveSettings({ modelFolders: await seedFolderList(localLibrary, modelsDir(), knownFolderCandidates()) });
  }

  /* --------------------------------------------------------------- serving */

  async function load(modelId: string, params: LoadParams): Promise<LoadResult> {
    if (remote) return remote('engine:load', modelId, params);
    // Loading is the moment a user expects the engine to be up, so starting it
    // here beats making them press two buttons in the right order.
    if (!server.isRunning()) {
      const started = await start();
      if (!started.ok) return { ok: false, message: started.message };
    }
    return server.load(modelId, params);
  }

  async function status(): Promise<import('@nekko-agent/shared').EngineStatus> {
    if (remote) {
      const s = await remote<import('@nekko-agent/shared').EngineStatus>('engine:status');
      remoteRunning = s.running;
      remoteResident = s.resident;
      return s;
    }
    const install = await installer.detect();
    const state = server.status();
    const gpu = await deps.getGpuStats().catch(() => null);
    // What the "will it fit" chips compare against: VRAM when there is a GPU to
    // name, system RAM otherwise. Total, not free: the question is whether the
    // model can ever be served here, not whether it fits beside open apps.
    const memory = engineMemory(gpu, totalmem());
    return {
      install,
      diffusionInstall: await diffusionInstaller.detect(),
      mlxInstall: await mlxRuntime.detect(),
      running: state.running,
      startedAt: state.startedAt,
      resident: state.resident,
      loading: state.loading,
      log: state.log,
      port: state.port,
      settings: deps.settings(),
      memory,
    };
  }

  /** The machine's memory pools, in the shape the fit planner reads. */
  async function hardware(): Promise<HardwareFacts> {
    const gpu = await deps.getGpuStats().catch(() => null);
    return {
      devices: (gpu?.devices ?? []).map((d) => ({
        name: d.name,
        totalBytes: d.memoryTotalMB * 1024 * 1024,
        freeBytes: d.memoryFreeMB * 1024 * 1024,
      })),
      unified: Boolean(gpu?.unified),
      systemRamTotalBytes: totalmem(),
      systemRamFreeBytes: freemem(),
    };
  }

  /**
   * Every model in the library, with load state, the last failure and the
   * planner's residency verdict folded in.
   *
   * `gpuFit` is one `computeFit` per row against a single hardware read — pure
   * math, no I/O per model — and stays undefined when no GPU probe answered,
   * because a verdict built on no hardware facts is a guess wearing one.
   */
  async function models(): Promise<Array<LocalModel & { loaded: boolean; gpuFit?: GpuFit }>> {
    if (daemon) return daemon('engine:models');
    const loaded = new Set(server.loadedIds());
    const list = await library.list();
    const hw = await hardware().catch(() => undefined);
    const overheadFloor = hw ? overheadFloorFor('llamacpp', (await installer.detect()).version) : undefined;
    return list.map((m) => ({
      ...m,
      loaded: loaded.has(m.id),
      lastLoadError: server.loadErrorFor(m.id),
      gpuFit: hw ? gpuFitFor(m, hw, overheadFloor) : undefined,
    }));
  }

  async function start(): Promise<{ ok: boolean; message: string }> {
    if (remote) {
      // The daemon keeps the provider entry pointing at the engine itself.
      const res = await remote<{ ok: boolean; message: string }>('engine:start');
      if (res.ok) remoteRunning = true;
      return res;
    }
    const res = await server.start();
    if (res.ok) deps.onServing?.(engineBaseUrl(deps.settings()));
    return res;
  }

  return {
    // engine binary
    detectEngine: () => installer.detect(),
    installEngine: (buildId?: string, runtime: 'llama' | 'diffusion' | 'mlx' = 'llama') =>
      runtime === 'mlx' ? mlxRuntime.install() : (runtime === 'diffusion' ? diffusionInstaller : installer).install(buildId),
    uninstallEngine: async (runtime: 'llama' | 'diffusion' | 'mlx' = 'llama'): Promise<{ ok: boolean; message: string }> => {
      // The daemon checks the server (through this host) and its own queue.
      if (daemonRuntimes) return daemonRuntimes('engine:uninstall', runtime);
      if (server.isRunning()) return { ok: false, message: 'Stop the model server before uninstalling a runtime.' };
      if (downloads.list().some(j => j.id.startsWith(`engine:${runtime}:`) && downloads.isActive(j.id))) return { ok: false, message: 'Wait for the runtime installation to finish or cancel it before uninstalling.' };
      if (runtime === 'mlx') return mlxRuntime.uninstall();
      return (runtime === 'diffusion' ? diffusionInstaller : installer).uninstall();
    },
    installPreview: (runtime: 'llama' | 'diffusion' | 'mlx', buildId?: string) =>
      runtime === 'mlx' ? mlxRuntime.preview() : (runtime === 'diffusion' ? diffusionInstaller : installer).preview(buildId),
    /**
     * One image from a loaded (or loadable) image model. `onStage` hears
     * whether it first has to load the model, which is most of a cold request.
     */
    generateImage: async (
      request: import('@nekko-agent/shared').ImageGenerationRequest,
      onStage?: (stage: 'loading' | 'generating') => void,
    ): Promise<import('@nekko-agent/shared').ImageGenerationResult> => {
      const { modelId } = request;
      const body = imageGenerationBody(request);
      if ('problem' in body) throw new Error(body.problem);
      const model = await library.find(modelId);
      if (model?.modality !== 'image') throw new Error('Choose an image-generation model.');
      if (remote) {
        // The daemon loads and generates; the stages are told from here.
        if (!(await remote<string[]>('engine:loadedIds')).includes(modelId)) onStage?.('loading');
        const loaded = await remote<LoadResult>('engine:load', modelId, model.preset ?? {});
        if (!loaded.ok) throw new Error(loaded.message);
        onStage?.('generating');
        return remote('engine:generateImage', request);
      }
      if (!server.loadedIds().includes(modelId)) onStage?.('loading');
      const started = await load(modelId, model.preset ?? {});
      if (!started.ok) throw new Error(started.message);
      onStage?.('generating');
      const key = deps.settings().apiKey;
      const res = await fetch(`${engineBaseUrl(deps.settings())}/images/generations`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: body.body,
        signal: AbortSignal.timeout(30 * 60_000),
      });
      const result = await res.json() as import('@nekko-agent/shared').ImageGenerationResult & { error?: { message?: string } };
      if (!res.ok || !result.data?.length) throw new Error(result.error?.message ?? `Image generation failed (HTTP ${res.status}).`);
      return result;
    },
    // catalog + downloads
    catalogCurated: () => catalog.curated(),
    catalogSearch: (q: string, limit?: number, format?: 'gguf' | 'mlx') => catalog.search(q, limit, format),
    catalogModel: (id: string) => catalog.model(id),
    catalogDetail: (id: string): Promise<CatalogModelDetail | null> => catalog.detail(id),
    downloadModel: (modelId: string, quantLabel: string): Promise<{ ok: boolean; message: string; jobId?: string }> =>
      daemonDownloads ? daemonDownloads('engine:downloadModel', modelId, quantLabel) : downloadModel(modelId, quantLabel),
    downloadCompanions: (modelId: string): Promise<{ ok: boolean; message: string }> =>
      daemonDownloads ? daemonDownloads('engine:downloadCompanions', modelId) : downloadCompanions(modelId),
    imageCompanions: (modelId: string): Promise<ImageCompanionStatus | null> =>
      daemonDownloads ? daemonDownloads('engine:imageCompanions', modelId) : imageCompanions(modelId),
    downloadImageCompanions: (modelId: string): Promise<{ ok: boolean; message: string }> =>
      daemonDownloads ? daemonDownloads('engine:downloadImageCompanions', modelId) : downloadImageCompanions(modelId),
    decisions,
    downloads: (): DownloadJob[] | Promise<DownloadJob[]> => (daemonDownloads ? daemonDownloads('engine:downloads') : downloads.list()),
    cancelDownload: (id: string): void | Promise<void> => (daemonDownloads ? daemonDownloads('engine:cancelDownload', id) : downloads.cancel(id)),
    dismissDownload: (id: string): void | Promise<void> => (daemonDownloads ? daemonDownloads('engine:dismissDownload', id) : downloads.dismiss(id)),
    /** This host's own queue (the runtime installs), for the daemon that merges it with the model downloads. */
    hostDownloads: () => downloads.list(),
    cancelHostDownload: (id: string) => downloads.cancel(id),
    dismissHostDownload: (id: string) => downloads.dismiss(id),
    // library
    models,
    findModel: (id: string) => library.find(id),
    importModel: (path: string) => library.importFile(path),
    deleteModel: (id: string) => library.remove(id),
    saveModelPreset: (id: string, preset: EngineLoadPreset) => library.savePreset(id, preset),
    diskUsage: () => library.diskUsage(),
    /** For the daemon's `engine:models`: what only this host's server knows about each model. */
    loadState: async () => ({
      loaded: server.loadedIds(),
      errors: Object.fromEntries(server.loadErrors()),
      version: (await installer.detect()).version,
    }),
    // model folders
    folders,
    saveFolders,
    seedFolders,
    // server
    start,
    stop: async (): Promise<StopResult> => {
      if (!remote) return server.stop();
      const res = await remote<StopResult>('engine:stop');
      remoteRunning = false;
      return res;
    },
    load,
    unload: (id: string): Promise<LoadResult> => (remote ? remote('engine:unload', id) : server.unload(id)),
    setResidentTtl: async (id: string, ttlSeconds: number): Promise<{ ok: boolean; message: string }> => {
      if (remote) return remote('engine:residentTtl', id, ttlSeconds);
      const r = server.setResidentTtl(id, ttlSeconds);
      return { ok: r.ok, message: r.message ?? '' };
    },
    /** Add or remove a model from the list loaded when the engine starts. */
    setAutoload: (id: string, enabled: boolean): Promise<EngineSettings> => {
      if (daemon) return daemon('engine:autoload', id, enabled);
      const current = deps.settings().autoload ?? [];
      const next = enabled ? [...new Set([...current, id])] : current.filter((m) => m !== id);
      return deps.saveSettings({ autoload: next });
    },
    status,
    isRunning: () => (remote ? remoteRunning : server.isRunning()),
    resident: () => (remote ? remoteResident : server.resident()),
    saveSettings: async (patch: Partial<EngineSettings>): Promise<EngineSettings> => {
      // The daemon saves it and re-serves its listener when the endpoint changed.
      if (remote) return remote('engine:settings', patch);
      const next = await deps.saveSettings(patch);
      // The port and the binding are read when the socket is opened, so a change
      // to either only takes effect on the next start. Restarting here rather
      // than leaving the UI to explain that is the honest behaviour.
      const endpoint = patch.port !== undefined || patch.bind !== undefined;
      if (server.isRunning() && server.servedByDaemon()) {
        // The daemon's listener holds the key and CORS list as well, so any
        // endpoint setting re-serves; loaded models stay loaded.
        if (reservesEndpoint(patch)) await server.reconfigure();
      } else if (server.isRunning() && endpoint) {
        await server.stop();
        await start();
      }
      return next;
    },
    // The engine daemon's router, asking about models it does not have running.
    routerLoad: (id: string, image: boolean) => server.routerLoad(id, image),
    routerModels: () => server.routerModels(),
    routerModel: (id: string) => server.routerModel(id),
    defaults: DEFAULT_ENGINE_SETTINGS,
  };
}

export type Engine = ReturnType<typeof createEngine>;

/**
 * What the "will it fit" chips compare against (`status().memory`): VRAM
 * when there is a GPU to name, system RAM otherwise. Total, not free: the
 * question is whether the model can ever be served here.
 */
export function engineMemory(gpu: GpuStats | null, totalMemBytes: number): { budgetBytes: number; kind: 'vram' | 'unified' | 'ram' } {
  return gpu && gpu.devices.length > 0
    ? { budgetBytes: gpu.totalMB * 1024 * 1024, kind: gpu.unified ? 'unified' : 'vram' }
    : { budgetBytes: totalMemBytes, kind: 'ram' };
}

/** Whether an engine settings change re-serves the daemon's listener: the port, binding, key or CORS list. */
export function reservesEndpoint(patch: Partial<EngineSettings>): boolean {
  return patch.port !== undefined || patch.bind !== undefined || patch.apiKey !== undefined || patch.corsOrigins !== undefined;
}

/**
 * One image request as stable-diffusion.cpp's server takes it, or why it is
 * refused (`generateImage`): a prompt, dimensions from 256 to 2048 in
 * multiples of 64, 1 to 100 steps and CFG from 0 to 30.
 */
export function imageGenerationBody(request: import('@nekko-agent/shared').ImageGenerationRequest): { body: string } | { problem: string } {
  const { modelId, prompt, width, height, steps = 28, cfgScale = 4.5, seed = -1 } = request;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000 || ![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 64 === 0) || !Number.isInteger(steps) || steps < 1 || steps > 100 || !Number.isFinite(cfgScale) || cfgScale < 0 || cfgScale > 30 || !Number.isSafeInteger(seed) || seed < -1) {
    return { problem: 'Use a prompt, dimensions from 256 to 2048 in multiples of 64, 1 to 100 steps and CFG from 0 to 30.' };
  }
  return { body: JSON.stringify({ model: modelId, prompt: `${prompt}\n<sd_cpp_extra_args>${JSON.stringify({ sample_params: { sample_steps: steps, guidance: { txt_cfg: cfgScale } }, seed })}</sd_cpp_extra_args>`, size: `${width}x${height}`, n: 1, output_format: 'png' }) };
}

/** A library row in the shape the fit planner reads. */
export function modelFactsFor(m: LocalModel): ModelFacts {
  return {
    id: m.id,
    providerId: 'nekko-engine',
    weightsBytes: m.sizeBytes,
    layers: m.layers,
    kvHeads: m.kvHeads,
    headDim: m.headDim,
    maxContext: m.maxContext,
    quantization: m.quantization,
    parameterSize: m.parameterSize,
  };
}

/**
 * Where the planner expects this model to run under the settings it would be
 * loaded with (its preset, else the engine defaults). Only the loadable
 * text-family modalities get a verdict: for the rest "where it runs" is not
 * a GPU-layers question.
 */
export function gpuFitFor(model: LocalModel, hw: HardwareFacts, overheadFloorBytes?: number): GpuFit {
  if (model.format === 'mlx') return 'unknown';
  const modality = model.modality ?? modelModality(model);
  if (modality !== 'chat' && modality !== 'vision' && modality !== 'embedding') return 'unknown';
  const gpuLayerFraction =
    model.preset?.gpuLayers !== undefined && model.layers
      ? Math.min(1, Math.max(0, model.preset.gpuLayers / model.layers))
      : 1;
  const plan = computeFit(
    modelFactsFor(model),
    {
      contextTokens: model.preset?.contextTokens ?? defaultContextTokens(model),
      parallelSlots: model.preset?.parallelSlots ?? 1,
      kvCacheDtype: model.preset?.kvCacheDtype ?? 'f16',
      gpuLayerFraction,
    },
    hw,
    { overheadFloorBytes },
  );
  if (plan.verdict === 'unknown') return 'unknown';
  if (plan.verdict === 'wont-load') return 'wont';
  if (hw.devices.length === 0) return 'cpu';
  return plan.verdict === 'spills' || gpuLayerFraction < 1 ? 'partial' : 'full';
}

type FolderCandidates = ReturnType<typeof knownFolderCandidates>;

/**
 * The folder list, plus the known layouts on this machine nobody has added.
 *
 * Suggestions are probed rather than merely tested for existence, because an
 * empty Ollama folder is not worth a row and "LM Studio (0 models)" is an
 * invitation to wonder what went wrong.
 */
export async function folderReport(library: Library, candidates: FolderCandidates): Promise<ModelFolderReport> {
  const configured = await library.folderReport();
  const taken = new Set(configured.map((f) => resolve(f.path).toLowerCase()));

  const suggestions: ModelFolderSuggestion[] = [];
  for (const candidate of candidates) {
    for (const path of candidate.paths) {
      if (taken.has(resolve(path).toLowerCase())) continue;
      const found = await library.probe(path, candidate.provider);
      if (found.modelCount === 0) continue;
      taken.add(resolve(path).toLowerCase());
      suggestions.push({ provider: candidate.provider, path, ...found });
      break; // One row per app: the first of its candidate paths that has models.
    }
  }
  return { folders: configured, suggestions };
}

/**
 * Every known folder on this machine that has models in it, as the folder
 * list a first start adopts (`seedFolders`): one row per app, never the
 * primary folder.
 */
export async function seedFolderList(library: Library, modelsDir: string, candidates: FolderCandidates): Promise<ModelFolder[]> {
  const found: ModelFolder[] = [];
  const taken = new Set([resolve(modelsDir).toLowerCase()]);
  for (const candidate of candidates) {
    for (const path of candidate.paths) {
      const key = resolve(path).toLowerCase();
      if (taken.has(key)) continue;
      if ((await library.probe(path, candidate.provider)).modelCount === 0) continue;
      taken.add(key);
      found.push(knownFolder(candidate.provider, path));
      break;
    }
  }
  return found;
}

/* ------------------------------------------------- downloads, as pure plans */

/** Whether a file is on disk with something in it. */
export async function landed(path: string): Promise<boolean> {
  return stat(path).then((s) => s.size > 0).catch(() => false);
}

type PlannedDownload = Omit<DownloadRequest, 'verify' | 'after'>;

/**
 * The downloads one quantization of a catalog model takes (`downloadModel`):
 * the main file, then the sidecars (later shards, a projector, tokenizer
 * files) not already on disk. Every file of the build carries one group, so
 * the UI shows them as one download.
 */
export async function modelDownloadPlan(
  model: CatalogModel | null,
  modelId: string,
  quantLabel: string,
  modelsDir: string,
  isLanded: (path: string) => Promise<boolean>,
): Promise<{ ok: false; message: string } | { ok: true; message: string; main: PlannedDownload; extras: PlannedDownload[]; verifyGguf: boolean }> {
  const quant = model?.quants.find((q) => q.label === quantLabel) ?? model?.quants[0];
  if (!model || !quant) return { ok: false, message: 'That model is no longer published.' };

  const mlx = quant.format === 'mlx';
  const type = mlx ? 'mlx' : modelModality({ name: `${model.name} ${modelId} ${model.tags.join(' ')} ${model.pipelineTag ?? ''} ${quant.file}` });
  // An MLX checkpoint is a folder, and the library finds it by `mlx` in its
  // path: `<models>/mlx/<owner>_<repo>/`.
  const destFor = (file: string) => join(modelsDir, type, modelId.replace('/', '_'), file.split('/').pop() as string);
  const jobId = `model:${modelId}:${quant.label}`;
  const groupLabel = `${model.name} · ${quant.label}`;
  const group = { group: jobId, groupLabel };
  const main: PlannedDownload = {
    id: jobId,
    kind: 'model',
    label: groupLabel,
    target: modelId,
    url: hfFileUrl(modelId, quant.file),
    dest: destFor(quant.file),
    ...group,
    file: quant.file,
  };
  const extras: PlannedDownload[] = [];
  for (const extra of quant.extraFiles ?? []) {
    const dest = destFor(extra);
    // Sidecars are shared across quants; one already on disk is not fetched
    // again when a second build of the same repo is downloaded.
    if (await isLanded(dest)) continue;
    extras.push({
      id: `${jobId}:${extra}`,
      kind: 'model',
      label: `${model.name} · ${extra.split('/').pop()}`,
      target: modelId,
      url: hfFileUrl(modelId, extra),
      dest,
      ...group,
      file: extra,
    });
  }
  return { ok: true, message: `Downloading ${model.name} (${quant.label}).`, main, extras, verifyGguf: !mlx };
}

/**
 * Which Hugging Face repo a library model came from, guessed from its id.
 *
 * A borrowed folder nests `publisher/repo/file` under the folder id
 * (`lmstudio/unsloth/Qwen3-4B/file`), so the repo is the middle two segments.
 * Our own downloads land in a dir named `owner_repo` (the single `_` the
 * download path writes), so the first segment splits on its first `_`.
 * Anything else (a loose import, an id a folder provider invented) returns
 * undefined, which the caller turns into an honest "cannot tell" answer.
 */
export function sourceRepoFor(model: LocalModel): string | undefined {
  if (model.sourceRepo) return model.sourceRepo;
  const segs = model.id.split('/');
  if (model.folderId && model.folderId !== 'primary' && segs.length >= 3) {
    return `${segs[1]}/${segs[2]}`;
  }
  if ((!model.folderId || model.folderId === 'primary') && segs.length >= 2) {
    const dir = segs[0];
    const i = dir.indexOf('_');
    if (i > 0 && i < dir.length - 1) return `${dir.slice(0, i)}/${dir.slice(i + 1)}`;
  }
  return undefined;
}

/**
 * The companion files to fetch for a model on disk (`downloadCompanions`),
 * given what its repo ships (`found`, null when the repo could not be read).
 */
export async function companionsPlan(
  model: LocalModel,
  repo: string,
  found: { projector?: string; sidecars: string[] } | null,
  modelsDir: string,
  isLanded: (path: string) => Promise<boolean>,
): Promise<{ ok: boolean; message: string; requests: PlannedDownload[] }> {
  if (!found) {
    return { ok: false, message: `Could not read the ${repo} repo on Hugging Face. It may be private or renamed.`, requests: [] };
  }
  const wanted = [found.projector, ...found.sidecars].filter((f): f is string => Boolean(f));
  if (!wanted.length) {
    return { ok: true, message: `${repo} ships no companion files for ${model.name}.`, requests: [] };
  }
  const destDir = model.managed === false ? companionsDir(modelsDir, model.id) : dirname(model.path);
  const requests: PlannedDownload[] = [];
  for (const file of wanted) {
    const fileName = file.split('/').pop() as string;
    const dest = join(destDir, fileName);
    // A file already beside the weights counts even when the destination is
    // the companions dir: no point fetching what is already there.
    const beside = join(dirname(model.path), fileName);
    const already = (await isLanded(dest)) || (dest !== beside && (await isLanded(beside)));
    if (already) continue;
    requests.push({
      id: `companions:${model.id}:${file}`,
      kind: 'model',
      label: `${model.name} · ${fileName}`,
      target: model.id,
      url: hfFileUrl(repo, file),
      dest,
      group: `companions:${model.id}`,
      groupLabel: `${model.name} · companion files`,
      file,
    });
  }
  const queued = requests.length;
  return queued
    ? { ok: true, message: `Fetching ${queued} companion file${queued === 1 ? '' : 's'} for ${model.name} from ${repo}.`, requests }
    : { ok: true, message: `${model.name} already has every companion file ${repo} ships.`, requests };
}

/**
 * The text encoders and VAE to fetch for an image model
 * (`downloadImageCompanions`), from what its set has on disk. A gated file
 * goes out with the Hugging Face token; without one its ungated stand-in does.
 */
export function imageCompanionsPlan(
  model: LocalModel,
  status: ImageCompanionStatus | null,
  token: string | undefined,
  modelsDir: string,
): { ok: boolean; message: string; requests: PlannedDownload[] } {
  const set = imageCompanionSetFor(model);
  if (!set || !status) {
    return { ok: false, message: `No known text encoders for ${model.name}. Set their paths in its image settings.`, requests: [] };
  }
  const dir = imageCompanionsDir(modelsDir);
  const requests: PlannedDownload[] = [];
  let bytes = 0;
  let stoodIn = '';
  set.files.forEach((file, i) => {
    if (status.files[i].path) return;
    const pick = file.gated && !token && file.fallback ? file.fallback : file;
    if (pick !== file) stoodIn = ` Its VAE needs a Hugging Face token with the ${file.repo} license accepted, so the small TAESD decoder stands in (slightly softer detail).`;
    requests.push({
      id: `image-companions:${pick.saveAs}`,
      kind: 'model',
      label: `${set.label} · ${pick.role}`,
      target: model.id,
      url: hfFileUrl(pick.repo, pick.file),
      dest: join(dir, pick.saveAs),
      group: `image-companions:${model.id}`,
      groupLabel: `${set.label} · text encoders and VAE`,
      file: pick.file,
      role: pick.role,
      headers: pick === file && file.gated && token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    bytes += pick.bytes;
  });
  const queued = requests.length;
  if (!queued) return { ok: true, message: `${model.name} already has its text encoders and VAE.`, requests };
  return { ok: true, message: `Fetching ${queued} file${queued === 1 ? '' : 's'} (${(bytes / 1e9).toFixed(1)} GB) for ${set.label}.${stoodIn}`, requests };
}

/**
 * The model jobs that have just finished (`onDownloadsChanged`): main model
 * files only, each once. `seen` carries every job's last state between calls.
 */
export function finishedModelJobs(jobs: DownloadJob[], seen: Map<string, DownloadJob['state']>): DownloadJob[] {
  const present = new Set(jobs.map((j) => j.id));
  for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
  const finished = jobs.filter(
    (j) =>
      j.kind === 'model' &&
      j.state === 'done' &&
      seen.get(j.id) !== 'done' &&
      // `model:<repo>:<quant>` is three segments; a companion's id appends
      // the file (`model:<repo>:<quant>:<file>`) and does not count.
      j.id.split(':').length === 3 &&
      j.dest,
  );
  for (const j of jobs) seen.set(j.id, j.state);
  return finished;
}

/** The library row a finished download created, matched on where it landed. */
export function downloadedModel(list: LocalModel[], job: DownloadJob): LocalModel | undefined {
  const dest = resolve(job.dest as string);
  return list.find((m) => {
    const p = resolve(m.path);
    // A GGUF job lands on the model file itself; an MLX job lands on a file
    // inside the model folder, whose path is what the library lists.
    return p === dest || p === resolve(dirname(dest));
  });
}

/**
 * The preset a fresh download starts with: the planner's best full-GPU
 * answer, falling back to the honest partial one. Nothing is written when
 * there is no GPU to fill, or the planner cannot read the model or says it
 * cannot run at all: a saved wrong setting is worse than the engine's default.
 */
export function gpuFirstPreset(model: LocalModel, hw: HardwareFacts | undefined, overheadFloorBytes: number): EngineLoadPreset | undefined {
  if (!hw || hw.devices.length === 0) return undefined;
  const result = autoFit({
    facts: modelFactsFor(model),
    hardware: hw,
    budgetFraction: 0.9,
    // The engine caps unnamed context at 64k on purpose (see
    // defaultContextTokens); the preset gets the same ceiling.
    maxContextTokens: defaultContextTokens(model),
    options: { overheadFloorBytes },
  });
  if (result.plan.verdict === 'unknown' || result.plan.verdict === 'wont-load') return undefined;
  const layers = model.layers ?? result.plan.totalLayers;
  return {
    contextTokens: result.request.contextTokens,
    kvCacheDtype: result.request.kvCacheDtype,
    parallelSlots: result.request.parallelSlots,
    gpuLayers: layers !== undefined ? Math.round(layers * result.request.gpuLayerFraction) : undefined,
    budgetFraction: 0.9,
  };
}

export { readGgufMetadata } from './gguf.js';
export { buildArgs, explainLoadError } from './server.js';
export { useEngineDaemon } from './daemon.js';
export type { ModelCompanions } from './server.js';
export { buildsFor, recommendedBuild, matchAsset, matchCompanion, allBuilds } from './builds.js';
export { hfFileUrl } from './catalog.js';
export type { EngineInstall, CatalogModel };
