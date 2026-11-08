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
  - first-run setup is closed, so the intro never stacks on the wizard. (Until 2026-11-08 it waited for the zones intro instead; that one now opens only when someone picks Multi-agent.)
- **What it shows.** A modal titled **Send your first prompt** in the ZonesIntro layout: three short looping demos, each with a heading and one or two sentences underneath (the words are in the modal, not the video), step dots, **Back**, **Next**, and **Get started** on the last step.
  1. **Start with a question**: Nekko peeks over the composer; the "Summarize this PDF" starter is tapped and typed in. Body: type anything, or pick a starter.
  2. **Add your files**: "Q3 report.pdf" is dragged in and lands as an attachment pill; Nekko's eyes follow it. Body: drag files in, or use **+** or **@**.
  3. **Send, and Nekko gets to work**: Send glows and is pressed, Nekko thinks, a reply appears, she cheers. Body: Nekko asks before running a command or changing anything on the computer.
- **Easily skipped.** **Skip** sits beside Next on every step before the last; the ✕, Escape and a click on the backdrop also close it. Closing it any way sets `firstPromptIntroSeen` and it never opens again. If saving the setting fails it simply shows again next time.
- **The demos** are drawn, not recorded: a simplified copy of the new-chat screen with the real labels (the greeting, the composer placeholder, +, Suggestions, the microphone, the Nekko Send button, the attachment pill), painted with the app's colour variables so they follow the theme. Nekko is the app's own pixel art, never rotated. Anything not being taught (the reply's text) is faint lines. Reduced motion shows one still frame per step.
- **Planned elements in the demo.** The starter chips in step 1 are planned (issue #614) and not in the app yet.

## iPhone and iPad

`[Implemented 2026-11-08; the rule and the bundled videos are unit-tested; a UI test walks Next, Back and Get started in light and dark on an iPhone 17 Pro simulator; not yet seen opening on its own on a real first pairing, or on a device]`

- **Same three steps, drawn for the phone.** The desktop's demos show desktop-only things (dragging files in, + and @ for files, starters, Enter), so the iPhone has its own: the iPhone's new-chat screen (the peeking Nekko, "What should we work on?", the glass box with +, the mic and Start, and its Automatic, Medium, No folder and Ask when it matters chips), with a fingertip where the desktop has a pointer.
  1. **Start with a question**: the box is tapped and "Summarize the sales notes" is typed. Body: type what you want done, or tap the mic and say it.
  2. **Add photos and a folder**: + opens Photos / Paste image, a photo lands in the box, then No folder is tapped and **Sales** picked. Body: + adds photos or a pasted image; a folder sets where Nekko works on the computer.
  3. **Tap Start, and Nekko gets to work**: Start glows and is tapped, the message rises, Nekko thinks, a reply appears and she cheers. Body: Nekko asks before running a command or changing anything.
- **When it opens.** Once, as a sheet over New chat, when it has not been seen, the chat is for a computer (a chat that runs on the iPhone has no photos or folders), the computer's chat list has been read, and no chat (on any paired computer or on the iPhone) has an exchange. A chat whose count the computer does not send counts as used, so people who already chatted never see it. There is no "tips off" setting on the phone to respect.
- **Closing.** **Skip** (top left, every step but the last), **Get started**, or swiping the sheet down; any of them sets `firstPromptIntroSeen` on the iPhone.
- **The videos** are MP4s in the app (`first-prompt-<step>-<light|dark>.mp4`, about 520 KB together), drawn in Remotion (`apps/desktop/scripts/first-prompt-intro-render/`) and rendered by `node apps/desktop/scripts/render-first-prompt-intro.mjs`, so the demos must be re-rendered and committed when they change. They are muted, loop, have no controls and are hidden from VoiceOver (the words under them say the same). With Reduce Motion each holds one still frame.
- **Android** has no intro yet ([#2234](https://github.com/nekko-labs/nekko-agent/issues/2234)).

## Boundaries

- Renderer only: one new optional setting, `firstPromptIntroSeen`, stored as is (no default, no migration). No new host actions, permissions or network access; the demos fetch nothing and play silently.
- The intro and Remotion load only when it opens (a lazy import from ChatPane).

## Not covered

- A way to replay it later (for example from a Help menu) is not built.
- People who already chatted before this shipped never see it, by design.
