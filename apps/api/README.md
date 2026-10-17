# Nekko Agent API

The small public backend behind nekkoagent.com: beta signups now, accounts later.
Fastify on one small Fly.io machine, Postgres on Neon's free plan. It is its own
npm package (not a root workspace) so the image holds only this folder.

## Endpoints

- `POST /v1/signups` with JSON `{ email, name?, list?, source?, utm?, website? }`.
  `list` defaults to `beta`. `source` keeps a page path only, `utm` keeps
  `utm_*` keys only, anything else is dropped. `website` is a honeypot the form
  hides; a filled one gets a fake success. Always answers `202 {ok:true}` on
  valid input, new or repeat, so the form can't reveal who is on the list.
  Browser calls are accepted only from `ALLOWED_ORIGINS`; 5 per IP per hour.
- `GET /healthz`: Fly's health check. The machine stops when idle and wakes on
  the next request in about a second; the signup page should call this on load
  so that happens before anyone presses Join.

## Database

`migrations/NNNN_*.sql` run in order on every start, inside one transaction under an advisory lock, recorded in
`schema_migrations`.

- `signups`: one row per email per list (`unique (list, lower(email))`), status
  `pending → invited → joined` or `unsubscribed`, optional `user_id`.
- `users`: the long-term account record (`unique lower(email)`); a signup that
  gets let in becomes a user. Nothing writes it yet.

## Run it

```bash
npm ci
npm test            # PGlite in memory, no database needed
DATABASE_URL=postgres://... npm run build && npm start
```

## Deploy (Fly.io)

From `apps/api`, logged in with `fly auth login`:

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
