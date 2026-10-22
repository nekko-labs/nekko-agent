<div align="center">

# Nekko Agent

**AI help on your computer. For coding and everyday work.**

Free and open source · MIT licensed · A fast local model server and AI agent in one app

</div>

---

## Overview

Nekko Agent is a seriously fast local model server and an AI agent, together
in one app. Run models on your own computer, bring in ChatGPT or Claude when you
want them, and decide exactly what Nekko gets to touch. A **model** is the AI
that does the thinking; **local** means it runs on your computer instead of
someone else's.

1. **A model server built to be quick.** A Rust core runs llama.cpp tuned for
   the way agents work. On the same model file and machine it decoded at
   **154 tokens/s** against Ollama's 115 and LM Studio's 116, ran code edits
   about **4.5x faster**, and came back to a paused chat about 40% faster than
   Ollama. It is not ahead everywhere: the first turn of a brand-new long chat
   is still slower than Ollama's. Measured 30 September 2026 on an RTX 5090;
   every number, and the harness to rerun them, is in
   [docs/benchmarks.md](docs/benchmarks.md).
2. **Run models and build with them in one place.** Search and download models
   from Hugging Face, see which fit your graphics card, and load them, all inside
   Nekko. Already using Ollama, LM Studio or vLLM? Nekko finds them and puts them
   to work too.
3. **Your favourite models, side by side.** Sign in with your ChatGPT plan, add
   Claude with an API key, or reach hundreds of models (Gemini included) through
   OpenRouter. Mix them with local models per chat or workflow, and hand smaller
   jobs to the cheaper one.
4. **See what you spend, and what you save.** Track what online models cost and
   what local models saved you against cloud prices. Live monitors show your CPU,
   memory, GPU and loaded models while your agents run.
5. **Agents that clock in on their own.** Run an agent on a schedule (check a
   price every morning) or wake it on a trigger (review every new GitHub pull
   request), with a visible history of every run.
6. **Talk instead of type.** Local dictation with Whisper turns your voice into
   text on your own computer, from the desktop or the phone app.
7. **Skip the window, keep the power.** Use the CLI and MCP server from your
   terminal or another agent. Claude Code, Codex and Cursor can hand work to your
   local models through Nekko.
8. **Your agents, in your pocket (beta).** Native iOS and Android apps let you
   start chats, approve risky commands and follow long runs, end-to-end
   encrypted, with everything still running on your computer.

**Share only what you choose.** Letting an AI read a prompt is one thing;
handing it your files, terminal, microphone and network is another. File tools
stay inside the folders you pick, terminal commands follow the approval rules
you set, the microphone is only used when you start dictating, and connectors
are opt-in. The Context Inspector shows what each request sends, and every file
change can be reviewed line by line. Local-only work keeps going offline once
your models are downloaded.

**Nekko**, our pixel-art cat, sits in the corner of the app, blinks, hops and
naps while your agents work, and wakes up when you come back.

