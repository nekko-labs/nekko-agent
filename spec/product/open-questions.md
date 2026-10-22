---
title: "Open Questions"
area: product
split-from: SPEC.md (2026-10-22)
---

# Open Questions

- Hosting/runtime for Cloud: **the relay now runs on Fly.io** (`nekko-agent-relay.fly.dev`, Nekko Labs org, single machine since rooms are per-machine memory); the Cloud app's host is still open (Fly.io is the natural default now). Relay scaling beyond one machine needs sticky routing (fly-replay by room) when it matters.
- E2E key-management UX (recovery vs zero-knowledge trade-offs).
- ~~Mobile: PWA first, or native shells later?~~ Resolved 2026-10-03: a purpose-built native app (Expo + llama.cpp), with the PWA kept for the full app in a phone browser. Revised 2026-10-07: platform-native SwiftUI (apps/ios) and Kotlin/Compose (apps/android); Expo stays as the reference until parity.
- Phone model storage: models live in the app's Documents folder, which iOS includes in device backups. Exclude them from backup (needs a native flag), or move them somewhere the OS may purge?
- Exact ZDR boundary for cloud-configured (non-local) providers without ZDR tiers, likely "not allowed in ZDR workspaces."
- Do desktop + local web share one data dir by default, or separate? (Lean: share, so the web UI sees your desktop sessions.)
- "Nekko Agent" as a local provider in onboarding now deep-links to **Model Server**, where the engine, the library and the borrowed folders all live. It should still become a real one-click managed-model install rather than a link to a tab.
- Microsoft Teams reads need Microsoft Graph OAuth, which requires an app registration; v1 supports posting via incoming webhook and reads via a pasted token. Whether to register a first-party Nekko Graph app is open.
- Full Gmail/Drive OAuth flow (needs Google client creds); macOS signing + notarization is **done**: the `nekko-labs` org secrets are in place and releases from v0.6.0 on are Developer ID signed and notarized (see [docs/signing.md](docs/signing.md)). Windows Authenticode is pending SignPath Foundation. The npm publish of `nekko-agent` needs an npm credential that may publish it: the v0.6.1 run failed with a 403 on the old package name, so either `NPM_TOKEN` must be able to publish the new name or the first publish is done by hand, after which a Trusted Publisher can be bound to `nekko-labs/nekko-agent`. Provisioning details in [provisioning.md](../../obsurdian/projects/nekko-agent/provisioning.md).
