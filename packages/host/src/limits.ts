/** Host-side subscription-limits capture and polling service. */

import { EventEmitter } from 'node:events';
import type { LimitWindow, LimitsProblem, OAuthProvider, ProviderConfig, ProviderKind, SubscriptionLimits } from '@nekko-agent/shared';
import { getToken, ensureFreshToken } from './oauth.js';
import { getSettings } from './store.js';
import { recordQuotaHistory } from './quota-history.js';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns } from './daemon-loop.js';

let events: EventEmitter | null = null;

const store = new Map<string, SubscriptionLimits>();
const lastPollByToken = new Map<string, number>();
const inFlight = new Map<string, Promise<SubscriptionLimits | undefined>>();
/** Why the latest read for a key failed; cleared by the next success or a new sign-in. */
const problems = new Map<string, LimitsProblem>();

const POLL_INTERVAL_MS = 30_000;
/** First retry after a failure; doubles per consecutive failure up to the cap. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** A quota read that failed for a reason worth reporting. */
export class LimitsReadError extends Error {
  constructor(readonly kind: LimitsProblem['kind'], readonly status?: number, readonly retryAfterMs?: number) {
    super(`limits read failed: ${kind}${status ? ` ${status}` : ''}`);
  }
}

/** Retry-After as delta seconds or an HTTP date, in ms from now. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Turn a failed response into a typed error. */
function failure(res: Response): LimitsReadError {
  if (res.status === 401 || res.status === 403) return new LimitsReadError('auth_expired', res.status);
  if (res.status === 429) return new LimitsReadError('rate_limited', 429, parseRetryAfter(res.headers.get('retry-after')));
  return new LimitsReadError('http', res.status);
}

/** Classify anything thrown by a read, including token refresh errors. */
export function classifyLimitsError(e: unknown): Pick<LimitsProblem, 'kind' | 'status'> & { retryAfterMs?: number } {
  if (e instanceof LimitsReadError) return { kind: e.kind, status: e.status, retryAfterMs: e.retryAfterMs };
  const message = e instanceof Error ? e.message : String(e);
  if (/sign in again|session expired|no refresh token|invalid_grant|revoked/i.test(message)) return { kind: 'auth_expired' };
  if (/no subscription token found/i.test(message)) return { kind: 'signed_out' };
  if (/token refresh failed/i.test(message)) return { kind: 'http' };
  return { kind: 'network' };
}

/** The backoff before the next attempt after `failures` consecutive failures. */
export function limitsBackoffMs(failures: number, retryAfterMs?: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.max(exp, retryAfterMs ?? 0);
}

/** Why the last read for this key failed, if it did. */
export function getLimitsProblem(tokenKey: string): LimitsProblem | undefined {
  return problems.get(tokenKey);
}

function recordProblem(tokenKey: string, e: unknown): void {
  const { kind, status, retryAfterMs } = classifyLimitsError(e);
  const now = Date.now();
  const failures = (problems.get(tokenKey)?.failures ?? 0) + 1;
  // A dead sign-in will not fix itself: wait for the user rather than
  // asking the token endpoint again every few minutes.
  const waitsForUser = kind === 'auth_expired' || kind === 'signed_out';
  const problem: LimitsProblem = { kind, status, at: now, failures, retryAt: waitsForUser ? undefined : now + limitsBackoffMs(failures, retryAfterMs) };
  problems.set(tokenKey, problem);
  // The cached snapshot is kept: getLimits already refuses to hand it back
  // once stale, and a short network blip should not blank fresh numbers.
}
const HEADER_STALE_MS = 60_000;
const POLL_STALE_MS = 35_000;

const ANTHROPIC_PREFIX = 'anthropic-ratelimit-unified-';

/**
 * Anthropic's window names, in both spellings: `5h` / `7d` on the rate-limit
 * headers, `five_hour` / `seven_day` in the usage JSON.
 */
const ANTHROPIC_PERIODS: Array<{ id: string; header: string; json: string; label: string; scope: LimitWindow['scope'] }> = [
  { id: '5h', header: '5h', json: 'five_hour', label: '5-hour', scope: 'session' },
  { id: '7d', header: '7d', json: 'seven_day', label: '7-day', scope: 'weekly' },
];

