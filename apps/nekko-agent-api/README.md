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

- `POST /v1/signups` with JSON `{ email, name?, list?, source?, utm?, marketing?, policyVersion?, website? }`.
  `marketing` (boolean, default false) is the separate "also send me product
  updates" consent and `policyVersion` (at most 32 of `A-Za-z0-9._-`) the
  privacy policy version the form showed; both are stored on the row and a
  repeat signup replaces them. Beta mail never depends on `marketing`; any
  product-update mail must go only to `marketing_opt_in` rows.
  `list` defaults to `beta`. `source` keeps a page path only, `utm` keeps
  `utm_*` keys only, anything else is dropped. `website` is a honeypot the form
  hides; a filled one gets a fake success. Always answers `202 {ok:true}` on
  valid input, new or repeat, so the form can't reveal who is on the list.
  Browser calls are accepted only from `ALLOWED_ORIGINS`; 5 per IP per hour.
  Double opt-in: a pending signup gets one "Confirm you want to join the Nekko
  Agent beta" email (Resend, from `hello@mail.nekkoagent.com`, reply-to
  `hello@nekkoagent.com`), at most one per address per day. Without
  `RESEND_API_KEY` the signup saves and the email is skipped with a log line.
- `GET /v1/signups/confirm?token=`: uses the email's single-use link (only its
  SHA-256 is stored; 7 days) and marks the signup `confirmed`; answers a small
  HTML page. Only the newest email's link works.
- `GET|POST /v1/signups/unsubscribe?token=`: one-click unsubscribe from the
  link in every email, and RFC 8058 `List-Unsubscribe-Post` from mail apps.
  Unsubscribing deletes the address's signup rows and keeps only a SHA-256 of
  it in `email_suppressions`, which no email is ever sent to (a later signup
  saves but gets no email).
- Retention: every 6 hours (and on start) pending signups not confirmed
  within 30 days of their last confirmation email (never one that wasn't
  emailed), and any row marked `unsubscribed`, are deleted in one
  transaction; confirmed, invited and joined rows are never touched.
  Links point at `PUBLIC_URL` (default `https://nekko-agent-api.fly.dev`).
- `/v1/sync/*`: end-to-end encrypted sync for Pro and Team (see
  [docs/SYNC-ENCRYPTION.md](../../docs/SYNC-ENCRYPTION.md)). Bearer `nk_` tokens
  (stored as SHA-256); the service stores only ciphertext, opaque ids and
  revisions and never holds a key that opens them. Writes need `users.plan` in
  `pro`/`team` (402 otherwise); reading, revoking and `DELETE /v1/sync` work on
  any plan.
- `/v1/fleet`: experimental **user-owned computer discovery**, not hosted
  machines or remote execution. Routes exist only with `NEKKO_FLEET_ENABLED=1`
  (also in `dev:local`). All discovery/publish/heartbeat calls require a live
  sync device with a wrap and proof for the current encrypted-account epoch;
  account sign-in alone is insufficient. `GET` lists this account's encrypted
  descriptors and 90-second presence leases; `PUT /self` publishes only the
  caller's computer with `{keyId, revision, descriptor}`; `POST /self/heartbeat`
  renews its lease; `DELETE /self` withdraws it. Publishing/heartbeats need
  Pro/Team; reads and withdrawal remain available after downgrade. Descriptors
  are capped at 16 KiB, with at most 100 retained advertisements per account.
  Sign-out, expiry, revocation and key rotation invalidate discovery. Desktop
  enrollment, descriptor crypto, phone connections and local-model execution
  are **not implemented by these routes**. Keep disabled until those are
  verified. See [account fleet spec](../../spec/phone/account-synced-computer-fleet.md).
