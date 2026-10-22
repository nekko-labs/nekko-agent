//! `settings.json`, owned by the engine daemon.
//!
//! The daemon is the file's single writer: the UI's `settings:get`,
//! `settings:update` and `settings:reset` land here, and the TS host sends its
//! own writes here too instead of touching the file. This is a port of the TS
//! host's `store.ts` (`getSettings`, `saveSettings`, `resetSettings`) down to
//! JavaScript's object spread, property order and `JSON.stringify` output, so
//! the file and every value handed back are byte for byte what the TS store
//! produced. `tests/golden.rs` holds it to the TS functions
//! (packages/host/src/settings.golden.test.ts writes the expected set and the
//! embedded defaults, and fails when either goes stale).

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// What the TS host starts from: `defaultSettings()`, `DEFAULT_ACCENT` and
/// `LEGACY_ACCENTS`, written by the TS golden test.
const DEFAULTS: &str = include_str!("defaults.json");

struct Defaults {
    settings: Map<String, Value>,
    accent: String,
    legacy_accents: Vec<String>,
}

fn embedded() -> &'static Defaults {
    static D: OnceLock<Defaults> = OnceLock::new();
    D.get_or_init(|| {
        let v: Value = serde_json::from_str(DEFAULTS).unwrap_or(Value::Null);
        Defaults {
            settings: v.get("defaults").and_then(Value::as_object).cloned().unwrap_or_default(),
            accent: v.get("defaultAccent").and_then(Value::as_str).unwrap_or_default().to_string(),
            legacy_accents: v
                .get("legacyAccents")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
        }
    })
}

/// `defaultSettings()`: the settings of a new install.
pub fn defaults() -> Map<String, Value> {
    embedded().settings.clone()
}

fn default_of(key: &str) -> Value {
    embedded().settings.get(key).cloned().unwrap_or(Value::Null)
}

/// The settings a file's text yields, as `getSettings` reads it: the
/// defaults with the file's keys spread over them, array fields normalized,
/// `maxSteps` dropped and a legacy accent migrated. Anything `getSettings`
/// would throw on (bad JSON, an accent that is not a string) yields the
/// defaults, as its `catch` does.
pub fn from_text(text: &str) -> Map<String, Value> {
    parse(text).unwrap_or_else(defaults)
}

fn parse(text: &str) -> Option<Map<String, Value>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let mut s = defaults();
    nekko_js::spread_into(&mut s, &parsed);
    let not_array = |s: &Map<String, Value>, k: &str| !s.get(k).is_some_and(Value::is_array);
    for key in ["providers", "workspaces", "connectors", "favoriteModels", "mcpServers"] {
        if not_array(&s, key) {
            s.insert(key.into(), Value::Array(Vec::new()));
        }
    }
    if not_array(&s, "guardrails") || s.get("guardrails").and_then(Value::as_array).is_some_and(Vec::is_empty) {
        s.insert("guardrails".into(), default_of("guardrails"));
    }
    if not_array(&s, "prompts") {
        s.insert("prompts".into(), default_of("prompts"));
    }
    s.shift_remove("maxSteps");
    // `settings.accent && LEGACY_ACCENTS.includes(settings.accent.toLowerCase())`:
    // any truthy accent that is not a string has no toLowerCase, so it throws.
    if nekko_js::truthy(s.get("accent")) {
        let accent = s.get("accent").and_then(Value::as_str)?;
        let d = embedded();
        if d.legacy_accents.iter().any(|l| *l == accent.to_lowercase()) {
            s.insert("accent".into(), Value::String(d.accent.clone()));
        }
    }
    Some(s)
}

/// A thrown TypeError, worded as V8 words it.
fn read_prop_error(base: &Value, prop: &str) -> String {
    let what = if base.is_null() { "null" } else { "undefined" };
    format!("Cannot read properties of {what} (reading '{prop}')")
}

