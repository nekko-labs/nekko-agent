//! `settings.json`, owned by the engine daemon.
//!
//! The daemon is the file's single writer: the UI's `settings:get`,
//! `settings:update` and `settings:reset` land here, and the TS host sends its
//! own writes here too instead of touching the file. This is a port of the TS
//! host's `store.ts` (`getSettings`, `saveSettings`, `resetSettings`) down to
//! JavaScript's object spread, property order and `JSON.stringify` output, so
//! the file and every value handed back are byte for byte what the TS store
//! produced. `tests/golden.rs` holds it to a frozen record of the deleted TS
//! functions; packages/shared's `engine-data.golden.test.ts` keeps the accents
//! in the embedded defaults current.

use serde_json::{Map, Value, json};
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
    if s.contains_key("autoResumeOnInternetRestore") {
        s.insert(
            "autoResumeOnInternetRestore".into(),
            json!(s.get("autoResumeOnInternetRestore") == Some(&Value::Bool(true))),
        );
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
    // Merge Mode changes under this store's write lock. Independent windows
    // send only changed fields, so an old renderer cannot erase another choice.
    if let Some(fields) = patch.get("defaultSessionOptions").and_then(Value::as_object) {
        let mut defaults = current.get("defaultSessionOptions").and_then(Value::as_object).cloned().unwrap_or_default();
        for (key, value) in fields {
            if key == "effort" && value.is_null() {
                // "Use the app default" must also override a starred mode's effort.
                let effort =
                    next.get("effort").filter(|v| !v.is_null()).cloned().unwrap_or(Value::String("normal".into()));
                defaults.insert(key.clone(), effort);
            } else if value.is_null() {
                defaults.shift_remove(key);
            } else {
                defaults.insert(key.clone(), value.clone());
            }
        }
        next.insert("defaultSessionOptions".into(), Value::Object(defaults));
    }
    // An explicit new starred mode replaces the last-used bundle.
    if patch.get("defaultSavedModeId").is_some() {
        next.shift_remove("defaultSessionOptions");
    }
    for (setting, field) in
        [("effort", "effort"), ("defaultChatMode", "mode"), ("defaultExecutionMode", "executionMode")]
    {
        if let Some(value) = patch.get(setting)
            && let Some(defaults) = next.get_mut("defaultSessionOptions").and_then(Value::as_object_mut)
        {
            defaults.insert(field.into(), value.clone());
            if field == "executionMode" {
                defaults.insert("gitIsolation".into(), Value::Bool(value.as_str() == Some("worktree")));
            }
        }
    }
    if next.contains_key("autoResumeOnInternetRestore") {
        next.insert(
            "autoResumeOnInternetRestore".into(),
            json!(next.get("autoResumeOnInternetRestore") == Some(&Value::Bool(true))),
        );
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

/// `writeJsonAtomic`: `JSON.stringify(value, null, 2)` to a private temp file
/// beside the target, flushed to disk, then renamed over it.
pub fn write_json_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = nekko_js::stringify_pretty(value, "  ");
    nekko_js::fs::atomic_write(path, text.as_bytes(), nekko_js::fs::AtomicWrite::PRIVATE)
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
        let dir = std::env::temp_dir().join(format!("nekko-settings-{}", nekko_js::uuid()));
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

#[cfg(test)]
mod chat_defaults_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clearing_effort_uses_app_default_even_with_a_starred_mode() {
        let current = json!({ "effort": "low", "defaultSavedModeId": "custom",
            "defaultSessionOptions": { "effort": "max", "memory": "off" } });
        let next =
            merge(current.as_object().unwrap(), &json!({ "defaultSessionOptions": { "effort": null } })).unwrap();
        assert_eq!(next["defaultSessionOptions"], json!({ "effort": "low", "memory": "off" }));
    }

    #[test]
    fn unstar_clears_overrides_and_new_manual_choices_merge_afterwards() {
        let current = json!({ "defaultSavedModeId": "fusion", "defaultSessionOptions": { "memory": "off" } });
        let next = merge(current.as_object().unwrap(), &json!({ "defaultSavedModeId": null })).unwrap();
        assert!(next.get("defaultSessionOptions").is_none());
        assert!(next["defaultSavedModeId"].is_null());
        let next = merge(&next, &json!({ "defaultSessionOptions": { "memory": "project", "mode": "ask" } })).unwrap();
        let next = merge(&next, &json!({ "defaultSessionOptions": { "memory": null, "mode": "yolo" } })).unwrap();
        assert_eq!(next["defaultSessionOptions"], json!({ "mode": "yolo" }));
    }

    #[test]
    fn independent_windows_merge_choices_and_restart_keeps_them() {
        let dir = std::env::temp_dir().join(format!("nekko-settings-chat-defaults-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(SettingsStore::new(dir.clone()));
        let a = store.clone();
        let b = store.clone();
        let a = std::thread::spawn(move || a.update(&json!({ "defaultSessionOptions": { "effort": "max" } })).unwrap());
        let b = std::thread::spawn(move || {
            b.update(&json!({ "defaultSessionOptions": { "mode": "ask", "memory": "off" } })).unwrap()
        });
        a.join().unwrap();
        b.join().unwrap();
        let reopened = SettingsStore::new(dir.clone());
        assert_eq!(reopened.get()["defaultSessionOptions"], json!({ "effort": "max", "mode": "ask", "memory": "off" }));
        let cleared = reopened.update(&json!({ "defaultSessionOptions": { "effort": null } })).unwrap();
        assert_eq!(cleared["defaultSessionOptions"], json!({ "mode": "ask", "memory": "off", "effort": "normal" }));
        let explicit = reopened.update(&json!({ "effort": "low", "defaultChatMode": "guardrails" })).unwrap();
        assert_eq!(
            explicit["defaultSessionOptions"],
            json!({ "mode": "guardrails", "memory": "off", "effort": "low" })
        );
        let starred = reopened.update(&json!({ "defaultSavedModeId": "fusion" })).unwrap();
        assert!(starred.get("defaultSessionOptions").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
