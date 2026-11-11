---
title: "Secrets in chat: give the agent a key it uses but never sees"
area: chat
---

# Secrets in chat: give the agent a key it uses but never sees

Tracked by [#2594](https://github.com/nekko-labs/nekko-agent/issues/2594). Decision: [0088](../../docs/decisions/0088-chat-secrets-reach-commands-never-the-model.md).

**User intent (Philip, 2026-11-11):** a secure way to add secrets in the chat, as other agents do: a secrets box where you hit Paste, or paste or type it yourself, and press Enter. The agent never sees it. It belongs in the conversation, like the commands the agent asks to run.

## How it works

`[implemented in source; daemon-tested and unit-tested; desktop and Local Web UI; visual evidence in the PR]`

- **The agent asks by name.** A new tool, `request_secret`, takes `name` (an environment variable name, such as `OPENAI_API_KEY`) and `reason` (one line: what it is for and where to get it). It is offered wherever `ask_user` is (a person reads the chat: not sub-agents, automations, workflow or goal runs), stays a direct call in code mode, and counts as an agent tool, so an offline chat keeps it. Its description tells the model to use it instead of asking for a secret in the chat, and to refer to the value only by name.
- **The secret box.** The turn waits, and the chat shows a box under the reply, where the question cards go: a lock, the variable name, the agent's reason, a masked field, **Paste** (reads the clipboard into the field without showing it), **Show**/**Hide**, **Skip** and **Provide** (Enter). The field is `type=password`, with autofill, spellcheck and password-manager prompts off. One line says the agent never sees it and that its commands use `$NAME`. While it waits, the chat counts as needing you (the board lane, the status line "Waiting for NAME") and a desktop notification says "Nekko Agent needs a secret" with the name.
- **The value takes its own road.** The box sends it on `chat:provideSecret` (session, call, value or `null` for Skip) straight to the engine. The engine keeps it in memory for that chat and then releases the waiting call, which only hears that it was given. The value is in no agent event, no chat file, no audit entry, no log and no model request. The pane clears the field once it is sent and keeps nothing.
- **Commands use it.** From then on every `bash` and `start_process` command in that chat has it as the environment variable (`$NAME` in sh, `$env:NAME` in PowerShell, `%NAME%` in cmd). The model reads: "The user provided NAME. Every bash and start_process command in this chat now has it as the environment variable NAME (until the app restarts)."
- **Output is redacted.** Any tool output that contains the value, as written or URL-encoded, reaches the model, the transcript and the live events as `[secret NAME]`, whichever tool brought it back (a shell command, a file read of a `.env`, a fetched page, an MCP result). The **Agent commands** terminal shows the same: a shell command's output is redacted as it streams, holding back a few characters so a value split across two chunks is still caught. Values shorter than 4 characters are set but not hunted for in output (they would blank out ordinary words).
- **Skip** tells the agent the user chose not to give it and not to ask again unless they bring it up. An unattended chat (with the unattended limit set) that nobody answers in time gets the same, worded for the timeout. Stopping the turn drops the box.
- **Lifetime.** Secrets live in the engine's memory per chat: a restart of the app or the engine forgets them, and deleting the chat drops them. Sub-agents (`spawn_agent`) do not inherit them.

## Acceptance

- The daemon test `a_secret_reaches_commands_and_never_the_model_or_the_chat` drives a scripted model through `request_secret`, `chat:provideSecret` and `echo $NEKKO_T_TOKEN`: the command's output reads `[secret NEKKO_T_TOKEN]`, and the value is in no event, the saved chat or any request sent to the model. A call from another chat, or one nobody waits on, cannot set a secret.
- `nekko-tools` tests: the value reaches a real shell's environment and is redacted from the result and the Agent commands terminal; a value split across output chunks is still caught; `Debug` never prints a value.
- Renderer tests: the box names the variable and reason, masks the field, keeps it out of autofill and cannot send an empty value.

## Privacy and security boundaries

- Redaction catches the value as written and URL-encoded. A command that transforms it (base64, reversing it, printing a slice) can still show it to the model; the tool description tells the model never to, and a prompt-injected agent could. The secret box is about keeping the value out of the chat and the model's context in ordinary work, not a defense against an agent that is trying to leak it. Guardrails, the egress gate and the outbound DLP still apply to commands that would send it somewhere.
- `start_process` output is redacted chunk by chunk in the Agent commands terminal (a long-running process has no end to flush at), so a value split across two reads can show there; what the agent reads through `read_process` is always redacted whole.
- `chat:provideSecret` is not a phone, paired-computer or messaging channel: a secret is only given on the computer itself (or its Local Web UI).

## Not done yet

- `[planned]` Remembering a secret across restarts (in the OS keystore, decision 0046), a list of a chat's secrets to remove one, and reusing one secret across chats.
- `[planned]` The phone apps: the request reaches them as a plain wait, without the box (iOS and Android issues are linked from the gaps table in [ios-and-android-stay-in-step](../phone/ios-and-android-stay-in-step.md)).
- `[not covered]` Claude Agent chats (Claude Code runs its own tools and is never offered `request_secret`) and sandbox chats (their commands run in a container that does not get the chat's secrets; the tool is not offered there).
- `[unverified]` The packaged desktop app on macOS and Linux, and the Local Web UI in a browser other than the hidden Electron fixture.
