---
title: Nekko Cloud is invite-only while it goes live
area: platform
status: in-progress
---

# Nekko Cloud is invite-only while it goes live

Tracking: [#2932](https://github.com/nekko-labs/nekko-agent/issues/2932), go-live checklist [#2733](https://github.com/nekko-labs/nekko-agent/issues/2733). Decision: [0106](../../docs/decisions/0106-nekko-cloud-is-invite-only-behind-an-account-gate.md).

## Goal

Nekko Cloud is switched on in production, but only accounts tied to Nekko Labs can use it. Everyone else is told it is invite-only for now.

## Acceptance criteria

- With `NEKKO_ACCOUNTS_ALLOWED_DOMAINS` and/or `NEKKO_ACCOUNTS_ALLOWED_EMAILS` set, signing in with an email that is not on the list (or not proven) answers 403 `account-not-available` and creates no user, signup link or token.
- Matching is case-insensitive; a domain matches exactly, so `mail.nekkolabs.com` and `evilnekkolabs.com` do not match `nekkolabs.com`.
- Every route that takes a Nekko Cloud token refuses a token whose account is not allowed (401), so narrowing the list cuts off existing devices.
- Healthz, beta signups, feedback, donations, the billing webhook and the public auth config stay open.
- Unset, behavior is unchanged.
- Desktop and iPhone show "Nekko Cloud is invite-only for now. This account isn't on the list yet." for the 403.

## Status

Implemented in the API (`apps/nekko-agent-api`), the desktop sign-in error and iPhone `CloudSync`. Android has no Nekko Cloud sign-in yet, so it has nothing to map. Production still needs `NEKKO_ACCOUNTS_ALLOWED_DOMAINS=nekkolabs.com` set before the Supabase secrets (needs Philip). Not verified against a real Supabase project; the Swift change is uncompiled (no Xcode on the author's machine).
