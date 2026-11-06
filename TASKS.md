---
status: active
last-updated: 2026-11-04
owner:
---

# Execution Plan, Nekko Agent

> **The plan only.** This file is the technical plan: how we build what [spec/](spec/README.md) describes (stack, architecture, data model, conventions, design system, constraints). Update it when the technical approach changes.
>
> **Tasks live in GitHub issues** (since 2026-11-04). Every change already has an issue ([AGENTS.md](AGENTS.md), "Landing work"): plan notes and the checklist for a change go in its issue, and how it was built goes in the PR description. [Floop](https://floop-nekko.fly.dev) mirrors the issues (two-way sync is planned). Do not add task groups here.
>
> **History.** Every task group and the Part 2 checklist up to the move are frozen, verbatim, in [docs/history/tasks-archive.md](docs/history/tasks-archive.md). Task IDs cited in code comments and the spec (IO-20, AN-32, T185, ...) are there. Why: [decision 0049](docs/decisions/0049-keep-the-spec-index-and-task-log-out-of-prs.md).


## Part 1, Plan (how we build it)

> The **technical plan**: how we build what [SPEC.md](spec/README.md) describes. Update this whenever the technical approach changes.

## Stack (decided, do not relitigate)

- **Monorepo**: npm workspaces. **No pnpm** (broken on this machine by a corepack/yarn override up the directory tree).
- **Desktop**: Electron **44.7.0** (exact-pinned under workspaces) + Vite 7 + React 19 + TypeScript 7 + Tailwind CSS v4 + Zustand 5. `electron-vite` v5 drives the build; `electron-builder` v26 creates installers. These versions reflect the dependency upgrade already present on `main`; keep the lockfile and package manifests aligned and verify packaged main/preload bundling when upgrading again.
- **Core engine**: `packages/core`, pure TS, no Electron imports, unit-testable with Vitest.
- **Host services**: `packages/host` (`@nekko-agent/host`), transport-agnostic Node services + a `createHost()` facade (Phase-2 extraction; see Architecture).
- **Shared types/IPC contracts**: `packages/shared` (`@nekko-agent/shared`).
- **Web server**: `apps/local-web-ui`, Fastify v5 (+ @fastify/static, @fastify/websocket).
- **Cloud**: `apps/nekko-agent-api/cloud`, Fastify, multi-account, file-backed store (Postgres-swappable).
- **CLI**: `apps/cli` (`nekko-agent`), ESM, Node 22 globals (`fetch`/`WebSocket`), no deps.
- **Relay**: `apps/relay-server`, Fastify WS dumb pipe.
- **Mobile migration**: platform-native SwiftUI in apps/ios; Kotlin/Compose in apps/android (standalone Gradle build, not an npm workspace; AGP 9.4 + built-in Kotlin, JDK 17). Existing `apps/mobile`, Expo (React Native, Expo Router, new architecture) with llama.rn for on-device models; standalone, not a root workspace (own `package-lock.json`). Types come from `@nekko-agent/shared` as type-only imports (tsconfig path, erased by Babel); runtime protocol code (E2E crypto via `@noble`, relay client) is reimplemented for Hermes and pinned to the shared implementation by tests. Native modules are allowed here (the "no native modules" rule is the desktop/engine's). Changed from Capacitor 2026-10-03, see Key Technical Decisions.
- **Website**: `apps/website`, static hand-crafted HTML/CSS/JS (no framework, GitHub Pages), download buttons → GitHub Releases.
- **Storage**: JSON files under the app data dir; usage analytics as JSONL. **No native modules**, spawn `ripgrep`/git via child_process when available, with JS fallbacks.
- **Engine daemon** (revised 2026-09-30 by Philip): **Rust**, a Cargo workspace at the repo root with crates under `crates/`. `nekkod` (binary: tokio + axum, the `/api` wire, supervision, strangler proxy), `nekko-term` (portable-pty sessions), `nekko-infer` (inference router and runtime adapters), `nekko-bench` (benchmark harness). Shipped as a standalone per-platform binary in the app's resources, never loaded into Node. The UI stays Electron + React (web technology, for maintainability); GPUI or another native shell is deferred (see Backlog).

## Architecture Overview

```text
apps/desktop/
  src/main/        Electron main: thin IPC wiring over createHost() (windows, IPC router,
                   workspace add dialog, window-state), service logic now lives in packages/host
  src/preload/     contextBridge API (typed, from packages/shared) → window.nekko
  src/renderer/    React app (shared verbatim across all editions; see Design System & UI/UX)
packages/core/     providers/ (anthropic, openai-compat, ollama-native, lmstudio, vllm,
                   openrouter), agent/ (loop, tools, prompts), guardrails/ (risky-command
                   classifier + policy), memory/ (markdown memory store), indexer/ (file
                   tree + outline + search), context/ (context assembly with provenance -
                   powers the Context panel), connectors/ (linear, slack, discord, gmail, gdrive)
packages/host/     services/ (settings, sessions, chat, tools, workspace, memory, usage,
                   connectors, mcp, spec, relay-agent, terminal, files, changes); host.ts
                   createHost() → NekkoApi surface + EventEmitter; dispatch.ts createDispatcher(host);
                   paths.ts (data dir, ALS)
packages/shared/   types, IPC channel contracts, defaults, e2e.ts (WebCrypto seal/open)
apps/local-web-ui/       Fastify: POST /api/:channel + /api/events WS over createHost(); serves renderer;
                   relay-agent mode; esbuild bundle → npx nekko-agent
apps/nekko-agent-api/cloud/        multi-account hosted edition (accounts, entitlements, per-account Host)
apps/relay-server/        dumb E2E pipe + push sender (APNs/FCM)
apps/cli/          nekko-agent CLI + MCP server (local in-process or remote HTTP+WS)
apps/ios/          SwiftUI iOS app (native target, in migration)
apps/android/      Kotlin / Jetpack Compose Android app: :protocol (JVM) + :app (Compose)
apps/mobile/       Expo iOS/Android app: migration reference (relay client + llama.rn on the phone)
apps/website/      marketing site (index.html, styles, mascot sprite, downloads)
```

### One codebase, multiple runtimes (the host extraction)

The keystone Phase-2 decision: service logic was extracted out of `apps/desktop/src/main` into the transport-agnostic **`packages/host`**. `createHost(opts)` returns one object implementing every `NekkoApi` method (minus the `on*` subscriptions, which become an `EventEmitter` emitting `agentEvent` / `indexProgress` / `terminalEvent` / `changesUpdated`). A shared **`createDispatcher(host)`** provides one routing table reused by every transport. Then every edition wraps the same `Host`:

- **Desktop** (`apps/desktop/src/main`): thin IPC wiring, `ipcMain.handle(channel, …) → host[method](...)`; forwards host events to `webContents.send`. Overrides only `workspaceAdd` for the native folder dialog.
- **Web/Docker** (`apps/local-web-ui`): `POST /api/:channel → host[method]` + a `/api/events` WebSocket, both routed by `createDispatcher`. Serves the same built renderer.
- **Cloud** (`apps/nekko-agent-api/cloud`): per-account `Host` (own data dir + event emitter), every request run inside `withDataDir()`.
- **Renderer transport adapter**: `renderer/web-client.ts` provides `window.nekko` over fetch/WS (auto-installed by `main.tsx` when no Electron preload exists), so the React UI is **shared byte-for-byte**. It can also route over the relay (`?relay=&room=&key=`).

> **The five-touch rule (recurring):** adding any renderer↔host capability means touching, in order: `shared/ipc.ts` (channel + `NekkoApi` type) → host impl + `host.ts` interface → `dispatch.ts` → `preload/index.ts` (Electron) → `web-client.ts` (web). Keep all five in sync. (Extending `setSessionOptions` is the same shape: update the `Pick` in **three** places, `sessions.ts`, the `host.ts` interface, and `shared/ipc.ts`.)

See [spec-web-and-hosted.md](spec-web-and-hosted.md) for the full web/Docker/Cloud design, edition matrix, relay protocol, and ZDR boundary.

### The Rust engine daemon (`nekkod`) and the strangler migration

Today `createHost()` runs inside the Electron main process, so the agent loop, every pty, the llama-server router and synchronous session I/O share a process with window management and IPC. The target is a Rust daemon that owns the engine, with the TS host shrinking channel by channel until it is gone. The migration never has a big-bang cutover:

- **One wire.** `nekkod` speaks exactly the Local Web UI's protocol: `POST /api/:channel` with `{ args }`, and a `/api/events` WebSocket of `{ channel, payload }`. The renderer's `web-client.ts` therefore works against it unchanged. Terminal data gets its own binary WebSocket per terminal (`/api/term/:id`) so bulk output never goes through JSON.
- **Strangler routing.** `nekkod` holds a table of channels it owns. Anything else is forwarded to a **TS host backend** it spawns and supervises (the existing host, run headless on a loopback port with a per-launch token, the same way `apps/local-web-ui` runs it). Events are merged: `nekkod` subscribes to the backend's `/api/events` and fans them out with its own. Porting a service means moving its channels into the owned table and deleting the TS implementation; nothing else changes.
- **Desktop topology.** Electron main becomes a thin shell: it spawns `nekkod` (from `resources/bin`), passes the data dir, a random port and a per-launch token, and keeps only what needs Electron (native dialogs, `shell`, the updater, window chrome) on `ipcMain`. The TS backend is started by `nekkod` with the Electron binary under `ELECTRON_RUN_AS_NODE=1`, so no separate Node runtime ships. The renderer receives the daemon URL and token from the preload and builds `window.nekko` from the web client plus the Electron-only overrides.
- **Supervision.** `nekkod` restarts a crashed TS backend with backoff; Electron main restarts a crashed `nekkod`. The renderer's web client already reconnects its event socket; in-flight requests fail with a readable error rather than hanging.
- **Security.** Loopback bind only, a bearer token on every HTTP and WebSocket request, and Host/Origin checks, matching `apps/local-web-ui`'s `createApiSecurityHook`. The token never appears in a URL the renderer logs.
- **Port order.** Terminals first (the hottest data path), then the inference router, then session storage, then providers and the agent loop, then tools/guardrails/changes, MCP, connectors/messaging/workflows, the relay agent and training. The web, npx and Docker editions move behind `nekkod` once the desktop path is proven, with per-platform binaries shipped as npm optional dependencies.

### Workspace windows (chat / terminal / file / files / browser / diff / pr / hypergate)

A workspace is a **split tree**, not a tab stack. `renderer/layout.ts` owns the tree and is pure and unit-tested: `WbPane` leaves and `WbSplit` branches (`dir: 'row' | 'col'`, `children`, parallel `sizes` summing to 1), with `splitPane` / `removePane` / `movePane` / `resizeSplit` / `retargetPane` / `extent` / `canSplit` (the 8x8 ceiling, `MAX_ACROSS`). Splitting beside a sibling on the same axis joins that split rather than nesting inside it, and a split left holding one child collapses into it, so the tree keeps the shape you would draw.

`store.ts` holds `workspaces: Workspace[]` (`{ id, anchor, root, activePaneId }`) plus `activeWorkspaceId`, and renames the old project-folder field to **`activeProjectId`** (`settings.workspaces` is the folder list the UI has always called Projects) so the two concepts never share a name. `WbPane.kind` is `'chat' | 'terminal' | 'file' | 'files' | 'browser' | 'diff' | 'pr' | 'hypergate'`; `WbPane.refId` holds the file path (file/diff), folder path (files), URL (browser), PR URL (pr), or the Hypergate manager's URL (hypergate). `WorkspacesView.tsx` routes each kind to a component. Store openers mirror `openChatPane` (locate-or-create, focus): a chat with no workspace starts one, everything else lands beside the focused window via `openInActive`. `splitPane` / `movePane` / `closePane` / `resizePanes` / `canSplitPane` wrap the tree functions; `newChatInPane` / `newTerminalInPane` create the host object first, then split. Hypergate is the one singleton window: there is a single manager, so an existing one is re-pointed rather than duplicated when the port changes.

## Data Model

- **Storage**: desktop/server/CLI share `~/.nekko-agent` by default (`NEKKO_DATA_DIR` override). Electron profile data lives in `desktop/`, cloud deployment data defaults to `cloud/` with per-account isolation, and managed model downloads use `models/{type}`. Legacy profiles require a confirmed move with a resumable journal, no silent merge, and preserved model IDs/presets. Usage analytics remain JSONL.
- **Settings** (`AppSettings`): providers, defaults (provider/model), guardrails ruleset, prompts (`PromptTemplate[]`), MCP servers (`McpServerConfig[]`), favorites, language, default chat mode, auto-update prefs, `specMethodology`, `orchestration`.
- **Session**: messages, `workspaceId`, `attachedPaths`, `specLinked`, `mode` (ask/guardrails/yolo), `disabledTools`, `offline`, `incognito`, `pinned`, `tags`, `title`, `modelId`, `autoModel`, `specMethodology`, `parentSessionId`, `ContextPrefs` (toggle/pin state). Context-use estimates in the renderer are ephemeral; compaction stages a bounded summary and replaces older transcript messages only after success, preserving recent turns when they fit and leaving the original untouched if cancelled.
- **Memory**: markdown entries, global + per-workspace.
- **Workspace**: folder roots + index (file tree, outline, search).
- **Usage**: JSONL append; `UsageSummary` aggregates byModel / bySession (drives cost estimation).
- **Changes** (diff/approval): keyed by sessionId, `{ path, original }` recorded the first time `write_file`/`edit_file` touches a path in a session; `listChanges`/`revertChange`/`acceptChange` operate over it.
- **Cloud**: file-backed `CloudStore` (`cloud.json` + per-account dirs under `accounts/<id>`) behind an interface so Postgres can drop in; `setPlan` ready for Stripe. Each account gets its own data dir, scoped via `withDataDir` (`AsyncLocalStorage` in `paths.ts`); the settings cache is keyed by data dir (`Map<dataDir, AppSettings>`).

## Integrations & APIs

- **Model providers**: Anthropic native; OpenAI-compatible SSE (OpenAI/OpenRouter/LM Studio/vLLM); Ollama native (list/pull/ps/load/unload). Base-URL `/v1` normalization for bare `host:port`.
- **Desktop browser control**: the optional `browser` tool uses Stagehand v4 with a dedicated visible local Chromium browser or a user-enabled loopback CDP port. The desktop host alone offers it; cloud/web, offline chats and unattended runs do not. Each action gets explicit approval regardless of chat mode, and the attached browser is never closed by the app. Deterministic selectors and page inspection need no additional LLM key or remote browser service.
- **Agent command log**: guarded `bash` tool calls append the command and stream stdout/stderr to a read-only virtual terminal keyed by session. The existing command executor remains authoritative; opening the pane never re-runs a command.
- **File IPC** (powers file panes / explorer / editor): `readFile(path) → {content, truncated, binary}` (1 MB cap, NUL-byte binary detect), `writeFile(path, content)`, `listDir(path) → DirEntry[]` (dirs-first), host `files.ts`, honoring sandbox/jail checks where applicable.
- **Connectors**: Linear/Slack/Discord via real REST (token-based); Gmail/Drive OAuth scaffold (full flow pending Google client creds).
- **MCP**: hand-rolled JSON-RPC-2.0 client, no SDK dep, two transports: **stdio** (`shell:true` on win32 so `npx`/`.cmd` resolve) and **streamable HTTP** (`McpServerConfig.url` + `token` → plain `fetch` POSTs with `Accept: application/json, text/event-stream`, parses JSON or SSE-framed replies, echoes `mcp-session-id` for stateful servers). `initialize` + `notifications/initialized`, `tools/list`, `tools/call`. Host-side `detectHypergate()` probes `localhost:7777` (`NEKKO_MCP_URL` override) for a Hypergate daemon (`hypergated`) (`mcp:hypergate` channel). Nekko Agent is also an MCP *server* via `nekko-agent mcp`.
- **Vaizer skills hub**: host `vaizer.ts` reads the public catalog of [nekko-labs/vaizer](https://github.com/nekko-labs/vaizer) (`vaizer:catalog` / `vaizer:skillMd` channels). Offline-first: bundled snapshot / `vaizer.json` cache by default, live GitHub fetch only on explicit refresh; SKILL.md fetched verbatim at install time. Non-catalog installs ride an `installSkill` payload + record snapshot.
- **Push (relay)**: APNs (HTTP/2 + ES256 JWT) and FCM (HTTP v1, service-account RS256 JWT → OAuth → messages:send), both dependency-free in `apps/relay-server/src/push.ts`. Tokens registered per deviceId; dropped on device revocation (`push-remove`). Config via `APNS_*` / `FCM_SERVICE_ACCOUNT` env. Credential setup: [provisioning.md](../../obsurdian/projects/nekko-agent/provisioning.md).
- **Relay v2 protocol (phone remote control)**: relay tags each device connection with a `cid` (`{type:'c', cid, data}` toward the agent; agent unicasts `{type:'d', cid, data}` and can `kick`); device auth is END-TO-END, a sealed HELLO (`deviceId` + optional one-time `pair` code) validated against the host's registry (`remote.json` via `packages/host/src/remote.ts`; pure `verifyHello` in `shared/remote.ts`). Requests before a welcome are refused; events fan out only to welcomed connections (terminal/changes/tasks/training events now ride the relay too). Relay hardening: timing-safe key compare, 10 MB frame cap, token-bucket rate limit, client/room caps, optional `NEKKO_RELAY_AUTHZ_URL` agent-enrollment gate (cloud `/api/relay/authorize`). Managed instance: `wss://nekko-agent-relay.fly.dev` (Fly.io, `apps/relay-server/fly.toml`, ONE machine, rooms are in-memory); self-host image `ghcr.io/nekko-labs/nekko-agent-relay`. Guide: [docs/REMOTE.md](docs/REMOTE.md).
- **Cloud auth**: email+password (scrypt via `node:crypto`, `salt:hash`, `timingSafeEqual`), bearer session tokens.

## Infrastructure & Deployment

- **Desktop**: electron-builder targets win (MSI/NSIS/zip), mac (dmg/zip, arm64 ad-hoc signed), linux (AppImage/deb). Release CI on `v*` tags builds all 3 OSes and publishes a draft. Auto-updates via electron-updater (GitHub feed, NSIS). To cut a release: bump version (root/desktop/server) + `git tag vX.Y.Z && git push` → CI publishes a draft → publish it.
- **Web/npx**: `npm run web` (in-repo) or `npm run bundle:web` → esbuild-bundled self-contained `nekko-agent` package in `apps/local-web-ui/cli-dist` (server+engine inlined, fastify external) → `npx nekko-agent`. Publish needs the user's npm login.
- **Docker**: multi-stage `Dockerfile` (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`, dev deps pruned, a cargo stage for `nekkod`, non-root node:22-trixie-slim with tini, health check on `/health`) + `docker-compose.yml` (volume workspace + data, `host.docker.internal:host-gateway`, publishes to 127.0.0.1:1440); GHCR publish workflow on `v*` tags.
- **Mobile**: `.github/workflows/mobile.yml` runs on mobile/relay changes (and manually): typecheck, unit tests, and the phone ↔ relay ↔ computer integration test (needs the root shared/core/host/cli/server/relay builds), then `expo prebuild` + an Android debug APK and an unsigned iOS simulator build. Locally on Windows: `subst` a short drive letter over the worktree before `gradlew assembleDebug` (CMake path limits), JDK 21 from Android Studio's `jbr`, `-PreactNativeArchitectures=x86_64` for the emulator. llama.rn's postinstall downloads its prebuilt libraries with `tar`; under Git Bash that is GNU tar, which reads `C:` as a remote host, so run installs from PowerShell or run `npm run llama:native` after.
- **Cloud**: `npm run cloud` (:4318) locally; hosted deploy target TBD (open question).
- **CI scope** (`ci.yml`, added 2026-10-17; see "CI scope, merge queue and stacks" in [the task archive](docs/history/tasks-archive.md#ci-scope-merge-queue-and-stacks-added-2026-10-17)): a `scope` job runs `scripts/ci-scope.mjs` over the run's event, changed files and labels and hands each slow job its OS matrix (PR tier, nightly full tier). `gate`, the one required check, aggregates them. There is no merge queue since 2026-11-06: PRs land by native auto-merge ([decision 0056](docs/decisions/0056-no-merge-queue-speed-contract-and-itests-run-nightly.md)), and `gate` waits for the path-gated speed contract and the itests on the PR itself, as well as nightly ([decision 0057](docs/decisions/0057-speed-contract-and-itests-run-on-every-pr.md)).
- **Local test loop**: `npm run local` builds + launches the built desktop app (electron-vite preview, no installer/Defender); `npm run web` for the browser edition.
- **Ports**: web 1440, cloud 4318. Kill a stale dev server by port (`Get-NetTCPConnection -LocalPort … | Stop-Process`), npm-wrapped node survives `pkill`.

## Design System & UI/UX

**UI map (renderer).** Left rail (icon nav, expands over the content on hover to show labels; its right divider is visible only while expanded): **Agent board** (dashboard), **Chat** → **Workspaces**, **Skills**, **Training**, **Goals**, **Design** (the design studio + snapshot board), **Model Providers** (cloud keys, subscriptions, servers elsewhere), **Model Server** (independent model/agent servers on the left, model library/downloads/folders on the right, with optional image generation), **Connectors**, **Memory**, **Settings**. (The dedicated **Projects** view was removed 2026-07-18; folders are added from a chat's + menu / Context Inspector, and the index still powers `@` mentions + context.) **Mascot**: Nekko, a right-facing 2D hand-drawn outline secret-agent cat. `AgentHead` is the canonical head geometry: slim ink-filled sunglasses, discreet earpiece/coiled wire, folded collar and small tie. Glasses perch above closed eyes in sleep/stretch; the mini simplifies the details for 16-24px legibility. Theme ink/paper and ginger ears/tail remain, as does the full mascot's line-boil wobble. Website hero/favicon/social artwork reuse the same geometry rather than drifting into another style. The renderer-local state machine and exact timings still map agent work, user activity, active pauses, and AFK/visibility to bug-watching, wake-and-spin, stretching, lying, and sleeping poses (T124/T135 foundations, AN10 visual refinement).

**Workspaces (the Chat surface).** A multi-window shell driven by a Zustand split-tree model (see *Workspace windows* above). The Agent board wall (`components/CommandWall.tsx`, state in the pure `commandWall.ts`) renders the same tree with the same `PaneFrame`, `SplitCompass` and the shared `components/Divider.tsx`, so dividers, the compass and drag-to-a-side behave identically on both surfaces; `PaneFrame` takes `ringColor` / `stripStyle` / `addable` / `closeTitle` for the wall's needs-you treatment and its own kinds. The left sidebar lists workspaces grouped by project (project bucket + a "General" bucket), each a three-line card reporting its state, model, binding limit, folders, and window count; sub-agent sessions (`parentSessionId`) nest under their parent. The centre is the active workspace's split tree, with no tab strip anywhere. Components: `WorkspacesView` (orchestrator + sidebar + canvas), `WorkspaceCard` (the sidebar card), `PaneFrame` (per-window title strip, drag handle, and the drop target that reads the nearest edge via the pure `edgeAt`), `SplitCompass` (the add-a-window compass, portaled out of the window's own clipping), `ExplorerPane` (a file explorer as a window), `ChatPane` (self-contained conversation, per-pane provider/model, streaming, inline Context Inspector; refactored out of the old monolithic `ChatView`), `TerminalPane` (Warp block terminal), `FilePane` (markdown preview / mono editor), `BrowserPane` (`<webview>` + URL bar), `DiffPane` (session change review). Terminals are an in-memory host service (`packages/host/terminal.ts`): one persistent shell process per terminal, per-command marker echo delimits blocks + carries the exit code (`$?`-aware on PowerShell), output streamed over a `terminalEvent` bus channel. Sub-agents: `spawn_agent` builtin tool handled in `host/chat.ts` (creates a child session, runs a nested `sendChat`, returns its last assistant message; depth-capped).

**Chat surface.** Messages render as **speech bubbles** (user right, assistant left with a tail) flowing into the composer. Reasoning streams into a Claude-Code-style collapsible **Thinking** box (dimmed, auto-collapses when the answer starts). A **metrics bar** above the composer shows context used/total (hover → token breakdown by source), tokens/sec, thinking on/off, an **effort** cycle (low/normal/high → `EFFORT_TEMPERATURE` {0.2,0.7,1.0}), and per-chat estimated cost. The composer also hosts the **prompt analyzer** (see below).

**Instrument strip (above the composer).** Two rows, split by the question each answers: row one **how this agent runs** (Mode, Tools, then a hairline divider and the Offline / Incognito privacy switches pushed right), row two **which brain it uses** (model picker, Thinking, Effort, then Automate pushed right). Three control families keep them from reading as one run of pills, and they are the vocabulary for any new strip control: **`.ctl-menu`** for a value picker (transparent bordered field, `.ctl-menu-label` for the muted name, `.ctl-caret` for the ▾), **`.ctl-toggle`** for an on/off switch (no background until hover; the on-state is color plus a lit `.ctl-dot`, never a filled pill; `.ctl-toggle-neutral` for a switch that shouldn't claim the accent, `.ctl-toggle-on` for a read-only indicator that can't carry `aria-pressed`), and a plain icon button for an action. Everything is `shrink-0` except the model chip, which truncates first, so the strip never wraps.

**Markdown (`Markdown.tsx`).** A dependency-free line scanner (not a blank-line block splitter, which mis-parses the dashed lists people actually type) shared by both sides of the transcript and the file viewer: lists nested by indentation, headings, quotes, rules, pipe tables, fenced code, inline bold/italic/strike/code/links + bare-URL autolinking, single newlines kept as `<br>`. Emphasis is stars-only with hugging delimiters so `snake_case` and `2 * 3 * 4` survive. Covered by `Markdown.test.tsx`.

**File / editor / browser surfaces (IDE-like).** `FilePane` reads via the file IPC; `.md` → toggle between rendered (`Markdown.tsx`) and source; other text → editable mono `<textarea>` with Save (Ctrl/Cmd-S) + dirty dot; binary/oversized → notice. `BrowserPane` is an Electron `<webview>` (`webviewTag: true` in the main `webPreferences`) with go/back/forward/reload/open-external. `FileTree.tsx` (`ProjectFiles`) is a collapsible per-project tree with `fileIcons.tsx` color-tinted glyphs (Linguist/Material palette), lazy children via `listDir`. `DiffPane.tsx` computes a client-side LCS line diff and renders added/removed lines with per-line keep/revert checkboxes + per-file and all-files Keep/Revert; refreshes on the `changesUpdated` event. The `SpecPanel` ↗/row click calls `openFilePane(path)` (not `openPath`), keeping an explicit "reveal in OS" affordance as fallback.

**Prompt analyzer.** `promptAnalysis.ts` (pure, renderer-side, no LLM): given the draft, returns `{ parts, findings, score: 'A'..'F', model }`. Part detection (role/task/context/examples/output-format/constraints/reasoning/tone/variables) + lint rules (vague terms, weak/passive verbs, missing role/format, ambiguous pronouns, length, filler, conflicting instructions, secret/PII leak) + a model hint (multi-step + large context → frontier; short single-shot → fast/cheap). `PromptAnalyzer.tsx` in the composer shows the grade + part checklist, expandable to grouped findings, with inline wavy underlines over flagged spans.

**Context Inspector (right panel, toggleable).** Two parts, each section self-explaining on hover (`InfoHint` group-hover popover):

- **Sources**: folders wired into the chat (active highlighted, add/remove, multi-root), attached files (native multi-file picker; `prompt` fallback on web), the chat's `SPEC.md` (highlighted + openable) with Build-from-chat / Live controls, links to detected guideline files (AGENTS.md/CLAUDE.md), and a memory count.
- **Breakdown**: live view of exactly what's entering the prompt this turn (files, guidelines, memory snippets, connector data, index snippets), each item toggleable/pinnable with token counts, plus a context-window headroom bar.

**Design tokens.** All in `renderer/styles.css`; components read tokens, never raw values.

- **Colour.** Cool ink/paper neutrals in three ink tiers (`--ink`, `--ink-soft`, `--ink-faint`), every tier at WCAG AA (4.5:1) on `--paper`, `--win`, `--surface` and `--surface-2` in every theme and preset (`contrast.test.ts` holds it). One brand hue, violet: `--accent` `#6d5efc` light / `#8b7dff` dark, recolourable in Settings. `--accent-soft` and `--ring` derive from it by `color-mix`, so they follow the user's choice. Semantic status hues (`--success`, `--danger`, `--warning`, `--info`, `--running`, `--attention`) carry state; never a raw hex. Dark and light via `data-theme` with `color-scheme` set, so native controls never go white-on-white.
- **Type.** Inter Tight for the UI, JetBrains Mono for code (Settings > Style can override both). One scale, 11 / 12 / 14 / 16 / 20 / 24, as `text-2xs` / `xs` / `sm` / `base` / `xl` / `2xl` (and `var(--text-*)` in CSS). Nothing below 11px, no in-between sizes, no `text-[Npx]`. Chat and documents set 14px body.
- **Spacing.** A 4px base: 4 / 8 / 12 / 16 / 24 / 32, with 1px and 2px only for hairlines. Never 6, 7, 10, 14 or 18. `--pane-gap` (8px) is the one gap between panels.
- **Elevation.** Tinted shadows only, blur about twice the offset: `--shadow-sm` (a toggle knob), `--shadow-md` (a tooltip), `--shadow-float` (menus, popovers, toasts), `--shadow-lift` (a dragged card). In Tailwind, `shadow-(--shadow-float)`; the default black `shadow-lg` scale is switched off. A resting card has a hairline border and no shadow.
- **Accent use.** The accent marks the one primary action per view (`.btn-primary`, a flat fill: never a gradient, never a resting shadow), focus rings and live data. Menus, creation rows and the nav rail use a neutral wash for hover and the active item. Titles are plain ink. Small group labels are 12px sentence case in `--ink-soft`, never tracked caps.
- **Reading.** Chat and documents cap prose at about 68ch with a 1.6 line height; code and tables keep the full width.
- **Motion.** One curve, `--ease-out` (`EASE_OUT` in `easing.ts` for `Element.animate`), no springs or overshoot on chrome; under 300ms for anything used often; nothing on keyboard-opened surfaces or on navigation. Animate `transform`, `opacity` and `clip-path`, never left/top/width/height or `transition-all`; open/close pairs are transitions so they can be interrupted. Drags write to the DOM and commit to state on release.
- **Touch.** The Local Web UI runs on phones: hover-only affordances also need `touch:` (`@media (hover: none)`), CSS `:hover` rules sit under `@media (hover: hover)`, fields are 16px on a coarse pointer, and long text in narrow rows wraps or middle-truncates (`MiddleTruncate`) with a `title`.
- **Shape.** `rounded-xl` controls, panels at `--pane-radius` with the squircle (below), focus as a `--ring` halo.

**Panels and the squircle.** Every surface of the workbench is a **panel**: the sidebar, each window, the inspector, the empty state. One `panel` utility carries the shape (`--pane-radius`, `corner-shape: squircle`, `overflow: hidden`, paper background) and `panel-ring` carries the outline. The ring is a **`::after` over the contents, not an `inset` box-shadow under them**, because an inset shadow paints on the element's own background layer: any child with a background of its own (a title strip, a toolbar) covers the stretch of ring running behind it, which is why a window's top corners read as square while its bottom ones were round. Focus is `--panel-ring-color`, set per panel. Panels float on one `--surface-2` field at `--pane-gap`, so the three columns of the workbench are one system rather than two full-bleed columns flanking a tray of rounded windows. Beyond that, a base rule gives `rounded-lg/xl/2xl/3xl` the superellipse everywhere; `rounded-full` is deliberately excluded, since a superellipse at a 50% radius is not a circle and the dots, avatars and pills that use it are meant to be round.

**Responsive / PWA.** ChatView session list + context panel become slide-over drawers on phones; header selects shrink/hide via `md:`. Installable PWA (manifest + network-first `sw.js` that never caches `/api`, registered only on http origins).

### Inline editor comments (planned), design

- **Surface**: in `FilePane`'s mono editor, a gutter **+** appears on the hovered/active line. Clicking opens an inline comment box anchored to that line.
- **Capture**: a comment carries `{ path, line, lineText, comment }`. Comments persist per session (extend the host `changes`/a new `comments.ts` store, keyed by sessionId; surfaced via a new `comments:*` IPC channel set following the five-touch rule). A small marker stays on commented lines until resolved.
- **Actions**: **Add to prompt** appends a formatted block (`> file:line, comment`) into the active pane's composer draft so several annotations batch into one ask; **Run now** dispatches immediately via `sendChat` on the pane's session with the same block as the user turn. Both reuse the existing composer/send path, no new agent plumbing.
- **Constraint**: zero new deps; gutter affordance built with the existing editor textarea + an overlay (same technique as the analyzer underline overlay).

### Design board (planned), design

- **Surface**: a new left-rail **Design** view (and/or a `WbPane.kind = 'design'`). A zoomable/pannable board lays out captured **page snapshots** as cards (Figma-canvas feel) using CSS transform pan/zoom, no new canvas/graph dep for v1.
- **Snapshots**: v1 = read-only images. Capture per page/route. For web/desktop, snapshot the rendered app (reuse the existing screenshot path / `webview` capture for the running preview); store under the app data dir keyed by route. A capture refresh is triggered on demand and when the agent reports a UI change.
- **Notes & comments**: clicking a card opens a side sheet. **Notes** persist with the board (a `design.json` per workspace). **Comments** reuse the inline-comment actions, **Add to prompt** / **Run now**, carrying the page identity as context.
- **Live update + indicator**: when an agent edits files that map to a page, mark that card with an **"updating" badge**; on the agent's `done`/`changesUpdated`, re-capture so the user watches the snapshot change. Clicking the badge calls `openChatPane(sessionId)` to jump to the driving agent.
- **Scope (v1)**: snapshots only (not an editable vector canvas, see Non-goals in spec). Page→file mapping starts heuristic (route table / manual tag) and can tighten later.

## Performance design (the speed contract)

How the rules in [SPEC's speed contract](spec/platform/speed-responsiveness-the-speed-contract.md) are met and enforced.

- **Store subscriptions are narrow.** No component subscribes to the whole zustand store. Components select the fields they render with `useShallow` or single-field selectors. Composer drafts live in component state and persist to `composerDrafts.ts` on a trailing debounce, so a keypress re-renders the composer and nothing else.
- **Transcript windowing.** `components/agent-console/VirtualTranscript.tsx` (in-repo, no dependency) renders only the rows intersecting the viewport plus an overscan. Row heights are measured with one shared `ResizeObserver` and kept in a height cache keyed by block id; unmeasured rows use an estimate. The list sticks to the bottom while streaming unless the user has scrolled up, and keeps the anchored row in place when heights above it change.
- **Frozen blocks.** Assistant text is split into top-level markdown blocks. Blocks before the last are memoized by content, so streaming re-parses only the tail block. Transcript rows are `React.memo` with stable props; streaming state reaches only the live row.
- **One streaming path.** Agent events are folded once (`liveRuns.ts`) and delivered to subscribers at most once per animation frame. A chat pane does not also run its own 50 ms flush over the same events.
- **Warm set for switching.** A renderer session cache (LRU, at most 8 chats and about 24 MB of message text) holds transcripts of recently opened chats and serves them instantly, revalidating in the background. The last 3 chat windows stay mounted, hidden with `content-visibility: hidden` so their layout and scroll positions are kept and showing one is a paint (virtualized, so a hidden pane costs its visible rows only). `listSessions` returns summaries without messages; full transcripts are fetched per chat.
- **Terminal path.** The daemon coalesces pty output per terminal into one frame per 8 ms (or 64 KB, whichever first) on a binary WebSocket. The client acknowledges consumed bytes; above 1 MB unacknowledged the daemon stops reading the pty, which back-pressures the program instead of the UI. Keystrokes are fire-and-forget WebSocket frames, not request/response calls. Scrollback is a byte ring buffer, never string concatenation. The renderer is xterm.js with the WebGL addon by default; `ghostty-web` (Ghostty's VT core in WebAssembly) is the experimental opt-in (`settings.terminal.renderer`), and falls back to xterm on its own if its WebAssembly cannot load. ghostty-web acks right after `write()` returns (it parses synchronously and only calls back on the next paint, which a hidden pane never gets); xterm acks from its parse callback. Both are code-split, so neither loads until a terminal opens. The renderer CSP allows `'wasm-unsafe-eval'` and `data:` in `connect-src` for ghostty-web's inlined module.
- **How it is tested.** `scripts/perf/` drives headless Chromium over the DevTools protocol (the `ws` client already in the tree, no Playwright) against the Local Web UI with a scripted OpenAI-compatible mock provider and a seeded 1,000-message chat. Keypresses are real `Input.dispatchKeyEvent` events; latency is measured in the page from the event's timestamp to the first frame after its effect is committed (`requestAnimationFrame` then a message-channel tick), with Event Timing entries recorded alongside. Streaming frame work is the main-thread time in each of the renderer's own animation frames, read from a DevTools trace in a vsync-paced browser (the Long Animation Frames API only reports frames over 50 ms). Each budget runs enough samples for a stable p95. The SPEC targets are for a desktop at 120 Hz and `npm run perf:strict` enforces them there; the `perf` CI job, on a 4-vCPU runner with no GPU and a 60 Hz display, fails when a p95 exceeds two and a half times the target (the regression gate in `scripts/perf/budgets.mjs`; at exactly twice, healthy builds sat at 94-104% of the gate and the job went red at random). The report prints each raw p95 with both numbers and is uploaded as a CI artifact, so a regression shows the number, not only the failure.

## Coding Conventions

Extends `../../knowledgebase/principles/coding.md` (which these override).

- **TypeScript everywhere**; `packages/core` is pure (no Electron) and unit-tested with Vitest.
- **Keep the build green**: `npm run build` at repo root (order: shared → core → host → desktop) before each commit; typecheck across all workspaces; core tests passing.
- **Land code via auto-merged PRs** on `nekko-labs/nekko-agent`: branch → push → `gh pr create` → `gh pr merge --squash --admin --delete-branch`. PR descriptions stay **short and plain**, a few human-readable bullets.
- **Human-readable tasks first**: checklist items read like plain product statements; technical detail goes as indented sub-bullets, never the top line.
- **Cross-platform** code (Windows-first dev). MCP/stdio spawns use `shell:true` on win32.
- **No new deps when avoidable**: diff (LCS), prompt analysis, file icons, MCP, push JWTs are all in-repo.
- **MCP server stdout hygiene**: `runMcpServer` reassigns `console.log = console.error` so stray stdout never corrupts the protocol stream.
- Autonomous build: don't ask the user; use best judgement; record open questions in `memory.md`.

## Constraints

- **No native node modules** (avoids Electron rebuild pain); **no pnpm**; **Windows-first** dev but keep code cross-platform. Rust lives in the separate `nekkod` binary only, never as a Node addon.
- **Rust daemon hygiene**: `cargo fmt --check`, `cargo clippy -- -D warnings` and `cargo test` pass in CI on Linux, macOS and Windows; the daemon never panics on bad input (errors become a `{ error }` reply), and every child process it spawns is killed when it exits.
- **Not a full IDE**: lightweight textarea editor (not Monaco/CodeMirror), no LSP/debugger; `<webview>` browser is a preview, not a hardened browser; Design board shows snapshots, not an editable canvas.
- The web/Docker server grants file + shell access to whoever can reach it → **bind to `127.0.0.1` by default**; exposing beyond localhost requires `--host`/`NEKKO_HOST=0.0.0.0` **and** a token (`NEKKO_TOKEN`), with a prominent banner. Guardrails + sandbox modes live in the host (not the UI), so they apply identically across editions.
- **Local Windows `dist` is blocked** by Defender quarantining `app-builder.exe` (AV false-positive), release CI runners are unaffected; don't change Defender settings unprompted.
- **Privacy invariant**: the relay sees only ciphertext + the fact "a run finished" (for push); never message content. Never read/echo a secret value into the conversation (the rotate script is no-echo by design).
- **GUI can't be exercised headless here**: interactive surfaces (webview, drag, diff line-revert math, analyzer overlay, the planned inline comments + design board) are verified by typecheck + build in this environment and need a hands-on pass on a real desktop/web run.
- **Standing rule**: confirm before first-time public exposure / new permissions/credentials unless explicitly authorized this session ([[confirm-before-public-or-permissions]]). Building tooling is fine; only *executing* the public/permission action needs the prompt.

## Key Technical Decisions

- **Host extraction (`packages/host`)**: one transport-agnostic `createHost()` + `createDispatcher()` so desktop/web/Docker/Cloud/CLI all reuse the same engine and the renderer is shared verbatim. The single biggest architectural move; everything else hangs off it.
- **Per-account isolation via `AsyncLocalStorage`**: `withDataDir(dir, fn)` scopes the data dir per request; the settings cache became `Map<dataDir, AppSettings>` (also a general correctness fix). Editions that never call `withDataDir` are byte-for-byte unaffected.
- **E2E-encrypted, outbound-only relay**: the local agent dials out (no inbound ports); keys derived from the pairing secret (PBKDF2 → AES-GCM); the relay forwards opaque ciphertext. This is what makes relayed local-model use inherently ZDR.
- **Open files in-app, not the OS**: matches the "stay in the app" goal and fixes the dead click (`openPath` silently fails with no registered `.md` handler); OS hand-off kept only as a "reveal" fallback.
- **Editor is a lightweight textarea**, not CodeMirror/Monaco, honors "simple, not a full IDE" + the small-dependency footprint; markdown gets the existing zero-dep `Markdown` renderer.
- **Browser pane uses Electron `<webview>`** for v1 (DOM-flow, simplest inside splittable panes); `WebContentsView` is more robust but needs main-process bounds syncing across split groups, deferred.
- **Diff/approve snapshots originals** on first agent write, then diffs current-vs-original; writes still happen immediately (tool loop never gated), "reject" reverts, full review/revert UX without blocking the agent.
- **Prompt analyzer is fully client-side** (regex/structural heuristics), instant, offline, free; the marketable always-on feel. LLM rewrite is a later opt-in.
- ~~**Capacitor over React Native for mobile**~~ (superseded 2026-10-03): it was chosen to wrap the shared renderer. Once the phone became its own client (PF21) and gained on-device models (PF22), the reuse argument was gone and llama.cpp needed a real native binding, so the app moved to **Expo + llama.rn** (the stack PocketPal ships on both stores). The full app in a phone browser over the relay remains for people who want every surface.
- **Tags over hierarchical folders** for conversation organization (lighter, less sidebar restructuring).
- **Hand-rolled MCP & push** (JSON-RPC over stdio; APNs/FCM JWTs via `node:crypto`), dependency-free, in keeping with "no native modules" and a lean tree.
