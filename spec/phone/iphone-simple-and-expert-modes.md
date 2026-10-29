---
title: "iPhone: Simple and Expert modes, the model and effort control, the context gauge and the hardware monitor (2026-10-24)"
area: phone
---

# iPhone: Simple and Expert modes (2026-10-24)

**User intent:** Philip asked (2026-10-24) for the phone's chat to get a mode switch at the top left, like the desktop's, toggling between **Simple** and **Expert**. In Simple mode the user picks the model and effort, from one control at the bottom with the model's name and a gauge for the effort. Expert mode adds a monitor panel of gauges for the computer's hardware, and a models monitor like the desktop's: the models loaded, unloading them, the hardware they use and their context size. The chat's context usage is shown in both modes, always.

**Status `[implemented 2026-10-24 on the native iPhone app and the computer's phone gate; the gate's TS and Rust editions unit-tested; the Swift package tests (protocol parsing, the monitor store, the chat's context and effort) pass on Linux and macOS; the hardware store is named HardwareMonitorModel to coexist with the folding-phone Monitors pane; the views driven in the simulator by LiveRelayTests/testSimpleAndExpertModes against a live stack (2026-10-25); Android implemented 2026-10-25 (T217b), see *Android* below]`**

## Behaviour

- **The switch.** A menu at the top left of every chat (next to Back) reads *Simple* or *Expert* with a gauge icon. The choice is the iPhone's (`Prefs.expertMode`, off by default) and holds for every chat and computer.
- **Model and effort (both modes).** Under the message box, one control: an effort dial (one notch per level the chat's model takes, the arc empty and the needle centred while the chat follows the computer's effort) and the model's name. It opens **Model and effort**: the model row opens the existing model picker; the effort dial is drawn large with a stop per level (`Effort.levels(for:)`, the desktop's `modelEffortLevels` ladder). Choosing one sets the chat's `effort` through `session:setOptions`. *Computer default* can't be chosen again from the phone (the gate takes only a level); the chat follows the computer until a level is chosen. Read-only while the chat on screen is the phone's saved copy.
- **Context (both modes, always).** Beside it, a ring that fills as the chat's window does and the count (`12.3k / 128k`, or just the tokens when the window is unknown, or `–` until the computer answers). The colours follow the desktop's composer gauge (`fillTone`: warning from 60%, danger from 85%). Tap for the breakdown by kind of source (system prompt, conversation, attached files, guidelines, memory, connectors, code index, skill), the reply streaming now, and what is free. The count is the computer's own (`context:preview`, the same estimate as the desktop's gauge), read with the chat and after each turn; while a reply streams it adds about one token per four characters streamed, as the desktop's live gauge does, in steps of 256 tokens so the gauge redraws a few times a reply rather than on every token.
- **Expert: the monitor panel.** Under the chat's title, small dials for CPU, memory, each GPU and GPU memory (*VRAM*, or *GPU memory* on a unified-memory Mac), in the desktop Hardware monitor's order, and the number of models loaded. Temperatures show under a dial where the computer has sensors (warning from 80 °C, danger from 90 °C). Dials colour by load (warning above 70%, danger above 90%). Re-read every 3 seconds, only while Expert mode is on and a chat is open.
- **Expert: the whole monitor.** Tapping the panel opens **Monitor**: the hardware as larger dials with the core count and memory; **Loaded models**, each with its name, where it runs (GPU, GPU + CPU with layers, CPU only, the split in the warning colour as on the desktop), its context size and memory, a bar for its share of the memory for models, and **Unload**; models queued or loading with their progress; how much of the memory for models the loaded ones take; and this chat's context breakdown. Unloading needs no confirmation (the next reply that uses the model loads it again) and says what the computer answered.

## Phone access (decided in this change)

Recorded in [docs/decisions/0028](../../docs/decisions/0028-phones-read-the-monitors-and-unload-models.md).

- `system:stats`, `gpu:stats`, `engine:status` and `context:preview` join `PHONE_CHANNELS` as **Read** (`PHONE_MONITOR_READ_CHANNELS`), each through a narrow projection made on the computer (`phone-views.ts`, `phone_views.rs`):
  - hardware: `PHONE_SYSTEM_VIEW`, `PHONE_TEMPS_VIEW`, `PHONE_GPU_VIEW`, `PHONE_GPU_DEVICE_VIEW`: numbers only, never a CPU or GPU model name (as `monitor:summary`);
  - the Model Server: `installed` (whether it has a binary, never the path), `running`, `resident` (`PHONE_RESIDENT_VIEW`), `loading` (`PHONE_LOADING_VIEW`) and `memory` (`PHONE_ENGINE_MEMORY_VIEW`); never its log, port, settings or folders;
  - a chat's context: `usedTokens` (the included items), `contextWindow` and tokens per source kind (`PHONE_CONTEXT_SOURCES`); never an item's label, origin or preview. The computer always calls it with no attached paths.