- `/v1/orgs`: **organizations and their shared computer fleet** (decision 0086,
  [spec](../../spec/platform/organizations.md)). Routes exist only with
  `NEKKO_ORGS_ENABLED=1` (always on in `dev:local`), independent of the account
  fleet flag. `NEKKO_ORGS_ALLOWED_EMAILS` (comma-separated, lower-cased) limits
  who may create orgs, accept invites or call the org fleet routes (403
  `orgs-not-available`); unset allows everyone. All routes are Bearer `nk_`,
  `Cache-Control: no-store`, inside the authenticated rate limit. Wire shapes:
  `Org {id, name, role, keyId, memberCount, createdAt}`,
  `Member {userId, email, role, addedAt, you}`, `Invite {id, email, role, createdAt, expiresAt}`,
  `FleetComputer {deviceId, userId, orgKeyId, revision, descriptor, seenAt, expiresAt, online, you}`.
  - `GET /v1/orgs` -> `{orgs, invites}` (invites addressed to the caller's email:
    `{id, orgId, orgName, role, invitedBy, expiresAt}`). `POST /v1/orgs {name}` (Pro/Team,
    201, caller becomes owner; 409 `org-limit` at 20 orgs). `GET /v1/orgs/:orgId`
    -> `Org & {members, invites}` (invites for owner/admin only). `PATCH` rename
    (owner/admin), `DELETE` (owner, 204). A non-member gets 404 `not-found` on every
    org route; a member without the role gets 403 `forbidden`.
  - `POST /v1/orgs/:orgId/invites {email, role?}` (owner/admin, role `admin` or
    `member`, 201; 409 `invite-exists`, `already-member`, `org-full`). No email is sent
    yet. `DELETE /v1/orgs/:orgId/invites/:inviteId` (204). `POST /v1/orgs/invites/:inviteId/accept`
    -> `Org` (the account's email must match; otherwise 404; 410 `invite-expired`;
    invites last 14 days).
  - `DELETE /v1/orgs/:orgId/members/:userId`: owner removes anyone, admin removes
    members, anyone removes themself. 409 `last-owner`. Deletes that user's org
    computers and answers `{rotateKey: true}` (the server holds no key, so a
    key-holding client rotates).
  - `PUT /v1/orgs/:orgId/key {keyId, proof?}`: advance the org-key epoch to exactly
    current + 1 (409 `org-key-epoch` with `currentKeyId`); owner/admin on an unlocked
    device; answers `{keyId}`. Older-epoch computers stay stored but are hidden
    until republished.
  - Org fleet: `GET /v1/orgs/:orgId/fleet` -> `{orgKeyId, computers}`;
    `PUT /v1/orgs/:orgId/fleet/self {orgKeyId, revision, descriptor}` (Pro/Team; 201
    first time, 200 after; 400 `bad-descriptor`, 409 `org-key-epoch` / `revision` /
    `fleet-full`); `POST .../fleet/self/heartbeat` (409 `publish-required`);
    `DELETE .../fleet/self` (204, any plan, no unlock, needs a device token). Reads,
    publish and heartbeat need org membership **and** an unlocked device (403
    `needs-synced-device`), like the account fleet. A computer is listed only for the
    org's current key, from a current member's unrevoked device with a live,
    proven token. 90-second presence lease. Limits: 100 members and 100 computers
    per org, 20 orgs per user.
- `GET /v1/auth/config`, `POST /v1/auth/session`, `GET /v1/auth/me`,
  `DELETE /v1/auth/session`: sign-in.
