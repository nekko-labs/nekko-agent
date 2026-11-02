/**
 * Model auto-mode, a pure heuristic that picks the best available model for a
 * given prompt, with no extra model calls. "Best" means: match a strong model
 * to complex/coding work and a cheap/fast model to quick questions, among the
 * models the chat's provider actually exposes. Used by the ChatPane when the
 * user selects the ✨ Auto model option.
 *
 * Auto has three profiles (see `AutoQuality`) so "let Nekko pick" isn't a
 * single opaque policy: Cheap always reaches for the smallest capable model,
 * Quality always reaches for the strongest, and Normal reads the prompt and
 * picks between them. The pick is explained (not just returned) so the composer
 * can show which model the next message will run on, and why.
 */

import type { ModelInfo } from './models.js';
import type { LimitWindow, SubscriptionLimits } from './limits.js';
import { getModelPrice, modelPricing } from './limits.js';
import { resolveModelAvailability, windowCoversModel } from './model-availability.js';

/** Sentinel model id meaning "let Nekko pick per turn". */
export const AUTO_MODEL_ID = '__auto__';

/** How aggressively Auto mode spends on capability. */
export type AutoQuality = 'cheap' | 'normal' | 'quality';

export const AUTO_QUALITIES: AutoQuality[] = ['cheap', 'normal', 'quality'];

/** Short labels + descriptions for the Auto profile picker. */
export const AUTO_QUALITY_META: Record<AutoQuality, { label: string; description: string }> = {
  cheap: { label: 'Cheap', description: 'Always the smallest capable model.' },
  normal: { label: 'Normal', description: 'Reads the prompt, picks to match.' },
  quality: { label: 'Quality', description: 'Always the strongest model available.' },
};

const COMPLEX_RE =
  /\b(implement|refactor|debug|architecture|design|migrat|optim[iy]|algorithm|concurren|distributed|security|performance|test|build|fix the|root cause|trace|why does|explain how)\b/i;

