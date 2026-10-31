# What the iPhone app has that Android lacks (2026-10-30)

Method: read `spec/phone/native-ios-app.md`, `spec/phone/native-android-app.md`,
the other `spec/phone/iphone-*` files and the open `AN-*`, `MD-6`, `MM-4` and
`T201a` tasks in `TASKS.md`, then checked each candidate gap against the code in
`apps/android` (file list, relay channels used, greps for the feature's markers).
Nothing here was run on a device or emulator.

The relay channels are almost the same on both: Android already calls git, PRs,
terminals, files, logs, previews, providers, automations, usage, monitors and
step-up. The only channels the iPhone uses and Android doesn't are `machine:summary`,
`session:watches`, `push:test` and `card:set`. So the gap is mostly on the phone side.

## Gaps, grouped into candidate PRs

| # | Gap | iOS reference | Android today | Size |
|---|---|---|---|---|
| 1 | **Chat actions from the chat:** rename, pin, chat mode / tool policy per chat, complete | `ChatView.swift` More menu | ⋮ has only Files, Git, Terminals; `setOptions` sends model and effort only | S |
| 2 | **Version check banner** (IO-32): name the side to update when protocols differ | `PhoneProtocol.swift`, chat list and About | `PhoneProtocol.VERSION` is sent but the computer's version is never shown | S |
| 3 | **Offline: drafts and outbox, exactly once** (`clientMessageId`, *Waiting to send*, *Send when online*, refused prompt back in the draft) | `Drafts.swift`, `Outbox.swift`, `OutboxRefresh.swift` | No `clientMessageId`; drafts not persisted; only `SignOutOutbox` | L (stack) |
| 4 | **Read offline and instant paint** (OF-5, OF-6): last 20 chats saved, painted at once | `SavedTranscripts.swift` | Saved chat list only (spec says OF-5 is not on Android) | M |
| 5 | **Route failover** (AN-28 / IO-20) plus **Check routes** and **Share diagnostics** (IO-21) | `RouteSupervisor.swift`, `RouteProber.swift`, `Diagnostics.swift` | `alt` routes parsed, not used; no route checks | L |
| 6 | **Notification controls per kind, test notification, dismissal sync** | `Notifier.swift`, Settings → Notify me about | One *Notify me* switch, local only | M |
| 7 | **Push** (AN-6, FCM) | APNs registration | None. Blocked: needs a Firebase project and the relay's FCM credentials | M + owner |
| 8 | **Rich Markdown** (MD-6): tables, link previews, Markdown composer and toolbar, rich paste | `MarkdownBlocks/Editing/Highlight.swift`, `RichPaste.swift`, `MarkdownComposer.swift` | Basic subset, no tables | L |
| 9 | **Mermaid diagrams** (MM-4) in a locked WebView | `Mermaid.swift` | None | M |
| 10 | **The agent's work as rows**: subagent groups, watches (`session:watches`), desktop-style status icons | `AgentRows.swift`, `AgentRowViews.swift`, `ChatStatusIcon.swift` | Done 2026-10-31 (`AgentRows.kt`, `AgentRowViews.kt`, `ChatStatusIcon`) | M |
| 11 | **Chat list view menu**: grouping, draggable / reorderable groups | `ChatListLayout.swift` | Fixed grouping | M |
| 12 | **Always-on dictation**: segments at pauses, "Nekko, …" voice commands, Hold to talk, first-open video | `VoiceSegmenter`, `VoiceCommands`, `HoldToTalk`, `VoiceRunner`, `VoiceIntroView` | One 30 s recording per tap | L |
| 13 | **Languages and theme presets** (T201a remainder) | String Catalogs (7 languages), `ThemePresets.swift` | Only the mode strings are translated; presets drawn as mode + accent | L (mechanical) |
| 14 | **A computer's page** (`machine:summary`, round trip, tiles) | `ComputerViews.swift`, `MachineModel.swift` | Computers screen: rename / switch / forget | M |
| 15 | **Nekko Cloud machines** | `CloudViews.swift`, `CloudSync.swift`, `CloudDeviceKey.swift` | None | L |
| 16 | **First run** (three steps, notification permission after pairing) | `FirstRunView.swift` | None | S |
| 17 | **Lock Screen card with Allow / Deny / Stop** (the one Live Activity, `card:set`) | `LiveCard.swift`, `RunActivities.swift` | Keep-alive Live Update with counts only, Deny in notifications | L, needs push to work while suspended |

## Not worth porting as-is

- Apple Watch app and complications: Wear OS would be a separate product decision.
- Control Center control, Siri App Shortcuts, Spooky alternate icon: Android already
  has the Quick Settings tile and the `nekko-agent://new` launcher shortcut.
- Pull-to-refresh mascot, opening animation, new-chat mascot: cosmetic, do after the above.

## Suggested order

1. Small, self-contained: **#1 chat actions**, **#2 version banner**, **#16 first run**.
2. Reliability: **#3 outbox** (stack: drafts → outbox + `clientMessageId` → UI), then **#4**, then **#5**.
3. Reading quality: **#10 agent rows**, **#8 Markdown** (tables first), **#9 Mermaid**.
4. **#6 notifications**; **#7 push** once the owner sets up Firebase; then **#17**.
5. **#13 languages and presets**, **#12 voice**, **#14**, **#11**, **#15**.

## Open questions for the owner

- Push (AN-6): who creates the Firebase project and gives the relay its FCM service account?
- Is Nekko Cloud machines (#15) wanted on Android in this beta?
- Should the translation work (#13) wait for the native-speaker review (T201b)?
