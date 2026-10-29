//! Files in one folder, for callers that must not reach outside it (IO-33
//! FA-1): `files:list`, `files:search`, `files:read` and `files:write`.
//!
//! The desktop's own explorer keeps `file:read` / `file:write` / `dir:list`
//! ([`crate::files`]), which take absolute paths because the user browses
//! their own disk. These take a path relative to a root the daemon chose (a
//! chat's checkout or a saved folder; the caller never names it) and refuse
//! anything that leaves it: `..`, absolute paths, and symlinks that resolve
//! outside. Files that may hold secrets are counted in a listing and never
//! named, read or written (the same rule as the phone's Changes view, plus
//! git's credentials). A save carries the hash of the file it was based on and
//! is refused with the current hash when the file moved on since, so a phone
//! never overwrites a newer desktop edit.
//!
//! Errors are `"<code>: <message>"`, the code one of [`codes`].

use crate::outline::IGNORED_DIRS;
use nekko_js as js;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Entries a listing returns; the rest are counted in `total`.
pub const LIST_CAP: usize = 500;
/// Entries read from one folder before the listing stops looking.
const SCAN_CAP: usize = 20_000;
/// Text bytes a read returns unless the caller asks for fewer.
pub const READ_DEFAULT: usize = 256 * 1024;
/// The most text bytes a read returns, whatever the caller asks.
pub const READ_MAX: usize = 1024 * 1024;
/// Images larger than this are described, not sent.
pub const IMAGE_CAP: u64 = 2 * 1024 * 1024;
/// Files larger than this have no hash (and so cannot be saved over).
const HASH_CAP: u64 = 64 * 1024 * 1024;
/// The largest text a save accepts, and the largest file it replaces.
pub const WRITE_CAP: usize = 1024 * 1024;
/// Hits a search returns by default, and at most.
pub const SEARCH_DEFAULT: usize = 50;
pub const SEARCH_MAX: usize = 200;
/// Files a search looks at before it stops.
const SEARCH_SCAN: usize = 50_000;
/// Bytes looked at for a NUL when deciding a file is not text.
const SNIFF: usize = 8 * 1024;

/// The error codes, the part of an error before `": "`.
pub mod codes {
    /// `..`, an absolute path, or a symlink that resolves outside the root.
    pub const OUTSIDE_ROOT: &str = "outside-root";
    /// A path that may hold secrets.
    pub const SECRET_FILE: &str = "secret-file";
    pub const NOT_FOUND: &str = "not-found";
    pub const NOT_A_FILE: &str = "not-a-file";
    pub const NOT_A_FOLDER: &str = "not-a-folder";
    /// A save over a file that is not text.
    pub const BINARY: &str = "binary";
    /// A save over the size cap, or over a file over it.
    pub const TOO_LARGE: &str = "too-large";
    /// An argument of the wrong shape.
    pub const BAD_REQUEST: &str = "bad-request";
    pub const IO: &str = "io";
}

fn fail(code: &str, message: impl std::fmt::Display) -> String {
    format!("{code}: {message}")
}

/// Paths whose content never leaves the computer through these calls:
/// `phoneSecretFile` (crates/nekko-remote/src/phone_changes.rs,
/// packages/shared/src/phone-changes.ts), plus git's stored credentials and a
/// repository's config (a remote URL can carry a token). `path` is relative
/// to the root, `/`-separated.
pub fn secret_path(path: &str) -> bool {
    let p = path.replace('\\', "/").to_lowercase();
    let name = p.rsplit('/').next().unwrap_or("");
    for dir in [".ssh/", ".aws/", ".gnupg/"] {
        if p.starts_with(dir) || p.contains(&format!("/{dir}")) {
            return true;
        }
    }
    if name.starts_with(".env") || name.starts_with("id_") {
        return true;
    }
    if [".npmrc", ".netrc", ".pypirc", "credentials", ".git-credentials"].contains(&name) {
        return true;
    }
    if p == ".git/config" || p.ends_with("/.git/config") {
        return true;
    }
    [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"].iter().any(|ext| name.ends_with(ext))
}

/// A folder whose contents are all secret (`.ssh`, `.aws`, `.gnupg`).
fn secret_dir(path: &str) -> bool {
    secret_path(&format!("{path}/x"))
}

/// A syntax-colouring hint from a file's name, in highlight.js / Prism names.
pub fn language(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    match name.as_str() {
        "dockerfile" | "containerfile" => return Some("dockerfile"),
        "makefile" | "gnumakefile" => return Some("makefile"),
        "cmakelists.txt" => return Some("cmake"),
        _ => {}
    }
    let ext = match name.rfind('.') {
        Some(0) | None => return None,
        Some(i) => &name[i + 1..],
    };
    Some(match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "json" | "jsonc" | "json5" => "json",
        "md" | "markdown" | "mdx" => "markdown",
        "py" | "pyi" => "python",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "rb" => "ruby",
        "php" => "php",
        "cs" => "csharp",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "m" | "mm" => "objectivec",
        "sh" | "bash" | "zsh" => "bash",
        "ps1" | "psm1" => "powershell",
        "bat" | "cmd" => "dos",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "ini" | "cfg" | "conf" => "ini",
        "xml" | "plist" | "svg" | "xaml" | "csproj" => "xml",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "sql" => "sql",
        "vue" => "vue",
        "svelte" => "svelte",
        "lua" => "lua",
        "r" => "r",
        "dart" => "dart",
        "scala" => "scala",
        "gradle" | "groovy" => "groovy",
        "graphql" | "gql" => "graphql",
        "proto" => "protobuf",
        "diff" | "patch" => "diff",
        "tf" | "hcl" => "hcl",
        "zig" => "zig",
        "ex" | "exs" => "elixir",
        "hs" => "haskell",
        "clj" | "cljs" => "clojure",
        "txt" | "log" => "plaintext",
        _ => return None,
    })
}

