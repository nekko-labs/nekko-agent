import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { OAuthProvider, OAuthSessionInfo, OAuthStatus, OAuthTokenSet, ProviderConfig } from '@nekko-agent/shared';
import { dataDir } from './paths.js';
import { ensurePrivateFile, writeJsonAtomic } from './secure-file.js';

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_SCOPES = 'org:create_api_key user:profile user:inference';
const CLAUDE_MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const CLAUDE_LOOPBACK_PORT_START = 8765;
const CLAUDE_LOOPBACK_PORT_END = 8795;

/** Bind failures that mean "this port is not ours to take", not a fatal error. */
const UNAVAILABLE_PORT_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_SCOPES = 'openid profile email offline_access';
const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback';

/**
 * OpenRouter's sign-in is the same PKCE shape minus the parts it does not use:
 * no client id, no scopes, and no state echo. What the exchange returns is a
 * permanent API key, not a token pair, so there is nothing to refresh.
 */
const OPENROUTER_AUTHORIZE_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/auth/keys';

/** Milliseconds a pending OAuth session stays valid. */
const SESSION_TTL_MS = 10 * 60 * 1000;

/** ChatGPT CLI access tokens are valid for 10 days after `last_refresh`. */
const CHATGPT_CLI_TOKEN_TTL_MS = 10 * 24 * 60 * 60 * 1000;

/** In-memory pending sessions keyed by session id. */
interface OAuthSession {
  id: string;
  provider: OAuthProvider;
  verifier: string;
  state: string;
  challenge: string;
  redirectUri: string;
  mode: 'loopback' | 'manual';
  expiresAt: number;
  server?: ReturnType<typeof createServer>;
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, OAuthSession>();
const inFlight = new Map<string, Promise<string>>();
let events: EventEmitter | null = null;

/** Wire the OAuth service to the host's event bus. Called once in createHost. */
export function initOAuth(eventBus: EventEmitter): void {
  events = eventBus;
}

function tokenStorePath(): string {
  return join(dataDir(), 'tokens.json');
}

function loadTokens(): Record<string, OAuthTokenSet> {
  const p = tokenStorePath();
  if (!existsSync(p)) return {};
  ensurePrivateFile(p);
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, OAuthTokenSet>;
  } catch {
    return {};
  }
}

/**
 * Under the engine daemon, tokens.json is the daemon's to write
 * (crates/nekkod/src/oauth.rs): sign-in, renewal, sign-out and the CLI import
 * all happen there, and this host asks it for a usable token (`oauth:fresh`)
 * instead of renewing one itself. A renewal rotates the refresh token, so two
 * writers would sign each other out.
 */
type OAuthDaemon = <T>(channel: string, ...args: unknown[]) => Promise<T>;
let daemon: OAuthDaemon | undefined;

export function useOAuthDaemon(call: OAuthDaemon | null): void {
  daemon = call ?? undefined;
}

function saveTokens(tokens: Record<string, OAuthTokenSet>): void {
  if (daemon) throw new Error('tokens.json is written by the engine daemon under nekkod.');
  writeJsonAtomic(tokenStorePath(), tokens);
}

export function getToken(tokenKey: string): OAuthTokenSet | undefined {
  return loadTokens()[tokenKey];
}

export function setToken(tokenKey: string, tokenSet: OAuthTokenSet): void {
  const tokens = loadTokens();
  tokens[tokenKey] = tokenSet;
  saveTokens(tokens);
}

export function deleteToken(tokenKey: string): void {
  const tokens = loadTokens();
  delete tokens[tokenKey];
  saveTokens(tokens);
}

/** Build a sanitized status object. Never includes the access token. */
export function buildStatus(
  tokenKey: string,
  tokenSet?: OAuthTokenSet,
  state: OAuthStatus['state'] = 'success',
  message?: string,
): OAuthStatus {
  if (!tokenSet) {
    return { tokenKey, connected: false, state: state ?? 'missing', message };
  }
  const expiresAt = tokenExpiresAt(tokenSet);
  const expired = !!expiresAt && expiresAt < Date.now();
  return {
    tokenKey,
    provider: tokenSet.provider,
    connected: !expired,
    accountId: tokenSet.accountId,
    accountEmail: tokenSet.accountEmail,
    expiresAt: tokenSet.expiresAt,
    scopes: tokenSet.scopes,
    state,
    message,
  };
}

function emitStatus(status: OAuthStatus): void {
  events?.emit('oauthStatus', status);
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(16).toString('base64url');
}

