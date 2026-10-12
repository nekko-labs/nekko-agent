# Subscription sign-in

Nekko Agent can run chat turns on your existing Claude (Pro/Max) or ChatGPT (Plus/Pro/Business) subscription instead of a metered API key. The subscription path is optional: API keys remain available for Anthropic and OpenAI, and local model servers (Ollama, LM Studio, vLLM) still cost $0.

## How it works

The host-side OAuth service runs the sign-in flow:

1. **Claude** - We use the same public OAuth client that Claude Code uses. After you click "Sign in with Claude", the app opens a browser to `https://claude.com/cai/oauth/authorize` and starts a loopback listener on a local port. After you authorize, Anthropic redirects to the listener with an authorization code. The host exchanges that code for an access token and stores it.

2. **ChatGPT / Codex** - We use the public OAuth client that the Codex CLI uses. The app opens `https://auth.openai.com/oauth/authorize` and tries to listen on `http://localhost:1455/auth/callback` (the registered redirect for that client). After authorization, OpenAI returns an access token, a refresh token, and an `id_token`. The host decodes the `id_token` to extract your ChatGPT account id, which the backend requires.

The host keeps the actual access and refresh tokens in `tokens.json` inside the data directory. At chat time, the host resolves a fresh access token and injects it into the request. The renderer only ever sees a sanitized status object: connected, account id, token key, and expiry. It never sees or stores the token itself.

## Caveats

Both OAuth clients are the same first-party clients used by the vendors' own CLI tools. Anthropic and OpenAI consumer terms are written around their own apps, so using a subscription token with a third-party app like Nekko Agent is off-label. The flows may stop working at any time if the vendor rotates a client id, changes a scope, or blocks the client.

Because of this, the subscription paths are offered as-is alongside the API key options, which are unaffected. The features are live-validated on the current versions of the vendor flows. If a flow breaks, the fallback paths below still work.

## Fallbacks

If the browser loopback fails, for example because another process is already using the port, the app falls back to the manual paste path:

- **Claude** - Copy the `code#state` string the authorization page shows and paste it into the manual code input.
- **ChatGPT** - If port 1455 is busy, the app switches to manual mode and you copy the code from the page.

You can also import a sign-in you already did with an official CLI:

- **Claude** - `claude setup-token` mints a long-lived token. Paste that token as the manual code.
- **Codex CLI** - `codex login` writes `~/.codex/auth.json`. The app can read it and import the same token shape.

If a subscription session expires, the provider card shows the expiry and a "Re-authenticate" button to sign in again.

## Security

- Tokens are stored in `tokens.json` under the Nekko Agent data directory. The file is created with mode `0600` and the host re-applies that permission on startup.
- `tokens.json` is never included in a settings export. The export contains only provider configuration (base URL, label, and the opaque `tokenKey`), not the access or refresh tokens.
- The host never sends token values to the renderer. The renderer can only request status, sign out, or re-auth through the host.
- Removing a subscription provider also deletes its stored token from the host.
