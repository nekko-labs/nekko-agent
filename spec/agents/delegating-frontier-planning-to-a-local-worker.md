---
title: "Delegating frontier planning to a local worker"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Delegating frontier planning to a local worker

The lead agent can delegate a scoped task through `spawn_agent` with optional `provider_id` and `model_id` targets. Leaving both out preserves the parent's model. Changing provider requires a known exact model ID; the host checks the configured, enabled target and its model list before creating the child. Unknown, unavailable, disabled, or known non-chat models produce an error, never a silent fallback to a different or paid model. The child appears in the existing nested session UI with its selected provider/model and inherits the parent's execution policy and disabled tools. Ask mode and the ask-everything sandbox require approval before starting a sub-agent or calling an MCP tool, so indirect execution cannot bypass that boundary.

This first implementation is **explicit cross-provider delegation**, not automatic price/capability/resource optimization. The lead receives enabled provider IDs and labels, not credentials, and must ask for a known model rather than invent an ID. An opt-in local-worker default and a routing-decision UI remain planned. Incognito delegation is blocked because child sessions are persisted; it must not quietly retain an incognito task.

The existing **Offline** chat mode is deliberately narrower than normal local-agent work: it disables connectors, MCP and every tool that reaches a network, while keeping the local tools (files, shell, desktop capture; see *Tool categories and the internet switch*, 2026-10-15). The host now also rejects cloud or non-loopback provider endpoints before making a request, prevents unoffered tool execution, skips connector fetching in offline context previews, and suppresses hidden post-turn spec refreshes. This is endpoint-policy enforcement, not an operating-system network sandbox; users still control whether their local inference server proxies requests elsewhere. Broader independent model actions, including explicit spec generation, need the same privacy audit before claiming application-wide network isolation.
