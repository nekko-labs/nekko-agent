# Reusable simulators or on-demand ones

Research date: 2026-11-15. Tracking: #2826 (follow-up to #2814). Question from Philip: does it make sense to have reusable simulators, or should agents make them on demand?

Machine: Philip's MacBook Pro, M1 Max (10 cores), 64 GB, macOS 27, Xcode 27.2 (27B52). It was busy during every measurement: load average 57.84 before the first boot, an Android emulator (`agent2649_api36`) at about 100% CPU, two Electron dev apps and the Nekko dev app running. Every timing below is one run under that load, not a benchmark.

## Summary

1. **Neither of today's two habits is right.** Scripts create, boot and delete a fresh simulator per run (clean, but pays the full cold boot every time and leaks devices when killed). The runbook tells agents to "reuse a simulator that is already booted", which is unsafe with parallel agents because nothing says whether that device is free.
2. **Reuse pays, mainly in boot time and boot CPU.** A cold first boot took **31.3 s**, a second boot of the same device **8.1 s**. A fresh device was still burning **498% CPU** a minute after boot and **97.6%** at three minutes (first-boot setup). Erasing a device gives the cold cost back (**38.1 s** boot after `simctl erase`).
3. **Reuse needs exclusivity.** Two agents on one device break each other: one install replaces the other's app mid-test, `-uiTestReset` wipes the other run's Keychain and files, and appearance and status bar overrides are device-wide.
4. **Disk is the real leak today, not CPU.** 203 devices take **80.2 GB**. 151 of them belong to runtimes that are no longer installed (iOS 15/16, watchOS 8, tvOS 15). Of the 42 usable iOS devices, 36 were not touched in the last 7 days.

**Recommendation:** a small pool of reusable devices managed by nekkod, leased to one chat at a time, shut down (not deleted) when idle, with a cap on how many are booted at once and a cleanup for stale ones. Keep on-demand create and delete for CI and for clean before/after evidence.

## What is on disk

`~/Library/Developer/CoreSimulator/Devices`, read with `simctl list devices -j` and `du -sk` per device. "Touched" is the device folder's modification time, a rough proxy for last use.

| Group | Devices | Size | Touched in last 7 days |
| --- | --- | --- | --- |
| Unavailable (runtime no longer installed) | 151 | 4.4 GB | |
| Usable iOS, Xcode's default names ("iPhone 17 Pro") | 24 | 32.3 GB | 1 |
| Usable iOS, named by agents or scripts (`Nekko-*`, `nekko-*`) | 18 | 43.6 GB | 5 |
| Usable watchOS | 10 | small | |
| **Total** | **203** | **80.2 GB** | |

By runtime: iOS 26.5 (26), iOS 27.0 (16), and 151 on runtimes Xcode 27.2 no longer has (iOS 15.0 to 16.4, watchOS 8.x, tvOS 15.x), some last touched 987 days ago. There are no XCTest parallel-testing clones left over (`~/Library/Developer/XCTestDevices` is empty). Android AVDs add **6.4 GB** in `~/.android/avd` (4 AVDs).

Largest devices:

| Size | Name | Runtime | Last touched |
| --- | --- | --- | --- |
| 7.36 GB | iPhone 17 Pro | iOS 26.5 | 3.4 days |
| 3.81 GB | iPhone 17 | iOS 27.0 | 14.2 days |
| 3.67 GB | Nekko-1882-phone-setup-owned | iOS 26.5 | today |
| 3.61 GB | iPhone 17 Pro Max | iOS 26.5 | 14.2 days |
| 3.57 GB | Nekko-1772-audit-owned | iOS 27.0 | 1.5 days |
| 3.57 GB | iPhone 17e | iOS 26.5 | 12.2 days |
| 3.31 GB | Nekko-iPhone-agent2 | iOS 27.0 | 14.2 days |
| 3.24 GB | Nekko-Local-CI | iOS 27.0 | today |
| 3.12 GB | iPhone 17 | iOS 26.5 | 12.2 days |
| 3.00 GB | iPhone Air | iOS 27.0 | 18.4 days |
| 2.97 GB | nekko-2699 | iOS 26.5 | today |
| 2.84 GB | iPhone Air | iOS 26.5 | 14.2 days |
| 2.80 GB | iPhone 13 (unavailable) | iOS 15.0 | 987 days |
| 2.77 GB | Nekko-iPadPanes-agent2 | iOS 27.0 | 20.4 days |
| 2.75 GB | Nekko-1782-parity-owned | iOS 26.5 | 10.2 days |

A device that has had the app installed and tests run grows to roughly 3 to 7 GB. A fresh one is 17 MB, 275 MB after its first boot and 1.0 GB after a second boot with nothing installed.

## Where the devices come from

- **`scripts/ios-evidence-local.mjs`** creates `Nekko-Evidence-<label>-<revision>`, boots it headless and shuts down and deletes it in a `finally`. A run killed outright (SIGKILL, an agent turn cancelled, the Mac sleeping mid-run) skips the `finally`; `Nekko-Evidence-secret-box-after` is one such orphan.
- **CI (`ios-native.yml` and the evidence workflows)** creates `Nekko-CI`, deletes it in a shell `trap`, and runs on ephemeral runners. Within one run it already **reuses** one device across suites, with `simctl uninstall dev.nekkolabs.nekkoagent` between them instead of a new device per suite.
- **Agents working by hand** follow the runbook's naming (`Nekko-<issue>-<what>`, often `-owned`) but keep the device for follow-up runs and never delete it. 13 of these were untouched for over a week.
- **Xcode** creates a default set of devices for every runtime it installs. Removing a runtime leaves its devices behind as "unavailable", which is the 151.

