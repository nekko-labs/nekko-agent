---
title: "iPhone: provider buttons on Models on This iPhone, and Anthropic's choice (2026-11-17)"
area: phone
---

# iPhone: provider buttons on Models on This iPhone, and Anthropic's choice

Issue: [#2931](https://github.com/nekko-labs/nekko-agent/issues/2931). `[implemented 2026-11-17 on the iPhone, native-unverified: no Mac was available to build or screenshot it]`

## User intent

Philip (2026-11-17), Settings, Models on This iPhone: remove the **On a computer only** section, since this screen is about providers on the phone. Like the desktop, show icon buttons for the popular providers to add one in a tap. Adding Anthropic shows its connection options with **Claude subscription** disabled, a sad message that Anthropic does not allow a subscription from the phone, and a small sad Nekko. The API key option works as before.

## What the user sees

- The **On a computer only** section is gone.
- **Providers**: each provider on this iPhone is an avatar row (its mark, its name, one status line) that opens its page: use on this iPhone (on or off), Test, New key, Remove. The row's old inline switch, swipe actions and touch-and-hold menu moved to that page.
- **Add a provider**: icon buttons for Claude API, OpenAI, Google Gemini, OpenRouter and Ollama Cloud, each starting the add flow already set to that provider (the guided key page or OpenRouter's sign-in as before), and **More providers** for the rest (Bedrock, Foundry, Vertex, any OpenAI-compatible server).
- **Anthropic** first opens its options: **API key** (works as today) and **Claude subscription**, dimmed, with a small sad Nekko and "Sorry, Anthropic doesn't allow a Claude subscription to be used from a phone. Use it on a computer, or add an API key here." Choosing the API key goes on to the usual add sheet.

## The sad Nekko

`SadNekko` is original SwiftUI line art: the same slender outline cat with slim sunglasses as the mascot's family, ears and whiskers drooping, brows raised in the middle, a frown and one tear, in the palette's ink. It is still and decorative (the words carry the meaning).

## Boundaries and status

No behavior of keys, requests or storage changes. The subscription choice is never actionable on the phone. `PhoneProviders.notOnPhone` stays as data but is no longer shown. Not done: screenshots (`node scripts/ios-evidence-local.mjs` on a Mac), native compile and UI test runs. Android: [#2939](https://github.com/nekko-labs/nekko-agent/issues/2939).
