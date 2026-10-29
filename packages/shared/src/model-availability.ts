/**
 * Why a model can or can't be run right now.
 *
 * A model list that silently omits what you can't use is indistinguishable from
 * a model list that is broken: "where is Fable?" has the same shape whether the
 * model was never in the catalog, isn't in your plan, or is simply capped until
 * Thursday. So every model a provider knows about stays in the list, and this
 * module carries the reason it can't be picked.
 *
 * Two sources feed it, and neither is vendor-specific:
 *
 * 1. **The catalog** — a provider that ships a static list (Anthropic) declares
 *    what it already knows: a model that needs a bigger plan, one that is API-key
 *    only, one the vendor has retired. Providers whose catalog comes off the wire
 *    (OpenAI, OpenRouter, a local server) simply declare nothing.
 * 2. **Live limits** — the normalized usage windows in `limits.ts`. A model-scoped
 *    window that is exhausted blocks that family; an account-wide window that is
 *    exhausted blocks every model behind that subscription.
 *
 * Pure functions, so the picker, the sidebar, and tests share one answer.
 */

import type { ModelInfo, ProviderConfig } from './models.js';
import type { SubscriptionLimits } from './limits.js';

/** The kind of thing standing between you and a model. */
export type ModelBlockReason =
  /** A provider usage window is spent; it comes back on its own. */
  | 'rate-limited'
  /** The signed-in plan (or key tier) doesn't include this model. */
  | 'plan'
  /** A local server knows the model but hasn't downloaded it. */
  | 'not-installed'
  /** No credential for this provider yet. */
  | 'signed-out'
  /** Retired by the vendor; listed so an old chat's model still has a name. */
  | 'retired';

export interface ModelAvailability {
  status: 'ready' | 'blocked';
  reason?: ModelBlockReason;
  /** One line shown verbatim in the UI, written by whoever knows the truth. */
  detail?: string;
  /** Epoch ms when the block lifts, when that is knowable (rate limits). */
  resetAt?: number;
}

export const READY: ModelAvailability = { status: 'ready' };

/** Short badge text for a blocked model, e.g. "Limit reached". */
export function blockLabel(a: ModelAvailability): string {
  switch (a.reason) {
    case 'rate-limited': return 'Limit reached';
    case 'plan': return 'Not in your plan';
    case 'not-installed': return 'Not downloaded';
    case 'signed-out': return 'Signed out';
    case 'retired': return 'Retired';
    default: return 'Unavailable';
  }
}

/** Compact "in 2d" / "in 3h" for a reset time, or undefined when unknown. */
export function formatResetIn(resetAt: number | undefined, now = Date.now()): string | undefined {
  if (!resetAt || !Number.isFinite(resetAt)) return undefined;
  const ms = resetAt - now;
  if (ms <= 0) return 'soon';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * Whether a usage window covers a given model. A model-scoped window names a
 * family (`opus`); everything else is account-wide and covers every model the
 * subscription serves.
 */
export function windowCoversModel(
  window: { scope: 'session' | 'weekly' | 'model'; modelFamily?: string },
  modelId: string,
): boolean {
  if (window.scope !== 'model') return true;
  if (!window.modelFamily) return false;
  return modelId.toLowerCase().includes(window.modelFamily.toLowerCase());
}

/**
 * Resolve a model's availability from its catalog declaration plus live limits.
 * Rate limits win over a catalog claim: a model you normally have is still
 * unusable while its window is spent, and that is the more actionable message.
 */
export function resolveModelAvailability(input: {
  model: ModelInfo;
  provider?: Pick<ProviderConfig, 'auth' | 'tokenKey'>;
  limits?: SubscriptionLimits | null;
}): ModelAvailability {
  const { model, provider, limits } = input;

  if (provider?.auth === 'subscription' && !provider.tokenKey) {
    return { status: 'blocked', reason: 'signed-out', detail: 'Sign in to this provider to use its models.' };
  }

  const spent = (limits?.windows ?? [])
    .filter((w) => w.status === 'rate_limited' && windowCoversModel(w, model.id))
    // Prefer the window that frees up first, so the reset time is the one that matters.
    .sort((a, b) => (a.resetAt || Infinity) - (b.resetAt || Infinity))[0];
  if (spent) {
    const when = formatResetIn(spent.resetAt);
    return {
      status: 'blocked',
      reason: 'rate-limited',
      resetAt: spent.resetAt || undefined,
      detail: `Your ${spent.label} limit is used up${when ? `, it resets ${when}` : ''}.`,
    };
  }

  return model.availability ?? READY;
}
