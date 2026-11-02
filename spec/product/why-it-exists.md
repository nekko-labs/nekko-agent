---
title: "Why It Exists"
area: product
split-from: SPEC.md (2026-10-22)
---

# Why It Exists

## Development build workflow

`npm run dev` runs `npm install` (about 2 seconds when nothing changed, so a pull that changed dependencies never launches against stale modules), then rebuilds the Rust daemon and every workspace the app imports before starting the desktop development server with hot reload, so it never runs stale output; a failed build prevents startup. It skips the production desktop bundle (electron-vite dev builds its own) and compiles the daemon with the `dev-daemon` Cargo profile (release optimizations without LTO, incremental), which the development app runs straight from `target/` as the newest local build: a one-file daemon change rebuilds in about 9 seconds instead of a minute. `npm run build` and packaging still use the release profile. Production renderer builds retain lazy diagram loading and all supported Mermaid layouts; build optimizations must preserve diagram rendering and normal application tree shaking.

People who want to run AI models locally are stuck choosing between two kinds of tool, each blind in its own way:

- **Local chat UIs (LM Studio, Ollama front-ends)** are *chat-only*, a great model runner with a chat box, but with no awareness of your files or projects. The model can talk about your work but can't actually do it.
- **Terminal CLIs (Claude Code, aider)** have agentic power but are *blind*, you can't see what changed without `git diff`, and editing means leaving the tool.

Nekko Agent exists to collapse that gap: easy local-model setup **and** a model that works inside your real codebases, with everything it does visible.

## Positioning (carry into website + README)

**AI help on your computer. For coding and everyday work.** Lead with what people can do: get help writing and coding, automate repetitive tasks, and choose AI running on their computer or an online service. Explain that a model is the AI they choose, and local AI runs on their own computer. Do not require readers to understand "frontier", "harness", "runtime", "CLI", or "MCP" before they understand the benefit. Technical setup details remain available farther down the page with short explanations.

The five main marketing headings are **Use AI on your computer or online**, **Choose the right AI for the job**, **Automate repetitive work**, **Manage your AI models in one place**, and **Control your computer by voice** (visibly Planned). Section titles describe concrete actions rather than agent/spy metaphors. Nekko Agent complements existing tools instead of requiring people to abandon their preferred interface; its differentiator remains combining available local compute with online models. Simplifying the language must preserve setup requirements, paid-provider costs, privacy boundaries, and the distinction between available and planned features.

## Messaging pillars

1. **Frontier and local, working together.** Use Nekko Agent as your primary harness/UI, or connect through its CLI and MCP from compatible tools such as Claude Code, Cursor, Codex, and OpenClaw. Bring your own frontier providers and local model servers.
2. **The right model for the task.** Help users select models for a prompt and delegate concrete work to local or cheaper models while reserving frontier capability for demanding planning. Local inference can avoid per-token API charges but still uses hardware, power, memory, and time. Explain routing decisions and never silently cross an offline boundary.
3. **Automation in one place.** Manage scheduled tasks, watchers, and workflows alongside interactive agent work. Reusable procedures support agent, skill, shell, and nested workflow steps with bounded retries and visible outcomes.
4. **Simpler model management.** Discover and connect local runtimes, manage supported model lifecycle actions from the same app, and mix managed and existing servers as support grows. Installing and supervising an inference runtime so a separate server app is unnecessary is a product goal, not a claim that an inference engine is already bundled.
5. **Control your PC offline, with safeguards.** Tell Nekko what you want by text or voice and let it perform supported local computer actions within permissions you choose. One-click guided setup selects a compatible local intent LLM, text-to-speech (TTS), optional speech-to-text (STT), and required runtimes based on the machine and each component's minimum requirements. The experience includes model/setup explanations, action previews, sensitive-action confirmations, and an immediate stop control. This is a major planned product capability, not available in the current release.

## Roadmap: beyond one machine

These are aspirations, not generally available capabilities or launch promises:

- **Team hardware and distributed work:** opt-in workers pool available machines for model inference, agent tasks, and workflows, with permissions, capacity reporting, isolation, cancellation, and clear ownership.
- **Local task runners:** expand today's local shell/agent workflow foundation into a practical alternative for jobs otherwise consuming hosted CI credits. GitHub Actions workflow compatibility and untrusted pull-request execution require their own design and security review; neither is implied by local shell steps.
- **Team workflows:** shared definitions, run coordination, access controls, and auditable outcomes across a team.
- **Optional cloud runners:** explore only if users want them. A paid service must remain optional and must not weaken the local-first experience.
- **Phone app as its own client:** `[in build 2026-10-03]` the phone app no longer wraps the desktop renderer. It is a purpose-built native app (see "Your agent in your pocket" below) that drives the user's own machine over the relay, in the spirit of Claude Code on the phone: start, follow, approve, and message runs, with push when a run finishes. Philip chose (2026-10-03) to put **on-device local models** in the same app rather than a separate product, so the phone keeps working when the computer is off. Still roadmap: the same client for **cloud runners**, and MLX on iPhone if llama.cpp's Metal path falls short.
- **Native desktop shell:** a GPU-rendered native UI (GPUI or similar) remains an option once the Rust engine daemon owns the engine. It is deferred: the desktop UI stays web technology (Electron + React) for maintainability, and the speed contract below is met there first.

Existing cloud prototypes and older branding elsewhere in this spec describe implementation history or parallel work, not a requirement to launch a hosted product before the local Nekko Agent experience.
