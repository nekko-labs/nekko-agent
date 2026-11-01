---
title: "Routing a Claude Agent chat between a local model and Claude Code"
area: agents
---

# Routing a Claude Agent chat between a local model and Claude Code

`[planned 2026-11-01; spec only, nothing built]` Decision: [0037](../../docs/decisions/0037-route-each-message-once-to-a-local-model-or-claude-code.md). Policy: [Claude policy](../product/claude-policy.md).

## User intent

A Claude Agent chat (provider kind `claude-code`) runs every message on the user's own Claude Code, often on a Claude Pro or Max plan. Many messages in such a chat do not need Claude Code: "what does this error mean", "reword this paragraph", "translate this", a quick question about a reply already on screen. Those spend plan usage and wait on a full Claude Code turn when a model already loaded on the machine could answer in a second, privately and for free.

Philip wants a Claude Agent chat to decide, per message, whether a local model answers it or Claude Code runs it, to always show which one did, and to let the user overrule it with one click or pin the chat to one engine. On a Claude plan this must stay inside Anthropic's terms: Claude Code is used by a person, through the unmodified binary, one message at a time.

## What is permitted, and why

Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page (read 2026-11-01) and the Consumer Terms (section 3) let a plan be used only through the user's own Claude Code, by a person: the Consumer Terms forbid reaching the service "through automated or non-human means" except with an API key or where Anthropic allows it. An API key or a cloud account (Bedrock, Vertex, Foundry) carries no such limit. So the router has two shapes:

| | Claude plan, and `unknown` | API key, cloud |
|---|---|---|
| Route a person's message once, before the turn, to local or Claude Code | yes | yes |
| Claude Code receives the message exactly as typed | always | default; context carry allowed (below) |
| Carry earlier local turns into the Claude Code turn (a summary or quoted block added by Nekko) | no: same footing as `context_note` (`awaiting_approval`) | yes, behind `context_note` |
| A local agent calls Claude Code as a tool or sub-agent, or loops between engines | no: a turn no person sent, the "automated or non-human means" the terms rule out | allowed by the terms; not in v1 (would get its own policy row) |
| Re-send to Claude Code automatically when a local answer fails or looks weak | no: only a person's click starts a Claude Code turn | not in v1 |
| Route to another Claude account, or away from one because its plan is running low | never, on any auth (see [accounts and switching](../models/accounts-and-switching.md)) | never |
| Read, use or proxy Claude credentials or plan endpoints | never | never |
| Change what Claude Code does inside its turn (model, tools, loop) | never: `model_routing` stays `unsupported` for Claude Code | never |

Why the plan shape is allowed: from Claude Code's side, a routed turn is indistinguishable from the user typing the message into Claude Code themselves. A person sent it, Nekko passed it through unchanged, Claude Code ran it once, unmodified. Messages that went to the local model never reached Anthropic at all. Choosing *not* to send a message to Claude is not a use of Claude. What would cross the line is Nekko authoring or altering what Claude Code receives, or Claude Code turns that no person started; the router does neither.

## Where it lives

- **Per chat, on Claude Agent chats only.** The composer's engine pill on a Claude Agent chat gains three choices: **Auto**, **Claude Code** (pinned), **Local** (pinned, with the local model named). A new Claude Agent chat starts on **Claude Code**: routing is opt-in. Nekko-engine chats (Anthropic API key, other providers) already have Auto and Fusion (see *Model auto-mode, with profiles* in [models and providers](../models/models-providers.md)) and do not get this pill.
- **Session fields.** `Session.engineRouting?: { mode: 'auto' | 'claude-code' | 'local'; localProviderId?: string; localModelId?: string }`. Absent reads as `claude-code`. A user field like `offline`: set with `setSessionOptions`, kept across turns, not copied by fork.
- **Which local model.** The chat's chosen local model, else the default local model, else the one currently loaded. With none available, Auto behaves as Claude Code and the pill reads "Auto (no local model loaded)".
- **Saved modes.** A saved mode may carry `engineRouting.mode`; applying it to a non-Claude-Agent chat changes nothing.
- **Phone.** A message sent from the phone is routed the same way: it is a person's message. The phone shows the same per-turn label and override.
- **Unattended turns.** An automation, goal, watch or auto-continue in a routed chat is routed too, but a turn that lands on Claude Code still goes through the existing admission gate, which refuses an unattended Claude Code turn on a plan (`unattended_runs`). On a plan, an unattended turn in Auto therefore runs locally or is refused, never sent to Claude Code.