/**
 * One window Anthropic reports, read from its name rather than from a list.
 *
 * The per-model windows are `<period>_<family>`: `7d_opus`, `7d_sonnet`, and
 * now `7d_fable`. A fixed list of them meant every new model family was
 * invisible here until someone shipped a build that mentioned it by name —
 * which is exactly why the Fable window never appeared — so the family is taken
 * from the name Anthropic sent. A period we do not recognise is still reported,
 * under its raw name, rather than dropped.
 */
export function describeAnthropicWindow(
  period: string,
  family: string | undefined,
): { id: string; label: string; scope: LimitWindow['scope']; modelFamily?: string } {
  const known = ANTHROPIC_PERIODS.find((p) => p.id === period);
  const label = known?.label ?? period;
  if (!family) {
    return { id: period, label, scope: known?.scope ?? 'weekly' };
  }
  return {
    id: `${period}_${family}`,
    label: `${label} ${titleCase(family)}`,
    scope: 'model',
    modelFamily: family,
  };
}

/** `fable` → `Fable`, `claude_next` → `Claude Next`. */
function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Split a window name into its period and, when it has one, its model family.
 * Accepts either spelling, so the headers and the usage JSON produce the same
 * window ids and the two sources can update each other.
 */
function splitAnthropicWindow(name: string): { period: string; family?: string } | null {
  for (const p of ANTHROPIC_PERIODS) {
    for (const spelling of [p.header, p.json]) {
      if (name === spelling) return { period: p.id };
      if (name.startsWith(`${spelling}_`)) return { period: p.id, family: name.slice(spelling.length + 1) };
    }
  }
  // An unrecognised period with no family we can separate out: report it whole.
  return name ? { period: name } : null;
}

type DaemonCall = NonNullable<ReturnType<typeof daemonCall>>;

/** What a daemon advertises in `daemon:info` `owned` when it keeps the limit state (crates/nekkod/src/limits.rs). */
export const DAEMON_LIMITS = 'limits:get';

/**
 * The engine daemon, when it owns limit state. Then this module is a client:
 * headers and polls go to the daemon, reads come from it, and the daemon tells
 * the UI itself (and this host, through `limits:notify`, for the phone relay).
 * Without a daemon (the web, server and cloud editions) everything stays here.
 */
async function daemonLimits(): Promise<DaemonCall | undefined> {
  const call = daemonCall();
  if (!call) return undefined;
  return (await daemonOwns(call, DAEMON_LIMITS)) ? call : undefined;
}

/** `limits:get`, from the daemon when it owns limit state. */
export async function readLimits(tokenKey: string, refresh = false): Promise<SubscriptionLimits | undefined> {
  const call = await daemonLimits();
  if (!call) return getLimits(tokenKey, refresh);
  return (await call<SubscriptionLimits | null>('limits:get', tokenKey, refresh)) ?? undefined;
}

/** `limits:problem`, from the daemon when it owns limit state. */
export async function readLimitsProblem(tokenKey: string): Promise<LimitsProblem | undefined> {
  const call = await daemonLimits();
  if (!call) return getLimitsProblem(tokenKey);
  return (await call<LimitsProblem | null>('limits:problem', tokenKey)) ?? undefined;
}

/** `limits:notify`: the daemon changed a snapshot; the phone relay hears it from here, the UI already has it. */
export function notifyFromDaemon(payload: { tokenKey: string; limits: SubscriptionLimits }): void {
  try {
    events?.emit('limitsUpdated', { ...payload, relayOnly: true });
  } catch {
    // A throwing observer must not fail the daemon's call.
  }
}

/** Wire the service to the host's event bus. Called once in createHost. */
export function initLimits(eventBus: EventEmitter): void {
  events = eventBus;
  store.clear();
  lastPollByToken.clear();
  inFlight.clear();
  problems.clear();
}

/** Drop all cached state for a token key, or for every key if omitted. */
export function clearLimits(tokenKey?: string): void {
  if (daemonCall()) {
    void daemonLimits().then((call) => call?.('limits:clear', tokenKey ?? null)).catch(() => {});
  }
  if (tokenKey) {
    store.delete(tokenKey);
    lastPollByToken.delete(tokenKey);
    inFlight.delete(tokenKey);
    problems.delete(tokenKey);
  } else {
    store.clear();
    lastPollByToken.clear();
    inFlight.clear();
    problems.clear();
  }
}

