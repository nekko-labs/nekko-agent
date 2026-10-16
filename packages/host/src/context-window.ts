import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import { guessContextWindow, isLocalProvider, modelMediaSupport } from '@nekko-agent/shared';

/**
 * The context window a turn actually has, in tokens.
 *
 * `guessContextWindow` reads a model id, and for a local model that is the
 * wrong number twice over: an id like `qwen3:8b` says nothing (the guess is a
 * cautious 128k), and what matters is not the model's maximum but what the
 * server loaded it with. Ollama loads with a 4k-8k context unless told
 * otherwise and silently drops the start of a longer prompt; llama.cpp and LM
 * Studio refuse it. Either way a run that believes it has 128k overflows long
 * before anything notices.
 *
 * So the model list is asked first: LM Studio's loaded context, the engine's
 * and OpenRouter's advertised context, Ollama's `/api/ps` for a loaded model.
 * Results are cached briefly per provider, so a turn costs one list request
 * at most, and nothing here ever blocks a turn: a failure falls back to the
 * guess.
 */

const CACHE_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 2_500;

interface Listing {
  at: number;
  windows: Map<string, number>;
  /** The listed rows by id, for what else a turn reads off them (image input). */
  models: Map<string, ModelInfo>;
}

const cache = new Map<string, Listing>();

/** Ollama's loaded context per model (`/api/ps`), which the model list does not carry. */
async function ollamaLoaded(baseUrl: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!res.ok) return out;
  const body = (await res.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
  for (const m of body.models ?? []) {
    const ctx = m.context_length;
    if (typeof ctx === 'number' && ctx > 0) for (const id of [m.name, m.model]) if (id) out.set(id, ctx);
  }
  return out;
}

async function listingFor(provider: ProviderConfig, list: () => Promise<ModelInfo[]>): Promise<Listing> {
  const hit = cache.get(provider.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const windows = new Map<string, number>();
  const rows = new Map<string, ModelInfo>();
  const timeout = new Promise<ModelInfo[]>((resolve) => setTimeout(() => resolve([]), LOOKUP_TIMEOUT_MS));
  const models = await Promise.race([list().catch(() => [] as ModelInfo[]), timeout]);
  for (const m of models) {
    rows.set(m.id, m);
    if (m.contextLength && m.contextLength > 0) windows.set(m.id, m.contextLength);
  }
  if (provider.kind === 'ollama') {
    for (const [id, ctx] of await ollamaLoaded(provider.baseUrl).catch(() => new Map<string, number>())) windows.set(id, ctx);
  }
  const listing = { at: Date.now(), windows, models: rows };
  cache.set(provider.id, listing);
  return listing;
}

/** Providers whose model list is worth asking for per-model facts. */
function asksList(provider: ProviderConfig): boolean {
  return isLocalProvider(provider.kind) || provider.kind === 'openai-compat' || provider.kind === 'openrouter';
}

/**
 * The window for `modelId` on `provider`: what the server reports when it
 * reports one, else the id-based guess. Only local servers and providers that
 * list per-model windows are asked; everything else is the guess, as before.
 */
export async function contextWindowFor(provider: ProviderConfig | undefined, modelId: string, list: () => Promise<ModelInfo[]>): Promise<number> {
  const guess = guessContextWindow(modelId);
  if (!provider || !asksList(provider)) return guess;
  try {
    const reported = (await listingFor(provider, list)).windows.get(modelId);
    return reported && reported > 0 ? reported : guess;
  } catch {
    return guess;
  }
}

/**
 * Whether a turn may send `modelId` pictures: false only when the model is
 * known not to take them (the engine's model without a projector, a catalog
 * listing text only, a text-only family). Unknown stays true, so a server we
 * cannot classify is not stripped of what it might see. Reads the same cached
 * list as `contextWindowFor`, so it costs no extra request.
 */
export async function imageInputFor(provider: ProviderConfig | undefined, modelId: string, list: () => Promise<ModelInfo[]>): Promise<boolean> {
  let model: ModelInfo | undefined;
  if (provider && asksList(provider)) {
    try {
      model = (await listingFor(provider, list)).models.get(modelId);
    } catch {
      model = undefined;
    }
  }
  return modelMediaSupport({ modelId, providerKind: provider?.kind, model }).image !== 'no';
}

/** The last window a turn used for `modelId` on `providerId`, without asking anyone. */
export function knownContextWindow(providerId: string | undefined, modelId: string | undefined): number {
  const reported = providerId && modelId ? cache.get(providerId)?.windows.get(modelId) : undefined;
  return reported ?? guessContextWindow(modelId);
}

/** Tests only. */
export function __resetContextWindows(): void {
  cache.clear();
}
