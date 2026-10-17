import { describe, expect, it } from 'vitest';
import { MAX_NETWORK_STREAM_ATTEMPTS, MAX_STREAM_ATTEMPTS, ProviderHttpError, StreamStalledError, httpError, isNetworkProviderError, isTransientProviderError, retryAfterMs, retryDelayMs } from './errors.js';
import { readWithIdle, type ReadResult } from './sse.js';

describe('isTransientProviderError', () => {
  it('retries overloads, rate limits, server errors and dropped connections', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      expect(isTransientProviderError(new ProviderHttpError('x', status))).toBe(true);
    }
    expect(isTransientProviderError(new StreamStalledError(1000))).toBe(true);
    expect(isTransientProviderError(new Error('anthropic 529: {"type":"overloaded_error"}'))).toBe(true);
    expect(isTransientProviderError(new Error('anthropic stream error: overloaded_error: Overloaded'))).toBe(true);
    expect(isTransientProviderError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientProviderError(new Error('terminated'))).toBe(true);
    expect(isTransientProviderError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('does not retry what a second attempt cannot fix', () => {
    for (const status of [400, 401, 402, 403, 404, 413, 422]) {
      expect(isTransientProviderError(new ProviderHttpError('x', status))).toBe(false);
    }
    expect(isTransientProviderError(new Error('anthropic 401: invalid x-api-key'))).toBe(false);
    expect(isTransientProviderError(new Error('This operation was aborted'))).toBe(false);
    expect(isTransientProviderError(new Error('max_tokens: 64000 > 32000'))).toBe(false);
  });

  it('reads retry-after as seconds or as a date', () => {
    expect(retryAfterMs('7')).toBe(7000);
    expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(retryAfterMs('soon')).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    const err = httpError('anthropic 429: slow down', { status: 429, headers: new Headers({ 'retry-after': '3' }) });
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
  });
});

describe('retryDelayMs', () => {
  it('doubles from a second to a 30 s cap, with bounded jitter', () => {
    const noJitter = () => 0;
    expect(retryDelayMs(1, undefined, noJitter)).toBe(1000);
    expect(retryDelayMs(2, undefined, noJitter)).toBe(2000);
    expect(retryDelayMs(3, undefined, noJitter)).toBe(4000);
    expect(retryDelayMs(6, undefined, noJitter)).toBe(30000);
    expect(retryDelayMs(1, undefined, () => 1)).toBe(2000);
    expect(retryDelayMs(6, undefined, () => 1)).toBe(31000);
  });

  it("prefers the provider's own retry-after, within reason", () => {
    expect(retryDelayMs(1, 9000)).toBe(9000);
    expect(retryDelayMs(1, 0)).toBe(500);
    expect(retryDelayMs(1, 10 * 60_000)).toBe(120_000);
  });

  it('gives up after a handful of attempts', () => {
    expect(MAX_STREAM_ATTEMPTS).toBe(5);
  });
});

describe('readWithIdle', () => {
  it('rejects, and cancels the reader, when a stream goes silent', async () => {
    let cancelled: unknown;
    const reader = {
      read: () => new Promise<ReadResult<Uint8Array>>(() => {}),
      cancel: async (reason?: unknown) => { cancelled = reason; },
    };
    await expect(readWithIdle(reader, 20)).rejects.toBeInstanceOf(StreamStalledError);
    expect(cancelled).toBeInstanceOf(StreamStalledError);
  });

  it('passes a timely chunk through and disables itself at 0', async () => {
    const chunk: ReadResult<Uint8Array> = { done: false, value: new Uint8Array([1]) };
    const reader = { read: async () => chunk, cancel: async () => {} };
    expect(await readWithIdle(reader, 1000)).toBe(chunk);
    expect(await readWithIdle(reader, 0)).toBe(chunk);
  });
});

describe('network recovery classification', () => {
  it('recognizes DNS and routing failures, including fetch causes', () => {
    for (const code of ['ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
      const error = new Error('connection unavailable', { cause: { code } });
      expect(isNetworkProviderError(error)).toBe(true);
      expect(isTransientProviderError(error)).toBe(true);
    }
  });
  it('does not extend HTTP, idle-stream or intentional abort retries', () => {
    expect(isNetworkProviderError(new ProviderHttpError('network error', 401))).toBe(false);
    expect(isNetworkProviderError(new ProviderHttpError('unavailable', 503))).toBe(false);
    expect(isNetworkProviderError(new StreamStalledError(1000))).toBe(false);
    expect(isNetworkProviderError(new DOMException('network error', 'AbortError'))).toBe(false);
  });
});

describe('network recovery window', () => {
  it('waits about half an hour in all before the reply ends', () => {
    expect(MAX_NETWORK_STREAM_ATTEMPTS).toBe(65);
    let waited = 0;
    for (let attempt = 1; attempt < MAX_NETWORK_STREAM_ATTEMPTS; attempt++) waited += retryDelayMs(attempt, undefined, () => 0);
    expect(waited / 60_000).toBeGreaterThan(29);
    expect(waited / 60_000).toBeLessThan(32);
  });
});
