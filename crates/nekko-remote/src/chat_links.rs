//! What an agent linked in a chat (issue #1095): the daemon's copy of
//! `packages/shared/src/chat-links.ts`. The local files an agent linked
//! (Markdown links and images, `file://` URLs and absolute paths, outside
//! fenced and inline code) and the local preview servers it named
//! (`http(s)://localhost|127.0.0.1|0.0.0.0|[::1]`, outside fenced code), read
//! from a chat's assistant messages. A paired phone may open exactly these
//! (`artifact:read`, `preview:fetch`), so this is a security boundary.
//!
//! The shared cases in `tests/golden/phone-artifacts.json`, written by the TS,
//! hold the two copies equal. Text is scanned byte by byte: every pattern is
//! ASCII, so the positions agree with the TS's UTF-16 ones.

use serde_json::{Value, json};

/// `CHAT_LINK_EXT`: extensions a linked artifact may have.
pub const LINK_EXT: [&str; 20] = [
    "csv", "doc", "docx", "gif", "htm", "html", "jpeg", "jpg", "json", "markdown", "md", "pdf", "png", "ppt", "pptx",
    "svg", "txt", "webp", "xls", "xlsx",
];

/// `CHAT_ASSET_EXT`: extensions of the files a linked HTML page may load from its folder.
pub const ASSET_EXT: [&str; 22] = [
    "avif", "css", "csv", "gif", "htm", "html", "ico", "jpeg", "jpg", "js", "json", "map", "md", "mjs", "otf", "png",
    "svg", "ttf", "txt", "webp", "woff", "woff2",
];

/// `LOOPBACK_HOSTS`: the first three are one origin (`localhost`).
pub const LOOPBACK_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

/// `ChatLinks`: artifact paths (normalised, absolute) and loopback origins (`http://localhost:5173`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatLinks {
    pub artifacts: Vec<String>,
    pub origins: Vec<String>,
}

impl ChatLinks {
    pub fn value(&self) -> Value {
        json!({ "artifacts": self.artifacts, "origins": self.origins })
    }

    pub fn from_value(v: &Value) -> Self {
        let list = |k: &str| {
            v[k].as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
        };
        ChatLinks { artifacts: list("artifacts"), origins: list("origins") }
    }
}

fn find(s: &str, pat: &str, from: usize) -> Option<usize> {
    s.get(from..)?.find(pat).map(|i| i + from)
}

/// `withoutFences`: text with fenced code blocks removed (an unclosed fence runs to the end).
pub fn without_fences(text: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    loop {
        let Some(open) = find(text, "```", i) else {
            out.push_str(&text[i..]);
            return out;
        };
        out.push_str(&text[i..open]);
        let Some(close) = find(text, "```", open + 3) else { return out };
        i = close + 3;
    }
}

/// `withoutInlineCode`: text with inline code spans (one line, between single backticks) removed.
pub fn without_inline_code(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::new();
    let (mut i, mut from) = (0, 0);
    while i < b.len() {
        if b[i] == b'`' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'`' && b[j] != b'\n' {
                j += 1;
            }
            if j < b.len() && b[j] == b'`' {
                out.push_str(&text[from..i]);
                i = j + 1;
                from = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[from..]);
    out
}

/// `markdownHrefs`: the hrefs of Markdown links and images, in order.
pub fn markdown_hrefs(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'[' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < b.len() && b[j] != b']' && b[j] != b'\n' {
            j += 1;
        }
        if j >= b.len() || b[j] != b']' || b.get(j + 1) != Some(&b'(') {
            i += 1;
            continue;
        }
        let start = j + 2;
        let mut k = start;
        while k < b.len() && b[k] != b')' && b[k] != b'\n' {
            k += 1;
        }
        if k >= b.len() || b[k] != b')' || k == start {
            i += 1;
            continue;
        }
        out.push(text[start..k].to_string());
        i = k + 1;
    }
    out
}

