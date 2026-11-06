//! What the agent linked in a chat, served to a paired phone (issue #1095):
//! `artifact:read` and `preview:fetch`.
//!
//! The phone's arguments are already screened by the relay gate
//! (nekko-remote `phone_artifacts.rs`); this is where the computer checks them
//! against the chat itself. The chat's links come from its assistant
//! messages (`nekko_remote::chat_links`, the same rules the TS has):
//!
//! - `artifact:read [sessionId, path]`: `path` must be a file the agent linked
//!   in that chat, or a file inside a linked HTML page's folder with an asset
//!   extension. The real path (symlinks resolved) is checked again: still a
//!   file, not a secret, and for an asset still inside the page's real folder.
//!   A page whose folder is a disk root or the user's home opens no assets.
//!   Text up to 1 MiB comes as `content` (cut beyond, `truncated`), anything
//!   else up to 4 MiB as `base64` (larger: no body, `truncated`).
//! - `preview:fetch [sessionId, url, { method }]`: the URL's origin must be a
//!   loopback origin linked in that chat. The computer connects to 127.0.0.1
//!   or ::1 only (never a DNS lookup, never a proxy), sends the original
//!   `Host`, `Accept: */*` and its own user agent and nothing from the phone,
//!   follows up to five redirects inside the same origin (any other redirect
//!   comes back as it is), stops after 15 s and returns up to 4 MiB of body.
//!
//! Errors are `code: message`: `bad-request`, `not-found`, `not-linked`,
//! `secret-file`, `not-a-file`, `unreachable`, `timeout`, `failed`.

use crate::routes::Ctx;
use base64::Engine;
use nekko_remote::chat_links::{self, ASSET_EXT, Access, ChatLinks, LINK_EXT};
use nekko_remote::phone_files::secret_path;
use serde_json::{Map, Value, json};
use std::io::Read;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Channels served here.
pub const CHANNELS: &[&str] = &["artifact:read", "preview:fetch"];

const NOT_LINKED_FILE: &str = "not-linked: this file was not linked in this chat";
const NOT_LINKED_PREVIEW: &str = "not-linked: this preview was not linked in this chat";

/// File names compare the way the computer's file system does by default.
const CASE_INSENSITIVE: bool = cfg!(any(windows, target_os = "macos"));

/// The caps, from the phone policy (`PHONE_ARTIFACTS_VIEW`).
#[derive(Debug, Clone)]
pub struct Limits {
    pub text_bytes: usize,
    pub binary_bytes: usize,
    pub preview_bytes: usize,
    pub redirects: usize,
    pub timeout: Duration,
}

impl Limits {
    pub fn from_policy() -> Self {
        let p = &nekko_remote::phone::policy().artifacts;
        Limits {
            text_bytes: p.text_bytes,
            binary_bytes: p.binary_bytes,
            preview_bytes: p.preview_bytes,
            redirects: p.redirects,
            timeout: Duration::from_millis(p.timeout_ms),
        }
    }
}

/// Extensions read as UTF-8 text.
const TEXT_EXT: &[&str] = &["css", "csv", "htm", "html", "js", "json", "map", "markdown", "md", "mjs", "svg", "txt"];

