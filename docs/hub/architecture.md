# Architecture

Nekko Agent is one engine and one React UI that run in several places: the desktop app, the self-hosted Local Web UI, Docker and the phone. This page is a map of the code for contributors. The full technical plan, with every decision and task, is in [`TASKS.md`](../../TASKS.md); what the product does and why is in [`spec/`](../../spec/README.md), one file per feature.

## The big picture

```text
 desktop window (Electron + React)        browser (Local Web UI, Docker)
            |                                        |
            |  IPC                          HTTP + WebSocket
            v                                        v
       apps/desktop main                  apps/local-web-ui
            \                                        /
             \----------- nekkod (Rust) ------------/
                     engine daemon on loopback
                       /                  \
             engine services          model servers
             (chat, tools,            (llama-server,
              terminals, ...)          routed)
```

- **The UI never shares a process with the agent.** The window talks to `nekkod`, the engine daemon, over a loopback connection with a per-launch token. The agent loop, terminals and model servers run there, so a busy agent cannot freeze the interface.
- **The engine is all Rust.** `nekkod` answers every engine channel itself. It was ported from a TypeScript engine (`packages/host`, `packages/core`, deleted 2026-10-19); the golden fixtures under `crates/*/tests/golden` are frozen records of that engine's behaviour ([docs/runbooks/golden-fixtures.md](../runbooks/golden-fixtures.md)).
- **Every edition is the same app.** Desktop, web and Docker run the same engine and the same UI. Only the transport differs: Electron IPC on the desktop, HTTP and WebSocket in the browser.

## Desktop lifetime and notifications

Closing the UI already hides it to the tray without stopping the engine. Explicit Quit shuts down the service and managed processes; Stop Nekko service stops the engine without quitting the UI. Neither arrangement promises continued work during OS sleep, shutdown or logout.

The 2026-10-13 implementation moves Electron native notifications into main (`apps/desktop/src/main/notifications.ts`), with a direct authenticated engine WebSocket subscription, fresh settings reads per eligible notice, reconnect/backoff and disposal on Quit. Main creates native notices; click delivery uses an encoded session deep link to restore the window and select the chat. Renderer notifications remain for browser editions only, avoiding duplicate Electron delivery. Settings exposes the default-on toggle in its standalone Notifications section.

The engine's usage summaries emit per-day session costs, local tokens, avoided costs and model ids. Budget aggregates those UTC buckets for every recorded detail instead of mixing a range with lifetime totals. Utilization's same-token Claude dedupe is display-only and prefers Anthropic, without changing provider routing or storage.

Status: implemented, unit and isolated fixture interaction tested; image/motion inspection and native toast delivery/click/permissions testing pending. Main currently assumes events are unattended, so focused-visible-chat suppression is a known review issue. Parent owns resolution and landing.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Types and IPC contracts. Pure, no runtime dependencies. |
| `packages/profile` | The user's data folder on this machine: where it lives, moving it, older installs' profiles, and the running app. Used by the desktop's main process, the CLI and the Local Web UI. |
| `apps/desktop` | The Electron app: `src/main` (Node), `src/preload` (the bridge) and `src/renderer` (React). |
| `apps/local-web-ui` | The self-hosted Local Web UI, also the `npx nekko-agent-local-web-ui` package. |
| `apps/cli` | The `nekko-agent` CLI and MCP server. |
| `apps/mobile` | The iOS and Android app (Expo). |
| `apps/relay-server` | The relay that pairs a phone with a computer. It only ever sees encrypted frames. |
| `apps/nekko-agent-api` | Nekko Cloud's API: signups, accounts, encrypted sync. The only part of the project that needs a database. |
| `apps/website` | nekkoagent.com, including these docs. |
| `crates/nekkod` | The engine daemon. |
| `crates/nekko-*` | The daemon's services: chat turns, tools, terminals, inference, remote access, storage, usage and more. |

## Where data lives

Nekko Agent is local-first. Everything you can run yourself works without a database; Postgres is only behind the hosted Nekko Cloud API.

```text
 your computer                              Nekko Cloud (hosted, optional)
 ---------------------------------          ------------------------------------
 desktop / Local Web UI / Docker            apps/relay-server   (stateless,
   nekkod + TS host                           routes encrypted frames only)
   chats: <data>/sessions/<id>.json
   settings, memory, models: files    --->  apps/nekko-agent-api (Fastify, Fly.io)
   in the local data directory     E2EE         |
                                   sync         v
 phone app                                  Postgres (Neon)
   pairs through the relay                    signups, users, api_tokens,
                                              sync_* (ciphertext only), donations
```

| Component | Storage | Database needed? |
| --- | --- | --- |
| Desktop app, Local Web UI, Docker | Files in the local data directory (one JSON file per chat, written to a temp name and renamed into place) | No |
| Relay (`apps/relay-server`) | None: it routes encrypted frames and keeps nothing | No |
| Nekko Cloud API (`apps/nekko-agent-api`) | Postgres via `DATABASE_URL` | Yes |

### The cloud database

- **Provider.** Production runs on [Neon](https://neon.tech) serverless Postgres, through Neon's pooled connection string. The Neon project sits in `aws-us-east-1`, next to the API's Fly region (`iad`). Any recent Postgres works; Neon is what we run and recommend (see [the API README](../../apps/nekko-agent-api/README.md#database-neon-recommended)).
- **Scale to zero.** Both the Fly machine and the Neon compute stop when idle. The first query after a quiet spell waits for the compute to wake (well under a second), and the pool's timeouts in `src/db.ts` leave room for that.
- **What it holds.** Signups and accounts (`signups`, `users`), API tokens stored as SHA-256 hashes, end-to-end encrypted sync (`sync_*`: ciphertext, opaque ids and revisions; the server never holds a key that opens them), and opt-in research samples sealed to an offline key (`donations`, with no user, device or IP column).
- **Migrations.** Plain SQL in `apps/nekko-agent-api/migrations/NNNN_*.sql`, applied in order on every start inside one transaction under an advisory lock and recorded in `schema_migrations`. No ORM.
- **Tests.** The API's tests run against PGlite in memory, so contributors never need a database or a Neon account.
- **Planned.** Account sign-in, billing and the relay's authorization endpoint (`NEKKO_RELAY_AUTHZ_URL`) will live in the same service and database.

## Build order

`npm run build` builds the Rust daemon, then the TypeScript workspaces in dependency order: `shared`, `profile`, `cli`, `desktop`. `npm run dev` runs a faster variant (the daemon in the incremental `dev-daemon` profile, no production desktop bundle, since electron-vite dev builds its own) and launches the desktop app.

## Where to put new code

- Engine behaviour goes in a Rust crate under `crates/`, so it can be tested without Electron.
- The desktop app only wires the engine to the window, the file system and the shell.
- A change to what the product does also updates its file under `spec/` (and `node scripts/spec-index.mjs` for a new one); a change to how it is built updates `TASKS.md`.
