//! Pending native file-tool originals, not whole-workspace checkpoints.
//! Saved chats use private local sidecars, under the session lifecycle lock.
//! Incognito originals stay in memory and are discarded on privacy transitions.

use nekko_store::{ReviewScope, SessionStore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub original: String,
    pub current: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    path: String,
    original: String,
}
#[derive(Serialize, Deserialize)]
struct Saved {
    version: u32,
    records: Vec<Record>,
}
struct Tracked {
    persistent: bool,
    records: Vec<Record>,
}
type Notifier = Arc<dyn Fn(&str) + Send + Sync>;
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 512;

#[derive(Default)]
pub struct ChangeTracker {
    sessions: Mutex<HashMap<String, Arc<Mutex<Option<Tracked>>>>>,
    notify: Mutex<Option<Notifier>>,
    store: Option<Arc<SessionStore>>,
}

fn current(path: &str) -> String {
    crate::nodefs::read_utf8(path).unwrap_or_default()
}
fn remove(file: &Path) -> Result<(), String> {
    match std::fs::remove_file(file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not remove review snapshot: {e}")),
        _ => Ok(()),
    }
}
fn save(file: Option<&Path>, records: &[Record]) -> Result<(), String> {
    let Some(file) = file else { return Ok(()) };
    if records.is_empty() {
        return remove(file);
    }
    if records.len() > MAX_FILES {
        return Err("Review snapshot limit reached (512 files); review and accept changes before editing more.".into());
    }
    #[derive(Serialize)]
    struct Borrowed<'a> {
        version: u32,
        records: &'a [Record],
    }
    let bytes = serde_json::to_vec(&Borrowed { version: 1, records }).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err("Review snapshot limit reached (64 MiB); review and accept changes before editing more.".into());
    }
    nekko_js::fs::atomic_write(file, &bytes, nekko_js::fs::AtomicWrite::PRIVATE)
        .map_err(|e| format!("Could not save review snapshot; file was not edited: {e}"))
}

impl ChangeTracker {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn persistent(store: Arc<SessionStore>) -> Self {
        Self { store: Some(store), ..Self::default() }
    }

    fn with_scope<R>(
        &self,
        id: &str,
        f: impl FnOnce(ReviewScope, &mut Option<Tracked>) -> Result<R, String>,
    ) -> Result<R, String> {
        let run = |scope| {
            let slot =
                self.sessions.lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().clone();
            let mut session = slot.lock().unwrap_or_else(|e| e.into_inner());
            f(scope, &mut session)
        };
        match &self.store {
            Some(store) => store.with_review(id, run),
            None => run(ReviewScope::Incognito), // compatibility: memory-only tracker
        }
    }

    fn load<'a>(
        _id: &str,
        file: Option<&Path>,
        sessions: &'a mut Option<Tracked>,
    ) -> Result<&'a mut Vec<Record>, String> {
        let persistent = file.is_some();
        // Deletion/privacy changes remove the sidecar under this same lifecycle
        // lock. Never resurrect a discarded original from our memory cache.
        let discarded =
            file.is_some_and(|p| std::fs::metadata(p).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound));
        if discarded || sessions.as_ref().is_some_and(|s| s.persistent != persistent) {
            *sessions = None;
        }
        if sessions.is_none() {
            let records = if let Some(file) = file {
                match std::fs::metadata(file) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                    Err(e) => return Err(format!("Could not read review snapshot: {e}")),
                    Ok(meta) => {
                        if meta.len() > MAX_SNAPSHOT_BYTES {
                            return Err("Review snapshot exceeds the 64 MiB limit.".into());
                        }
                        let bytes = std::fs::read(file).map_err(|e| format!("Could not read review snapshot: {e}"))?;
                        let saved: Saved = serde_json::from_slice(&bytes)
                            .map_err(|e| format!("Could not read review snapshot; original preserved on disk: {e}"))?;
                        if saved.version != 1 || saved.records.len() > MAX_FILES {
                            return Err("Unsupported review snapshot format or file count.".into());
                        }
                        saved.records
                    }
                }
            } else {
                Vec::new()
            };
            *sessions = Some(Tracked { persistent, records });
        }
        Ok(&mut sessions.as_mut().expect("loaded").records)
    }

    pub fn set_notifier(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        *self.notify.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(f));
    }
    fn notify(&self, id: &str) {
        let f = self.notify.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(f) = f {
            f(id);
        }
    }

    pub fn record_original(&self, id: &str, path: &str) -> Result<(), String> {
        self.with_scope(id, |scope, sessions| {
            let file = match &scope {
                ReviewScope::Saved(p) => Some(p.as_path()),
                ReviewScope::Incognito => None,
                ReviewScope::Missing => {
                    *sessions = None;
                    return Err("Chat was deleted; file was not edited.".into());
                }
            };
            let records = Self::load(id, file, sessions)?;
            if records.iter().any(|r| r.path == path) {
                return Ok(());
            }
            let original = if file.is_some() {
                if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_SNAPSHOT_BYTES) {
                    return Err("Original exceeds the 64 MiB review snapshot limit; file was not edited.".into());
                }
                match std::fs::read(path) {
                    Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                    Err(e) => return Err(format!("Could not capture original; file was not edited: {e}")),
                }
            } else {
                current(path)
            };
            records.push(Record { path: path.to_string(), original });
            if let Err(e) = save(file, records) {
                records.pop();
                return Err(e);
            }
            Ok(())
        })?;
        self.notify(id);
        Ok(())
    }

    pub fn list_changes(&self, id: &str) -> Result<Vec<FileChange>, String> {
        self.with_scope(id, |scope, sessions| {
            let file = match &scope {
                ReviewScope::Saved(p) => Some(p.as_path()),
                ReviewScope::Incognito => None,
                ReviewScope::Missing => {
                    *sessions = None;
                    return Ok(Vec::new());
                }
            };
            let records = Self::load(id, file, sessions)?;
            let mut out: Vec<FileChange> = records
                .iter()
                .filter_map(|r| {
                    let current = current(&r.path);
                    (current != r.original).then(|| FileChange {
                        path: r.path.clone(),
                        original: r.original.clone(),
                        current,
                    })
                })
                .collect();
            out.sort_by(|a, b| nekko_js::locale_compare(&a.path, &b.path));
            Ok(out)
        })
    }

    pub fn accept_change(&self, id: &str, path: &str) -> Result<(), String> {
        self.with_scope(id, |scope, sessions| {
            let file = match &scope {
                ReviewScope::Saved(p) => Some(p.as_path()),
                ReviewScope::Incognito => None,
                ReviewScope::Missing => {
                    *sessions = None;
                    return Ok(());
                }
            };
            let records = Self::load(id, file, sessions)?;
            let next: Vec<Record> = records.iter().filter(|r| r.path != path).cloned().collect();
            save(file, &next)?;
            *records = next;
            Ok(())
        })?;
        self.notify(id);
        Ok(())
    }

    pub fn accept_all(&self, id: &str) -> Result<(), String> {
        self.with_scope(id, |scope, sessions| {
            if let ReviewScope::Saved(p) = scope {
                remove(&p)?;
            }
            *sessions = None;
            Ok(())
        })?;
        self.notify(id);
        Ok(())
    }

    pub fn clear_memory(&self) {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}
