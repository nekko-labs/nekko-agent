---
title: "iPhone New chat: model on device, the connect checklist, limits and picker detail (2026-11-17)"
area: phone
---

# iPhone New chat: model on device, the connect checklist, limits and picker detail (2026-11-17)

Design: [nekko-designs/iphone-new-chat-design.html](../../nekko-designs/iphone-new-chat-design.html). Issues: [#2921](https://github.com/nekko-labs/nekko-agent/issues/2921), [#2922](https://github.com/nekko-labs/nekko-agent/issues/2922), [#2923](https://github.com/nekko-labs/nekko-agent/issues/2923), [#2925](https://github.com/nekko-labs/nekko-agent/issues/2925). Android: [#2950](https://github.com/nekko-labs/nekko-agent/issues/2950).

**User intent:** Philip (2026-11-17), on a New chat that runs on This iPhone: remove the "Runs on This iPhone with your own key. No tools: it can't see your computers or files." line. When there are no tools, folders or git provider, tell the user they may want to add them, in a note they can close; on their first message make it a tutorial with a checklist of things to connect. Put the device and the model on one line with a small connector. Usage limits should always show when they're known. Show each model's size in the model picker, with the usage limits.

## Model on device (#2922)

`[implemented 2026-11-17 on iPhone; not yet run on a simulator or device]`

- New chat's model and the place it runs share one line: **model ⟶ device**, joined by a small faint dot and arrow. Each half opens its own picker (the model picker, and Run on with Automatic, the computers and This iPhone). Effort's gauge and word follow the device, then Expert's tool policy.
- When the line is too long, it gives way in order: the provider name after the model goes first, then effort keeps only its gauge, then both names shorten in the middle, the device last.
- VoiceOver reads the halves in order: the model and provider, then "Runs on <device>". The connector is decorative.
- In Run on, This iPhone's subtitle is "Its own models".

## The connect checklist and note (#2921)

`[implemented 2026-11-17 on iPhone; rules unit-tested in NekkoProtocol on Linux; a simulator UI test is written (PhoneDirectCloudTests) and runs on macOS CI]`

- The "no tools" line under New chat's composer and the banner above an open phone chat's first message are gone. The open phone chat's title has one subtitle line: **model ⟶ This iPhone**.
- **Checklist.** Until someone has sent a first message, New chat shows "Nekko can do more with these" under the composer, led by the Nekko face, with a count ("1 of 4") and a close (×). Four rows, each a tap target that opens its setup:
  - **Pair a computer** ("Let Nekko use tools and your files"): opens pairing.
  - **Add a folder** ("A project for Nekko to work in"): opens the computer's folders; before a computer is paired it says "After you pair a computer" and opens pairing.
  - **Connect a git provider** ("GitHub, GitLab or Bitbucket") and **Connect a task tool** ("Linear, Jira, Floop and more"): open this phone's Connectors.
  A done row ticks and names what got connected (the computer, the first folder, the git provider, the task tool). The checklist goes away when all four are done.
- **Note.** After the first message, while no computer, folder or git provider is connected, one line: "Nekko can't use your files or tools yet. Connect", with a close. Connect opens the same rows in a sheet. A task tool alone doesn't count, as it gives Nekko no files or tools.
- **Closing.** The × hides the checklist and the note on this phone for good; "Checklist hidden. Undo" stays where it was for six seconds.
- **First message.** "Sent before" means any chat on a paired computer or this phone with an exchange (an older computer's chat with no count counts as used, as the first-prompt intro does). Once seen, it is remembered, so deleting every chat doesn't bring the checklist back. Until the chat list is read, neither shows, so someone who already chatted never sees the checklist flash.
- Both show on phone and computer chats, not on image chats. Saved on this device only (`firstMessageSent`, `connectChecklistClosed`); UI test runs start with them closed unless a test opts in.

## Not yet

- The limit line (#2923) and the model picker's size, context, folded snapshots and limits (#2925) land in the next layers of this stack.
- Screenshots from a simulator or device: the views were written on Windows and are compiled and tested by macOS CI.
