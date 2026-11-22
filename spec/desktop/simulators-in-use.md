---
title: "Simulators in use: which chat runs each one, what it costs, and stopping it"
area: desktop
---

# Simulators in use

Issues #2814 and #2826. `[implemented 2026-11-15; daemon unit and integration tests, renderer tests and hidden-window captures against a stub bridge; checked against live simulators on macOS through the daemon probe only, not yet in a packaged build]`

**User intent (Philip, 2026-11-15).** The Mac sat at 98% CPU with five iOS simulators booted, one of them for nine days, and nothing in the app said so. Show when a simulator is in use and which chat is using it, open a panel with the simulator in that chat when an agent starts on one, put a status line at the bottom of the chat that opens it, and let me shut simulators down.

**Follow-up (Philip, 2026-11-15, #2826).** Make the Simulators group collapsible; offer auto shutdown after 5 and 15 minutes too; Open did nothing, so make it work and also open the chat using the device. Also: are reusable simulators better than on-demand ones (see `reports/simulator-reuse-vs-on-demand-2026-11-15.md`).

## Why nothing showed it before

A booted iOS simulator is re-parented to Apple's CoreSimulatorService the moment `simctl boot` returns, so it is not a child of the agent's command, and nothing tied it back to the chat. Agents also never shut down the simulators they booted, so they piled up.

## What is shown

- **Hardware monitor: Simulators** (the Agent board's dock), and the same group in the **monitor chip's panel** on every other tab. Only while at least one simulator or emulator is booted. One row per device:
  - its name, with model and OS in the tooltip, and its CPU (summed over the device's processes, so it can pass 100%);
  - the chat that last used it ("used by iPad PanesTests, 2 min ago", which opens that chat), or "idle 9 days" when it is quiet (under 3% CPU) and no agent has touched it for 30 minutes or more; and how long it has been up;
  - **Open** opens the chat that last used the device (when an agent used it) and the device's own window (iOS), the window on top. A device no agent used opens its window only; a headless emulator an agent used opens its chat only. **Shut down** (words in the danger colour). Shutting down an iOS simulator offers **Undo** for 8 seconds, which boots it again.
  - Under the rows, **Auto shutdown**: Never (default), after 5 minutes, 15 minutes, 30 minutes, 1 hour or 4 hours. It shows on both surfaces.
  - **The group folds.** Its header (a turning chevron, "Simulators", the count and total CPU) folds the rows and Auto shutdown away, leaving that one line. Unfolded by default; the choice is remembered on this computer and shared by the dock and the chip's panel. The Undo line after a shutdown shows even while folded.
  - Not shown while the monitors read a connected computer: these are this computer's devices.
- **Monitor chip:** a phone glyph and the count while any device is booted; the tooltip has the total CPU.
- **In the chat: the Simulator panel**, at the top of the chat's Agent Monitor, for the devices this chat's agent used that are still booted: a live view of the screen, the device's CPU, **Open window** and **Shut down**, and a tab per device when there are several.
  - **It opens by itself** the first time the chat's agent starts on a device, once per chat and device. Closing it keeps it closed until the agent moves to another device. This applies in Simple too: it is the one thing that opens the Agent Monitor without the button, because a simulator the user cannot see is the problem this solves. `simulatorPanelAutoOpen: false` turns it off.
  - Where the chat has no room for the Agent Monitor (a narrow pane, an Agent board window) it does not open; the status line below still shows.
- **Above the composer:** "Nekko-1314-iPad is running · 95% CPU · Show" (a success dot and the phone glyph) while a device this chat used is booted. Show opens the Simulator panel, or Simulator itself where the chat has no room for the panel.

## Which chat uses which device

The daemon watches every agent tool call of every chat type (built-in tools, Claude Code, sandbox chats) as the events pass to the windows.

- A call **acts on a simulator** when it runs `simctl boot/install/launch/io/openurl/...`, `xcodebuild` with a simulator `-destination`, `adb` (other than `adb devices` and `emu kill`), `emulator -avd`, `open -a Simulator`, or a known runner (`flutter run`, `expo run:ios`, `react-native run-ios`, `maestro test`, `detox test`, `scripts/ios-evidence-local.mjs`). Listing, shutting down, deleting or erasing devices is not using one.
- A booted device that such a call names, by UDID, name, AVD or adb serial, in the command or in its output (`simctl create` prints the new UDID), is that chat's. `simctl ... booted` is the most recently booted iOS device.
- A device that boots within two minutes after an acting call, without being named, is the newest such call's chat (a script that makes and boots its own simulator).
- The newest use wins: another chat that acts on the same device takes it over.
- Who used what is kept in `simulators.json` in the data folder, so a device's idle time survives a restart. Nothing in it leaves the computer.

## The device's window

Xcode 27 has no Simulator.app: Apple replaced it with **DeviceHub** (`Xcode.app/Contents/Applications/DeviceHub.app`, `com.apple.dt.Devices`), so the first Open (`open -a Simulator --args -CurrentDeviceUDID`) failed on Xcode 27. The daemon now finds the selected Xcode (`DEVELOPER_DIR`, else `xcode-select -p`) and opens `devices://device/open?id=<udid>` with that Xcode's DeviceHub; with an older Xcode it opens that Xcode's Simulator.app by path with `-CurrentDeviceUDID` (which Simulator honours only when it is not already running); with neither it falls back to `open -a Simulator`. Verified 2026-11-15 on Xcode 27.2 by hand: DeviceHub logged the URL as handled. Not yet clicked through the packaged app. DeviceHub's first launch runs its system updater, which takes several seconds before the window appears.

## Cost

- One `ps` per read (about 0.1 s of CPU for 2,500 processes). The window reads every 5 s while a device is booted and every 15 s while none is, never while the window is hidden; the daemon shares one read across windows for 2 s.
- `simctl list` runs only when a device the daemon has not seen boots, and once a minute while any is booted.
- After an acting call the daemon reads every 4 s for 3 minutes, so a device that boots later is picked up, and tells the windows at once (`simulators:updated`).
- The live view takes one screenshot every 1.5 s, only while the panel is on screen and the window is visible.

## Auto shutdown

Off by default (`simulatorAutoShutdownMinutes`; the choices are 5, 15, 30, 60 and 240). When set, once a minute the daemon shuts down a device that an agent used, that no agent has touched for that many minutes and that is under 5% CPU. A device no agent used (one you booted yourself) is never shut down by this.

## Quitting shuts them down

**User intent (Philip, 2026-11-19).** When the app shuts down gracefully, make sure the simulators shut down too.

`[implemented 2026-11-19; unit test, and checked on macOS against two real simulators through a stand-alone daemon stopped by closing its stdin: the one an agent used shut down, the other stayed booted]`

- When the daemon shuts down gracefully (quitting the app, `npm run dev`'s q, Enter or Ctrl+C, a closed stdin, SIGTERM or SIGHUP), it shuts down every booted simulator and emulator an agent used, all at once, alongside the rest of its cleanup. The agents that booted them are stopping, so nothing else would.
- A device no agent used (one you booted yourself) stays running, as with auto shutdown.
- It waits at most 4 seconds, inside the time the app gives the daemon to stop, and then quits anyway; a device still stopping finishes on its own. Each one shut down, or that could not be, is a line in the daemon's log.
- A forced stop (the second press in `npm run dev`, a crash, SIGKILL) skips it: the devices stay booted and show in the Hardware monitor on the next start.
- Measured on an M1 Max, macOS 27.2, debug daemon: quitting took 0.9 to 1.0 s with no agent device booted and 3.9 s with one (`simctl shutdown` itself).

## Boundaries

- Desktop and Local Web UI only. None of the `simulators:*` channels is in the phone's allowlist; a phone cannot list, view or stop a simulator.
- Screenshots are taken on demand for the panel and never stored.
- iOS needs Xcode on macOS. Android emulators are read on macOS and Linux from their `qemu-system-*` process; Windows is not covered yet.
- A headless Android emulator has no window, so its Open opens only the chat that used it (none when no agent did); Shut down asks it to quit through adb, then ends its process.

## Agents shut down what they boot

`docs/runbooks/simulators.md`: an agent that boots a simulator or emulator shuts it down when its task ends, unless the user asked to keep it.