export function buildAuthorizeUrl(
  provider: OAuthProvider,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  if (provider === 'openrouter') {
    // OpenRouter's own parameter names: it calls the redirect `callback_url`
    // and does not take a client_id, scope, or state.
    const url = new URL(OPENROUTER_AUTHORIZE_URL);
    url.searchParams.set('callback_url', redirectUri);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }
  const url = new URL(provider === 'claude' ? CLAUDE_AUTHORIZE_URL : CHATGPT_AUTHORIZE_URL);
  // Claude's console callback only renders the `code#state` string to copy when
  // `code=true` is set; without it the page has nothing for the manual fallback
  // to paste. Loopback redirects must not set it, or the browser lands on that
  // page instead of coming back to us.
  if (provider === 'claude' && redirectUri === CLAUDE_MANUAL_REDIRECT_URI) {
    url.searchParams.set('code', 'true');
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider === 'claude' ? CLAUDE_CLIENT_ID : CHATGPT_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', provider === 'claude' ? CLAUDE_SCOPES : CHATGPT_SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

function listenOnce(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function findClaudeLoopbackPort(
  session: OAuthSession,
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<number | undefined> {
  for (let port = CLAUDE_LOOPBACK_PORT_START; port <= CLAUDE_LOOPBACK_PORT_END; port++) {
    const server = createServer(handler);
    session.server = server;
    try {
      await listenOnce(server, port);
      return port;
    } catch (e: any) {
      try {
        server.close();
      } catch {
        /* best effort */
      }
      // A port can be unavailable without being in use: Windows reserves
      // ranges for Hyper-V/WinNAT and refuses the bind with EACCES. Those are
      // "try the next one" too, not a reason to fail the whole sign-in.
      if (!UNAVAILABLE_PORT_CODES.has(e?.code)) {
        session.server = undefined;
        throw e;
      }
    }
  }
  session.server = undefined;
  return undefined;
}

async function startLoopback(
  session: OAuthSession,
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<boolean> {
  if (session.provider === 'openrouter') {
    // OpenRouter accepts any callback URL, so the port can be whatever the OS
    // hands out rather than a fixed one the provider registered.
    const server = createServer(handler);
    session.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      if (!port) throw new Error('no port');
      session.redirectUri = `http://localhost:${port}/callback`;
      return true;
    } catch {
      try {
        server.close();
      } catch {
        /* best effort */
      }
      session.server = undefined;
      return false;
    }
  }
  if (session.provider === 'claude') {
    const port = await findClaudeLoopbackPort(session, handler);
    if (!port) return false;
    session.redirectUri = `http://localhost:${port}/callback`;
    return true;
  }
  // ChatGPT registered exactly one redirect URI, so the listener has to take
  // port 1455.
  const tryListen = async (): Promise<boolean> => {
    const server = createServer(handler);
    session.server = server;
    try {
      await listenOnce(server, 1455);
      session.redirectUri = CHATGPT_REDIRECT_URI;
      return true;
    } catch (e: any) {
      try {
        server.close();
      } catch {
        /* best effort */
      }
      session.server = undefined;
      if (e?.code === 'EADDRINUSE') return false;
      throw e;
    }
  };
  if (await tryListen()) return true;
  // The port's most common squatter is an earlier sign-in session of ours that
  // never finished (the window closed mid-flow, Connect was clicked twice).
  // Taking it back is safe; anything else holding 1455 is not ours to close,
  // and the flow degrades to manual: the redirect still lands on the dead
  // port, so the user pastes the address-bar URL back to finish.
  if ((await reclaimChatgptLoopback(session.id)) && (await tryListen())) return true;
  return false;
}

/**
 * Close another pending ChatGPT session's listener and wait for the port to
 * free. Returns whether such a session existed.
 */
async function reclaimChatgptLoopback(currentId: string): Promise<boolean> {
  const stale = [...sessions.values()].find(
    (s) => s.id !== currentId && s.provider === 'chatgpt' && s.server,
  );
  if (!stale?.server) return false;
  const server = stale.server;
  closeSession(stale);
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 500);
    t.unref?.();
    server.once('close', () => {
      clearTimeout(t);
      resolve();
    });
  });
  return true;
}

function scheduleSessionExpiry(session: OAuthSession): void {
  const ttl = session.expiresAt - Date.now();
  if (ttl <= 0) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (sessions.get(session.id) === session) {
      closeSession(session);
    }
  }, ttl);
}

