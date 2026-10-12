# Architecture

Nekko Agent is one engine and one React UI that run in several places: the desktop app, the self-hosted web edition, Docker and the phone. This page is a map of the code for contributors. The full technical plan, with every decision and task, is in [`TASKS.md`](https://github.com/nekko-labs/nekko-agent/blob/main/TASKS.md); what the product does and why is in [`SPEC.md`](https://github.com/nekko-labs/nekko-agent/blob/main/SPEC.md).

## The big picture

```text
 desktop window (Electron + React)        browser (web edition, Docker)
            |                                        |
            |  IPC                          HTTP + WebSocket
            v                                        v
       apps/desktop main                      apps/server
            \                                        /
             \----------- nekkod (Rust) ------------/
                     engine daemon on loopback
                    /            |              \
          native services   model servers   TS host (packages/host)
          (chat, tools,     (llama-server,   for everything not
           terminals, ...)   routed)          ported to Rust yet
```

- **The UI never shares a process with the agent.** The window talks to `nekkod`, the engine daemon, over a loopback connection with a per-launch token. The agent loop, terminals and model servers run there, so a busy agent cannot freeze the interface.
- **The engine is moving from TypeScript to Rust.** `nekkod` answers what has been ported natively and passes the rest to the TypeScript host it supervises. Each ported piece has to match the TypeScript behaviour exactly before it takes over.
- **Every edition is the same app.** Desktop, web and Docker run the same engine and the same UI. Only the transport differs: Electron IPC on the desktop, HTTP and WebSocket in the browser.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Types and IPC contracts. Pure, no runtime dependencies. |
| `packages/core` | The TypeScript engine: providers, agent loop, guardrails, context, indexer, memory, connectors. No Electron imports, unit tested with Vitest. |
| `packages/host` | Wires the engine to the file system, shell and settings. Shared by every edition. |
| `apps/desktop` | The Electron app: `src/main` (Node), `src/preload` (the bridge) and `src/renderer` (React). |
| `apps/server` | The self-hosted web edition, also the `npx nekko-agent-web` package. |
| `apps/cli` | The `nekko-agent` CLI and MCP server. |
| `apps/mobile` | The iOS and Android app (Expo). |
| `apps/relay` | The relay that pairs a phone with a computer. It only ever sees encrypted frames. |
| `apps/cloud` | Nekko Agent Cloud, the planned hosted edition. |
| `apps/website` | nekkoagent.com, including these docs. |
| `crates/nekkod` | The engine daemon. |
| `crates/nekko-*` | The daemon's services: chat turns, tools, terminals, inference, remote access, storage, usage and more. |

## Build order

`npm run build` builds the Rust daemon, then the TypeScript workspaces in dependency order: `shared`, `core`, `host`, `cli`, `desktop`. `npm run dev` runs a faster variant (the daemon in the incremental `dev-daemon` profile, no production desktop bundle, since electron-vite dev builds its own) and launches the desktop app.

## Where to put new code

- Engine behaviour goes in `packages/core` or a Rust crate, so it can be tested without Electron.
- The desktop app only wires the engine to the window, the file system and the shell.
- A change to what the product does also updates `SPEC.md`; a change to how it is built updates `TASKS.md`.
