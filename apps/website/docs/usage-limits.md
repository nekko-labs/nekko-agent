# Usage limits and price estimates

This page explains where Nekko Agent's usage numbers come from and what they mean.

## Where the limit numbers come from

The app does not guess your usage. It asks the provider:

- **Claude (Anthropic subscription)** - Every subscription-mode response carries `anthropic-ratelimit-unified-*` headers that report the 5-hour, 7-day, and per-model 7-day windows. The host also polls `GET https://api.anthropic.com/api/oauth/usage` for the first paint and manual refreshes.

- **ChatGPT (Codex subscription)** - The host polls `GET https://chatgpt.com/backend-api/wham/usage` with the current Bearer token and `ChatGPT-Account-Id`. The endpoint returns optional `primary_window` and `secondary_window` usage, plus plan type and credits. These are slots, not fixed periods: a primary window can be weekly, and either slot can be absent or null. Each window's `limit_window_seconds` determines its identity and label. Reported durations of 18,000 and 604,800 seconds become `5-hour` and `7-day`, respectively, regardless of slot; other positive integer durations get explicit duration labels. Missing or invalid durations retain the usage/reset data under neutral `Primary usage` or `Secondary usage` labels; neither the slot nor time until reset is used to guess a period.

  Source: OpenAI's public Codex source at commit `b741e480e203f037ca726bc2a76d99a8e8668e66`: [nullable window slots](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs#L21-L34), [window duration field](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs#L14-L22), [duration conversion](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/backend-client/src/client.rs#L741-L753), and [duration-driven labels with neutral fallbacks](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/tui/src/chatwidget/rate_limits.rs#L103-L145). Nekko uses exact reported durations rather than Codex's approximate label matching.

Both providers are normalized into the same `SubscriptionLimits` shape in `packages/shared/src/limits.ts`. That shape has no unknown/general-duration scope: ChatGPT durations of at least seven days use `weekly`, shorter durations use `session`, and unknown durations use `session` only as a compatibility fallback. The displayed label, not that fallback scope, describes the reported period.

## Live reads, not estimates

The numbers in the chat header chip and the Models card are live reads from the provider. They update after each subscription response and on a throttled poll. Nekko Agent does not extrapolate or predict your usage locally; if a provider does not return a window, that window is simply not shown.

## Off-label caveat

The Anthropic and ChatGPT usage endpoints used here are documented by or reverse-engineered from the providers' subscription flows. They can change, move, or stop returning data at any time. Nekko Agent is not affiliated with Anthropic or OpenAI, and the readouts are provided as a convenience for subscribers, not as an official feature of those services.

## Prices are list estimates, not a bill

`MODEL_PRICING` in `packages/shared/src/limits.ts` is a table of published list prices, matched by model id substring. The per-model labels (`$X/$Y per MTok`) and the session total in the chat header are estimates only.

Your actual provider bill may differ because of taxes, discounts, cached-token pricing, batch pricing, enterprise agreements, image or tool-token costs, or mid-rate changes. Local models (Ollama, LM Studio, vLLM) and subscription providers are shown as `Free` or `Included in plan` because they are not metered through an API key in Nekko Agent.

## Limits are provider-side

Nekko Agent can only read and surface the limits that Anthropic and OpenAI return. It cannot raise, reset, or bypass them. If a window is reported as rate limited, that state comes from the provider; Nekko Agent does not create or remove the limit.
