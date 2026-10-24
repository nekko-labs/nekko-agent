---
status: accepted
date: 2026-10-24
---

# 0020. Let phones read the hardware, the Model Server and a chat's context, and unload a model

## Context

The iPhone's Expert mode shows the computer's hardware, the models its Model Server holds and a chat's context size, and can unload a model, as the desktop's Hardware and Local models monitors and composer gauge do ([spec](../../spec/phone/iphone-simple-and-expert-modes.md)). The phone gate is an allowlist with narrow projections ([0012](0012-phone-access-classes-and-relay-replay-protection.md)); none of `system:stats`, `gpu:stats`, `engine:status`, `context:preview` or `model:unload` was on it. Their full results hold things a phone must not see: the engine's binary path, port, log lines and settings (folders), and the context bundle's file paths, previews of attached files, memory and guidelines.

## Options considered

1. **Pass the channels through unchanged.** Least code. Leaks paths, log lines and file previews to every paired phone.
2. **One new phone-only channel that assembles a monitor snapshot on the computer.** One round trip. A channel the desktop doesn't have, a second code path to keep equal to the desktop's monitors, and a new name for the relay to know.
3. **Open the desktop's own channels behind projections** (named fields only, as `usage:summary` and `limits:get` are), the reads in the Read class and unloading in the Change class without a per-call proof. Same data and code path as the desktop; three small reads every few seconds while the panel is open.
4. **Unloading with a signed proof**, like saving a file.

## Decision

Option 3. Reads are what the desktop's monitors show, minus everything path-like; the context view sends totals only and the computer always calls it with no attached paths. Unloading is classed with stopping a run (agent class: the Change switch applies and each call is written to the device's activity list, no Face ID): it only frees memory, and the next reply that uses the model loads it again, so a signed proof (option 4) would cost a Face ID prompt for something the user undoes by sending a message. Loading, downloading, deleting models and the Model Server's settings stay refused.

## Consequences

- The phone's monitors and the desktop's read the same values; a projection change must land in both editions of the gate (TS and Rust, held equal by their tests).
- A phone with Change on can unload a model another chat is using; that chat's next reply reloads it (slower, not broken). If that proves disruptive, move `model:unload` to the proof class.
- Polling costs three relay round trips every 3 seconds while Expert mode is on and a chat is open, and nothing otherwise.
