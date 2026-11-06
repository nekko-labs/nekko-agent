---
status: accepted
date: 2026-10-22
---

# 0003. Pseudonymize private values at the model-client seam

## Context

Privacy Shield ([spec](../../spec/context/privacy-shield.md), [design](../superpowers/specs/2026-10-22-privacy-shield-design.md)) keeps personal data and secrets from reaching a cloud model. An agent, unlike a chatbot, must still act on those values: write the real email into a file, open the real `/Users/<name>/...` path, show the user real names. The daemon builds every agent turn on one `ModelClient` (`ProviderClient` in nekkod's `chat_client.rs`, once the `nekko-chat` crate), and side calls (titles, suggestions, compaction) are a handful of known call sites. Detection must never call another service, or the detector sees what we are keeping in.

## Options considered

1. **Where:** a `ModelClient` wrapper in the daemon; per provider in `nekko-agent`; a localhost HTTPS proxy; the renderer before send. The wrapper covers every turn through one seam and sees typed messages. Per-provider work means 11 kinds and 3 wire formats. A proxy needs TLS interception and SSE rewriting. The renderer misses everything the agent reads and cannot restore.
2. **What replaces a value:** a typed placeholder kept in a per-reply vault (`[PII_EMAIL_1]`), masking (`j***@x.com`), dropping, a synthetic substitute, or format-preserving encryption. Masking and dropping break tool calls. Substitutes invite the model to "correct" or reuse a plausible fake. Encryption adds a key for no gain over a vault.
3. **How values are found:** regex with validators plus user terms; on-device NER; a local LLM; Presidio; a cloud DLP service. Only the first is cheap, dependency-free and certain to stay on the machine today. NER and a local LLM are later phases. Presidio means a Python runtime. Cloud DLP defeats the purpose.

## Decision

Wrap the model client (`ShieldedClient`) and replace detected values with stable, typed, numbered placeholders, restoring them in everything the model returns before the loop, tools or transcript see it. Detection is on-device regex with validators plus the user's terms. Off by default; only providers off this computer are shielded.

## Consequences

- The agent works unchanged on real values, the transcript on disk is unchanged, and prompt caching survives because numbering is stable across requests.
- Every new path that sends chat content to a model must go through `privacy::shield_for` or `privacy::guard`. Image generation and repository review are not covered yet.
- Placeholders are pseudonyms: quasi-identifiers, prose names and images still get through. NER (phase 2) and a local-model rewrite (phase 3) address this.
- Claude Agent chats cannot be shielded from this seam; reaching them needs the proxy option.
- If models stop passing placeholders through tool calls verbatim, the wrong value is written (the placeholder text itself, never someone else's value). That would show up as `[PII_` text in files and in support reports.
