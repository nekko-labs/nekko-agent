/**
 * What went wrong with a model call, in a shape the agent loop can act on.
 *
 * A provider that answers 529 "overloaded", a stream that goes quiet for five
 * minutes, and a connection the network dropped are all failures the next
 * attempt usually gets past; a 401 or a 400 about the request body is not.
 * Providers throw these so the loop can tell the two apart (see `loop.ts`,
 * `streamWithRetry`) instead of ending the reply on the first transient hiccup,
 * which is how a long agent run died at 2 a.m. over one bad second.
 */

/** A non-OK HTTP response from a provider. `message` keeps the old wording. */
export class ProviderHttpError extends Error {
  readonly status: number;
  /** `retry-after`, in milliseconds, when the response named one. */
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** A response stream that sent nothing for longer than the idle limit. */
export class StreamStalledError extends Error {
  constructor(idleMs: number) {
    super(`The model stopped sending after ${Math.round(idleMs / 1000)} s of silence.`);
    this.name = 'StreamStalledError';
  }
}

/** Build the error for a non-OK response, reading `retry-after` when present. */
export function httpError(message: string, res: Pick<Response, 'status' | 'headers'>): ProviderHttpError {
  return new ProviderHttpError(message, res.status, retryAfterMs(res.headers?.get?.('retry-after')));
}

/** `retry-after` is seconds or an HTTP date; either becomes a wait in ms. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Statuses a second attempt usually gets past. 529 is Anthropic's "overloaded". */
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Whether a failure is worth retrying. Besides the statuses above this covers
 * the ways a connection dies underneath a request (Node's "fetch failed",
 * ECONNRESET, "terminated", a stalled stream) and the in-band stream errors
 * providers send instead of a status ("overloaded_error").
 */
export function isTransientProviderError(e: unknown): boolean {
  if (isNetworkProviderError(e)) return true;
  if (e instanceof StreamStalledError) return true;
  if (e instanceof ProviderHttpError) return TRANSIENT_STATUSES.has(e.status);
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/abort/i.test(msg)) return false;
  // A status in the message, for providers that have not been taught the
  // typed error yet ("anthropic 529: ..."), and for 408/5xx proxies.
  const m = /\b(\d{3})\b/.exec(msg);
  if (m && TRANSIENT_STATUSES.has(Number(m[1]))) return true;
  return /overloaded|rate.?limit|too many requests|temporarily|try again|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed|terminated|network error|stream ended unexpectedly|Premature close|stopped sending/i.test(
    msg,
  );
}

/**
 * Whether the connection itself failed (DNS, an unreachable network, a dropped
 * socket), as opposed to a provider that answered. Wi-Fi that drops for a few
 * minutes is the common case, so these get the longer window below. Node's
 * fetch hides the code in `cause`, which is followed.
 */
export function isNetworkProviderError(e: unknown): boolean {
  if (e instanceof ProviderHttpError || e instanceof StreamStalledError) return false;
  if (e instanceof Error && e.name === 'AbortError') return false;
  const value = e as { message?: string; code?: string; cause?: unknown } | null;
  const message = value?.message ?? String(e ?? '');
  if (/abort/i.test(message)) return false;
  if (NETWORK_FAILURE.test(`${value?.code ?? ''} ${message}`)) return true;
  return value?.cause !== undefined && value.cause !== e && isNetworkProviderError(value.cause);
}

const NETWORK_FAILURE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ENETDOWN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|socket hang up|fetch failed|terminated|network error|Premature close/i;

/** Attempts a model call gets before the reply is ended as interrupted. */
export const MAX_STREAM_ATTEMPTS = 5;

/**
 * Attempts when the network itself failed: about half an hour of waits at the
 * 30 s backoff cap, then the reply ends as interrupted and offers Continue.
 */
export const MAX_NETWORK_STREAM_ATTEMPTS = 65;

/**
 * How long to wait before attempt `attempt` (1-based): the provider's own
 * `retry-after` when it gave one, else 1 s doubling to a 30 s cap, with a
 * little jitter so parallel chats do not all knock at once.
 */
export function retryDelayMs(attempt: number, retryAfter?: number, random = Math.random, baseMs = 1_000): number {
  if (retryAfter !== undefined) return Math.min(Math.max(retryAfter, 500), 120_000);
  const base = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 30 * baseMs);
  return Math.round(base + random() * Math.min(base, baseMs));
}

/**
 * How long a response stream may stay silent before it counts as lost.
 *
 * Five minutes, the same as Codex's `stream_idle_timeout_ms`: a local model
 * can take minutes to its first token on a cold prompt, and a cloud model with
 * a 200k-token context can think for a long while before it says anything.
 * `NEKKO_STREAM_IDLE_MS` overrides it (0 disables).
 */
export function streamIdleMs(): number {
  const env = typeof process !== 'undefined' ? process.env?.NEKKO_STREAM_IDLE_MS : undefined;
  const n = env === undefined ? NaN : Number(env);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
}
