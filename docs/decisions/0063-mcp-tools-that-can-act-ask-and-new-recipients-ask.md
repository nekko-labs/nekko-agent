---
status: accepted
date: 2026-11-07
---

# 0063. MCP tools that can act ask, and new recipients ask

Proposed by Davide on 2026-11-07; accepted by Philip on 2026-11-07 without changes, with [0054](0054-gate-egress-in-chats-that-read-untrusted-content.md). Issue: [#1867](https://github.com/nekko-labs/nekko-agent/issues/1867). Spec: [agent data security](../../spec/context/agent-data-security.md), "Outward actions".

## Context

Decision 0054 gates what leaves a chat that has read untrusted content. P1 of the same plan covers outward actions in every chat: sending an email or a message, posting, opening a ticket. Once sent, they cannot be taken back.

Nekko has no email or chat tools of its own: those actions go through MCP servers. The shell was already covered, because `git push`, `gh pr comment` and `curl` are not read-only and ask in Guardrails (decision 0010). MCP tools, however, asked only in Ask mode, or in a tainted chat after 0054. So a README in the workspace, which does not taint a chat, could get the agent to post the secret through an MCP tool unasked. The eval `readme-mcp-send-exfil` recorded `ran` without this decision.

MCP servers can annotate a tool as read-only (`readOnlyHint`). That is the server's own claim.

## Options considered

1. **Keep MCP asking only in tainted chats.** No new prompts, but an agent can still send a message unasked in any other chat.
2. **Ask for every MCP call in Guardrails.** Strictest, but search-heavy servers would ask on every lookup, and people would move to YOLO.
3. **Ask unless the server marks the tool read-only.** Searches and reads stay fluid; sends, posts and changes ask. The claim is trusted only where no untrusted content could have shaped the call.
4. **A recipient allowlist set by the user.** Precise, but a list to maintain up front. That suits an admin (Team), not a single user.

For recipients: ask once per chat; remember them in every chat (one approval in a tainted chat would trust an address forever); or do not check them.

## Decision

- **Option 3.** In Guardrails, an MCP tool asks unless its server marks it read-only and the chat has not read untrusted content, or the user chose "Always allow this tool" in this chat.
- **A new recipient asks, per chat**, even for an always-allowed tool. A call whose arguments name an address, channel, chat, user or phone this chat has not written to asks and names it. Approving it makes that recipient known for the rest of the chat.
- YOLO never asks (0054). The admin recipient allowlist stays a Team rule, not started.

## Consequences

- Guardrails asks more in chats that use MCP servers whose tools are not annotated. "Always allow this tool" and annotated servers keep that bearable. If people move to YOLO over it, look at the servers that lack annotations before relaxing the rule.
- Recipients are found by argument name. A recipient named only in free text (a body that says "forward this to x") is not caught.
- A server that falsely marks a sending tool read-only gets past the first rule in a clean chat. The recipient rule does not apply to read-only tools either. Annotated servers are trusted as their authors are.
- Each fix flips recorded outcomes in `crates/nekkod/tests/golden/injection-evals.json`: `readme-mcp-send-exfil` is `asked` in Guardrails, and still `ran` in YOLO.
