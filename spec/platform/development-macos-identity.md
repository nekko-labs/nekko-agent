---
title: "Development macOS identity"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Development macOS identity

Implemented and native smoke verified on 2026-10-06: `npm run dev` and desktop `start` prepare a separate, locally ad-hoc-signed **Nekko Agent.app** development bundle and launch it through macOS LaunchServices, rather than modifying the shared Electron download or launching directly under Terminal. The native display name is Nekko Agent. Development uses `com.nekkoagent.desktop.dev`, separate from the release identity. Existing macOS privacy grants are not reset or migrated; a disposable macOS runner verified the signed private bundle, preserved shared Electron runtime, Nekko Agent menu/Dock identity, microphone attribution, isolated data profile, owned shutdown/relaunch and full Agent board startup. The native screenshots were directly inspected. No user profile data or grants may be changed for testing. Other platforms retain the normal Electron launcher.

## Development macOS identity

Implemented and native smoke verified on 2026-10-06: `npm run dev` and desktop `start` prepare a separate, locally ad-hoc-signed **Nekko Agent.app** development bundle and launch it through macOS LaunchServices, rather than modifying the shared Electron download or launching directly under Terminal. The native display name is Nekko Agent. Development uses `com.nekkoagent.desktop.dev`, separate from the release identity. Existing macOS privacy grants are not reset or migrated; a disposable macOS runner verified the signed private bundle, preserved shared Electron runtime, Nekko Agent menu/Dock identity, microphone attribution, isolated data profile, owned shutdown/relaunch and full Agent board startup. The native screenshots were directly inspected. No user profile data or grants may be changed for testing. Other platforms retain the normal Electron launcher.


## Import safety (#1841)

Implemented: the development launcher resolves the Electron executable lazily inside macOS/Windows runtime preparation, not when its module is imported. An import checks `ELECTRON_RUN_AS_NODE` before any runtime lookup and does not trigger Electron's lazy binary downloader. Native Node subprocess regressions intercept any Electron require and exercise both refused and allowed imports under the unchanged five-second test budget; they do not launch Electron. This change does not reverify macOS signing/LaunchServices or Windows runtime preparation.
