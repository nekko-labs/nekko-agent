---
status: accepted
date: 2026-11-03
---

# 0043. Account deletion is a hard delete that tears down cloud machines first

## Context

Nekko Cloud had no way to delete an account (GDPR Art. 17). The data spans
three places: this service's Postgres (the user row, its tokens, sync data,
cloud machine rows, machine hours and signups), Fly (the user's running cloud
machines, whose environment holds the pairing key), and Supabase Auth (the
sign-in identity). Deleting a machine today only marks its row deleted, and
ignores a failed Fly call. Spec: [Nekko Cloud data rights](../../spec/platform/nekko-cloud-data-rights.md).

## Options considered

1. **Soft delete**: mark the user deleted and purge later. Easy to undo, but
   the data stays, every query has to filter it, and a purge job becomes one
   more thing that can silently not run.
2. **Delete in the database first, machines after**: the account is gone at
   once, but a failed Fly call leaves a machine running and billing with the
   pairing key in its environment and no row left to find it by.
3. **Hard delete, machines first**: destroy every machine the account ever
   had on Fly (already gone counts as done); on any failure stop with 502 and
   delete nothing, so the app can simply try again. Then one transaction
   deletes the users row (which cascades to everything that references it),
   the address's signups, and puts the address's hash on the suppression list.
   Supabase goes last.

## Decision

Option 3. Nothing may keep running after the account is gone, and an account
that can still be found is better than a machine that can't. Cloud machine
rows and machine hours are deleted with the account rather than marked.

Supabase Auth is a separate system that can fail on its own, so its deletion
is an outbox: the Supabase user id goes into `pending_auth_deletions` in the
same transaction as the local delete, the route then calls the admin API and
removes the row on success, and an hourly job retries what is left. The route
answers 204 once the local delete commits, whatever Supabase did; the retry
log names no user.

## Consequences

- Deletion can't be undone, and support can't restore an account.
- The address is suppressed, so a later beta signup with it saves but gets no
  email, until the person asks hello@nekkoagent.com to lift it.
- Until the Supabase delete succeeds, the person can still sign in to
  Supabase; signing in again creates a fresh, empty Nekko Cloud account.
- The server needs `SUPABASE_SERVICE_ROLE_KEY`; without it, deletions wait in
  the outbox.
- A machine created by a request racing the deletion could be missed. Lock
  machine creation per user if that ever shows up.
