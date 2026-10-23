//! Session storage for the engine daemon, ported from
//! `packages/host/src/sessions.ts`.
//!
//! Chats live one JSON file each in `<data>/sessions/<id>.json`. The daemon
//! is their only writer: the UI's own writes (`write.rs`) and a running
//! turn's checkpoints (`save_turn`) both go through this store, which
//! serializes the writes to each chat (one lock per chat; clearing or purging
//! many chats takes them all).
//!
//! Every file is written to a temp name and renamed into place, so a reader
//! never sees half a file.

pub mod client_ids;
pub mod meta;
mod summary;
mod write;

pub use meta::Meta;

pub use summary::summarize;
pub use write::{STARTER_MODES, execution_mode};

use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

pub struct SessionStore {
    dir: PathBuf,
    /// Summaries by file, valid while the file's mtime and size match, the
    /// same rule `listSessionSummaries` uses.
    cache: Mutex<HashMap<PathBuf, (SystemTime, u64, Value)>>,
    /// Held for reading across each read-modify-write of one chat (with
    /// that chat's own lock), and for writing by the writes that walk every
    /// chat (clearing, purging).
    all: RwLock<()>,
    /// One lock per chat a write is in progress on, so a long save of one
    /// chat never holds up another's. Dropped when nobody holds it.
    chats: Mutex<HashMap<String, Arc<Mutex<()>>>>,
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
        Self {
            dir: data_dir.as_ref().join("sessions"),
            cache: Mutex::new(HashMap::new()),
            all: RwLock::new(()),
            chats: Mutex::new(HashMap::new()),
        }
    }

    /// Run `f` with chat `id`'s writes held: no other write to that chat, and
    /// no clear or purge, lands meanwhile. Not reentrant.
    pub(crate) fn with_chat<R>(&self, id: &str, f: impl FnOnce() -> R) -> R {
        let _all = self.all.read().unwrap_or_else(|e| e.into_inner());
        let lock = self.chats.lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().clone();
        let out = {
            let _chat = lock.lock().unwrap_or_else(|e| e.into_inner());
            f()
        };
        let mut chats = self.chats.lock().unwrap_or_else(|e| e.into_inner());
        // The map and this call hold it: nobody else waits on it.
        if Arc::strong_count(&lock) == 2 {
            chats.remove(id);
        }
        out
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Every chat file, with its metadata (one `stat` each, following links
    /// as `is_file` does).
    fn files(&self) -> Vec<(PathBuf, std::fs::Metadata)> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        rd.filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .filter_map(|p| {
                let meta = std::fs::metadata(&p).ok()?;
                meta.is_file().then_some((p, meta))
            })
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

    /// A chat without its transcript (see [`meta`]), or `None` when there is
    /// no such (readable) chat. Much cheaper than [`get`](Self::get) for a
    /// long chat.
    pub fn meta(&self, id: &str) -> Option<Meta> {
        if !valid_id(id) {
            return None;
        }
        meta::parse(&std::fs::read(self.dir.join(format!("{id}.json"))).ok()?)
    }

    /// `listSessions`: every chat with its transcript, newest first.
    pub fn list(&self) -> Vec<Value> {
        let mut all: Vec<Value> = self.files().iter().filter_map(|(p, _)| Self::read(p)).collect();
        newest_first(&mut all);
        all
    }

    /// Every chat without its transcript, newest first.
    pub fn list_meta(&self) -> Vec<Value> {
        let mut all: Vec<Value> = self
            .files()
            .iter()
            .filter_map(|(p, _)| meta::parse(&std::fs::read(p).ok()?))
            .map(Meta::into_value)
            .collect();
        newest_first(&mut all);
        all
    }

    /// [`list`](Self::list), but only the chats whose file contains `needle`
    /// anywhere: the rest are searched as bytes and never parsed. A chat that
    /// has the key `"activeRun"`, say, has to contain that text.
    pub fn list_containing(&self, needle: &str) -> Vec<Value> {
        let finder = memchr::memmem::Finder::new(needle.as_bytes());
        let mut all: Vec<Value> = self
            .files()
            .iter()
            .filter_map(|(p, _)| {
                let bytes = std::fs::read(p).ok()?;
                finder.find(&bytes)?;
                serde_json::from_slice(&bytes).ok()
            })
            .collect();
        newest_first(&mut all);
        all
    }

    /// `listSessionSummaries`: every chat without its transcript, newest
    /// first. Only files that changed since the last call are read.
    pub fn summaries(&self) -> Vec<Value> {
        let files = self.files();
        let mut out = Vec::with_capacity(files.len());
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        for (file, meta) in &files {
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
        let present: HashSet<&PathBuf> = files.iter().map(|(p, _)| p).collect();
        cache.retain(|k, _| present.contains(k));
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
    fn a_write_to_one_chat_does_not_wait_for_another_and_its_lock_goes_after() {
        let (s, dir) = store();
        let s = Arc::new(s);
        let a = s.create(None).unwrap()["id"].as_str().unwrap().to_string();
        let b = s.create(None).unwrap()["id"].as_str().unwrap().to_string();
        s.with_chat(&a, || {
            let (s, b) = (s.clone(), b.clone());
            std::thread::spawn(move || s.set_options(&b, &json!({ "title": "while a is held" })).unwrap())
                .join()
                .unwrap();
        });
        assert_eq!(s.get(&b).unwrap()["title"], "while a is held");
        assert!(s.chats.lock().unwrap().is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn lists_only_the_chats_containing_a_needle_and_meta_skips_the_transcript() {
        let (s, dir) = store();
        let write = |id: &str, extra: Value| {
            let mut v =
                json!({ "id": id, "updatedAt": 1, "messages": [{ "id": "u", "role": "user", "content": "hi" }] });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            std::fs::write(dir.join("sessions").join(format!("{id}.json")), serde_json::to_vec_pretty(&v).unwrap())
                .unwrap();
        };
        write("s_a", json!({ "activeRun": { "startedAt": 1 } }));
        write("s_b", json!({}));
        let found: Vec<Value> = s.list_containing("\"activeRun\"").iter().map(|v| v["id"].clone()).collect();
        assert_eq!(found, [json!("s_a")]);
        let meta = s.meta("s_a").unwrap();
        assert!(meta.messages_array && meta.get("messages").is_none() && meta.get("activeRun").is_some());
        assert_eq!(s.list_meta().len(), 2);
        assert!(s.meta("../s_a").is_none() && s.meta("s_none").is_none());
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
