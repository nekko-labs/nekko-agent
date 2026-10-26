# Keep completed chats until explicit deletion

## Decision

Completed chats remain on disk indefinitely unless the user explicitly clears or deletes them. Completion is reversible organization, not a delayed delete. The former 60-day expiry is removed for existing and future completed chats; already-deleted data is not restored.

## Why

Users expect completed rows to remain accessible. Silent time-based deletion makes completion unsafe as a way to tidy active work. Storage growth should be visible and user-controlled instead.

## Consequences

Local chat history can grow. Settings warns at 1 GB and offers confirmed time-range cleanup. The measurement excludes models, caches and unrelated files. Nekko Cloud sync is a separate opt-in capability, not automatic local offloading. No background process silently deletes completed conversations. The legacy purge channel remains a no-op for older clients.

See [the feature specification](../../spec/chat/completed-history-retention-and-storage.md) and [#1156](https://github.com/nekko-labs/nekko-agent/issues/1156).
