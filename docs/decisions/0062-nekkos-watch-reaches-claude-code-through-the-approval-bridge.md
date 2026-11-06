---
status: accepted
date: 2026-11-04
---

# 0062. Nekko's watch reaches Claude Code as a tool on the approval bridge, gated by the Claude policy

## Context

Claude Code chats could not arm Nekko's durable watch (`agent_watch`), so they never waited on PR checks the way Nekko engine chats can (issue #1675). Philip asked to add it without breaking Anthropic's terms. The [Claude policy table](../../spec/product/claude-policy.md) already holds the answer per sign-in: `nekko_tools` (Nekko's tools inside a Claude Code chat) and `unattended_runs` (Claude Code turns no person started, which every watch wake-up is) are `enabled` on an API key or cloud account and `awaiting_approval` on a Claude plan and an unread sign-in. Nekko already runs one MCP server per Claude Code chat, the approval bridge, through Claude Code's own `--mcp-config`, the documented way to extend it.

## Options considered

1. **A separate MCP server for Nekko tools.** Clean separation, but a second process, config entry and token per chat for one tool.
2. **Tell Claude Code about the watch with `--append-system-prompt`.** Gated by `context_note`, and the launch code forbids the flag outright today; the tool's description can carry the same guidance without it.
3. **List `agent_watch` on the existing approval bridge, only where both rows are enabled, and check again on every call.**

## Decision

Option 3. At launch nekkod asks the policy for `nekko_tools` and `unattended_runs`; only when both are `enabled` does it start the bridge with `--tools agent_watch`. Each call reaches nekkod at `POST /harness/tool` with the chat's bridge token (loopback only, no browser origin) and is refused unless that launch offered the tool and both rows are still enabled. A change in the offered tools relaunches Claude Code at the next message. The bridge's permission prompt allows the watch in every mode, as a Nekko engine chat runs `agent_watch` without asking, because it only schedules a wake-up of the same chat. The transcript shows the call as `agent_watch`, so every client draws its watch row.

## Consequences

- On an API key or cloud account, Claude Code arms its own watches; the host's default PR watch ([Watch PRs until merge-ready](../../spec/agents/watch-prs-until-merge-ready.md)) stands aside for them.
- On a Claude plan nothing changes until Anthropic approves, or the user records their own approval (Settings > Agents > Claude plan features), which turns both rows on for that install.
- Nothing is added to Claude Code's prompt and its binary is untouched. If Anthropic objects to Nekko tools on a plan, the existing rows already keep them off; a signed override can turn them off for API keys too without a release.