/** Latest normalized state for a token key, or undefined if none captured yet. */
export function get(tokenKey: string): SubscriptionLimits | undefined {
  return store.get(tokenKey);
}

/**
 * Return the latest state, polling first if it is missing or stale.
 * The poll is throttled, so this is safe to call from UI refresh paths.
 * If the cached snapshot is stale and the poll cannot refresh it, this
 * returns `undefined` rather than handing back the stale snapshot as fresh.
 */
export async function getLimits(tokenKey: string, refresh = false): Promise<SubscriptionLimits | undefined> {
  const state = get(tokenKey);
  if (!refresh && state && state.updatedAt + state.staleAfterMs > Date.now()) {
    return state;
  }
  const polled = await pollHere(tokenKey);
  if (!polled) return undefined;
  if (polled.updatedAt + polled.staleAfterMs <= Date.now()) return undefined;
  return polled;
}

/**
 * Capture provider rate-limit headers from a subscription response.
 * Anthropic headers are only parsed for the anthropic/claude provider;
 * other providers' headers are left alone. If no recognized headers are
 * present, the existing state is left unchanged.
 */
export function recordFromHeaders(
  tokenKey: string,
  provider: OAuthProvider | ProviderKind,
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): SubscriptionLimits | undefined {
  if (provider !== 'anthropic' && provider !== 'claude') {
    return get(tokenKey);
  }
  if (daemonCall()) {
    // The daemon may own the state; it hears the same pairs this would parse.
    const pairs = [...headerMap(headers)];
    void daemonLimits()
      .then((call) => (call ? call('limits:headers', tokenKey, provider, pairs) : recordHeaders(tokenKey, pairs)))
      .catch(() => {});
    return get(tokenKey);
  }
  return recordHeaders(tokenKey, headers);
}

function recordHeaders(
  tokenKey: string,
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): SubscriptionLimits | undefined {
  const parsed = parseAnthropicHeaders(headers);
  if (parsed.windows.length === 0) {
    return get(tokenKey);
  }
  // Merge rather than replace, windows included. The rate-limit headers report
  // windows and nothing else, so writing them over the snapshot dropped the plan
  // and credit figures the usage endpoint had supplied: the popover showed them
  // once and then lost them the moment the user sent a message.
  //
  // The window list needs the same treatment, and for the same reason. A single
  // response only carries headers for the windows that response was billed
  // against, typically `5h` and `7d`; the per-model windows (`7d_fable`,
  // `7d_opus`) only ever come from the usage endpoint. Taking the header list
  // wholesale therefore deleted every per-model window the poll had discovered,
  // which is why the Fable limit appeared after a poll and then vanished on the
  // next message. Header windows are newer for the windows they mention, so they
  // win per id, and windows they say nothing about are carried forward.
  recordQuotaHistory(tokenKey, 'headers', parsed);
  const previous = get(tokenKey);
  const limits: SubscriptionLimits = {
    ...parsed,
    windows: mergeWindows(previous?.windows ?? [], parsed.windows),
    planType: previous?.planType,
    creditsBalance: previous?.creditsBalance,
    creditsState: previous?.creditsState,
  };
  store.set(tokenKey, limits);
  const bus = events;
  if (bus) {
    try {
      bus.emit('limitsUpdated', { tokenKey, limits });
    } catch {
      // A throwing observer must not abort an in-flight chat turn.
    }
  }
  return limits;
}

/**
 * On-demand provider poll. Throttled to at most once every 30 seconds per
 * token key. Fetches the authoritative usage endpoint for Claude or ChatGPT.
 */
export async function poll(tokenKey: string): Promise<SubscriptionLimits | undefined> {
  if (daemonCall()) {
    const call = await daemonLimits();
    if (call) return (await call<SubscriptionLimits | null>('limits:poll', tokenKey)) ?? undefined;
  }
  return pollHere(tokenKey);
}

