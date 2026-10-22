---
title: "Local marketing website preview (2026-10-17)"
area: brand
split-from: SPEC.md (2026-10-22)
---

# Local marketing website preview (2026-10-17)

`[implemented; unit-tested; verified by serving the site locally and loading pages and docs]` `npm run website` serves the static marketing site and docs in `apps/website` on `http://127.0.0.1:8080` (set `PORT` to change it), so a contributor can look at a website or docs change before it ships. It needs no build, package installation, agent backend or app data, and every response is `no-store`, so a refresh shows the latest edit.

- **Same URLs as production:** it resolves clean URLs the way `vercel.json`'s `cleanUrls` does, so `/docs` serves `docs/index.html` and `/docs/cli` serves `docs/cli.html`. Redirects and production cache headers are not reproduced.
- **Read-only and local:** it binds loopback only, answers `GET` and `HEAD` (anything else is 405), refuses paths that resolve outside `apps/website` (403) and malformed URLs (400).
- A preview server, not production hosting; nothing on the website itself changes.
