---
title: "Sign in with ChatGPT on the phone (2026-11-23)"
area: phone
status: in-progress
---

# Sign in with ChatGPT on the phone

Issue: [#3244](https://github.com/nekko-labs/nekko-agent/issues/3244). Decision: [0118](../../docs/decisions/0118-phones-sign-in-to-chatgpt-themselves.md). Desktop: [signing in with a subscription](../models/signing-in-with-a-subscription.md).

## User intent

Philip (2026-11-23): "I want the phone ChatGPT provider to use the subscription instead of the API", then chose option B: the phone signs in to ChatGPT itself, rather than borrowing a paired computer's sign-in.

## What the person sees

- **iPhone:** Settings, Models on This iPhone. **ChatGPT** is the first of the provider buttons. Android: phone chats, Add provider, **ChatGPT**, which is first in the list.
- The form for ChatGPT is one button, **Sign in with ChatGPT**. It has no key field and no address, and a short note says the phone keeps its own sign-in, that OpenAI's terms are written around its own apps, and that an OpenAI API key works too.
- The ChatGPT sign-in opens in the browser sheet (iPhone) or the browser (Android). After approving, the page says *Signed in to ChatGPT* and sends the browser back to the app. The app swaps the code for this phone's own tokens, reads the plan's models, and keeps the provider: *ChatGPT connected.*
- Chats then run on the plan, with the models the plan lists (the same list the desktop reads), photos included. No per-token bill, and no API key anywhere.
- **Signing in again** (after it expires, or to change accounts) replaces the sign-in on the existing ChatGPT provider; its chats stay.
- An expired sign-in says *Your ChatGPT sign-in has expired. Sign in again.* Reaching the plan's limit says so, with how long to wait when ChatGPT says.

## How it works

- The same public PKCE sign-in as the desktop and the Codex CLI: client `app_EMoamEEZ73f0CkXaXp7hrann`, `https://auth.openai.com/oauth/authorize`, the same parameters, and the redirect `http://localhost:1455/auth/callback`, the only one OpenAI accepts for that client.
- While the sign-in is open, the app listens on the phone's loopback interface, port 1455: Network.framework (`NWListener`, loopback only) on the iPhone, a loopback `ServerSocket` on Android. It takes only `GET /auth/callback` carrying the sign-in's own random `state`; anything else gets a 404. It closes after the answer, on Cancel, or after ten minutes. The answer's page redirects the browser to `nekko-agent://chatgpt-signed-in`, which closes the iPhone's sheet and brings Android back to phone chats.
- If something else holds port 1455, the form says so and nothing is opened.
- The code is swapped at `https://auth.openai.com/oauth/token` (form-encoded). The account id comes from the id token's `chatgpt_account_id` claim; the expiry from the access token.
- Chats go to `https://chatgpt.com/backend-api/codex/responses` (the Responses API) in the Codex CLI's request shape: `instructions`, `input`, `stream`, `store: false`, and no token cap or temperature, which the backend refuses. The model list is `GET /codex/models?client_version=0.171.0`, filtered and ordered as on the desktop.
- Five minutes before the access token runs out, the next request first renews it with the refresh token, one renewal at a time per provider.

## Privacy and security

- The phone holds **its own** refresh token. It never copies one from a computer, and a computer never gets the phone's: OpenAI replaces a refresh token each time it is used, so two installs sharing one would sign each other out.
- The tokens are this provider's key: in the iPhone's Keychain, or sealed by the Android Keystore, like every other phone key. They never reach a computer, the relay or Nekko Cloud, and are never logged.
- The listener binds loopback only and checks `state`, so another device on the network can't reach it and a forged callback is ignored.
- Provider error text is never shown (it can echo credentials); failures are explained from status and error codes.
- As on the desktop, OpenAI's terms are written around its own apps; the sign-in is offered as-is and the API key path stays.

## Status

- Implemented (2026-11-23):
  - **Android:** protocol (`ChatGptSignIn.kt`, `PhoneProviders.kt`) and app (`PhoneChats.kt`, `PhoneScreen.kt`, `PhoneHTTP.kt`, `DeepLink.kt`).
  - **iPhone:** NekkoKit (`ChatGPTSignIn.swift`, `PhoneProviders.swift`, `PhoneChats.swift`) and app (`ChatGPTCallbackListener.swift`, `PhoneViews.swift`, `PhoneProviderViews.swift`, `URLSessionPhoneHTTP.swift`).
- Verified: Android protocol JVM tests (`ChatGptSignInTest`, 13), including a real loopback round trip through the listener, and the existing provider suites.
- Not yet verified:
  - The Android app tests (`PhoneChatsTest`); this environment had no Android SDK.
  - The iPhone code: no Swift toolchain was available, so it was not compiled.
  - A real sign-in against OpenAI on a device, the browser's handling of `localhost:1455` (iOS sheet and Android browsers), and Android's foreground behaviour while the browser is open.
  - Screenshots.
