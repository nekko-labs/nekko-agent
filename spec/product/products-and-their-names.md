---
title: "Products and their names (decided 2026-10-18)"
area: product
split-from: SPEC.md (2026-10-22)
---

# Products and their names (decided 2026-10-18)

- **Nekko Agent**: the desktop app (`apps/desktop`) and the engine it runs (nekkod).
- **Local Web UI**: the same UI and engine, served to a browser from your own machine or server (`apps/local-web-ui`; `npx nekko-agent-local-web-ui`, Docker). Not a public web app: a hosted web app is not on the roadmap, and the name keeps room for one.
- **Local Model Server**: the model server Nekko Agent runs on your computer (llama.cpp and the other runtimes, the library, downloads). The app calls its page **Model Server**.
- **Nekko Cloud**: the hosted side. Its code project is `apps/nekko-agent-api` (Fly app `nekko-agent-api`): beta signups today; accounts, plans and billing are a parked module (`apps/nekko-agent-api/cloud`, off and not deployed). It will own user auth and permissions for Relay, and (decided 2026-10-24) **Nekko Cloud machines**, per-user sandboxed machines the phone pairs with ([spec](../phone/nekko-cloud-machines.md)). Planned address: `api.nekkoagent.com`.
- **Relay**: the phone-to-computer pipe, part of Nekko Cloud but a separate service (`apps/relay-server`, Fly app `nekko-agent-relay`). Self-hosting it, or running it on your own computer, stays possible.
- **Agent board** (renamed 2026-10-24, was Command Center): the wall of live agent and terminal windows,. The rail and the page title say **Agents**. In code it is still the `command` view (`CommandCenterView`, `CommandWall`, `command-wall-*` classes, the saved `commandWall` settings), so saved walls carry over untouched.

Older entries below may use the names from when they shipped: the web edition (Local Web UI), Nekko Server (Model Server), Nekko Agent Cloud (Nekko Cloud), Command Center (Agent board).
