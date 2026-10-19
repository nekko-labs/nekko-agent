/** Subscription limit state and per-model list-price estimates. */

import type { ProviderConfig } from './models.js';
import { MODEL_PRICING_SNAPSHOT } from './model-pricing-snapshot.js';

export const MODEL_PRICING_SOURCE = MODEL_PRICING_SNAPSHOT.source;
export const MODEL_PRICING_CHECKED_AT = MODEL_PRICING_SNAPSHOT.checkedAt;

/**
 * Provider kinds that publish a documented usage/credit read authorized for the
 * same API key a user configures for inference (not a separate admin or
 * management key). OpenRouter's `GET /api/v1/key` is the one such read today.
 * A kind without one stays out so the UI can say "no usage API" rather than
 * scraping a dashboard or inventing a number.
 */
const API_KEY_LIMIT_KINDS: ReadonlySet<ProviderConfig['kind']> = new Set(['openrouter']);

/**
 * Provider kinds whose API-key responses carry the key's own rate limits as
 * standard headers (Anthropic's `anthropic-ratelimit-requests-*` and token
 * families). nekkod records them after each turn under the same
 * `provider:<id>` key; there is nothing to poll between turns.
 */
const API_KEY_HEADER_LIMIT_KINDS: ReadonlySet<ProviderConfig['kind']> = new Set(['anthropic']);

/**
 * The key the limits service can fetch for this provider, or null when nothing
 * can be read. A signed-in provider reads by `tokenKey`; an API-key provider
 * with a documented read gets `provider:<id>` so its snapshot lives in the same
 * store without a token. Everything else is null, which the UI reports
 * distinctly rather than showing an empty read.
 */
export function limitsKeyFor(provider: ProviderConfig): string | null {
  if (provider.auth === 'subscription' && provider.tokenKey) return provider.tokenKey;
  if (provider.apiKey && (API_KEY_LIMIT_KINDS.has(provider.kind) || API_KEY_HEADER_LIMIT_KINDS.has(provider.kind))) {
    return `provider:${provider.id}`;
  }
  return null;
}

/** A single provider-side usage/limit window, normalized across vendors. */
export interface LimitWindow {
  id: string;
  label: string;
  scope: 'session' | 'weekly' | 'model';
  /**
   * For model-scoped windows, the family this window tracks as a lowercase
   * substring of the model ids it covers (`opus`, `sonnet`, …). A family rather
   * than an exact id on purpose: the window applies to every generation of that
   * model, so `opus` keeps covering `claude-opus-5` after `claude-opus-4-8`.
   */
  modelFamily?: string;
  /** 0-100 percentage of the limit currently used. */
  usedPercent: number;
  /** Epoch milliseconds when this window resets. */
  resetAt: number;
  /** Provider-side status for this window. */
  status: 'allowed' | 'warning' | 'rate_limited';
}

/** Normalized subscription limits for one signed-in account. */
export interface SubscriptionLimits {
  windows: LimitWindow[];
  /** Provider plan name, e.g. "plus" for ChatGPT. */
  planType?: string;
  /** USD credit balance, when `creditsState` is `balance`. */
  creditsBalance?: number;
  /**
   * What the credit figure means, so the UI never has to guess from an absent
   * number. It used to read a missing balance as "Unlimited", which was a
   * confident answer to a question nobody had asked the provider: a plan with
   * extra usage switched off, and a plan we simply had not read yet, both looked
   * like an unlimited one.
   */
  creditsState?: 'unlimited' | 'balance' | 'disabled' | 'unknown';
  /** Epoch milliseconds when this snapshot was captured. */
  updatedAt: number;
  /** How long after `updatedAt` the snapshot should be considered stale. */
  staleAfterMs: number;
}

/**
 * Why the last quota read for an account produced nothing, so the UI can say
 * what is wrong instead of a bare "unavailable". Counts and codes only: never
 * a token, URL or response body.
 *
 * - `signed_out`: no stored sign-in for this account.
 * - `auth_expired`: the sign-in expired and could not be renewed; polling
 *   stops until the user signs in again.
 * - `rate_limited`: the provider answered 429; `retryAt` honours Retry-After.
 * - `http`: any other non-2xx answer, with its `status`.
 * - `network`: the request did not complete (offline, DNS, TLS, timeout).
 * - `unreadable`: a 2xx answer whose body could not be parsed.
 */
export interface LimitsProblem {
  kind: 'signed_out' | 'auth_expired' | 'rate_limited' | 'http' | 'network' | 'unreadable';
  status?: number;
  /** Epoch ms of the failure. */
  at: number;
  /** Epoch ms before which the host will not ask the provider again; absent when it waits for the user. */
  retryAt?: number;
  /** Consecutive failures, for the backoff. */
  failures: number;
}

