---
status: accepted
date: 2026-10-22
---

# 0004. Use Supabase Auth for identity only; keep accounts and data in Nekko Cloud

## Context

Nekko Cloud needs sign-in for end-to-end encrypted sync (spec: [End-to-end encrypted sync](../../spec/chat/end-to-end-encrypted-sync-for-pro-and-team.md)). Philip asked to use "our Supabase auth". The API already runs on Fly with Postgres on Neon; Supabase's database was ruled out earlier on cost (both free projects are in use).

## Options considered

1. **Supabase Auth for identity, Neon for data**: the app signs in to Supabase (email code, Apple, GitHub, Google), then trades the access token once for a Nekko Cloud device token. Pros: no password handling of our own, providers and email delivery handled, no new database. Cons: two services to configure; Supabase is a dependency for new sign-ins.
2. **Supabase for auth and data**: Supabase Postgres with row-level security. Cons: the free projects are taken; moving the data off Neon for no gain.
3. **Our own auth** (magic links via an email provider, OAuth apps ourselves). Cons: more security-sensitive code to own and review.

## Decision

Option 1. Supabase proves who the user is and nothing else: the API verifies the access token against the project's JWKS (issuer, audience `authenticated`, expiry, not anonymous) and issues its own revocable per-device `nk_` token. Accounts, plans, devices and sealed records stay in Nekko Cloud's Postgres. Supabase never sees a synced byte or a key.

## Consequences

- The Supabase project needs email OTP (a code in the template), the three providers, and redirect URLs for the desktop loopback and the iPhone scheme (`apps/nekko-agent-api/README.md`).
- Signing in is unavailable while Supabase is down; already-issued device tokens keep working.
- A Supabase account takeover would let someone sign in as the user and see metadata, never chats: sync keys live only on devices.
- A local stand-in for Supabase Auth (`npm run dev:local`) keeps development and tests offline.
