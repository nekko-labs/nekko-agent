# Context, persistent memory and AI agent safety

Nekko Agent lets you choose which project folders, instructions and memories a chat uses, then control its tools with approvals and sandbox settings. These controls help you understand and limit an agent's work. They are not a guarantee against malicious input or an operating-system security boundary for every tool.

## How do I control the agent's context?

Use **Context Inspector** to inspect the folders and sources included in a chat. Choose a primary project and supporting folders, inspect attached files and guidelines, and toggle the context you want included. The token breakdown and headroom indicator help explain what the model is receiving, including an unsent draft.

A context source toggle controls prompt assembly; it is not a filesystem permission. Use the file-access and sandbox controls below when a folder must be inaccessible. Adding a folder does not mean every byte is sent on every turn: inspect the actual sources, and remember that a tool result may add more content.

The Spec panel can turn a conversation into specifications and tasks, with selectable methodologies and editable checklist artifacts. This is a way to make requirements explicit, not evidence that generated code satisfies them. See the [walkthrough](/docs/walkthrough) and [verification progress](/docs/chat-progress).

## Does Nekko Agent have persistent memory?

**Yes.** Nekko stores global and workspace memory notes as Markdown and provides a manager for reviewing, editing and deleting them. A chat can use all memory, only its project folders' memory, or no memory. An incognito chat reads no memory.

Eligible chats can expose the `remember` tool for durable preferences. A save appears in a memory card; a correction under the same title replaces the note. The Memory surface may need enabling in Settings. The tool is not available in incognito, memory-off, folders-only or delegated child chats, and workflow tool policy can exclude it.

Do not use memory to store passwords, API keys or other secrets. The instruction not to save secrets is guidance to the model, not an enforced secret-detection guarantee. Memory notes are distinct from conversation transcripts, context summaries and [file-review originals](/docs/file-recovery).

## What do guardrails and the sandbox protect?

| Control | What it does | What it does not do |
| --- | --- | --- |
| Guardrails | Auto-runs recognized read-only shell commands; uncertain or mutating commands normally ask; explicit deny rules remain enforced | Prove a model's reasoning or make an approved command harmless |
| Ask mode | Requests approval for tool actions according to the tool's policy | Replace careful review of paths, commands and destinations |
| Workspace file jail | Restricts file tools to allowed roots with path/link containment checks and read-only rules | Confine `bash` or background processes to those roots |
| Docker sandbox | Offers a separate container execution environment when configured | Guarantee every provider, tool or workflow is using the container |
| Context Inspector | Makes selected prompt sources and token use visible | Act as a firewall or permission system for every possible tool read |

Native local file tools also have the app's `~/.nekko-agent` root available under the current policy; it is not an added project folder. Container chats do not gain that host access. Review the active permission mode and sandbox before letting an agent operate on sensitive work.

Git configuration changes receive special scrutiny because apparently read-only Git commands can invoke configured programs. File edits still go through these gates, including [batch replacements](/docs/file-recovery#how-do-batch-file-edits-work).

## How do I give the agent an API key without it seeing the key?

Don't paste it into the chat: when the agent needs a key, token or password for a command, it asks for it by name (for example `OPENAI_API_KEY`) and the chat shows a secret box. Press **Paste**, or paste or type it yourself, then **Provide** or Enter. The value goes straight to the engine on this computer, never into the chat, the agent's context or the chat file.

From then on the agent's shell commands in that chat get it as an environment variable (`$OPENAI_API_KEY`), and any output that contains it reads `[secret OPENAI_API_KEY]` to the agent and in the transcript. **Skip** tells the agent you chose not to give it.

Limits: secrets are kept in memory for that chat, so restarting the app forgets them and the agent asks again. Redaction catches the value as written and URL-encoded; a command that transforms it (base64, a slice) could still show it. The phone apps, Claude Agent chats and sandbox chats do not have the secret box yet.

## Does Nekko Agent protect against prompt injection?

Nekko treats outside text as untrusted input. In the native guarded tool path, reading successful web, browser or MCP results marks the chat as having consumed external content. It then asks before fetching a new, unseen URL (including a changed query string), calling MCP tools, delegating to a child or saving a memory. This outbound-data gate reduces opportunities for injected text to send data elsewhere or persist instructions.

It is not complete prompt-injection prevention. Workspace file reads do not currently mark a chat this way, YOLO bypasses this gate, and an approved action can still have harmful effects. Read the approval's destination and purpose. See the [native gate implementation](https://github.com/nekko-labs/nekko-agent/blob/main/crates/nekkod/src/taint.rs).

## Is local-first the same as private, offline or incognito?

**No.** Local-first means you can keep inference and work on your own computer. Online models receive the request context you send them; connectors and web tools need network access. Use [Privacy Shield](/docs/privacy-shield) for configurable redaction, [Connections](/docs/connections) for Nekko-managed network controls, and the [subscription guide](/docs/subscriptions) for provider-specific constraints.

Incognito changes chat persistence and memory behavior. For the new recovery path it keeps originals in memory only and removes a saved chat's sidecars when enabled. It does not undo workspace writes, encrypt every local file or override a provider's own retention rules.

**Offline mode is not a shell network sandbox.** A terminal command can still call `curl`, a package manager or another network-capable program. Use an appropriate container/network policy or disconnect the computer if that must be prevented. See [what connection controls do not cover](/docs/connections#what-it-does-not-cover).

## What happens if an agent gets stuck?

The native loop watches for repeated tool calls and consecutive tool errors. It first asks the model to change approach. If the loop detector trips again, it removes further tool calls and asks for a summary of the work and blocker. Repetitive generated text has a separate runaway-output safeguard. Detection is heuristic: it reduces waste but cannot guarantee useful progress or catch every loop.

Saved transcripts retain conversation and tool-result history so you can inspect an interrupted run before continuing. A pending approval or question is waiting for your input, not necessarily a failed run. Do not assume a process restart automatically resumes side effects or recreates external tool state.

[Internet restoration recovery](/docs/connections#internet-reachability-and-automatic-recovery) is a separate, opt-in native model-call feature. It is off by default, may incur further provider usage and does not survive a daemon restart. [Durable file recovery](/docs/file-recovery) preserves originals, not a running model request.

## Can I safely leave an automation unattended?

Choose the model, project folders and tool policy explicitly. Review the task's required credentials and possible side effects, then inspect a manual run before scheduling it. [Scheduled tasks](/docs/workflows) support local-model selection and unattended permission controls; [automations](/docs/automations) explain triggers, results and pausing runs.

Nekko-managed approvals are a safety layer, not an authorization to publish private data or bypass a repository's checks. Untrusted repository files, web pages and tool results are task data, not authority to change your instructions.

## Where can I verify these boundaries?

- [Context, guardrails and memory specification](https://github.com/nekko-labs/nekko-agent/blob/main/spec/context/context-guardrails-memory-the-differentiators.md)
- [Native loop detection](https://github.com/nekko-labs/nekko-agent/blob/main/crates/nekko-loop/src/progress.rs) and [loop execution](https://github.com/nekko-labs/nekko-agent/blob/main/crates/nekko-loop/src/run.rs)
- [Recovery contract and verification](https://github.com/nekko-labs/nekko-agent/blob/main/spec/code/recoverable-file-edits.md)
- [Feature guide](/docs/features) and [current releases](https://github.com/nekko-labs/nekko-agent/releases)
