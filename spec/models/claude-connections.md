---
title: Claude subscription and API connections
area: models
---

# Claude subscription and API connections

Intent: switch explicitly between a personal Claude plan, an organization seat (including the same email), and multiple Claude API connections without overwriting another account or confusing billing. Tracked by #2334. [Editable design](../../docs/designs/claude-connections.html).

## Design and acceptance criteria

- The desktop/shared-web model picker offers a **Claude connection** selector when the selected provider is Claude and more than one enabled Claude connection exists. Claude includes Claude Code subscriptions, Anthropic API keys, Bedrock, Vertex and Foundry.
- Each option identifies its saved connection name and subscription/API source. A details line shows the subscription identity reported by Claude Code (email, organization, plan), or an honest checking/unavailable/signed-out state. API details name the billing source and optional Anthropic workspace, never the key.
- Choosing a connection filters the offered models. It does not change the chat until the user chooses a model from that connection. No cross-provider alias guessing, and no missing-catalog fallback to another connection. An All providers option restores the full provider list, including non-Claude providers.
- Switching Claude profiles starts a new Claude Code conversation under the existing account-scoped launch/resume behavior. History remains visible in Nekko but is not promised to be transferred into that new conversation. Existing in-flight work is unchanged. Recommend a new chat to keep personal and organization work separate.
- Subscription setup offers a separately named profile even when no default login is connected. A normalized profile name already in the saved providers cannot be signed into or saved again from this flow. Existing identity duplicate/second-personal-plan checks remain in force. Pending identity reads are scoped to the requested profile; stale results cannot authorize another profile. Blank names cannot save the usual account.
- API connection names are visible before saving, not hidden in advanced connection settings. Each save remains an independent provider ID, including multiple keys for the same API vendor.
- Keyboard/native select semantics, wrapped identity text and narrow layouts must work at desktop, phone/folded and unfolded/split-screen widths. This is capability-based responsive design, not a claim of testing a specific folding device.

## Privacy and boundaries

Nekko continues to run the user's own unmodified Claude Code sign-in. No subscription credential reads, copies or new OAuth client. Never infer organization ownership from an email or a user-entered label. No account rotation on rate limits, quota pooling, silent paid fallback or API key display. Native iOS/Android controls are follow-up scope; their existing provider/model selection remains unchanged.

## Status

Implemented in desktop/shared web. All 3,429 desktop tests, desktop production build, desktop/shared-web typechecks and 22 isolated hidden Electron interaction assertions pass with synthetic accounts: personal-to-org selection, subscription-to-API exact model IDs, separate API keys, empty-catalog no-fallback, profile collision prevention and visible API names. Layout assertions pass at 360, 660 and 820 CSS pixels. Before/after PNGs captured. Visual inspection is blocked: browser screenshot timed out and native capture returned UnknownVizError; captured pixels await review before landing. Live personal/organization sign-in, real billing, macOS/Linux and physical foldable devices are not verified by synthetic UI tests.