/// `folderPathKey`: a folder path's comparable form. No trailing separator
/// (except a drive root's), one separator kind and case-folded where the
/// filesystem ignores case (a Windows drive path or a UNC share).
pub fn folder_path_key(p: &str) -> String {
    let raw = nekko_js::trim(p);
    let b = raw.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    let windows = (drive && (b.len() == 2 || b[2] == b'\\' || b[2] == b'/')) || raw.starts_with("\\\\");
    let sep = |c: char| c == '\\' || c == '/';
    let trimmed = if windows && drive && raw[2..].chars().all(sep) {
        format!("{}\\", &raw[..2])
    } else {
        strip_trailing_separators(raw).to_string()
    };
    if windows { trimmed.replace('/', "\\").to_lowercase() } else { trimmed }
}

/// `raw.replace(/(?<=.)[\\/]+$/, '')`: the leftmost start inside the trailing
/// run of separators that has a character before it other than a line
/// terminator (`.` does not match those).
fn strip_trailing_separators(raw: &str) -> &str {
    let run_start = raw.trim_end_matches(['\\', '/']).len();
    if run_start == raw.len() {
        return raw;
    }
    // Separators are one byte, so every index in the run is a char boundary.
    for start in run_start..raw.len() {
        if let Some(prev) = raw[..start].chars().next_back()
            && !nekko_js::is_line_terminator(prev)
        {
            return &raw[..start];
        }
    }
    raw
}

/// `uniqueFolders(folders).folders`, with its throws: one entry per folder
/// path, later duplicates dropped, order otherwise kept. A value that is not
/// iterable, an entry that is null or has no string `path`, are errors, as
/// they are in JavaScript.
pub fn unique_folders(folders: &Value) -> Result<Vec<Value>, String> {
    let items: Vec<Value> = match folders {
        Value::Array(a) => a.clone(),
        // `for…of` over a string yields its characters, whose `path` is undefined.
        Value::String(s) => s.chars().map(|c| Value::String(c.to_string())).collect(),
        Value::Object(_) => return Err("folders is not iterable".into()),
        other => return Err(format!("folders is not iterable (cannot read property {})", nekko_js::display(other))),
    };
    let mut seen: Vec<(String, Value)> = Vec::new();
    let mut out = Vec::new();
    for f in items {
        if f.is_null() {
            return Err(read_prop_error(&f, "path"));
        }
        let path = match f.get("path") {
            Some(Value::String(p)) => p.clone(),
            _ => return Err("f.path.trim is not a function".into()),
        };
        let key = folder_path_key(&path);
        let kept = seen.iter().find(|(k, _)| *k == key).map(|(_, id)| id.clone());
        if nekko_js::truthy(kept.as_ref()) {
            continue;
        }
        let id = f.get("id").cloned().unwrap_or(Value::Null);
        match seen.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = id,
            None => seen.push((key, id)),
        }
        out.push(f);
    }
    Ok(out)
}

/// `{ ...current, ...patch }` with `patch.workspaces` de-duplicated, or the
/// error `saveSettings` throws (before anything is cached or written).
pub fn merge(current: &Map<String, Value>, patch: &Value) -> Result<Map<String, Value>, String> {
    let mut next = current.clone();
    nekko_js::spread_into(&mut next, patch);
    if patch.is_null() {
        return Err(read_prop_error(patch, "workspaces"));
    }
    if let Some(ws) = patch.as_object().and_then(|p| p.get("workspaces"))
        && nekko_js::truthy(Some(ws))
    {
        next.insert("workspaces".into(), Value::Array(unique_folders(ws)?));
    }
    Ok(next)
}

/// The settings of one data directory: cached after the first read, saved
/// whole on every change, with every change also published to subscribers.
pub struct SettingsStore {
    path: PathBuf,
    /// Always an object; shared, so a reader that only looks need not copy it.
    cache: Mutex<Option<Arc<Value>>>,
    changed: tokio::sync::watch::Sender<Value>,
}

