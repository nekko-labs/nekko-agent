# Subscription sign-in

Nekko Agent can run chat turns on your existing ChatGPT (Plus/Pro/Business) subscription instead of a metered API key, and can mint an OpenRouter API key for you through OpenRouter's own sign-in. Both are optional: API keys remain available for Anthropic, OpenAI and OpenRouter, and local model servers (Ollama, LM Studio, vLLM) still cost $0.

## Claude

Nekko Agent does not sign in to Claude plans (Free, Pro or Max). Anthropic's terms do not let third-party apps offer Claude.ai login, send requests on Claude plan credentials, or collect Claude credentials, so Nekko Agent does none of these. Earlier builds did; on its first start after the update, Nekko Agent deletes any saved Claude sign-in from this computer, turns off the providers that used one, and shows a one-time notice. Your chats are kept.

To use Claude in Nekko Agent:

- **Claude with an API key** - Add an Anthropic provider with your own Console API key. Every Nekko Agent feature works, billed per token to your Anthropic account.
- **Claude Agent** (coming with the same release) - Nekko Agent runs the Claude Code you already have installed. You sign in inside Claude Code itself, with your plan, an API key or a cloud account; Nekko Agent never sees that sign-in and never reads Claude Code's credentials.

## How it works

The OAuth service in the engine daemon (`crates/nekkod/src/oauth.rs`) runs the sign-in flow:

1. **ChatGPT / Codex** - We use the public OAuth client that the Codex CLI uses. The app opens `https://auth.openai.com/oauth/authorize` and tries to listen on `http://localhost:1455/auth/callback` (the registered redirect for that client). After authorization, OpenAI returns an access token, a refresh token, and an `id_token`. The daemon decodes the `id_token` to extract your ChatGPT account id, which the backend requires.

2. **OpenRouter** - OpenRouter's PKCE flow listens on any free local port. After you approve, OpenRouter hands back an API key created for this app, billed to your OpenRouter balance.

The daemon keeps the actual tokens in `tokens.json` inside the data directory. At chat time, it resolves a fresh access token and injects it into the request. The renderer only ever sees a sanitized status object: connected, account id, token key, and expiry. It never sees or stores the token itself.

## More than one account

You can sign in more than one ChatGPT plan, for example a personal plan and a work one. Each gets its own provider, its own token and its own usage limits. To tell them apart, the app shows the email each one is signed in as next to its name, as in `ChatGPT · you@example.com`, in the model picker, the Utilization panel and the Capacity list.

The email comes from the ChatGPT `id_token`, stays in `tokens.json` next to the token, and is not part of a settings export. A plan signed in before this was added shows no email until you sign it in again. API keys and OpenRouter keys carry no email, so they show just the provider name.

## Caveats

The ChatGPT OAuth client is the same first-party client the Codex CLI uses. OpenAI's consumer terms are written around its own apps, so the flow may stop working at any time if OpenAI rotates the client id, changes a scope, or blocks the client. The API-key options are unaffected.

## Fallbacks

If port 1455 is busy, the ChatGPT sign-in switches to manual mode: after you authorize, copy the address the browser lands on and paste it into the app.

You can also import a sign-in you already did with the Codex CLI: `codex login` writes `~/.codex/auth.json`, and the app can read it and import the same token shape.

If a subscription session expires, the provider card shows the expiry and a "Re-authenticate" button to sign in again.

## Security

- Tokens are stored in `tokens.json` under the Nekko Agent data directory. The file is created with mode `0600` and the permission is re-applied on startup.
- `tokens.json` is never included in a settings export. The export contains only provider configuration (base URL, label, and the opaque `tokenKey`), not the access or refresh tokens.
- The renderer never receives token values. It can only request status, sign out, or re-auth.
- Removing a subscription provider also deletes its stored token.
- A CI check (`scripts/check-claude-compliance.mjs`) fails the build if Claude sign-in, Claude credential reading or Claude plan limits come back.
