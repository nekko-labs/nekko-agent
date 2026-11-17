---
title: "iPhone: real brand marks for sign-in and providers (2026-11-17)"
area: phone
---

# iPhone: real brand marks for sign-in and providers

Issue: [#2930](https://github.com/nekko-labs/nekko-agent/issues/2930). `[implemented 2026-11-17 on the iPhone, native-unverified: no Mac was available to build or screenshot it]`

## User intent

Philip (2026-11-17, from app 0.10.1005): the Nekko Cloud sign-in buttons use stand-in symbols (a code glyph for GitHub, a circled G for Google). Wherever the app names a company or provider, use that company's real mark, the same artwork the desktop ships.

## What the user sees

- **Nekko Cloud sign-in.** *Continue with Apple* is Apple's own style for Sign in with Apple: a solid black button (white in dark mode) with the Apple logo and white (black) text, no border, at least 44 high. *Continue with GitHub* shows GitHub's mark in the ink colour. *Continue with Google* shows Google's four-colour G on a plain surface.
- **Providers.** The model picker's provider headings show the provider's mark (Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, vLLM), from the same vector artwork as the desktop's `providers/*.svg` and the chat row's model line. A custom endpoint has no mark of its own and shows a link glyph. `BrandMark.asset(forProviderKind:)` maps a provider kind to its mark exactly as the desktop's `ProviderMark.tsx` does.

## Where the artwork comes from

Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio and vLLM: Lobe Icons (MIT), already in the asset catalog as `ProviderMarks`. New: GitHub's `mark-github` from Octicons (MIT, GitHub's trademark), and the Google G as the same Lobe outline split into its four parts and coloured with Google's brand colours. The Apple logo is the system's `apple.logo` symbol, never redrawn. Credits and licenses are in [ASSETS.md](../../ASSETS.md); the iOS notice ships as `apps/ios/App/BrandMarks-LICENSE.txt`. The names and marks belong to their owners.

## Not done / unverified

- No screenshots yet (needs `node scripts/ios-evidence-local.mjs` on a Mac).
- The sign-in still goes through the web sheet, so the Apple button is Apple-styled but not the native `SignInWithAppleButton`. Native Sign in with Apple is not part of this change.
- Android: [gaps row](ios-and-android-stay-in-step.md).
