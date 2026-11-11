---
status: accepted
date: 2026-11-11
---

# 0088. Chat secrets reach the agent's commands as environment variables, never the model

## Context

Agents regularly need a credential to finish a job (an API key to call a service, a
token to publish a package). Until now the only way to give one was to paste it into the
chat, where it lands in the transcript, the model's context, the provider's logs, the
chat file and every sync of it. Philip asked for the secrets box other agents have: the
user pastes or types the value, presses Enter, and the agent can use it but never see it
(#2594).

## Decision

- The agent asks with a tool, `request_secret { name, reason }`, which pauses the turn as
  `ask_user` does. `name` is an environment variable name.
- The chat shows a secret box in the conversation. Its value travels on its own channel,
  `chat:provideSecret`, straight to the engine, never through an agent event, the chat
  file, the audit trail, a log, a phone or a paired computer. The waiting call only hears
  "provided" or "skipped".
- The engine keeps the chat's secrets in memory and sets them as environment variables on
  the chat's `bash` and `start_process` commands. The model refers to them by name.
- Every tool result the model or the transcript gets passes through one redaction step in
  the engine (`TurnTools::attended`), which writes each value, as written and
  URL-encoded, as `[secret NAME]`. The shell's live mirror to the Agent commands terminal
  is redacted as it streams.
- Memory only, for now: a restart forgets them and the agent asks again. Keeping them in
  the OS keystore (decision 0046) is the planned next step, behind an explicit choice.

## Alternatives not taken

- **Substituting a placeholder in the command text** (the model writes `{{secret:NAME}}`
  and the engine swaps the value in before running). It works for any tool argument, but
  the value then sits in the command the engine logs, mirrors and shows on approval cards,
  and every place that displays a command would need to undo the swap. An environment
  variable never appears in the command at all.
- **Asking through `ask_user` with a free-text answer.** The answer is persisted as the
  tool result the model reads, which is exactly what this avoids.
- **Writing the value to a file in the workspace** (`.env`). It ends up in the folder the
  agent reads and the user may commit.

## Consequences

- Redaction is a convenience, not a security boundary: a command that transforms the
  value (base64, slicing) can still show it, and a prompt-injected agent could do that on
  purpose. The guardrails, the egress gate (0054) and the outbound DLP (0065) still apply.
- Claude Agent chats and sandbox chats do not get the tool: Claude Code runs its own
  shell, and sandbox commands run in a container that does not receive the chat's
  environment.