/** One short sentence for a limits problem, for panels and tooltips. */
export function describeLimitsProblem(problem: LimitsProblem, now = Date.now()): string {
  const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const retry = problem.retryAt && problem.retryAt > now ? ` Retrying at ${at(problem.retryAt)}.` : '';
  switch (problem.kind) {
    case 'signed_out': return 'Not signed in. Sign in again in Settings.';
    case 'auth_expired': return 'Sign-in expired. Sign in again in Settings.';
    case 'rate_limited': return `Rate limited by the provider.${retry}`;
    case 'http': return `Quota read failed (HTTP ${problem.status ?? '?'}).${retry}`;
    case 'network': return `Could not reach the provider.${retry}`;
    case 'unreadable': return `The provider sent a quota answer we could not read.${retry}`;
  }
}

/** Published list-price entry for a model family ($/MTok). */
export interface ModelPricing {
  /** Substring match against a model id, e.g. "sonnet" matches any claude-sonnet id. */
  match: string;
  /** Published source model, when matched exactly. */
  modelId?: string;
  source?: string;
  checkedAt?: string;
  overrides?: readonly { minPromptTokens?: number; input: number; output: number; cacheRead?: number; cacheWrite?: number }[];
  /** Input tokens, USD per 1M. */
  input: number;
  /** Output tokens, USD per 1M. */
  output: number;
  /** Cached read tokens, USD per 1M, when published. */
  cacheRead?: number;
  /** Cached write tokens, USD per 1M, when published. */
  cacheWrite?: number;
}

/**
 * Conservative list prices (USD per 1M tokens). Match is a substring of the
 * model id. `getModelPrice` picks the entry with the longest matching substring
 * so specific variants (e.g. `o1-mini`) are not shadowed by their family prefix.
 * Unknown / local models have no entry, so the UI can honestly say "no
 * estimate" while usage accounting falls back to $0.
 */
export const DEFAULT_LOCAL_COST_BENCHMARK = 'qwen3-32b';

export const MODEL_COMPARISON_TIERS = [
  { label: 'Frontier: Fable / Astra', models: ['claude-fable-5.1', 'gpt-6-astra'] },
  { label: 'Advanced: Opus / Sol', models: ['claude-opus-5.5', 'gpt-6.1-sol'] },
  { label: 'Balanced: Sonnet', models: ['claude-sonnet-5.5'] },
  { label: 'Fast: Haiku / Luna', models: ['claude-haiku-5.5', 'gpt-6-luna'] },
  { label: 'Open models', models: ['qwen3-32b', 'gpt-oss-20b', 'gpt-oss-120b', 'gemma-3-27b-it'] },
] as const;

