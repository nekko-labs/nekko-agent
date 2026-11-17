# Simulators and emulators

How an agent uses an iOS simulator or Android emulator on a shared Mac without leaving
it running. On 2026-11-15 five simulators sat booted on Philip's Mac, one for nine
days, and held the load average above 80 (#2814).

## Shut down what you boot

- **When your task ends, shut down every simulator or emulator you booted**, unless the
  user asked you to keep it running. Do it in the same turn that finishes the work, also
  when the work failed:
  ```
  xcrun simctl shutdown <udid>
  adb -s emulator-<port> emu kill
  ```
- A simulator you created for the task (`simctl create`), delete as well:
  `xcrun simctl delete <udid>`. `scripts/ios-evidence-local.mjs` already creates, boots
  and deletes its own.
- Never shut down a device you did not boot: another chat, or the user, may be using it.
  `xcrun simctl list devices booted` lists them, and the app's Hardware monitor says which
  chat last used each one.
- Prefer reusing a simulator that is already booted for the same runtime over booting
  another one.
- Name a device you create after the task (`Nekko-<issue>-<what>`), so a person reading
  the Hardware monitor knows what it is for.

## Boot headless

Boot with `xcrun simctl boot <udid>` and do not open Simulator.app unless the user asked
to watch: a shown Simulator window costs WindowServer time on top of the device's own.
The chat's Simulator panel in Nekko Agent shows the screen without it.

## Name the device in your commands

Nekko Agent ties a simulator to the chat whose commands name it (by UDID or name, or
`booted`), so the user sees which chat is using it. Pass `-destination
'platform=iOS Simulator,id=<udid>'` rather than a generic name when more than one
device is booted.
