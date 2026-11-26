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

## Android (#2939)

`[implemented 2026-11-26 on Android; JVM tests and lint pass, the device journey (PhoneCloudDeviceTest) is updated but not yet run; not seen on an emulator or a phone]`

- The phone's providers screen ("Models on this phone") has no "need a computer" line. Each provider is an avatar row with its mark that opens its page: Use on this phone, Test (its result said under the name), New key, Remove.
- **Add a provider**: buttons for ChatGPT, Claude API, OpenAI, Google Gemini, OpenRouter and Ollama Cloud, each opening the add form already set to it, and **More providers** for the rest.
- **Claude API** first shows Anthropic's choice: API key goes on to the form; Claude subscription is dimmed and can't be chosen, with the same sad Nekko (`SadNekko`, the iPhone's drawing) and words.
- From Settings → Models on This phone, a provider's row opens its page and Add a provider opens these buttons.
- The screen stays English-only, as the rest of the phone's own chats screen.
