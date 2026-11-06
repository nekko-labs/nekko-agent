---
title: "Nekko Cloud data rights: deletion, export, consent, logs and alerts (2026-11-03)"
area: platform
---

# Nekko Cloud data rights

Issue: [#1611](https://github.com/nekko-labs/nekko-agent/issues/1611). Decision: [0043](../../docs/decisions/0043-account-deletion-is-a-hard-delete-that-tears-down-cloud-machines-first.md). Runbook: [privacy incident](../../docs/runbooks/privacy-incident.md).

## Intent

Anyone with a Nekko Cloud account or a beta signup can get their data out,
have it deleted for good, and choose product emails separately from the beta.
Nekko Cloud keeps nothing about a person it does not need: its logs hold no
IP addresses or link tokens. When the service breaks, Nekko Labs hears about
it, and a breach has a written process with the 72-hour clock in it. This
covers the API service (`apps/nekko-agent-api`); the website and the apps
have their own parts (#1610 for the website).

## Account deletion (implemented 2026-11-03)

`DELETE /v1/account` with `Authorization: Bearer <nk_ token>`, the contract
the desktop and phone apps call:

- **204**: the account is gone. **401**: no valid token. **502**
  `{"error":"machine-teardown-failed"}`: a cloud machine could not be
  destroyed, and nothing was deleted; trying again is safe.
- Order: first every cloud machine the account ever had is destroyed on Fly
  (a machine Fly no longer has counts as destroyed), so nothing keeps running
  or billing and the pairing key in its environment goes with it. Then one
  transaction deletes the users row and everything that refers to it (device
  tokens, sync devices, keyrings, wraps, objects and usage, cloud machine rows
  and machine hours, all hard-deleted), deletes every signup row with the
  account's email, and puts the email's SHA-256 on the suppression list so the
  address is never mailed again. Last, the Supabase Auth user is deleted
  through the admin API (`SUPABASE_SERVICE_ROLE_KEY`). If Supabase fails, the
  answer is still 204: the Supabase user id waits in `pending_auth_deletions`
  and an hourly job retries it. Nothing else about the person is kept.
- Another account's data is never touched (tested).
- Not undoable. Signing in again afterwards makes a new, empty account.
- Planned: the Delete account button in the desktop and phone apps, which
  call this route.

## Export (planned)

For now an access or portability request is answered by hand: the person
emails hello@nekkoagent.com and gets their account row, signups, signed-in
devices and machines within a month. Synced data is end-to-end
encrypted; the person's own devices already hold its readable copy.
Planned: `GET /v1/account/export`.

## Marketing consent (implemented 2026-11-03)

- `POST /v1/signups` takes optional `marketing` (boolean, default false) and
  `policyVersion` (letters, digits, `.`, `_`, `-`, at most 32 characters);
  anything else in those fields answers 400. They are stored as
  `signups.marketing_opt_in` and `signups.policy_version`.
- A repeat signup replaces both: each signup is a new statement of what the
  person agreed to.
- Rows from before this change stay `marketing_opt_in = false`: their consent
  was bundled with the beta request.
- Beta mail (the confirmation email, invites) never depends on the flag. Any
  product-update mail goes only to rows with `marketing_opt_in = true` and not
  suppressed. No such mail is sent today.
- The website's unticked "Also send me product updates" box is #1610.

## Log redaction (implemented 2026-11-03)

- A request log line holds method, path (no query string), status and
  timing. No client IP, port or host, so the tokens in the confirm and
  unsubscribe links never reach a log. Errors keep type, message, code and
  stack, never a driver's extra fields (Postgres quotes row values there).
- 404s answer without Fastify's own "Route not found" line, which held the
  full URL.
- Rate limits still count by IP, in memory only; nothing stores it.
- Feedback and donations stay unlogged entirely.

## Error alerting (implemented 2026-11-03)

- With `ALERT_EMAIL` set (and `RESEND_API_KEY`), a 5xx answer or a failed
  background job (purges, machine-hours sweep, Supabase retries) emails that
  address through Resend, at most once per 15 minutes. The email names the
  route pattern and status, or the job, and the time; never a body, address,
  IP or id. Off when `ALERT_EMAIL` is unset.
- Unverified: a live alert from production (needs the secret set).

## Breach process (implemented 2026-11-03)

[docs/runbooks/privacy-incident.md](../../docs/runbooks/privacy-incident.md):
how an incident is noticed, Philip decides, the 72-hour report to the
supervisory authority (Art. 33), when users are told (Art. 34), what to
record, and the vendor contacts.

## Retention

Unchanged here (`src/retention.ts`): unconfirmed signups are deleted 30 days
after their last confirmation email, unsubscribed rows at once.