Built by [Nekko Labs](https://nekkolabs.com), MIT-licensed, and developed in the
open. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

### Coming soon

- **Model routers.** Let a router pick the model for each request: our upcoming
  open-source Nekko Router, another open-source router, or a paid one with your
  own key.
- **Sharing with friends and teammates.** Share agents, workflows and progress
  with the people you build with.
- **Hands-free computer control by voice** (planned): local intent and speech
  models, scoped app access, confirmations and a stop control. See the
  [planned experience](spec/automation/one-click-setup-for-safe-offline-pc-control.md).
- **Local task runner** (exploring): an alternative to hosted CI for repeat jobs
  such as tests. This is not a claim of GitHub Actions workflow compatibility.

> **Verified working** end-to-end against a live LM Studio server (`google/gemma-4-31b-qat`):
> connect, model listing, streaming, **reasoning models**, and the full tool-calling
> agent loop (single- and multi-step). Run `node scripts/itest-local.mjs <baseUrl> <model>`
> to check your own server.

![Nekko Agent, unified chat with the Context Inspector](docs/screenshots/chat.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/models.png" alt="Models, local + cloud providers with usage analytics" /></td>
    <td width="50%"><img src="docs/screenshots/guardrails.png" alt="Settings, sandbox modes and guardrail rules" /></td>
  </tr>
</table>

> A full picture-by-picture tour is in the **[walkthrough guide](docs/WALKTHROUGH.md)**.

## How to run Nekko Agent

**1. Download the installer.** Grab it for your OS from the
[latest GitHub release](https://github.com/nekko-labs/nekko-agent/releases/latest)
or [nekkoagent.com](https://nekkoagent.com): Windows NSIS `.exe`, macOS `.dmg`,
or Linux `.AppImage`/`.deb`.

**2. Run it locally from source.** Easiest and fastest, and the way to see your
changes while working on it:

```bash
npm install
npm run local        # builds everything, then launches the desktop app
npm run dev          # npm install, incremental build (including nekkod), then launches with hot reload
```

**3. Run it in Docker.** Safest option: the app, its file tools, and your
workspaces stay inside the container.

```bash
docker compose up    # build + run, then open http://localhost:1440
```

**4. Run the Local Web UI.** The backup approach when you don't plan to use the
desktop app: the same engine and same UI in your browser, fully offline.

```bash
npm run web          # builds everything, serves http://localhost:1440
```

Details for each are below: [signing and the installer](#the-installer),
[Docker](#run-with-docker), and the [Local Web UI](#run-the-web-edition).

### The installer

Release macOS builds are signed with a Nekko Labs Developer ID certificate and
notarized by Apple when the macOS signing secrets are configured, so the `.dmg`
opens and installs normally with no Gatekeeper workaround. If those secrets are
absent, the workflow publishes an unsigned fallback build; clear its quarantine
flag once with `xattr -cr "/Applications/Nekko Agent.app"`. Verify a signed build
yourself if you like:

```bash
spctl --assess --type execute --verbose=4 "/Applications/Nekko Agent.app"
```

That should report `accepted` with `source=Notarized Developer ID`. How this is set up: [docs/signing.md](docs/signing.md).

Windows installers are signed when the release signing secrets are configured.
Unsigned fallback builds show an "unknown publisher" SmartScreen prompt: choose
**More info → Run anyway**. The NSIS installer receives desktop updates; Linux
AppImage/deb and macOS DMG releases include their updater metadata. A release
installed from a manually downloaded artifact may still require the matching
installer format for updates.

#### macOS says the app is damaged and can't be opened

**Releases before v0.6.0** are unsigned. macOS quarantines them and may say the app is *damaged* or move it to the Trash. The app is fine; clear the quarantine flag once with `xattr -cr "/Applications/<app name>.app"`, or take a current signed build. From v0.6.0 on, macOS builds are signed with a Developer ID and notarized.

### Uninstalling

- **Windows**: *Settings → Apps → Installed apps → Nekko Agent → Uninstall*, or the **Uninstall Nekko Agent** shortcut in the Start Menu folder. The uninstaller asks whether to also delete your chats and settings (choose **No** to keep them for a reinstall).
- **macOS**: drag **Nekko Agent** from Applications to the Trash. To also remove data: `rm -rf "$HOME/Library/Application Support/Nekko Agent"`.
- **Linux**: remove the AppImage, or `sudo apt remove nekkoagent` for the `.deb`.

## Why Nekko Agent

**Use the hardware you already have, with frontier help when it matters.**
Nekko Agent reads, edits, searches, and runs inside your codebases, combining
local models, a multi-folder index, per-project memory, and guardrails with
frontier providers in one agent environment.

**Keep your preferred way of working.** Use the workbench to browse files,
review diffs, and inspect context, or connect its local agent capabilities to
your existing harness over CLI/MCP. Choosing a local model should not mean
giving up the tools that make an agent useful.

## Editions

Same engine, same UI, multiple runtimes (see the design in the project spec):

| Edition | How | Status |
| --- | --- | --- |
| **Desktop** | Electron app / `npm run dev` | ✅ available |
| **Self-hosted web** | `npm run web`, offline, the same UI in your browser | ✅ available |
| **Docker** | `docker compose up`, workspaces as volumes, local models via `host.docker.internal` | ✅ available |
| **Phone remote control** | pair your phone (QR, one-time code) and run chats/training/goals on your home machine from anywhere, end-to-end encrypted; the iOS/Android app also runs small models on the phone itself; managed relay free in beta, or [self-host it](docs/REMOTE.md) with one Docker command | ✅ available |
| **Nekko Cloud** (paid) | managed hosting: subscriptions, always-available **Zero-Data-Retention** mode, cloud chat-history + file management | 🔜 planned |

The desktop, web, and Docker editions all run the **same engine + same React UI**, only the transport differs (Electron IPC vs HTTP/WebSocket): the engine is `nekkod`, a Rust daemon each edition starts.

### Run the Local Web UI

```bash
npm install
npm run web        # builds everything, then serves at http://localhost:1440
```

Same app, in your browser, fully offline. It binds to `localhost` by default. A
non-loopback bind refuses to start unless `NEKKO_TOKEN` is set; use
`Authorization: Bearer <token>` for API requests and append `?token=…` only for
browser WebSocket access. If a trusted reverse proxy provides authentication,
the explicit escape hatch is `NEKKO_ALLOW_UNAUTHENTICATED=1`. Host and Origin
checks can be extended for a proxy with comma-separated
`NEKKO_ALLOWED_HOSTS` and `NEKKO_ALLOWED_ORIGINS`. Data lives in
`~/.nekko` (override with `NEKKO_DATA_DIR`).

![Nekko Agent Local Web UI](docs/screenshots/web-edition.png)

### Run with Docker

```bash
docker compose up        # build + run, then open http://localhost:1440
```

Mount your codebases into `./workspace` (the sandbox confines file tools there),
and reach a model server on your host at `http://host.docker.internal:<port>`.
Settings/sessions persist in the `nekko-agent-data` volume.
Compose generates and prints a random token; read it with `docker compose logs`
(or set your own `NEKKO_TOKEN`) before exposing the service beyond localhost.

Cloud keeps inference and tools **on your machine**, the relay is an
end-to-end-encrypted pipe to a paired local agent, so using your own model stays
private by design.

## Features

- **Unified chat / cowork / code**: one thread, no mode switching.
- **Built-in model server**: a Rust core driving llama.cpp that downloads, loads and serves
  models from Hugging Face, with GPU fit estimates and keep-loaded controls.
- **Local runners too**: auto-discover Ollama / LM Studio / vLLM; pull, load, and
  unload Ollama models; manage servers and watch token usage.
- **Cloud providers too**: ChatGPT plan sign-in, Anthropic, OpenAI, OpenRouter, any OpenAI-compatible endpoint.
- **Spend and savings**: API spend, estimated savings from local models, and live hardware and model monitors.
- **Automations**: workflows on a schedule or an event trigger, such as a GitHub pull request.
- **Voice dictation**: Whisper Tiny English, transcribed on your computer.
- **Skills**: a library sorted by job with every step visible, plus a marketplace.
- **Context Inspector**: see exactly what enters the prompt (files, guidelines,
  memory, connectors) with live token counts; toggle and pin anything.
- **Guardrails**: risky commands (`rm -rf`, force push, `curl | sh`, …) prompt
  before running; configurable allow / ask / deny per rule.
- **Sandbox**: workspace-jail by default, optional Docker isolation, or ask-everything.
- **Multi-folder index**: add multiple roots; file + symbol index with fast search.
- **Memory**: global and per-project, stored as plain markdown.
- **Connectors**: GitHub, GitLab, Linear, Jira, Slack, Discord, Microsoft Teams, Gmail, Google Drive, Trello, Asana, Todoist.
- **Nekko the mascot**: a pixel-art cat that blinks, hops, works and naps in the corner of the app.

## Architecture

A Cargo workspace (the engine) beside an npm-workspaces monorepo (the apps):

| Package | What |
| --- | --- |
| [`crates/nekkod`](crates/nekkod) | The engine daemon every edition starts: chats, tools, providers, automation, the model server, the phone relay agent. Built from the other crates in [`crates/`](crates). |
| [`packages/shared`](packages/shared) | Types + IPC contracts (pure, no deps) |
| [`packages/profile`](packages/profile) | The user's data folder: where it lives, moving it, older installs' profiles |
| [`apps/desktop`](apps/desktop) | Electron app (main / preload / React renderer) |
| [`apps/local-web-ui`](apps/local-web-ui) | Self-hosted Fastify Local Web UI |
| [`apps/relay-server`](apps/relay-server) | End-to-end encrypted remote relay |
| [`apps/cli`](apps/cli) | CLI and MCP stdio subagent surface |

The engine has no Electron in it, so it is tested on its own (`cargo test --workspace`) and every edition reuses it.

## CLI and MCP subagent

External harnesses can drive the same host through the CLI or MCP server:

```bash
npm install --global nekko-agent   # publishing with the next release
npx nekko-agent status --json
npx nekko-agent mcp
```

From a checkout:

```bash
npm run build --workspace=apps/cli
node apps/cli/dist/index.js status --json
node apps/cli/dist/index.js mcp
```

Use `--url http://host:port --token "$NEKKO_TOKEN"` for a running web
edition. Chat defaults to guardrails approval; see the complete command list,
machine-output schemas, safety model, MCP registration examples, and recipes
in [docs/CLI.md](docs/CLI.md).

## Develop

```bash
npm install
npm run build:core   # build shared + core
npm test             # vitest (guardrails, context, outline)
npm run dev          # launch the desktop app with hot reload (electron-vite)
```

### Build the app and engine

```bash
npm run build         # release nekkod + app (TypeScript packages, CLI, desktop)
npm run build:nekkod  # release Rust daemon only, staged into desktop resources/bin
npm run build:app     # TypeScript packages, CLI and desktop only; no Rust build
```

The combined build requires Rust/Cargo and fails if the daemon cannot be built.
`build:nekkod` also checks the usual `~/.cargo/bin` installation when Cargo is not
on PATH, and stages the runtime sidecar libraries alongside the executable.
`build:app` does not update an already staged daemon; use the combined build after
changing Rust code.

### Test your changes locally (no installer, no Defender)

After making changes, run **one** command to build and launch the real app for
your current OS, no need to download the released installer:

```bash
npm run local        # build everything + launch the built desktop app (Windows/macOS)
npm run web          # build + serve the Local Web UI at http://localhost:1440
```

`npm run local` builds the production renderer/main and runs it via
`electron-vite preview` (no `electron-builder`, so it sidesteps the MSI/Defender
step). Run it on each OS to test that OS's build; `npm run web` covers the
browser. For a tight loop, `npm run dev` has hot reload.

Build installers:

```bash
npm run dist         # electron-builder → apps/desktop/release
```

Releases are published to GitHub Releases by the [release workflow](.github/workflows/release.yml)
on `v*` tags. Download links point to the [latest GitHub release](https://github.com/nekko-labs/nekko-agent/releases/latest).

## License

MIT © Nekko Labs
