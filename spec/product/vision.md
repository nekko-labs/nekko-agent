---
title: "Vision"
area: product
split-from: SPEC.md (2026-10-22)
---

# Vision

**Nekko Agent** is your local agent, backed by frontier intelligence. It is an open-source assistant for coding, cowork, and repeatable work that blends models running on your hardware with frontier providers. Use its own desktop UI or bring its capabilities into Claude Code, Cursor, Codex, OpenClaw, and other compatible tools through the CLI and MCP. Local-only work can run offline once its models and dependencies are installed; frontier calls and network integrations still require connectivity and may send their selected context to the configured provider.

The primary domain is **nekkoagent.com**; every other domain we own permanently redirects to it with paths and query strings preserved. The repository is **nekko-labs/nekko-agent**, the npm package and CLI command are **nekko-agent**, the bundle id is **dev.nekkolabs.nekkoagent**, and installers are named **NekkoAgent-…**.

The rename is finished and the legacy-name compatibility layer has been retired: only the `nekko-agent` command ships, only `NEKKO_*` environment variables are read, local data lives under `~/.nekko-agent` (desktop profile under `desktop/`, cloud deployments under `cloud/`, unless explicitly overridden), and only `nekko-agent://` deep links resolve. Existing Nekko Agent data from `~/.nekko` or its desktop app-data folder moves only after confirmation; profiles are never merged silently. Release assets and updater feeds published under an older name are immutable and stay where they are, and the earlier domains keep redirecting to the current one.

The personality is a capable, approachable assistant: clear task status, quiet confidence, and generous whitespace take precedence over spy or space metaphors.

Quality bar: on par with Zed / Cursor / Warp / OpenClaw, generous whitespace, minimal chrome, dark/light themes, fast.

The mascot redesign is in draft review: an icon-inspired 8-bit cat head in cream on dark green replaces the secret-agent accessories across desktop, live chat status, marketing, and mobile. It blinks, occasionally shows happy ^ ^ eyes, and uses stepped hops with reduced-motion support. The existing app icon remains unchanged. Cross-platform visual evidence and animation review are still required before shipping.
