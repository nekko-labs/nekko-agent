---
title: "Send your first prompt: the first-chat intro"
area: chat
---

# Send your first prompt: the first-chat intro

`[Implemented 2026-11-05; the gate is unit-tested; checked in a hidden, off-screen Electron fixture of the full App (opens on its own, Skip and Get started close it and save the setting, it stays closed); not yet tried in the packaged app, the Local Web UI, or with a real first launch through setup]`

Issue #1635 proposed never auto-playing it (a "See how it works" link instead); the decision here is to open it once on the first chat, kept easy to skip.

## Intent

Someone opening their very first chat gets a short, skippable explanation of how to send a prompt, without having to read docs. People who have used the app before never see it.

## Behaviour

- **When it opens.** Once, over the new-chat screen ("What should we work on?"), when all of these hold:
  - the clean start is showing (Focused, full surface, a provider set up, no question or approval pending);
  - the chat list has loaded and no chat has an exchange yet, so it is the person's first ever chat;
  - `firstPromptIntroSeen` is not set;
  - contextual tips are on (`showTips` is not `false`);
  - the zones intro, which opens on the first visit to the Agents board, has been closed (or the board is not in zones), so a new user gets the two intros one after the other, never stacked.
- **What it shows.** A modal titled **Send your first prompt** in the ZonesIntro layout: three short looping demos, each with a heading and one or two sentences underneath (the words are in the modal, not the video), step dots, **Back**, **Next**, and **Get started** on the last step.
  1. **Start with a question**: Nekko peeks over the composer; the "Summarize this PDF" starter is tapped and typed in. Body: type anything, or pick a starter.
  2. **Add your files**: "Q3 report.pdf" is dragged in and lands as an attachment pill; Nekko's eyes follow it. Body: drag files in, or use **+** or **@**.
  3. **Send, and Nekko gets to work**: Send glows and is pressed, Nekko thinks, a reply appears, she cheers. Body: Nekko asks before running a command or changing anything on the computer.
- **Easily skipped.** **Skip** sits beside Next on every step before the last; the ✕, Escape and a click on the backdrop also close it. Closing it any way sets `firstPromptIntroSeen` and it never opens again. If saving the setting fails it simply shows again next time.
- **The demos** are drawn, not recorded: a simplified copy of the new-chat screen with the real labels (the greeting, the composer placeholder, +, Suggestions, the microphone, the Nekko Send button, the attachment pill), painted with the app's colour variables so they follow the theme. Nekko is the app's own pixel art, never rotated. Anything not being taught (the reply's text) is faint lines. Reduced motion shows one still frame per step.
- **Planned elements in the demo.** The starter chips in step 1 are planned (issue #614) and not in the app yet.

## Boundaries

- Renderer only: one new optional setting, `firstPromptIntroSeen`, stored as is (no default, no migration). No new host actions, permissions or network access; the demos fetch nothing and play silently.
- The intro and Remotion load only when it opens (a lazy import from ChatPane).

## Not covered

- A way to replay it later (for example from a Help menu) is not built.
- People who already chatted before this shipped never see it, by design.
