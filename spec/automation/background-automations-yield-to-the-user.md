---
title: "Background automations yield to the user"
area: automation
---

# Background automations yield to the user

**What it is for.** Scheduled tasks, workflows and goal runs on a local model compete with the person at the computer for the same GPU, memory and fans. They should run while nobody is using the machine, and step aside when someone comes back, without the user having to pause them by hand. This is part B of local-model scheduling. Part A, recommending models from the hardware, is [Hardware-aware model recommendations](../models/hardware-aware-model-recommendations.md). The choices behind the defaults are recorded in [decision 0011](../../docs/decisions/0011-background-automations-wait-for-idle-on-local-models.md).

Three pieces, in order:

1. **B1: when** (signals and per-automation policies), this page.
2. **B2: how to yield** (preemption within about a second of the user's return), below.
3. **B3: what stays loaded** (models kept resident, idle ones unloaded under memory pressure, and a monitor chip such as "Background: 1 paused · you're using the computer"), below.

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

## Run policies `[implemented for tasks and workflows, unit- and daemon-tested; UI planned]`

Each task and workflow can carry a policy (`runPolicy`). The settings' `automationRunPolicy` sets it for those that carry none. The idle threshold is `automationIdleMinutes`, 5 by default.

- **Only when I'm idle** (`idle`): wait until the user is away and no chat of theirs is replying, the machine is on mains power, and it is not hot.
- **Low priority** (`lowPriority`): run even while the user is active, but not on a low battery or a hot machine. In B1 this is only the policy. Running with fewer threads, fewer GPU layers and a smaller context comes with B2.
- **Always** (`always`): today's behaviour.

The default is **Only when I'm idle for automations on a local model** (the built-in engine, or a provider on a loopback address, as `localModelOnly` judges it). A workflow counts as local when it is `localModelOnly`, or when its own model or any step's model is local. Automations on a cloud model default to **Always**: they do not load this machine, and they keep today's behaviour.

**A waiting run is never dropped silently.** A scheduled run that is still waiting for idle 2 hours after it came due starts anyway, in low priority:

- **Tasks:** while held, the task carries `waitingSince`. The run that starts records `lastRunLowPriority` and `lastRunWaitedMs`.
- **Workflows:** a held workflow carries `waitingSince`. The run records `lowPriority` and `waitedMs`.
- **Rechecks:** a held task is looked at again once per scheduler tick (15 s). Before this change, a due task held by "Pause all automations" was rechecked on every turn of the scheduler loop, about every 50 ms.

**What never waits:**
- **Workflow runs started by an event** (pull request, push, Slack, connector, webhook) start at once, marked low priority when the policy would have held them. There is no queue to keep them in, and dropping an event would lose work.
- **Manual runs** ("Run now", the Run button, the CLI) always start at once.
- **Goal runs.** A person starts them, and their time budget would run out while they waited.
- "Pause all automations" still overrides everything.

Acceptance:
- **Tested:** a synthetic activity source in place of the OS reading holds a due task and a due scheduled workflow while the user is active, and releases them when the user is away (`nekko-automation/tests/tasks.rs`, `tests/workflows.rs`). The cap and the cloud default are tested too.
- **End to end:** the real daemon holds a local task on a machine whose input it can read (`nekkod/tests/daemon/automation.rs`).

## Settings and UI `[implemented, unit-tested; isolated renderer evidence]`

- **When it runs** (`RunPolicyField`), in the workflow editor's Runs section and in the ⚡ Automate dialog.
  - The unset choice reads "Default: …", resolved as the daemon would: own policy, then the setting, then by where the model runs.
  - Saving the default sends `null`, not `undefined`, so the JSON that reaches the daemon clears it.
  - Tasks have no editor after creation; the policy is set when the task is made.
- **Settings → Automations:** "When automations run" (`automationRunPolicy`; "By where the model runs" is `null`) and "Away after" (`automationIdleMinutes`, 1 to 240, default 5).
- **The waiting state:**
  - A held task's status in the Automations window reads "waiting for you to be away" instead of "due now".
  - A held workflow's row has a "waiting for you to be away" badge.
  - Tooltips say when it came due, that it runs after 2 hours anyway, and that Run starts it now.
- **How a run started:** "low priority · waited 2 hr" on a task's last run, a workflow run's header and its history entry.
- **Evidence:** `apps/desktop/scripts/automations-integration.cjs` renders these surfaces with synthetic data in a hidden, non-focusable window, in dark and light.
- **Not built yet:** a live "Background: paused, you're active" chip in the monitor (B3).

## Stepping aside while running (B2) `[implemented, unit- and daemon-tested; measured on macOS]`

A run that started keeps checking, and steps aside if the computer stops being free. The model stays loaded, and the run carries on from where it stood.

- **How a run says it:** the automation's `chat:send` carries `background`, decided when the run starts (`run_policy::running_mode`):
  - `idle` for "Only when I'm away";
  - `lowPriority` for "Low priority", a run past the 2-hour cap, or an event run held by the policy;
  - nothing for "Always", a manual run, or a host that cannot tell whether anyone is here.
- **Only on a local model:** the daemon gates the turn only when its provider runs on this computer (the `localModelOnly` test). Cloud turns never pause.
- **When it steps aside:**
  - `idle`: someone uses the computer (input within the idle threshold, or a chat of theirs replying), or the machine is on battery, low on battery or hot;
  - `lowPriority`: a chat of the person's is replying on a local model, or the battery is low, or the machine is hot. Typing alone does not pause it.
- **How:**
  - The turn's model client (nekko-chat's `YieldingClient`) looks before each model call and every 200 ms while one streams.
  - It closes the call's connection, which stops llama-server's generation, and ends the call with "Paused while someone uses this computer".
  - The loop drops what that call had streamed and sends it again from the same point. That costs no retry attempt and no backoff.
  - The next call waits until the gate opens.
  - Tools already running finish; only model calls wait.