async function pollHere(tokenKey: string): Promise<SubscriptionLimits | undefined> {
  // A `provider:<id>` key is an API-key provider read with its inference key;
  // everything else is an OAuth token key.
  const apiKeyProvider = providerFromLimitsKey(tokenKey);
  const token = apiKeyProvider ? undefined : getToken(tokenKey);
  if (!apiKeyProvider && !token) {
    if (!problems.has(tokenKey)) recordProblem(tokenKey, new LimitsReadError('signed_out'));
    return get(tokenKey);
  }

  const now = Date.now();
  const last = lastPollByToken.get(tokenKey) ?? 0;
  if (now - last < POLL_INTERVAL_MS) {
    return get(tokenKey);
  }
  const problem = problems.get(tokenKey);
  if (problem) {
    // A dead sign-in stays dead until the stored token changes (a new sign-in,
    // or a chat's own refresh succeeding); everything else waits out its backoff.
    const waitsForUser = problem.retryAt == null;
    const tokenChanged = !!token && (token.obtainedAt ?? 0) > problem.at;
    if (waitsForUser ? !tokenChanged : now < problem.retryAt!) return get(tokenKey);
  }

  const existing = inFlight.get(tokenKey);
  if (existing) return existing;

  const bus = events;
  let promise!: Promise<SubscriptionLimits | undefined>;
  promise = (async (): Promise<SubscriptionLimits | undefined> => {
    try {
      let next: SubscriptionLimits | undefined;
      if (apiKeyProvider) {
        next = await pollApiKeyProvider(apiKeyProvider);
      } else {
        const accessToken = await ensureFreshToken(tokenKey);
        const fresh = getToken(tokenKey);
        if (!fresh) return get(tokenKey);

        if (fresh.provider === 'claude') {
          next = await pollClaude(tokenKey, accessToken);
        } else if (fresh.provider === 'chatgpt') {
          next = await pollChatGpt(tokenKey, accessToken, fresh.accountId);
        } else if (fresh.provider === 'openrouter') {
          next = await pollOpenRouter(tokenKey, accessToken);
        } else {
          next = undefined;
        }
      }

      if (inFlight.get(tokenKey) !== promise) {
        return get(tokenKey);
      }
      if (next) {
        recordQuotaHistory(tokenKey, 'poll', next);
        store.set(tokenKey, next);
        problems.delete(tokenKey);
        try {
          bus?.emit('limitsUpdated', { tokenKey, limits: next });
        } catch {
          // A throwing observer must not abort a background poll.
        }
      }
      lastPollByToken.set(tokenKey, Date.now());
      return next ?? get(tokenKey);
    } catch (e) {
      lastPollByToken.set(tokenKey, Date.now());
      recordProblem(tokenKey, e);
      return get(tokenKey);
    } finally {
      if (inFlight.get(tokenKey) === promise) inFlight.delete(tokenKey);
    }
  })();

  inFlight.set(tokenKey, promise);
  return promise;
}

async function pollClaude(tokenKey: string, accessToken: string): Promise<SubscriptionLimits | undefined> {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!res.ok) throw failure(res);

  const text = await res.text();
  const json = safeJson(text);
  if (!json || typeof json !== 'object') throw new LimitsReadError('unreadable', res.status);

  return parseAnthropicUsageJson(json as Record<string, unknown>);
}

async function pollChatGpt(
  tokenKey: string,
  accessToken: string,
  accountId: string | undefined,
): Promise<SubscriptionLimits | undefined> {
  // Without the account id the usage endpoint cannot be asked; only a new sign-in supplies it.
  if (!accountId) throw new LimitsReadError('auth_expired');

  const configuredBase = getSettings().providers.find((p) => p.tokenKey === tokenKey)?.baseUrl;
  const baseUrl = (configuredBase ?? 'https://chatgpt.com/backend-api').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/wham/usage`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
    },
  });
  if (!res.ok) throw failure(res);

  const text = await res.text();
  const json = safeJson(text);
  if (!json || typeof json !== 'object') throw new LimitsReadError('unreadable', res.status);

  return parseChatGptUsage(json as Record<string, unknown>);
}

/** Resolve a `provider:<id>` limits key back to its configured provider. */
function providerFromLimitsKey(key: string): ProviderConfig | undefined {
  if (!key.startsWith('provider:')) return undefined;
  const id = key.slice('provider:'.length);
  return getSettings().providers.find((p) => p.id === id && p.enabled);
}

/**
 * The documented usage read for an API-key provider's inference key.
 * Kinds without one are unreachable here because `limitsKeyFor` never assigns
 * them a key; returning undefined keeps them honest rather than guessed.
 */
async function pollApiKeyProvider(provider: ProviderConfig): Promise<SubscriptionLimits | undefined> {
  if (!provider.apiKey) return undefined;
  if (provider.kind === 'openrouter') {
    return readOpenRouterKey(provider.baseUrl || 'https://openrouter.ai/api/v1', provider.apiKey);
  }
  return undefined;
}

/**
 * OpenRouter has no plan windows to poll; what a key can tell us is its credit
 * position and, for free-tier keys, the daily free-model request allowance.
 * `GET /key` returns those directly, authorized for the inference key itself.
 */
async function pollOpenRouter(tokenKey: string, accessToken: string): Promise<SubscriptionLimits | undefined> {
  const configuredBase = getSettings().providers.find((p) => p.tokenKey === tokenKey)?.baseUrl;
  const baseUrl = configuredBase ?? 'https://openrouter.ai/api/v1';
  return readOpenRouterKey(baseUrl, accessToken);
}

async function readOpenRouterKey(baseUrl: string, bearer: string): Promise<SubscriptionLimits | undefined> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/key`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw failure(res);

  return parseOpenRouterKey(safeJson(await res.text()), res.status);
}