/// `decodeURIComponent`, or None on a malformed escape or bytes that are not UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            if !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `^[a-z]:[\\/]` (case-insensitive).
fn starts_with_drive_slash(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

/// `^[a-z][a-z\d+.-]*:` (case-insensitive): a URL scheme, or a drive letter.
fn starts_with_scheme(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return false;
    }
    for &c in &b[1..] {
        if c == b':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == b'+' || c == b'.' || c == b'-') {
            return false;
        }
    }
    false
}

fn has_control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
}

/// The path of a `file:` URL (`file:///home/a`, `file://localhost/a`, `file:/a`, `file:///C:/a`).
fn file_url_path(url: &str) -> Option<String> {
    let mut rest = &url[5..];
    if let Some(cut) = rest.find(['?', '#']) {
        rest = &rest[..cut];
    }
    if let Some(after) = rest.strip_prefix("//") {
        let slash = after.find('/')?;
        let host = after[..slash].to_lowercase();
        if !host.is_empty() && host != "localhost" {
            return None;
        }
        rest = &after[slash..];
    }
    if !rest.starts_with('/') {
        return None;
    }
    let decoded = percent_decode(rest)?;
    let b = decoded.as_bytes();
    let drive =
        b.len() >= 3 && b[1].is_ascii_alphabetic() && b[2] == b':' && (b.len() == 3 || b[3] == b'/' || b[3] == b'\\');
    Some(if drive { decoded[1..].to_string() } else { decoded })
}

/// `localPath`: a link or a phone's path as a normalised absolute path on this
/// computer (`/a/b` or `C:/a/b`), or None.
pub fn local_path(href: &str, base: Option<&str>) -> Option<String> {
    let mut p = href.trim();
    p = p.strip_prefix('<').unwrap_or(p);
    p = p.strip_suffix('>').unwrap_or(p);
    let p: String = if p.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("file:")) {
        file_url_path(p)?
    } else {
        if p.starts_with('\\') || p.starts_with("//") || p.starts_with('#') {
            return None;
        }
        if starts_with_scheme(p) && !starts_with_drive_slash(p) {
            return None;
        }
        match p.find(['?', '#']) {
            Some(cut) => p[..cut].to_string(),
            None => p.to_string(),
        }
    };
    if p.is_empty() || has_control(&p) {
        return None;
    }
    let absolute = starts_with_drive_slash(&p) || p.starts_with('/');
    let combined = if absolute {
        p.replace('\\', "/")
    } else {
        let base = base.filter(|b| !b.is_empty())?;
        format!("{base}/{p}").replace('\\', "/")
    };
    let drive_root = {
        let b = combined.as_bytes();
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/'
    };
    if combined.starts_with("//") || (!drive_root && !combined.starts_with('/')) {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in combined.split('/') {
        if part == ".." {
            if parts.last().is_some_and(|l| !is_drive(l)) {
                parts.pop();
            }
        } else if !part.is_empty() && part != "." {
            parts.push(part);
        }
    }
    let path = format!("{}{}", if combined.starts_with('/') { "/" } else { "" }, parts.join("/"));
    let after_drive = if path.get(..2).is_some_and(is_drive) { &path[2..] } else { &path[..] };
    if has_control(&path) || after_drive.contains(':') {
        return None;
    }
    Some(path)
}

/// `pathExt`: the lowercase extension of a path's last segment, or "".
pub fn path_ext(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or("");
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `linkArtifactPath`: a Markdown link's target as an artifact path.
pub fn link_artifact_path(href: &str, base: Option<&str>) -> Option<String> {
    local_path(href, base).filter(|p| LINK_EXT.contains(&path_ext(p).as_str()))
}

/// `LoopbackUrl`: a parsed loopback URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackUrl {
    /// `http://localhost:5173` or `http://[::1]:9000`.
    pub origin: String,
    pub scheme: &'static str,
    /// The authority as written, host lowercased: the `Host` header sent.
    pub authority: String,
    pub port: u16,
    /// `localhost` (also `127.0.0.1` and `0.0.0.0`) or `[::1]`.
    pub host: &'static str,
    /// Path and query, starting `/`; the fragment is dropped.
    pub path: String,
    /// The URL rebuilt from the checked parts.
    pub url: String,
}

