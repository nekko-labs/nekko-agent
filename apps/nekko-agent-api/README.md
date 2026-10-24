# nekko-agent-api (Nekko Cloud)

The code project for **Nekko Cloud**, the hosted side of Nekko Agent. It runs as
the Fly app `nekko-agent-api` and is the public backend behind nekkoagent.com.

What lives here:

- **The API service** (`src/`, deployed): beta signups now. Fastify on one small
  Fly.io machine, Postgres on Neon's free plan. It is its own npm package (not a
  root workspace) so the image holds only this folder.
- **Cloud accounts**: not here yet. The earlier hosted-edition prototype (one TS
  host per account) was deleted with the TS engine; PF14 step 4 designs
  accounts on a shared, multi-tenant nekkod, and this service is where their
  sign-up, login and billing will live.
- **Relay** (the product) is part of Nekko Cloud but a separate service:
  [`apps/relay-server`](../relay-server). This service is where Relay's
  permissions and user auth will live: the relay already asks
  `NEKKO_RELAY_AUTHZ_URL` before it lets an agent enroll, and that URL will
  point here once accounts exist.

Planned: serve this service on `api.nekkoagent.com` (today it answers on its Fly
hostname).

## Endpoints

- `POST /v1/signups` with JSON `{ email, name?, list?, source?, utm?, website? }`.
  `list` defaults to `beta`. `source` keeps a page path only, `utm` keeps
  `utm_*` keys only, anything else is dropped. `website` is a honeypot the form
  hides; a filled one gets a fake success. Always answers `202 {ok:true}` on
  valid input, new or repeat, so the form can't reveal who is on the list.
  Browser calls are accepted only from `ALLOWED_ORIGINS`; 5 per IP per hour.
- `/v1/sync/*`: end-to-end encrypted sync for Pro and Team (see
  [docs/SYNC-ENCRYPTION.md](../../docs/SYNC-ENCRYPTION.md)). Bearer `nk_` tokens
  (stored as SHA-256); the service stores only ciphertext, opaque ids and
  revisions and never holds a key that opens them. Writes need `users.plan` in
  `pro`/`team` (402 otherwise); reading, revoking and `DELETE /v1/sync` work on
  any plan.
- `GET /v1/auth/config`, `POST /v1/auth/session`, `GET /v1/auth/me`,
  `DELETE /v1/auth/session`: sign-in. The app signs in to Supabase Auth and
  trades the access token here for its own `nk_` device token (180 days from
  last use). Supabase proves identity only; accounts, plans and data stay in
  this database.
- `POST /v1/donations`, `DELETE /v1/donations/:id`: opt-in samples sealed to
  the offline research key. Unauthenticated, not request-logged, no sender
  columns; withdrawn with the device's delete token, expired after 180 days.
- `POST /v1/feedback`: the quick note from any app's Send feedback sheet,
  `{ message, app? }` (`src/feedback.ts`). Unauthenticated, not request-logged,
  10 per IP per hour (counted in memory). `app` comes only when the sender
  switched on "Include app info", and only `app`, `version`, `os`, `osVersion`
  and `arch` are kept.
- `GET /healthz`: Fly's health check. The machine stops when idle and wakes on
  the next request in about a second; the signup page should call this on load
  so that happens before anyone presses Join.

## Database

`migrations/NNNN_*.sql` run in order on every start, inside one transaction under an advisory lock, recorded in
`schema_migrations`.

- `signups`: one row per email per list (`unique (list, lower(email))`), status
  `pending → invited → joined` or `unsubscribed`, optional `user_id`.
- `users`: the long-term account record (`unique lower(email)`); a signup that
  gets let in becomes a user. `plan` is `free`, `pro` or `team`; `auth_subject`
  is the Supabase user id (migration `0003`). First sign-in creates the user, or
  links the beta signup's user with the same email.
- `api_tokens`, `sync_devices`, `sync_keyrings`, `sync_key_wraps`,
  `sync_objects`, `sync_usage`: encrypted sync (migration `0002`).
