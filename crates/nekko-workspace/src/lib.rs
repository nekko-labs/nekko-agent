//! The user's projects, for the engine daemon (PF14): the file explorer
//! ([`files`]), memory notes ([`memory`]), line comments ([`comments`]) and
//! the workspace index with its outline and search ([`index`],
//! [`outline`]), and the git and pull-request state the sidebar and the PR
//! card show ([`git`], [`pr`]).
//!
//! Ported from the TS host's `files.ts`, `memory.ts`, `comments.ts`,
//! `workspace.ts` and core's indexer, with JavaScript's rules where they
//! show in the result (`localeCompare` order, UTF-16 lengths, `String()`
//! of a missing value, `JSON.stringify(x, null, 2)` layout). Held to the TS
//! functions by a frozen golden set (`tests/golden`).

pub mod comments;
pub mod design;
pub mod files;
pub mod git;
pub mod gitops;
pub mod index;
pub mod integrations;
pub mod memory;
pub mod outline;
pub mod pr;
pub mod proc;
pub mod scoped;
pub mod skills;
pub mod spec;
pub mod stacks;

use std::path::Path;

/// Bumped by every finished read a cache keeps, so a caller that waited
/// behind a read can tell it finished after the caller asked.
static READS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The current read count, taken when a call starts.
pub(crate) fn read_seq() -> u64 {
    READS.load(std::sync::atomic::Ordering::SeqCst)
}

/// A new read finished: its number, greater than any count taken before.
pub(crate) fn next_read() -> u64 {
    READS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

pub(crate) use nekko_js::now_ms;

/// Write to a temp name beside the file and rename it over, so a reader
/// never sees half a file.
pub(crate) fn write_atomic(file: &Path, bytes: &[u8]) -> Result<(), String> {
    nekko_js::fs::atomic_write(file, bytes, Default::default()).map_err(|e| e.to_string())
}
