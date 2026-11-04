---
title: "iPhone: chats on this iPhone, where each chat runs, and group by computer (2026-11-04)"
area: phone
---

# iPhone: chats on this iPhone, where each chat runs, and group by computer (2026-11-04)

`[implemented 2026-11-04, iPhone only: the providers, requests, streaming and chat store are tested in NekkoKit (Linux Swift container), the list's Group by → Computer in NekkoProtocol; the screens build on macOS CI and are driven by the live UI test testChatsOnTheComputerAndOnThisIPhoneInOneList with a fixture provider. Not yet tried against a real provider from a device. Android has none of it yet]` Decision: [0048](../../docs/decisions/0048-the-iphone-runs-chats-on-its-own-cloud-providers.md). Builds on [every computer at once](iphone-every-computer-at-once.md).

## User intent

Philip asked (2026-11-04):

- The iPhone app is about the providers and fleet machines together: no switching to each machine to see its chats and status; it is all on one page.
- **Group by computer** is an option.
- As on the desktop, each chat carries an icon or mark for where it runs.
- The phone itself can be a provider, using a cloud model provider, with the same cloud providers the desktop can connect to.

## What the user sees

- **One list, every place.** The chat list holds every paired computer's chats and this iPhone's own chats. *Show chats from* in the computer pill lists *All computers*, each computer, and **This iPhone** (*Its own models*) once the phone runs chats.
- **Where a chat runs**, on its row when the list shows more than one place: the computer's icon in its colour (the desktop's computer colours, the same order), or a dot when the computer has no icon, then its name; this iPhone's chats show a phone mark and *This iPhone*. The colour is on the mark only, so the name keeps the list's contrast. **View → Show → Computer** and **Computer icons** turn the name and the icon off, as on the desktop.
- **Group by → Computer** (in the view menu once there is more than one place): a heading per computer, then *This iPhone*, each with its mark, its chats in the chosen order and its own completed chats after them. With headings naming the place, the rows don't repeat it. A computer with no chats in view shows when *Empty groups* is on.
- **Models on this iPhone** (Settings → Computers, and *Or use a model provider on this iPhone* on the welcome screen before any computer is paired): the phone's providers, each with its models or what went wrong, a switch to turn it off, touch and hold for **Test**, **New key** and **Remove**. **Add a provider** takes the kind, a name, the address where the kind needs one, and the key; it is kept only after the provider answers. The kinds: Claude API (optional workspace ID), OpenAI, OpenRouter, Claude in Amazon Bedrock, Claude in Microsoft Foundry, Claude on Vertex AI (a pasted access token, about an hour), OpenAI-compatible (any https server). The desktop's other kinds are listed under *On a computer only*: the Claude subscription (Claude Code), the ChatGPT subscription and local model servers.
- **New chat → Run on** lists **This iPhone** (*Its own models, no tools*) beside the computers. On this iPhone the model chip picks among the phone's providers' models; folder, tools, effort, photos and Nekko Cloud step aside, the box asks *Ask anything*, and a line says the chat runs on this iPhone with your own key and has no tools. New chat starts on this iPhone when the list is filtered to it or no computer is paired.
- **A chat on this iPhone** opens to its conversation: a line on where it runs and with which model, your messages, the reply streaming in with Markdown, **Stop** while it streams, and **Try again** under a reply that failed (the provider's own words: a refused key, a rate limit, an unknown model). Its menu changes the model, renames, pins, completes or restores, and deletes. In the list it swipes and touches and holds like any chat.
- With no computer paired and a provider on this iPhone, the app opens on the chat list instead of the welcome screen.

## How it works

- `PhoneProviders` builds each request: the Messages API (`/v1/messages`, `x-api-key`, `anthropic-version`) for the Claude API, Bedrock and Foundry; Vertex AI's `streamRawPredict` with a bearer token; Chat Completions (`/chat/completions`, bearer key) for OpenAI, OpenRouter and OpenAI-compatible servers. `PhoneStreamParser` reads both streams. Models come from the provider's models list, or a fixed Claude catalog for Bedrock, Foundry and Vertex AI, which have none to read.
- `PhoneChats` keeps the providers (no keys) and the chats in `phone-chats` beside the drafts (Application Support, out of backups, protected until first unlock), the keys in the `dev.nekkolabs.nekkoagent.phone-providers` Keychain service on this device only, and streams each reply into the chat. A reply cut off by the app closing says so on the next launch.
- The chat list merges `PhoneChats.summaries` with the computers' lists; a chat id `phone:<uuid>` opens `PhoneChatView` in place of the computer chat screen, in a pane too.
- `ChatSections.make` takes the places and which place a chat runs on for Group by → Computer; `ComputerColors` is the desktop's `COMPUTER_COLORS`.

## Privacy and security

- A phone provider's key is sent only to that provider, over https (an `http://` address is refused), from an ephemeral URL session with no cache. It is never sent to a computer, the relay, Nekko Cloud, a log or a diagnostics report, and the phone still never holds a computer's key ([0016](../../docs/decisions/0016-a-phone-carries-a-sealed-provider-key-and-never-holds-one.md)).
- The phone's chats are not synced and not sent to a computer.
- Settings → Forget everything on this iPhone removes the phone's providers, keys and chats.

## Acceptance

- With a computer paired and a provider on this iPhone, a chat on each shows in one list; the iPhone's row reads *This iPhone* with its mark, the computer's its name.
- Group by → Computer shows a heading per place with the right chats; with one place the option is not offered.
- A Claude API key that is refused is not kept, and Add says the provider's reason.
- A reply streams in on the iPhone, Stop keeps what arrived, and Try again after a failed reply sends the conversation again without the failed reply.
- Unit tests: `PhoneChatsTests` (NekkoKit), `ChatListLayoutTests` (NekkoProtocol). UI: `LiveRelayTests.testChatsOnTheComputerAndOnThisIPhoneInOneList`.

## Not verified yet

- A real provider called from a device (the UI test uses a fixture provider inside the simulator).
- Translations of the new text: the new strings show in English in every language until the catalog is translated.
- Photos in a chat on this iPhone, tools, and syncing these chats are not built.