## Measured costs

One run each, iPhone 17, iOS 27.0, device created for the measurement and deleted at the end (both measurement devices are gone).

| Step | Result |
| --- | --- |
| `simctl create` | 0.3 s, 17 MB |
| Cold first boot to `simctl bootstatus -b` done | 31.3 s |
| Size after first boot | 275 MB |
| 60 s after first boot | 259 processes, 498.1% CPU (summed `ps` over the device's `launchd_sim` tree) |
| 180 s after first boot (second device, same steps) | 243 processes, 97.6% CPU |
| `simctl shutdown` | 3.8 s |
| Second (warm) boot of the same device | 8.1 s |
| Size after second boot | 1.0 GB |
| `simctl shutdown` + `simctl erase` | 3.9 s |
| Boot after erase | 38.1 s |

Memory: `footprint --summary` over the device's processes reported 10 to 11 GB, and summed RSS 33.6 GB. Both count shared pages more than once, so treat them as loose upper bounds, not the device's real cost. The steady-state CPU of an idle device was not measured here; #2814 recorded about 70% CPU for five booted, mostly idle devices together.

Load: the load average went from 57.84 to 353.43 during the first measurement and stayed above 300 during the second. Other work was running too, but a boot starts about 250 processes at once, so a burst of agents booting fresh devices in parallel is a visible hit on this Mac.

Not measured: CPU settle time after a warm boot, and real memory use (the next step would be a memory-pressure or `vm_stat` delta on an otherwise idle Mac).

## Two agents on one device

The iOS app and tests assume a device of their own:

- `xcodebuild test` installs the app under test, replacing whatever another run installed, mid-test.
- `-uiTestReset` (read in `apps/ios/App/AppModel.swift` and `NekkoApp.swift`) wipes the Keychain, offline files, chat list and transcripts at launch. That is what makes **sequential** reuse safe (the next run starts clean without erasing the device), and what makes **concurrent** reuse unsafe.
- `simctl ui <device> appearance`, `simctl status_bar ... override` and `simctl io ... recordVideo` are device-wide, so one agent's theme or recording lands in the other's evidence.
- CI's `simctl uninstall` between suites would remove the app from under another run.

nekkod already knows which chat last used each booted device (`crates/nekkod/src/simulators.rs`, `lastUse`), but that is attribution after the fact, not a lock. Nothing stops a second chat from picking the same device.

## Options

| | (a) On demand: create, boot, delete per task | (b) Reuse any booted device (runbook today) | (c) nekkod pool with exclusive leases |
| --- | --- | --- | --- |
| Boot time per task | 31.3 s cold every time | 0 s if one is booted | 8.1 s warm, 0 s if already booted and free |
| Boot CPU | Full first-boot burst every time (498% at 1 min) | None | Warm boot only |
| Disk | Low if cleanup runs; leaks when killed | Grows with the devices people keep | Bounded: a few named devices per runtime/model |
| Clean state | Always | No; depends on the last user | `-uiTestReset` for Nekko's app; `simctl erase` on request (38.1 s) |
| Parallel agents | Safe | Unsafe | Safe: one chat per device |
| Booted devices piling up | No | Yes (the #2814 nine-day device) | Capped, and auto shutdown stops idle leases |

## Recommendation

Build (c), in phases. Keep (a) for CI runners, which are ephemeral, and for matched before/after evidence, where both revisions must start from the same clean device.

1. **Clean up and fix the runbook (small, now).**
   - `xcrun simctl delete unavailable` gives back 151 devices and 4.4 GB with no risk to anything usable.
   - Offer, with Philip's go-ahead, to delete agent-made `Nekko-*` devices untouched for 7 days or more (13 devices).
   - Runbook: replace "prefer reusing a simulator that is already booted" with "reuse only a device you booted, or a free pool device"; shut pool devices down rather than deleting them.
2. **nekkod pool with leases.**
   - Agents ask nekkod for a device (`simulators:acquire {runtime, model}`, also exposed as an MCP tool) and get a booted UDID leased to their chat; `simulators:release` gives it back.
   - Pool devices are named `Nekko-Pool-<model>-<runtime>-<n>`, created on first need, never deleted by the pool.
   - On acquire: `simctl uninstall` of the app under test, not an erase. Erase only when the caller asks for a clean device.
   - A cap on booted devices (2 on this Mac by default, a setting), queueing further requests. The auto shutdown in #2826 (5, 15, 30 min...) shuts down an idle leased device and ends its lease.
   - The Hardware monitor shows each pool device as free or leased to a chat, using the attribution that already exists.
3. **Orphan cleanup in the app.** The Hardware monitor's Simulators group shows "N unused simulators, X GB" with Delete, for unavailable devices and `Nekko-*` devices not booted for 14 days. Never pool devices or ones the user made, unless they choose to.
4. **Scripts.** `scripts/ios-evidence-local.mjs --device pool` leases from nekkod when it is running and falls back to create and delete when not. CI stays as it is.

## Suggested follow-up issues

- Delete unavailable simulators and offer cleanup of stale agent-made ones (Hardware monitor "unused simulators" row).
- nekkod simulator pool: acquire/release with exclusive leases, booted-device cap, MCP tool for agents.
- Runbook and `ios-evidence-local.mjs`: lease from the pool instead of "reuse any booted device".
- Measure on an idle Mac: real memory per booted device (memory-pressure delta) and CPU settle time after a warm boot.
