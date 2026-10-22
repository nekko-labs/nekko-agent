---
title: "Claude policy (2026-10-19)"
area: product
split-from: SPEC.md (2026-10-22)
---

# Claude policy (2026-10-19)

**Why:** Anthropic's terms let a third-party app use Claude on the user's own API key or cloud account without restriction, but a Claude plan only through the user's own, unmodified Claude Code, and they do not clearly cover some features for third-party apps on a plan. Philip's direction: those features are built and tested now, stay off for plan users until Anthropic approves them, and can then be switched on by Nekko (a reviewed release or a signed policy), never by a user-flippable toggle. Design: obsurdian `projects/nekko-agent/features/claude-code-harness/prompt.md` ("Claude policy table").

**One table decides every Claude capability.** `CLAUDE_POLICY` (`packages/shared/src/claude-policy.ts`) maps each auth (`api_key`, `cloud`, `subscription`, `unknown`) and capability (`interactive_chat`, `phone_remote`, `unattended_runs`, `nekko_tools`, `context_note`, `usage_limits`, `cost_estimate`, `model_routing`) to `enabled`, `awaiting_approval` (built and tested, off until Anthropic says yes) or `unsupported` (structurally impossible; nothing turns it on). nekkod enforces its Rust mirror (`crates/nekko-agent/src/claude_policy.rs`); a golden test (`packages/host/src/claude-policy.golden.test.ts` writes, `crates/nekko-agent/tests/claude_policy.rs` reads) keeps the table, the reasons and the auth mapping identical.

| | API key | Cloud (Bedrock, Vertex, Foundry) | Claude plan, and `unknown` |
|---|---|---|---|
| Chat, phone remote | on | on | on |
| Scheduled tasks, workflows, goals, watches, auto-continue (`unattended_runs`) | on | on | awaiting approval |
| Nekko tools inside a Claude Code chat (`nekko_tools`) | on | on | awaiting approval |
| Context note via `--append-system-prompt` (`context_note`) | on | on | awaiting approval |
| Usage limits in Nekko (`usage_limits`) | on | on | awaiting approval; no plan usage source exists, so nothing is shown even then |
| Cost estimate | on | on | unsupported (billed to the plan; tokens only) |
| Model routing | on (Nekko engine) | on (Nekko engine) | unsupported |

- A Claude Code ("Claude Agent", provider kind `claude-code`) turn also never gets model routing on any auth: Claude Code owns the loop (`claude_code_owns_loop`).
- `unknown` (Claude Code's `claude auth status` not read yet, signed out, or an unrecognized method) behaves as a plan: fail closed.
- Auth is chosen per provider: `anthropic` is `api_key` (`subscription` for the legacy sign-in until it is removed), `bedrock`/`vertex`/`foundry` are `cloud`, and `claude-code` is `api_key` or `cloud` when Nekko sets the credential itself (`claudeCode.authSource`), otherwise what `claude auth status` reports.
- **Reasons.** Every row that is not enabled carries a `ReasonId` whose one-line copy (`CLAUDE_REASONS`) is what a greyed control shows, followed by a "Why?" link to the "What works with a Claude plan?" sheet (`CLAUDE_PLAN_SHEET`). The comparison table under the provider cards is generated from the table (`claudeComparisonTable`); its plan column reads "Not yet" for the approval-gated rows (the design's "Off by default" for Nekko tools was dropped because there is no user toggle).
- **Gates.** nekkod admission refuses an unattended Claude Code turn (automation's `chat:send`, which now carries `unattended: true`) whose auth lacks `unattended_runs`, and tells the chat the reason. The harness calls `allows_nekko_tools`, `allows_context_note` and `plan_usage`, and records `claude auth status` with `note_auth_status`. The TS host's auto-continue applies the same rule (`claudeUnattendedRefusal`).
- **Signed override.** A release may carry `claude-policy.json` beside its update feed file. nekkod verifies its Ed25519 signature against the release policy key, accepts it only with a higher serial than the one applied, applies it all or nothing, and keeps it in the data directory. It can move rows only between `enabled` and `awaiting_approval`, never touch an `unsupported` row, and never turn an `unknown` row on. **Not live yet:** Nekko has no release signing key, so the key is an all-zero placeholder (TODO for Philip) and every override is refused.
- **Renderer.** `claude:policy` (effective table, applied override, preview), `claude:capability(providerId, capability)` (row, reason id and line) and `claude:planUsage(providerId)`. No UI reads them yet (H4/H5b).
- **Preview (dev only).** `NEKKO_CLAUDE_POLICY_PREVIEW=subscription` renders the plan's approval-gated rows as enabled and answers `claude:planUsage` with example data (`claudePlanUsageExample()`, labelled "Example data"), for recording what Nekko would turn on. It is compiled only into nekkod builds with the `dev-tools` feature (`npm run dev`'s daemon), never the release build the app packages, and is ignored in a packaged app. The real Claude Code session in a preview still runs on an API key.

Status: implemented and tested (unit, parity and an end-to-end daemon test); inert until the Claude Agent harness and UI use it.
