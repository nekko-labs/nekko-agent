# Subscription Sign-In (Claude + ChatGPT) Implementation Plan

> **Historical only:** The Claude subscription approach in this plan was retired. Do not implement it or impersonate the first-party CLI; see the [current Claude policy](../../../spec/product/claude-policy.md).

**Goal:** Let users run Nekko Agent on their existing Claude (Pro/Max) or ChatGPT (Plus/Pro/Business) subscription instead of a metered API key, with a one-click browser sign-in; API keys remain available as the secondary path.

**Architecture:** A host-side OAuth service (`packages/host/src/oauth.ts`) runs the PKCE flow (browser authorize + loopback callback, with a paste-the-code fallback for headless/remote). Token sets live in `tokens.json` in the data dir, written with `writeJsonAtomic` (0600). Providers stay pure: the host resolves a fresh access token at chat time and injects it, so `packages/core` never owns refresh state. Claude subscription reuses `AnthropicProvider` with a different auth header + beta flag; ChatGPT subscription is a new `ChatGptProvider` speaking the OpenAI Responses API (different wire format than chat completions).

**Tech Stack:** TypeScript, `node:crypto` + WebCrypto (PKCE), `node:http` loopback listener (no deps), existing `parseSSE`, `writeJsonAtomic` secure file store.

---

## Background / verified endpoint facts (researched 2026-09-08)

**Claude (Anthropic) subscription OAuth** — same public client Claude Code uses:
- Authorize: `https://claude.ai/oauth/authorize` (subscription accounts) or `https://console.anthropic.com/oauth/authorize`
- Token exchange: `https://console.anthropic.com/v1/oauth/token` — **JSON body, not form-urlencoded**
- `client_id`: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Scopes: `org:create_api_key user:profile user:inference`
- PKCE: S256. **Quirk: `state` must equal the PKCE verifier** (not a random nonce).
- Redirect: loopback `http://localhost:<port>/callback` works for this client (try a port range); the manual fallback is `redirect_uri=https://console.anthropic.com/oauth/code/callback`, which renders a `code#state` string the user pastes back.
- The former direct subscription API path is obsolete. Use the current, unmodified Claude Code integration for plan access.
- Refresh: same token endpoint, `grant_type: 'refresh_token'` (JSON).
- Long-lived token path: `claude setup-token` in the Claude Code CLI mints a durable token the user can paste.

**ChatGPT (OpenAI Codex) subscription OAuth** — same public client Codex uses:
- Authorize: `https://auth.openai.com/oauth/authorize`
- Token: `https://auth.openai.com/oauth/token`
- `client_id`: `app_EMoamEEZ73f0CkXaXp7hrann` (public Codex client; verify at implementation time — OpenAI rotates these occasionally)
- Registered redirect: `http://localhost:1455/auth/callback` — **fixed port**. If 1455 is taken, offer the fallbacks below.
- Scopes: `openid profile email offline_access`
- Token response: `{ id_token, access_token, refresh_token }`. The **account id** comes from the `id_token` JWT claim `https://api.openai.com/auth` → `chatgpt_account_id` (base64url-decode the payload, no signature verification needed for our use).
- API: `POST https://chatgpt.com/backend-api/codex/responses` (Responses API, SSE). Required headers: `Authorization: Bearer <access>`, `chatgpt-account-id: <accountId>`, `OpenAI-Beta: responses=experimental`, `originator: codex_cli_rs` (or our own; Codex sends `codex_cli_rs`), `session_id: <uuid>` per conversation.
- Refresh: `grant_type=refresh_token` at the same endpoint.
- Headless fallback: **import an existing login** — `codex login` writes `~/.codex/auth.json` with the same token shape (`tokens.access_token`, `tokens.refresh_token`, `tokens.account_id`, `last_refresh`). Reading it gives a zero-browser path.
- Device code: OpenAI ships device-code auth (beta) for headless; optional stretch.

**Honest caveat (must ship in docs/UI copy):** both flows ride the vendor's own first-party CLI OAuth client. Anthropic and OpenAI consumer terms are written around their own apps; third-party use is off-label and can stop working at any time. The subscription path is offered as-is alongside API keys, which are unaffected. SPEC.md must say this plainly.

## File Structure

