//! Files and logs from a paired phone (IO-33 FA-1, FA-5): the daemon's copy
//! of `packages/shared/src/phone-files.ts`. Which arguments a phone may send
//! to `files:*` and `logs:*` (rebuilt from the checked fields; the folder is
//! always named by chat or saved-folder id, a save always carries the hash the
//! phone read) and what it receives back (capped reads, listings and tails;
//! secret-looking files refused, left out and counted; no paths on the
//! computer).
//!
//! The limits and field lists come from `phone-access.json` (`files`); the
//! shared cases in `tests/golden/phone-files.json`, written by the TS, hold the
//! two copies equal.

use crate::phone::Denied;
use crate::phone_changes::secret_file;
use crate::phone_views::pick_keys;
use serde_json::{Map, Value, json};

/// `PHONE_FILES_READ_CHANNELS` and `PHONE_FILES_CHANGE_CHANNELS`.
pub const CHANNELS: [&str; 6] = ["files:list", "files:read", "files:search", "logs:list", "logs:read", "files:write"];

pub fn is_files(channel: &str) -> bool {
    CHANNELS.contains(&channel)
}

/// `PHONE_FILES_VIEW` and the field lists, as the TS wrote them.
#[derive(Debug, Clone, Default)]
pub struct FilesPolicy {
    pub entries: usize,
    pub hits: usize,
    pub hits_default: usize,
    pub read_bytes: usize,
    pub image_chars: usize,
    pub write_bytes: usize,
    pub path_chars: usize,
    pub id_chars: usize,
    pub query_chars: usize,
    pub logs: usize,
    pub log_tail_bytes: usize,
    pub log_search_bytes: usize,
    pub log_matches: usize,
    pub log_line_chars: usize,
    pub log_text_chars: usize,
    pub entry_view: Vec<String>,
    pub file_view: Vec<String>,
    pub write_view: Vec<String>,
    pub log_view: Vec<String>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

impl FilesPolicy {
    /// From `files` in `phone-access.json`; a missing value allows and shows nothing.
    pub fn from_policy(v: &Value) -> Self {
        let n = |k: &str| v["view"][k].as_u64().unwrap_or(0) as usize;
        FilesPolicy {
            entries: n("entries"),
            hits: n("hits"),
            hits_default: n("hitsDefault"),
            read_bytes: n("readBytes"),
            image_chars: n("imageChars"),
            write_bytes: n("writeBytes"),
            path_chars: n("pathChars"),
            id_chars: n("idChars"),
            query_chars: n("queryChars"),
            logs: n("logs"),
            log_tail_bytes: n("logTailBytes"),
            log_search_bytes: n("logSearchBytes"),
            log_matches: n("logMatches"),
            log_line_chars: n("logLineChars"),
            log_text_chars: n("logTextChars"),
            entry_view: strings(&v["entryView"]),
            file_view: strings(&v["fileView"]),
            write_view: strings(&v["writeView"]),
            log_view: strings(&v["logView"]),
        }
    }
}

fn bad(detail: &str) -> Denied {
    Denied { code: "value-invalid", detail: detail.to_string() }
}

fn denied_key(key: &str) -> Denied {
    Denied { code: "option-denied", detail: key.to_string() }
}

/// Length in UTF-16 units, as JavaScript's `s.length`.
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `phoneFilesSecret`: `phoneSecretFile` plus git's stored credentials and a
/// repository's config (the computer's `secret_path` in nekko-workspace).
pub fn secret_path(path: &str) -> bool {
    let p = path.replace('\\', "/").to_lowercase();
    let name = p.rsplit('/').next().unwrap_or("");
    secret_file(&p) || name == ".git-credentials" || p == ".git/config" || p.ends_with("/.git/config")
}

/// A folder whose contents are all secret (`.ssh`, `.aws`, `.gnupg`).
fn secret_dir(path: &str) -> bool {
    !path.is_empty() && secret_path(&format!("{path}/x"))
}

/// The folder: `{ sessionId }`, `{ sessionId, workspaceId }` or `{ workspaceId }`, rebuilt.
fn root(v: Option<&Value>, p: &FilesPolicy) -> Result<Value, Denied> {
    let o = v.and_then(Value::as_object).ok_or_else(|| bad("folder"))?;
    if let Some(k) = o.keys().find(|k| *k != "sessionId" && *k != "workspaceId") {
        return Err(denied_key(k));
    }
    let mut out = Map::new();
    for key in ["sessionId", "workspaceId"] {
        let Some(id) = o.get(key) else { continue };
        match id.as_str() {
            Some(s) if !s.is_empty() && len16(s) <= p.id_chars => {
                out.insert(key.to_string(), id.clone());
            }
            _ => return Err(bad("folder")),
        }
    }
    if out.is_empty() {
        return Err(bad("folder"));
    }
    Ok(Value::Object(out))
}

/// A relative path: text without NUL, not too long. Missing is the folder itself when `empty` allows it.
fn rel_path(v: Option<&Value>, empty: bool, p: &FilesPolicy) -> Result<String, Denied> {
    match v {
        None if empty => Ok(String::new()),
        Some(Value::String(s)) if len16(s) <= p.path_chars && !s.contains('\0') && (empty || !s.is_empty()) => {
            Ok(s.clone())
        }
        _ => Err(bad("path")),
    }
}

/// A whole number of at least 1, clamped to `max`.
fn count(v: &Value, what: &str, max: usize) -> Result<Value, Denied> {
    match v.as_f64() {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= 1.0 => Ok(json!(n.min(max as f64) as u64)),
        _ => Err(bad(what)),
    }
}

/// An options object (or nothing) with only `keys`.
fn options<'a>(v: Option<&'a Value>, keys: &[&str], what: &str) -> Result<Option<&'a Map<String, Value>>, Denied> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(o)) => {
            if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str())) {
                return Err(denied_key(k));
            }
            Ok(Some(o))
        }
        Some(_) => Err(bad(what)),
    }
}

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `screenPhoneFiles`: the arguments to pass to the computer's call, rebuilt
/// from the checked fields, or why the phone's call is refused.
pub fn screen(channel: &str, args: &[Value], p: &FilesPolicy) -> Result<Vec<Value>, Denied> {
    let get = |i: usize| args.get(i);
    Ok(match channel {
        "files:list" => vec![root(get(0), p)?, json!(rel_path(get(1), true, p)?)],
        "files:search" => {
            let r = root(get(0), p)?;
            let q = match get(1) {
                Some(Value::String(q)) if !q.trim().is_empty() && len16(q) <= p.query_chars => q.clone(),
                _ => return Err(bad("query")),
            };
            let limit = match get(2) {
                None | Some(Value::Null) => json!(p.hits_default),
                Some(v) => count(v, "limit", p.hits)?,
            };
            vec![r, json!(q), limit]
        }
        "files:read" => {
            let r = root(get(0), p)?;
            let path = rel_path(get(1), false, p)?;
            if secret_path(&path) {
                return Err(bad("secret file"));
            }
            let o = options(get(2), &["maxBytes"], "read options")?;
            let max = match o.and_then(|o| o.get("maxBytes")) {
                Some(v) => count(v, "maxBytes", p.read_bytes)?,
                None => json!(p.read_bytes),
            };
            vec![r, json!(path), json!({ "maxBytes": max })]
        }
        "files:write" => {
            let r = root(get(0), p)?;
            let path = rel_path(get(1), false, p)?;
            if secret_path(&path) {
                return Err(bad("secret file"));
            }
            let content = match get(2) {
                Some(Value::String(s)) => s.clone(),
                _ => return Err(bad("content")),
            };
            if content.len() > p.write_bytes {
                return Err(bad("content too large"));
            }
            let o = options(get(3), &["expectHash"], "save options")?;
            // A phone saves over the version it read, never blind and never a new file.
            let hash = match o.and_then(|o| o.get("expectHash")).and_then(Value::as_str) {
                Some(h) if hex64(h) => h.to_string(),
                _ => return Err(bad("expectHash")),
            };
            vec![r, json!(path), json!(content), json!({ "expectHash": hash })]
        }
        "logs:list" => Vec::new(),
        "logs:read" => {
            let id = match get(0) {
                Some(Value::String(s)) if !s.is_empty() && len16(s) <= p.id_chars => s.clone(),
                _ => return Err(bad("log id")),
            };
            let o = options(get(1), &["maxMatches", "query", "tailBytes"], "log options")?;
            let mut out = Map::new();
            if let Some(o) = o {
                if let Some(q) = o.get("query") {
                    match q.as_str() {
                        Some(s) if len16(s) <= p.query_chars => {
                            if !s.is_empty() {
                                out.insert("query".into(), q.clone());
                            }
                        }
                        _ => return Err(bad("query")),
                    }
                }
                if let Some(t) = o.get("tailBytes") {
                    let max = if out.contains_key("query") { p.log_search_bytes } else { p.log_tail_bytes };
                    out.insert("tailBytes".into(), count(t, "tailBytes", max)?);
                }
                if let Some(m) = o.get("maxMatches") {
                    out.insert("maxMatches".into(), count(m, "maxMatches", p.log_matches)?);
                }
            }
            vec![json!(id), Value::Object(out)]
        }
        _ => return Err(bad(channel)),
    })
}