- `model:unload` joins as **Change without a proof** (`PHONE_AGENT_CHANNELS`): it takes a provider id and a model id (both non-empty strings, else `value-invalid`) and returns only `ok` and `message`. Loading, downloading, deleting models and the Model Server's settings stay refused.

## Android (2026-10-25, T217b)

**Status `[implemented on the native Android app; Kotlin unit tests (parsing, the polling model, the chat's context and effort) pass; ChatModesTest driven on a local 7.6" foldable emulator (two chat panes) and a Pixel 5 phone emulator against an in-test computer, not yet on hardware or a live computer]`**

The same design as the iPhone, in the native app (`apps/android`), wide foldables first:

- **The switch** sits right of Back in every chat's header and is the phone's own choice (`EXPERT_MODE`, Simple by default). In a folding phone's chat pane (Galaxy Fold, Pixel Fold open) the header is narrow, so the switch is the dial icon alone, coloured in Expert, and the title stays readable; each pane's chat follows the same choice.
- **Model and effort** and the **context ring** sit in one row under the message box, in both modes. The row's control opens a bottom sheet: the model row opens the computer's model list (the New chat picker, every enabled provider, starred first) and the large effort dial has a button per level; both go through `session:setOptions`. The ring's breakdown opens as a small menu. The model's name comes from the chat's provider's `models:list`, read when the chat opens.
- **Expert** adds the strip of dials under the chat's header and the **Monitor** bottom sheet (larger dials, Loaded models with Unload, models loading, the memory for models, this chat's context). The hardware is re-read every 3 s only while Expert is on, the chat is on screen (lifecycle STARTED) and the computer is online. On a folding phone each chat pane reads it on its own.
- Strings are Android resources in English and the iPhone's six other languages, drafted from its String Catalog; the rest of the Android app is still English only, so those six languages see these controls translated in an otherwise English app.

## Simple hides developer controls (reframed 2026-10-28, #1311)

The same change as the desktop ([Desktop Simple and Expert modes](../desktop/desktop-simple-and-expert-modes.md), [decision 0030](../../docs/decisions/0030-simple-hides-developer-controls-per-device.md)). Simple becomes the everyday app: developer controls out of sight, every capability still there, no screen hidden. The mode and the choices are kept on the phone (`expertMode`, and `simpleChoices` as JSON holding only values that differ from the defaults). A new install starts in Simple. The 2026-10-24 rule that effort and context show in both modes was first superseded (both Expert only), then brought back by Philip's updates of 2026-10-28: context and effort are Show by default.

- **The switch** is two icon segments, a chat bubble (*Simple: everyday controls*) and angle brackets (*Expert: every control*), at the top left of a chat and of the chats list.
- **The phone's catalogue** has the same ids as `packages/shared/src/simple-mode.ts`. The model picker, effort and context are Show by default; every other control is Expert only:
  - `changes`
  - `hardware`
  - `ph-subtitle`
  - `model`
  - `effort`
  - `context`
  - `ph-policy`
  - `thinking`
  - `ph-git`
  - `terminal`
  - `ph-monitors`
- **Settings > Simple mode** is a screen reached from Settings. It has an intro, a Simple | Expert **Preview**, and one card per area. Each card draws its area from chips named after the real controls, dashed and faded where the previewed mode leaves a control out. Each control has a row with a Show / Expert only / Hide choice. **Reset to defaults** is at the bottom.

