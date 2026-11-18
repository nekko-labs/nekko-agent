---
title: First-visit guides for Skills, Design, Connectors and Memory
area: desktop
---

# First-visit guides for Skills, Design, Connectors and Memory (2026-11-14)

Issues: [#1273](https://github.com/nekko-labs/nekko-agent/issues/1273) (Skills), [#1274](https://github.com/nekko-labs/nekko-agent/issues/1274) (Design), [#1275](https://github.com/nekko-labs/nekko-agent/issues/1275) (Connectors), [#1276](https://github.com/nekko-labs/nekko-agent/issues/1276) (Memory). Part of [#614](https://github.com/nekko-labs/nekko-agent/issues/614).

## Intent

These pages assumed the person already knew what a skill, a design board, a connector or a memory note is. Someone new to Nekko, in Simple mode especially, had no way to learn. Each page gets a short guide the first time it opens, in the same shape as the [Library guide](library-and-first-visit-guide.md).

## Behavior (implemented, not yet released)

- **First visit.** Opening Skills, Design, Connectors or Memory for the first time shows that page's guide, in Simple and Expert mode alike. The Design guide also shows before a project folder has been added.
- **What a guide says.** A one-line lead, three numbered steps and one thing to try, in plain words with no developer terms:
  - **Skills:** a skill is saved know-how the agent picks up when a request matches it; open one and press **Use in chat**; add more from the Marketplace, and skills from other apps on the computer appear on their own.
  - **Design:** draw with **Sketch** or describe with **Generate**; the design lands on the board as a card and as a file in the project; open a card to change it, with earlier versions kept.
  - **Connectors:** connect an app with its sign-in details, which stay on this computer; ask a chat about what is in it; messaging channels reach an agent from an app like Telegram, from allowed chats only.
  - **Memory:** global notes are read by every chat, workspace notes only by chats in that workspace; agents save what they learn about you and show a card; open a note to change or delete it, press **+** to add one; private chats read none.
- **Dismiss and reopen.** The main button, the close control, Escape and the scrim close it. Closing is saved per page in this profile's local storage, so the guide does not return on a later visit or a reload. A **<Page> guide** button on each page opens it again. If storage is blocked the guide still closes but shows again next time.
- **One component.** All five guides, Library included, render from one `PageIntro` with per-page content. Library's text, artwork and storage key (`nekko.libraryIntroSeen`) are unchanged; the new pages use `nekko.<page>IntroSeen`.

## Privacy and boundaries

A guide reads nothing and loads nothing from the network. Dismissal saves one flag per page. The guides' close buttons have labels built per page, so click reports do not carry them (see `scripts/click-labels.mjs`).

## Not done

- **Phones.** Only the iPhone has one of these pages (Connectors); its guide is still to do under #1275. Android has none of the four pages.
- No artwork for the four new guides; Library keeps its own.

## Verification

`PageIntro.test.tsx` (per-page storage, blocked storage, three steps, the try line, close and reopen copy, and no developer terms in any guide) and the unchanged `LibraryIntro.test.tsx`. Hidden, isolated Electron captures of each guide in dark and light are in the implementing PR. Not checked in a packaged build.
