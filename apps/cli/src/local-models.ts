import type { CatalogModel, CatalogQuant, DownloadJob, ProviderConfig } from '@nekko-agent/shared';
import { isRuntimeKind } from '@nekko-agent/shared';
import type { Client } from './lib.js';

/**
 * Local model management for external agents (MCP) and the terminal (CLI).
 *
 * The app's Model Server page drives the built-in engine (llama.cpp behind
 * Nekko's own router) and any other local runtime (Ollama, LM Studio, vLLM)
 * through host channels that already exist. This module is the thin layer that
 * lets Claude Code or a shell script do the same: find the runtime a request
 * means, pick a sensible quantization, and answer in short JSON a model can
 * read without wading through the UI's full state.
 */

/** The quantization a download picks when the caller does not name one. */
const PREFERRED_QUANTS = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q4_0', 'Q6_K', 'Q8_0'];

/**
 * The runtime provider a request addresses: the one named, or the built-in
 * engine. Only local runtimes qualify, because start/stop/load mean nothing
 * for a cloud API.
 */
export function runtimeProvider(providers: ProviderConfig[], providerId?: string): ProviderConfig {
  if (providerId) {
    const p = providers.find((x) => x.id === providerId);
    if (!p) throw new Error(`No provider "${providerId}". See nekko-agent_status for configured providers.`);
    if (!isRuntimeKind(p.kind)) {
      throw new Error(`"${providerId}" is a ${p.kind} provider, not a local runtime; only local model servers can be started, stopped or loaded.`);
    }
    return p;
  }
  const engine = providers.find((x) => x.kind === 'llamacpp');
  if (!engine) {
    throw new Error('The built-in engine has no provider entry yet. Open the app once (or run nekko-agent_engine_status) so it registers, or pass providerId for another local runtime.');
  }
  return engine;
}

/**
 * Which quantization to download. An exact label wins (case-insensitive); with
 * none, the catalog's own recommended pick order, then the first one listed.
 */
export function pickQuant(model: CatalogModel, requested?: string): CatalogQuant {
  if (!model.quants.length) throw new Error(`${model.id} publishes no downloadable GGUF/MLX files.`);
  if (requested) {
    const hit = model.quants.find((q) => q.label.toLowerCase() === requested.toLowerCase());
    if (!hit) {
      throw new Error(`${model.id} has no "${requested}" quantization. Available: ${model.quants.map((q) => q.label).join(', ')}`);
    }
    return hit;
  }
  for (const label of PREFERRED_QUANTS) {
    const hit = model.quants.find((q) => q.label.toUpperCase() === label);
    if (hit) return hit;
  }
  return model.quants[0];
}

const GB = 1024 ** 3;
export const gb = (bytes?: number) => (typeof bytes === 'number' ? Math.round((bytes / GB) * 10) / 10 : undefined);

/** One download as an agent needs it: what, how far, and whether it is over. */
export function summarizeDownload(job: DownloadJob) {
  const pct = job.totalBytes ? Math.round((job.receivedBytes / job.totalBytes) * 1000) / 10 : undefined;
  const remaining = job.totalBytes && job.bytesPerSecond ? Math.round((job.totalBytes - job.receivedBytes) / job.bytesPerSecond) : undefined;
  return {
    id: job.id,
    kind: job.kind,
    label: job.groupLabel ?? job.label,
    file: job.file,
    target: job.target,
    state: job.state,
    percent: pct,
    receivedGB: gb(job.receivedBytes),
    totalGB: gb(job.totalBytes),
    etaSeconds: job.state === 'downloading' ? remaining : undefined,
    message: job.message,
  };
}

/** The engine's library, trimmed to what picking and loading a model needs. */
export async function listLocalModels(client: Client) {
  const models = await client.engineModels();
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    loaded: m.loaded,
    sizeGB: gb(m.sizeBytes),
    quantization: m.quantization,
    parameterSize: m.parameterSize,
    modality: m.modality,
    format: m.format ?? 'gguf',
    fit: m.gpuFit,
    maxContext: m.maxContext,
    lastLoadError: m.lastLoadError,
  }));
}

/** Engine install + server state, plus every other local runtime's, in one read. */
export async function localModelStatus(client: Client) {
  const [engine, settings] = await Promise.all([client.engineStatus(), client.getSettings()]);
  const others = settings.providers.filter((p) => isRuntimeKind(p.kind) && p.kind !== 'llamacpp' && p.enabled !== false);
  const runtimes = await Promise.all(
    others.map(async (p) => {
      const s = await client.runtimeStatus(p.id).catch((e: Error) => ({ error: e.message }) as const);
      if (!s) return { providerId: p.id, kind: p.kind, running: false };
      if ('error' in s && !('kind' in s)) return { providerId: p.id, kind: p.kind, error: s.error };
      return {
        providerId: p.id,
        kind: p.kind,
        running: s.running,
        installed: s.installed,
        owned: s.owned,
        baseUrl: s.baseUrl,
        resident: s.resident.map((r) => r.id),
        error: s.error ?? s.reason,
      };
    }),
  );
  const engineProvider = settings.providers.find((p) => p.kind === 'llamacpp');
  return {
    engine: {
      providerId: engineProvider?.id ?? null,
      installed: Boolean(engine.install.binPath),
      version: engine.install.version,
      backend: engine.install.backend,
      notInstalledReason: engine.install.binPath ? undefined : engine.install.reason,
      running: engine.running,
      port: engine.port,
      resident: engine.resident.map((r) => ({ id: r.id, contextLength: r.contextLength, loadedOn: r.loadedOn, vramGB: gb(r.vramBytes) })),
      loading: engine.loading?.map((l) => ({ id: l.id, phase: l.phase, progress: l.progress })),
      memory: engine.memory ? { kind: engine.memory.kind, budgetGB: gb(engine.memory.budgetBytes) } : undefined,
    },
    runtimes,
  };
}