export const MODEL_PRICING: ModelPricing[] = [
  // DeepInfra via OpenRouter, verified 2026-10-06: https://openrouter.ai/qwen/qwen3-32b
  { match: 'qwen3-32b', input: 0.08, output: 0.28 },
  { match: 'claude-opus', input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  { match: 'claude-sonnet', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  { match: 'claude-fable', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  { match: 'claude-haiku', input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
  // Standard short-context list prices: https://developers.openai.com/api/docs/pricing
  { match: 'gpt-6-astra', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: 'gpt-6.1-sol', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  { match: 'gpt-6-luna', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { match: 'gpt-5.6-sol', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  { match: 'gpt-5.6-cyber', input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
  // OpenAI API list prices; ChatGPT subscription requests remain included in
  // the plan. Do not assign API prices to unpublished subscription-only ids.
  { match: 'gpt-5-mini', input: 0.25, output: 2 },
  { match: 'gpt-5-nano', input: 0.05, output: 0.4 },
  { match: 'gpt-5', input: 1.25, output: 10 },
  { match: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { match: 'gpt-4o', input: 2.5, output: 10 },
  { match: 'gpt-4.1-nano', input: 0.10, output: 0.40 },
  { match: 'gpt-4.1-mini', input: 0.40, output: 1.60 },
  { match: 'gpt-4.1', input: 2, output: 8 },
  { match: 'o3-mini', input: 1.10, output: 4.40 },
  { match: 'o3', input: 2, output: 8 },
  { match: 'o1-mini', input: 1.10, output: 4.40 },
  { match: 'o1', input: 15, output: 60 },
  { match: 'gpt-3.5', input: 0.5, output: 1.5 },
];

// Build once: pricing is queried during streaming and chat switches. Preserve
// first-entry precedence for unqualified ids shared by multiple hosted routes.
const publishedModelPrices = new Map<string, (typeof MODEL_PRICING_SNAPSHOT.models)[number]>();
for (const price of MODEL_PRICING_SNAPSHOT.models) {
  for (const id of [price.id, price.id.split('/').slice(1).join('/')]) {
    if (!publishedModelPrices.has(id)) publishedModelPrices.set(id, price);
  }
}
const familyModelPrices = [...MODEL_PRICING].sort((a, b) => b.match.length - a.match.length);

/** Find the pricing entry whose match is the longest substring of `modelId`. */
export function getModelPrice(modelId: string | undefined): ModelPricing | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase().replace(/^(claude-[a-z]+)-(\d+)-(\d+)(?=$|-)/, '$1-$2.$3')
    .replace(/^(qwen3|gpt-oss):(\d+b)(?=$|[-_])/, '$1-$2');
  // Exact hosted ids and unambiguous local names beat legacy family prices.
  // Do not treat a different size, fine-tune, batch or unpublished variant as exact.
  const published = publishedModelPrices.get(id);
  if (published) return { ...published, match: id, modelId: published.id, source: MODEL_PRICING_SOURCE, checkedAt: MODEL_PRICING_CHECKED_AT };
  // Only the published GPT-5 API ids have these prices. Subscription-only
  // Codex variants and later generations must not inherit the base price.
  if (/(?:^|\/)gpt-[5-9](?:[.\-]|$)/.test(id) &&
      !/(?:^|\/)gpt-(?:5(?:-(?:mini|nano))?|6-astra|6\.1-sol|6-luna|5\.6-(?:sol|cyber))(?:$|-\d{4}-\d{2}-\d{2}$)/.test(id)) return undefined;
  return familyModelPrices.find((p) => id.includes(p.match));
}

export interface EstimateCostInputs {
  /** Non-cached input/prompt tokens. Do not include cached tokens here. */
  inputTokens: number;
  /** Non-cached output/completion tokens. Do not include cached tokens here. */
  outputTokens: number;
  /** Cached read tokens, priced separately from `inputTokens`. */
  cacheReadTokens?: number;
  /** Cached write tokens, priced separately from `inputTokens`. */
  cacheWriteTokens?: number;
  /** Subscription plans bill through the plan, not per token. */
  auth?: 'apikey' | 'subscription';
}

/**
 * Estimated USD cost for a usage record. Returns `undefined` when the model
 * has no published price, so callers can avoid showing a wrong number.
 * Subscription auth always returns 0 (the usage is included in the plan).
 *
 * `inputTokens` and `outputTokens` must be the non-cached prompt and
 * generation counts; cached reads and writes are priced separately via
 * `cacheReadTokens` and `cacheWriteTokens`. Including cached tokens in the
 * main counts would double-count them.
 */
export function estimateCost(
  modelId: string | undefined,
  usage: EstimateCostInputs,
): number | undefined {
  if (!modelId) return undefined;
  if (usage.auth === 'subscription') return 0;
  const p = getModelPrice(modelId);
  if (!p) return undefined;
  // Analytics can aggregate several requests, so totals cannot determine a
  // per-request long-context surcharge. These remain standard-rate estimates.
  const rates = p;
  let cost = (usage.inputTokens / 1e6) * rates.input + (usage.outputTokens / 1e6) * rates.output;
  if (usage.cacheReadTokens) {
    cost += (usage.cacheReadTokens / 1e6) * (rates.cacheRead ?? rates.input);
  }
  if (usage.cacheWriteTokens) {
    cost += (usage.cacheWriteTokens / 1e6) * (rates.cacheWrite ?? rates.input);
  }
  return cost;
}

/**
 * Backward-compatible numeric cost estimate. Unknown / local / unpriced models
 * return 0; this is the function the existing usage log already calls.
 */
export function estimateCostUSD(modelId: string | undefined, input: number, output: number): number {
  return estimateCost(modelId, { inputTokens: input, outputTokens: output }) ?? 0;
}

/**
 * Pull provider-published prices off a model record, for `formatModelPriceLabel`.
 * Returns undefined unless both directions are priced.
 */
export function modelPricing(m: { inputPricePerM?: number; outputPricePerM?: number }): { input: number; output: number } | undefined {
  return m.inputPricePerM != null && m.outputPricePerM != null
    ? { input: m.inputPricePerM, output: m.outputPricePerM }
    : undefined;
}

/** Inputs for `formatModelPriceLabel`. */
export interface ModelPriceLabelInputs {
  modelId: string;
  /** Provider auth mode. */
  auth?: 'apikey' | 'subscription';
  /** Whether the provider is a local on-device server (free). */
  isLocal?: boolean;
  /**
   * Provider-reported prices (USD per million tokens), which beat the static
   * table because they are the meter the bill actually runs on.
   */
  pricing?: { input: number; output: number };
}

/**
 * Text label for a model option in a picker or list:
 * - local models: "Free"
 * - subscription auth: "Included in plan" + muted equivalent list price
 * - metered API key: "$in/$out per MTok"
 * - unknown / unpriced: undefined, so the UI shows nothing rather than a wrong number.
 */
export function formatModelPriceLabel({ modelId, auth, isLocal, pricing }: ModelPriceLabelInputs): string | undefined {
  if (isLocal) return 'Free';
  if (auth === 'subscription') {
    const p = pricing ?? getModelPrice(modelId);
    if (!p) return 'Included in plan';
    return `Included in plan · ~$${p.input.toFixed(2)}/$${p.output.toFixed(2)} per MTok`;
  }
  const p = pricing ?? getModelPrice(modelId);
  if (!p) return undefined;
  if (p.input === 0 && p.output === 0) return 'Free';
  return `$${p.input.toFixed(2)}/$${p.output.toFixed(2)} per MTok`;
}
