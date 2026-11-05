---
title: "iPhone: New chat picks a free computer for a local model (2026-11-05)"
area: phone
---

# iPhone: New chat picks a free computer for a local model (2026-11-05)

`[implemented 2026-11-05, iPhone only: ranking, fleet probes and the activity:state phone view have unit coverage (NekkoKit MachinePickTests on native macOS CI, nekko-remote, packages/shared). The SwiftUI screen builds and the isolated simulator Automatic/manual/all-busy/pending-probe tests pass in run 42025582777 at 408528bef. Captured screenshots and timing video still require visual inspection; the full native suite is pending. Two real computers remain unverified. Android picks the same way since 2026-11-05 (native-android-app.md); the desktop doesn't pick]` Decision: [0052](../../docs/decisions/0052-new-chat-picks-a-free-computer-on-the-phone.md). Builds on [every computer at once](iphone-every-computer-at-once.md).

## User intent

The ask (2026-11-05, Davide for his manager): *people pick, but pick an available machine.* For a local model, the app picks the machine for you, then the model, then sends the chat there. Nobody should have to know which of their computers is free. Picking by hand stays possible.

Settled with Davide (2026-11-05):

- The phone picks, over the links it already holds to every paired computer; no Nekko Cloud broker.
- "Free" means no chat is replying there and nobody is at its keyboard. GPU headroom comes later.
- Only chats on a **local model** are moved. A cloud model's work happens at the provider.
- A chosen **folder** decides the computer (the folder lives there).
- With every computer busy or offline, the chat stays on the computer used last, and the screen says so.
- The iPhone first.

## What the user sees

- **New chat → Run on** starts on **Automatic** when the chat's model is local, more than one computer is paired, no folder is chosen and New chat was opened from the all-computers list. The chip reads *Auto · Studio Mac*.
- While it asks the computers, the line under the options reads *Finding a free computer…*. Then it says what it chose: *Auto picked Studio Mac: MacBook is busy.*, *Auto picked Studio Mac: it's free.*, *Every computer is busy, so Auto kept MacBook, the one used last.* or *No other computer can run a local model now, so Auto kept MacBook.*
- Moving to another computer keeps what was typed and picks a local model there: the same model if that computer has it, else the last one used there, else one already loaded on its model server, else the first listed. The folder stays unset.
- **Run on** lists **Automatic** (*A free computer*) above the computers. Picking a computer or this iPhone turns Automatic off for this chat. Picking Automatic again asks again.
- Picking a local model in the model list asks again. Picking a folder, a cloud model or opening New chat from one computer's list leaves the chat where it is.

## How it works

- `activity:state` (nekkod, the B1 idle signals) is a phone **Read** channel (`PHONE_ACTIVITY_READ_CHANNELS`). The computer projects it to `PHONE_ACTIVITY_VIEW`: `userActive`, `chatActive`, `headless` and `strain` (on battery, low, hot). Never `idleSeconds`, `power`, `cpuC` or `gpuC`. The phone's arguments are dropped, so the computer's own idle threshold (`automationIdleMinutes`) applies. Read off refuses it like every read.
- `ComputersStore.pickMachine(lastUsed:)` (NekkoKit `MachinePick.swift`) asks every online computer `activity:state` and `providers:list` in parallel (4 s each), over the active connection or the computer's fleet link, and counts the chats replying there from the fleet's event streams.
- `MachinePicker.pick` ranks the online computers with an enabled model server (Ollama, LM Studio, llama.cpp, vLLM): nobody using it, then didn't say (an older computer, or the read failed), then someone at it, then a chat replying. Ties go to the computer used last, then to one not on battery or hot, then to pairing order. If the best is busy, the one used last.
- `ComputersStore.localModel(on:prefer:)` reads the target's providers and models over its link before it becomes active. Provider IDs belong to each computer: the selected model is matched across the target's enabled local providers before falling back to its last or loaded model. Then New chat makes it active (the link is handed over, no new connection).
- Starting is disabled while Automatic probes. Superseded or cancelled probes cannot switch the computer, and an earlier probe cannot clear a newer probe's loading state. A server with no installed model keeps the current computer with the unavailable explanation, not the all-busy explanation.

## Privacy and security

- The computer tells the phone only yes/no answers about its use. It never sends how long it has been idle, its battery level or its temperatures.
- Nothing leaves the end-to-end encrypted links the phone already holds; Nekko Cloud and the relay see no more than before.

## Acceptance

- Two computers paired and online, both with a model server; computer A has a chat replying, B is idle. New chat from the all-computers list with a local model picked on A: the chat moves to B with B's model, and the line says *Auto picked B: A is busy.* (`MachinePickTests.testThePhoneAsksEveryComputerAndPicksTheFreeOne` covers the store side.)
- Both busy: the chat stays on the one used last, and the line says so.
- B offline: B isn't asked or picked.
- A folder chosen, a cloud model, or New chat from A's own list: no Auto, no line.
- The phone's view of `activity:state` holds only the four fields, and the phone can't change the threshold (`nekko-remote` `says_whether_the_computer_is_in_use_and_nothing_more`).

## Not verified yet

- Actual visual inspection of the matched simulator screenshots and timing video; capture artifacts exist in [run 42025582777](https://github.com/nekko-labs/nekko-agent/actions/runs/42025582777), but local screenshot-inspection tools failed. Full native-suite completion is pending; the focused simulator tests passed.
- Two real computers end to end.