- `donations`: sealed opt-in samples, with no user, device or IP column.
- `feedback`: Send feedback notes (migration `0005`), with no user, device or
  IP column and only the day each arrived. Read them with
  `select received_on, message, app_info from feedback order by received_on desc`.

## Sign-in: Supabase Auth

Supabase is used for identity only (no Supabase database tables). In the
Supabase project:

1. **Authentication → Providers → Email**: on, with *Confirm email* on. In
   **Email Templates → Magic Link**, put the code in the message (`{{ .Token }}`):
   the apps ask for the 6-digit code rather than following a link.
2. **Providers → Apple, GitHub, Google**: on, each with its client id and secret.
3. **URL Configuration → Redirect URLs**: add `http://127.0.0.1:*/callback`
   (the desktop's loopback listener picks a free port) and
   `nekko-agent://cloud-callback` (the iPhone).
4. **JWT signing keys**: the default asymmetric keys need nothing more here;
   the service verifies tokens against the project's JWKS. A project still on
   the legacy HS256 secret also sets `SUPABASE_JWT_SECRET`.

Then on the service:

```bash
fly secrets set SUPABASE_URL='https://<project>.supabase.co' SUPABASE_ANON_KEY='<anon or publishable key>'
```

Without both, the `/v1/auth/*` routes answer 503 and the apps say sign-in isn't switched on.

Setting a plan by hand until Stripe writes it: `update users set plan = 'pro' where lower(email) = lower('…');`

## Local dev stack

`npm run dev:local` runs the whole service on `http://127.0.0.1:4330` with
Postgres in memory (PGlite; `DEV_DATA_DIR` keeps it in a folder) and a stand-in
for Supabase Auth on the same port: email codes are printed to the console
(`DEV_CODE=123456` fixes them), and Apple, GitHub and Google sign in at once as
`<provider>-dev@example.com`. New accounts start on `DEV_PLAN` (default `pro`).
Point the desktop at it with `NEKKO_CLOUD_URL=http://127.0.0.1:4330`, the
iPhone (debug builds) with the `-cloudAPI http://…` launch argument, and the
engine's end-to-end test with
`NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test live`.

## Database: Neon recommended

Any recent Postgres works, but production runs on [Neon](https://neon.tech) and it
is what we recommend for anyone running their own copy of this service. It
scales to zero like the Fly machine, so an idle deployment costs nothing, and
its branches give each environment its own database.

1. Create a Neon project in `aws-us-east-1` (next to `iad` in `fly.toml`), or
   with the CLI: `npm i -g neonctl && neonctl auth && neonctl projects create --name nekko-agent-api`.
2. Copy the **pooled** connection string (host contains `-pooler`) with
   `sslmode=require`: `neonctl connection-string --pooled`.
3. Set it as `DATABASE_URL` (see Deploy below). Migrations run on start, so
   there is nothing else to set up.
4. Optional: a branch per environment (`neonctl branches create --name staging`)
   for a staging deploy or for trying a migration against a copy of production.

The service is the only part of Nekko Agent that needs a database; the app,
the Local Web UI and the relay run without one. See
[Architecture: where data lives](../../docs/hub/architecture.md#where-data-lives).

## Run it

```bash
npm ci
npm test            # PGlite in memory, no database needed
DATABASE_URL=postgres://... npm run build && npm start
```

## Deploy (Fly.io)

From `apps/nekko-agent-api`, logged in with `fly auth login`:

```bash
fly apps create nekko-agent-api --org <org>
fly secrets set DATABASE_URL='<Neon pooled connection string, sslmode=require>'
fly deploy --ha=false
```

`--ha=false` keeps it to one machine (Fly makes two by default). Neon's project
should be in `aws-us-east-1`, next to the `iad` region in `fly.toml`.

## Cost

Fly has no spending cap or billing alert; usage past the credits is billed to
the card. So `fly.toml` holds the ceiling instead: one `shared-cpu-1x` 256 MB
machine, auto-stopped when idle, no autoscaler, no volume, and the shared IPv4
(do not `fly ips allocate-v4`, a dedicated one is $2/month). Always on, that is
about $2/month plus bandwidth. For a hard $100 stop, put Fly on a card with a
$100 monthly limit.
