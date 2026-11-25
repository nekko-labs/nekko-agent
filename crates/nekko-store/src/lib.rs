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

pub mod blobs;
pub mod client_ids;
pub mod meta;
mod phase;
pub mod pr;
mod review;
mod summary;
mod write;
pub use review::ReviewScope;

pub use meta::Meta;

pub use phase::loop_phase;
pub use summary::summarize;
pub use write::{STARTER_MODES, execution_mode};

use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

/// How long the in-memory chat list is trusted before every chat file is
/// looked at again, for a file changed by something other than the daemon
/// (a sync tool, a person with an editor). The daemon's own writes, deletes
/// and renames never wait for it: they mark their chat to be read again.
pub const RESCAN_EVERY: Duration = Duration::from_secs(30);

/// One chat file as the list last saw it.
struct Entry {
    mtime: SystemTime,
    size: u64,
    /// `None` for a file that is not a chat (half written, or not JSON): it is
    /// not read again until its mtime or size changes.
    summary: Option<Value>,
}

/// The chat list, kept between calls: each chat's summary valid while the file
/// stands as it did, the same rule `listSessionSummaries` uses.
#[derive(Default)]
struct Index {
    /// By path, so the list comes out in the same order every time.
    entries: BTreeMap<PathBuf, Entry>,
    /// Files this store wrote, deleted or renamed since the last look.
    dirty: HashSet<PathBuf>,
    /// When every file was last looked at (`None`: never).
    scanned: Option<Instant>,
    /// The summary of a chat with a deferred save, made from its memory:
    /// `(save generation, disk mtime, disk size)` it was made for, and it.
    overlays: HashMap<String, ((u64, SystemTime, u64), Value)>,
}

/// A running turn's chat held for a later save.
struct Deferred {
    session: Arc<Mutex<Value>>,
    /// Counts the holds: a new one makes the in-memory chat newer.
    generation: u64,
    /// When it was last held (ms), the `updatedAt` its summary shows meanwhile.
    held_at: f64,
}

pub struct SessionStore {
    dir: PathBuf,
    /// The chat list, see [`Index`].
    index: Mutex<Index>,
    rescan: Duration,
    /// Held for reading across each read-modify-write of one chat (with
    /// that chat's own lock), and for writing by the writes that walk every
    /// chat (clearing, purging).
    all: RwLock<()>,
    /// One lock per chat a write is in progress on, so a long save of one
    /// chat never holds up another's. Dropped when nobody holds it.
    chats: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Running turns' chats whose newest state is in memory but not yet on
    /// disk ([`defer_turn_save`](Self::defer_turn_save)). Every read and
    /// every write of a chat here writes its pending save first, so nothing
    /// ever reads a chat older than the turn has made it.
    deferred: Mutex<HashMap<String, Deferred>>,
    holds: std::sync::atomic::AtomicU64,
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

impl Index {
    /// Bring the list up to date: every file looked at when it is due (or
    /// never was), and always the files this store wrote since.
    fn sync(&mut self, dir: &Path, rescan: Duration) {
        if self.scanned.is_none_or(|at| at.elapsed() >= rescan) {
            self.scan(dir);
            return;
        }
        for path in std::mem::take(&mut self.dirty) {
            self.refresh(&path, true);
        }
    }

    /// Look at every chat file: read the ones that changed, forget the ones gone.
    fn scan(&mut self, dir: &Path) {
        self.dirty.clear();
        let found = files(dir);
        let present: HashSet<&PathBuf> = found.iter().map(|(p, _)| p).collect();
        self.entries.retain(|k, _| present.contains(k));
        for (path, meta) in &found {
            self.load(path, meta, false);
        }
        self.scanned = Some(Instant::now());
    }

    /// Look at one file. `force` reads it even if its mtime and size are as before.
    fn refresh(&mut self, path: &Path, force: bool) {
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() => self.load(path, &meta, force),
            _ => {
                self.entries.remove(path);
            }
        }
        self.dirty.remove(path);
    }

