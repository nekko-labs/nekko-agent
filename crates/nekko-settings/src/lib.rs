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
//!
//! One thing differs from the TS store: the [`SECRETS`] (API keys and tokens)
//! live in the OS keystore when there is one, and settings.json leaves them
//! out (decision 0046). Every value handed back still carries them.

use nekko_vault::Vault;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
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

/// The secrets in the settings (`SECRET_FIELDS` in packages/shared's
/// settings.ts, which a backup leaves out), as (list, id field, secret field): a list's
/// entries are told apart by their id (a connector by its kind). An empty
/// list name means the top level, an empty id field an object.
pub const SECRETS: &[(&str, &str, &str)] = &[
    ("providers", "id", "apiKey"),
    ("connectors", "kind", "token"),
    ("mcpServers", "id", "token"),
    ("", "", "hfToken"),
    ("", "", "typesafeApiKey"),
    ("engine", "", "apiKey"),
    ("apiServer", "", "token"),
];

/// Call `f(name, holder, field)` for every place a secret can sit, named for
/// the keystore (`providers.<id>.apiKey`, `hfToken`).
fn each_secret(s: &mut Map<String, Value>, mut f: impl FnMut(String, &mut Map<String, Value>, &str)) {
    for &(list, id, field) in SECRETS {
        if list.is_empty() {
            f(field.to_string(), s, field);
        } else if id.is_empty() {
            if let Some(o) = s.get_mut(list).and_then(Value::as_object_mut) {
                f(format!("{list}.{field}"), o, field);
            }
        } else {
            for o in
                s.get_mut(list).and_then(Value::as_array_mut).into_iter().flatten().filter_map(Value::as_object_mut)
            {
                if let Some(key) = o.get(id).and_then(Value::as_str).filter(|k| !k.is_empty()) {
                    f(format!("{list}.{key}.{field}"), o, field);
                }
            }
        }
    }
}

/// The settings of one data directory: cached after the first read, saved
/// whole on every change, with every change also published to subscribers.
pub struct SettingsStore {
    path: PathBuf,
    /// Always an object; shared, so a reader that only looks need not copy it.
    cache: Mutex<Option<Arc<Value>>>,
    changed: tokio::sync::watch::Sender<Value>,
    /// Where the secrets go; `None` keeps them in settings.json (0600), for a
    /// computer without a keystore.
    vault: Option<Box<dyn Vault>>,
    /// The secrets the vault holds, by name, as saved. Locked only under `cache`.
    vaulted: Mutex<HashMap<String, String>>,
}

