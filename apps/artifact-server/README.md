# Nekko Artifacts server

Publishes an artifact (an HTML page with the files it loads, a document, an
image, a report) at a stable URL anyone with the link can open. Republishing
keeps the URL and adds a version. You can run it yourself; Nekko Cloud will
run the same server.

Spec: [spec/chat/publishing-artifacts.md](../../spec/chat/publishing-artifacts.md).

## Run it

With Docker:

```sh
cd apps/artifact-server
echo "NEKKO_ARTIFACTS_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d
```

From the repo, without Docker:

```sh
npm run build -w @nekko-agent/artifact-server
NEKKO_ARTIFACTS_TOKEN=$(openssl rand -hex 32) npm start -w @nekko-agent/artifact-server
```

The upload API listens on port 4500 and the published artifacts on 4501.

## Two origins

Published pages are arbitrary HTML and JavaScript, so they are served from a
different origin than the API (a different port locally, a different hostname
behind a proxy). Never serve them from a path under your app's or the API's
domain: give them their own hostname and set `NEKKO_ARTIFACTS_PUBLIC_URL` to it.

Every page also runs under a CSP sandbox in an opaque origin: it has no cookies
or storage, it loads only files from its own folder (`<public URL>/<id>/`),
and it can't submit forms. Those rules apply wherever the server runs.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `NEKKO_ARTIFACTS_TOKEN` | (required) | The owner's token, at least 32 characters. |
| `NEKKO_ARTIFACTS_PUBLIC_URL` | `http://localhost:4501` | Where published artifacts are reachable; it goes into every URL. |
| `NEKKO_ARTIFACTS_DATA` | `./data` (`/data` in Docker) | The folder artifacts are stored in. |
| `NEKKO_ARTIFACTS_API_PORT` | `4500` | |
| `NEKKO_ARTIFACTS_CONTENT_PORT` | `4501` | |
| `NEKKO_ARTIFACTS_HOST` | `0.0.0.0` | |
| `NEKKO_ARTIFACTS_MAX_ARTIFACTS` | `100` | Artifacts published at once. |
| `NEKKO_ARTIFACTS_MAX_MB` | `25` | Size of one version. |
| `NEKKO_ARTIFACTS_MAX_FILES` | `500` | Files in one version. |
| `NEKKO_ARTIFACTS_KEEP_VERSIONS` | `10` | Older versions are deleted on republish. |

## API

Every `/v1` call takes `Authorization: Bearer <token>`. Files travel as base64.

| Call | Does |
| --- | --- |
| `POST /v1/artifacts` | Publishes. Body: `{ title?, visibility?, entry?, files: [{ path, data }] }`. Returns the artifact with its `url`. |
| `PUT /v1/artifacts/:id` | Republishes as a new version under the same URL. Same body; `title` and `visibility` keep their value when left out. |
| `GET /v1/artifacts` | What this token has published, newest first. |
| `GET /v1/artifacts/:id` | One artifact, with its versions. |
| `DELETE /v1/artifacts/:id` | Unpublishes it and deletes its files. |
| `GET /v1/usage` | How many artifacts and bytes this token uses, and its limits. |

`visibility` is `unlisted` (the default: reachable by its unguessable link, and
kept out of search engines) or `public`. `entry` is the file the URL opens;
it defaults to `index.html`, or to the only file.

```sh
curl -s -X POST http://localhost:4500/v1/artifacts \
  -H "Authorization: Bearer $NEKKO_ARTIFACTS_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Hello\",\"files\":[{\"path\":\"index.html\",\"data\":\"$(printf '<h1>Hello</h1>' | base64)\"}]}"
```

Errors come back as `{ error, message }`, with `message` ready to show to the
user: `limit_reached` (403), `too_large` and `too_many_files` (413),
`bad_path`, `bad_entry` and others (400), `unauthorized` (401), `not_found` (404).

## Not yet

Storage in an S3-compatible bucket, password and expiry links, serving an
older version by its own URL, and a bandwidth limit.