function closeSession(session: OAuthSession): void {
  sessions.delete(session.id);
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = undefined;
  }
  try {
    session.server?.close();
  } catch {
    /* best effort */
  }
}

async function callbackHandler(
  session: OAuthSession,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const callbackPath = new URL(session.redirectUri).pathname;
    if (url.pathname !== callbackPath) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code) {
      res.writeHead(400);
      res.end('missing code');
      return;
    }
    // OpenRouter does not echo a state; its protection is the PKCE verifier.
    if (session.provider !== 'openrouter' && state !== session.state) {
      res.writeHead(400);
      res.end('invalid state');
      return;
    }
    const tokenSet = await exchangeCode(session.provider, code, session.redirectUri, session.verifier, session.state);
    const tokenKey = makeTokenKey(session.provider, tokenSet.accountId, session.id);
    setToken(tokenKey, tokenSet);
    closeSession(session);
    emitStatus(buildStatus(tokenKey, tokenSet, 'success'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Sign-in complete. You can close this tab.</body></html>');
  } catch (e) {
    const message = (e as Error).message;
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Sign-in failed: ${message}`);
    emitStatus({
      tokenKey: '',
      provider: session.provider,
      connected: false,
      state: 'error',
      message,
    });
  }
}

export async function beginOAuth(provider: OAuthProvider): Promise<OAuthSessionInfo> {
  const { verifier, challenge } = pkcePair();
  const state = provider === 'claude' ? verifier : generateState();
  const session: OAuthSession = {
    id: randomUUID(),
    provider,
    verifier,
    state,
    challenge,
    redirectUri:
      provider === 'claude'
        ? CLAUDE_MANUAL_REDIRECT_URI
        : provider === 'openrouter'
          ? 'http://localhost/callback'
          : CHATGPT_REDIRECT_URI,
    mode: 'manual',
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    void callbackHandler(session, req, res);
  };

  sessions.set(session.id, session);
  scheduleSessionExpiry(session);

  const listening = await startLoopback(session, handler);
  if (listening) {
    session.mode = 'loopback';
  } else if (provider === 'openrouter') {
    // OpenRouter's flow has no paste-a-code page; without a local listener it
    // cannot complete at all, so fail now rather than at the callback.
    closeSession(session);
    throw new Error('Could not open a local listener for the sign-in callback. Check nothing else is saturating the port range, then try again.');
  }

  const authUrl = buildAuthorizeUrl(provider, session.redirectUri, challenge, state);

  emitStatus({
    tokenKey: '',
    provider,
    connected: false,
    state: 'pending',
  });

  return {
    id: session.id,
    provider,
    authUrl,
    mode: session.mode,
    expiresAt: session.expiresAt,
  };
}

export function makeTokenKey(provider: OAuthProvider, accountId: string | undefined, sessionId: string): string {
  return `${provider}:${accountId ?? sessionId.slice(0, 8)}`;
}

/** Extract a code and optional state from a raw code, code#state, or full URL. */
export function parsePasted(pasted: string, redirectUri: string): { code: string; state?: string } {
  const trimmed = pasted.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const url = new URL(trimmed);
    const redirect = new URL(redirectUri);
    if (url.hostname.toLowerCase() !== redirect.hostname.toLowerCase() || url.pathname !== redirect.pathname) {
      throw new Error('Pasted URL does not match this session\'s redirect URI.');
    }
    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    if (!code) throw new Error('No authorization code found in the URL.');
    return { code, state };
  }
  if (trimmed.includes('#')) {
    const [code, state] = trimmed.split('#', 2);
    return { code, state };
  }
  return { code: trimmed };
}

export async function finishOAuth(sessionId: string, pasted: string): Promise<OAuthStatus> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('OAuth session not found or already completed.');
  if (session.expiresAt < Date.now()) {
    closeSession(session);
    throw new Error('OAuth session has expired. Start again.');
  }

  const { code, state } = parsePasted(pasted, session.redirectUri);
  // A pasted code without a state (bare code or a URL without a state) is accepted
  // as the documented manual-fallback behavior.
  if (state && state !== session.state) {
    throw new Error('Invalid state parameter. The pasted code does not match this session.');
  }

  const tokenSet = await exchangeCode(session.provider, code, session.redirectUri, session.verifier, session.state);
  const tokenKey = makeTokenKey(session.provider, tokenSet.accountId, session.id);
  setToken(tokenKey, tokenSet);
  closeSession(session);
  const status = buildStatus(tokenKey, tokenSet, 'success');
  emitStatus(status);
  return status;
}

export function cancelOAuth(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  closeSession(session);
}

/** The `email` claim of an unvalidated ChatGPT id_token, if it carries one. */
export function extractEmail(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return cleanEmail(json.email);
  } catch {
    return undefined;
  }
}

/** A plausible email address, trimmed, or undefined. Display-only, never used to authorize. */
export function cleanEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}

export function extractAccountId(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const json = JSON.parse(payload) as Record<string, unknown>;
    const auth = json['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

/** Decode the `exp` claim from an unvalidated JWT, returning epoch milliseconds. */
export function expFromJwt(jwt: string | undefined): number | undefined {
  if (typeof jwt !== 'string') return undefined;
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const json = JSON.parse(payload) as Record<string, unknown>;
    if (typeof json.exp === 'number') return json.exp * 1000;
  } catch {
    /* malformed or not a JWT */
  }
  return undefined;
}

/** Best-effort expiry for a stored token, falling back to a JWT `exp` claim. */
function tokenExpiresAt(tokenSet: OAuthTokenSet): number | undefined {
  if (tokenSet.expiresAt) return tokenSet.expiresAt;
  if (tokenSet.provider === 'chatgpt') return expFromJwt(tokenSet.accessToken);
  return undefined;
}

export function tokenFromResponse(provider: OAuthProvider, json: Record<string, unknown>, obtainedAt: number): OAuthTokenSet {
  // OpenRouter's exchange returns the API key itself as `key`, not a token pair.
  const accessToken = (json.access_token ?? json.key) as string | undefined;
  if (!accessToken) throw new Error('Token response missing access_token.');

  if (provider === 'openrouter') {
    return { provider, accessToken, obtainedAt };
  }

  const idToken = json.id_token as string | undefined;
  const accountId = provider === 'chatgpt' ? (idToken ? extractAccountId(idToken) : undefined) : undefined;
  // Claude's token response names the account it signed in; ChatGPT's id_token
  // carries an `email` claim (the sign-in asks for the `email` scope).
  const account = json.account as Record<string, unknown> | undefined;
  const accountEmail = provider === 'claude'
    ? cleanEmail(account?.email_address)
    : idToken ? extractEmail(idToken) : undefined;

  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  const scopes = json.scope as string | undefined;

  // ChatGPT access tokens are JWTs; their `exp` claim is more reliable than
  // the `expires_in` field when it is missing or rounded down.
  const jwtExp = provider === 'chatgpt' ? expFromJwt(accessToken) : undefined;
  const expiresAt = jwtExp ?? Date.now() + expiresIn * 1000;

  return {
    provider,
    accessToken,
    refreshToken: json.refresh_token as string | undefined,
    expiresAt,
    accountId,
    accountEmail,
    scopes,
    obtainedAt,
  };
}

/** A token endpoint request: where, with which headers, and the body. */
export interface TokenRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The request that redeems an authorization code (OpenRouter: for its API key). */
export function exchangeRequest(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
  verifier: string,
  state: string,
): TokenRequest {
  if (provider === 'openrouter') {
    return {
      url: OPENROUTER_KEY_URL,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    };
  }
  if (provider === 'claude') {
    // Anthropic's token endpoint validates the whole body against a schema and
    // rejects it with "Invalid request format" when `state` is absent, even
    // though the code alone would identify the grant.
    return {
      url: CLAUDE_TOKEN_URL,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: CLAUDE_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        state,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    };
  }
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CHATGPT_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  return {
    url: CHATGPT_TOKEN_URL,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  };
}

/** What a redeemed code's response becomes: the token set, or the error the sign-in fails with. */
export function exchangeResult(provider: OAuthProvider, ok: boolean, status: number, text: string, obtainedAt: number): OAuthTokenSet {
  if (provider === 'openrouter') {
    if (!ok) {
      const errBody = safeJson(text);
      const errField = errBody?.error as { message?: unknown } | undefined;
      const err = String(errField?.message ?? errBody?.error_description ?? (text.slice(0, 200) || `HTTP ${status}`));
      throw new Error(`Key exchange failed: ${err}`);
    }
    const json = safeJson(text);
    if (!json?.key) throw new Error('OpenRouter returned no API key.');
    return tokenFromResponse(provider, json, obtainedAt);
  }
  if (!ok) {
    const err = String(safeJson(text)?.error_description ?? text.slice(0, 200) ?? `HTTP ${status}`);
    throw new Error(`Token exchange failed: ${err}`);
  }
  const json = safeJson(text);
  if (!json) throw new Error('Token response was not valid JSON.');
  const tokenSet = tokenFromResponse(provider, json, obtainedAt);
  if (provider === 'chatgpt' && !tokenSet.accountId) {
    throw new Error('Could not read your ChatGPT account id from the sign-in response.');
  }
  return tokenSet;
}

async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
  verifier: string,
  state: string,
): Promise<OAuthTokenSet> {
  const obtainedAt = Date.now();
  const req = exchangeRequest(provider, code, redirectUri, verifier, state);
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
  const text = await res.text().catch(() => '');
  return exchangeResult(provider, res.ok, res.status, text, obtainedAt);
}

/** The request that renews a token set that has a refresh token. */
export function refreshRequest(tokenSet: OAuthTokenSet): TokenRequest {
  if (tokenSet.provider === 'claude') {
    return {
      url: CLAUDE_TOKEN_URL,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: CLAUDE_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: tokenSet.refreshToken,
        // The first-party client echoes the granted scope set on refresh; the
        // endpoint's strict body validation rejects a grant missing it.
        scope: tokenSet.scopes ?? CLAUDE_SCOPES,
      }),
    };
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CHATGPT_CLIENT_ID,
    refresh_token: tokenSet.refreshToken ?? '',
  });
  return {
    url: CHATGPT_TOKEN_URL,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  };
}

/** What a renewal's response becomes: the next token set, or the error. */
export function refreshResult(tokenSet: OAuthTokenSet, ok: boolean, status: number, text: string, obtainedAt: number): OAuthTokenSet {
  if (!ok) {
    const err = String(safeJson(text)?.error_description ?? text.slice(0, 200) ?? `HTTP ${status}`);
    if (status === 401 || /invalid_grant|expired|revoked/i.test(err)) {
      throw new Error('Subscription session expired. Sign in again.');
    }
    throw new Error(`Token refresh failed: ${err}`);
  }
  const json = safeJson(text);
  if (!json) throw new Error('Token refresh response was not valid JSON.');
  const next = tokenFromResponse(tokenSet.provider, json, obtainedAt);
  if (next.refreshToken == null) next.refreshToken = tokenSet.refreshToken;
  if (next.accountId == null && tokenSet.accountId) next.accountId = tokenSet.accountId;
  if (next.accountEmail == null && tokenSet.accountEmail) next.accountEmail = tokenSet.accountEmail;
  if (next.scopes == null && tokenSet.scopes) next.scopes = tokenSet.scopes;
  return next;
}

async function refreshTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
  const obtainedAt = Date.now();
  if (!tokenSet.refreshToken) throw new Error('No refresh token available.');
  const req = refreshRequest(tokenSet);
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
  const text = await res.text().catch(() => '');
  return refreshResult(tokenSet, res.ok, res.status, text, obtainedAt);
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function ensureFreshToken(tokenKey: string, force = false): Promise<string> {
  if (!tokenKey) {
    throw new Error('No token key specified.');
  }
  if (daemon) return daemon<string>('oauth:fresh', tokenKey, force);
  if (!force) {
    const existing = inFlight.get(tokenKey);
    if (existing) return existing;
  }

  const promise = (async () => {
    const tokenSet = getToken(tokenKey);
    if (!tokenSet) {
      throw new Error(`No subscription token found for ${tokenKey}. Sign in again.`);
    }
    // A missing expiresAt does not mean the token is expired; try to recover
    // the `exp` claim from a ChatGPT JWT, and refresh only if no expiry can be
    // determined or the token is within 60 seconds of expiring.
    const expiresAt = tokenExpiresAt(tokenSet);
    if (!force && expiresAt && expiresAt - 60_000 > Date.now()) {
      return tokenSet.accessToken;
    }
    // An OpenRouter sign-in produces a permanent API key: no expiry, no refresh
    // token, nothing to renew. It stays valid until the user revokes it.
    if (!expiresAt && !tokenSet.refreshToken) {
      return tokenSet.accessToken;
    }
    if (!tokenSet.refreshToken) {
      throw new Error(`Subscription session expired for ${tokenKey}. Sign in again.`);
    }
    const next = await refreshTokenSet(tokenSet);
    setToken(tokenKey, next);
    emitStatus(buildStatus(tokenKey, next, 'success'));
    return next.accessToken;
  })();

  inFlight.set(tokenKey, promise);
  return promise.finally(() => {
    if (inFlight.get(tokenKey) === promise) inFlight.delete(tokenKey);
  });
}

export async function resolveSubscriptionProvider(config: ProviderConfig): Promise<ProviderConfig> {
  // A tokenKey means the credential lives in the OAuth token store rather than
  // on the config itself. That covers subscription tokens (Claude/ChatGPT,
  // auth 'subscription') and the API key OpenRouter's sign-in minted, which is
  // saved as auth 'apikey' because it bills per token, not per plan.
  if (config.auth !== 'subscription' && !config.tokenKey) return config;
  if (!config.tokenKey) {
    throw new Error('Provider is configured for subscription sign-in but has no token key. Sign in again in Settings.');
  }
  const accessToken = await ensureFreshToken(config.tokenKey);
  // Backfill the account id from the stored token set when the provider config
  // lacks one: the CLI-import path (e.g. ~/.codex/auth.json) records it on the
  // token, and the renderer never sees it to save on the config.
  const accountId = config.accountId ?? getToken(config.tokenKey)?.accountId;
  return { ...config, apiKey: accessToken, accountId };
}

export function signOut(tokenKey: string): void {
  deleteToken(tokenKey);
}

/** True when `tokenKey` belongs to a real subscription session (refreshes,
 * has limits to poll). OpenRouter keys are metered API keys. */
export function isSubscriptionToken(tokenKey: string): boolean {
  const provider = getToken(tokenKey)?.provider;
  return provider === 'claude' || provider === 'chatgpt';
}

export function getOAuthStatus(tokenKey: string): OAuthStatus {
  const tokenSet = getToken(tokenKey);
  return buildStatus(tokenKey, tokenSet, tokenSet ? 'success' : 'missing');
}

/** Parse a timestamp from a CLI credential file, which may be a number or an ISO string. */
function parseCliTimestamp(raw: unknown, now: number): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? now : ms;
  }
  return now;
}

/** The Claude CLI's credential file (`~/.claude/.credentials.json`) as a token set, if it holds one. Throws on bad JSON. */
export function claudeCliToken(raw: string, now: number): OAuthTokenSet | undefined {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const block = (parsed.claudeAiOauth as Record<string, unknown> | undefined) ?? parsed;
  const accessToken = (block.accessToken as string) ?? (block.access_token as string);
  if (!accessToken) return undefined;
  const scopesRaw = block.scopes;
  const scopes = Array.isArray(scopesRaw) ? scopesRaw.join(' ') : (scopesRaw as string | undefined);
  return {
    provider: 'claude',
    accessToken,
    refreshToken: (block.refreshToken as string) ?? (block.refresh_token as string),
    expiresAt: (block.expiresAt as number) ?? (block.expires_at as number),
    scopes,
    obtainedAt: now,
  };
}

/** The Codex CLI's auth file (`~/.codex/auth.json`) as a token set, if it holds one. Throws on bad JSON. */
export function codexCliToken(raw: string, now: number): OAuthTokenSet | undefined {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  if (!tokens?.access_token) return undefined;
  const accessToken = tokens.access_token as string;
  const refreshToken = tokens.refresh_token as string | undefined;
  const accountId = tokens.account_id as string | undefined;
  const accountEmail = typeof tokens.id_token === 'string' ? extractEmail(tokens.id_token) : undefined;
  const obtainedAt = parseCliTimestamp(parsed.last_refresh, now);
  const expiresAt =
    expFromJwt(accessToken) ??
    expFromJwt(tokens.id_token as string) ??
    obtainedAt + CHATGPT_CLI_TOKEN_TTL_MS;
  return { provider: 'chatgpt', accessToken, refreshToken, accountId, accountEmail, expiresAt, obtainedAt };
}

export function importCliAuth(): Record<OAuthProvider, boolean> {
  // OpenRouter has no first-party CLI with a credential file to import.
  const result: Record<OAuthProvider, boolean> = { claude: false, chatgpt: false, openrouter: false };

  const claudePath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(claudePath)) {
    try {
      const token = claudeCliToken(readFileSync(claudePath, 'utf8'), Date.now());
      if (token) {
        setToken('claude', token);
        result.claude = true;
      }
    } catch {
      /* malformed or unreadable credential file */
    }
  }

  const chatgptPath = join(homedir(), '.codex', 'auth.json');
  if (existsSync(chatgptPath)) {
    try {
      const token = codexCliToken(readFileSync(chatgptPath, 'utf8'), Date.now());
      if (token) {
        setToken('chatgpt', token);
        result.chatgpt = true;
      }
    } catch {
      /* malformed or unreadable auth file */
    }
  }

  return result;
}
