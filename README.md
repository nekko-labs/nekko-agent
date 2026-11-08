# Nekko Agent

**The personal, local agent you can trust.**

An open-source AI agent and model server for coding and everyday work. Run models
on your own computer, bring in supported online providers when you want them, and
choose the folders, context and tools each task can use. Chat, cowork and code in
one app, or use the same engine from the Local Web UI, CLI or MCP.

[Download Nekko Agent](https://github.com/nekko-labs/nekko-agent/releases/latest) ·
[Website](https://nekkoagent.com) ·
[Documentation](https://nekkoagent.com/docs) ·
[Features and limitations](https://nekkoagent.com/docs/features)

Free and open source · MIT licensed · No account needed for local AI · Local work can run offline after setup

## What you can do

- **Run local models in one place.** Search and download models from Hugging Face,
  check GPU fit estimates, and load, unload or keep models ready with the built-in
  Local Model Server. Connect existing Ollama, LM Studio or vLLM servers too.
- **Choose local or online AI per chat.** Use ChatGPT subscription sign-in,
  Anthropic/OpenAI API keys, OpenRouter or compatible endpoints. Claude
  subscriptions run through your installed Claude Code, not a Claude sign-in
  inside Nekko. Features and terms differ by provider; see
  [accounts](docs/accounts.md) and [subscription sign-in](docs/SUBSCRIPTIONS.md).
- **Work with files and review the result.** Read, search and edit across the
  project folders you select. Inspect changes line by line and keep or undo
  native text-tool edits. [File recovery](docs/file-recovery.md) explains
  saved originals, batch edits and what shell or external-editor changes do not cover.
- **See what goes into a request.** The Context Inspector shows files,
  instructions, saved notes and token counts. Use project guidelines and memory
  without including every file in every prompt.
- **Automate repeat work.** Run scheduled tasks manually first, then add a
  schedule or supported event trigger. Review run history and output. The host
  and app must stay running; online services need connectivity, and unattended
  work needs an explicit permission policy. See [automations](docs/automations.md).
- **Delegate and follow progress.** Split independent jobs into sub-agents and
  follow plans, tool activity, verification evidence and PR progress. Reuse skills
  or connect services such as GitHub, Linear, Slack, Discord, Gmail and Drive.
- **Create more than code.** Produce reports, Mermaid diagrams and editable HTML
  prototypes, then find output files again in Library. See the
  [walkthrough](docs/WALKTHROUGH.md) for the workbench and artifact tools.
- **Dictate and monitor.** Use local speech transcription, track online-model
  costs and estimated local savings, and inspect hardware and loaded-model usage.
- **Connect other tools.** Use the CLI and MCP server from Claude Code, Codex,
  Cursor or another compatible client. See [CLI and MCP](docs/CLI.md).
- **Continue from your phone (beta).** Pair the native iOS or Android app to
  follow chats, answer questions and approve commands on your computer. Small
  on-phone models support local chat too. Check the
  [remote-access guide](docs/REMOTE.md) for connection options and availability.

Nekko, the app's cat mascot, keeps you company while your agents work.

## Privacy and control, with clear boundaries

You choose the project folders and command-approval policy. Risky commands can
require approval; the Changes panel lets you inspect native text-tool edits.
**A workspace file jail does not confine shell processes.** Docker provides an
additional isolation option. Context toggles are not operating-system access controls.

[Privacy Shield](docs/privacy-shield.md) can replace supported sensitive values
with placeholders before sending text to cloud models. It uses local pattern
matching, not guaranteed anonymization: images are not redacted, ordinary names
need custom terms, and Claude Code chats bypass the shield. Incognito avoids
saving the chat transcript; it does not make an online provider local.

With downloaded local models and local tools, work can continue offline.
Online models, web tools, downloads, connectors and remote access need a network.
Terminal commands can make their own network requests; Offline mode is not an
OS firewall. See [context, memory and safety](docs/context-memory-safety.md).

Paired-device chat and command traffic is end-to-end encrypted through the relay.
Optional short Lock Screen status notifications pass through Apple/Google push
services as plain text. Managed relay availability is separate from phone-app
availability; use the current [connection guidance](docs/REMOTE.md), rather than
assuming a hosted relay is running.

## Benchmarks

### Apple Silicon: local code edits (October 2026)

On an M5 Max with Qwen3-8B Q4_K_M, Nekko returned a 156-line file with a function
renamed in **2.5 seconds**, versus **13.9 seconds in Ollama 0.40.11**, using the
same GGUF weights. These published medians measure inference replies for one
whole-file rename, **not a complete agent workflow or every coding task**.

Nekko enables llama.cpp's n-gram speculative decoding by default, which helps
when output repeats much of the input. Results vary by workload and hardware;
MLX is faster at plain decode, and speculation adds first-token overhead.
[Method, limitations and raw runs](docs/benchmarks.md).

### Earlier results: NVIDIA RTX 5090 (September 2026)

| Measure | Nekko Agent engine | Ollama 0.23.0 | LM Studio 2.46.0 |
| --- | --- | --- | --- |
| Plain decode, tokens/s ↑ | **154** | 115 | 116 |
| Code edit, tokens/s ↑ | **534** | 106 | 108 |
| Four requests at once, total tokens/s ↑ | **256** | 113 | 210 |
| Return to a paused chat, first token ↓ | **790 ms** | 1,290 ms | 1,600 ms |

Gemma 4 12B Q4_K_M · NVIDIA RTX 5090 · Windows 11 · median of 3 runs ·
30 September 2026. Throughput results are separate from the M5 Max reply timings.
Not ahead everywhere: Ollama starts a fresh long chat faster (1.3 s versus 1.7 s).
[Full comparison and limitations](docs/benchmarks.md#nvidia-rtx-5090-windows-2026-09-30).

## How to run Nekko Agent

### The installer

Download for Windows, Apple-silicon macOS or Linux from the
[latest GitHub release](https://github.com/nekko-labs/nekko-agent/releases/latest).
Check that release's notes and assets for the available builds. Source features
can arrive before an installer includes them.

macOS builds are signed and notarized when release signing is configured;
unsigned fallback builds are possible. Windows builds are currently unsigned,
with SignPath signing in progress according to the website. See
[signing and verification](docs/signing.md) before trusting a downloaded build.

### From source

Use **Node.js 22.12.0 or newer** and the build prerequisites in
[CONTRIBUTING.md](CONTRIBUTING.md). Building the engine requires Rust/Cargo.
From a source checkout:

```bash
npm install
npm run local        # build the desktop app and release daemon, then launch
# Or, for development:
npm run dev          # incremental dev daemon and desktop hot reload
```

### Run the Local Web UI

```bash
npm install
npm run build:nekkod # build and stage the engine for a fresh source checkout
npm run web          # build the UI and CLI, then serve http://localhost:1440
```

The Local Web UI uses the same engine and React UI as the desktop app. A fresh
source setup also needs a built daemon; see [CONTRIBUTING.md](CONTRIBUTING.md).
It binds to localhost by default. Non-loopback access requires authentication
unless explicitly disabled; see the [architecture guide](docs/hub/architecture.md)
for deployment details. Local tasks can work offline after setup, not online providers or connectors.

### Run with Docker

```bash
docker compose up    # build + run, then open http://localhost:1440
```

The app and its file tools run in the container. Mount projects into
`./workspace` and connect a host model server at
`http://host.docker.internal:<port>`. Settings and sessions persist in the
`nekko-agent-data` volume. Compose generates a token; read it with
`docker compose logs` or configure `NEKKO_TOKEN`. Review
[docker-compose.yml](docker-compose.yml) before exposing the service.

## CLI and MCP

The CLI can drive the same engine, and the MCP server exposes it to other agents.
From a source checkout:

```bash
npm run build --workspace=apps/cli
node apps/cli/dist/index.js status --json
node apps/cli/dist/index.js mcp
```

Use `--url http://host:port --token "$NEKKO_TOKEN"` to reach a running Local Web UI.
See [CLI setup](apps/cli/README.md) and the [command and safety reference](docs/CLI.md).

## Develop

```bash
npm run build         # release daemon, shared packages, CLI and desktop
npm run build:nekkod  # release daemon only, staged into desktop resources/bin
npm run build:app     # app packages only; does not rebuild the daemon
npm test              # compliance, Node and Vitest suites
npm run dist          # build and package desktop installers
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for platform prerequisites and the local
workflow. The Rust engine lives in [`crates/`](crates), the desktop app in
[`apps/desktop`](apps/desktop), and the browser runtime in
[`apps/local-web-ui`](apps/local-web-ui). The [architecture guide](docs/hub/architecture.md)
covers the daemon, apps, shared contracts and transports.

## What's next

The [website roadmap](https://nekkoagent.com/#roadmap) describes model routers,
sharing with teammates, planned voice-driven computer control and exploration of
local project-check runners. **Dictation is available; general hands-free
computer control is planned.** Do not assume GitHub Actions compatibility or
that a setting labeled Coming soon is implemented. See
[features and limitations](https://nekkoagent.com/docs/features) and the
[release notes](https://github.com/nekko-labs/nekko-agent/releases) for current availability.

## License

MIT © [Nekko Labs](https://nekkolabs.com). Contributions welcome:
[CONTRIBUTING.md](CONTRIBUTING.md).
