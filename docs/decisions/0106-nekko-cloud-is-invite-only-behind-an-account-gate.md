---
status: accepted
date: 2026-11-17
---

# 0106. Nekko Cloud goes live invite-only, behind an account gate in the API

## Context

Philip wants Nekko Cloud switched on in production but closed to everyone except Nekko
Labs accounts for now (#2932, go-live checklist #2733). Plans and org features already
have their own switches (decisions 0086 and 0092), but those hide features from signed-in
users; they do not stop a stranger from creating an account.

## Options considered

1. **Leave sign-in off in production.** Nobody can try it, not even the team.
2. **Gate in Supabase** (disable sign-ups, invite users). Needs dashboard work per person
   and does not cut off tokens this service already issued.
3. **Gate in this API, by proven email.** A domain and email allowlist in environment
   variables, checked when a Supabase session is traded for a Nekko Cloud token and again on
   every bearer token.

## Decision

Option 3. `NEKKO_ACCOUNTS_ALLOWED_DOMAINS` and `NEKKO_ACCOUNTS_ALLOWED_EMAILS`
(comma-separated, case-insensitive). When either is set, only an account whose email is proven
(an emailed code or link, or Supabase's own confirmed-email record, never editable user
metadata) and is on the list may sign in or use a token. A domain matches exactly, not its
subdomains. Everyone else gets 403 `account-not-available` at sign-in with no user, signup
link or token created, and a 401 on any route with an existing token, so narrowing the list
cuts those off. The email comes from the existing token lookup, so there is no extra query.
Unset, everyone is let in, as before.

Public routes (health check, beta signups, feedback, donations, the billing webhook, the
auth config and the feature list's public part) stay open: they are not tied to an account,
Stripe and Fly need the first and last, and they create no Nekko Cloud account.

This is separate from `NEKKO_STAFF_EMAILS`, which only decides who sees unreleased features.
Staff are expected to be inside the gate, not the same list.

## Consequences

- Production sets `NEKKO_ACCOUNTS_ALLOWED_DOMAINS=nekkolabs.com` before the Supabase secrets.
- Opening Nekko Cloud to everyone later is removing the variable.
- Apps show "Nekko Cloud is invite-only for now." for the 403.