/// The MIME type of an extension; `application/octet-stream` when unknown.
pub fn mime_of(ext: &str) -> &'static str {
    match ext {
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn text_arg(args: &[Value], i: usize) -> Option<String> {
    args.get(i).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// `artifact:read` and `preview:fetch`.
pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let sid = text_arg(args, 0).ok_or("bad-request: the first argument is the chat's id")?;
    let links = chat_links_of(ctx, &sid).await?;
    let limits = Limits::from_policy();
    match channel {
        "artifact:read" => {
            let path = text_arg(args, 1).ok_or("bad-request: the path is missing")?;
            let home = home_dir();
            tokio::task::spawn_blocking(move || {
                read_artifact(&path, &links, CASE_INSENSITIVE, home.as_deref(), &limits)
            })
            .await
            .map_err(|e| format!("failed: {e}"))?
        }
        "preview:fetch" => {
            let url = text_arg(args, 1).ok_or("bad-request: the URL is missing")?;
            let head = args.get(2).and_then(|o| o.get("method")).and_then(Value::as_str) == Some("HEAD");
            fetch_preview(&url, head, &links, &limits).await
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// The chat's links: its assistant messages, relative links against its folder.
async fn chat_links_of(ctx: &Ctx, sid: &str) -> Result<ChatLinks, String> {
    let store = ctx.sessions.clone();
    let id = sid.to_string();
    let session = tokio::task::spawn_blocking(move || store.get(&id).unwrap_or(Value::Null))
        .await
        .map_err(|e| format!("failed: {e}"))?;
    if session.is_null() {
        return Err("not-found: no such chat".into());
    }
    // A chat with no folder still has its absolute links.
    let base = crate::workspace::scoped_root(ctx, Some(&json!({ "sessionId": sid })))
        .await
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    Ok(chat_links::chat_links(session.get("messages").unwrap_or(&Value::Null), base.as_deref()))
}

/// The user's home folder.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// A canonical path as `/`-separated text, without Windows' `\\?\` prefix.
fn plain(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    s.strip_prefix("//?/").map(str::to_string).unwrap_or(s)
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

/// `artifact:read`: a linked file, or an asset of a linked page, checked again on its real path.
pub fn read_artifact(
    path_arg: &str,
    links: &ChatLinks,
    case_insensitive: bool,
    home: Option<&Path>,
    limits: &Limits,
) -> Result<Value, String> {
    let path =
        chat_links::local_path(path_arg, None).ok_or("bad-request: the path is an absolute path or a file:// URL")?;
    let access = chat_links::artifact_access(&path, links, case_insensitive).ok_or(NOT_LINKED_FILE)?;
    if secret_path(&path) {
        return Err("secret-file: this file is never sent to a phone".into());
    }
    let real = std::fs::canonicalize(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "not-found: no such file".to_string(),
        _ => format!("not-found: {e}"),
    })?;
    let meta = std::fs::metadata(&real).map_err(|e| format!("not-found: {e}"))?;
    if !meta.is_file() {
        return Err("not-a-file: that is a folder, not a file".into());
    }
    // The real file, symlinks followed, must pass the same rules.
    let real_text = plain(&real);
    if secret_path(&real_text) {
        return Err("secret-file: this file is never sent to a phone".into());
    }
    let real_ext = chat_links::path_ext(&real_text);
    match &access {
        Access::Linked(linked) => {
            // Lexical case folding must not authorize a different file on a case-sensitive volume.
            let linked_real = std::fs::canonicalize(linked).map_err(|_| NOT_LINKED_FILE.to_string())?;
            if linked_real != real || !LINK_EXT.contains(&real_ext.as_str()) {
                return Err(NOT_LINKED_FILE.into());
            }
        }
        Access::Asset(root) => {
            let root_real = std::fs::canonicalize(root).map_err(|_| NOT_LINKED_FILE.to_string())?;
            let at_home = home.and_then(|h| std::fs::canonicalize(h).ok()).is_some_and(|h| h == root_real);
            let hidden = real
                .strip_prefix(&root_real)
                .ok()
                .is_some_and(|rel| rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')));
            if hidden
                || root_real.parent().is_none()
                || at_home
                || !real.starts_with(&root_real)
                || !ASSET_EXT.contains(&real_ext.as_str())
            {
                return Err(NOT_LINKED_FILE.into());
            }
        }
    }
    let size = meta.len();
    let ext = chat_links::path_ext(&path);
    let name = path.rsplit('/').next().unwrap_or_default().to_string();
    let mut out = Map::new();
    out.insert("path".into(), json!(path));
    out.insert("name".into(), json!(name));
    out.insert("mime".into(), json!(mime_of(&ext)));
    out.insert("size".into(), json!(size));
    out.insert("mtime".into(), json!(mtime_ms(&meta)));
    let file = std::fs::File::open(&real).map_err(|e| format!("not-found: {e}"))?;
    if TEXT_EXT.contains(&ext.as_str()) {
        let mut buf = Vec::new();
        file.take(limits.text_bytes as u64 + 1).read_to_end(&mut buf).map_err(|e| format!("failed: {e}"))?;
        let cut = buf.len() > limits.text_bytes;
        buf.truncate(limits.text_bytes);
        let text = match String::from_utf8(buf) {
            Ok(t) => Some(t),
            // Cut in the middle of a character: drop the partial one.
            Err(e) if cut && e.utf8_error().error_len().is_none() => {
                let valid = e.utf8_error().valid_up_to();
                let mut bytes = e.into_bytes();
                bytes.truncate(valid);
                String::from_utf8(bytes).ok()
            }
            Err(_) => None,
        };
        if let Some(text) = text {
            out.insert("kind".into(), json!("text"));
            out.insert("content".into(), json!(text));
            out.insert("truncated".into(), json!(cut));
            return Ok(Value::Object(out));
        }
    }
    // Not text, or text that is not UTF-8: the bytes, when they fit.
    out.insert("kind".into(), json!("binary"));
    if size > limits.binary_bytes as u64 {
        out.insert("truncated".into(), json!(true));
        return Ok(Value::Object(out));
    }
    let mut buf = Vec::new();
    let file = std::fs::File::open(&real).map_err(|e| format!("not-found: {e}"))?;
    file.take(limits.binary_bytes as u64 + 1).read_to_end(&mut buf).map_err(|e| format!("failed: {e}"))?;
    if buf.len() > limits.binary_bytes {
        out.insert("truncated".into(), json!(true));
    } else {
        out.insert("base64".into(), json!(base64::engine::general_purpose::STANDARD.encode(&buf)));
        out.insert("truncated".into(), json!(false));
    }
    Ok(Value::Object(out))
}

/// The response headers a phone receives.
const HEADERS: &[&str] = &["cache-control", "content-length", "content-type", "etag", "last-modified"];

fn classify(e: reqwest::Error, origin: &str) -> String {
    if e.is_timeout() {
        "timeout: the preview server did not answer in time".into()
    } else if e.is_connect() {
        format!("unreachable: nothing is answering at {origin}")
    } else {
        format!("failed: {e}")
    }
}

/// `preview:fetch`: a GET or HEAD to a loopback origin the chat linked.
pub async fn fetch_preview(url: &str, head: bool, links: &ChatLinks, limits: &Limits) -> Result<Value, String> {
    let start = chat_links::loopback_url(url, 2048).ok_or("bad-request: not a local preview URL")?;
    if !links.origins.contains(&start.origin) {
        return Err(NOT_LINKED_PREVIEW.into());
    }
    let origin = start.origin.clone();
    match tokio::time::timeout(limits.timeout, fetch(start, head, limits)).await {
        Ok(r) => r.map_err(|e| classify(e, &origin)),
        Err(_) => Err("timeout: the preview server did not answer in time".into()),
    }
}

async fn fetch(start: chat_links::LoopbackUrl, head: bool, limits: &Limits) -> Result<Value, reqwest::Error> {
    let port = start.port;
    // `localhost` is looked up here, never by DNS: this computer's two loopback addresses.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        // A local dev server's certificate is usually self-signed; the connection never leaves this computer.
        .danger_accept_invalid_certs(true)
        .user_agent(concat!("NekkoAgent-Preview/", env!("CARGO_PKG_VERSION")))
        .resolve_to_addrs(
            "localhost",
            &[SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SocketAddr::from((Ipv6Addr::LOCALHOST, port))],
        )
        .timeout(limits.timeout)
        .build()?;
    let method = if head { reqwest::Method::HEAD } else { reqwest::Method::GET };
    let mut current = start.clone();
    let mut hops = 0;
    loop {
        let target = format!("{}://{}:{}{}", current.scheme, current.host, current.port, current.path);
        let resp = client
            .request(method.clone(), &target)
            .header(reqwest::header::HOST, &current.authority)
            .header(reqwest::header::ACCEPT, "*/*")
            .send()
            .await?;
        if resp.status().is_redirection() && hops < limits.redirects {
            let next = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|l| l.to_str().ok())
                .and_then(|l| url::Url::parse(&current.url).ok()?.join(l).ok())
                .and_then(|n| chat_links::loopback_url(n.as_str(), 2048))
                .filter(|n| n.origin == start.origin);
            if let Some(next) = next {
                current = next;
                hops += 1;
                continue;
            }
        }
        return respond(resp, &current.url, head, limits.preview_bytes).await;
    }
}

async fn respond(mut resp: reqwest::Response, url: &str, head: bool, cap: usize) -> Result<Value, reqwest::Error> {
    let mut headers = Map::new();
    for name in HEADERS {
        if let Some(v) = resp.headers().get(*name).and_then(|v| v.to_str().ok()) {
            headers.insert(name.to_string(), json!(v));
        }
    }
    let content_type = headers.get("content-type").and_then(Value::as_str).unwrap_or_default().to_string();
    let status = resp.status().as_u16();
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    if !head {
        while let Some(chunk) = resp.chunk().await? {
            if body.len() + chunk.len() > cap {
                body.extend_from_slice(&chunk[..cap - body.len()]);
                truncated = true;
                break;
            }
            body.extend_from_slice(&chunk);
        }
    }
    Ok(json!({
        "url": url,
        "status": status,
        "contentType": content_type,
        "headers": headers,
        "base64": base64::engine::general_purpose::STANDARD.encode(&body),
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn limits() -> Limits {
        Limits { timeout: Duration::from_secs(10), ..Limits::from_policy() }
    }

    /// `/`-separated text of a temp path, as an agent would link it.
    fn slash(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    fn links_for(text: &str) -> ChatLinks {
        chat_links::chat_links(&json!([{ "role": "assistant", "content": text }]), None)
    }

    #[test]
    fn reads_a_linked_file_and_a_linked_pages_assets_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = slash(dir.path());
        std::fs::create_dir_all(dir.path().join("site/css")).unwrap();
        std::fs::create_dir_all(dir.path().join("site/.git")).unwrap();
        std::fs::write(dir.path().join("report.md"), "# Report\n").unwrap();
        std::fs::write(dir.path().join("other.md"), "no").unwrap();
        std::fs::write(dir.path().join("site/index.html"), "<link href=css/a.css>").unwrap();
        std::fs::write(dir.path().join("site/css/a.css"), "body{}").unwrap();
        std::fs::write(dir.path().join("site/logo.png"), [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::write(dir.path().join("site/run.exe"), "MZ").unwrap();
        std::fs::write(dir.path().join("site/.git/x.json"), "{}").unwrap();
        std::fs::write(dir.path().join("outside.css"), "x").unwrap();
        let links = links_for(&format!(
            "Made [the report]({root}/report.md) and [the site](file://{}{root}/site/index.html).",
            if root.starts_with('/') { "" } else { "/" }
        ));
        let l = limits();
        let read = |p: String| read_artifact(&p, &links, CASE_INSENSITIVE, None, &l);

        let v = read(format!("{root}/report.md")).unwrap();
        assert_eq!(
            (v["kind"].as_str(), v["content"].as_str(), v["truncated"].as_bool()),
            (Some("text"), Some("# Report\n"), Some(false))
        );
        assert_eq!(v["mime"], json!("text/markdown; charset=utf-8"));
        assert_eq!(v["name"], json!("report.md"));
        assert!(v["mtime"].as_u64().unwrap() > 1_600_000_000_000, "milliseconds since the epoch");
        assert_eq!(read(format!("{root}/site/css/a.css")).unwrap()["content"], json!("body{}"));
        let png = read(format!("{root}/site/logo.png")).unwrap();
        assert_eq!(
            (png["kind"].as_str(), png["base64"].as_str(), png["mime"].as_str()),
            (Some("binary"), Some("iVBORw=="), Some("image/png"))
        );
        for refused in ["other.md", "site/run.exe", "site/.git/x.json", "site/../outside.css", "outside.css"] {
            assert_eq!(read(format!("{root}/{refused}")).unwrap_err(), NOT_LINKED_FILE, "{refused}");
        }
        assert_eq!(
            read("notes/report.md".into()).unwrap_err(),
            "bad-request: the path is an absolute path or a file:// URL"
        );
        std::fs::remove_file(dir.path().join("report.md")).unwrap();
        assert_eq!(read(format!("{root}/report.md")).unwrap_err(), "not-found: no such file");
        std::fs::create_dir(dir.path().join("report.md")).unwrap();
        assert_eq!(read(format!("{root}/report.md")).unwrap_err(), "not-a-file: that is a folder, not a file");
        // A page in the home folder opens itself, not the home folder's files.
        let at_home = read_artifact(
            &format!("{root}/site/css/a.css"),
            &links,
            CASE_INSENSITIVE,
            Some(&dir.path().join("site")),
            &l,
        );
        assert_eq!(at_home.unwrap_err(), NOT_LINKED_FILE);
    }

    #[test]
    fn caps_text_and_binary() {
        let dir = tempfile::tempdir().unwrap();
        let root = slash(dir.path());
        let l = Limits { text_bytes: 10, binary_bytes: 8, ..limits() };
        std::fs::write(dir.path().join("long.txt"), "abcdefghié12").unwrap();
        std::fs::write(dir.path().join("big.pdf"), [0u8; 9]).unwrap();
        std::fs::write(dir.path().join("small.pdf"), [0u8; 8]).unwrap();
        std::fs::write(dir.path().join("latin1.txt"), [0xe9u8, b'a']).unwrap();
        let links = links_for(&format!(
            "[a]({root}/long.txt) [b]({root}/big.pdf) [c]({root}/small.pdf) [d]({root}/latin1.txt)"
        ));
        let read = |n: &str| read_artifact(&format!("{root}/{n}"), &links, CASE_INSENSITIVE, None, &l).unwrap();
        let long = read("long.txt");
        // Ten bytes end inside the é: the partial character is dropped.
        assert_eq!(
            (long["content"].as_str(), long["truncated"].as_bool(), long["size"].as_u64()),
            (Some("abcdefghi"), Some(true), Some(13))
        );
        let big = read("big.pdf");
        assert_eq!((big.get("base64"), big["truncated"].as_bool()), (None, Some(true)));
        assert_eq!(read("small.pdf")["base64"], json!("AAAAAAAAAAA="));
        let latin = read("latin1.txt");
        assert_eq!((latin["kind"].as_str(), latin["base64"].as_str()), (Some("binary"), Some("6WE=")));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_secret_through_a_symlink_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = slash(dir.path());
        std::fs::create_dir(dir.path().join(".ssh")).unwrap();
        std::fs::write(dir.path().join(".ssh/id_ed25519"), "KEY").unwrap();
        std::os::unix::fs::symlink(dir.path().join(".ssh/id_ed25519"), dir.path().join("notes.md")).unwrap();
        std::fs::create_dir(dir.path().join("site")).unwrap();
        std::fs::write(dir.path().join("site/index.html"), "x").unwrap();
        std::fs::write(dir.path().join("secret.css"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.css"), dir.path().join("site/a.css")).unwrap();
        std::fs::create_dir(dir.path().join("site/.private")).unwrap();
        std::fs::write(dir.path().join("site/.private/data.json"), "private").unwrap();
        std::os::unix::fs::symlink(dir.path().join("site/.private"), dir.path().join("site/public")).unwrap();
        let links = links_for(&format!("[n]({root}/notes.md) [s]({root}/site/index.html)"));
        let read = |n: &str| read_artifact(&format!("{root}/{n}"), &links, false, None, &limits());
        assert!(read("notes.md").unwrap_err().starts_with("secret-file:"));
        assert_eq!(read("site/a.css").unwrap_err(), NOT_LINKED_FILE, "an asset that leaves the page's folder");
        assert_eq!(read("site/public/data.json").unwrap_err(), NOT_LINKED_FILE, "a hidden real asset folder");
    }

    #[test]
    fn case_folding_does_not_authorize_a_different_real_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("report.md"), "linked").unwrap();
        std::fs::write(dir.path().join("REPORT.md"), "other").unwrap();
        if std::fs::canonicalize(dir.path().join("report.md")).unwrap()
            == std::fs::canonicalize(dir.path().join("REPORT.md")).unwrap()
        {
            return; // This volume is case-insensitive.
        }
        let root = slash(dir.path());
        let links = links_for(&format!("[report]({root}/report.md)"));
        assert_eq!(
            read_artifact(&format!("{root}/REPORT.md"), &links, true, None, &limits()).unwrap_err(),
            NOT_LINKED_FILE
        );
    }

    /// A tiny HTTP/1.1 server on 127.0.0.1: each request gets one canned answer, then the connection closes.
    async fn server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let mut got = Vec::new();
                    while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(n) = sock.read(&mut buf).await else { return };
                        if n == 0 {
                            return;
                        }
                        got.extend_from_slice(&buf[..n]);
                    }
                    let req = String::from_utf8_lossy(&got).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let lower = req.to_lowercase();
                    let header = |name: &str| {
                        lower
                            .lines()
                            .find_map(|l| l.strip_prefix(&format!("{name}: ")).map(str::to_string))
                            .unwrap_or_default()
                    };
                    let (status, extra, body): (&str, String, Vec<u8>) = match path.as_str() {
                        "/" => (
                            "200 OK",
                            "Content-Type: text/html\r\nSet-Cookie: s=1\r\nETag: \"v1\"\r\n".into(),
                            b"<h1>hi</h1>".to_vec(),
                        ),
                        "/echo" => (
                            "200 OK",
                            "Content-Type: text/plain\r\n".into(),
                            format!("host={};cookie={};ua={}", header("host"), header("cookie"), header("user-agent"))
                                .into_bytes(),
                        ),
                        "/hop" => ("302 Found", format!("Location: http://localhost:{port}/echo\r\n"), Vec::new()),
                        "/off" => ("302 Found", "Location: http://example.com/\r\n".into(), Vec::new()),
                        "/loop" => ("302 Found", "Location: /loop\r\n".into(), Vec::new()),
                        "/big" => {
                            ("200 OK", "Content-Type: application/octet-stream\r\n".into(), vec![7u8; 5 * 1024 * 1024])
                        }
                        "/slow" => {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            ("200 OK", String::new(), Vec::new())
                        }
                        _ => ("404 Not Found", String::new(), b"nope".to_vec()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    if !req.starts_with("HEAD") {
                        let _ = sock.write_all(&body).await;
                    }
                    let _ = sock.shutdown().await;
                });
            }
        });
        port
    }

    fn b64(v: &Value) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(v["base64"].as_str().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn fetches_only_a_linked_loopback_origin() {
        let port = server().await;
        let links = links_for(&format!("Running at http://localhost:{port}/"));
        let l = limits();
        // 127.0.0.1 and localhost are one origin; the Host the phone named is sent, nothing of the phone's.
        let v = fetch_preview(&format!("http://127.0.0.1:{port}/"), false, &links, &l).await.unwrap();
        assert_eq!((v["status"].as_u64(), v["contentType"].as_str()), (Some(200), Some("text/html")));
        assert_eq!(b64(&v), b"<h1>hi</h1>");
        assert_eq!(v["headers"]["etag"], json!("\"v1\""));
        assert!(v["headers"].get("set-cookie").is_none());
        let echo = fetch_preview(&format!("http://127.0.0.1:{port}/echo"), false, &links, &l).await.unwrap();
        let text = String::from_utf8(b64(&echo)).unwrap();
        assert!(text.starts_with(&format!("host=127.0.0.1:{port};cookie=;ua=nekkoagent-preview/")), "{text}");
        let head = fetch_preview(&format!("http://localhost:{port}/"), true, &links, &l).await.unwrap();
        assert_eq!((head["status"].as_u64(), head["base64"].as_str()), (Some(200), Some("")));
        // Another port, or another host, is not linked.
        assert_eq!(
            fetch_preview(&format!("http://localhost:{}/", port.wrapping_add(1)), false, &links, &l).await.unwrap_err(),
            NOT_LINKED_PREVIEW
        );
        assert_eq!(
            fetch_preview(&format!("http://[::1]:{port}/"), false, &links, &l).await.unwrap_err(),
            NOT_LINKED_PREVIEW
        );
        assert_eq!(
            fetch_preview("http://example.com/", false, &links, &l).await.unwrap_err(),
            "bad-request: not a local preview URL"
        );
    }

    #[tokio::test]
    async fn redirects_stay_in_the_origin_and_bodies_are_capped() {
        let port = server().await;
        let links = links_for(&format!("http://localhost:{port}"));
        let l = limits();
        let hop = fetch_preview(&format!("http://localhost:{port}/hop"), false, &links, &l).await.unwrap();
        assert_eq!(
            (hop["status"].as_u64(), hop["url"].as_str()),
            (Some(200), Some(format!("http://localhost:{port}/echo").as_str()))
        );
        let off = fetch_preview(&format!("http://localhost:{port}/off"), false, &links, &l).await.unwrap();
        assert_eq!(
            (off["status"].as_u64(), off["url"].as_str()),
            (Some(302), Some(format!("http://localhost:{port}/off").as_str()))
        );
        let looped = fetch_preview(&format!("http://localhost:{port}/loop"), false, &links, &l).await.unwrap();
        assert_eq!(looped["status"].as_u64(), Some(302), "five redirects, then the sixth comes back as it is");
        let big = fetch_preview(&format!("http://localhost:{port}/big"), false, &links, &l).await.unwrap();
        assert_eq!((b64(&big).len(), big["truncated"].as_bool()), (l.preview_bytes, Some(true)));
        let short = Limits { timeout: Duration::from_millis(300), ..limits() };
        let slow = fetch_preview(&format!("http://localhost:{port}/slow"), false, &links, &short).await.unwrap_err();
        assert!(slow.starts_with("timeout:"), "{slow}");
    }

    #[tokio::test]
    async fn nothing_listening_is_unreachable() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let links = links_for(&format!("http://localhost:{port}/"));
        let err = fetch_preview(&format!("http://localhost:{port}/"), false, &links, &limits()).await.unwrap_err();
        assert!(err.starts_with("unreachable:"), "{err}");
    }
}