- **What you see:** the run's chat shows "Paused until this computer is free", the rail note says why, and the status reads "Paused".
  - `background:state` and the `background:updated` event count background turns, paused ones and the commonest reason (`active`, `chat`, `battery`, `lowBattery`, `hot`), ready for the monitor chip (B3).
- **Measured (M5 Max, Qwen3.5 4B and Gemma 4 12B, `docs/perf-history.md`):**
  - Generation stops 22 to 35 ms after the hang-up.
  - Resuming with the model loaded re-reads 1 to 4 prompt tokens in 16 to 26 ms.
  - Unloading instead would cost 0.8 to 1.2 s of load and 0.9 to 2.6 s of prompt.
  - The time from real input to the stop is bounded by design, not measured: about 0.4 s on macOS and Windows, about 1.2 s on Linux.

Acceptance:
- **Client:** a yielding call stops and is sent again without spending an attempt, and Stop is not a yield (`nekko-chat/tests/yielding.rs`, `nekko-loop/tests/retry.rs`).
- **Daemon:** the real daemon pauses a low-priority task while a person's chat replies on the same loopback model, then finishes it with no trace of the stopped reply (`nekkod/tests/daemon/automation.rs`).

**Not built:** unloading the model when a pause lasts (B3, residency), and lighter launches (fewer GPU layers or threads) for low priority.

## What stays loaded, and the background chip (B3) `[implemented, unit-tested; isolated renderer evidence]`

**Residency.** Before a load, the engine makes room (nekko-engine `server.rs`, `do_load`):

- **The resident limit** (`maxLoaded`): idle models are unloaded, least recently used first. This is unchanged.
- **Free GPU memory:** for a llama.cpp model the planner can size (`capacity::compute_fit`: weights, KV cache for the load's context, overhead, times its GPU share), when the GPU probe reads free memory. Idle models are unloaded, least recently used first, until the estimate fits.
  - If nothing idle is left, the load goes ahead, as before, and the log says it may not fit. A load is never refused on a memory estimate alone.
  - On Apple Silicon, "free" is total memory less what the GPU has allocated. That overstates free memory, so this rarely unloads anything there. It never unloads by mistake.
- **Kept resident:** a model with its own idle TTL of 0 ("Keep resident" in Model Server) is never unloaded to make room. The global `idleTtlSeconds` of 0 only stops the idle sweep and pins nothing.
  - If every resident model is busy or kept resident, the load is refused: "Every resident model is busy or kept resident. Stop keeping one resident, or increase the resident limit."
- **No routing model:** the plan named a small routing model to keep warm. Nothing in the app uses a local routing model yet, so none is pinned by default; "Keep resident" is how to keep one warm.
- **A long pause:** a paused background turn holds no open request, so its model is idle. It is unloaded by the idle timeout (900 s by default), or sooner when a person's chat needs the room. B3 adds no separate rule for it.

**The chip.**
- **On every view but the Agent board:** the resource chip in the corner shows **BG running** or **BG paused** while an automation runs on a local model, with the whole line on hover.
- **On the Agent board:** the Monitors panel shows it as a row under its toolbar, for example **Background: 1 paused · you're using the computer**. The reasons read: you're using the computer, your chat is using the model, on battery, battery low, running hot.
- **Source:** both read `background:state` once and then follow `background:updated`. Nothing shows when no automation runs in the background.

Acceptance:
- **Engine:** `nekko-engine/tests/server.rs` checks that a model kept resident is not unloaded to make room, that a load which does not fit in free memory unloads the idle ones first (oldest first) and then loads, and that without a GPU reading only the resident limit counts. The golden scenarios are unchanged.
- **Renderer:** `BackgroundChip.test.tsx` and `background.test.ts`. Evidence: `automations-integration.cjs`, with the resource chip and the Monitors panel paused and running, in dark and light.
