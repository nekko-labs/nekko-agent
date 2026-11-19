# 0108. Each computer syncs its own Library files

Date: 2026-11-19. Status: accepted. Issues: #2748, #2752. Builds on [0100](0100-shared-library-files-are-sealed-with-a-key-in-the-link.md).

## Context

Library is worked out on each computer from its chats and project folders; the same file has no shared identity across computers. Philip asked for Library content to sync to Nekko Cloud with a visible backed-up or not-backed-up cloud on each file. The sealed `library` sync collection and its 30-day history were already in place on the service (0100).

## Decision

- **One record per file per computer.** The local id is the computer's device id and the file's path there. Two computers never write the same record, so there are no write conflicts to merge, and an opened record must hash back to the object id it came under, so the service can't swap one file for another.
- **Another computer's file is a read-only copy.** It is listed under "From <computer>", opens view-only and changes only where it was made. Copies sit in the engine's cloud folder, grouped by the folder they came from so a design's versions stay one design, and go with the sync keys.
- **Only a delete on disk removes a synced file.** Library's list changes for many reasons (a chat archived, a filter, a chat still loading); none of them deletes anything from Nekko Cloud. A file gone from disk sends a tombstone, and the service keeps the last revision for 30 days.
- **8 MB per file, one record.** Larger files are skipped and say so.
- **The app reports, the engine uploads.** The renderer tells the engine which files Library lists; the engine reads, seals and uploads them with the chat sync, so backup carries on with Library closed.

## Alternatives not taken

- **One record per file shared by every computer, merged by newest change.** Needs a cross-computer identity for files that live at different paths on each computer, and a merge rule for two edits; editing someone else's copy in place is what multiplayer (#2751) is for.
- **Delete from Nekko Cloud whatever Library stops listing.** A filter or an archived chat would quietly delete backups.
- **Split large files into parts now.** Library files are mostly pages, documents and images well under 8 MB; parts can come later without changing the record format for small files.
- **Let the renderer upload.** Backup would stop whenever Library is closed, and the renderer would need the sync keys.

## Consequences

- The same file on two computers is stored twice and listed twice (once local, once "From" the other computer).
- A file over 8 MB is not backed up until parts exist.
- Editing another computer's file needs a copy saved locally first.
