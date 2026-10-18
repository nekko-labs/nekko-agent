# @nekko-agent/cloud, Nekko Cloud (hosted edition)

The multi-account, hosted edition. It wraps the **same** host engine (`@nekko-agent/host`)
and the **same** React UI as the desktop and self-hosted Local Web UI installs, just per
authenticated account, with feature limits enforced server-side by plan.

The OSS app (desktop / self-hosted server) **never** signs in or license-checks.
Only this hosted edition has accounts and entitlements.

## What's here (Phase 3.1, Cloud foundation)

- **Accounts + auth** (`accounts.ts`): email/password sign-up & log-in, scrypt
  password hashing (`node:crypto`, no deps), bearer session tokens. File-backed
  (`cloud.json`) behind a small `CloudStore` interface so a Postgres impl can
  drop in later.
- **Per-account isolation** (`server.ts`): each account gets its own data dir and
  its own `Host` instance; every authenticated request runs inside
  `withDataDir(accountDir, …)` so settings/sessions/memory never cross accounts.
- **Entitlements** (`entitlements.ts`): `free` / `pro` / `team` → workspace and
  device limits, ZDR, cloud-sync, managed connectors. Gated server-side in the
  dispatch path (e.g. the free-plan workspace cap).
- **Login gate** (renderer `components/CloudLogin.tsx`): shown only when
  `/api/auth/config` reports cloud mode and there's no valid session; stores the
  account token as the Bearer the existing web-client already sends.
- **Billing** (`billing.ts`): Stripe Checkout + Customer Portal + webhooks,
  hand-rolled against the Stripe REST API (no SDK dep) and **gated on
  `STRIPE_SECRET_KEY`**, the server runs and tests pass with no Stripe account.
  Webhook signatures are verified with HMAC-SHA256 (`node:crypto`); on
  `checkout.session.completed` / `customer.subscription.*` events the account's
  plan is updated via `store.setPlan`, which immediately changes its
  entitlements. The OSS app never touches any of this.

## Run it

```bash
npm run cloud            # from repo root: builds engine + renderer, serves :4318
```

Environment:

- `CLOUD_PORT` (default `4318`), `CLOUD_HOST` (default `127.0.0.1`)
- `CLOUD_DATA_DIR` (default `~/.nekko-cloud`), cloud metadata + per-account dirs
- `NEKKO_RENDERER_DIR`, override the served renderer build
- `CLOUD_PUBLIC_URL`, public base URL, for Checkout success/cancel/portal redirects
- Billing (optional; billing stays disabled if `STRIPE_SECRET_KEY` is unset):
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/auth/config` |, | `{ cloud: true, billing }` (renderer uses this to decide whether to gate / show upgrade) |
| `POST /api/auth/signup` |, | `{ email, password }` → `{ token, account, entitlements }` |
| `POST /api/auth/login` |, | `{ email, password }` → `{ token, account, entitlements }` |
| `GET /api/auth/me` | Bearer | `{ account, entitlements }` |
| `POST /api/auth/logout` | Bearer | invalidate the token |
| `POST /api/billing/checkout` | Bearer | `{ plan: 'pro'｜'team' }` → `{ url }` (Stripe Checkout) |
| `POST /api/billing/portal` | Bearer | `{ url }` (Stripe Customer Portal) |
| `POST /api/billing/webhook` | Stripe signature | apply plan changes from Stripe events |
| `POST /api/:channel` | Bearer | the full NekkoApi, scoped to the account |
| `GET /api/events` (WS) | Bearer (`?token=`) | the account's agent/index events |

## Still TODO (later Phase 3)

- ZDR mode + cloud chat-history / file management + encrypted-at-rest sync
- Device registry + revocation (builds on accounts + the relay)
- Managed connectors (pre-registered OAuth apps)