impl SettingsStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        SettingsStore {
            path: dir.into().join("settings.json"),
            cache: Mutex::new(None),
            changed: tokio::sync::watch::Sender::new(Value::Null),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Arc<Value>>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn load(&self) -> Map<String, Value> {
        if !self.path.exists() {
            return defaults();
        }
        ensure_private(&self.path);
        match std::fs::read(&self.path) {
            Ok(bytes) => from_text(&String::from_utf8_lossy(&bytes)),
            Err(_) => defaults(),
        }
    }

    fn current(&self, cache: &mut Option<Arc<Value>>) -> Arc<Value> {
        cache.get_or_insert_with(|| Arc::new(Value::Object(self.load()))).clone()
    }

    /// `getSettings()`.
    pub fn get(&self) -> Value {
        (*self.shared()).clone()
    }

    /// [`get`](Self::get) without the copy, for a reader that only looks.
    pub fn shared(&self) -> Arc<Value> {
        let mut cache = self.lock();
        self.current(&mut cache)
    }

    /// `saveSettings(patch)`: the new settings, or what it would throw.
    pub fn update(&self, patch: &Value) -> Result<Value, String> {
        let mut cache = self.lock();
        let current = self.current(&mut cache);
        let next = merge(current.as_object().unwrap_or(&Map::new()), patch)?;
        self.commit(&mut cache, next)
    }

    /// `resetSettings()`.
    pub fn reset(&self) -> Result<Value, String> {
        let mut cache = self.lock();
        self.commit(&mut cache, defaults())
    }

    /// Cache, then write, as the TS store does (a failed write leaves the new
    /// value cached and reports the error).
    fn commit(&self, cache: &mut Option<Arc<Value>>, next: Map<String, Value>) -> Result<Value, String> {
        let value = Value::Object(next);
        *cache = Some(Arc::new(value.clone()));
        write_json_atomic(&self.path, &value).map_err(|e| e.to_string())?;
        self.changed.send_replace(value.clone());
        Ok(value)
    }

    /// Every saved change from now on (the receiver starts at `null`, or the
    /// last saved value).
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Value> {
        self.changed.subscribe()
    }
}

#[cfg(unix)]
fn ensure_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn ensure_private(_path: &Path) {}

fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// `writeJsonAtomic`: `JSON.stringify(value, null, 2)` to a private temp file
/// beside the target, flushed to disk, then renamed over it.
pub fn write_json_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json");
    let temp = dir.join(format!(".{name}.{}.tmp", uuid()));
    let text = nekko_js::stringify_pretty(value, "  ");
    let written = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&temp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        rename_retrying(&temp, path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    ensure_private(path);
    Ok(())
}

fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            // Windows refuses a rename over a file another process holds open
            // without delete sharing; that clears in moments.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 20 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(5 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn folder_keys_match_the_ts_rules() {
        assert_eq!(folder_path_key("C:\\code\\"), "c:\\code");
        assert_eq!(folder_path_key("c:/code"), "c:\\code");
        assert_eq!(folder_path_key("D:"), "d:\\");
        assert_eq!(folder_path_key("d:\\\\"), "d:\\");
        assert_eq!(folder_path_key("/home/A/"), "/home/A");
        assert_eq!(folder_path_key("///"), "/");
        assert_eq!(folder_path_key("/"), "/");
        assert_eq!(folder_path_key("x\n//"), "x\n/");
        assert_eq!(folder_path_key("x\n/"), "x\n/");
    }

    #[test]
    fn a_store_round_trips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("nekko-settings-{}", uuid()));
        let store = SettingsStore::new(&dir);
        let rx = store.subscribe();
        assert_eq!(store.get()["theme"], "system");
        store.update(&json!({ "theme": "dark" })).unwrap();
        assert_eq!(rx.borrow()["theme"], "dark");
        assert!(store.update(&Value::Null).is_err());
        assert_eq!(SettingsStore::new(&dir).get()["theme"], "dark");
        store.reset().unwrap();
        assert_eq!(SettingsStore::new(&dir).get()["theme"], "system");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
