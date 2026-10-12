import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthProvider, OAuthStatus, OAuthTokenSet } from '@nekko-agent/shared';
import {
  buildAuthorizeUrl,
  buildStatus,
  claudeCliToken,
  codexCliToken,
  exchangeRequest,
  exchangeResult,
  makeTokenKey,
  parsePasted,
  refreshRequest,
  refreshResult,
} from './oauth.js';

/**
 * What the engine daemon's OAuth port (crates/nekko-oauth) must reproduce
 * exactly: authorize URLs, pasted-code parsing, token requests, what their
 * responses become (token sets or errors), statuses and the CLI imports, for
 * every case in `golden/cases.json`. Fails when `golden/expected.json` is
 * stale; rewrite it with `UPDATE_GOLDEN=1`.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-oauth', 'tests', 'golden');

type Outcome = { value: string } | { error: string };
function outcome(fn: () => unknown): Outcome {
  try {
    const v = fn();
    return { value: v === undefined ? 'undefined' : JSON.stringify(v) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function at<T>(now: number, fn: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.useRealTimers());

interface Cases {
  authorizeUrls: Array<{ provider: OAuthProvider; redirectUri: string; challenge: string; state: string }>;
  pasted: Array<{ pasted: string; redirectUri: string }>;
  exchangeRequests: Array<{ provider: OAuthProvider; code: string; redirectUri: string; verifier: string; state: string }>;
  exchangeResults: Array<{ provider: OAuthProvider; ok: boolean; status: number; text: string; obtainedAt: number; now: number }>;
  refreshRequests: OAuthTokenSet[];
  refreshResults: Array<{ tokenSet: OAuthTokenSet; ok: boolean; status: number; text: string; obtainedAt: number; now: number }>;
  statuses: Array<{ tokenKey: string; tokenSet?: OAuthTokenSet; state: OAuthStatus['state']; message?: string; now: number }>;
  cli: Array<{ kind: 'claude' | 'codex'; raw: string; now: number }>;
  tokenKeys: Array<{ provider: OAuthProvider; accountId?: string; sessionId: string }>;
}

describe('oauth golden set', () => {
  it('matches what the TS OAuth functions produce for every case', () => {
    const c = JSON.parse(readFileSync(join(golden, 'cases.json'), 'utf8')) as Cases;
    const actual = {
      authorizeUrls: c.authorizeUrls.map((x) => outcome(() => buildAuthorizeUrl(x.provider, x.redirectUri, x.challenge, x.state))),
      pasted: c.pasted.map((x) => outcome(() => parsePasted(x.pasted, x.redirectUri))),
      exchangeRequests: c.exchangeRequests.map((x) => outcome(() => exchangeRequest(x.provider, x.code, x.redirectUri, x.verifier, x.state))),
      exchangeResults: c.exchangeResults.map((x) => at(x.now, () => outcome(() => exchangeResult(x.provider, x.ok, x.status, x.text, x.obtainedAt)))),
      refreshRequests: c.refreshRequests.map((x) => outcome(() => refreshRequest(x))),
      refreshResults: c.refreshResults.map((x) => at(x.now, () => outcome(() => refreshResult(x.tokenSet, x.ok, x.status, x.text, x.obtainedAt)))),
      statuses: c.statuses.map((x) => at(x.now, () => outcome(() => buildStatus(x.tokenKey, x.tokenSet, x.state, x.message)))),
      // A JSON.parse error's wording is V8's own; only the fact of it is held.
      cli: c.cli.map((x) => {
        const o = outcome(() => (x.kind === 'claude' ? claudeCliToken(x.raw, x.now) : codexCliToken(x.raw, x.now)));
        return 'error' in o ? { error: true } : o;
      }),
      tokenKeys: c.tokenKeys.map((x) => outcome(() => makeTokenKey(x.provider, x.accountId, x.sessionId))),
    };
    const path = join(golden, 'expected.json');
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
  });
});
