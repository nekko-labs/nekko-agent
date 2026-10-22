---
title: "Signing in with a subscription (planned)"
area: models
split-from: SPEC.md (2026-10-22)
---

# Signing in with a subscription (planned)

`[removed 2026-10-19]` Claude plan sign-in is gone (see "Claude plan sign-in removed" under Decisions); this paragraph now describes ChatGPT only. A user with a **ChatGPT Plus/Pro/Business** subscription clicks **Sign in with ChatGPT** on the Models page (or in onboarding), approves in the browser tab that opens, and lands back on a connected provider marked **Subscription**, no API key, no per-token billing. The flow uses the same public OAuth sign-in the vendor's own CLI uses; the honest caveat shown next to the button is that the vendor's terms are written around their own apps, so the subscription path is offered as-is and the API-key path remains fully supported. Headless or remote setups get a paste-the-code fallback, and anyone already signed in to the Codex CLI can **import** that session in one click instead of repeating the browser flow. Sign out revokes the local token; a failed refresh prompts re-auth rather than silently falling back. `[fixed 2026-10-01]` The ChatGPT callback listens on port 1455; when that port is already held, Nekko Agent closes a stale sign-in attempt of its own still parked there and retries once, and only when the holder is a stranger does it fall back to the paste flow. The manual path keeps the same redirect address (the code rides in it) and tells the user to copy the address bar of the browser's error page, which is the only place that URL appears, rather than hunt for a code that page does not show.
