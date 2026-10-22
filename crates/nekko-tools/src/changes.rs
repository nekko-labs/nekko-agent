//! Pending changes, ported from `packages/host/src/changes.ts`.
//!
//! The first time a chat's agent writes or edits a file, the file's content
//! is snapshotted; the review panel diffs what is on disk now against that
//! snapshot. Writes still land immediately (the agent loop is never held up),
//! accepting a file just stops tracking it, and reverting is the renderer
//! writing the snapshot back. In memory only, like the TS store.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// `FileChange` from `@nekko-agent/shared`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    /// Content before the agent's first edit this session ('' if it was new).
    pub original: String,
    /// Content on disk now.
    pub current: String,
}

struct Record {
    path: String,
    original: String,
}

type Notifier = Arc<dyn Fn(&str) + Send + Sync>;

/// Every session's snapshots. One per engine; cheap to share behind an `Arc`.
#[derive(Default)]
pub struct ChangeTracker {
    /// Per session, in first-touch order (a JS `Map`'s order), which decides
    /// ties in the sorted listing.
    sessions: Mutex<HashMap<String, Vec<Record>>>,
    notify: Mutex<Option<Notifier>>,
}

/// `readFileSync(path, 'utf8')`, or '' if that throws.
fn safe_read(path: &str) -> String {
    crate::nodefs::read_utf8(path).unwrap_or_default()
}

fn current(path: &str) -> String {
    if crate::nodefs::exists(path) { safe_read(path) } else { String::new() }
}

impl ChangeTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Called with the session id whenever a session's set changes
    /// (`setChangeNotifier`).
    pub fn set_notifier(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        *self.notify.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(f));
    }

    fn notify(&self, session_id: &str) {
        let f = self.notify.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(f) = f {
            f(session_id);
        }
    }

    /// Snapshot `path` the first time this session touches it (`recordOriginal`).
    pub fn record_original(&self, session_id: &str, path: &str) {
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let records = sessions.entry(session_id.to_string()).or_default();
            if records.iter().any(|r| r.path == path) {
                return;
            }
            records.push(Record { path: path.to_string(), original: current(path) });
        }
        self.notify(session_id);
    }

    /// Files that differ from their snapshot, sorted by path (`listChanges`).
    pub fn list_changes(&self, session_id: &str) -> Vec<FileChange> {
        let tracked: Vec<(String, String)> = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let Some(records) = sessions.get(session_id) else { return Vec::new() };
            records.iter().map(|r| (r.path.clone(), r.original.clone())).collect()
        };
        let mut out: Vec<FileChange> = tracked
            .into_iter()
            .filter_map(|(path, original)| {
                let current = current(&path);
                (current != original).then_some(FileChange { path, original, current })
            })
            .collect();
        // Stable, as Array.prototype.sort is.
        out.sort_by(|a, b| nekko_js::locale_compare(&a.path, &b.path));
        out
    }

    /// Keep a file's changes and stop tracking it (`acceptChange`).
    pub fn accept_change(&self, session_id: &str, path: &str) {
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(records) = sessions.get_mut(session_id) {
                records.retain(|r| r.path != path);
            }
        }
        self.notify(session_id);
    }

    /// Keep all of a session's changes (`acceptAllChanges`).
    pub fn accept_all(&self, session_id: &str) {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        self.notify(session_id);
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn sorts_like_locale_compare() {
        // ICU root order: case is a tertiary difference, punctuation sorts
        // before letters, and "_" before "-" (byte order would say otherwise).
        let mut v = vec!["b.txt", "B.txt", "a_b", "a-b", "a.b", "ab", "é", "e", "f"];
        v.sort_by(|a, b| nekko_js::locale_compare(a, b));
        assert_eq!(v, vec!["a_b", "a-b", "a.b", "ab", "b.txt", "B.txt", "e", "é", "f"]);
    }
}