impl LoopbackUrl {
    pub fn value(&self) -> Value {
        json!({
            "origin": self.origin, "scheme": self.scheme, "authority": self.authority, "port": self.port,
            "host": self.host, "path": self.path, "url": self.url,
        })
    }
}

/// The loopback host at byte `i`, and where it ends.
fn loopback_host(b: &[u8], i: usize) -> Option<(&'static str, usize)> {
    for name in LOOPBACK_HOSTS {
        if b.get(i..i + name.len()).is_some_and(|s| s.eq_ignore_ascii_case(name.as_bytes())) {
            return Some((if name == "[::1]" { "[::1]" } else { "localhost" }, i + name.len()));
        }
    }
    None
}

/// `http://` or `https://` at byte `i` (case-insensitive).
fn scheme_at(b: &[u8], i: usize) -> Option<&'static str> {
    if b.get(i..i + 8).is_some_and(|s| s.eq_ignore_ascii_case(b"https://")) {
        Some("https")
    } else if b.get(i..i + 7).is_some_and(|s| s.eq_ignore_ascii_case(b"http://")) {
        Some("http")
    } else {
        None
    }
}

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `loopbackUrl`: a URL a phone may ask the computer to fetch, or None.
pub fn loopback_url(url: &str, max_chars: usize) -> Option<LoopbackUrl> {
    if len16(url) > max_chars || url.chars().any(|c| (c as u32) <= 0x20 || c as u32 == 0x7f || c == '\\') {
        return None;
    }
    let scheme = scheme_at(url.as_bytes(), 0)?;
    let at = scheme.len() + 3;
    let end = url[at..].find(['/', '?', '#']).map_or(url.len(), |e| at + e);
    let authority = url[at..end].to_lowercase();
    if authority.contains('@') {
        return None;
    }
    let (host, host_end) = loopback_host(authority.as_bytes(), 0)?;
    let mut port: u32 = if scheme == "https" { 443 } else { 80 };
    if host_end < authority.len() {
        if authority.as_bytes()[host_end] != b':' {
            return None;
        }
        let digits = &authority[host_end + 1..];
        if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        port = digits.parse().ok()?;
        if !(1..=65535).contains(&port) {
            return None;
        }
    }
    let mut path = url[end..].to_string();
    if let Some(hash) = path.find('#') {
        path.truncate(hash);
    }
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    Some(LoopbackUrl {
        origin: format!("{scheme}://{host}:{port}"),
        scheme,
        url: format!("{scheme}://{authority}{path}"),
        authority,
        port: port as u16,
        host,
        path,
    })
}

/// `loopbackOrigins`: the loopback origins in `text`, in order, once each.
pub fn loopback_origins(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    for i in 0..b.len() {
        if b[i] != b'h' && b[i] != b'H' {
            continue;
        }
        let Some(scheme) = scheme_at(b, i) else { continue };
        let Some((host, mut j)) = loopback_host(b, i + scheme.len() + 3) else { continue };
        let mut port: u32 = if scheme == "https" { 443 } else { 80 };
        let has_port = b.get(j) == Some(&b':') && b.get(j + 1).is_some_and(u8::is_ascii_digit);
        if has_port {
            let mut k = j + 1;
            while b.get(k).is_some_and(u8::is_ascii_digit) {
                k += 1;
            }
            if k - (j + 1) > 5 {
                continue;
            }
            port = text[j + 1..k].parse().unwrap_or(0);
            if !(1..=65535).contains(&port) {
                continue;
            }
            j = k;
        }
        if let Some(&next) = b.get(j)
            && (!next.is_ascii()
                || next.is_ascii_alphanumeric()
                || b"_%\\-:@".contains(&next)
                || (next == b'.' && (!has_port || b.get(j + 1).is_some_and(|c| c.is_ascii_alphanumeric()))))
        {
            continue;
        }
        let origin = format!("{scheme}://{host}:{port}");
        if !out.contains(&origin) {
            out.push(origin);
        }
    }
    out
}

