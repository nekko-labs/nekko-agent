import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { setDataDir } from './paths.js';
import {
  pkcePair,
  beginOAuth,
  finishOAuth,
  cancelOAuth,
  setToken,
  getToken,
  ensureFreshToken,
  importCliAuth,
  useOAuthDaemon,
} from './oauth.js';

describe('OAuth core', () => {
  let dir: string;
  let fetchMock: Mock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nekko-oauth-'));
    setDataDir(dir);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  describe('pkcePair', () => {
    it('produces base64url verifier and S256 challenge', () => {
      const { verifier, challenge } = pkcePair();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    });
  });

  describe('beginOAuth', () => {
    it('builds a Claude URL where state equals the verifier', async () => {
      const session = await beginOAuth('claude');
      const url = new URL(session.authUrl);
      expect(url.hostname).toBe('claude.com');
      expect(url.pathname).toBe('/cai/oauth/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const state = url.searchParams.get('state');
      const challenge = url.searchParams.get('code_challenge');
      expect(state).toBeTruthy();
      expect(challenge).toBeTruthy();
      // Finishing with code#state should exchange with code_verifier == state.
      const captured = await captureTokenExchange(fetchMock, 'claude', async () => {
        fetchMock.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'claude-access',
              refresh_token: 'claude-refresh',
              expires_in: 3600,
              scope: 'user:profile user:inference',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
        await finishOAuth(session.id, `auth-code#${state}`);
      });
      const body = JSON.parse(captured.body);
      expect(body).toMatchObject({
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        grant_type: 'authorization_code',
        code: 'auth-code',
        // Anthropic rejects the exchange as "Invalid request format" without it.
        state,
        code_verifier: state,
      });
      expect(captured.headers['Content-Type']).toBe('application/json');
    });

    it('asks Claude to render the pasteable code only on the manual console callback', async () => {
      const loopback = await beginOAuth('claude');
      const loopbackUrl = new URL(loopback.authUrl);
      expect(loopbackUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      expect(loopbackUrl.searchParams.get('code')).toBeNull();
      cancelOAuth(loopback.id);

      // With every loopback port taken, begin falls back to the console
      // callback, which needs `code=true` to show a code worth pasting.
      const blockers = await occupyClaudeLoopbackPorts();
      try {
        const manual = await beginOAuth('claude');
        const manualUrl = new URL(manual.authUrl);
        expect(manual.mode).toBe('manual');
        expect(manualUrl.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
        expect(manualUrl.searchParams.get('code')).toBe('true');
        cancelOAuth(manual.id);
      } finally {
        await Promise.all(blockers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      }
    });

    it('builds a ChatGPT URL and exchanges with form-urlencoded body', async () => {
      const session = await beginOAuth('chatgpt');
      const url = new URL(session.authUrl);
      expect(url.hostname).toBe('auth.openai.com');
      expect(url.pathname).toBe('/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.has('id_token_add_organizations')).toBe(false);
      expect(url.searchParams.has('codex_cli_simplified_flow')).toBe(false);
      expect(url.searchParams.has('originator')).toBe(false);
      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();

      const idToken = makeFakeIdToken('chatgpt-account-123');
      const captured = await captureTokenExchange(fetchMock, 'chatgpt', async () => {
        fetchMock.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'chatgpt-access',
              refresh_token: 'chatgpt-refresh',
              id_token: idToken,
              expires_in: 3600,
              scope: 'openid profile email offline_access',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
        await finishOAuth(session.id, `https://localhost:1455/auth/callback?code=codex-code&state=${state}`);
      });
      const params = new URLSearchParams(captured.body);
      const verifier = params.get('code_verifier')!;
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(params.get('code')).toBe('codex-code');
      expect(captured.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('accepts ChatGPT loopback callbacks on the redirectUri path and rejects other paths', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'chatgpt-access',
            refresh_token: 'chatgpt-refresh',
            id_token: makeFakeIdToken('chatgpt-account-123'),
            expires_in: 3600,
            scope: 'openid profile email offline_access',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const session = await beginOAuth('chatgpt');
      const authUrl = new URL(session.authUrl);
      expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      const state = authUrl.searchParams.get('state')!;

      const wrong = await requestStatus(`/callback?code=loopback-code&state=${state}`);
      expect(wrong).toBe(404);

      const right = await requestStatus(`/auth/callback?code=loopback-code&state=${state}`);
      expect(right).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reclaims port 1455 from an abandoned ChatGPT session instead of going manual', async () => {
      const first = await beginOAuth('chatgpt');
      expect(first.mode).toBe('loopback');

      const second = await beginOAuth('chatgpt');
      try {
        expect(second.mode).toBe('loopback');
        // The first session was closed to free the port; it can no longer finish.
        await expect(finishOAuth(first.id, 'code')).rejects.toThrow('not found');
        // And the new listener actually answers.
        const state = new URL(second.authUrl).searchParams.get('state');
        const res = await requestStatus(`/auth/callback?code=x&state=${state}-wrong`);
        expect(res).toBe(400);
      } finally {
        cancelOAuth(second.id);
      }
    });

    it('degrades ChatGPT to manual when something else holds port 1455', async () => {
      const holder = await holdPort1455();
      if (!holder) {
        // Port not bindable in this environment at all; nothing to assert.
        return;
      }
      try {
        const session = await beginOAuth('chatgpt');
        try {
          expect(session.mode).toBe('manual');
          // The redirect URI cannot change (OpenAI registered exactly one), so
          // the auth URL still points at the dead port and the UI's paste box
          // is how the code comes home.
          const url = new URL(session.authUrl);
          expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
        } finally {
          cancelOAuth(session.id);
        }
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    });

    it('builds an OpenRouter URL with callback_url and no client_id or state', async () => {
      const session = await beginOAuth('openrouter');
      const url = new URL(session.authUrl);
      expect(url.hostname).toBe('openrouter.ai');
      expect(url.pathname).toBe('/auth');
      expect(url.searchParams.get('callback_url')).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.has('client_id')).toBe(false);
      expect(url.searchParams.has('state')).toBe(false);
      expect(url.searchParams.has('scope')).toBe(false);
      expect(session.mode).toBe('loopback');
      cancelOAuth(session.id);
    });

    it('exchanges an OpenRouter code for a permanent API key', async () => {
      const session = await beginOAuth('openrouter');
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ key: 'sk-or-v1-test', user_id: 'user_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      // OpenRouter has no state echo, so a bare code is the whole paste.
      const status = await finishOAuth(session.id, 'auth_code_abc');
      expect(status.connected).toBe(true);
      expect(status.provider).toBe('openrouter');
      expect(status.tokenKey).toMatch(/^openrouter:/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://openrouter.ai/api/v1/auth/keys');
      const body = JSON.parse((init as { body: string }).body);
      expect(body).toMatchObject({ code: 'auth_code_abc', code_challenge_method: 'S256' });
      expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new URL(session.authUrl).searchParams.get('code_challenge')).toBe(
        createHash('sha256').update(body.code_verifier).digest('base64url'),
      );

      const stored = getToken(status.tokenKey);
      expect(stored?.provider).toBe('openrouter');
      expect(stored?.accessToken).toBe('sk-or-v1-test');
      expect(stored?.expiresAt).toBeUndefined();
      expect(stored?.refreshToken).toBeUndefined();
    });

    it('accepts an OpenRouter loopback callback without a state param', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ key: 'sk-or-v1-loop', user_id: 'user_2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const session = await beginOAuth('openrouter');
      const port = Number(new URL(new URL(session.authUrl).searchParams.get('callback_url')!).port);
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get({ hostname: 'localhost', port, path: '/callback?code=or-code', agent: false }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          })
          .on('error', reject);
      });
      expect(status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('token store', () => {
    it('round-trips token sets through tokens.json', () => {
      setToken('claude/my-key', {
        provider: 'claude',
        accessToken: 'secret-access',
        refreshToken: 'secret-refresh',
        expiresAt: Date.now() + 3600_000,
        accountId: 'user@example.com',
        scopes: 'user:profile user:inference',
        obtainedAt: Date.now(),
      });
      const back = getToken('claude/my-key');
      expect(back).toBeTruthy();
      expect(back?.provider).toBe('claude');
      expect(back?.accessToken).toBe('secret-access');
      expect(back?.refreshToken).toBe('secret-refresh');
      expect(back?.accountId).toBe('user@example.com');
    });

    it('ensureFreshToken refreshes a stale token and updates the store', async () => {
      const tokenKey = 'chatgpt/account-1';
      setToken(tokenKey, {
        provider: 'chatgpt',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1,
        accountId: 'account-1',
        obtainedAt: Date.now() - 2,
      });

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            scope: 'openid profile email offline_access',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const access = await ensureFreshToken(tokenKey);
      expect(access).toBe('new-access');
      const refreshed = getToken(tokenKey);
      expect(refreshed?.accessToken).toBe('new-access');
      expect(refreshed?.refreshToken).toBe('new-refresh');
      const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
      const params = new URLSearchParams(init.body);
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(params.get('refresh_token')).toBe('old-refresh');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('ensureFreshToken returns a still-valid token without hitting the network', async () => {
      const tokenKey = 'claude/account-2';
      setToken(tokenKey, {
        provider: 'claude',
        accessToken: 'live-access',
        refreshToken: 'live-refresh',
        expiresAt: Date.now() + 120_000,
        obtainedAt: Date.now(),
      });
      const access = await ensureFreshToken(tokenKey);
      expect(access).toBe('live-access');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ensureFreshToken returns an OpenRouter key as-is, even when forced', async () => {
      const tokenKey = 'openrouter:user_1';
      setToken(tokenKey, { provider: 'openrouter', accessToken: 'sk-or-v1-test', obtainedAt: Date.now() });
      // A permanent key has no expiry and no refresh token: force or not,
      // there is nothing to renew.
      expect(await ensureFreshToken(tokenKey)).toBe('sk-or-v1-test');
      expect(await ensureFreshToken(tokenKey, true)).toBe('sk-or-v1-test');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('importCliAuth', () => {
    it('adopts tokens from CLI credential files and reports what was found', () => {
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      try {
        mkdirSync(join(dir, '.claude'), { recursive: true });
        mkdirSync(join(dir, '.codex'), { recursive: true });
        writeFileSync(
          join(dir, '.claude', '.credentials.json'),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: 'claude-cli-access',
              refreshToken: 'claude-cli-refresh',
              expiresAt: Date.now() + 3600_000,
              scopes: ['user:profile', 'user:inference'],
            },
          }),
        );
        writeFileSync(
          join(dir, '.codex', 'auth.json'),
          JSON.stringify({
            tokens: {
              access_token: 'codex-access',
              refresh_token: 'codex-refresh',
              account_id: 'codex-account-1',
            },
            last_refresh: Date.now(),
          }),
        );
        const summary = importCliAuth();
        expect(summary.claude).toBe(true);
        expect(summary.chatgpt).toBe(true);
        expect(getToken('claude')?.accessToken).toBe('claude-cli-access');
        expect(getToken('chatgpt')?.accountId).toBe('codex-account-1');
      } finally {
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserProfile;
      }
    });
  });
});

async function captureTokenExchange(
  mock: Mock,
  provider: 'claude' | 'chatgpt',
  fn: () => Promise<void>,
): Promise<{
  url: string;
  headers: Record<string, string>;
  body: any;
}> {
  await fn();
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0];
  expect(String(url)).toContain(provider === 'claude' ? 'platform.claude.com' : 'auth.openai.com');
  return {
    url: String(url),
    headers: (init as any).headers as Record<string, string>,
    body: (init as any).body as any,
  };
}

/** Hold every port Claude's loopback listener scans, forcing the manual fallback. */
async function occupyClaudeLoopbackPorts(): Promise<http.Server[]> {
  const servers: http.Server[] = [];
  for (let port = 8765; port <= 8795; port++) {
    const server = http.createServer(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      servers.push(server);
    } catch {
      // A port we cannot bind (Windows reserves ranges for Hyper-V) is a port
      // the host cannot bind either, so it counts as occupied for this test.
      server.close();
    }
  }
  return servers;
}

/** Sit on ChatGPT's fixed callback port to force the manual fallback. */
async function holdPort1455(): Promise<http.Server | undefined> {
  const server = http.createServer(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(1455, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    return server;
  } catch {
    server.close();
    return undefined;
  }
}

function makeFakeIdToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-123',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  const signature = randomBytes(16).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function requestStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: 1455, path, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject);
  });
}

describe('OAuth under the engine daemon', () => {
  it('asks the daemon for a usable token and never writes tokens.json itself', async () => {
    setDataDir(mkdtempSync(join(tmpdir(), 'nekko-oauth-daemon-')));
    const calls: unknown[][] = [];
    useOAuthDaemon((async (...args: unknown[]) => {
      calls.push(args);
      return 'fresh-token';
    }) as never);
    try {
      expect(await ensureFreshToken('claude:a')).toBe('fresh-token');
      expect(await ensureFreshToken('claude:a', true)).toBe('fresh-token');
      expect(calls).toEqual([['oauth:fresh', 'claude:a', false], ['oauth:fresh', 'claude:a', true]]);
      expect(() => setToken('claude:a', { provider: 'claude', accessToken: 'x', obtainedAt: 1 })).toThrow(/engine daemon/);
    } finally {
      useOAuthDaemon(null);
    }
  });
});
