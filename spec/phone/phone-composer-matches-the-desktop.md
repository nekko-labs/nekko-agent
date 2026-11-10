---
title: "Phone composer matches the desktop's (2026-11-10)"
area: phone
---

# Phone composer matches the desktop's (2026-11-10, [#2448](https://github.com/nekko-labs/nekko-agent/issues/2448))

**Status `[implemented 2026-11-10; Android compiled, JVM tests green and checked on an API 37 emulator; iPhone views build and are captured on macOS CI only (this work was done on Windows); not yet on a physical phone]`.**

Philip asked (2026-11-10), for the phone composer on iOS and Android:

- the chat / image toggle shows only its icons, sits in the top right of the composer, and matches the active theme;
- the composer's add button is a plus icon;
- the composer's bottom row matches the desktop composer: the same buttons and dropdowns, in the same order and positions, with the same icons.

The desktop composer (`ChatPane.tsx`, the `composer-bar` row and the details row under it) is the reference.

## The desktop row the phones follow

Under the text, left to right: **+** (Photo / Video, File, Folder, Repository, Automate, Skill), the **folder picker**, and in Simple the **asks-first** control as just its icon; then, at the right, the **mic** and **Send**. Under that row: the **model and effort**, the asks-first control with its name in Expert, and the **context** ring at the far right.

## What each phone does

| Place | iPhone | Android |
| --- | --- | --- |
| + | The desktop's plain plus (`composer-plus`), soft ink, no filled circle | Same artwork (`composer_plus`), soft ink, accent while its menu is open |
| Folder after + | The chat's folder with the desktop's folder icon (Gentleface folder-open). A phone can't change a chat's folder (`session:setOptions` has no `workspaceId` for phones), so its menu opens the chat's **Files**. Hidden when the chat has no folder. In New chat it is the folder picker it already was, moved here from the options row | Same, in the chat composer (`ComposerFolderChip`) |
| Asks first, Simple | Its icon only, after the folder (`AsksFirstMenu(iconOnly:)`, `ToolPolicyPicker(iconOnly:)`), same popover and YOLO warning | Its icon only, after the folder (`ComposerAsksIcon`), opening the same sheet |
| Asks first, Expert | Named, beside the model in the row below (it was only under More before) | Same (`ChatOptionsRow`) |
| Mic | The desktop's mic artwork (`composer-mic`), still the hands-free voice conversation | Moved out of the + menu to beside Send, the same artwork; still the voice conversation, shown when dictation is on |
| Send / Stop | Unchanged: the phone's accent circle | Unchanged |
| Model, effort, context | Unchanged, the box's last row | Unchanged |
| Chat / Image (New chat) | Two icons (the desktop's chat bubble and photo) in a pill at the box's top right; the one on is in the accent on a raised surface pill that slides over 200 ms (none with Reduce Motion). Replaces the full-width segmented control | The same two icons and pill, at the top right above New chat's form, replacing the Chat / Image chips |

Icons are the desktop's own line icons from `icons.tsx` and `DictationButton.tsx` (ours) and Gentleface folder-open (MIT, already credited in ASSETS.md), shipped as template images (`Assets.xcassets/ComposerIcons`) and vector drawables (`res/drawable/composer_*.xml`), tinted only with theme tokens (soft ink at rest, accent when on).

## Adapted, not copied

- Phones keep Send as their own accent circle rather than the desktop's Nekko avatar.
- Android keeps the *Aa* formatting toggle in the row, after asks-first; where the formatting toolbar lives is #2450's.
- Android's New chat is still a form with no message box, so only the toggle changed there; the composer for it is [#2459](https://github.com/nekko-labs/nekko-agent/issues/2459) (gap row in [iOS and Android stay in step](ios-and-android-stay-in-step.md)).
- Image chats keep their own composer: no folder or asks-first, as on the desktop.
- The phone-only chat (a chat on this iPhone) has no folder or tools, so only its mic artwork changed.

## Acceptance

- New chat on both phones: the toggle is two icons at the top right, themed, and switches between chat and image as before (`newChat.kind.chat`, `newChat.kind.image`).
- The + is a plain plus on both phones (`composer.add` / *Add*).
- A chat with a folder shows it after +, and its menu opens Files; Simple shows the asks-first icon next; mic and Send sit at the right.
- Expert shows asks-first by name beside the model.
- Verified: Android compile, JVM tests and emulator screenshots; iPhone build, UI tests and screenshots on macOS CI. Not verified on a physical phone.
