---
title: Library and its first-visit guide
area: desktop
---

# Library and its first-visit guide

## Intent

The rail destination formerly called Artifacts is **Library**. Someone opening it for the first time should understand what appears there without knowing the term artifact. This completes the introduction requested in issue #1272 and applies the Library name to the rail, page title, command palette and voice navigation.

## Implemented

- Library keeps the existing `artifacts` route, file index and preview behavior. Files are not moved or copied by this rename. Chat artifact cards, the Agent Monitor's Artifacts disclosure, and the separate Nekko Artifacts publishing server keep their existing names.
- The first visit opens an illustrated, static guide in both Simple and Detailed output modes. Three short explanations cover creating files in a chat, finding and previewing them, returning to the source chat, and keeping or sharing a file through its usual app. A sample request ends the guide with something to try.
- **Explore Library**, the close control, Escape and the scrim dismiss the guide. Dismissal is saved in this renderer profile's local storage; returning to Library or reloading does not reopen it. **Library guide** always reopens it. Clearing browser/app profile storage resets the first-visit state. If storage is blocked the guide still closes, but dismissal cannot survive remounting.
- On narrow shared-web/desktop windows the list uses the available width. Selecting a file switches to its preview, with **Back to Library** returning to the list. Wide windows retain the list and preview side by side.
- The existing index reads up to the 60 most recent eligible top-level chats. It is not a scan of every file on the computer or a backup. Deleted files can remain listed until their source chat changes.

## Privacy and boundaries

The guide uses original inline artwork and reads no files or external resources. Dismissal saves only a boolean in local storage. File previews retain their existing isolation and permission boundaries. Files remain in their original folders; nothing is published automatically. Hosted publishing remains separate planned work, not a Library action added here. The native phone apps do not have this page and are unchanged.

## Acceptance and verification

- First visit shows the guide, dismissal persists across leaving/re-entering and reload, and the page control reopens it.
- Modal keyboard dismissal, file opening, source-chat navigation, filtering and narrow-screen return behavior remain usable.
- Focused tests cover copy, storage failure/persistence, static artwork, voice navigation and the unchanged artifact index. The full-App isolated Electron journey records desktop/narrow screenshots in default dark and light themes and checks actual interactions.
- Visual and packaged-platform verification status is recorded in the implementing PR; code existence is not proof of shipped or verified behavior.