fn image_mime(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    if !lower.contains('.') {
        return None;
    }
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn has_signature(mime: &str, buf: &[u8]) -> bool {
    match mime {
        "image/png" => buf.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => buf.starts_with(&[255, 216, 255]),
        "image/gif" => buf.starts_with(b"GIF87a") || buf.starts_with(b"GIF89a"),
        "image/webp" => buf.len() >= 12 && &buf[..4] == b"RIFF" && &buf[8..12] == b"WEBP",
        _ => false,
    }
}

fn base64(bytes: &[u8]) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// sha256 of a whole file, read in chunks; None past [`HASH_CAP`].
fn file_hash(path: &Path, size: u64) -> Result<Option<String>, String> {
    if size > HASH_CAP {
        return Ok(None);
    }
    let mut f = std::fs::File::open(path).map_err(|e| io_err(&e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| io_err(&e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(Some(hex(&h.finalize())))
}

/// sha256 of some bytes, as hex.
pub fn hash_bytes(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn io_err(e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        fail(codes::NOT_FOUND, "no such file or folder")
    } else {
        fail(codes::IO, e)
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// One folder, as the root of everything these calls touch.
#[derive(Debug, Clone)]
pub struct Scope {
    /// Canonical: symlinks resolved, so `starts_with` is a real containment test.
    root: PathBuf,
}

/// A path inside the scope: what the caller asked for, and where it is.
struct Resolved {
    /// The caller's path, normalised: `/`-separated, no `.` or empty parts.
    rel: String,
    /// The root joined with `rel` (not yet resolved).
    path: PathBuf,
}

impl Scope {
    /// The scope of `root`, which must be an existing folder.
    pub fn new(root: &Path) -> Result<Scope, String> {
        let root = std::fs::canonicalize(root).map_err(|e| io_err(&e))?;
        if !root.is_dir() {
            return Err(fail(codes::NOT_A_FOLDER, "the root is not a folder"));
        }
        Ok(Scope { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Check the caller's relative path's shape and join it to the root.
    fn resolve(&self, rel: &str) -> Result<Resolved, String> {
        if rel.contains('\0') {
            return Err(fail(codes::BAD_REQUEST, "the path holds a NUL"));
        }
        let norm = rel.replace('\\', "/");
        let b = norm.as_bytes();
        let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
        if norm.starts_with('/') || drive {
            return Err(fail(codes::OUTSIDE_ROOT, "paths are relative to the chat's folder"));
        }
        let mut parts: Vec<&str> = Vec::new();
        for part in norm.split('/') {
            match part {
                "" | "." => {}
                ".." => return Err(fail(codes::OUTSIDE_ROOT, "the path leaves the chat's folder")),
                p => parts.push(p),
            }
        }
        let mut path = self.root.clone();
        for p in &parts {
            path.push(p);
        }
        Ok(Resolved { rel: parts.join("/"), path })
    }

    /// Resolve symlinks and require the result inside the root: the
    /// canonical path and its `/`-separated path relative to the root.
    fn contain(&self, path: &Path) -> Result<(PathBuf, String), String> {
        let real = std::fs::canonicalize(path).map_err(|e| io_err(&e))?;
        let rel =
            self.relative(&real).ok_or_else(|| fail(codes::OUTSIDE_ROOT, "a link leads outside the chat's folder"))?;
        Ok((real, rel))
    }

    fn relative(&self, real: &Path) -> Option<String> {
        let rest = real.strip_prefix(&self.root).ok()?;
        Some(rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
    }

    fn refuse_secret(rel: &str, dir: bool) -> Result<(), String> {
        let secret = if dir { !rel.is_empty() && secret_dir(rel) } else { secret_path(rel) };
        if secret { Err(fail(codes::SECRET_FILE, "this file may hold secrets and is never shown")) } else { Ok(()) }
    }

    /// `files:list`: a folder's entries, folders first, at most [`LIST_CAP`].
    /// Secret entries are only counted (`hiddenSecrets`), as are links that
    /// lead outside the root or nowhere (`hiddenLinks`).
    pub fn list(&self, rel: &str) -> Result<Value, String> {
        let r = self.resolve(rel)?;
        Self::refuse_secret(&r.rel, true)?;
        let (real, real_rel) = self.contain(&r.path)?;
        Self::refuse_secret(&real_rel, true)?;
        if !real.is_dir() {
            return Err(fail(codes::NOT_A_FOLDER, "not a folder"));
        }
        let mut entries: Vec<(String, bool, bool)> = Vec::new();
        let (mut hidden_secrets, mut hidden_links, mut scanned) = (0u64, 0u64, 0usize);
        let mut incomplete = false;
        for entry in std::fs::read_dir(&real).map_err(|e| io_err(&e))? {
            if scanned >= SCAN_CAP {
                incomplete = true;
                break;
            }
            scanned += 1;
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if r.rel.is_empty() { name.clone() } else { format!("{}/{name}", r.rel) };
            let Ok(kind) = entry.file_type() else { continue };
            let (dir, link) = if kind.is_symlink() {
                match self.contain(&entry.path()) {
                    Ok((target, target_rel)) => {
                        let dir = target.is_dir();
                        let secret = !target_rel.is_empty()
                            && if dir { secret_dir(&target_rel) } else { secret_path(&target_rel) };
                        if secret {
                            hidden_secrets += 1;
                            continue;
                        }
                        (dir, true)
                    }
                    Err(_) => {
                        hidden_links += 1;
                        continue;
                    }
                }
            } else {
                (kind.is_dir(), false)
            };
            if (dir && secret_dir(&child)) || (!dir && secret_path(&child)) {
                hidden_secrets += 1;
                continue;
            }
            entries.push((name, dir, link));
        }
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| js::locale_compare(&a.0, &b.0)));
        let total = entries.len();
        entries.truncate(LIST_CAP);
        let list: Vec<Value> = entries
            .into_iter()
            .map(|(name, dir, link)| {
                let path = if r.rel.is_empty() { name.clone() } else { format!("{}/{name}", r.rel) };
                let mut m = Map::new();
                m.insert("name".into(), json!(name));
                m.insert("path".into(), json!(path));
                m.insert("dir".into(), json!(dir));
                if let Ok(meta) = std::fs::metadata(real.join(&name)) {
                    if !dir {
                        m.insert("size".into(), json!(meta.len()));
                    }
                    if let Some(t) = mtime_ms(&meta) {
                        m.insert("mtime".into(), json!(t));
                    }
                }
                if link {
                    m.insert("link".into(), json!(true));
                }
                Value::Object(m)
            })
            .collect();
        Ok(json!({
            "path": r.rel,
            "entries": list,
            "total": total,
            "truncated": total > LIST_CAP || incomplete,
            "hiddenSecrets": hidden_secrets,
            "hiddenLinks": hidden_links,
        }))
    }

    /// The files a search looks through when git cannot list them: a walk
    /// that skips the indexer's ignored folders and secret folders, never
    /// follows links, and stops at [`SEARCH_SCAN`] files.
    fn walk(&self) -> (Vec<String>, bool) {
        let mut out = Vec::new();
        let mut stack: Vec<(PathBuf, String)> = vec![(self.root.clone(), String::new())];
        while let Some((dir, rel)) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else { continue };
            let mut names: Vec<(String, bool)> = read
                .flatten()
                .filter_map(|e| {
                    let kind = e.file_type().ok()?;
                    if kind.is_symlink() {
                        return None;
                    }
                    Some((e.file_name().to_string_lossy().into_owned(), kind.is_dir()))
                })
                .collect();
            names.sort();
            for (name, is_dir) in names.into_iter().rev() {
                let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                if is_dir {
                    if IGNORED_DIRS.contains(&name.as_str()) || secret_dir(&child) {
                        continue;
                    }
                    stack.push((dir.join(&name), child));
                } else {
                    if out.len() >= SEARCH_SCAN {
                        return (out, true);
                    }
                    out.push(child);
                }
            }
        }
        (out, false)
    }

    /// `files:search`: files whose name (then whose path) holds `query`,
    /// case-insensitively; at most `limit` hits ([`SEARCH_MAX`]). `listed`
    /// is git's list of the folder's files (tracked and untracked, ignored
    /// ones left out, see [`git_files`]); without it, a bounded walk.
    pub fn search(&self, query: &str, limit: Option<usize>, listed: Option<Vec<String>>) -> Value {
        let limit = limit.unwrap_or(SEARCH_DEFAULT).clamp(1, SEARCH_MAX);
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return json!({ "hits": [], "truncated": false, "complete": true });
        }
        let (files, incomplete) = match listed {
            Some(mut l) => {
                let over = l.len() > SEARCH_SCAN;
                l.truncate(SEARCH_SCAN);
                (l, over)
            }
            None => self.walk(),
        };
        let mut hits: Vec<(u8, String)> = Vec::new();
        for path in files {
            if secret_path(&path) {
                continue;
            }
            let lower = path.to_lowercase();
            let name = lower.rsplit('/').next().unwrap_or("");
            let rank = if name == q {
                0
            } else if name.starts_with(&q) {
                1
            } else if name.contains(&q) {
                2
            } else if lower.contains(&q) {
                3
            } else {
                continue;
            };
            hits.push((rank, path));
        }
        hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(&b.1)));
        let truncated = hits.len() > limit;
        hits.truncate(limit);
        Value::Object(Map::from_iter([
            (
                "hits".into(),
                Value::Array(
                    hits.into_iter()
                        .map(|(_, path)| {
                            let name = path.rsplit('/').next().unwrap_or("").to_string();
                            json!({ "path": path, "name": name })
                        })
                        .collect(),
                ),
            ),
            ("truncated".into(), json!(truncated)),
            ("complete".into(), json!(!incomplete)),
        ]))
    }

    /// `files:read`: a file's text (up to `max_bytes`, default
    /// [`READ_DEFAULT`], never past [`READ_MAX`]) with a language hint, or an
    /// image as a data URL up to [`IMAGE_CAP`], or a binary file described.
    /// Always its size, modification time and the sha256 of all its bytes
    /// (`hash`, which a save sends back as `expectHash`).
    pub fn read(&self, rel: &str, max_bytes: Option<usize>) -> Result<Value, String> {
        let r = self.resolve(rel)?;
        Self::refuse_secret(&r.rel, false)?;
        let (real, real_rel) = self.contain(&r.path)?;
        Self::refuse_secret(&real_rel, false)?;
        let meta = std::fs::metadata(&real).map_err(|e| io_err(&e))?;
        if !meta.is_file() {
            return Err(fail(codes::NOT_A_FILE, "not a file"));
        }
        let max = max_bytes.unwrap_or(READ_DEFAULT).clamp(1, READ_MAX);
        let size = meta.len();
        let hash = file_hash(&real, size)?;
        let name = r.rel.rsplit('/').next().unwrap_or("").to_string();
        let mut out = Map::new();
        out.insert("path".into(), json!(r.rel));
        out.insert("name".into(), json!(name));
        out.insert("size".into(), json!(size));
        out.insert("mtime".into(), json!(mtime_ms(&meta)));
        out.insert("hash".into(), json!(hash));

        let mut f = std::fs::File::open(&real).map_err(|e| io_err(&e))?;
        let head_len = (max as u64).max(SNIFF as u64).min(size) as usize;
        let mut head = vec![0u8; head_len];
        f.read_exact(&mut head).map_err(|e| io_err(&e))?;

        if let Some(mime) = image_mime(&r.rel).filter(|m| has_signature(m, &head)) {
            out.insert("kind".into(), json!("image"));
            out.insert("mime".into(), json!(mime));
            out.insert("editable".into(), json!(false));
            if size > IMAGE_CAP {
                out.insert("truncated".into(), json!(true));
            } else {
                let mut all = head;
                f.read_to_end(&mut all).map_err(|e| io_err(&e))?;
                out.insert("truncated".into(), json!(false));
                out.insert("imageDataUrl".into(), json!(format!("data:{mime};base64,{}", base64(&all))));
            }
            return Ok(Value::Object(out));
        }
        if head[..head.len().min(SNIFF)].contains(&0) {
            out.insert("kind".into(), json!("binary"));
            out.insert("truncated".into(), json!(false));
            out.insert("editable".into(), json!(false));
            return Ok(Value::Object(out));
        }
        let take = head.len().min(max);
        let truncated = (take as u64) < size;
        let slice = &head[..take];
        // Cut at a character boundary when the cap split one.
        let text = match std::str::from_utf8(slice) {
            Ok(s) => s.to_string(),
            Err(e) if truncated && e.error_len().is_none() => {
                String::from_utf8_lossy(&slice[..e.valid_up_to()]).into_owned()
            }
            Err(_) => String::from_utf8_lossy(slice).into_owned(),
        };
        let lang = language(&r.rel);
        out.insert("kind".into(), json!("text"));
        out.insert("content".into(), json!(text));
        out.insert("truncated".into(), json!(truncated));
        if let Some(l) = lang {
            out.insert("language".into(), json!(l));
        }
        out.insert("markdown".into(), json!(lang == Some("markdown")));
        out.insert(
            "editable".into(),
            json!(!truncated && hash.is_some() && size as usize <= WRITE_CAP && std::str::from_utf8(slice).is_ok()),
        );
        Ok(Value::Object(out))
    }

    /// `files:write`: save `content` only if the file is still the one the
    /// caller read (`expect_hash` equals its sha256), or is still missing
    /// when `expect_hash` is None. Otherwise `{ ok: false, error: "conflict",
    /// hash }` with the current hash (null when there is no file). Written to
    /// a temp file beside it and renamed over, keeping its permissions;
    /// through a link, the link's target is written.
    pub fn write(&self, rel: &str, content: &str, expect_hash: Option<&str>) -> Result<Value, String> {
        if content.len() > WRITE_CAP {
            return Err(fail(codes::TOO_LARGE, format!("saves are capped at {WRITE_CAP} bytes")));
        }
        if content.as_bytes().contains(&0) {
            return Err(fail(codes::BINARY, "the text holds a NUL"));
        }
        let r = self.resolve(rel)?;
        if r.rel.is_empty() {
            return Err(fail(codes::NOT_A_FILE, "not a file"));
        }
        Self::refuse_secret(&r.rel, false)?;
        let exists = std::fs::symlink_metadata(&r.path).is_ok();
        let target = if exists {
            let (real, real_rel) = self.contain(&r.path)?;
            Self::refuse_secret(&real_rel, false)?;
            let meta = std::fs::metadata(&real).map_err(|e| io_err(&e))?;
            if !meta.is_file() {
                return Err(fail(codes::NOT_A_FILE, "not a file"));
            }
            if meta.len() > WRITE_CAP as u64 {
                return Err(fail(codes::TOO_LARGE, "the file is too large to save over"));
            }
            let current = std::fs::read(&real).map_err(|e| io_err(&e))?;
            if current[..current.len().min(SNIFF)].contains(&0)
                || image_mime(&real_rel).is_some_and(|m| has_signature(m, &current))
            {
                return Err(fail(codes::BINARY, "the file is not text"));
            }
            let hash = hash_bytes(&current);
            if expect_hash != Some(hash.as_str()) {
                return Ok(json!({ "ok": false, "error": "conflict", "hash": hash }));
            }
            real
        } else {
            if expect_hash.is_some() {
                return Ok(json!({ "ok": false, "error": "conflict", "hash": null }));
            }
            let parent = r.path.parent().ok_or_else(|| fail(codes::NOT_FOUND, "no folder"))?;
            let (real_parent, parent_rel) = self.contain(parent)?;
            if !real_parent.is_dir() {
                return Err(fail(codes::NOT_A_FOLDER, "the parent is not a folder"));
            }
            Self::refuse_secret(&parent_rel, true)?;
            let name = r.path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
            real_parent.join(name)
        };
        // Keeping the old file's permissions (an executable script stays one).
        let opts = nekko_js::fs::AtomicWrite { mode: nekko_js::fs::Mode::Keep, fsync: true, create_dir: false };
        nekko_js::fs::atomic_write(&target, content.as_bytes(), opts).map_err(|e| fail(codes::IO, e))?;
        let meta = std::fs::metadata(&target).map_err(|e| io_err(&e))?;
        Ok(json!({
            "ok": true,
            "hash": hash_bytes(content.as_bytes()),
            "size": meta.len(),
            "mtime": mtime_ms(&meta),
        }))
    }
}

/// The folder's files as git lists them (tracked and untracked, without the
/// ones `.gitignore` leaves out), relative to `root`; None when git is
/// missing, the folder is not in a repository (or git lists nothing in it,
/// as in an ignored folder), or the list is too long.
pub async fn git_files(root: &Path) -> Option<Vec<String>> {
    let dir = root.to_string_lossy().into_owned();
    let out = crate::proc::run(
        "git",
        &["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        std::time::Duration::from_secs(10),
        Some(&dir),
        32 * 1024 * 1024,
    )
    .await;
    if !out.ok || out.stdout.is_empty() {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    // `--cached` lists a file once per merge stage during a conflict.
    Some(out.stdout.split('\0').filter(|s| !s.is_empty() && seen.insert(s.to_string())).map(str::to_string).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn code(r: Result<Value, String>) -> String {
        r.unwrap_err().split(':').next().unwrap().to_string()
    }

    fn names(v: &Value) -> Vec<String> {
        v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn secret_paths_cover_the_phone_rule_and_git_credentials() {
        for p in [
            ".env",
            ".env.local",
            "app/.env.production",
            ".ssh/id_ed25519",
            "home/.aws/credentials",
            "x/.gnupg/pubring.kbx",
            "id_rsa",
            "certs/server.pem",
            "a/b.key",
            "store.p12",
            ".npmrc",
            ".netrc",
            ".pypirc",
            ".git-credentials",
            ".git/config",
            "sub/.git/config",
            "A\\B\\.ENV",
        ] {
            assert!(secret_path(p), "{p}");
        }
        for p in ["src/environment.ts", "README.md", ".gitignore", ".git/HEAD", "keys.md", "envelope.rs"] {
            assert!(!secret_path(p), "{p}");
        }
        assert!(secret_dir(".ssh") && secret_dir("a/.aws") && !secret_dir("src"));
    }

    #[test]
    fn refuses_paths_that_leave_the_root() {
        let d = tmp();
        std::fs::create_dir(d.path().join("in")).unwrap();
        std::fs::write(d.path().join("in/a.txt"), "a").unwrap();
        let s = Scope::new(&d.path().join("in")).unwrap();
        for bad in ["../a.txt", "x/../../a", "/etc/passwd", "\\etc", "C:/Windows", "c:\\x", "..", "a/..\\.."] {
            assert_eq!(code(s.read(bad, None)), codes::OUTSIDE_ROOT, "{bad}");
            assert_eq!(code(s.list(bad)), codes::OUTSIDE_ROOT, "{bad}");
        }
        assert_eq!(code(s.read("a\0b", None)), codes::BAD_REQUEST);
        // `.` and empty parts are fine.
        assert_eq!(s.read("./a.txt", None).unwrap()["content"], "a");
        assert_eq!(s.read("a.txt", None).unwrap()["path"], "a.txt");
        assert_eq!(s.list("").unwrap()["path"], "");
        assert_eq!(s.list(".").unwrap()["path"], "");
        assert_eq!(code(s.read("missing.txt", None)), codes::NOT_FOUND);
        assert_eq!(code(s.read("", None)), codes::NOT_A_FILE);
        assert_eq!(code(s.list("a.txt")), codes::NOT_A_FOLDER);
    }

    #[cfg(unix)]
    #[test]
    fn links_inside_are_followed_and_links_outside_refused() {
        use std::os::unix::fs::symlink;
        let d = tmp();
        let root = d.path().join("root");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(d.path().join("outside.txt"), "secret stuff").unwrap();
        std::fs::create_dir(d.path().join("outdir")).unwrap();
        symlink(d.path().join("outside.txt"), root.join("out.txt")).unwrap();
        symlink(d.path().join("outdir"), root.join("outdir")).unwrap();
        symlink(root.join("src/main.rs"), root.join("main-link.rs")).unwrap();
        symlink(root.join("nowhere"), root.join("broken")).unwrap();
        std::fs::write(root.join(".env"), "KEY=1").unwrap();
        symlink(root.join(".env"), root.join("innocent.txt")).unwrap();
        let s = Scope::new(&root).unwrap();

        let listed = s.list("").unwrap();
        assert_eq!(names(&listed), ["src", "main-link.rs"]);
        assert_eq!(listed["hiddenLinks"], 3, "out.txt, outdir and broken");
        assert_eq!(listed["hiddenSecrets"], 2, ".env and the link to it");
        assert_eq!(listed["entries"][1]["link"], true);

        assert_eq!(code(s.read("out.txt", None)), codes::OUTSIDE_ROOT);
        assert_eq!(code(s.list("outdir")), codes::OUTSIDE_ROOT);
        assert_eq!(code(s.read("outdir/x", None)), codes::NOT_FOUND);
        assert_eq!(code(s.write("out.txt", "x", None)), codes::OUTSIDE_ROOT);
        assert_eq!(code(s.write("outdir/new.txt", "x", None)), codes::OUTSIDE_ROOT);
        assert!(!d.path().join("outdir/new.txt").exists());
        assert_eq!(std::fs::read_to_string(d.path().join("outside.txt")).unwrap(), "secret stuff");
        assert_eq!(code(s.read("innocent.txt", None)), codes::SECRET_FILE);
        assert_eq!(s.read("main-link.rs", None).unwrap()["content"], "fn main() {}");

        // A root reached through a link is resolved first.
        symlink(&root, d.path().join("alias")).unwrap();
        let s = Scope::new(&d.path().join("alias")).unwrap();
        assert_eq!(s.read("src/main.rs", None).unwrap()["language"], "rust");
    }

    #[test]
    fn secrets_are_counted_never_named_read_or_written() {
        let d = tmp();
        let root = d.path();
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        std::fs::write(root.join(".ssh/id_rsa"), "k").unwrap();
        std::fs::write(root.join(".env"), "TOKEN=x").unwrap();
        std::fs::write(root.join("server.pem"), "pem").unwrap();
        std::fs::write(root.join("app.ts"), "x").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/config"), "[remote] url=https://tok@x").unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: main").unwrap();
        let s = Scope::new(root).unwrap();
        let listed = s.list("").unwrap();
        assert_eq!(names(&listed), [".git", "app.ts"]);
        assert_eq!(listed["hiddenSecrets"], 3);
        let text = listed.to_string();
        for leak in [".ssh", ".env", "server.pem"] {
            assert!(!text.contains(leak), "{leak} appeared in the listing");
        }
        assert_eq!(s.list(".git").unwrap()["hiddenSecrets"], 1);
        for p in [".env", ".ssh/id_rsa", "server.pem", ".git/config", "sub/.env.local"] {
            // Compared without printing the refusal: a failure names only the path tried.
            assert!(code(s.read(p, None)) == codes::SECRET_FILE, "{p} was not refused for reading");
            assert!(code(s.write(p, "x", None)) == codes::SECRET_FILE, "{p} was not refused for writing");
        }
        assert_eq!(code(s.list(".ssh")), codes::SECRET_FILE);
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), "TOKEN=x");
        let hits = s.search("env", None, None);
        assert_eq!(hits["hits"], json!([]));
    }

    #[test]
    fn lists_folders_first_capped_with_sizes() {
        let d = tmp();
        let root = d.path();
        std::fs::create_dir(root.join("b-dir")).unwrap();
        std::fs::create_dir(root.join("A-dir")).unwrap();
        std::fs::write(root.join("z.txt"), "12345").unwrap();
        std::fs::write(root.join("a.txt"), "1").unwrap();
        let s = Scope::new(root).unwrap();
        let listed = s.list("").unwrap();
        assert_eq!(names(&listed), ["A-dir", "b-dir", "a.txt", "z.txt"]);
        assert_eq!(listed["entries"][3]["size"], 5);
        assert_eq!(listed["entries"][3]["path"], "z.txt");
        assert!(listed["entries"][0].get("size").is_none());
        assert!(listed["entries"][0]["mtime"].as_u64().unwrap() > 0);
        assert_eq!(listed["truncated"], false);

        for i in 0..LIST_CAP + 7 {
            std::fs::write(root.join("b-dir").join(format!("f{i:04}.txt")), "").unwrap();
        }
        let big = s.list("b-dir").unwrap();
        assert_eq!(big["entries"].as_array().unwrap().len(), LIST_CAP);
        assert_eq!(big["total"], LIST_CAP + 7);
        assert_eq!(big["truncated"], true);
        assert_eq!(big["entries"][0]["path"], "b-dir/f0000.txt");
    }

    #[test]
    fn reads_text_with_a_hash_language_and_cap() {
        let d = tmp();
        let root = d.path();
        let body = "# Title\n\nSome text é\n";
        std::fs::write(root.join("README.md"), body).unwrap();
        let s = Scope::new(root).unwrap();
        let r = s.read("README.md", None).unwrap();
        assert_eq!(r["kind"], "text");
        assert_eq!(r["content"], body);
        assert_eq!(r["markdown"], true);
        assert_eq!(r["language"], "markdown");
        assert_eq!(r["size"], body.len());
        assert_eq!(r["hash"], hash_bytes(body.as_bytes()));
        assert_eq!(r["editable"], true);
        assert_eq!(r["truncated"], false);

        // The cap cuts at a character boundary, and the hash is still the whole file's.
        let long = format!("{}é{}", "a".repeat(9), "b".repeat(100));
        std::fs::write(root.join("long.txt"), &long).unwrap();
        let r = s.read("long.txt", Some(10)).unwrap();
        assert_eq!(r["content"], "a".repeat(9));
        assert_eq!(r["truncated"], true);
        assert_eq!(r["editable"], false);
        assert_eq!(r["hash"], hash_bytes(long.as_bytes()));
        assert_eq!(r["language"], "plaintext");
        // Never more than the hard cap, whatever is asked.
        std::fs::write(root.join("huge.txt"), "x".repeat(READ_MAX + 10)).unwrap();
        let r = s.read("huge.txt", Some(usize::MAX)).unwrap();
        assert_eq!(r["content"].as_str().unwrap().len(), READ_MAX);
        let r = s.read("huge.txt", None).unwrap();
        assert_eq!(r["content"].as_str().unwrap().len(), READ_DEFAULT);
    }

    #[test]
    fn reads_images_and_describes_binaries() {
        let d = tmp();
        let root = d.path();
        let png = [137u8, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1];
        std::fs::write(root.join("p.png"), png).unwrap();
        std::fs::write(root.join("fake.png"), "not a png").unwrap();
        std::fs::write(root.join("blob.bin"), [1u8, 0, 2, 3]).unwrap();
        let mut big = png.to_vec();
        big.resize(IMAGE_CAP as usize + 1, 0);
        std::fs::write(root.join("big.png"), &big).unwrap();
        let s = Scope::new(root).unwrap();
        let r = s.read("p.png", None).unwrap();
        assert_eq!(r["kind"], "image");
        assert_eq!(r["imageDataUrl"], format!("data:image/png;base64,{}", base64(&png)));
        assert_eq!(r["hash"], hash_bytes(&png));
        let r = s.read("big.png", None).unwrap();
        assert_eq!((r["kind"].clone(), r["truncated"].clone()), (json!("image"), json!(true)));
        assert!(r.get("imageDataUrl").is_none());
        assert_eq!(s.read("fake.png", None).unwrap()["kind"], "text");
        let r = s.read("blob.bin", None).unwrap();
        assert_eq!((r["kind"].clone(), r["size"].clone()), (json!("binary"), json!(4)));
        assert!(r.get("content").is_none());
        assert_eq!(code(s.write("blob.bin", "x", Some(&hash_bytes(&[1, 0, 2, 3])))), codes::BINARY);
        assert_eq!(code(s.write("p.png", "x", Some(&hash_bytes(&png)))), codes::BINARY);
    }

    #[test]
    fn a_save_needs_the_hash_of_the_file_it_replaces() {
        let d = tmp();
        let root = d.path();
        std::fs::write(root.join("a.txt"), "one").unwrap();
        let s = Scope::new(root).unwrap();
        let read = s.read("a.txt", None).unwrap();
        let hash = read["hash"].as_str().unwrap().to_string();

        // The desktop saved in between: the phone's save is refused with the new hash.
        std::fs::write(root.join("a.txt"), "two").unwrap();
        let r = s.write("a.txt", "phone", Some(&hash)).unwrap();
        assert_eq!(r, json!({ "ok": false, "error": "conflict", "hash": hash_bytes(b"two") }));
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "two");
        // No hash for an existing file is a conflict too.
        assert_eq!(s.write("a.txt", "phone", None).unwrap()["error"], "conflict");

        // With the current hash it saves, and answers the new hash.
        let r = s.write("a.txt", "phone", Some(&hash_bytes(b"two"))).unwrap();
        assert_eq!(r["ok"], true);
        assert_eq!(r["hash"], hash_bytes(b"phone"));
        assert_eq!(r["size"], 5);
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "phone");
        // No temp file is left behind.
        let left: Vec<_> = std::fs::read_dir(root).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1, "{left:?}");

        // A new file: only with no expected hash, and only in an existing folder.
        assert_eq!(
            s.write("new.txt", "x", Some("abc")).unwrap(),
            json!({ "ok": false, "error": "conflict", "hash": null })
        );
        assert!(!root.join("new.txt").exists());
        assert_eq!(s.write("new.txt", "x", None).unwrap()["ok"], true);
        assert_eq!(code(s.write("no/such/dir.txt", "x", None)), codes::NOT_FOUND);
        assert_eq!(code(s.write("", "x", None)), codes::NOT_A_FILE);
        std::fs::create_dir(root.join("d")).unwrap();
        assert_eq!(code(s.write("d", "x", None)), codes::NOT_A_FILE);

        // Caps and text only.
        assert_eq!(code(s.write("big.txt", &"x".repeat(WRITE_CAP + 1), None)), codes::TOO_LARGE);
        assert_eq!(code(s.write("nul.txt", "a\0b", None)), codes::BINARY);
        std::fs::write(root.join("large.txt"), "x".repeat(WRITE_CAP + 1)).unwrap();
        let h = s.read("large.txt", None).unwrap()["hash"].as_str().unwrap().to_string();
        assert_eq!(code(s.write("large.txt", "x", Some(&h))), codes::TOO_LARGE);
    }

    #[cfg(unix)]
    #[test]
    fn a_save_keeps_the_mode_and_writes_through_links() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let d = tmp();
        let root = d.path();
        std::fs::write(root.join("run.sh"), "echo 1").unwrap();
        std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o750)).unwrap();
        symlink(root.join("run.sh"), root.join("link.sh")).unwrap();
        let s = Scope::new(root).unwrap();
        let r = s.write("link.sh", "echo 2", Some(&hash_bytes(b"echo 1"))).unwrap();
        assert_eq!(r["ok"], true);
        assert!(std::fs::symlink_metadata(root.join("link.sh")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(root.join("run.sh")).unwrap(), "echo 2");
        assert_eq!(std::fs::metadata(root.join("run.sh")).unwrap().permissions().mode() & 0o777, 0o750);
    }

    #[test]
    fn concurrent_saves_never_leave_a_mixed_file() {
        let d = tmp();
        std::fs::write(d.path().join("a.txt"), "base").unwrap();
        let s = std::sync::Arc::new(Scope::new(d.path()).unwrap());
        let base = hash_bytes(b"base");
        let wins: Vec<bool> = (0..8)
            .map(|i| {
                let (s, base) = (s.clone(), base.clone());
                std::thread::spawn(move || s.write("a.txt", &format!("writer {i}"), Some(&base)).unwrap()["ok"] == true)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        // The file always holds one whole save, never a mix.
        let now = std::fs::read_to_string(d.path().join("a.txt")).unwrap();
        assert!(now.starts_with("writer ") && now.len() == "writer 0".len(), "{now}");
        assert!(wins.iter().any(|w| *w));
    }

    #[test]
    fn searches_names_then_paths_with_caps() {
        let d = tmp();
        let root = d.path();
        std::fs::create_dir_all(root.join("src/components")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/button")).unwrap();
        std::fs::write(root.join("src/components/Button.tsx"), "").unwrap();
        std::fs::write(root.join("src/button.ts"), "").unwrap();
        std::fs::write(root.join("src/components/index.ts"), "").unwrap();
        std::fs::write(root.join("node_modules/button/index.js"), "").unwrap();
        std::fs::write(root.join("button"), "").unwrap();
        let s = Scope::new(root).unwrap();
        let r = s.search("BUTTON", None, None);
        let paths: Vec<_> = r["hits"].as_array().unwrap().iter().map(|h| h["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["button", "src/button.ts", "src/components/Button.tsx"]);
        assert_eq!(r["hits"][2]["name"], "Button.tsx");
        assert_eq!(r["truncated"], false);
        assert_eq!(r["complete"], true);
        let r = s.search("components", None, None);
        assert_eq!(r["hits"].as_array().unwrap().len(), 2, "matched by path");
        let r = s.search("s", Some(1), None);
        assert_eq!((r["hits"].as_array().unwrap().len(), r["truncated"].clone()), (1, json!(true)));
        assert_eq!(s.search("  ", None, None)["hits"], json!([]));
        // A list from git replaces the walk; secret paths are dropped from it.
        let listed = vec!["a/button.md".to_string(), ".env.button".to_string()];
        let r = s.search("button", None, Some(listed));
        assert_eq!(r["hits"], json!([{ "path": "a/button.md", "name": "button.md" }]));
        // Limits are clamped.
        let many: Vec<String> = (0..SEARCH_MAX + 50).map(|i| format!("f{i}.rs")).collect();
        let r = s.search("f", Some(10_000), Some(many));
        assert_eq!(r["hits"].as_array().unwrap().len(), SEARCH_MAX);
    }

    #[test]
    fn language_hints() {
        assert_eq!(language("a/b.TS"), Some("typescript"));
        assert_eq!(language("x.tsx"), Some("tsx"));
        assert_eq!(language("Dockerfile"), Some("dockerfile"));
        assert_eq!(language("dir.rs/Makefile"), Some("makefile"));
        assert_eq!(language(".bashrc"), None);
        assert_eq!(language("noext"), None);
        assert_eq!(language("c.yml"), Some("yaml"));
    }

    #[tokio::test]
    async fn git_lists_files_without_ignored_ones() {
        let d = tmp();
        let root = d.path();
        let git = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(root).output().map(|o| o.status.success())
        };
        if !git(&["init", "-q"]).unwrap_or(false) {
            return; // no git on this machine
        }
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir(root.join("build")).unwrap();
        std::fs::write(root.join("build/out.js"), "").unwrap();
        std::fs::write(root.join("main.rs"), "").unwrap();
        let mut files = git_files(root).await.unwrap();
        files.sort();
        assert_eq!(files, [".gitignore", "main.rs"]);
        // Nothing listed (an ignored folder) falls back to the walk.
        assert!(git_files(&root.join("build")).await.is_none());
    }
}
