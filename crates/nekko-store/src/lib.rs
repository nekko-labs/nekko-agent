//! Session storage for the engine daemon, ported from
//! `packages/host/src/sessions.ts`.
//!
//! Chats live one JSON file each in `<data>/sessions/<id>.json`. The daemon
//! serves the reads and the UI's own writes (`write.rs`); the TS agent loop
//! still writes the chat it is running, since it holds the session in memory
//! for a whole turn and saves as it goes (it moves with the agent loop, PF14).
//! Serving these here takes the heaviest calls off the TS event loop: listing
//! every chat on each sidebar refresh, and opening a chat, which for an image
//! chat means parsing megabytes of pictures while an agent in another tab is
//! streaming through the same thread.
//!
//! Both sides write each file to a temp name and rename it into place, so a
//! reader never sees half a file.

pub mod client_ids;
mod summary;
mod write;

pub use summary::summarize;
pub use write::{STARTER_MODES, execution_mode};

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub struct SessionStore {
    dir: PathBuf,
    /// Summaries by file, valid while the file's mtime and size match, the
    /// same rule `listSessionSummaries` uses.
    cache: Mutex<HashMap<PathBuf, (SystemTime, u64, Value)>>,
    /// Held across each read-modify-write this store makes.
    writes: Mutex<()>,
}

/// Session ids are `s_<time>_<random>` (base36 and base64url). Anything else
/// is refused rather than joined into a path.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn updated_at(v: &Value) -> f64 {
    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// Newest first, as `b.updatedAt - a.updatedAt` sorts: a missing value
/// compares equal, and the sort is stable.
fn newest_first(list: &mut [Value]) {
    list.sort_by(|a, b| updated_at(b).partial_cmp(&updated_at(a)).unwrap_or(std::cmp::Ordering::Equal));
}

impl SessionStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self { dir: data_dir.as_ref().join("sessions"), cache: Mutex::new(HashMap::new()), writes: Mutex::new(()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn files(&self) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        rd.filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json") && p.is_file())
            .collect()
    }