- Create: `packages/shared/src/oauth.ts` — `OAuthProvider`, `OAuthTokenSet`, `OAuthSessionInfo`, channel constants.
- Modify: `packages/shared/src/models.ts` — `ProviderKind` += `'chatgpt'`; `ProviderConfig` += `auth?: 'apikey' | 'subscription'`, `accountId?: string`, `tokenKey?: string`; `PROVIDER_DEFAULTS` entry for `chatgpt`.
- Modify: `packages/shared/src/settings.ts` — nothing needed (providers already persist); confirm `tokens.json` never lands in settings export/import (it should be excluded or flagged).
- Modify: `packages/shared/src/ipc.ts` — `oauth:*` channel names + `NekkoApi` methods.
- Create: `packages/host/src/oauth.ts` — PKCE, loopback listener, exchange, refresh, token store, CLI-import readers.
- Modify: `packages/host/src/host.ts`, `dispatch.ts` — five-touch wiring.
- Modify: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/web-client.ts` — five-touch wiring (client methods only; the flow itself runs host-side).
- `AnthropicProvider` direct subscription mode: retired; do not restore.
- Create: `packages/core/src/providers/chatgpt.ts` — Responses API provider.
- Modify: `packages/core/src/providers/index.ts` — construct by kind/auth.
- Modify: `packages/host/src/chat.ts` (or wherever providers are instantiated) — resolve `tokenKey` → fresh access token before each run; trigger refresh on 401 once.
- Create: `apps/desktop/src/renderer/components/SubscriptionSignIn.tsx` — shared sign-in card (used by Models page + onboarding).
- Modify: `apps/desktop/src/renderer/views/ModelsView.tsx` — subscription-first CTAs; provider cards show "Subscription" badge, account, Sign out / Re-auth.
- Modify: `packages/host/src/store.ts` — exclude `tokens.json` from settings export; never echo token values into any channel payload.
- Tests: `packages/host/src/oauth.test.ts` (PKCE shape, state=verifier rule, token store round-trip, refresh grant body, code#state parsing), `packages/core/src/providers/chatgpt.test.ts` (message mapping, SSE event → ProviderChunk).

## Key code sketches (authoritative shapes; fill bodies at implementation)

```ts
// packages/shared/src/oauth.ts
export type OAuthProvider = 'claude' | 'chatgpt';
export interface OAuthTokenSet {
  provider: OAuthProvider;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;      // epoch ms
  accountId?: string;      // chatgpt_account_id
  scopes?: string;
  obtainedAt: number;
}
export interface OAuthSessionInfo {
  id: string;
  provider: OAuthProvider;
  authUrl: string;
  /** 'loopback' waits for the local callback; 'manual' needs finishOAuth(code). */
  mode: 'loopback' | 'manual';
  expiresAt: number;
}
```

```ts
// ChatGptProvider.chat() request shape (Responses API)
{
  model: req.model,
  instructions: req.system,
  input: toResponseItems(req.messages), // user → input_text, assistant → output_text,
                                        // tool results → function_call_output
  tools: req.tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
  stream: true,
  store: false,
}
// SSE: 'response.output_text.delta' → {type:'text'}; 'response.reasoning_summary_text.delta'
// → {type:'reasoning'}; item done with type 'function_call' → {type:'tool_call'};
// 'response.completed' → usage + done.
```

## Tasks

### PR 1 — `feat/oauth-core` (foundation, no UI)

- [ ] **T1: shared OAuth types + IPC contract**
  - Create `packages/shared/src/oauth.ts` (types above).
  - `packages/shared/src/ipc.ts`: channels `oauth:begin`, `oauth:finish`, `oauth:cancel`, `oauth:status`, `oauth:signout`, `providers:importCliAuth`; `NekkoApi` methods `oauthBegin(provider)`, `oauthFinish(sessionId, code)`, `oauthCancel(sessionId)`, `oauthStatus(provider)`, `oauthSignOut(providerConfigId)`, `importCliAuth()` → which CLIs had credentials found.
  - Extend `ProviderConfig` (`auth`, `tokenKey`, `accountId`) and add `'chatgpt'` kind + `PROVIDER_DEFAULTS` entry (`baseUrl: 'https://chatgpt.com/backend-api'`, `needsKey: false`, label `'ChatGPT (subscription)'`).

- [ ] **T2: host OAuth service**
  - `packages/host/src/oauth.ts`:
    - `pkcePair()` via `node:crypto` `randomBytes` + `createHash('sha256')` base64url (no dep).
    - `beginOAuth(provider)` → starts `node:http` loopback server (Claude: probe a small port range e.g. 8765-8795; ChatGPT: must try `1455` first — on `EADDRINUSE` mark the session `manual` and return the URL anyway for the paste path) → build authorize URL (Claude: `state` = verifier; ChatGPT: random `state`, verify on callback) → return `{ sessionId, authUrl, mode }`.
    - Callback handler validates state, exchanges code (Claude: JSON POST; ChatGPT: JSON POST `grant_type=authorization_code`), decodes `id_token` for `chatgpt_account_id`, writes `tokens.json` via `writeJsonAtomic`, emits `oauthStatus` on the host event bus, closes the listener.
    - `finishOAuth(sessionId, pasted)` — accepts `code`, `code#state`, or a full redirect URL; extracts and exchanges.
    - `ensureFreshToken(tokenKey)` — refresh when `expiresAt - 60_000 < Date.now()`; single-flight per key.
    - `importCliAuth()` — read `~/.claude/.credentials.json` (Claude Code's store) and `~/.codex/auth.json`; return what was found without echoing secrets; caller converts into a provider + token record.
  - Wire `host.ts` + `dispatch.ts` + `preload/index.ts` + `web-client.ts` (five-touch).
  - `oauth.test.ts`: PKCE verifier/challenge shape, `state === verifier` in the Claude URL, `code#state` parse, token-store round-trip, refresh request body.

- [ ] **T3: token injection at chat time**
  - Wherever `chat.ts` builds a provider from `ProviderConfig`, if `auth === 'subscription'`: `config.apiKey = await ensureFreshToken(config.tokenKey)`; on a `401` retry once after a forced refresh, then surface "subscription session expired, sign in again."
  - Exclude `tokens.json` from settings export; `settings:export` stays token-free.

- [ ] **T4: verify + commit** — `npm run build`, typecheck all workspaces, tests green. Commit `feat(oauth): PKCE core + token store`.

### PR 2 — `feat/claude-signin`

- **T5: Historical AnthropicProvider subscription mode** — retired; do not implement.
- [ ] **T6: `SubscriptionSignIn.tsx`** — card: "Sign in with Claude" button → `oauthBegin('claude')` → open `authUrl` (desktop `shell.openExternal`; web `window.open`) → waiting state → on `oauthStatus` event, create the `anthropic` provider with `auth:'subscription'`, `tokenKey`, `accountId` (email from `user:profile` if returned) → test + persist. Paste-code fallback input wired to `oauthFinish`. "Paste a setup token instead" link (`claude setup-token` output accepted directly as a long-lived access token).
- [ ] **T7: Models page integration** — in the add-provider flow, picking Anthropic shows the subscription CTA first with "Use an API key instead" as the secondary disclosure; connected card shows Subscription badge + account + Sign out (`oauth:signout` clears token + provider or demotes to apikey-less).
- [ ] **T8: verify + commit.**

### PR 3 — `feat/chatgpt-signin`

- [ ] **T9: `ChatGptProvider`** — Responses API mapping per sketch; `listModels()` returns the current ChatGPT-plan model set (ship a curated constant list, e.g. gpt-5.x + codex variants, plus a free-text model override in the provider's settings); `test()` = a 1-token `responses` ping or a models probe.
- [ ] **T10: sign-in UI** — same `SubscriptionSignIn` with `provider='chatgpt'`; loopback on 1455, `EADDRINUSE` → manual instructions + **Import from Codex CLI** (`providers:importCliAuth` → `~/.codex/auth.json`).
- [ ] **T11: verify + commit** — add `chatgpt.test.ts` covering message/tool mapping + SSE event parsing.

### PR 4 — `feat/subscription-ux` (polish, can fold into PR 2/3 if small)

- [ ] **T12:** subscription-first copy across the provider surfaces: when adding any Anthropic/OpenAI provider, the subscription sign-in is the primary button and the API key the quiet alternative ("no API usage fees" vs "billed per token"). Provider cards badge `Subscription` vs `API key`; usage/cost panels show $0 + "subscription" label for these providers.
- [ ] **T13:** Settings re-auth/sign-out row; expiry note. Docs: `docs/SUBSCRIPTIONS.md` (how it works, the caveat, fallbacks, security: tokens in `tokens.json` 0600, never exported).

## Self-review notes

- Spec coverage: sign-in (T2/T6/T10), API key fallback (existing + T7/T12), "encourage subscription" (T7/T12), easy flow (loopback + paste + CLI import).
- Type consistency: `OAuthProvider`/`OAuthTokenSet`/`tokenKey` used identically in shared, host, and UI tasks.
- Non-goals: no enterprise SSO custom clients; no storing tokens in settings export; no streaming of secrets into chat context.
