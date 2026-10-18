# Nekko Agent, Web, Docker & Hosted Editions (Spec)

> Added 2026-06-20. Expands the canonical [master-build-prompt.md](master-build-prompt.md) with three new pillars requested by Philip:
> 1. An **offline Local Web UI** that runs the *same code* as the native app via one npm command or `docker compose`.
> 2. A **paid hosted edition** ("Nekko Cloud") with subscriptions, an always-available **Zero Data Retention (ZDR)** option, cloud-hosted chat history + file management, and **phone connectivity to your locally-running model**.
> 3. **Positioning**: real on-device + codebase usability (vs LM Studio's chat-only experience) with IDE-like file viewing/editing (vs terminal-only CLIs).

This is a planning/spec document. Implementation lands in phases (see [Build plan](#build-plan--phases)).

---

## 1. Editions overview

| | **Desktop** (today) | **Self-hosted web** | **Docker** | **Nekko Cloud** (paid) |
|---|---|---|---|---|
| Runtime | Electron | Node server + browser | Node server in a container | Managed multi-tenant service |
| Install | installer / `npm run dev` | `npx nekko-agent` or `npm run web` | `docker compose up` | sign in at app.nekkoagent.com |
| Runs your code & files | ✅ local FS | ✅ local FS | ✅ mounted volume | ✅ via paired local agent |
| Local models | ✅ | ✅ | ✅ (host network) | ✅ via secure relay |
| Cost | free, OSS | free, OSS | free, OSS | subscription |
| Chat history / files | local disk | local disk | container volume | cloud-synced, encrypted |
| Phone access |, | LAN only | LAN only | ✅ from anywhere |
| Data retention | local only | local only | local only | **ZDR option always on offer** |

**One promise across all of them:** the engine (`@nekko-agent/core`) and the entire React UI are identical. Only the *host transport* differs.

---

## 2. Principle: one codebase, three runtimes

### 2.1 Where we are
- `packages/core`, pure engine (providers, agent loop, guardrails, context, indexer, memory, connectors). Already transport-agnostic. ✅
- `apps/desktop/src/main/*`, **host services** (settings store, sessions, chat orchestrator, sandboxed tool executor, workspace indexer, memory store, usage log, connector fetch) currently live here and are wired to the renderer through Electron IPC (`ipc.ts` + `preload`).
- `apps/desktop/src/renderer/*`, React UI that calls `window.nekko.*` (the `NekkoApi` contract in `@nekko-agent/shared`).

### 2.2 The refactor: extract `packages/host`
Move the service logic out of `apps/desktop/src/main` into a new transport-agnostic **`packages/host`**:

```
packages/host/        // Node-only, no Electron, no HTTP, just services + a Host facade
  services/           // settings, sessions, chat, tools, workspace, memory, usage, connectors
  host.ts             // createHost(opts) → an object implementing every NekkoApi method
                      // + an event emitter for AgentEvent / IndexProgress
  storage.ts          // pluggable persistence (local FS today; cloud adapter for Cloud)
```

`createHost()` returns one object whose methods are exactly the `NekkoApi` surface (minus the `on*` subscriptions, which become an EventEmitter). Every edition wraps the same `Host`:

- **Electron** (`apps/desktop/src/main`): `ipcMain.handle(channel, (e,...args) => host[method](...args))`; forwards `host.on('agentEvent', …)` to `webContents.send`. (This is a thin rewrite of today's `ipc.ts`.)
- **Web server** (`apps/local-web-ui`): one HTTP route per request method + a WebSocket for streamed events. (Details in §3.)

### 2.3 Renderer transport adapter
The renderer must get `window.nekko` regardless of runtime. Introduce a tiny bootstrap that picks an adapter:

- **Electron**: the existing `preload` exposes `window.nekko` (unchanged).
- **Web**: a bundled `web-client.ts` defines `window.nekko` where each method is a `fetch('/api/<channel>', {body})` call, and `onAgentEvent` / `onIndexProgress` subscribe to a WebSocket (or SSE). It is API-compatible with `NekkoApi`, so **no view code changes**.

Selection is by build target / presence of the preload bridge: `window.nekko ??= makeWebClient()`.

### 2.4 Net effect
`@nekko-agent/core` + `apps/desktop/src/renderer` are shared verbatim. New code is: `packages/host` (mostly moved), `apps/local-web-ui` (new, thin), and `renderer/web-client.ts` (new, thin). The desktop `main` shrinks to a host wiring file.

---

## 3. Self-hosted Local Web UI

### 3.1 One command
`apps/local-web-ui` is a small Fastify (or Express) app that:
1. Calls `createHost()` (local FS storage, same data dir as desktop so they can share state).
2. Mounts `POST /api/:channel` → `host[method](...args)` (validated against the IPC contract).
3. Exposes `GET /api/events` (WebSocket) streaming `AgentEvent` + `IndexProgress`.
4. Serves the built renderer (`apps/desktop` renderer output, or a shared `packages/renderer`) as static files.
5. Opens the default browser at `http://localhost:1440`.

Run paths:
- `npx nekko-agent` (published bin) → downloads + starts the server.
- In-repo: `npm run web` → builds renderer + core + host, starts `apps/local-web-ui`.
- The server is **offline-first**: it makes no outbound calls except to the model servers and connectors the user configures.

### 3.2 Docker
Ship a `Dockerfile` + `docker-compose.yml`:

```yaml
services:
  nekko-agent:
    image: ghcr.io/nekko-labs/nekko-agent:latest    # or build: .
    ports: ["1440:1440"]
    volumes:
      - ./workspace:/workspace                # codebases the agent may touch
      - nekko-agent-data:/data                      # settings, sessions, memory, usage
    environment:
      - NEKKO_SANDBOX=workspace-jail
      - NEKKO_DATA_DIR=/data
    extra_hosts: ["host.docker.internal:host-gateway"]   # reach a model server on the host
volumes: { nekko-agent-data: {} }
```

- Workspaces map to mounted volumes; the **workspace-jail sandbox** confines tool file access to `/workspace`.
- Local models on the host are reachable at `http://host.docker.internal:<port>`; the base-URL field accepts that directly.

### 3.3 Security for the Local Web UI
The web server grants file + shell access to whoever can reach it. Therefore:
- **Bind to `127.0.0.1` by default.** Exposing on `0.0.0.0`/LAN requires `--host` **and** a generated access token (printed once, required as a `Authorization` header / `?token=`).
- Guardrails + sandbox modes apply identically (they live in the host, not the UI).
- Docker image runs as a non-root user; shell tool honors the same guardrail policy.
- A prominent banner when bound beyond localhost.

---

## 4. Nekko Cloud (paid, hosted)

> **Engine shape, decided 2026-10-13 (Philip):** when the TS engine is retired (PF14), Cloud runs on **one shared, multi-tenant `nekkod`**, not a daemon per account; per-account daemons stay an option if isolation or load ever demands them. Today Cloud still runs one in-process TS host per account. See PF14 step 4 in [TASKS.md](TASKS.md).

The managed edition. Everything the OSS app does, plus convenience that only a hosted service can provide, without giving up local execution or privacy.

### 4.1 What it adds over self-hosting
1. **Zero-setup access** from any browser at `app.nekkoagent.com`.
2. **Cloud chat history**: sessions sync across devices, encrypted at rest.
3. **Cloud file management**: a cloud workspace (upload/organize/version files) alongside your local ones.
4. **Phone connectivity to your local model**: use your phone to drive the model running on your home/office machine, from anywhere (§4.5). This is the headline cloud feature.
5. **ZDR guarantee**: an always-available zero-data-retention mode (§4.4).
6. Managed connectors (OAuth apps pre-registered for Gmail/Drive/Slack/etc., so users don't register their own).

> Local execution stays local. Cloud never runs your shell/filesystem tools on our servers, those always execute on *your* paired machine (desktop or self-hosted agent). The cloud is a sync + relay + billing layer.

### 4.2 Accounts & auth
- Email + OAuth (Google/GitHub) sign-in. Sessions via short-lived JWT + refresh token.
- Org/team accounts (post-MVP) for shared connectors and seats.
- Device pairing tokens link a local agent to an account (§4.5).

### 4.3 Payments & plans (Stripe), implemented
- **Stripe Checkout** for subscription start; **Stripe Customer Portal** for management; **webhooks** drive entitlement state (`active`, `past_due`, `canceled`).
- Entitlements gate cloud-only features (sync, relay, managed connectors). The OSS app never checks a license, paid features are server-side only.
- **Implementation** (`apps/nekko-agent-api/cloud/src/billing.ts`): hand-rolled against the Stripe REST API (no SDK dependency), gated on `STRIPE_SECRET_KEY` so the server runs without a Stripe account. `/api/billing/checkout` opens a Checkout Session for the chosen plan's price; `/api/billing/portal` opens the Customer Portal; `/api/billing/webhook` verifies the `Stripe-Signature` (HMAC-SHA256 over `${t}.${body}`, with a replay-window check) and applies plan changes via `store.setPlan` (`checkout.session.completed` and `customer.subscription.updated|deleted`). The account remembers its `stripeCustomerId` so subscription events map back to it. Requires keys to bill for real: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `CLOUD_PUBLIC_URL`.
- Plans (draft, see §6): Free (OSS, BYO everything), Pro (individual), Team.
- Free trial of Pro; annual discount.

### 4.4 Zero Data Retention (ZDR), always on offer
A first-class, always-available mode (not an enterprise-only afterthought):
- **Definition**: with ZDR enabled, the platform does **not** persist prompt/response content or file contents. Only minimal operational metadata needed for billing (token counts, timestamps, model id) and routing is stored; message bodies are processed in-memory and dropped.
- **Model providers**: Cloud only routes to provider endpoints/configurations that themselves honor ZDR (e.g., your local model via relay, which never leaves your machine, or provider ZDR tiers). The UI shows a per-provider ZDR badge.
- **Default vs opt-in**: ZDR is **always available on every plan**; users choose retention (for cloud history) vs ZDR (no retention) per workspace. Using your **local model via the relay is inherently ZDR** for inference (content never touches our servers in cleartext, see §4.5 transport).
- **Verifiability**: published data-flow diagram; retention settings visible in-app; audit log of what was/wasn't stored.

### 4.5 Phone connectivity to your local model (the relay)
Goal: open Nekko Agent on your phone, talk to the LLM running on your home machine, securely, through NAT, without port-forwarding.

```
[ Phone / browser ]  --TLS-->  [ Nekko Cloud relay ]  <--outbound WSS--  [ Local agent on your machine ]
       (Cloud web UI)              (auth + routing,            (desktop app or `nekko-agent agent`;
                                    no plaintext storage)        holds the model + tools + files)
```

- **Local agent**: the desktop app (or a headless `nekko-agent agent` / the self-hosted server) opens a persistent **outbound** WSS connection to the relay and registers under the user's account with a device pairing token. No inbound ports.
- **Relay**: authenticates both ends, matches a phone session to the right agent, and forwards an encrypted channel. The relay is a dumb pipe for inference/tool traffic.
- **End-to-end encryption**: agent↔client traffic is encrypted with keys established at pairing (relay sees ciphertext for message bodies). This is what makes relayed local-model use **inherently ZDR**.
- **What runs where**: inference runs on the local machine's model server; tool calls (read/edit files, run commands, index) execute on the local machine under its guardrails/sandbox. The phone is a thin client.
- **Pairing UX**: desktop shows a QR / 6-digit code; phone scans/enters it; a device appears in the account and can be revoked anytime.
- **Offline/degraded**: if the agent is offline, the phone shows it as unreachable and can fall back to a cloud-configured provider (subject to ZDR choice).

### 4.6 Data model & sync
- Cloud-synced entities: sessions (chat history), memory entries, workspace metadata, cloud files, connector configs (tokens encrypted with a per-user KMS key).
- **CRDT/last-write-wins** sync between local agent and cloud for sessions + memory so desktop and phone stay consistent.
- ZDR workspaces sync metadata only (titles, timestamps), never bodies.
- Encryption at rest (provider KMS); per-user encryption keys; secrets (connector tokens, model keys) encrypted client-side where possible.

---

## 5. Positioning & messaging

Capture these on the website + README.

### 5.1 vs LM Studio (and Ollama UIs)
> **LM Studio runs models. Nekko Agent runs *with your work*.**
- LM Studio / most local UIs are **chat-only**, a great model runner with a chat box, but no awareness of your files or projects.
- Nekko Agent **reads, edits, searches, and runs** in your actual codebases: multi-folder index, file viewer + inline editing, tool-using agent, per-project memory, guardrails. Same easy local-model setup, but the model can *do the work*, not just talk about it.

### 5.2 vs terminal CLIs (Claude Code, aider, etc.)
> **The power of an agentic CLI, with eyes.**
- Terminal agents are powerful but blind, you can't *see* what changed without `git diff`, and editing means leaving the tool.
- Nekko Agent gives an **IDE-like surface**: browse the indexed file tree, view files, see diffs, and edit inline, while the agent works alongside you. Approvals and the Context Inspector make every action visible.

### 5.3 Messaging pillars
1. **Local-first, truly usable**: your models + your files, on your machine.
2. **See everything**: Context Inspector shows exactly what the model gets; IDE-like file viewing/editing; guardrails on risky commands.
3. **Runs anywhere, same app**: native, one-command web, Docker, or hosted.
4. **Private by design**: offline OSS editions; Cloud offers an always-available ZDR mode and relays to *your* local model so inference content never leaves your machine.
5. **Your phone, your home model**: drive your local LLM from anywhere (Cloud).

---

## 6. Pricing (draft, for discussion)

| Plan | Price (draft) | For | Includes |
|---|---|---|---|
| **Free / OSS** | $0 | everyone | Desktop, self-hosted web, Docker; all local features; BYO model keys |
| **Pro** | ~$12/mo (or ~$108/yr) | individuals | Cloud history sync, cloud files, **phone↔local-model relay**, managed connectors, ZDR mode |
| **Team** | ~$20/seat/mo | teams | Pro + shared connectors, org SSO, seats, admin/audit |

Numbers are placeholders pending cost modeling (relay bandwidth, storage). ZDR is available on **all** paid plans, not gated to Team.

**Relay passthrough decision (2026-07-22, T100)**: self-hosting the relay is free forever and first-class (one Docker command, `ghcr.io/nekko-labs/nekko-agent-relay`; Compose/Coolify/Fly recipes in docs/REMOTE.md). The **managed relay** (`nekko-agent-relay.fly.dev`) runs free during beta with per-connection rate limits; at Cloud launch it becomes part of the paid plans by pointing `NEKKO_RELAY_AUTHZ_URL` at the cloud's `/api/relay/authorize` (already implemented; checks the account and returns the plan's `maxDevices`). Rationale: the relay only routes ciphertext, so managed hosting is a low-liability bandwidth cost that maps cleanly to a subscription, while self-hosting preserves the open-source promise.

---

## 7. Build plan / phases

Phase ordering keeps the OSS app shippable throughout.

- [ ] **P2.1, Host extraction**: move `apps/desktop/src/main` services into `packages/host`; rewrite desktop `main` as thin IPC wiring over `createHost()`. No user-visible change; keep build + tests green.
- [ ] **P2.2, Web server**: `apps/local-web-ui` (Fastify) mapping the IPC contract to HTTP + WS; `renderer/web-client.ts` adapter; `npm run web`; localhost bind + token for non-local.
- [ ] **P2.3, Docker**: `Dockerfile`, `docker-compose.yml`, `host.docker.internal` model access, volume-mounted workspaces, non-root, published image via CI.
- [ ] **P2.4, Packaging/publish**: `npx nekko-agent` bin; website download/run section updated; docs.
- [ ] **P3.1, Cloud foundation**: accounts/auth, Postgres, entitlements, app.nekkoagent.com shell reusing the same renderer with a cloud transport.
- [x] **P3.2, Payments**: Stripe Checkout + Portal + signature-verified webhooks → `store.setPlan`; entitlement gating (already existed). Gated on `STRIPE_SECRET_KEY`; live charges need keys. See §4.3.
- [ ] **P3.3, ZDR + cloud history/files**: retention modes, encrypted storage, sync engine, ZDR badges + audit.
- [x] **P3.4, Relay + phone**: DONE (T100). Relay v2 (per-device cids, unicast, kick, limits, optional cloud authz gate), agent-side device registry with 10-min single-use pairing codes + rename/revoke/rotate, HELLO handshake over the E2E channel, phone bottom-nav, per-device push tokens, managed relay live at `wss://nekko-agent-relay.fly.dev`, self-host image `ghcr.io/nekko-labs/nekko-agent-relay`. Notably the device registry lives on the AGENT, so revocation shipped without the Cloud account model; the cloud's `/api/relay/authorize` gate exists for making the managed relay a paid perk at launch. See docs/REMOTE.md.
- [ ] **P3.5, Managed connectors**: pre-registered OAuth apps for Gmail/Drive/Slack/Discord.

## 8. Open questions
- Hosting/runtime for Cloud (Fly.io / Render / AWS?) and relay scaling model.
- E2E key management UX (recovery vs zero-knowledge trade-offs).
- Mobile: PWA first, or native shells later?
- Exact ZDR boundary for cloud-configured (non-local) providers without ZDR tiers, likely "not allowed in ZDR workspaces."
- Do desktop + local web share one data dir by default, or separate? (Lean: share, so the web UI sees your desktop sessions.)