    fn read(path: &Path) -> Option<Value> {
        let bytes = std::fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// `getSession`: the whole chat, or `None` when there is no such (readable) chat.
    pub fn get(&self, id: &str) -> Option<Value> {
        if !valid_id(id) {
            return None;
        }
        Self::read(&self.dir.join(format!("{id}.json")))
    }

    /// `listSessions`: every chat with its transcript, newest first.
    pub fn list(&self) -> Vec<Value> {
        let mut all: Vec<Value> = self.files().iter().filter_map(|p| Self::read(p)).collect();
        newest_first(&mut all);
        all
    }

    /// `listSessionSummaries`: every chat without its transcript, newest
    /// first. Only files that changed since the last call are read.
    pub fn summaries(&self) -> Vec<Value> {
        let files = self.files();
        let mut out = Vec::with_capacity(files.len());
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        for file in &files {
            let Ok(meta) = std::fs::metadata(file) else { continue };
            let (mtime, size) = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
            if let Some((m, s, summary)) = cache.get(file)
                && *m == mtime
                && *s == size
            {
                out.push(summary.clone());
                continue;
            }
            match Self::read(file).as_ref().and_then(summarize) {
                Some(summary) => {
                    cache.insert(file.clone(), (mtime, size, summary.clone()));
                    out.push(summary);
                }
                None => {
                    cache.remove(file);
                }
            }
        }
        cache.retain(|k, _| files.contains(k));
        drop(cache);
        newest_first(&mut out);
        out
    }

    /// `sessionImages` (image-chat.ts): the newest `limit` generated pictures, newest last.
    pub fn images(&self, id: &str, limit: f64) -> Vec<Value> {
        let Some(s) = self.get(id) else { return Vec::new() };
        let cap = if limit.is_finite() { (limit.floor() as i64).clamp(1, 12) as usize } else { 1 };
        let mut out = Vec::new();
        for m in s.get("messages").and_then(Value::as_array).into_iter().flatten().rev() {
            if out.len() >= cap {
                break;
            }
            let generated = m.get("generated").is_some_and(|g| !g.is_null() && g != &Value::Bool(false));
            let first = m.get("images").and_then(Value::as_array).and_then(|a| a.first());
            if m.get("role").and_then(Value::as_str) == Some("assistant")
                && generated
                && let Some(src) = first
            {
                out.push(json!({ "messageId": m.get("id").cloned().unwrap_or(Value::Null), "src": src }));
            }
        }
        out.reverse();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (SessionStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("nekko-store-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        (SessionStore::new(&dir), dir)
    }

    /// Unique per test: tests run in parallel, and on Windows two of them can
    /// read the same clock tick, share a folder, and delete it under each other.
    fn rand_suffix() -> String {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        format!("{n}-{}", SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos())
    }

    #[test]
    fn refuses_ids_that_are_not_ids() {
        let (s, dir) = store();
        std::fs::write(dir.join("secret.json"), "{}").unwrap();
        assert!(s.get("../secret").is_none());
        assert!(!valid_id("a/b") && !valid_id("") && valid_id("s_muoasmpg_wUCI2bj5"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn lists_newest_first_skips_broken_files_and_refreshes_changed_ones() {
        let (s, dir) = store();
        let write = |id: &str, updated: u64, text: &str| {
            let v = json!({ "id": id, "title": id, "updatedAt": updated, "messages": [{ "id": "u", "role": "user", "content": text, "createdAt": 1 }] });
            std::fs::write(dir.join("sessions").join(format!("{id}.json")), serde_json::to_vec_pretty(&v).unwrap())
                .unwrap();
        };
        write("s_a", 1, "first");
        write("s_b", 2, "second");
        std::fs::write(dir.join("sessions").join("s_c.json"), "{ half a fi").unwrap();
        std::fs::write(dir.join("sessions").join("s_d.json.123.tmp"), "{}").unwrap();
        let ids: Vec<String> = s.summaries().iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["s_b", "s_a"]);
        write("s_a", 3, "changed, and longer");
        let first = &s.summaries()[0];
        assert_eq!(first["id"], "s_a");
        assert_eq!(first["firstUserText"], "changed, and longer");
        assert!(first.get("messages").is_none());
        assert_eq!(s.list().len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn completion_survives_summary_refresh_and_restore() {
        let (s, dir) = store();
        let chat = s.create(None).unwrap();
        let id = chat["id"].as_str().unwrap();
        assert!(s.summaries()[0].get("archivedAt").is_none());
        let completed = s.set_options(id, &json!({ "archivedAt": 123 })).unwrap().unwrap();
        assert_eq!(completed["archivedAt"], 123);
        assert_eq!(s.summaries()[0]["archivedAt"], 123);
        assert_eq!(SessionStore::new(&dir).summaries()[0]["archivedAt"], 123);
        s.set_options(id, &json!({ "archivedAt": null })).unwrap();
        assert!(s.summaries()[0]["archivedAt"].is_null());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn collects_generated_images_newest_last() {
        let (s, dir) = store();
        let g = json!({ "modelId": "m", "width": 8, "height": 8, "steps": 1, "cfgScale": 1, "seed": 1, "ms": 1 });
        let v = json!({ "id": "s_i", "updatedAt": 1, "messages": [
            { "id": "a1", "role": "assistant", "content": "", "images": ["data:1"], "generated": g },
            { "id": "u", "role": "user", "content": "x", "images": ["data:attached"] },
            { "id": "a2", "role": "assistant", "content": "", "images": ["data:2"], "generated": g },
        ] });
        std::fs::write(dir.join("sessions").join("s_i.json"), v.to_string()).unwrap();
        assert_eq!(
            s.images("s_i", 4.0),
            vec![json!({ "messageId": "a1", "src": "data:1" }), json!({ "messageId": "a2", "src": "data:2" })]
        );
        assert_eq!(s.images("s_i", 1.0).len(), 1);
        std::fs::remove_dir_all(dir).ok();
    }
}
