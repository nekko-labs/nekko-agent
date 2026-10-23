---
title: "Background automations yield to the user"
area: automation
---

# Background automations yield to the user

**What it is for.** Scheduled tasks, workflows and goal runs on a local model compete with the person at the computer for the same GPU, memory and fans. They should run while nobody is using the machine, and step aside when someone comes back, without the user having to pause them by hand. This is part B of local-model scheduling. Part A, recommending models from the hardware, is [Hardware-aware model recommendations](../models/hardware-aware-model-recommendations.md). The choices behind the defaults are recorded in [decision 0011](../../docs/decisions/0011-background-automations-wait-for-idle-on-local-models.md).

Three pieces, in order:

1. **B1: when** (signals and per-automation policies), this page.
2. **B2: how to yield** (preemption within about a second of the user's return), planned.
3. **B3: what stays loaded** (a small routing model kept warm, the large one evicted under memory pressure, and a monitor chip such as "Background: paused, you're active"), planned.

## Activity signals `[implemented, unit- and daemon-tested; live-checked on macOS only]`

The daemon answers `activity:state` with whether someone is using the computer, so the gate works without the desktop app open. Every signal is best-effort and unprivileged:

- **Input:** seconds since the last keyboard, mouse or touch input.
  - macOS: `CGEventSourceSecondsSinceLastEventType` on the HID system state. Needs no Accessibility permission.
  - Windows: `GetLastInputInfo`, for the daemon's own session (the desktop app's).
  - Linux: logind's idle hint for the user's graphical session (`loginctl show-session auto`). The desktop sets it after its own idle delay (GNOME's default is 5 minutes). Before that the user reads as active, and a desktop that never sets the hint reads as always active.
  - Present when there was input within the idle threshold (5 minutes by default).
- **A chat a person started is replying:** any `chat:send` without the automation's `unattended` mark, from the app or the phone. While one runs, the user counts as present however long ago they typed.
- **Power:** on battery, and low battery.
  - Low means the system's own warning, or a charge at or below 20%.
  - macOS reports no percentage here, only the warning.
- **Heat:** CPU at or above 100 °C or GPU at or above 90 °C, from the hardware monitor's sensors (`temps.rs`) and the GPU probe.

Battery and heat are *strain*, not presence: they argue against heavy work, but they do not mean someone is at the machine.

**A headless machine counts as idle.** Docker, a server, a Linux login without a graphical session and a Windows service session have no input to read. There, only a replying chat counts as presence.

Readings are cached: input for 0.5 s, so B2 can react within a second; temperatures for 10 s; power for 30 s.

**Not in B1:** a full-screen app or game in the foreground, and GPU use by other processes. Both need per-window or per-process APIs; the GPU probe reads only total utilisation today.

**Privacy.** The signals are read and judged on the device and never leave it. `activity:state` reports durations and states, never which app or window is in front.

## Run policies `[planned: B1, next layer]`

Each task, workflow and goal run has a policy, and a global default sets the policy for new ones:

- **Only when I'm idle:** wait until the user is away and no chat of theirs is replying.
- **Low priority:** run even while the user is active. In B1 this is only the policy. Running with fewer threads, fewer GPU layers and a smaller context comes with B2.
- **Always:** today's behaviour.

The default is **Only when I'm idle for automations on a local model** (the built-in engine, or a provider on a loopback address, as `localModelOnly` judges it). Automations on a cloud model default to **Always**: they do not load this machine, and they keep today's behaviour.

**A waiting run is never dropped silently.** A scheduled run that is still waiting for idle after a cap (2 hours) starts anyway, in low priority, and the run shows "waited for idle". Manual runs ("Run now", the CLI) always start at once. "Pause all automations" still overrides everything.

Acceptance: a synthetic activity signal (a test source in place of the OS reading) holds a due run while the user is active and releases it when they go idle, for tasks, workflows and goal runs.

## Settings and UI `[planned: B1, last layer]`

- A policy selector on each task, workflow and goal run.
- The global default and the idle threshold in Settings.
- The waiting state on the run ("Waiting for you to be away").
