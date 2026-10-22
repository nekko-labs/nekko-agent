---
title: "Build storage maintenance"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Build storage maintenance

Implemented maintenance command (Windows cleanup validation in progress): `npm run clean:builds` previews reproducible outputs across registered worktrees and known shared Rust pools; `-- --apply` explicitly deletes eligible outputs older than 14 days by default. `--older-than=0` permits an immediate approved cleanup. `--global` includes known download caches, not model downloads, user app data, toolchain installations, source, branches or evidence. Tracked files, junction targets and primary development app dependencies/runtime/output/dev-daemon are protected. Git ownership/access failures skip the affected checkout rather than changing trust settings. Windows checks active build/install processes and runtime executable paths; Unix apply requires explicit idle confirmation because automatic ownership detection is not implemented. Extra active paths can be protected with `--protect=<path>`. No automatic worktree removal or background deletion. Transient capture/performance CI artifacts now expire after 14 days; durable PR evidence follows the existing publication policy.
 Cloud (paid, hosted)

- **Cloud foundation** `[shipped]`, multi-account hosted edition wrapping the same engine + renderer per account; email+password auth, bearer tokens, per-account data isolation, entitlements (free/pro/team) gated server-side. The OSS app never license-checks.
- **Phone↔local-model relay** `[shipped]`, see "Phone remote control" above: relay v2 + device registry + revocation + managed instance on Fly.io. The relay carries an **entitlement gate** (`NEKKO_RELAY_AUTHZ_URL` → the cloud's `/api/relay/authorize`, which checks the account and returns the plan's device allowance) so the managed relay becomes a paid Cloud perk at launch while self-hosting stays free; the gate is off during beta.
- **Payments (Stripe)** `[shipped]`, Checkout (upgrade to Pro/Team) + Customer Portal (manage/cancel) + signature-verified webhooks that drive an account's plan (and therefore its entitlements). Hand-rolled against the Stripe REST API (no SDK dependency) and gated on `STRIPE_SECRET_KEY`, so the cloud server runs fully without a Stripe account; real charges light up once keys are configured.
- **ZDR + cloud history/files** `[planned]`, retention modes, encrypted-at-rest sync engine, ZDR badges + audit log.
- **Managed connectors** `[planned]`, pre-registered OAuth apps for Gmail/Drive/Slack/Discord.
- **Relay tiers + free push + fair-share limiter** `[planned]`, see "Hosted relay tiers, free notifications and what the server may know" under phone remote control: free content-free push for all, a limited and fair-queued free traffic tier, Cloud lifts the limits, self-hosting gets everything for free.
- **PII-free server analytics** `[planned]`, aggregate counters only (platforms, versions, coarse region, content-free event names, tier and limit hits), daily-salted identifiers, 24-hour raw-log rotation, a visible opt-out on both apps.
