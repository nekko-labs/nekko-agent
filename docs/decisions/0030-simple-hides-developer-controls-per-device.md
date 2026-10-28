---
status: accepted
date: 2026-10-28
---

# 0030. Simple hides developer controls, chosen per control and kept per device

## Context

Simple and Expert shipped on the phones (2026-10-24) and the desktop (2026-10-25) as a switch where Expert only added the hardware strip and the loaded-models monitor; Simple hid nothing, and effort and the context gauge showed in both modes on purpose. Philip asked (2026-10-27) for Simple to become the experience for people who are not developers: the same capabilities, with controls such as effort, the context gauge and reasoning out of sight, and a Settings page to choose which controls Simple shows. He reviewed a design and answered its open questions (2026-10-28).

## Options considered

1. **Two fixed modes.** Simple hides a list chosen by us. Simple, but anyone who wants one control back (the effort dial, say) has to live in Expert.
2. **A switch per control, on or off in Simple.** What the first design drew. It cannot express "never show this", which Philip asked for once he saw it.
3. **Three states per control: Show (both modes), Expert only, Hide (neither).** Defaults put every developer control at Expert only, and only the model picker and prompt suggestions at Show.

On scope: hide whole pages in Simple (Training, CI runners, the Model Server's engine view), or only controls inside pages. On storage: per device, or synced through the account.

## Decision

Option 3, controls only, per device:

- A catalogue in `packages/shared/src/simple-mode.ts` lists every control Simple can hide, with its area, platforms and default. The iPhone and Android apps keep copies with the same ids.
- Simple never hides a page. Sections inside a page fold instead: Settings shows one "Show advanced settings" row in place of the Tools group.
- The mode and the choices are saved on each device and never synced. A new install starts in Simple.
- On the desktop the switch moves to the title bar, because it changes the whole app.

## Consequences

- The 2026-10-24/25 specs that kept effort and the context gauge in both modes are superseded: both default to Expert only.
- A control hidden in Simple is still reachable by switching to Expert, or by choosing Show for it. Hidden controls are not listed by search: Settings search only reads what is on screen.
- Every new developer control needs a catalogue entry (and the phone copies) or it shows in Simple. If the list keeps growing with every feature, that is the sign a coarser grouping is needed.
- The desktop's Ctrl+Shift+E was considered for the switch and dropped: it already completes a chat.