- **Philip's updates (2026-10-28):** "simple shows context", monitors shown "whenever a local model is running, even in simple mode", "minimal guages and percentages that when tapped, show more detail", "a minimal pull down sheet panel at the top", the getting-long note saying "it will save n tokens to start fresh", and "keep the nekko in the top middle. move the the toggle to a slim second row. use a subtle divider line." On both phones:
  - **Context** is Show by default.
  - **The monitors** (`hardware`, `ph-monitors`) at Expert only also show in Simple while the Model Server holds a local model. Simple reads only `engine:status` every 10 s to know; the full hardware read (3 s) runs only while the gauges or the panel are on screen.
  - **Header:**
    - The top row keeps Back, the title centred, and More.
    - The switch moves to a slim second row (32 pt / 34 dp) with a hairline under it.
    - The right of that row holds the **minimal monitor** when shown: thin rings with percentages for CPU, Memory and GPU, plus the loaded-model count.
  - **The agent panel:** tapping the gauges pulls a panel down from under the title. It is dismissed by a swipe up, a tap outside, Done or Back. It holds:
    - larger gauges with temperatures;
    - loaded models with Unload;
    - in a chat, its model, effort and context breakdown.

    It replaces the strip of dials and the bottom Monitor sheet.
  - **Getting long (Simple only):** at 85% of the window, a line above the message box says *This chat is getting long. Starting fresh saves about N tokens.* N is the conversation's tokens.
    - **Start fresh** opens New chat on the same computer with the same model.
    - The line can be dismissed per chat. On the iPhone that is kept on the phone for the last 200 chats; on Android, while the chat stays open in the back stack.
  - **iPhone:** the chats list's large *Chats* title no longer draws, because the slim row sits under the bar. The cat is centred. Debug builds take `-uiTestLocalModel` and `-uiTestLongChat` for screenshots.
  - **Android:** the chats list centres *Chats* (it has no Nekko mark). In the slim row the segments are 30 dp tall, under the 48 dp touch guideline.
  - **Verified:**
    - iPhone: NekkoNativeTests (100 run, 1 skipped), Protocol `swift test` (190), and live `testSimpleAndExpertModes` with its accessibility audits; screenshots use the debug stubs for the loaded model and the long chat.
    - Android: 276 unit tests, lint and builds; `ChatModesTest` updated but not run.

