---
title: "Desktop: Simple and Expert modes, the effort dial, the context ring and the hardware strip (2026-10-25)"
area: desktop
---

# Desktop: Simple and Expert modes (2026-10-25)

**User intent:** Philip asked (2026-10-25) that the iPhone's new chat design ([iPhone: Simple and Expert modes](../phone/iphone-simple-and-expert-modes.md)) also apply to the Electron desktop app, the most important surface for it, and that wide phones (open folding phones) get similar controls.

**Status `[implemented 2026-10-25 in apps/desktop; unit-tested (dial geometry, the ring, the effort control's keys and markup); captured in the hidden chat-modes harness with synthetic hardware and engine data; not yet tried on a real machine with a local GPU]`**

## Behaviour

- **The switch.** *Simple* / *Expert* with a gauge icon at the top left of every chat, before its title (in the window's title strip when the chat is framed). Kept on this computer (`localStorage`, `nekko.chatMode`), shared by every open chat, Simple by default.
- **Effort (both modes).** Beside the model picker, a small dial with one notch per level the chat's model takes (the existing `effortRungs` ladder, so the model's default still reads *Default · Medium* on Opus 5.5), the word *Effort* and the level. Clicking opens a popover with the dial drawn large and a button per level; the arrow keys step the level without opening it. It sets the chat's effort, or the app's when there is no chat, exactly as the slider it replaces did.
- **Context (both modes, always).** The composer gauge is a ring that fills as the window does, beside the count (`125k / 200k`, `~` before a guessed window). Colours are unchanged (`fillTone`: green, warning from 60%, danger from 85%); the count takes the colour from 60%. Hover or focus shows the same breakdown as before.
- **Expert: the hardware strip.** Under the chat's header, small dials for CPU, memory, each GPU and VRAM (*GPU memory* on unified memory), with temperatures under a dial where the machine reports one, and the number of models the Model Server holds. Dials colour by load as on the phone (warning above 70%, danger above 90%). They follow Settings → Monitors: a monitor switched off has no dial and is not sampled. The readings come from the same shared sampler as the resource chip (every 2 s); the loaded count re-reads the engine every 6 s, only while the strip is shown.
- **Expert: the monitor.** Clicking the strip opens larger dials and the **Local models** monitor: each resident model with where it runs, its context and memory, a jump to its settings and *Open Model Server*. Unloading stays on Model Server, where the desktop already offers it.

## Message box bottom row (2026-11-03)

Issue: [#1599](https://github.com/nekko-labs/nekko-agent/issues/1599). Philip: nothing should ever go below the message box; a lower row belongs inside it.

- **Simple and Expert.** The row that sat under the message box (folder, model and effort, the context ring, usage, then Tools, MCP and the internet toggle at the right) is now the box's own bottom row, under the editor and the bar with + and Send, behind a hairline. Same controls, same order, same visibility rules. The "this chat needs a model" note sits at the top of that row, inside the box.
- **New chat.** On the wall's new chat the model and effort already ride the composer's bar, so the copy that floated under the box is gone. A new chat outside the wall keeps the model and effort as the box's bottom row.
- **Wall windows** still have no footer row ([a composer in every wall window](a-composer-in-every-wall-window.md)). An archived chat has no message box and now shows no footer either.
- Nothing renders under the message box in any of these.

Verification: `AgentWindowIndicators.test.tsx` and `cleanStart.test.tsx` check the controls sit inside the box after its bar and that no control follows the box; captured before and after in the hidden chat-modes and new-chat harnesses.

## Wide phones

- **iPhone app, regular width** (an open folding phone, iPad): each pane in `PanesView` shows the same `ChatView`, so the switch, the model and effort control, the context gauge and the Expert panel apply per pane.
- **Android** (Galaxy Fold and other foldables): the same design since 2026-10-25 (T217b), see [iPhone Simple and Expert modes, Android](../phone/iphone-simple-and-expert-modes.md#android-2026-10-25-t217b).

## Not yet

- Unload from the desktop's Expert monitor.
- A real-hardware check (NVIDIA, Apple Silicon unified memory) of the strip's labels and temperatures.