/// `messageLinks`: the artifacts and loopback origins one assistant message links.
pub fn message_links(text: &str, base: Option<&str>) -> ChatLinks {
    let prose = without_fences(text);
    let mut artifacts: Vec<String> = Vec::new();
    for href in markdown_hrefs(&without_inline_code(&prose)) {
        if let Some(p) = link_artifact_path(&href, base)
            && !artifacts.contains(&p)
        {
            artifacts.push(p);
        }
    }
    ChatLinks { artifacts, origins: loopback_origins(&prose) }
}

/// `chatLinks`: what a chat's assistant messages link (`messages` is
/// `session.messages`, `base` the chat's folder when it has one).
pub fn chat_links(messages: &Value, base: Option<&str>) -> ChatLinks {
    let mut out = ChatLinks::default();
    for m in messages.as_array().into_iter().flatten() {
        if m.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(content) = m.get("content").and_then(Value::as_str) else { continue };
        let one = message_links(content, base);
        for a in one.artifacts {
            if !out.artifacts.contains(&a) {
                out.artifacts.push(a);
            }
        }
        for o in one.origins {
            if !out.origins.contains(&o) {
                out.origins.push(o);
            }
        }
    }
    out
}

/// `ArtifactAccess`: a linked artifact, or a file in a linked page's folder (`root`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Access {
    Linked(String),
    Asset(String),
}

impl Access {
    pub fn value(&self) -> Value {
        match self {
            Access::Linked(root) => json!({ "kind": "linked", "root": root }),
            Access::Asset(root) => json!({ "kind": "asset", "root": root }),
        }
    }
}

/// `artifactAccess`: whether a normalised path may be read for this chat's links.
pub fn artifact_access(path: &str, links: &ChatLinks, case_insensitive: bool) -> Option<Access> {
    let key = |s: &str| if case_insensitive { s.to_lowercase() } else { s.to_string() };
    let want = key(path);
    if let Some(linked) = links.artifacts.iter().find(|a| key(a) == want) {
        return Some(Access::Linked(linked.clone()));
    }
    if !ASSET_EXT.contains(&path_ext(path).as_str()) {
        return None;
    }
    for a in &links.artifacts {
        let ext = path_ext(a);
        if ext != "html" && ext != "htm" {
            continue;
        }
        let dir = &a[..a.rfind('/').unwrap_or(0)];
        // `/page.html` or `C:/page.html`: the root of a disk is not a page's folder.
        if dir.is_empty() || is_drive(dir) {
            continue;
        }
        let prefix = format!("{}/", key(dir));
        let Some(rel) = want.strip_prefix(&prefix) else { continue };
        if rel.split('/').any(|s| s.starts_with('.')) {
            continue;
        }
        return Some(Access::Asset(dir.to_string()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lists_match_the_policy() {
        let p: Value = serde_json::from_str(include_str!("phone-access.json")).unwrap();
        let list = |k: &str| -> Vec<String> {
            p["artifacts"][k].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
        };
        assert_eq!(list("linkExt"), LINK_EXT.to_vec());
        assert_eq!(list("assetExt"), ASSET_EXT.to_vec());
        assert_eq!(list("loopbackHosts"), LOOPBACK_HOSTS.to_vec());
    }

    #[test]
    fn non_ascii_text_scans_without_panicking() {
        let links = message_links("é [日本](/tmp/日本.md) `ü` http://localhost:1 ```é", None);
        assert_eq!(links.artifacts, vec!["/tmp/日本.md".to_string()]);
        assert_eq!(links.origins, vec!["http://localhost:1".to_string()]);
        let l = ChatLinks { artifacts: vec!["/İ/a.html".into()], origins: vec![] };
        assert!(artifact_access("/i̇/b.css", &l, true).is_some());
        assert_eq!(local_path("file:///tmp/%C3", None), None);
        assert_eq!(local_path("file:///tmp/%zz", None), None);
        assert_eq!(loopback_url("http://localhosté/", 2048), None);
        assert_eq!(loopback_url("http://[::1]é/", 2048), None);
    }
}
