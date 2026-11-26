---
title: "iPhone: relay reconnect backoff has jitter (2026-11-26)"
area: phone
---

# iPhone: relay reconnect backoff has jitter (#3385)

`[implemented 2026-11-26, iPhone only; unit-tested in NekkoProtocol; not observed against a relay restart]` From the phone apps performance audit, item 7.

- After a lost relay connection the phone redials after 1, 2, 4 ... 30 s, and each wait gets 0 to 50% more at random (`RelayConfig.retryDelay`, `retryJitter`), so every phone and computer that lost the relay together does not redial in the same instant. The cap is jittered too (30 to 45 s). An offline computer is still polled at a fixed 15 s.
- Android has the fixed schedule still: see [the gaps table](ios-and-android-stay-in-step.md)(ios-and-android-stay-in-step.md).
