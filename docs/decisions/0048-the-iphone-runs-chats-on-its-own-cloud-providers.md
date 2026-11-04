---
status: accepted
date: 2026-11-04
---

# 0048. The iPhone runs chats of its own, on cloud providers whose keys it keeps

## Context

Decision [0016](0016-a-phone-carries-a-sealed-provider-key-and-never-holds-one.md)
kept usable provider keys out of the phone for a computer's providers: the phone
seals a key to the computer and never stores or reads one back. Decision
[0047](0047-the-iphone-stays-connected-to-every-paired-computer.md) made the chat
list an aggregate of every paired computer.

Philip asked (2026-11-04) for the next step: the phone itself is one more place a
chat runs, using a cloud model provider, with the same cloud providers the
desktop can connect to, listed with the computers in the one chat list, which
can also be grouped by computer. Spec:
[chats on this iPhone, and group by computer](../../spec/phone/iphone-chats-on-this-iphone-and-group-by-computer.md).

A chat that runs on the phone has no computer to hold its key: the phone has to
call the provider itself, so it has to hold the key.

## Options considered

1. **Route the phone's chats through a computer or Nekko Cloud.** The key stays
   off the phone (0016 unchanged), but the phone is not a place of its own: no
   computer online, no chat. It is what a paired computer or a Nekko Cloud
   machine already does.
2. **Keep the key in the phone's Keychain, for the phone's own providers only.**
   The phone calls the provider straight over https. The key is the user's,
   typed on the phone, for chats on the phone; it never leaves for a computer,
   the relay or Nekko Cloud.
3. **Sign in to the providers with OAuth on the phone.** Only some providers
   offer it (the ChatGPT subscription does; the APIs take keys), and the
   desktop keeps those sign-ins on the computer.

## Decision

Option 2 (`PhoneChats`, `PhoneProviders` in NekkoKit; `URLSessionPhoneHTTP`).

- The phone's provider keys are a separate Keychain service
  (`dev.nekkolabs.nekkoagent.phone-providers`), `AfterFirstUnlockThisDeviceOnly`,
  never synchronized, not in backups. The saved provider list holds no key.
- A key is sent only to its provider, over https; the app refuses an `http://`
  address for these providers. Requests use an ephemeral session with no URL cache.
- Kinds: the desktop's cloud kinds that are plain HTTPS APIs: Claude API,
  OpenAI, OpenRouter, Claude in Amazon Bedrock, Claude in Microsoft Foundry,
  Claude on Vertex AI (a pasted access token) and OpenAI-compatible (https).
  Not on the phone: Claude subscription (it runs Claude Code), ChatGPT
  subscription (signs in on a computer), and local model servers.
- The phone's chats are kept on the phone (`phone-chats` beside the drafts, out of
  backups) and are not synced. They have no tools: the model answers in text.
- 0016 stands for a computer's providers: the phone still never holds or reads a
  computer's key, and these keys are never offered to a computer.
- Settings → Forget everything on this iPhone deletes these keys and chats too.

## Consequences

- A lost, unlocked phone can use the user's own keys until they are revoked at
  the provider; the Keychain and the app lock are the protection, as for the
  phone's pairing keys.
- A Vertex AI access token lasts about an hour; the phone asks for a new one when
  it runs out rather than holding Google credentials.
- Android has no phone provider yet.
