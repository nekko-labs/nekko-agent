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
  any plan. Nothing issues tokens yet: sign-in is still to come.
- `POST /v1/donations`, `DELETE /v1/donations/:id`: opt-in samples sealed to
  the offline research key. Unauthenticated, not request-logged, no sender
  columns; withdrawn with the device's delete token, expired after 180 days.
- `GET /healthz`: Fly's health check. The machine stops when idle and wakes on
  the next request in about a second; the signup page should call this on load
  so that happens before anyone presses Join.

## Database

`migrations/NNNN_*.sql` run in order on every start, inside one transaction under an advisory lock, recorded in
`schema_migrations`.

- `signups`: one row per email per list (`unique (list, lower(email))`), status
  `pending → invited → joined` or `unsubscribed`, optional `user_id`.
- `users`: the long-term account record (`unique lower(email)`); a signup that
  gets let in becomes a user. `plan` is `free`, `pro` or `team`. Nothing writes it yet.
- `api_tokens`, `sync_devices`, `sync_keyrings`, `sync_key_wraps`,
  `sync_objects`, `sync_usage`: encrypted sync (migration `0002`).
- `donations`: sealed opt-in samples, with no user, device or IP column.

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
