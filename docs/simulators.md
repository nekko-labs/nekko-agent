# Simulators in use

When an agent builds or tests a phone app it boots an iOS simulator or an Android
emulator. A booted simulator keeps using CPU and memory after the agent's command ends,
and it is easy to lose track of. Nekko Agent shows every booted simulator, which chat
is using it and what it costs, and lets you stop it.

## Where you see them

- **Monitor chip** (bottom right): a phone and a count while any simulator is booted.
  Hover it for the list.
- **Hardware monitor** on the Agent board: a **Simulators** group with each device, its
  CPU, the chat that last used it ("used by iPad tests, 2 min ago", which opens that
  chat) or "idle 9 days" when nothing has touched it, and how long it has been up.
  Click the group's name to fold it to one line (the count and total CPU); it stays
  folded until you unfold it.
- **In the chat**: when the chat's agent starts on a simulator, a **Simulator** panel
  opens at the top of the chat's Agent Monitor with a live view of the screen. It opens
  once per simulator; close it and it stays closed until the agent moves to another one.
  A line above the message box ("iPhone is running · 40% CPU · Show") brings it back.

## Stopping one

- **Shut down** stops a simulator. For an iOS simulator, **Undo** boots it again for a
  few seconds afterwards.
- **Open** opens the chat that is using the simulator and, for an iOS simulator, its
  window in Xcode's device app (DeviceHub from Xcode 27, Simulator before it). For an
  emulator with no window it opens the chat only.
- **Auto shutdown** (under the list) stops simulators an agent used once no agent has
  touched them for 5, 15 or 30 minutes, 1 hour or 4 hours and they are nearly idle. It
  is off by default, and it never stops a simulator you booted yourself.

## Turning the panel off

Set `simulatorPanelAutoOpen` to `false` in settings to keep the Simulator panel from
opening by itself. The status line and the Hardware monitor still show.

## Privacy and limits

- Everything stays on this computer. Screenshots for the live view are taken while the
  panel is on screen and are not saved. A paired phone cannot see or stop simulators.
- iOS simulators need Xcode on a Mac. Android emulators are shown on macOS and Linux.
- Which chat is using a simulator is worked out from the commands its agent ran. A
  simulator started outside Nekko Agent shows with no chat.