- `DELETE /v1/account` (Bearer `nk_` token): deletes the account for good
  (decision 0043). Destroys every cloud machine it had on Fly first (502
  `machine-teardown-failed` and nothing deleted if one can't be), then in one
  transaction deletes the user and everything referring to it, deletes its
  signups and puts the address's hash in `email_suppressions`; last, deletes
  the Supabase Auth user (`SUPABASE_SERVICE_ROLE_KEY`; a failure waits in
  `pending_auth_deletions` and is retried hourly). 204, or 401 without a valid
  token. The app signs in to Supabase Auth and
  trades the access token here for its own `nk_` device token (180 days from
  last use). Supabase proves identity only; accounts, plans and data stay in
  this database.
- `POST /v1/donations`, `DELETE /v1/donations/:id`: opt-in samples sealed to
  the offline research key. Unauthenticated, not request-logged, no sender
  columns; withdrawn with the device's delete token, expired after 180 days.
- `/v1/machines`: **Nekko Cloud machines** (decision 0017, `spec/phone/nekko-cloud-machines.md`):
  a sandboxed machine per user that the phone pairs with like any computer.
  `GET` lists them; `POST {name?, region?, scope?}` (Pro and Team, at most 3)
  mints a relay room, a pairing key and a one-time pairing code, starts the
  machine on Fly with them in its environment, and answers the pairing link
  once (only the key's hash is stored, so this service can never open the
  machine's relay frames); `GET /:id`, `PUT /:id/scope` (what the phone lets
  the cloud see: `repos`, `privacyShield`, `memory`, `syncBack`; applies on
  the next start), `POST /:id/stop`, `POST /:id/start` (metered against the
  plan's machine hours), `DELETE /:id`. `POST /v1/relay/authorize` is the
  relay's enrolment gate (`NEKKO_RELAY_AUTHZ_URL`): a machine's `nkm_` access
  token as a Bearer. On when `FLY_API_TOKEN` and `FLY_MACHINES_APP` are set
  (`NEKKO_RELAY_URL`, `NEKKO_MACHINE_IMAGE` optional); the routes are absent
  otherwise. Tests run against an in-memory driver.
- `POST /v1/feedback`: the quick note from any app's Send feedback sheet,
  `{ message, app? }` (`src/feedback.ts`). Unauthenticated, not request-logged,
  10 per IP per hour (counted in memory). `app` comes only when the sender
  switched on "Include app info", and only `app`, `version`, `os`, `osVersion`
  and `arch` are kept. A body with `screenshots` is refused here.
- `POST /v1/feedback/screenshots`: the same note with 1 to 3 screenshots,
  `{ message, app?, screenshots: [{ type, data }] }`, `data` base64 of a PNG or
  JPEG up to 5 MB (`src/screenshots.ts`). Each must be a whole, well-formed
  image of its type (`400 bad-screenshot` with its index otherwise, and nothing
  is stored); metadata is stripped before storing. Counts against the 10 notes
  per IP per hour, plus 3 with screenshots per IP per hour and 2 uploads at
  once (`503 busy`), all checked before the body is read.
- `GET /healthz`: Fly's health check. The machine stops when idle and wakes on
  the next request in about a second; the signup page should call this on load
  so that happens before anyone presses Join.

## Logs and alerts

Request log lines hold method, path (never the query string), status and
timing: no client IP, port or host, so the tokens in confirm and unsubscribe
links stay out of Fly's logs (`LOG_SERIALIZERS` in `src/server.ts`). Rate
limits count IPs in memory only.

With `ALERT_EMAIL` set (and `RESEND_API_KEY`), a 5xx answer or a failed
background job emails that address, at most once per 15 minutes, naming only
the route or job (`src/alerts.ts`). What to do next:
[the privacy incident runbook](../../docs/runbooks/privacy-incident.md).

```bash
fly secrets set ALERT_EMAIL='<who gets alerts>'
```

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
- `feedback_screenshots`: a note's screenshots (migration `0013`), cleaned of
  metadata, with no file name; deleted with the note and 90 days after it
  arrived (`purgeFeedbackScreenshots`). Read them with
  `select position, type, encode(data, 'base64') from feedback_screenshots where feedback_id = $1 order by position`
  and decode the base64 locally.
- `cloud_machines`: one row per Nekko Cloud machine (migration `0006`): region,
  size, state, the hosting provider's machine id, the relay room, the hashes of
  the pairing key and of the relay access token, the scope, hours used.
- `machine_usage`: machine seconds per account per month (migration `0007`).
- `fleet_computers`: opt-in encrypted user-owned computer advertisements, their
  publishing device/token, epoch, revision and presence timestamp (migration
  `0014`). No model names, connection coordinates or secrets in plaintext.
  Revocation, sync deletion and account deletion remove the corresponding rows;
  withdrawal retains a hidden revision guard.
- `orgs`, `org_members`, `org_invites`, `org_fleet_computers` (migration `0015`):
  organizations, their roster with roles, invites addressed to a lower-cased email
  (14 days), and sealed computer descriptors per org (publishing device, user and
  token, org key epoch, revision, presence). `orgs.key_id` is only the epoch
  number. Removing a member, revoking a device, `DELETE /v1/sync` and account
  deletion remove the matching computers; account deletion also deletes orgs the
  account alone owns.
- `signups.marketing_opt_in`, `signups.policy_version` (migration `0011`):
  marketing consent apart from the beta, and the policy version agreed to.
- `pending_auth_deletions` (migration `0012`): Supabase users still to delete
  after their account was deleted here; only the Supabase user id.

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

Account deletion also removes the Supabase Auth user, which needs the
project's **service-role key** (Project Settings → API keys; server-side only,
never in an app):

```bash
fly secrets set SUPABASE_SERVICE_ROLE_KEY='<service_role or secret key>'
```

Without it, deleted accounts' Supabase users wait in `pending_auth_deletions`
and are deleted on the first hourly run after the key is set.

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
