# 0100. Shared Library files are sealed with a key in the link

Date: 2026-11-14. Status: accepted. Issues: #2749, #2750, #2752.

## Context

Philip asked for Library files to sync, be shared with others and hosted on Nekko Cloud, keep versions and come back for 30 days after a delete, all on a paid plan. Sync already promises that Nekko Labs cannot read a person's data ([SYNC-ENCRYPTION](../SYNC-ENCRYPTION.md), [0005](0005-supabase-for-identity-only.md)). A shared file has to be readable by people with no Nekko account and no sync keys.

## Decision

- **Synced Library files are sync records.** They use the existing sealed sync (a `library` collection): the same keys, epochs, revisions and rollback checks as chats. The service keeps a Library record's replaced revisions for 30 days (`sync_object_history`); a delete is a sealed tombstone revision like any other, so "recover" means going back to the revision before it. Restoring re-seals the old content as a new revision on a device.
- **A shared file is sealed with its own key, and the key lives in the link's `#fragment`.** Browsers never send the fragment to a server, so Nekko Cloud stores and serves only ciphertext (`library_shares`), and the page that opens a link decrypts in the visitor's browser. An edit link carries a second secret; the service keeps only its SHA-256.
- **Versions and deletes:** a share keeps each replaced version for 30 days; deleting a share stops the link at once and keeps it restorable for 30 days; "delete for good" removes it now. A job purges everything past 30 days and frees its storage.
- **Behind switches, and paid for by storage:** `library-cloud` (off by default; team first) gates writing. Writing needs Pro or Team, and shares, their versions and kept revisions all count toward the plan's storage. Reading, deleting and restoring a deleted share never depend on the plan or the switch. `library-multiplayer` is a separate switch, and the service reports it unavailable until it runs the relay.

## Alternatives not taken

- **Host shared files readable by the service.** Simpler viewer, server-side previews and search, but it breaks the promise that Nekko Labs can't read what people sync, for exactly the files they chose to send to others.
- **Share by giving another account sync access.** Needs every viewer to have an account and device keys; a link is what people expect.
- **Keep versions forever.** Unbounded storage on a fixed plan; 30 days matches the delete window and what similar services offer on their base plans.

## Consequences

- Losing a link loses access to the shared copy; Nekko Labs can't recover it. The owner can share again from the file.
- Anyone who has the link can read the file, and anyone with an edit link can change it, until the owner stops sharing. The owner sees and controls each share from the app.
- Previews of shared files (link unfurls, thumbnails) can't be made by the service.
