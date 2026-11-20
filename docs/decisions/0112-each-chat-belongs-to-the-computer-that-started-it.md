# 0112. Each chat belongs to the computer that started it

Date: 2026-11-21. Status: accepted. Issue: #3143. Builds on [0108](0108-each-computer-syncs-its-own-library-files.md).

## Context

Chat sync merged every computer's chats into one list: one record per chat, newest `updatedAt` wins, and any computer could carry any chat on. Philip asked for chats that are "unique per device", with every device still seeing "the combined chats", and the computer each came from named on its card and usable as a grouping. A chat also depends on its computer: its working folder, worktrees, terminals, Claude Code sessions and local models live there.

## Decision

- **A chat belongs to the computer it started on.** Its sealed record carries `home { deviceId, device }`. On that computer the chat file names no home; a copy on another computer keeps it, which is how the app and the engine know it is someone else's.
- **Only the home computer changes a chat in Nekko Cloud.** Another computer never pushes its copy or a tombstone for it, and refuses a turn in it (`chat:send` answers *This chat belongs to Laptop*). To carry on there, the person forks it (*Continue here*) into a chat of that computer.
- **How a copy is arranged is the computer's own.** Pinned, order and archived stay as set on the computer holding the copy when a newer copy arrives. Removing a copy forgets it on that computer only, and a newer copy is not taken again.
- **One exception to "only the home writes": a key rotation.** When a computer is removed, the computers left re-seal every chat under the new epoch. Each re-seals its own chats, and pushes its copies of other computers' chats as they are, still naming their home, so a removed computer's chats stay readable to the others. Revisions keep two re-seals of one chat from clobbering each other.
- **Records from before this change carry no home.** Each computer pushes its chats once more with its home. A chat held by two computers is claimed by the first to sync after updating; the other adopts that claim when its copy is not newer, and claims it itself when it has carried the chat on since.

## Alternatives not taken

- **Keep one merged chat, editable everywhere.** Two computers running the same chat race, a turn's tools and folders exist on only one of them, and newest-wins silently drops the other computer's turn.
- **A chat moves to whichever computer last replied.** The card's computer would change under the person, and the working folder would not follow.
- **Show other computers' chats only while that computer is connected (federation).** A closed laptop's chats would vanish, and syncing exists so they don't.
- **Guess the home of a chat synced before this change from its paths.** Unreliable (a Mac and a PC can share folder names); the first-claim rule is stable and conflict-free.

## Consequences

- A chat started on a laptop is read-only on the desk computer: replying there makes a new chat.
- A chat that also arrives live from a connected computer is listed once, as the live one.
- A shared chat from before this change may be labelled with the computer that synced first, not the one that started it.
