---
title: "iPhone: usage by computer and by this iPhone, grouped by subscription (2026-11-05)"
area: phone
---

# iPhone: usage by computer and by this iPhone, grouped by subscription (2026-11-05)

`[implemented 2026-11-05 (#1773), iPhone only: the grouping, the fleet reads, the stream's token counts and the phone's ledger are tested in NekkoKit (Linux Swift container); the screen builds on macOS CI. Unverified on a device and against real providers until the Native iOS run passes and someone opens it on a phone with two computers. Android still shows the active computer only]` Builds on [every computer at once](iphone-every-computer-at-once.md) and [chats on this iPhone](iphone-chats-on-this-iphone-and-group-by-computer.md).

## User intent

Philip asked (2026-11-05, issue #1773): the iPhone's **Usage and limits** read only the active computer. It should show usage from every paired computer and from the chats that run on the iPhone itself, grouped by where it came from, and within each place by subscription (plan) versus pay-per-token API use, with each subscription's limits.

## What the user sees

*Computers and settings → Usage and limits*:

- **All places** (when there is more than one place): tokens, tokens on a subscription, API tokens, and estimated API spend across the computers. When a place is offline, a line says its last numbers are counted.
- **One section per place**, the paired computers in the app's order (each with its icon and colour, as in the chat list), then **This iPhone** (or iPad) when the phone runs chats or has recorded usage.
  - **Subscriptions** first: each enabled provider that reported limits, as *Label · Plan* with its limit bars (used, resets), then the models that bill to a subscription with their tokens.
  - **API** next: the pay-per-token models with tokens and estimated cost, and the place's estimated API spend. On This iPhone the models are grouped under the provider they ran on, tokens only.
  - **Recent days**, collapsed.
- **Offline computers** are listed with *Offline* in the heading. One the phone has read before keeps the numbers it last gave (*Offline. These are the last numbers it gave.*); one it has not says its usage shows when it reconnects. A computer that answers with an error keeps its last numbers and shows why.
- Pull to refresh reads every place again.

## How it works

- `FleetUsageModel` (NekkoKit) reads every online computer in parallel over its own connection (the active one, or its fleet link through `ComputersStore.caller`): `usage:summary`, `providers:list`, and `limits:get` for each enabled provider by id. Nothing is sent to a computer that is not online. The pure grouping (`UsagePlace`, `UsageTotals`) is in NekkoProtocol.
- A model counts as a subscription when the computer's summary marks it `subscription`. The computer counts those models at zero cost, so a place's estimated API spend is its summary's total cost. Subscription tokens come from the models listed (the computer sends its 12 busiest), and API tokens are the rest of the total.
- **This iPhone's usage**: `PhoneStreamParser` reads the token counts the provider streams: Anthropic's `message_start` (input, cache writes and reads included) and `message_delta` (output, a running total); for OpenAI and OpenRouter the chat request asks for `stream_options.include_usage` and the last chunk carries `prompt_tokens` and `completion_tokens`. OpenAI-compatible servers are not asked, since some reject fields they don't know, so their chats count nothing. A stopped or failed reply still records what the provider reported.
- `PhoneUsageLedger` keeps tokens per provider, model and local day, the last 90 days, in its own file (`phone-usage`) beside the phone's chats under Application Support, out of backups.

## Privacy and boundaries

- The phone's ledger stays on the phone: it is never sent to a computer, the relay or Nekko Cloud, and **Forget everything** on This iPhone deletes it with the chats and keys.
- The phone has no price table and does not estimate a cost for its own chats; it shows tokens only.
- Reading usage from a computer is a read-class call, as before; no key or token reference reaches the phone (limits are asked by provider id).

## Acceptance

- [x] Every online paired computer is read, each over its own link, and grouped subscription then API (NekkoKit tests).
- [x] Offline computers say so and keep their last numbers; nothing is sent to them (NekkoKit tests).
- [x] This iPhone's chats record tokens from both stream formats; the ledger persists and Forget everything wipes it (NekkoKit tests).
- [ ] The screen checked on a device or simulator with two computers and the phone's own chats (macOS CI screenshots, then a device).
- [x] Android parity (#2114, below).

## Android (#2114)

`[Implemented 2026-11-11; protocol UsageByPlaceTest (grouping, totals, the phone's ledger and its file, Anthropic's and OpenAI's stream counts) and app UsageByPlaceControllerTest (every computer over its own link, offline ones keep their last numbers with nothing sent, an error keeps them and says why, this phone after the computers); UsageByPlaceDeviceTest and a before/after of the real screen on an API 37 emulator; not yet with two real computers or real providers]`

- The same screen: **All places** when there is more than one, then each paired computer in the app's order with its icon (**Offline** in the heading when it is), then **This phone**. In each: the place's tokens, **Subscriptions** (plans with their limit bars, then the models that bill to a plan), **API** (models with tokens and cost on a computer, by provider and tokens only on the phone, and the estimated spend), **Recent days**, folded.
- `UsagePlace`, `UsageTotals` and `PhoneUsageLedger` are in the protocol module (`UsageByPlace.kt`), as the iPhone's are in NekkoProtocol/NekkoKit. `UsageByPlaceController` reads every computer over `ComputersRepository.callerFor` (the active one's connection or its fleet link, and only when it is online), all at once.
- **Offline computers** show the numbers they last gave: each computer's raw answers (usage summary, the public provider list, limits) are kept on the phone under `usage.lastByComputer` in its preferences. One never read says its usage shows when it reconnects; one that answers with an error keeps its last numbers and says why.
- **This phone's usage**: `PhoneStreamParser` reports `PhoneStreamEvent.Usage` from Anthropic's `message_start`/`message_delta` and OpenAI and OpenRouter's last chunk (Android already asked those two for `include_usage`); `PhoneChats` records each reply's totals, a stopped or failed one too, in the encrypted store beside the phone's chats (`phone.usage.v1`), 90 days. A provider test is not counted. Never sent anywhere; no prices.
- Not yet on Android: a way to wipe the phone's ledger on its own (Android has no Forget everything for phone chats yet); it is removed with the app's data.
