---
title: "Android: idle costs (polls, Keystore, activity map, reconnect)"
area: phone
---

# Android: idle costs (polls, Keystore, activity map, reconnect)

## Intent

The Android app should do no work for a screen nobody is looking at, and no repeated work whose answer cannot have changed. From the 2026-11-26 phone performance audit; tracked in [#3412](https://github.com/nekko-labs/nekko-agent/issues/3412).

## Behaviour

- **Polls follow the screen.** The computer page's 30 second read and an open chat's 15 second watch refresh run only while that screen is started (`repeatOnLifecycle(STARTED)`), as the monitors and hardware polls already do. Coming back reads once at once.
- **The Keystore key is opened once.** The key that seals the secure store is opened on first use and kept for the life of the process; it is opened again only after a use of it failed (key gone or invalidated).
- **The activity map changes only when something changed.** An agent event that changes neither the chats' running / needs-you state nor the attention state returns the same state, so a streamed token copies no map (the iPhone's `if next != activity`).
- **Relay reconnect backoff has jitter.** Each redial waits 1, 2, 4 ... up to 30 seconds as before, plus a random 0 to 50% of that, so phones and computers that lost the relay together do not redial in the same instant. An offline computer is still polled at a fixed 15 seconds. The iPhone does the same ([#3385](https://github.com/nekko-labs/nekko-agent/issues/3385)).

## Acceptance

- The computer page's poll stops when its coroutine is cancelled and reads nothing more (unit test).
- Reading the secure store twice opens the Keystore key once (unit test on the cache; the Keystore itself is Android-only).
- A second `Text` event for a running chat returns the identical computers state (unit test).
- The backoff schedule with no jitter drawn is 1, 2, 4, 8, 16, 30, 30 seconds; the largest draw adds just under half; real draws land in `[base, 1.5 * base)` (unit test).

## Status

Implemented 2026-11-26, JVM-unit-tested. Not measured on a device; see [perf history](../../docs/perf-history.md) Unmeasured.
