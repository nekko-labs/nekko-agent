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

Planned: Library files (documents, pages, designs, diagrams, data, images) become records in a sealed `library` sync collection, with the same keys, epochs and revision rules as chats. A file made on one computer appears in Library on the others, saying which computer it came from. Not started on the computer side; the service side (history below) is in place.

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
- Not done: the app side (Share in Library, the versions and recently deleted lists, syncing Library files in the engine), the link page on nekkoagent.com, the multiplayer relay and editor, docs pages. Not deployed.