    fn load(&mut self, path: &Path, meta: &std::fs::Metadata, force: bool) {
        let (mtime, size) = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
        if !force && self.entries.get(path).is_some_and(|e| e.mtime == mtime && e.size == size) {
            return;
        }
        // Pictures are only counted here: never read back from their files.
        let summary = std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .as_ref()
            .and_then(summarize);
        self.entries.insert(path.to_path_buf(), Entry { mtime, size, summary });
    }
}

/// Every chat file in `dir`, with its metadata (one `stat` each, following
/// links as `is_file` does).
fn files(dir: &Path) -> Vec<(PathBuf, std::fs::Metadata)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| {
            let meta = std::fs::metadata(&p).ok()?;
            meta.is_file().then_some((p, meta))
        })
        .collect()
}

impl SessionStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            dir: data_dir.as_ref().join("sessions"),
            index: Mutex::new(Index::default()),
            rescan: RESCAN_EVERY,
            holds: std::sync::atomic::AtomicU64::new(0),
            all: RwLock::new(()),
            chats: Mutex::new(HashMap::new()),
            deferred: Mutex::new(HashMap::new()),
        }
    }

    /// Look at every chat file again after `every` instead of [`RESCAN_EVERY`].
    pub fn with_rescan_every(mut self, every: Duration) -> Self {
        self.rescan = every;
        self
    }

    /// Chat `id`'s file was written, deleted or renamed here: read it again
    /// at the next listing.
    pub(crate) fn touched(&self, id: &str) {
        let path = self.dir.join(format!("{id}.json"));
        self.index.lock().unwrap_or_else(|e| e.into_inner()).dirty.insert(path);
    }

    /// Run `f` with chat `id`'s writes held: no other write to that chat, and
    /// no clear or purge, lands meanwhile. Not reentrant.
    pub(crate) fn with_chat<R>(&self, id: &str, f: impl FnOnce() -> R) -> R {
        // Before any lock is taken: a pending turn save lands first, and a
        // flush (which writes under this same chat lock) never runs inside it.
        let _ = self.flush(id);
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

    /// A picture kept beside the chats (`<sha256>.<ext>`, see blobs.rs) is here.
    pub fn has_blob(&self, name: &str) -> bool {
        blobs::valid_name(name) && blobs::dir(&self.dir).join(name).is_file()
    }

    /// A picture's bytes, by its blob name.
    pub fn blob(&self, name: &str) -> Option<Vec<u8>> {
        if !blobs::valid_name(name) {
            return None;
        }
        std::fs::read(blobs::dir(&self.dir).join(name)).ok()
    }

    /// Move the pictures of a live `tool_result` event (`result.images`, data
    /// URLs of 4 KB or more) beside the chats and leave `nekko-blob:<name>`
    /// references in the event, so the frame the hub keeps and sends every
    /// socket is a few hundred bytes, not megabytes. The chat read back through
    /// the store has the pictures as data URLs as ever. Returns how many moved.
    pub fn shed_event_images(&self, images: &mut [Value]) -> usize {
        let dir = blobs::dir(&self.dir);
        let mut moved = 0;
        for image in images {
            if let Some(url) = image.as_str()
                && url.starts_with("data:")
                && let Some(reference) = blobs::store_inline(&dir, url)
            {
                *image = Value::String(reference);
                moved += 1;
            }
        }
        moved
    }

    /// Keep a picture beside the chats, as a chat's `nekko-blob:<name>` will look for it. Refused
    /// unless the bytes hash to the name, so nothing else can be written there under it.
    pub fn put_blob(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if !blobs::matches(name, bytes) {
            return Err("a picture that is not what its name says".into());
        }
        let dir = blobs::dir(&self.dir);
        let path = dir.join(name);
        if path.is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write::write_atomic_bytes(&path, bytes).map_err(|e| e.to_string())
    }

    fn files(&self) -> Vec<(PathBuf, std::fs::Metadata)> {
        files(&self.dir)
    }

    /// A chat file, with the pictures kept beside it put back (blobs.rs).
    fn read(path: &Path) -> Option<Value> {
        let bytes = std::fs::read(path).ok()?;
        let mut chat: Value = serde_json::from_slice(&bytes).ok()?;
        if memchr::memmem::find(&bytes, blobs::REF.as_bytes()).is_some()
            && let Some(dir) = path.parent()
        {
            blobs::restore(&mut chat, &blobs::dir(dir));
        }
        Some(chat)
    }

    /// Remove the picture files no chat refers to any more and that are
    /// older than `min_age` (younger ones may belong to a save in flight).
    /// Returns how many were removed.
    pub fn gc_blobs(&self, min_age: std::time::Duration) -> usize {
        let blob_dir = blobs::dir(&self.dir);
        let Ok(entries) = std::fs::read_dir(&blob_dir) else { return 0 };
        self.flush_all();
        let mut used = HashSet::new();
        for (path, _) in self.files() {
            if let Ok(bytes) = std::fs::read(&path) {
                blobs::references(&bytes, &mut used);
            }
        }
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !blobs::valid_name(&name) || used.contains(&name) {
                continue;
            }
            let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok());
            if old.is_some_and(|age| age >= min_age) && std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    /// Hold a running turn's save of `session` (with `messages` as its
    /// transcript, moved in now) until [`flush`](Self::flush). A turn
    /// checkpoints on every step and tool result, and each save rewrites the
    /// whole chat file (megabytes in a long chat); deferred, the saves within
    /// a short window become one. Anything that reads or writes the chat here
    /// writes it first.
    pub fn defer_turn_save(&self, session: &Arc<Mutex<Value>>, messages: Option<Vec<Value>>) {
        let id = {
            let mut s = session.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(m) = messages
                && let Some(obj) = s.as_object_mut()
            {
                obj.insert("messages".into(), Value::Array(m));
            }
            s.get("id").and_then(Value::as_str).unwrap_or_default().to_string()
        };
        if valid_id(&id) {
            let generation = self.holds.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            let held = Deferred { session: session.clone(), generation, held_at: nekko_js::now_ms() as f64 };
            self.deferred.lock().unwrap_or_else(|e| e.into_inner()).insert(id, held);
        }
    }

    /// Write chat `id`'s deferred turn save, if it has one.
    pub fn flush(&self, id: &str) -> Result<(), String> {
        let pending = self.deferred.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        match pending {
            Some(held) => self.save_turn_shared(&held.session, None),
            None => Ok(()),
        }
    }

    /// Write every deferred turn save (before a full listing, and at shutdown).
    pub fn flush_all(&self) {
        let ids: Vec<String> = self.deferred.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        for id in ids {
            if let Err(e) = self.flush(&id) {
                eprintln!("nekko-store: could not save chat {id}: {e}");
            }
        }
    }

    /// Drop chat `id`'s deferred turn save, for a caller about to save the
    /// same chat with a newer transcript.
    pub fn discard_deferred(&self, id: &str) {
        self.deferred.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    /// Whether chat `id` has a deferred turn save waiting.
    pub fn has_deferred(&self, id: &str) -> bool {
        self.deferred.lock().unwrap_or_else(|e| e.into_inner()).contains_key(id)
    }

    /// `getSession`: the whole chat, or `None` when there is no such (readable) chat.
    pub fn get(&self, id: &str) -> Option<Value> {
        let _ = self.flush(id);
        self.get_raw(id)
    }

    /// [`get`](Self::get) as the file stands, for a caller already inside the chat's lock.
    pub(crate) fn get_raw(&self, id: &str) -> Option<Value> {
        if !valid_id(id) {
            return None;
        }
        Self::read(&self.dir.join(format!("{id}.json")))
    }

    /// A chat without its transcript (see [`meta`]), or `None` when there is
    /// no such (readable) chat. Much cheaper than [`get`](Self::get) for a
    /// long chat.
    pub fn meta(&self, id: &str) -> Option<Meta> {
        let _ = self.flush(id);
        self.meta_raw(id)
    }

    /// [`meta`](Self::meta) as the file stands, for a caller already inside the chat's lock.
    pub(crate) fn meta_raw(&self, id: &str) -> Option<Meta> {
        if !valid_id(id) {
            return None;
        }
        meta::parse(&std::fs::read(self.dir.join(format!("{id}.json"))).ok()?)
    }

    /// `listSessions`: every chat with its transcript, newest first.
    pub fn list(&self) -> Vec<Value> {
        self.flush_all();
        let mut all: Vec<Value> = self.files().iter().filter_map(|(p, _)| Self::read(p)).collect();
        newest_first(&mut all);
        all
    }

    /// Every chat without its transcript, newest first.
    pub fn list_meta(&self) -> Vec<Value> {
        self.flush_all();
        self.list_meta_raw()
    }

    /// [`list_meta`](Self::list_meta) as the files stand, for a caller holding every chat's lock.
    pub(crate) fn list_meta_raw(&self) -> Vec<Value> {
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
        self.flush_all();
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
    /// first. Reads no chat file that has not changed, and does not write the
    /// deferred turn saves: a running chat's summary is made from its memory
    /// instead (what its save would have written), so a listing after every
    /// event no longer defeats the save debounce.
    ///
    /// The file list is kept: a call looks at no file but the ones this store
    /// wrote since the last, and at every file again once per
    /// [`RESCAN_EVERY`], for a chat changed from outside.
    pub fn summaries(&self) -> Vec<Value> {
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        index.sync(&self.dir, self.rescan);
        let overlays = self.overlays(&mut index);
        let mut out: Vec<Value> =
            index.entries.iter().filter_map(|(path, e)| overlays.get(path).or(e.summary.as_ref()).cloned()).collect();
        let listed: HashSet<&PathBuf> = index.entries.keys().collect();
        // A chat held before its file was ever listed.
        out.extend(overlays.iter().filter(|(p, _)| !listed.contains(p)).map(|(_, v)| v.clone()));
        drop(index);
        newest_first(&mut out);
        // After the cache, which keeps each chat's own PRs: a chat also lists its sub-agents'.
        pr::roll_up_child_pr_urls(&mut out);
        out
    }

    /// One chat's summary, as [`summaries`](Self::summaries) lists it (its
    /// sub-agents' PRs included), without looking at any other chat file: only
    /// this file is checked, the rest of the list is as it was kept. `None`
    /// when there is no such (readable) chat.
    pub fn summary(&self, id: &str) -> Option<Value> {
        if !valid_id(id) {
            return None;
        }
        let path = self.dir.join(format!("{id}.json"));
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if index.scanned.is_none() {
            index.sync(&self.dir, self.rescan);
        }
        index.refresh(&path, false);
        let overlays = self.overlays(&mut index);
        let mut own = overlays.get(&path).or(index.entries.get(&path).and_then(|e| e.summary.as_ref())).cloned()?;
        let below = {
            let all: Vec<&Value> =
                index.entries.iter().filter_map(|(p, e)| overlays.get(p).or(e.summary.as_ref())).collect();
            pr::child_pr_urls(id, &all)
        };
        drop(index);
        if !below.is_empty() {
            let mut urls: Vec<String> =
                serde_json::from_value(own.get("prUrls").cloned().unwrap_or_default()).unwrap_or_default();
            for u in below {
                if !urls.contains(&u) {
                    urls.push(u);
                }
            }
            own["prUrls"] = urls.into();
        }
        Some(own)
    }

    /// The summaries of the chats with a deferred save, made from what they
    /// hold in memory, by file. What a flush would have written: the
    /// fields the user changed (on disk) stay, `updatedAt` is when it was held.
    fn overlays(&self, index: &mut Index) -> HashMap<PathBuf, Value> {
        let held: Vec<(String, Arc<Mutex<Value>>, u64, f64)> = self
            .deferred
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(id, d)| (id.clone(), d.session.clone(), d.generation, d.held_at))
            .collect();
        index.overlays.retain(|id, _| held.iter().any(|h| &h.0 == id));
        let mut out = HashMap::new();
        for (id, session, generation, held_at) in held {
            let path = self.dir.join(format!("{id}.json"));
            let disk = index.entries.get(&path);
            let key = (generation, disk.map_or(SystemTime::UNIX_EPOCH, |e| e.mtime), disk.map_or(0, |e| e.size));
            if let Some((made_for, v)) = index.overlays.get(&id)
                && *made_for == key
            {
                out.insert(path, v.clone());
                continue;
            }
            let memory = summarize(&session.lock().unwrap_or_else(|e| e.into_inner()));
            let Some(mut v) = memory else { continue };
            if let Some(disk) = disk.and_then(|e| e.summary.as_ref()) {
                write::keep_user_fields(&mut v, disk);
            }
            let newest = updated_at(&v).max(held_at);
            v["updatedAt"] = json!(newest);
            index.overlays.insert(id, (key, v.clone()));
            out.insert(path, v);
        }
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
        // Every call looks at every file: the files below are changed from outside.
        let (s, dir) = store();
        let s = s.with_rescan_every(Duration::ZERO);
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
    fn the_kept_list_follows_own_writes_at_once_and_outside_changes_on_the_rescan() {
        let (s, dir) = store();
        let id = |v: &Value| v["id"].as_str().unwrap().to_string();
        let a = id(&s.create(None).unwrap());
        assert_eq!(s.summaries().len(), 1);
        // Own writes, deletes and creates show at once.
        let b = id(&s.create(None).unwrap());
        s.set_options(&a, &json!({ "title": "renamed" })).unwrap();
        let listed = s.summaries();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed.iter().find(|v| v["id"] == a.as_str()).unwrap()["title"], "renamed");
        s.delete(&b).unwrap();
        assert_eq!(s.summaries().len(), 1);
        // A file changed from outside is not looked at until the next rescan.
        let outside = dir.join("sessions").join("s_outside.json");
        std::fs::write(&outside, json!({ "id": "s_outside", "updatedAt": 1, "messages": [] }).to_string()).unwrap();
        assert_eq!(s.summaries().len(), 1);
        assert!(s.summary("s_outside").is_some(), "one chat is always checked on its own file");
        let s = s.with_rescan_every(Duration::ZERO);
        assert_eq!(s.summaries().len(), 2);
        std::fs::remove_file(&outside).unwrap();
        assert_eq!(s.summaries().len(), 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_single_summary_equals_the_listed_one_and_never_flushes() {
        let (s, dir) = store();
        let write = |id: &str, parent: Option<&str>, updated: u64, url: &str| {
            let mut v = json!({ "id": id, "title": id, "updatedAt": updated, "messages": [
                { "id": "u", "role": "user", "content": "do it", "createdAt": 1 },
                { "id": "a", "role": "assistant", "content": "", "toolCalls": [{ "id": format!("t_{id}"), "name": "PowerShell", "input": { "command": "gh pr create --fill" } }] },
                { "id": "r", "role": "tool", "toolResult": { "toolCallId": format!("t_{id}"), "output": url } },
            ] });
            if let Some(p) = parent {
                v["parentSessionId"] = json!(p);
            }
            std::fs::write(dir.join("sessions").join(format!("{id}.json")), serde_json::to_vec(&v).unwrap()).unwrap();
        };
        let url = |n: u32| format!("https://github.com/o/r/pull/{n}");
        write("s_parent", None, 1, &url(1));
        write("s_child", Some("s_parent"), 2, &url(2));
        write("s_grandchild", Some("s_child"), 3, &url(3));
        write("s_other", None, 4, &url(4));
        let listed = s.summaries();
        for id in ["s_parent", "s_child", "s_grandchild", "s_other"] {
            let want = listed.iter().find(|v| v["id"] == id).unwrap();
            let mut got = s.summary(id).unwrap();
            let sorted = |v: &mut Value| {
                let mut u: Vec<String> = serde_json::from_value(v["prUrls"].clone()).unwrap();
                u.sort();
                v["prUrls"] = json!(u);
            };
            let mut want = want.clone();
            sorted(&mut want);
            sorted(&mut got);
            assert_eq!(&got, &want, "{id}");
        }
        assert_eq!(s.summary("s_parent").unwrap()["prUrls"], json!([url(1), url(3), url(2)]), "newest chat first");
        assert!(s.summary("../s_parent").is_none() && s.summary("s_none").is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_chat_summary_lists_the_prs_its_sub_agent_chats_created() {
        let (s, dir) = store();
        // A Claude Code sub-agent's child chat, as subagents.rs saves it: its own transcript, `parentSessionId` set.
        let write = |id: &str, parent: Option<&str>, updated: u64, url: &str, failed: bool| {
            let mut v = json!({ "id": id, "title": id, "updatedAt": updated, "messages": [
                { "id": "u", "role": "user", "content": "do it", "createdAt": 1 },
                { "id": "a", "role": "assistant", "content": "", "toolCalls": [{ "id": format!("t_{id}"), "name": "PowerShell", "input": { "command": "$u = gh pr create --fill; $u" } }] },
                { "id": "r", "role": "tool", "toolResult": { "toolCallId": format!("t_{id}"), "output": url, "isError": failed } },
            ] });
            if let Some(p) = parent {
                v["parentSessionId"] = json!(p);
            }
            std::fs::write(dir.join("sessions").join(format!("{id}.json")), serde_json::to_vec_pretty(&v).unwrap())
                .unwrap();
        };
        let url = |n: u32| format!("https://github.com/o/r/pull/{n}");
        write("s_parent", None, 1, "no PR here", false);
        write("s_child", Some("s_parent"), 2, &url(2), false);
        write("s_failed", Some("s_parent"), 3, &url(3), true);
        write("s_grandchild", Some("s_child"), 4, &url(4), false);
        // Sub-agents' PRs follow the chat's own in list order (newest chat first); the chip sorts them itself.
        let by_id = |id: &str| {
            let mut urls: Vec<String> =
                serde_json::from_value(s.summaries().into_iter().find(|v| v["id"] == id).unwrap()["prUrls"].clone())
                    .unwrap();
            urls.sort();
            json!(urls)
        };
        assert_eq!(by_id("s_parent"), json!([url(2), url(4)]));
        assert_eq!(by_id("s_child"), json!([url(2), url(4)]));
        assert_eq!(by_id("s_failed"), json!([]));
        assert_eq!(by_id("s_grandchild"), json!([url(4)]));
        // The cache keeps each chat's own PRs: a second read does not add them twice.
        assert_eq!(by_id("s_parent"), json!([url(2), url(4)]));
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
    fn a_live_events_pictures_move_beside_the_chats_and_come_back_in_the_saved_chat() {
        use base64::Engine;
        let (s, dir) = store();
        let png =
            format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(vec![7u8; 8192]));
        let small = "data:image/png;base64,AAAA".to_string();
        let mut images = vec![json!(png), json!(small), json!("not a data url")];
        assert_eq!(s.shed_event_images(&mut images), 1);
        let reference = images[0].as_str().unwrap().to_string();
        assert!(reference.starts_with("nekko-blob:") && reference.len() < 100, "{reference}");
        assert_eq!(images[1], json!(small));
        assert_eq!(images[2], json!("not a data url"));
        assert!(s.has_blob(reference.strip_prefix("nekko-blob:").unwrap()));
        // The checkpoint that saves the same picture finds its file and the chat reads back whole.
        let mut chat = s.create(None).unwrap();
        chat["messages"] =
            json!([{ "id": "r", "role": "tool", "toolResult": { "toolCallId": "t", "output": "", "images": [png] } }]);
        s.save_whole(&mut chat).unwrap();
        assert_eq!(s.get(chat["id"].as_str().unwrap()).unwrap()["messages"][0]["toolResult"]["images"][0], json!(png));
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
