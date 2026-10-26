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
- **Context (both modes, always).** Beside it, a ring that fills as the chat's window does and the count (`12.3k / 128k`, or just the tokens when the window is unknown, or `–` until the computer answers). The colours follow the desktop's composer gauge (`fillTone`: warning from 60%, danger from 85%). Tap for the breakdown by kind of source (system prompt, conversation, attached files, guidelines, memory, connectors, code index, skill), the reply streaming now, and what is free. The count is the computer's own (`context:preview`, the same estimate as the desktop's gauge), read with the chat and after each turn; while a reply streams it adds about one token per four characters streamed, as the desktop's live gauge does.
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

## Not yet

- Android on a real foldable and against a live computer; one shared hardware read for two chat panes instead of one each.
- The desktop has the same design since 2026-10-25: [Desktop Simple and Expert modes](../desktop/desktop-simple-and-expert-modes.md).
- Clearing a chat's effort back to the computer's default from the phone (needs the gate to accept a clear).
- Changing which monitors show, as the desktop's Settings → Monitors does; the phone shows them all.