/** Parse OpenRouter's `GET /key` answer; a body without `data` is unreadable. */
export function parseOpenRouterKey(body: unknown, status: number): SubscriptionLimits {
  const json = body as Record<string, unknown> | undefined;
  const data = json?.data as Record<string, unknown> | undefined;
  if (!data) throw new LimitsReadError('unreadable', status);

  const windows: LimitWindow[] = [];
  const free = data.free_model_daily_requests as { limit?: number; remaining?: number; used?: number } | undefined;
  if (free && typeof free.limit === 'number' && free.limit > 0) {
    const used = typeof free.used === 'number' ? free.used : free.limit - (free.remaining ?? free.limit);
    const usedPercent = clampPercent((used / free.limit) * 100);
    const resets = new Date();
    resets.setUTCHours(24, 0, 0, 0); // free-model allowance resets at UTC midnight
    windows.push({
      id: 'free_daily',
      label: 'Free-model requests',
      scope: 'session',
      usedPercent,
      resetAt: resets.getTime(),
      status: usedPercent >= 100 ? 'rate_limited' : usedPercent >= 80 ? 'warning' : 'allowed',
    });
  }

  const limit = typeof data.limit === 'number' ? data.limit : null;
  const remaining =
    typeof data.limit_remaining === 'number'
      ? data.limit_remaining
      : limit != null && typeof data.usage === 'number'
        ? Math.max(0, limit - data.usage)
        : undefined;

  return {
    windows,
    planType: data.is_free_tier === true ? 'free tier' : undefined,
    creditsBalance: remaining,
    creditsState: limit == null ? 'unlimited' : 'balance',
    updatedAt: Date.now(),
    staleAfterMs: POLL_STALE_MS,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function headerMap(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): Map<string, string> {
  const map = new Map<string, string>();
  // An array of pairs has a forEach too, with the index where a Headers object
  // passes the name: the pairs a daemon-driven turn relays went through that
  // branch and threw, so its rate limits were never recorded.
  if (!Array.isArray(headers) && typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((v, k) => map.set(k.toLowerCase(), v));
  } else if (typeof (headers as Iterable<[string, string]>)[Symbol.iterator] === 'function') {
    for (const [k, v] of headers as Iterable<[string, string]>) {
      map.set(k.toLowerCase(), v);
    }
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      map.set(k.toLowerCase(), v);
    }
  }
  return map;
}

function getHeader(
  map: Map<string, string>,
  name: string,
): string | undefined {
  return map.get(name.toLowerCase());
}

function normalizeStatus(value: string | undefined): LimitWindow['status'] {
  const s = value?.toLowerCase() ?? '';
  if (s === 'rate_limited' || s === 'rejected') return 'rate_limited';
  if (s === 'warning' || s === 'allowed_warning') return 'warning';
  return 'allowed';
}

export function parseAnthropicHeaders(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): SubscriptionLimits {
  const map = headerMap(headers);
  const windows: LimitWindow[] = [];

  // Every `…-<window>-utilization` header there is, rather than the handful we
  // happened to know the names of when this shipped.
  for (const [key, util] of map) {
    if (!key.startsWith(ANTHROPIC_PREFIX) || !key.endsWith('-utilization')) continue;
    const name = key.slice(ANTHROPIC_PREFIX.length, -'-utilization'.length);
    const parts = splitAnthropicWindow(name);
    if (!parts) continue;

    const utilization = parseFloat(util);
    if (!Number.isFinite(utilization)) continue;

    const reset = getHeader(map, `${ANTHROPIC_PREFIX}${name}-reset`);
    const resetAt = reset ? parseInt(reset, 10) * 1000 : 0;
    const status = normalizeStatus(getHeader(map, `${ANTHROPIC_PREFIX}${name}-status`) ?? 'allowed');

    windows.push({
      ...describeAnthropicWindow(parts.period, parts.family),
      // Headers report a fraction (0.62 = 62%), unlike the usage JSON below.
      usedPercent: clampPercent(utilization * 100),
      resetAt,
      status,
    });
  }

  return { windows: sortWindows(windows), updatedAt: Date.now(), staleAfterMs: HEADER_STALE_MS };
}

/**
 * Combine a previous window list with a fresher one, by window id.
 *
 * Neither source is complete on its own: the usage endpoint reports every
 * window including the per-model ones, while a response's rate-limit headers
 * only mention the windows that request was billed against. So a fresh window
 * replaces its older namesake, and a window the fresh source is simply silent
 * about survives rather than being read as "gone".
 */
export function mergeWindows(previous: LimitWindow[], fresh: LimitWindow[]): LimitWindow[] {
  const byId = new Map(previous.map((w) => [w.id, w]));
  for (const w of fresh) byId.set(w.id, w);
  return sortWindows([...byId.values()]);
}

/**
 * Window order: the two plan-wide windows first, then the per-model ones
 * alphabetically. Discovery hands them over in whatever order the provider
 * serialized them, and a list that reshuffles itself between polls is harder to
 * read than one that is merely incomplete.
 */
export function sortWindows(windows: LimitWindow[]): LimitWindow[] {
  const rank = (w: LimitWindow) => (w.scope === 'session' ? 0 : w.scope === 'weekly' ? 1 : 2);
  return [...windows].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/**
 * Clamp a percentage into 0-100. A scale surprise from a provider must degrade
 * to "pegged at 100%", never to the 6200% the usage endpoint once produced when
 * its whole-percent numbers were read as fractions.
 */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

/**
 * Parse `GET /api/oauth/usage`.
 *
 * The two Anthropic surfaces disagree on scale and the difference is load-bearing:
 * the rate-limit *headers* report `utilization` as a fraction (`0.62`), this JSON
 * endpoint reports whole percent (`62`). Multiplying here as the header parser
 * does is what made a 62%-used week render as "6200%" until the first real
 * request replaced the snapshot with header-derived numbers.
 */
export function parseAnthropicUsageJson(json: Record<string, unknown>): SubscriptionLimits {
  const windows: LimitWindow[] = [];

  for (const [key, win] of Object.entries(json)) {
    if (!win || typeof win !== 'object') continue;
    const parts = splitAnthropicWindow(key);
    if (!parts) continue;
    // A key that parses only because `splitAnthropicWindow` reports anything it
    // cannot split is not a window: `extra_usage` has no utilization figure.
    const obj = win as Record<string, unknown>;
    if (obj.utilization === undefined) continue;

    const utilization =
      typeof obj.utilization === 'number'
        ? obj.utilization
        : parseFloat(String(obj.utilization ?? ''));
    if (!Number.isFinite(utilization)) continue;

    const usedPercent = clampPercent(utilization);
    const resetsAt = typeof obj.resets_at === 'string' ? Date.parse(obj.resets_at) : 0;
    const reported = normalizeStatus(typeof obj.status === 'string' ? obj.status : undefined);
    let status: LimitWindow['status'] = 'allowed';
    if (reported === 'rate_limited' || usedPercent >= 100) {
      status = 'rate_limited';
    } else if (reported === 'warning' || usedPercent >= 80) {
      status = 'warning';
    }

    windows.push({
      ...describeAnthropicWindow(parts.period, parts.family),
      usedPercent,
      resetAt: resetsAt > 0 ? resetsAt : 0,
      status,
    });
  }

  return {
    windows: sortWindows(windows),
    ...parseAnthropicCredits(json),
    updatedAt: Date.now(),
    staleAfterMs: POLL_STALE_MS,
  };
}

/**
 * Anthropic's credit position, from the `extra_usage` block.
 *
 * `extra_usage` is the pay-as-you-go allowance beyond the plan: a monthly limit
 * and what has been spent against it. Switched off is a real answer and not the
 * same as unlimited, and a block we cannot read is `unknown` rather than either.
 */
function parseAnthropicCredits(
  json: Record<string, unknown>,
): Pick<SubscriptionLimits, 'creditsBalance' | 'creditsState'> {
  const extra = json.extra_usage;
  if (!extra || typeof extra !== 'object') return { creditsState: 'unknown' };

  const obj = extra as Record<string, unknown>;
  if (obj.is_enabled === false) return { creditsState: 'disabled' };

  const limit = Number(obj.monthly_limit);
  const used = Number(obj.used_credits);
  if (!Number.isFinite(limit)) return { creditsState: 'unknown' };
  // A limit with nothing spent against it yet still has its whole balance left.
  const spent = Number.isFinite(used) ? used : 0;
  return { creditsBalance: Math.max(0, limit - spent), creditsState: 'balance' };
}

/** WHAM slots are not periods: even primary can be the weekly window. */
function describeChatGptWindow(
  key: 'primary_window' | 'secondary_window',
  duration: unknown,
): Pick<LimitWindow, 'id' | 'label' | 'scope'> {
  const slot = key === 'primary_window' ? 'primary' : 'secondary';
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) {
    // The shared shape has no unknown scope; session is a compatibility fallback,
    // not a claim about the period. Never infer a duration from the slot/reset.
    return { id: slot, label: `${titleCase(slot)} usage`, scope: 'session' };
  }
  if (duration === 18_000) return { id: '5h', label: '5-hour', scope: 'session' };
  if (duration === 604_800) return { id: '7d', label: '7-day', scope: 'weekly' };

  const units = [
    { seconds: 86_400, suffix: 'd', label: 'day' },
    { seconds: 3_600, suffix: 'h', label: 'hour' },
    { seconds: 60, suffix: 'm', label: 'minute' },
    { seconds: 1, suffix: 's', label: 'second' },
  ];
  const unit = units.find((u) => duration % u.seconds === 0)!;
  const count = duration / unit.seconds;
  return {
    id: `${count}${unit.suffix}`,
    label: `${count}-${unit.label}`,
    scope: duration >= 604_800 ? 'weekly' : 'session',
  };
}

export function parseChatGptUsage(json: Record<string, unknown>): SubscriptionLimits {
  const windows: LimitWindow[] = [];
  const rateLimit = json.rate_limit as Record<string, unknown> | undefined;
  const planType = typeof json.plan_type === 'string' ? json.plan_type : undefined;

  let creditsBalance: number | undefined;
  let creditsState: SubscriptionLimits['creditsState'] = 'unknown';
  const credits = json.credits as Record<string, unknown> | undefined;
  if (credits) {
    if (credits.unlimited === true) {
      creditsState = 'unlimited';
    } else if (typeof credits.balance === 'string' || typeof credits.balance === 'number') {
      const v = parseFloat(String(credits.balance));
      if (Number.isFinite(v)) {
        creditsBalance = v;
        creditsState = 'balance';
      }
    }
  }

  if (rateLimit) {
    const allowed = rateLimit.allowed === true;
    const limitReached = rateLimit.limit_reached === true;

    const addWindow = (key: 'primary_window' | 'secondary_window') => {
      const win = rateLimit[key] as Record<string, unknown> | undefined;
      if (!win) return;

      const usedPercent =
        typeof win.used_percent === 'number'
          ? win.used_percent
          : parseFloat(String(win.used_percent ?? ''));
      if (!Number.isFinite(usedPercent)) return;

      const resetAt =
        typeof win.reset_at === 'number' ? win.reset_at * 1000 : 0;

      let status: LimitWindow['status'] = 'allowed';
      if (!allowed || limitReached) {
        status = 'rate_limited';
      } else if (usedPercent >= 80) {
        status = 'warning';
      }

      windows.push({
        ...describeChatGptWindow(key, win.limit_window_seconds),
        usedPercent: clampPercent(usedPercent),
        resetAt,
        status,
      });
    };

    addWindow('primary_window');
    addWindow('secondary_window');
  }

  return { windows, planType, creditsBalance, creditsState, updatedAt: Date.now(), staleAfterMs: POLL_STALE_MS };
}