/** Heuristic: does this prompt warrant a stronger (pricier) model? */
export function isComplexPrompt(prompt: string): boolean {
  if (prompt.length > 600) return true;
  // Multi-step asks (numbered lists, several sentences) lean complex.
  if (/```/.test(prompt)) return true;
  return COMPLEX_RE.test(prompt);
}

/**
 * Models that aren't conversational: speech recognition, embeddings, rerankers,
 * text-to-speech, OCR, single-task models, and image generation. A local server
 * usually lists these alongside its chat models (LM Studio happily serves
 * `whisper-large-v3` and `unlimited-ocr` from the same endpoint), and picking one
 * for a reply just fails - so Auto never considers them. Matched on whole
 * name segments, and permissive on purpose: an unknown model is assumed to be a
 * chat model. Vision-language models are chat models and stay in.
 */
const NON_CHAT_RE =
  /(^|[\W_])(whisper|distil-whisper|parakeet|wav2vec|seamless|tts|piper|kokoro|bark|xtts|embed|embedding|bge|gte|e5|nomic-embed|minilm|jina-(embed|clip)|rerank|reranker|colbert|clip|siglip|sd|sdxl|sd3|stable-diffusion|flux|dall-e|dalle|ocr|trocr|paddle|florence|donut|layoutlm|translate|moderation|guard)([\W_]|$)/i;

/** Whether this model can hold a conversation (so Auto may pick it). */
export function isChatModel(model: ModelInfo): boolean {
  return !NON_CHAT_RE.test(`${model.id} ${model.name}`);
}

/**
 * Capability tier for a model, inferred from its id/name (higher = stronger).
 * Deliberately coarse, it only needs to rank what a provider offers.
 */
export function modelTier(model: ModelInfo): number {
  const id = `${model.id} ${model.name}`.toLowerCase();
  if (/opus|gpt-5|o1-pro|405b|70b|72b/.test(id)) return 5;
  if (/sonnet|gpt-4o(?!-mini)|gpt-4\.1(?!-mini)|o3(?!-mini)|o1(?!-mini)|llama-3\.[13]|qwen2?\.?5?-?(32|34)b|mixtral/.test(id)) return 4;
  if (/haiku|mini|flash|small|1\.5b|3b|7b|8b|9b|phi|gemma/.test(id)) return 2;
  return 3;
}

/** The model Auto settled on, plus enough context to explain the choice. */
export interface AutoPick {
  modelId: string;
  /** The chosen model's display name, for the composer chip. */
  name: string;
  /** One short sentence saying why this model, shown on hover. */
  reason: string;
  /** Inferred capability tier of the chosen model (see `modelTier`). */
  tier: number;
  /** Whether the prompt read as complex work (Normal profile only uses this). */
  complex: boolean;
}

/**
 * Resolve Auto mode to a concrete model, with the reasoning attached.
 *
 * Cheap and Quality ignore the prompt entirely (they're a standing instruction
 * about spend, and a picker that silently changes its mind is worse than one
 * that doesn't). Normal reads the prompt: complex work gets the strongest model
 * available, quick questions get the smallest capable one. "Capable" means tier
 * 2 and up, so Auto never drops onto a toy model when something better is
 * loaded. Ties break toward `preferred` (starred) ids, then list order.
 */
export function pickAutoModel(
  models: ModelInfo[],
  prompt: string,
  { quality = 'normal', preferred = new Set<string>() }: { quality?: AutoQuality; preferred?: Set<string> } = {},
): AutoPick | null {
  if (models.length === 0) return null;
  // Speech, embedding, and image models can't answer a chat turn. Fall back to
  // the raw list only if filtering would leave nothing to pick from.
  const chatOnly = models.filter(isChatModel);
  const candidates = chatOnly.length ? chatOnly : models;

  const complex = isComplexPrompt(prompt);
  // Normal is the only profile that lets the prompt move the target.
  const wantStrong = quality === 'quality' || (quality === 'normal' && complex);

  const ranked = candidates
    .map((m, i) => ({ m, tier: modelTier(m), i, fav: preferred.has(m.id) ? 0 : 1 }))
    .sort((a, b) => {
      const byTier = wantStrong ? b.tier - a.tier : a.tier - b.tier;
      return byTier || a.fav - b.fav || a.i - b.i;
    });

  // Reaching down for a cheap model shouldn't land below tier 2 when something
  // more capable is available.
  const capable = ranked.filter((r) => r.tier >= 2);
  const chosen = (!wantStrong && capable.length ? capable[0] : ranked[0]);

  return {
    modelId: chosen.m.id,
    name: chosen.m.name || chosen.m.id,
    tier: chosen.tier,
    complex,
    reason: autoReason(quality, complex, candidates.length),
  };
}

function autoReason(quality: AutoQuality, complex: boolean, count: number): string {
  if (count === 1) return 'The only model this provider offers.';
  if (quality === 'cheap') return 'Cheap: the smallest model that can still do the job.';
  if (quality === 'quality') return 'Quality: the strongest model available, whatever you ask.';
  return complex
    ? 'This reads like real work, so Auto reached for the strongest model.'
    : 'A quick question, so Auto picked a smaller, faster model.';
}

/**
 * A usage window is "spent" for switching purposes once it is rate-limited or
 * within the last sliver of its allowance: at 95% a turn queued behind it would
 * still land, but the turn after that very likely would not, so the honest
 * move is to look for headroom now rather than mid-failure.
 */
export const PROVIDER_SPENT_THRESHOLD = 95;

/**
 * A same-tier candidate counts as "materially cheaper" once its blended
 * per-million-token price is at most this fraction of the home pick's. A
 * smaller gap is noise (context mix swings the real bill more than that).
 */
export const PROVIDER_CHEAPER_RATIO = 0.6;

/** One provider's models plus what is known about its remaining capacity. */
export interface ProviderPool {
  providerId: string;
  providerLabel: string;
  models: ModelInfo[];
  /** Live usage windows, when this provider can be measured at all. */
  limits?: SubscriptionLimits | null;
  /** Passed through to the availability resolver (signed-out check). */
  auth?: 'apikey' | 'subscription';
  tokenKey?: string;
  /** Local on-device providers run free; their models cost nothing to serve. */
  local?: boolean;
}

/** An Auto pick, tagged with the provider it landed on. */
export interface AutoProviderPick extends AutoPick {
  providerId: string;
  providerLabel: string;
  /** True when the pick moved the turn off the chat's own provider. */
  switched: boolean;
}

/** The chat-capable models a provider can still serve right now. */
function runnableModels(pool: ProviderPool): ModelInfo[] {
  return pool.models
    .filter(isChatModel)
    .filter(
      (m) =>
        resolveModelAvailability({ model: m, provider: pool, limits: pool.limits }).status === 'ready',
    );
}

/**
 * The window that will stop this provider next: the most-used window covering
 * at least one chat model the provider offers. Account-wide windows cover
 * everything; model windows count only for the family they name.
 */
function bindingWindowFor(pool: ProviderPool): LimitWindow | undefined {
  const chat = pool.models.filter(isChatModel);
  return [...(pool.limits?.windows ?? [])]
    .filter((w) => chat.some((m) => windowCoversModel(w, m.id)))
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

/**
 * Why this provider is about to stop serving turns, or null when it is fine.
 * Exported so the composer can fetch standby provider lists only when the
 * trigger is real rather than on every render.
 */
export function providerSwitchTrigger(pool: ProviderPool): string | null {
  const win = bindingWindowFor(pool);
  if (win && (win.status === 'rate_limited' || win.usedPercent >= PROVIDER_SPENT_THRESHOLD)) {
    return win.usedPercent >= 100 || win.status === 'rate_limited'
      ? `the ${win.label} limit is used up`
      : `the ${win.label} limit is ${Math.round(win.usedPercent)}% used`;
  }
  if (pool.models.some(isChatModel) && runnableModels(pool).length === 0) {
    return 'it has no usable models right now';
  }
  return null;
}

/**
 * Blended per-million-token price of serving one turn with this model on this
 * pool: provider-published prices first (the meter the bill runs on), then the
 * static pricing table. Local providers and subscription plans cost the user
 * nothing per turn. `undefined` when neither side publishes a price, so a
 * candidate can never be called "cheaper" on a guess.
 */
function turnPrice(pool: ProviderPool, m: ModelInfo): number | undefined {
  if (pool.local || pool.auth === 'subscription') return 0;
  const pub = modelPricing(m);
  if (pub) return (pub.input + pub.output) / 2;
  const p = getModelPrice(m.id);
  return p ? (p.input + p.output) / 2 : undefined;
}

/**
 * Auto mode across providers. The home provider keeps the pick whenever it can
 * serve; when it is spent and `switchOnCapacity` is on, the turn moves to an
 * equivalent model on the provider with the most headroom, and when home is
 * healthy but a same-tier model elsewhere is materially cheaper, the turn
 * moves there instead. "Equivalent" is load-bearing: candidates must be at
 * least the tier the home pick would have been, so a switch is never a silent
 * downgrade, and a step up says so in the reason. A provider with no measured
 * limits reads as full headroom (a metered-key provider has no capacity
 * ceiling), but a measured one wins ties.
 */
export function pickAcrossProviders(
  pools: ProviderPool[],
  prompt: string,
  {
    quality = 'normal',
    preferred = new Set<string>(),
    homeProviderId,
    switchOnCapacity = false,
  }: {
    quality?: AutoQuality;
    /** Favorites as `${providerId}::${modelId}` so a star survives the move. */
    preferred?: Set<string>;
    homeProviderId?: string;
    switchOnCapacity?: boolean;
  } = {},
): AutoProviderPick | null {
  const home = pools.find((p) => p.providerId === homeProviderId) ?? pools[0];
  if (!home) return null;

  const favsFor = (p: ProviderPool) =>
    new Set(p.models.filter((m) => preferred.has(`${p.providerId}::${m.id}`)).map((m) => m.id));
  const homeRunnable = runnableModels(home);
  // The pick also runs over the unfiltered list when everything is blocked:
  // its tier is still the standard a switch candidate has to meet.
  const homePick = pickAutoModel(homeRunnable.length ? homeRunnable : home.models, prompt, {
    quality,
    preferred: favsFor(home),
  });
  const toPick = (p: ProviderPool, pick: AutoPick, switched: boolean): AutoProviderPick => ({
    ...pick,
    providerId: p.providerId,
    providerLabel: p.providerLabel,
    switched,
  });
  if (!homePick) return null;
  if (!switchOnCapacity) return toPick(home, homePick, false);

  const wantedTier = homePick.tier;
  const candidates = pools
    .filter((p) => p !== home)
    .flatMap((p) => {
      const win = bindingWindowFor(p);
      const headroom = win ? 100 - win.usedPercent : 100;
      return runnableModels(p).map((m) => ({
        pool: p,
        m,
        tier: modelTier(m),
        headroom,
        price: turnPrice(p, m),
        measured: !!p.limits,
        fav: preferred.has(`${p.providerId}::${m.id}`),
      }));
    })
    .filter((c) => c.tier >= wantedTier);

  const capacityTrigger = providerSwitchTrigger(home);
  let best: (typeof candidates)[number] | undefined;
  let reason: string | undefined;
  if (capacityTrigger) {
    // Capacity switch: most headroom first, measured before assumed, then the
    // closest tier, then the cheaper of two equal options, then favorites.
    best = [...candidates].sort(
      (a, b) =>
        b.headroom - a.headroom ||
        Number(b.measured) - Number(a.measured) ||
        Math.abs(a.tier - wantedTier) - Math.abs(b.tier - wantedTier) ||
        (a.price ?? Infinity) - (b.price ?? Infinity) ||
        Number(b.fav) - Number(a.fav),
    )[0];
    if (best) {
      reason = `${home.providerLabel}: ${capacityTrigger}, so this turn runs on ${best.m.name || best.m.id} on ${best.pool.providerLabel}`;
    }
  } else {
    // Cost switch: home is healthy, so only a materially cheaper same-tier
    // model elsewhere justifies moving the turn. Cheapest wins outright.
    const homeModel = home.models.find((m) => m.id === homePick.modelId);
    const homePrice = homeModel ? turnPrice(home, homeModel) : undefined;
    best = candidates
      .filter(
        (c) =>
          homePrice != null &&
          homePrice > 0 &&
          c.price != null &&
          c.price <= homePrice * PROVIDER_CHEAPER_RATIO,
      )
      .sort(
        (a, b) =>
          (a.price ?? Infinity) - (b.price ?? Infinity) ||
          Math.abs(a.tier - wantedTier) - Math.abs(b.tier - wantedTier) ||
          Number(b.fav) - Number(a.fav),
      )[0];
    if (best) {
      const name = best.m.name || best.m.id;
      reason = best.price === 0
        ? `${home.providerLabel}: ${name} on ${best.pool.providerLabel} does the same tier of work for free`
        : `${home.providerLabel}: ${name} on ${best.pool.providerLabel} does the same tier of work at about ${Math.round(((best.price ?? 0) / (homePrice ?? 1)) * 100)}% of the price`;
    }
  }

  if (!best || !reason) return toPick(home, homePick, false);

  return toPick(best.pool, {
    modelId: best.m.id,
    name: best.m.name || best.m.id,
    tier: best.tier,
    complex: homePick.complex,
    reason: `${reason}${best.tier > wantedTier ? ', a step up' : ''}.`,
  }, true);
}