- **Philip's second round (2026-10-28),** after trying the iPhone build. His words, in order: the gauges bar "should smoothly descend from below the top card"; "a lot of white space appears in the top bar between the mac icon and the simple toggle"; "hovering the guages should show full details in an interactive tooltip"; "remove the running and needs you sections in here. Those should be dynamic groups that show when agents are in that status"; "move the search to just be in the top left menu"; "we seemed to backtrack to the rounded cards instead of the modern design we had before"; "remove the pair another computer and move it into the computers section"; "if there are two or more computers, show n connected"; "change 'sign out or stop' to be 'sign out or disconnect'"; "in logs, clarify by grouping, on this phone, and per device"; "make 'effort' a slider bar in the dropdown. show effort by default in the in simple mode. Also reduce the whole size of it. Give the slider bar a color behind the left size of the slider that gets more intense in the gradient and subtle speed line animations". On both phones:
  - **The slim row** slides down from under the title bar as a screen opens (a short spring, none with Reduce Motion), and the minimal monitor slides in the same way when it appears. Its ground is the solid colour at the top of the app's wash, with a faint shadow along its top edge, so it reads as tucked under the bar. The chats list's title is inline (Nekko stays in the middle), which removes the empty band where the large *Chats* title and the search drawer sat.
  - **Gauge tooltips:** hovering a gauge with a pointer, or touching and holding it, opens a small popover with that reading in full: the gauge, its name, what it measures (chip and cores, memory used of total, the GPU's name, GPU memory used of total) and its temperature; the models count lists each loaded model and its size. **Details** in it opens the agent panel. A plain tap still opens the panel.
  - **Monitors:** *Needs you* and *Running* show only while something is in them. *Next automations* stays.
  - **Search** leaves the chats list's bar. **Search chats** is in the top-left computer menu, and choosing it puts a search field with **Cancel** in place of the slim row.
  - **Flat lists again:** the chats list and Monitors put their rows straight on the coloured ground, hairline separated, with accented group headings, as on 2026-10-24. The rounded panels of 2026-10-26 are gone from those two screens; Settings and the other forms keep grouped sections.
  - **The computer menu:** *Pair another computer* leaves it (it is on the Computers page). *Computers* moves up beside the computer list. *Sign out or stop* is now **Sign out or disconnect**.
  - **The computer pill:** with two or more computers paired, a second line reads *N paired*. Philip asked for "n connected"; the phone holds a live connection to one computer at a time and the Computers page calls the others *Not connected*, so the line says *paired*.
  - **Logs** are grouped: **On this phone** (the phone's connection log since the app started), then one group per paired computer. The connected computer lists its logs; another offers **Connect to read its logs**.
  - **Effort** is Show by default in Simple. The composer's dial is smaller (16 pt). The control opens a small dropdown (a popover on the iPhone) instead of a half-height sheet: the model row, then effort as a bar that snaps to the model's levels with their names under it. Left of the thumb the bar fills with the accent, deepening toward the thumb and with each level, and faint speed lines drift through the fill, faster at higher effort (still with Reduce Motion). *Computer default* leaves the bar empty with a faint thumb in the middle. VoiceOver adjusts it with swipe up and down.
  - **Android differences:**
    - Android had no computer menu, so Chats gets one: a pill at the top left (dot, computer name, *N paired*, arrow) whose menu lists the computers (tap one to connect), **Search chats**, **Computers** and **Sign out or disconnect**. It replaces the top-right Computers icon; Settings keeps its icon at the top right.
    - Its lists were never cards. Rows now get hairline dividers and the group headings the accent colour. Android has no coloured wash.
    - Effort stays a bottom sheet, now sized to its content with no dial; the composer's dial is 18 dp.
    - Animations follow the system's animator duration scale (off at 0). The top bars are 56 dp, so the slim row sits right under them.
    - *On this phone* in Logs is the in-memory connection log, opened as its own page with Share.

### iPhone `[implemented 2026-10-28 on branch simple-expert-modes; SimpleModeTests and the NekkoNativeTests suite pass (98 run, 1 skipped); LiveRelayTests/testSimpleAndExpertModes passes against a live relay stack with its accessibility audits in both modes; screenshots on a fresh simulator; NewChatChoicesTests and PanesTests now launch in Expert but were not run]`

- **Gates.** Each goes through `Prefs.shows(id)`:
  - `ph-subtitle`: the model and computer line under the title.
  - `changes`: More > Changes.
  - `hardware`: the monitor panel; polling stops while hidden.
  - `model` and `effort`: their halves of the composer's control and of its sheet, More > Model, and the New chat chips. The control goes when both are hidden. A chat with no model still shows the picker.
  - `context`: the ring and count.
  - `ph-policy`: More > Tool policy and the New chat Tools chip. A hidden choice keeps its saved or default value.
  - `thinking`: the reasoning fold, tool step rows, sub-agent and purpose groups. They are hidden outright; there is no per-turn fold yet. *Working…* still shows while a reply runs.
  - `ph-git`: More > Git, More > Commit or open a PR, and the PR chip above the composer.
  - `terminal`: More > Terminals and + > Terminal.
  - `ph-monitors`: the Monitors row at the bottom of Chats. The Monitors pane on a folding phone or iPad stays.
- **Settings > Simple mode** is a row under Appearance that shows the current mode. Touching a control's row outlines its element in the accent colour for a moment.
- **Steps in Simple:** each turn's reasoning and tool steps fold to one line (*Took 4 steps*, *Working · 2 steps so far*, *Thought it through*) with **Show steps** / **Hide steps** per turn. The phone gets no turn times from the computer, so no duration shows.
- **Strings:** the new strings are in `Localizable.xcstrings` in de, es, fr, ja, pt and zh-Hans (2026-10-28).

### Android `[implemented 2026-10-28 on branch simple-expert-modes; JVM unit tests (SimpleModeTest, 273 in all), lint and debug and androidTest builds pass; ChatModesTest rewritten for the new switch but not run (no working adb on the build Mac); no screenshots yet]`

- **Gates.**
  - `ph-subtitle`: the model and computer line under the title.
  - `changes`: the header icon.
  - `hardware`: the strip and Monitor sheet; polling stops while hidden.
  - `model`, `effort` and `context`: each is its own part of the row under the message box, and the row goes when all three do. A chat with no model still shows the picker. Effort also leaves New chat, which then uses the computer's default.
  - `thinking`: the Show reasoning toggle, and the tool step rows and step cards, which are left out (Android has no per-turn fold). Allow and Deny cards still show.
  - `ph-git`: the PR chip and its sheet. More > Git stays, since it is the only way to the Git screen.
  - `terminal`: Terminal in the + menu and Terminals in More.
  - `ph-monitors`: the Monitors row at the bottom of the chats list. The foldable Monitors pane and screen stay.
- **Steps in Simple (2026-10-28):** each turn folds to one line with its time when known (*Took 3 steps · 14s*), and **Show steps** opens it.
- **Touch targets:** the slim row's switch and gauges keep a 34 dp look with 48 dp touch areas.
- **Verified:** `ChatModesTest` (5 tests) passes on a headless arm64 emulator after platform-tools moved to r37 (2026-10-28).
- **Left out of the Settings screen:** `ph-policy`. Android has no per-chat tool policy, so the choice would do nothing.
- **The preview** starts on Simple. A row just changed is ringed in the accent colour for a moment.

## Not yet

- Android on a real foldable and against a live computer; one shared hardware read for two chat panes instead of one each.
- The desktop has the same design since 2026-10-25: [Desktop Simple and Expert modes](../desktop/desktop-simple-and-expert-modes.md).
- Clearing a chat's effort back to the computer's default from the phone (needs the gate to accept a clear).
- Changing which monitors show, as the desktop's Settings → Monitors does; the phone shows them all.