## How it decides

The router runs in nekkod before admission, once per user message, and only reads the message. It never edits it.

1. **Pins win.** `claude-code` or `local` mode routes there, no classification.
2. **Per-message override.** Holding the alternate send (or picking the engine from the send button's menu) routes this message to the named engine.
3. **Hard rules (heuristics, under a millisecond).**
   - A slash command (`/compact`, `/usage`, any `/…`) goes to Claude Code verbatim: it is Claude Code's own command.
   - An attachment the local model cannot read (an image without a vision model, a PDF without a reader) goes to Claude Code.
   - Work on the workspace (edit, refactor, run, test, commit, "fix the build", a file path or `@file` mention) goes to Claude Code.
   - A follow-up that only makes sense against the previous turn ("continue", "do it", "try again", "that didn't work") goes to the engine that ran the previous turn.
   - A message the local model's context cannot hold goes to Claude Code.
4. **Local classifier.** Otherwise the loaded local model classifies the message with a fixed prompt (message plus the previous turn's engine; no tools, no network) into `local` or `claude-code` with a confidence. It runs with a 400 ms budget and a few output tokens. Local wins only at or above the threshold (default 0.75); a timeout, an error or a low score goes to Claude Code. The classifier never sees or produces text that reaches Claude Code.
5. **Default.** Anything undecided goes to Claude Code: the user picked a Claude Agent chat, so an unsure router errs toward the engine they chose.

Not signals: plan usage, rate limits or a "running low" state. The router never moves a message off Claude Code because a plan is near its limit, and never onto another account. The plan sheet may *suggest* pinning the chat to Local when usage is high; the pin is the user's click.

## A local turn in a Claude Agent chat

- Runs on Nekko's own engine with the chosen local model, the chat's transcript as context (Claude Code's earlier printed replies included: reading what Claude Code printed is the same footing as the plan sheet and plan usage), and **read-only** tools only. Edits, commands and anything that changes the workspace are Claude Code's work, so a local turn that needs them says so and offers **Send to Claude Code**.
- Is never added to Claude Code's session. Claude Code's next turn resumes its own conversation (`--resume`) and has not seen the local turns. The transcript marks each local turn "Claude Code didn't see this".
- On a plan, Nekko does not summarize or quote local turns into the next Claude Code turn. To give Claude Code what a local turn said, the user uses **Quote in message** on that reply: it inserts the text into the composer, where the user sees and can edit it before sending. The message is then the person's own. On an API key or cloud auth with `context_note` enabled, Auto may also prepend a clearly marked "Answered locally earlier in this chat" block; the turn's label says so.

## What the user sees

- **Per turn, a route label** above the reply: "Handled locally · <model>" or "Sent to Claude Code", with the reason on hover ("workspace edit", "slash command", "classifier 0.91", "pinned", "you chose"). A turn that fell back because no local model was loaded says so.
- **One-click override after the fact.** A local reply has **Send to Claude Code**: it sends the original message, unchanged, as a new Claude Code turn, a person's click, one hop. A Claude Code reply has **Ask locally instead**, which runs the same message on the local model. Neither repeats on its own.
- **Override before sending.** The send button's menu: Send (Auto), Send to Claude Code, Send to local.
- **Pinning.** The engine pill: Auto, Claude Code, Local. Pinning is per chat and survives restarts.
- **Usage.** Local turns show tokens and "Free · on this computer"; Claude Code turns show what they show today. The chat's usage chip counts only Claude Code turns against the plan.

## Policy row: `engine_routing`

A new capability in the Claude policy table (`packages/shared/src/claude-policy.ts`, Rust mirror `crates/nekko-agent/src/claude_policy.rs`, golden `crates/nekko-agent/tests/golden/claude-policy.json`). Proposed, not implemented:

| Auth | `engine_routing` | Shape |
|---|---|---|
| `api_key` | `enabled` | one hop; context carry when `context_note` is enabled |
| `cloud` | `enabled` | same |
| `subscription` | `enabled` | one hop, person-started, message unchanged |
| `unknown` | `enabled` | the plan shape (its `context_note` is `awaiting_approval`, so nothing is carried) |

- The row gates only the pre-turn choice. The stricter plan shape is enforced by rows that already exist: `context_note` for anything Nekko adds to what Claude Code receives, `unattended_runs` for a Claude Code turn no person started. So `unknown` can be `enabled` and still fail closed: it gets exactly the plan shape.
- `engine_routing` is not added to `CLAUDE_CODE_UNSUPPORTED`: it happens before the turn, outside Claude Code's loop. `model_routing` keeps `claude_code_owns_loop`.
- `CLAUDE_AWAITING_REASON.engine_routing` is a new `ReasonId`, `engine_routing_needs_approval` ("Routing this chat between a local model and Claude Code is off for now."), used only if a signed override ever moves the row to `awaiting_approval`. The comparison table gains a row "Route messages between a local model and Claude Code", "Yes" in every column.
- The harness asserts the passthrough: when the route is Claude Code on an auth whose `context_note` is not enabled, the bytes written to `claude -p` equal the user's message. A test pins this.
- A local agent calling Claude Code as a tool or sub-agent is **not** this row. If it is ever built it gets its own row (for example `claude_code_delegation`: `enabled` on `api_key`/`cloud`, `awaiting_approval` on `subscription`/`unknown`, so the user's approval switch from decision 0031 would apply).

## Privacy

Classification and local turns run on the machine; a message routed locally never leaves it. The classifier's prompt and scores are kept in the turn record for the label, not sent anywhere. Offline and Cloud only still apply: in an Offline chat Auto routes everything locally and Claude Code turns are refused as today; in a Cloud only chat Auto is unavailable and the pill offers Claude Code only.

## Acceptance criteria

1. A Claude Agent chat's engine pill offers Auto, Claude Code and Local; a new Claude Agent chat starts on Claude Code. Other chats have no such pill.
2. Every turn in a routed chat records its engine and reason, and shows "Handled locally · <model>" or "Sent to Claude Code" with the reason on hover, on desktop and phone.
3. On every auth whose `context_note` is not enabled (a plan, `unknown`), the text written to Claude Code for a routed turn is byte-identical to the user's message: a test sends local turns, then a Claude Code turn, and compares the harness input with the message.
4. Exactly one engine runs per user message. No code path starts a Claude Code turn from a local turn's output, a classifier result alone without a person's message, a failure, or a retry; **Send to Claude Code** is the only way a local reply becomes a Claude Code turn.
5. Slash commands, workspace edits and unreadable attachments always route to Claude Code; a follow-up routes to the previous turn's engine; classifier timeout, error or low confidence routes to Claude Code.
6. With no local model available, Auto sends everything to Claude Code and says so.
7. An unattended turn in Auto on a plan never reaches Claude Code (the existing `unattended_runs` refusal), and runs locally when it can.
8. The router never reads plan usage or rate-limit state, never chooses another Claude provider or account, and never touches a Claude credential.
9. Local turns are marked "Claude Code didn't see this"; **Quote in message** puts a local reply's text in the composer for the user to send.
10. `engine_routing` is in the TS table, the Rust mirror and the golden fixture, `enabled` for all four auths, and the parity test passes.

## Not yet

Everything above is planned. Open: the classifier prompt and threshold need measuring against a labelled set of real Claude Agent messages; whether **Ask locally instead** should be offered on Claude Code replies at all (it costs nothing on the plan but may confuse); and whether the Local pin should also apply to the phone's quick replies.
