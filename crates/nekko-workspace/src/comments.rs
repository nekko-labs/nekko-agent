//! Inline editor comments, ported from `packages/host/src/comments.ts`:
//! `comments:list`, `comment:add`, `comment:resolve`.
//!
//! One JSON file, `<data>/comments.json`, keyed by the file's path, in
//! `JSON.stringify(store, null, 2)` layout. Writes are serialized here and
//! land atomically (the TS store wrote in place).

use nekko_js as js;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::now_ms;

/// One writer at a time: each call is a read-modify-write of the whole file.
static LOCK: Mutex<()> = Mutex::new(());

fn file(data_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    Ok(data_dir.join("comments.json"))
}

/// `load()`: the parsed store, `{}` when missing or unreadable, with keys in
/// the order `JSON.parse` gives them.
fn load(data_dir: &Path) -> Value {
    let Ok(p) = file(data_dir) else { return json!({}) };
    std::fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_str::<Value>(&String::from_utf8_lossy(&b)).ok())
        .map(js::js_order)
        .unwrap_or_else(|| json!({}))
}

fn save(data_dir: &Path, store: &Value) -> Result<(), String> {
    crate::write_atomic(&file(data_dir)?, js::stringify_pretty(&js::js_order(store.clone()), "  ").as_bytes())
}

/// `String(path)`, the store's key, for a path that may be missing.
pub fn key_of(path: Option<&Value>) -> String {
    path.map_or_else(|| "undefined".into(), js::display)
}

/// `a - b` as the sort comparator computes it: NaN when either is not a number.
fn minus(a: Option<&Value>, b: Option<&Value>) -> f64 {
    let n = |v: Option<&Value>| match v {
        // Subtraction coerces like `Number()`, except that `undefined` is NaN.
        None => f64::NAN,
        Some(v) => js::to_number(Some(v)),
    };
    n(a) - n(b)
}

/// The comparator's sign, where NaN and 0 both mean "tie".
fn sign(d: f64) -> std::cmp::Ordering {
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// `listComments(path)` over an already loaded store: by line, then by age.
fn list_in(store: &Value, key: &str) -> Value {
    let mut list = match store.get(key) {
        Some(Value::Array(a)) => a.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(other) => return other.clone(),
    };
    list.sort_by(|a, b| {
        let line = minus(a.get("line"), b.get("line"));
        // `x || y`: a zero or NaN difference falls through to the next key.
        if js::truthy_number(line) { sign(line) } else { sign(minus(a.get("createdAt"), b.get("createdAt"))) }
    });
    Value::Array(list)
}

pub fn list(data_dir: &Path, path: Option<&Value>) -> Value {
    list_in(&load(data_dir), &key_of(path))
}

/// `crypto.randomUUID()`.
fn uuid_v4() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
}

/// `addComment(path, line, lineText, comment)`: returns the file's comments
/// as they now read from disk.
pub fn add(
    data_dir: &Path,
    path: Option<&Value>,
    line: Option<&Value>,
    line_text: Option<&Value>,
    comment: Option<&Value>,
) -> Result<Value, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = key_of(path);
    let mut store = load(data_dir);
    let mut entry = Map::new();
    entry.insert("id".into(), json!(uuid_v4()?));
    // `undefined` fields vanish in JSON.stringify.
    for (k, v) in [("path", path), ("line", line), ("lineText", line_text), ("comment", comment)] {
        if let Some(v) = v {
            entry.insert(k.into(), v.clone());
        }
    }
    entry.insert("createdAt".into(), json!(now_ms()));
    let Value::Object(map) = &mut store else {
        return Err("Cannot add a comment: comments.json is not an object".into());
    };
    let mut list = match map.get(&key) {
        Some(Value::Array(a)) => a.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => return Err("store[path] is not iterable".into()),
    };
    list.push(Value::Object(entry));
    map.insert(key.clone(), Value::Array(list));
    save(data_dir, &store)?;
    Ok(list_in(&load(data_dir), &key))
}

/// `resolveComment(path, id)`: removes it, and the file's key once empty.
pub fn resolve(data_dir: &Path, path: Option<&Value>, id: Option<&Value>) -> Result<Value, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = key_of(path);
    let mut store = load(data_dir);
    let Value::Object(map) = &mut store else {
        return Err("Cannot resolve a comment: comments.json is not an object".into());
    };
    let kept: Vec<Value> = match map.get(&key) {
        Some(Value::Array(a)) => a.iter().filter(|c| c.get("id") != id).cloned().collect(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => return Err("(store[path] ?? []).filter is not a function".into()),
    };
    if kept.is_empty() {
        map.shift_remove(&key);
    } else {
        map.insert(key.clone(), Value::Array(kept));
    }
    save(data_dir, &store)?;
    Ok(list_in(&load(data_dir), &key))
}
