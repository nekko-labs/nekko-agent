---
title: Library on Nekko Cloud (sync, share, versions, multiplayer)
area: platform
status: in-progress
---

# Library on Nekko Cloud

Tracking: [#2752](https://github.com/nekko-labs/nekko-agent/issues/2752) with [#2748](https://github.com/nekko-labs/nekko-agent/issues/2748) (sync), [#2749](https://github.com/nekko-labs/nekko-agent/issues/2749) (share), [#2750](https://github.com/nekko-labs/nekko-agent/issues/2750) (versions and 30-day recovery), [#2751](https://github.com/nekko-labs/nekko-agent/issues/2751) (multiplayer). Decision: [0100](../../docs/decisions/0100-shared-library-files-are-sealed-with-a-key-in-the-link.md).

## Intent

Requested 2026-11-14: with Nekko Cloud on a paid plan, let people (1) sync Library content, (2) share it with others, hosted on Nekko Cloud, (3) keep versions and recover deletes for 30 days, and (4) work on a document together and see each other's cursors, behind a multiplayer mode that is off by default.

## The promise

- Nekko Labs can't read a synced or shared Library file. Synced files are sealed with the account's sync keys, like chats. A shared file is sealed with a key that exists only in its link, after the `#`, which browsers never send to a server.
- Everything is off until switched on: `library-cloud` covers sync, sharing and versions; `library-multiplayer` covers editing together. Both start off and are turned on by the team first ([plans and billing](plans-and-billing.md#the-switch)).
- Writing needs Pro or Team, and everything stored (synced files, kept revisions, shared files and their versions) counts toward the plan's storage (Pro 5 GB, Team 20 GB). Reading, deleting and restoring a deleted share never depend on the plan or the switch.

## Sync (#2748)

Requested again 2026-11-19: "let's enable syncing the library content to nekko cloud. (we need status indicators for syncing state, and backed up state should have a small cloud connected or disconnected icon on the top right."

Implemented, not yet released (behind `library-cloud`, which is off):

- **What syncs.** Every file Library lists on a computer (documents, pages, designs and each of their versions, diagrams, data, office files, images), up to 8 MB each, is a sealed record in the `library` sync collection, with the same keys, epochs and revision rules as chats. The app tells the engine which files Library lists (`library:sync`, paths, titles, kinds and the chat each came from); the engine reads, seals and uploads them with the chat sync (at once for a new or changed file, otherwise every minute), a request's worth at a time. A file saved again unchanged is noted, not uploaded. A file Library stops listing (a chat archived, a filter) stays synced; a file gone from disk is deleted from Nekko Cloud, which keeps its last revision for 30 days.
- **Other computers.** A file from another computer of the account appears in Library with "From <computer name>" where the chat title would be and a down-arrow cloud. It is a read-only copy in the engine's cloud folder, kept beside the other files from the same folder on that computer, so a design's versions still read as one design. It opens view-only (no Open chat), follows each change made there and leaves when it is deleted there.
- **Each file's cloud.** In the top-right corner of every tile's preview (all three preview layouts) and at the end of every row: a check in the success colour when it is backed up; an up arrow while it waits for the next sync or uploads; a slashed cloud when it isn't backed up (sync is off on this computer, larger than 8 MB, unreadable, or the plan's storage is full, the last in the warning colour). The tooltip and screen-reader label say which. A design's cloud speaks for all its versions.
- **The header** gives Library's state as a dot and a word beside the item count, with the detail on hover: Backing up N files, N files waiting to back up, Nekko Cloud storage full, N files not backed up, Backed up, or Not backed up (sync is off here; turn it on in Settings, Nekko Cloud).
- **No trace when it isn't open.** Without a plan that syncs and the switch on for the account, the status carries no `library` part, the app shows no cloud and tells the engine nothing, and the engine keeps no list.
- **Storage full** stops the Library upload for that pass without failing chat sync.

Verified: engine unit tests (record format, refused records, the 8 MB file fitting the 16 MiB cap once sealed, safe copy names, version folders); `crates/nekko-cloud/tests/library_live.rs` against the local service (two computers: the switch hides everything, files sync and a design's versions share a folder, a relative path and an over-8 MB file are refused, the server's copy has no names, paths, chats or contents, a change follows, an unchanged save uploads nothing, a delete removes the copy, Delete everything synced removes the copies); the existing `live`, `attacks`, `delete_account` and `step_up_stays_local` suites; renderer unit tests; and the hidden, isolated `library-sync` journey (17 checks, dark and light, all layouts, narrow). Not checked: two real computers, packaged builds, the Local Web UI in other browsers, files near 8 MB on a slow link, and the iPhone and Android apps, which don't list Library files yet. Files over 8 MB are not split into parts.

## Share (#2749)

Implemented in Nekko Cloud (not yet in the app or on the website):

- The app sends a file sealed with a fresh key; the service gives it a random 22-character id and serves the sealed bytes to anyone who asks for that id (`GET /v1/s/:id`, any site may read it). The link's page will decrypt it in the browser with the key from the link.
- The owner lists their shares (`GET /v1/shares`), changes one by revision (a stale write is told the current revision), and stops sharing (`DELETE`): the link answers "no longer shared" at once. A stopped share can be restored for 30 days; `?forever=1` deletes it now.
- An edit link carries a second secret; the service keeps only its SHA-256, and holding it lets someone change the file (paid for by the owner's plan) and see its versions, never delete it or restore it.
- Files up to 10 MB sealed.

## Versions and 30-day recovery (#2750)

Implemented in Nekko Cloud (not yet in the app):

- **Shares:** every change keeps the replaced version for 30 days. The owner (or an edit link) lists versions and opens one; the owner can go back to one, which becomes the newest version while the current one is kept.
- **Synced Library files:** each replaced revision of a `library` record is kept for 30 days (`GET /v1/sync/history/library/:objectId`, and each revision's sealed bytes). A delete is a sealed tombstone revision, so a deleted file comes back by restoring the revision before it, which a device re-seals as a new revision. Chats keep no history.
- A purge every six hours removes revisions and versions replaced more than 30 days ago and shares stopped more than 30 days ago, and frees their storage. "Delete everything synced" also removes kept revisions; deleting the account removes shares too.

## Multiplayer (#2751)

Planned, behind `library-multiplayer` (off). The switch exists in Nekko Cloud; the service reports the feature unavailable, whatever the switch says, until it runs the relay: a room per shared document over WebSocket that relays only sealed edits and cursor positions, edits merging as a CRDT, each person's caret and selection shown with their name and colour.

## Privacy and security

- The service stores ciphertext, sizes, revisions and times. It never receives a share's key or an edit link's secret in a form it keeps (the secret is checked against its SHA-256 when presented).
- Share ids are 128-bit random. Anyone holding a link can read the file until the owner stops sharing; anyone holding an edit link can change it.
- Public reads carry no cookies or account, are not cached, and are rate-limited with the sync routes.

## Status

- Implemented and tested against PGlite (`apps/nekko-agent-api`, `src/shares.ts`, migration `0017`, `shares.test.ts`): both switches, share create, read, list, change, stop, restore, delete for good, versions and going back, edit links, storage limits, Library revision history, the 30-day purge.
- Syncing Library files (#2748): implemented in the engine and the desktop app, see Sync above.
- Not done: the rest of the app side (Share in Library, the versions and recently deleted lists), the link page on nekkoagent.com, the multiplayer relay and editor, a docs page beyond [Encrypted sync](../../docs/SYNC-ENCRYPTION.md). Not deployed.