/// `cutText`: the first `n` UTF-16 units, a surrogate pair cut in half dropped.
fn cut_text(s: &str, n: usize) -> String {
    crate::hello::cut16(s, n).to_string()
}

/// `tailText`: the last `n` UTF-16 units, a surrogate pair cut in half dropped.
fn tail_text(s: &str, n: usize) -> String {
    let total = len16(s);
    if total <= n {
        return s.to_string();
    }
    let skip = total - n;
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= skip {
            return s[i..].to_string();
        }
        units += c.len_utf16();
    }
    String::new()
}

/// A count the computer sent, or 0.
fn num(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991).unwrap_or(0)
}

fn keys(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn listing(r: &Value, p: &FilesPolicy) -> Value {
    let Some(o) = r.as_object() else { return Value::Null };
    let mut out = pick_keys(r, &keys(&["hiddenLinks", "path", "total"]));
    let mut hidden = num(o.get("hiddenSecrets"));
    let mut entries = Vec::new();
    for e in o.get("entries").and_then(Value::as_array).into_iter().flatten() {
        let Some(path) = e.as_object().and_then(|m| m.get("path")).and_then(Value::as_str) else { continue };
        let secret = if e.get("dir") == Some(&Value::Bool(true)) { secret_dir(path) } else { secret_path(path) };
        if secret {
            hidden += 1;
            continue;
        }
        entries.push(Value::Object(pick_keys(e, &p.entry_view)));
    }
    let cut = entries.len() > p.entries;
    entries.truncate(p.entries);
    out.insert("entries".into(), Value::Array(entries));
    out.insert("truncated".into(), json!(o.get("truncated") == Some(&Value::Bool(true)) || cut));
    out.insert("hiddenSecrets".into(), json!(hidden));
    Value::Object(out)
}

fn search(r: &Value, p: &FilesPolicy) -> Value {
    let Some(o) = r.as_object() else { return Value::Null };
    let mut hits = Vec::new();
    for h in o.get("hits").and_then(Value::as_array).into_iter().flatten() {
        let Some(path) = h.as_object().and_then(|m| m.get("path")).and_then(Value::as_str) else { continue };
        if secret_path(path) {
            continue;
        }
        hits.push(Value::Object(pick_keys(h, &keys(&["name", "path"]))));
    }
    let cut = hits.len() > p.hits;
    hits.truncate(p.hits);
    json!({
        "hits": hits,
        "truncated": o.get("truncated") == Some(&Value::Bool(true)) || cut,
        "complete": o.get("complete") == Some(&Value::Bool(true)),
    })
}

fn file(r: &Value, p: &FilesPolicy) -> Value {
    let Some(o) = r.as_object() else { return Value::Null };
    match o.get("path").and_then(Value::as_str) {
        Some(path) if !secret_path(path) => {}
        _ => return Value::Null,
    }
    let mut out = pick_keys(r, &p.file_view);
    if let Some(Value::String(content)) = o.get("content") {
        if len16(content) > p.read_bytes {
            out.insert("content".into(), json!(cut_text(content, p.read_bytes)));
            out.insert("truncated".into(), json!(true));
            out.insert("editable".into(), json!(false));
        } else {
            out.insert("content".into(), json!(content));
        }
    }
    if let Some(Value::String(url)) = o.get("imageDataUrl")
        && url.starts_with("data:image/")
        && len16(url) <= p.image_chars
    {
        out.insert("imageDataUrl".into(), json!(url));
    }
    Value::Object(out)
}

fn log_read(r: &Value, p: &FilesPolicy) -> Value {
    let Some(o) = r.as_object() else { return Value::Null };
    let mut out = pick_keys(r, &keys(&["id", "moreMatches", "query", "size", "truncated", "updatedAt"]));
    if let Some(Value::String(text)) = o.get("text") {
        out.insert("text".into(), json!(tail_text(text, p.log_text_chars)));
        if len16(text) > p.log_text_chars {
            out.insert("truncated".into(), json!(true));
        }
    }
    if let Some(Value::Array(list)) = o.get("matches") {
        let matches: Vec<&Map<String, Value>> = list.iter().filter_map(Value::as_object).collect();
        let kept = matches
            .iter()
            .take(p.log_matches)
            .map(|m| {
                let mut one = Map::new();
                if let Some(line) = m.get("line") {
                    one.insert("line".into(), line.clone());
                }
                let text = m.get("text").and_then(Value::as_str).map(|t| cut_text(t, p.log_line_chars));
                one.insert("text".into(), json!(text.unwrap_or_default()));
                Value::Object(one)
            })
            .collect();
        out.insert("matches".into(), Value::Array(kept));
        if matches.len() > p.log_matches {
            out.insert("moreMatches".into(), json!(true));
        }
    }
    Value::Object(out)
}

/// `phoneFilesView`: what a phone receives for a files or logs call.
pub fn view(channel: &str, result: &Value, p: &FilesPolicy) -> Value {
    match channel {
        "files:list" => listing(result, p),
        "files:search" => search(result, p),
        "files:read" => file(result, p),
        "files:write" => {
            if result.is_object() {
                Value::Object(pick_keys(result, &p.write_view))
            } else {
                Value::Null
            }
        }
        "logs:list" => match result.as_array() {
            Some(list) => Value::Array(
                list.iter()
                    .filter(|l| l.is_object())
                    .take(p.logs)
                    .map(|l| Value::Object(pick_keys(l, &p.log_view)))
                    .collect(),
            ),
            None => json!([]),
        },
        "logs:read" => log_read(result, p),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> &'static FilesPolicy {
        &crate::phone::policy().files
    }

    #[test]
    fn the_policy_carries_the_limits() {
        let p = policy();
        assert_eq!((p.entries, p.hits, p.read_bytes, p.write_bytes), (500, 100, 262_144, 262_144));
        assert_eq!((p.log_tail_bytes, p.log_search_bytes, p.log_matches), (262_144, 8 * 1024 * 1024, 500));
        assert!(p.file_view.iter().any(|k| k == "hash") && !p.file_view.iter().any(|k| k == "content"));
    }

    #[test]
    fn secret_paths_match_the_computers_rule() {
        for path in [
            ".env",
            "a/.env.local",
            ".ssh/config",
            "x/.aws/credentials",
            "k.pem",
            ".git/config",
            "a/.git/config",
            ".git-credentials",
        ] {
            assert!(secret_path(path), "{path}");
            assert!(nekko_like_secret(path), "{path}");
        }
        for path in ["src/env.ts", ".github/ci.yml", ".git/HEAD", "gitconfig"] {
            assert!(!secret_path(path), "{path}");
        }
        assert!(secret_dir(".ssh") && secret_dir("a/.gnupg") && !secret_dir("src") && !secret_dir(""));
    }

    /// The rule in crates/nekko-workspace/src/scoped.rs, written out again so a
    /// drift between the two is caught here (nekko-remote does not depend on it).
    fn nekko_like_secret(path: &str) -> bool {
        let p = path.to_lowercase();
        let name = p.rsplit('/').next().unwrap_or("");
        [".ssh/", ".aws/", ".gnupg/"].iter().any(|d| p.starts_with(d) || p.contains(&format!("/{d}")))
            || name.starts_with(".env")
            || name.starts_with("id_")
            || [".npmrc", ".netrc", ".pypirc", "credentials", ".git-credentials"].contains(&name)
            || p == ".git/config"
            || p.ends_with("/.git/config")
            || [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"].iter().any(|e| name.ends_with(e))
    }

    #[test]
    fn a_save_fits_what_a_phone_could_read() {
        let hash = "0".repeat(64);
        let fits = "é".repeat(policy().write_bytes / 2);
        let args = [json!({ "sessionId": "s" }), json!("a.md"), json!(fits), json!({ "expectHash": hash })];
        assert!(screen("files:write", &args, policy()).is_ok());
        let args =
            [json!({ "sessionId": "s" }), json!("a.md"), json!(format!("{fits}a")), json!({ "expectHash": hash })];
        assert_eq!(screen("files:write", &args, policy()).unwrap_err(), bad("content too large"));
    }

    #[test]
    fn long_reads_and_tails_are_cut_like_the_ts() {
        let p = policy();
        let content = format!("{}😀tail", "x".repeat(p.read_bytes - 1));
        let v =
            view("files:read", &json!({ "path": "a.txt", "kind": "text", "content": content, "editable": true }), p);
        assert_eq!(len16(v["content"].as_str().unwrap()), p.read_bytes - 1);
        assert_eq!((v["truncated"].clone(), v["editable"].clone()), (json!(true), json!(false)));
        let text = format!("😀{}", "y".repeat(p.log_text_chars - 1));
        let v = view("logs:read", &json!({ "id": "daemon", "text": text, "truncated": false }), p);
        assert_eq!(v["text"], json!("y".repeat(p.log_text_chars - 1)));
        assert_eq!(v["truncated"], json!(true));
        assert_eq!(tail_text("ab😀cd", 3), "cd");
        assert_eq!(tail_text("ab😀cd", 4), "😀cd");
    }
}
