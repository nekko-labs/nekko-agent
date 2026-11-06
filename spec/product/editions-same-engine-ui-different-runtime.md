---
title: "Editions, same engine + UI, different runtime"
area: product
split-from: SPEC.md (2026-10-22)
---

# Editions, same engine + UI, different runtime

Nekko Agent ships the **same engine + same React UI** in several runtimes; from the user's point of view it's the same product wherever it runs (only the host transport differs, see `TASKS.md` and [spec-web-and-hosted.md](spec-web-and-hosted.md)):

- **Desktop** (Electron), the primary experience, available today (installers on GitHub Releases).

**Installing the desktop app (2026-10-17).** `[implemented; Windows signing waits on Azure identity validation]` Installing should take one gesture and raise no scary warnings. On **macOS** the `.dmg` opens to a branded drag-to-install window: the app on the left, the Applications folder on the right, and a pixel Nekko leaping between them under "Drag the cat into Applications". The app inside is Developer ID signed, notarized and stapled, so it opens without a Gatekeeper prompt. On **Windows** the `.exe` is a one-click installer: double-click, a short branded progress window, and the app opens, installed per user with Start Menu and desktop shortcuts, no admin prompt and no wizard pages. It is Authenticode-signed through Azure Artifact Signing in Nekko Labs LLC's name once that identity is validated; until then it ships unsigned and SmartScreen shows "unknown publisher". Uninstalling asks whether to keep chats and settings; updates never remove them. How it is wired: [docs/signing.md](docs/signing.md). `[updated 2026-11-01]` An in-app update is installed only when it is signed by the same publisher as the running app: on macOS a strict `codesign` check against the running app's Developer ID team before the swap (a failed check reopens the running app), on Windows the same Authenticode subject as the running app; a local or unsigned build skips the check.
- **Self-hosted web**: `npx nekko-agent` or `npm run web` starts a local server that serves the same UI in a browser; offline-first.
- **Docker**: `docker compose up`, workspaces as mounted volumes, local models reachable via `host.docker.internal`.
- **Nekko Cloud** (paid), managed hosting with subscriptions, an always-available **Zero-Data-Retention** mode, cloud chat-history + file management, and **phone connectivity to your locally-running model** via a secure relay.
