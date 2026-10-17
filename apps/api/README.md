# Nekko Agent API

The small public backend behind nekkoagent.com: beta signups now, accounts later.
Fastify on Render's free plan, Postgres on Neon's free plan. It is its own npm
package (not a root workspace) so Render installs only this folder.

## Endpoints

- `POST /v1/signups` with JSON `{ email, name?, list?, source?, utm?, website? }`.
  `list` defaults to `beta`. `source` keeps a page path only, `utm` keeps
  `utm_*` keys only, anything else is dropped. `website` is a honeypot the form
  hides; a filled one gets a fake success. Always answers `202 {ok:true}` on
  valid input, new or repeat, so the form can't reveal who is on the list.
  Browser calls are accepted only from `ALLOWED_ORIGINS`; 5 per IP per hour.
- `GET /healthz`: Render's health check. The signup page should call it when it
  loads, because a free Render instance sleeps after 15 idle minutes and takes
  up to a minute to wake.

## Database

`migrations/NNNN_*.sql` run in order on every start (Render's free plan has no
pre-deploy step), inside one transaction under an advisory lock, recorded in
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

## Deploy

`render.yaml` at the repo root is the Blueprint. In Render: New, Blueprint, pick
this repo, and paste the Neon **pooled** connection string as `DATABASE_URL`.
Deploys follow pushes to `main` that touch `apps/api/`.
