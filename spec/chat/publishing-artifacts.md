---
title: "Publishing artifacts (Nekko Artifacts)"
area: chat
---

# Publishing artifacts (Nekko Artifacts)

**Status:** `[server implemented 2026-11-03, unit-tested, isolation checked in headless Chrome; not yet in the app, not yet hosted]`. Tracked in #616: the build is #1622, the hosting decisions are #1621.

## What it is for

Artifacts are already first-class inside Nekko Agent ([chat artifact cards and session-local documents](chat-artifact-cards-and-session-local-documents.md)). Publishing takes one out of the computer: an HTML page, doc, image, report or dashboard gets a URL that opens in any browser and on a phone, for people who don't have Nekko Agent.

## How it behaves

- **Publish** gives an artifact a stable URL. **Republish** keeps the URL and adds a version; the URL always serves the newest. Older versions are kept up to a limit (10 by default), then deleted.
- **Visibility.** `unlisted` (the default) is reachable only by its unguessable link (130 random bits) and asks search engines not to index it. `public` lets them. Password and expiry links are planned.
- **Static only** for the beta: HTML, CSS, JS, images, fonts, media, PDFs and data files. No code runs on the server. The API is shaped so stored state can be added later without changing URLs.
- **Where it is published.** Any artifact server: one the user runs (`apps/artifact-server`, one `docker compose up`), or Nekko Cloud's once it is hosted. Both run the same server; only the configuration differs.
- **Limits** are enforced by the server per token: artifacts published at once, MB per version, files per version, versions kept. Over a limit, the server answers with a message the app shows as is. The hosted free and paid numbers are not decided (#1621); a self-hosted server sets its own.

## Security and privacy boundaries

- **Isolated origin.** Published pages are served from their own origin (a separate hostname in production, a separate port locally), never from the app's, the API's or a path under them.
- **Sandboxed.** Every published response carries a CSP with `sandbox` and without `allow-same-origin`, so a page runs in an opaque origin: no cookies, no `localStorage`, nothing shared with another artifact or with the server's origin.
- **Its own folder only.** Every CSP source is the artifact's own folder (`<public URL>/<id>/`): a page loads and fetches nothing from other artifacts or other sites, and `form-action 'none'` stops it submitting a form anywhere, which also rules out the simplest credential-collection page. Its own files can be fetched (`Access-Control-Allow-Origin: *`, with no credentials involved).
- **No cookies, ever,** on the content origin. Unknown file types are served as downloads, never rendered. `nosniff`, `no-referrer`, `Cross-Origin-Opener-Policy: same-origin` and a Permissions-Policy that denies camera, microphone, location and payment.
- **Who may publish.** The upload API needs a bearer token; the server keeps only its SHA-256. Another token's artifact answers "not found", so ids can't be probed.
- **What stays local.** Nothing leaves the computer until the user publishes, and then only the files they publish.
- Checked on 2026-11-03 in headless Chrome against the built server: the page's own CSS, image and `data.json` load; `localStorage` and `document.cookie` throw; a fetch of another artifact or of `https://example.com` and a form posted to another site are blocked.

## Not decided yet (#1621)

The provider that hosts Nekko Cloud artifacts, the domain for the isolated origin, the free and paid limits, billing, and the hosted abuse policy (reports, takedowns, scanning). Also open: whether pages may load scripts and styles from a CDN. Today they may not (sources are the artifact's own folder); the app's Publish step can bundle what a page loads instead.

## Planned (#1622)

- Storage in any S3-compatible bucket (R2, Tigris, Supabase Storage, MinIO), beside the local folder.
- In the app: Settings → Artifacts (add a server with its URL and token, kept in the token store; see what is published), a **Publish** action on artifact cards and in the file pane (server, visibility, copy URL), and bundling the local files an HTML artifact loads.
- The `publish_artifact` tool for the agent, always behind approval.
- Password and expiry links, a URL per older version, and a bandwidth limit.

## Acceptance

- `docker compose up` starts a server; the app publishes an HTML artifact to it and gets a URL. `[server side met; the app side is planned]`
- The URL opens in an incognito browser and on a phone. Republishing keeps the URL and adds a version. `[met for the server in tests and headless Chrome; phone not yet checked]`
- A published page can't read the app's or the API's cookies or storage, nor another artifact's files. `[met: tests on the served headers, and headless Chrome]`
- Going over a limit gives a clear message in the app. `[the server's messages are met; showing them in the app is planned]`
- A security review of the isolated origin and the CSP before the hosted tier launches. `[not done]`
