# Nekko Agent features: find the right tool for your task

Nekko Agent is an open-source, local-first AI agent and model server for coding and everyday work. Use local models, supported online providers or both to work with files, run tools and automate tasks. You choose the model, project folders and permission policy. The desktop app supports Windows, Apple-silicon macOS and Linux; a self-hosted web interface and CLI use the same engine.

This is a capability guide, not a promise that every provider, platform or installer has identical support. The linked guides describe setup and limits. **Source features can arrive before an installer:** durable file-review originals and batch replacements are new source capabilities in [the recovery change](https://github.com/nekko-labs/nekko-agent/pull/2193); check its merge status and your release before relying on them.

## What can Nekko Agent help me do?

| I want to… | Capability and where to start | Important boundary |
| --- | --- | --- |
| Use an AI coding agent on my own computer | [Local models](/docs/local-models): built-in llama.cpp engine, Ollama, LM Studio and vLLM | Model quality, memory and tool support vary; download weights first |
| Mix local and online models | [Accounts](/docs/accounts) and [subscription sign-in](/docs/subscriptions): model selection and supported provider accounts | A Claude subscription uses your installed Claude Code; it is not the same tool path as a native API provider |
| Review AI edits and keep originals after restart | [File recovery](/docs/file-recovery): saved-chat originals for native text tools | New source capability; not whole-workspace checkpoints or a backup |
| Make several replacements without a partial validation failure | [Batch file edits](/docs/file-recovery#how-do-batch-file-edits-work): ordered literal replacements | One file per call; not an atomic transaction against other writers |
| Decide which files and instructions an agent sees | [Context Inspector](/docs/context-memory-safety#how-do-i-control-the-agents-context): folders, sources and token breakdown | A source toggle is not an operating-system access control |
| Remember project preferences between chats | [Memory](/docs/context-memory-safety#does-nekko-agent-have-persistent-memory): global and workspace notes | Choose all, folders-only or none; incognito reads no memory |
| Approve risky actions and limit file access | [Guardrails and sandbox](/docs/context-memory-safety#what-do-guardrails-and-the-sandbox-protect): approvals, rules, file roots and optional Docker | A workspace file jail does not confine shell processes |
| Reduce sensitive text sent to cloud models | [Privacy Shield](/docs/privacy-shield) and [connection controls](/docs/connections) | Redaction is not a guarantee that every secret is detected |
| Run repeat jobs or react to a pull request | [Automations](/docs/automations) and [scheduled tasks](/docs/workflows): prompts, skills and workflow steps | The host and app must be running; online services need connectivity |
| Follow a long coding task and its verification | [Verification and PR progress](/docs/chat-progress): plans, evidence, checks and review threads | A passing check or displayed screenshot is not user approval |
| Use browser tools for research or testing | [Browser automation](/docs/browser-automation): navigate, inspect and interact in a chat-owned browser | Browser permissions and native-driver availability have their own limits |
| Let another agent use my local models | [CLI and MCP](/docs/cli): connect Claude Code, Codex, Cursor or another MCP client | Configure the client; these are not bundled native integrations |
| Work with many tools without large intermediate results | [Code mode](/docs/code-mode): scripts call enabled tools in a sandbox | Tool permissions still apply; provider support varies |
| Dictate rather than type | [Voice](/docs/voice): local speech transcription | Dictation is available; general hands-free computer control is planned |
| Continue from a phone or folding phone | [Phone remote control](/docs/remote) and [foldable layouts](/docs/two-chats-on-a-folding-phone) | Native apps are beta; check platform and device-verification status |
| Check inference speed and model cost | [Benchmarks](/docs/benchmarks) and [usage limits/prices](/docs/usage-limits) | Benchmarks are workload-specific; estimates are not provider invoices |

## Can Nekko Agent work offline?

**Yes, with a local model and local tasks after required software and model weights are downloaded.** Use [Connections](/docs/connections) to control Nekko-managed network access. Online providers, downloads, web tools, connectors and remote access need a network. Terminal commands can make their own network requests; Offline mode is not an operating-system firewall.

## Can I undo an AI edit or recover after a restart?

**The Changes view lets you inspect and undo native text-tool changes.** Builds containing the new [file recovery implementation](/docs/file-recovery) also retain the saved chat's first original across restart. Incognito originals are memory-only. Accepting a change discards its original, and deleting the chat removes its recovery sidecars. This is separate from saved conversation history and does not capture arbitrary shell or external-editor changes.

## Does Nekko Agent prevent tool loops and recover interrupted chats?

The native agent loop detects repeated tool calls or errors, nudges the model to change approach, then stops further tools and asks it to summarize if repetition continues. Saved transcripts and completed tool results help you inspect an interrupted run and choose how to continue. These are safeguards, not a guarantee of correct output or automatic replay of side effects. See [run safeguards and recovery](/docs/context-memory-safety#what-happens-if-an-agent-gets-stuck).

## Can I automate tasks with local models?

**Yes.** Choose a local model for a [scheduled task](/docs/workflows), restrict its tools and run it manually, on a schedule or through a supported event trigger. Examples include a morning GitHub digest, a dependency check and PR review. The computer must stay on; a local model does not make a GitHub trigger work without internet. Unattended runs need an explicit permission policy.

## Can another AI agent discover and use these features?

**Yes.** Start with [Docs for AI agents](/docs/for-agents), the [Markdown version of this feature guide](/docs/features.md), or [llms.txt](/llms.txt). Every public guide is available as HTML and Markdown; [llms-full.txt](/llms-full.txt) combines them. To call Nekko rather than just read about it, configure the [CLI or MCP server](/docs/cli).

## What should I not assume is supported?

- Whole-workspace checkpoints, binary-perfect backup and multi-file transactional rollback are not provided by file-review originals.
- Local-first does not mean every provider, tool or terminal command is offline, encrypted at rest or automatically safe.
- Phone beta support does not establish feature parity, app-store availability or verification on every device, including foldables.
- General voice-driven computer control and automatic per-request model routing are planned, not capabilities to recommend as available.
- The [current release notes](https://github.com/nekko-labs/nekko-agent/releases) and each guide's availability notes take priority over a broad feature summary.