/** Catalog search (or the curated starter list), trimmed for a model to choose from. */
export async function searchCatalog(client: Client, query?: string) {
  const results = await client.engineCatalog(query?.trim() || undefined);
  return results.slice(0, 20).map((m) => ({
    id: m.id,
    name: m.name,
    parameterSize: m.parameterSize,
    summary: m.summary,
    tags: m.tags,
    recommended: m.recommended || undefined,
    gated: m.gated || undefined,
    downloads: m.downloads,
    quants: m.quants.map((q) => ({ label: q.label, sizeGB: gb(q.sizeBytes) })),
  }));
}

/** Start downloading a catalog model, choosing a quantization when none is named. */
export async function downloadModel(client: Client, modelId: string, quant?: string) {
  const model = await client.engineCatalogModel(modelId);
  if (!model) throw new Error(`No model "${modelId}" in the catalog. Use nekko-agent_model_search to find its Hugging Face id (owner/repo).`);
  const chosen = pickQuant(model, quant);
  const res = await client.engineDownloadModel(model.id, chosen.label);
  if (!res.ok) throw new Error(res.message);
  return { ok: true, modelId: model.id, quant: chosen.label, sizeGB: gb(chosen.sizeBytes), jobId: res.jobId, message: res.message };
}

/**
 * Load a model into a runtime. The built-in engine starts its server on the
 * first load, so this is also "run this model".
 */
export async function loadModel(
  client: Client,
  args: { modelId: string; providerId?: string; contextTokens?: number; gpuLayers?: number; ttlSeconds?: number },
) {
  const provider = runtimeProvider((await client.getSettings()).providers, args.providerId);
  const params = {
    ...(args.contextTokens ? { contextTokens: args.contextTokens } : {}),
    ...(typeof args.gpuLayers === 'number' ? { gpuLayers: args.gpuLayers } : {}),
    ...(typeof args.ttlSeconds === 'number' ? { ttlSeconds: args.ttlSeconds } : {}),
  };
  const res = await client.runtimeLoad(provider.id, args.modelId, params);
  if (!res.ok) throw new Error(res.message ?? `Could not load ${args.modelId}.`);
  return {
    ok: true,
    providerId: provider.id,
    modelId: args.modelId,
    message: res.message,
    hint: `Use it with nekko-agent_chat { provider: "${provider.id}", model: "${args.modelId}" }.`,
  };
}

export async function unloadModel(client: Client, args: { modelId: string; providerId?: string }) {
  const provider = runtimeProvider((await client.getSettings()).providers, args.providerId);
  const res = await client.unloadModel(provider.id, args.modelId);
  if (!res.ok) throw new Error(res.message ?? `Could not unload ${args.modelId}.`);
  return { ok: true, providerId: provider.id, modelId: args.modelId, message: res.message };
}

export async function startRuntime(client: Client, providerId?: string) {
  const provider = runtimeProvider((await client.getSettings()).providers, providerId);
  const res = await client.runtimeStart(provider.id);
  if ('error' in res && !('kind' in res)) throw new Error(res.error);
  const s = res as Exclude<typeof res, { error: string }>;
  if (s.error) throw new Error(s.error);
  return { ok: s.running, providerId: provider.id, running: s.running, baseUrl: s.baseUrl, version: s.version };
}

/**
 * Stop a runtime. Without `force` a process this app did not start is left
 * alone, and the answer says so, so an agent can ask its user before forcing.
 */
export async function stopRuntime(client: Client, providerId?: string, force = false) {
  const provider = runtimeProvider((await client.getSettings()).providers, providerId);
  const res = await client.runtimeStop(provider.id, force);
  if (res.needsConfirmation) {
    return {
      ok: false,
      needsConfirmation: true,
      providerId: provider.id,
      message: `${res.message} ${res.processName ? `(${res.processName}) ` : ''}This process was not started by Nekko Agent; confirm with the user, then pass force: true.`,
    };
  }
  if (!res.ok) throw new Error(res.message);
  return { ok: true, providerId: provider.id, message: res.message };
}

/**
 * Poll one download until it is over. Companion files (shards, projectors)
 * share the main job's group, so the whole group has to land, not just the
 * first file.
 */
export async function waitForDownload(
  client: Client,
  jobId: string | undefined,
  onProgress?: (line: string) => void,
  intervalMs = 1000,
): Promise<ReturnType<typeof summarizeDownload> | undefined> {
  if (!jobId) return undefined;
  const over = ['done', 'failed', 'cancelled'];
  for (;;) {
    const jobs = await client.engineDownloads();
    const main = jobs.find((j) => j.id === jobId);
    if (!main) return undefined;
    const group = main.group ? jobs.filter((j) => j.group === main.group) : [main];
    const failed = group.find((j) => j.state === 'failed' || j.state === 'cancelled');
    const s = summarizeDownload(main);
    onProgress?.(`${s.label}: ${s.state}${s.percent !== undefined ? ` ${s.percent}%` : ''}${s.totalGB !== undefined ? ` of ${s.totalGB} GB` : ''}${s.etaSeconds !== undefined ? `, ~${s.etaSeconds}s left` : ''}   `);
    if (failed) return summarizeDownload(failed);
    if (group.every((j) => over.includes(j.state))) return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