impl SettingsStore {
    /// A store that keeps its secrets in settings.json.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self::with_vault(dir, None)
    }

    /// A store whose secrets live in `vault`.
    pub fn with_vault(dir: impl Into<PathBuf>, vault: Option<Box<dyn Vault>>) -> Self {
        SettingsStore {
            path: dir.into().join("settings.json"),
            cache: Mutex::new(None),
            changed: tokio::sync::watch::Sender::new(Value::Null),
            vault,
            vaulted: Mutex::new(HashMap::new()),
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
        let file = match std::fs::read(&self.path) {
            Ok(bytes) => from_text(&String::from_utf8_lossy(&bytes)),
            Err(_) => return defaults(),
        };
        let Some(vault) = self.vault.as_deref() else { return file };
        // Secrets the file leaves out come back from the vault.
        let mut s = file.clone();
        let mut vaulted = self.vaulted.lock().unwrap_or_else(|e| e.into_inner());
        each_secret(&mut s, |name, o, field| {
            if !o.contains_key(field)
                && let Some(v) = nekko_vault::get(vault, &name)
            {
                o.insert(field.into(), Value::String(v.clone()));
                vaulted.insert(name, v);
            }
        });
        // Secrets the file still holds (an older build's, or a save the vault
        // refused) move to the vault, and leave the file once read back.
        let disk = self.stash(vault, &mut vaulted, &s);
        if disk != file {
            let _ = write_json_atomic(&self.path, &Value::Object(disk));
        }
        s
    }

    /// Save every secret in `s` to the vault (one already there as it is is
    /// left alone), forget the ones `s` no longer has, and return what
    /// settings.json keeps: `s` without each secret the vault read back.
    fn stash(
        &self,
        vault: &dyn Vault,
        vaulted: &mut HashMap<String, String>,
        s: &Map<String, Value>,
    ) -> Map<String, Value> {
        let mut disk = s.clone();
        let mut now: HashMap<String, String> = HashMap::new();
        each_secret(&mut disk, |name, o, field| {
            let Some(v) = o.get(field).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string) else {
                return;
            };
            match now.get(&name) {
                // Two entries with one id: the first holds the vault item, this one stays in the file.
                Some(first) if *first != v => return,
                Some(_) => {}
                None if vaulted.get(&name) == Some(&v) || nekko_vault::put(vault, &name, &v) => {
                    now.insert(name, v);
                }
                None => return,
            }
            o.shift_remove(field);
        });
        for gone in vaulted.keys().filter(|k| !now.contains_key(*k)) {
            nekko_vault::delete(vault, gone);
        }
        *vaulted = now;
        disk
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

    /// `resetSettings()`. The vault's secrets go too.
    pub fn reset(&self) -> Result<Value, String> {
        let mut cache = self.lock();
        if self.vault.is_some() {
            // Read first, so the vault's items are known and can be deleted.
            self.current(&mut cache);
        }
        self.commit(&mut cache, defaults())
    }

    /// Cache, then write, as the TS store does (a failed write leaves the new
    /// value cached and reports the error).
    fn commit(&self, cache: &mut Option<Arc<Value>>, next: Map<String, Value>) -> Result<Value, String> {
        let disk = match self.vault.as_deref() {
            Some(vault) => {
                let mut vaulted = self.vaulted.lock().unwrap_or_else(|e| e.into_inner());
                Value::Object(self.stash(vault, &mut vaulted, &next))
            }
            None => Value::Object(next.clone()),
        };
        let value = Value::Object(next);
        *cache = Some(Arc::new(value.clone()));
        write_json_atomic(&self.path, &disk).map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod secret_tests {
    use super::*;
    use nekko_vault::FileVault;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nekko-settings-secrets-{name}-{}", nekko_js::uuid()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn keystore(d: &Path) -> Option<Box<dyn Vault>> {
        Some(Box::new(FileVault::new(d.join("keystore.json"))))
    }

    fn on_disk(d: &Path) -> String {
        std::fs::read_to_string(d.join("settings.json")).unwrap()
    }

    const OLD: &str = r#"{"theme":"dark","hfToken":"hf_x","providers":[{"id":"p1","kind":"openai","apiKey":"sk-1"},{"id":"p2","kind":"ollama"}],"apiServer":{"enabled":true,"token":"t0"}}"#;

    #[test]
    fn an_older_file_moves_its_secrets_to_the_keystore_on_first_read() {
        let d = dir("migrate");
        std::fs::write(d.join("settings.json"), OLD).unwrap();
        let store = SettingsStore::with_vault(&d, keystore(&d));
        let s = store.get();
        assert_eq!((s["providers"][0]["apiKey"].clone(), s["hfToken"].clone()), (json!("sk-1"), json!("hf_x")));
        assert_eq!(s["apiServer"]["token"], "t0");
        let file = on_disk(&d);
        assert!(!file.contains("sk-1") && !file.contains("hf_x") && !file.contains("t0"), "{file}");
        assert!(file.contains("\"p1\"") && file.contains("\"dark\""));
        let vault = FileVault::new(d.join("keystore.json"));
        assert_eq!(vault.get("providers.p1.apiKey").as_deref(), Some("sk-1"));
        // A restart reads them back from the keystore, and changes nothing.
        let again = SettingsStore::with_vault(&d, keystore(&d)).get();
        assert_eq!(again, s);
        assert_eq!(on_disk(&d), file);
        let _ = std::fs::remove_dir_all(d);
    }

    /// A keystore that will not save.
    struct Locked;
    impl Vault for Locked {
        fn get(&self, _: &str) -> Option<String> {
            None
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
        fn delete(&self, _: &str) {}
        fn kind(&self) -> &'static str {
            "locked"
        }
    }

    #[test]
    fn a_keystore_that_will_not_save_leaves_every_key_in_the_file() {
        let d = dir("locked");
        std::fs::write(d.join("settings.json"), OLD).unwrap();
        let store = SettingsStore::with_vault(&d, Some(Box::new(Locked)));
        assert_eq!(store.get()["providers"][0]["apiKey"], "sk-1");
        assert_eq!(on_disk(&d), OLD, "nothing rewritten");
        store.update(&json!({ "theme": "light" })).unwrap();
        let file = on_disk(&d);
        assert!(file.contains("sk-1") && file.contains("hf_x"), "{file}");
        assert_eq!(SettingsStore::with_vault(&d, Some(Box::new(Locked))).get()["hfToken"], "hf_x");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn saves_keep_keys_out_of_the_file_and_removed_keys_leave_the_keystore() {
        let d = dir("saves");
        let store = SettingsStore::with_vault(&d, keystore(&d));
        let p = |key: Option<&str>| {
            let mut p = json!({ "id": "p1", "kind": "openai", "enabled": true });
            if let Some(k) = key {
                p["apiKey"] = json!(k);
            }
            json!({ "providers": [p], "connectors": [{ "kind": "github", "token": "ghp_1" }] })
        };
        store.update(&p(Some("sk-a"))).unwrap();
        store.update(&json!({ "theme": "dark" })).unwrap();
        store.update(&p(Some("sk-b"))).unwrap();
        assert!(
            !on_disk(&d).contains("sk-a") && !on_disk(&d).contains("sk-b") && !on_disk(&d).contains("ghp_1"),
            "{}",
            on_disk(&d)
        );
        let vault = FileVault::new(d.join("keystore.json"));
        assert_eq!(vault.get("providers.p1.apiKey").as_deref(), Some("sk-b"));
        assert_eq!(vault.get("connectors.github.token").as_deref(), Some("ghp_1"));
        let reopened = SettingsStore::with_vault(&d, keystore(&d));
        assert_eq!(reopened.get()["providers"][0]["apiKey"], "sk-b");
        reopened.update(&p(None)).unwrap();
        assert_eq!(vault.get("providers.p1.apiKey"), None);
        assert!(SettingsStore::with_vault(&d, keystore(&d)).get()["providers"][0].get("apiKey").is_none());
        // A reset deletes them all, read first if nothing was yet.
        SettingsStore::with_vault(&d, keystore(&d)).reset().unwrap();
        assert_eq!(std::fs::read_to_string(d.join("keystore.json")).unwrap().trim(), "{}");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn two_entries_with_one_id_keep_both_keys() {
        let d = dir("dupes");
        let store = SettingsStore::with_vault(&d, keystore(&d));
        let both = json!({ "providers": [{ "id": "p", "apiKey": "a" }, { "id": "p", "apiKey": "b" }] });
        store.update(&both).unwrap();
        let again = SettingsStore::with_vault(&d, keystore(&d)).get();
        assert_eq!(
            (again["providers"][0]["apiKey"].clone(), again["providers"][1]["apiKey"].clone()),
            (json!("a"), json!("b"))
        );
        let _ = std::fs::remove_dir_all(d);
    }
}
