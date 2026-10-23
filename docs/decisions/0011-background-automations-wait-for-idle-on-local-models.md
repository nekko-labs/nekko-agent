---
status: accepted
date: 2026-10-23
---

# 0011. Background automations on a local model wait for idle; a waiting run starts after a cap

## Context

Automations that run on a local model compete with the person at the computer for the GPU, memory and fans ([spec](../../spec/automation/background-automations-yield-to-the-user.md)). Until now a scheduled task fired at its time, whatever the user was doing, and only "Pause all automations" held it back. Three facts shaped the choice:

- **Cloud automations do not load the machine.** Holding them back would change behaviour for every existing user, and gain nothing.
- **Some machines are never idle by our signals.** A laptop in constant use, or a Linux desktop that never sets logind's idle hint, would never run an idle-only automation.
- **No idle detection existed**, so the signals had to be read from the OS by the daemon. The daemon also runs without the desktop app (the Local Web UI, Docker), where there may be no input to read at all.

## Options considered

Which automations wait by default:

1. **All of them.** Simple, but changes behaviour for cloud automations that do not compete for the machine.
2. **Those on a local model.** Targets the cost, using the same local-provider test as `localModelOnly`.
3. **None (opt-in).** Changes nothing, but leaves the problem to every user.

What happens to a run that waits and the user never goes idle:

1. **Wait forever.** Honest about the policy, but a task can silently never run.
2. **Skip it and record the skip.** Bounded, but loses the work.
3. **Start it after a cap, in low priority, and say so.** Bounded, and nothing is lost.

What a machine with no input to read counts as:

1. **Active.** Idle-only automations would never run on a server.
2. **Idle.** Nobody sits at a server; only a chat someone started is presence there.

## Decision

Local-model automations default to **Only when I'm idle** (option 2), and cloud ones to **Always**. A run waiting for idle **starts after a 2-hour cap, in low priority**, and the run says it waited (option 3). A headless machine **counts as idle**. The signals are read by the daemon (`nekko-machine`'s `activity.rs`): input idle time from the OS, a replying chat a person started, battery and heat. Battery and heat are strain on the machine, not presence.

## Consequences

- Nothing changes for cloud automations. Local ones move to idle time, which is the point, and cannot starve.
- On Linux, idle time is only as good as the desktop's idle hint, which arrives after the desktop's own delay (5 minutes on GNOME). A desktop that never sets it falls back to the cap. If that proves common, read X11 or Wayland idle directly.
- "Low priority" only names a policy until B2 makes it lighter on the machine (fewer threads and GPU layers). Until then, a capped run competes with the user as a run does today.
- Full-screen and game detection, and GPU use by other processes, are left out of the first signals. If users report automations starting during games, they come next.
