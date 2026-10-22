//! `fetch_url`, ported from `packages/host/src/web-fetch.ts`.
//!
//! One GET with a size and time limit, HTML reduced to text with its links
//! kept, and the head of the result handed back. The HTML pass is the TS
//! regex pass run on the same JavaScript regular expressions
//! ([`nekko_tools::jsre`]) over UTF-16, so the text the model reads is the
//! same; `golden/fetch.json`, a frozen record of the deleted TS functions,
//! holds it to that.
//!
//! What differs, on purpose or by necessity: a body is decompressed by
//! reqwest (Node's fetch does too), which drops `content-length` from a
//! compressed reply, so the binary-type message may say `unknown` where Node
//! named the compressed size; a character reference to a lone surrogate
//! (`&#xD800;`) reaches the model as U+FFFD instead of an unpaired unit.
//!
//! Where it may go: only the public internet unless the caller passes hosts
//! the user approved ([`crate::netguard`]). Every redirect hop is checked
//! again. Without a proxy the check runs in the client's own resolver, so the
//! address checked is the address dialed. When the environment or system
//! names a proxy for the URL, the host is resolved here first to decide, and
//! the request then goes through the proxy, which resolves the name again:
//! a name that changes its answer in between (DNS rebinding), or that only
//! the proxy can resolve, is not caught on that path. A local or private
//! destination comes back as [`FetchError::Local`] for the caller to ask about.

use crate::netguard::{self, PublicOnly};
use nekko_js as js;
use nekko_tools::Cancel;
use nekko_tools::jsre::JsRegex;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

/// Longest a fetch may take, connect and body included.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Most bytes read from a response.
pub const FETCH_MAX_BYTES: usize = 2_000_000;
/// Default characters handed to the model.
pub const FETCH_DEFAULT_CHARS: f64 = 20_000.0;
/// Ceiling on `max_chars`.
pub const FETCH_MAX_CHARS: f64 = 100_000.0;
/// Redirects followed, each one checked (Node's fetch follows 20).
pub const FETCH_MAX_REDIRECTS: usize = 20;

const USER_AGENT: &str = "Mozilla/5.0 (compatible; NekkoAgent/1.0; +https://nekkoagent.com)";

const BLOCK_TAGS: &[&str] = &[
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "ul",
    "ol",
    "li",
    "table",
    "tr",
    "blockquote",
    "pre",
    "figure",
    "figcaption",
    "dl",
    "dt",
    "dd",
    "form",
    "hr",
    "address",
    "details",
    "summary",
];

fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        // A plain space in the TS table, so it folds with the others.
        "nbsp" => " ",
        "hellip" => "\u{2026}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "copy" => "\u{a9}",
        "reg" => "\u{ae}",
        "trade" => "\u{2122}",
        "laquo" => "\u{ab}",
        "raquo" => "\u{bb}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        _ => return None,
    })
}

fn u(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

macro_rules! regex {
    ($name:ident, $src:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> =
            LazyLock::new(|| JsRegex::new($src, $flags).expect(concat!("valid regex ", stringify!($name))));
    };
}

regex!(ENTITY, r"&(#x[0-9a-f]+|#\d+|[a-z]+);", "gi");
regex!(COMMENT, r"<!--[\s\S]*?-->", "g");
regex!(DOCTYPE, r"<!doctype[^>]*>", "gi");
regex!(DROPPED, r"<(script|style|noscript|svg|canvas|template|iframe|object|embed)\b[\s\S]*?<\/\1\s*>", "gi");
regex!(HEAD, r"<head\b[\s\S]*?<\/head\s*>", "gi");
regex!(TITLE, r"<title[^>]*>([\s\S]*?)<\/title>", "i");
regex!(BR, r"<br\s*\/?>", "gi");
regex!(H_OPEN, r"<h([1-6])\b[^>]*>", "gi");
regex!(H_CLOSE, r"<\/h[1-6]\s*>", "gi");
regex!(LI_OPEN, r"<li\b[^>]*>", "gi");
regex!(LI_CLOSE, r"<\/li\s*>", "gi");
regex!(CELL, r"<(td|th)\b[^>]*>", "gi");
regex!(CODE_OPEN, r"<(pre|code)\b[^>]*>", "gi");
regex!(CODE_CLOSE, r"<\/(pre|code)\s*>", "gi");
regex!(LINK, r#"<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>"#, "gi");
regex!(ANY_TAG, r"<[^>]+>", "g");
regex!(SPACES, r"\s+", "g");
regex!(SKIP_LINK, r"^(#|javascript:|mailto:)", "i");
regex!(IMG, r#"<img\b[^>]*alt\s*=\s*(["'])(.*?)\1[^>]*>"#, "gi");
regex!(TAG, r"<\/?([a-z][a-z0-9]*)\b[^>]*>", "gi");
regex!(INLINE_SPACE, r"[ \t\r\f\v]+", "g");
regex!(LINE_SPACE, r" *\n *", "g");
regex!(BLANK_LINES, r"\n{3,}", "g");
regex!(HTML_SNIFF, r"<html[\s>]|<body[\s>]|<!doctype html", "i");

/// `s.trim()` over UTF-16 units.
fn trim16(s: &[u16]) -> &[u16] {
    let space = |c: &u16| char::from_u32(u32::from(*c)).is_some_and(js::is_js_space);
    let start = s.iter().position(|c| !space(c)).unwrap_or(s.len());
    let end = s.iter().rposition(|c| !space(c)).map_or(start, |i| i + 1);
    &s[start..end]
}

/// `parseInt(digits, radix)` for the digits the entity regex admits, as a
/// code point when it is one `String.fromCodePoint` accepts.
fn code_point(digits: &[u16], radix: u32) -> Option<u32> {
    let mut n: u32 = 0;
    for &d in digits {
        let v = char::from_u32(u32::from(d))?.to_digit(radix)?;
        n = n.checked_mul(radix)?.checked_add(v)?;
        if n >= 0x110000 {
            return None;
        }
    }
    (n > 0).then_some(n)
}

/// `String.fromCodePoint(n)` as UTF-16, lone surrogates included.
fn from_code_point(n: u32) -> Vec<u16> {
    if n < 0x10000 {
        return vec![n as u16];
    }
    let v = n - 0x10000;
    vec![0xD800 + (v >> 10) as u16, 0xDC00 + (v & 0x3FF) as u16]
}

fn decode_entities16(s: &[u16]) -> Vec<u16> {
    ENTITY.replace_all(s, |g| {
        let (whole, code) = (g[0].unwrap_or_default(), g[1].unwrap_or_default());
        if code.first() == Some(&u16::from(b'#')) {
            let hex = matches!(code.get(1), Some(&c) if c == u16::from(b'x') || c == u16::from(b'X'));
            let n = if hex { code_point(&code[2..], 16) } else { code_point(&code[1..], 10) };
            return n.map_or_else(|| whole.to_vec(), from_code_point);
        }
        entity(&lossy(code).to_ascii_lowercase()).map_or_else(|| whole.to_vec(), u)
    })
}

/// `decodeEntities(s)`.
pub fn decode_entities(s: &str) -> String {
    lossy(&decode_entities16(&u(s)))
}

/// `new URL(href, base).toString()`, or `href` as written when that throws.
fn absolute(href: &str, base: &str) -> String {
    url::Url::parse(base)
        .and_then(|b| url::Url::options().base_url(Some(&b)).parse(href))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| href.to_string())
}

/// `htmlToText(html, baseUrl)`: scripts, styles and hidden boilerplate
/// dropped, headings marked, lists bulleted, links kept as `text (href)`,
/// whitespace folded.
pub fn html_to_text(html: &str, base_url: Option<&str>) -> String {
    lossy(&html_to_text16(&u(html), base_url))
}

fn html_to_text16(html: &[u16], base_url: Option<&str>) -> Vec<u16> {
    let mut s = COMMENT.replace_all_with(html, "");
    s = DOCTYPE.replace_all_with(&s, "");
    s = DROPPED.replace_all_with(&s, "");
    s = HEAD.replace_all(&s, |g| {
        let head = g[0].unwrap_or_default();
        match TITLE.exec(head).and_then(|groups| groups.get(1).cloned().flatten()) {
            Some(r) if !r.is_empty() => [u("<h1>"), head[r].to_vec(), u("</h1>")].concat(),
            _ => Vec::new(),
        }
    });
    s = BR.replace_all_with(&s, "\n");
    s = H_OPEN.replace_all(&s, |g| {
        let n = g[1].and_then(|d| d.first()).map_or(1, |&d| usize::from(d - u16::from(b'0')));
        u(&format!("\n\n{} ", "#".repeat(n)))
    });
    s = H_CLOSE.replace_all_with(&s, "\n\n");
    s = LI_OPEN.replace_all_with(&s, "\n- ");
    s = LI_CLOSE.replace_all_with(&s, "");
    s = CELL.replace_all_with(&s, " | ");
    s = CODE_OPEN.replace_all_with(&s, "`");
    s = CODE_CLOSE.replace_all_with(&s, "`");
    s = LINK.replace_all(&s, |g| {
        let (href, text) = (g[2].unwrap_or_default(), g[3].unwrap_or_default());
        let stripped = ANY_TAG.replace_all_with(text, "");
        let folded = SPACES.replace_all_with(&stripped, " ");
        let label = trim16(&folded).to_vec();
        if label.is_empty() {
            return Vec::new();
        }
        if SKIP_LINK.find(href).is_some() {
            return label;
        }
        let href = lossy(href);
        let abs = match base_url {
            Some(base) => absolute(&href, base),
            None => href,
        };
        let abs = u(&abs);
        if abs == label { label } else { [label, u(" ("), abs, u(")")].concat() }
    });
    s = IMG.replace_all(&s, |g| {
        let alt = trim16(g[2].unwrap_or_default());
        if alt.is_empty() { Vec::new() } else { [u("[image: "), alt.to_vec(), u("]")].concat() }
    });
    s = TAG.replace_all(&s, |g| {
        let tag = lossy(g[1].unwrap_or_default()).to_ascii_lowercase();
        if BLOCK_TAGS.contains(&tag.as_str()) { u("\n") } else { Vec::new() }
    });
    s = decode_entities16(&s);
    s = INLINE_SPACE.replace_all_with(&s, " ");
    s = LINE_SPACE.replace_all_with(&s, "\n");
    s = BLANK_LINES.replace_all_with(&s, "\n\n");
    trim16(&s).to_vec()
}

/// A fetched page, as `fetchUrl` returns it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    /// The readable text, cut to `max_chars`.
    pub text: String,
    /// UTF-16 units of readable text before the cut.
    pub total_chars: usize,
    pub truncated: bool,
}

/// What `fetchUrl` reads off a response, the network part done.
#[derive(Clone, Debug, Default)]
pub struct Reply {
    pub status: u16,
    /// `res.url`: where redirects ended; empty when unknown.
    pub final_url: String,
    pub content_type: Option<String>,
    pub content_length: Option<String>,
    /// The body, at most [`FETCH_MAX_BYTES`].
    pub body: Vec<u8>,
}

/// `new URL(raw.trim())`, http(s) only.
pub fn parse_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(js::trim(raw)).map_err(|_| format!("Not a URL: {raw}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Only http and https URLs can be fetched (got {}:).", url.scheme()));
    }
    Ok(url)
}

/// `Math.min(Math.max(1000, Math.round(maxChars ?? 20000)), 100000)`.
pub fn max_chars(requested: Option<f64>) -> usize {
    let n = requested.unwrap_or(FETCH_DEFAULT_CHARS);
    let rounded = (n + 0.5).floor();
    let n = if rounded.is_nan() { f64::NAN } else { rounded.max(1000.0) };
    // Math.max(1000, NaN) is NaN and Math.min(NaN, ...) too; a JSON number is never NaN.
    if n.is_nan() { FETCH_DEFAULT_CHARS as usize } else { n.min(FETCH_MAX_CHARS) as usize }
}

/// The first `charset=` value in a lower-cased content type.
fn charset(content_type: &str) -> Option<&str> {
    let mut rest = content_type;
    while let Some(at) = rest.find("charset=") {
        let value = &rest[at + "charset=".len()..];
        let end = value.find(|c: char| c == ';' || js::is_js_space(c)).unwrap_or(value.len());
        if end > 0 {
            return Some(&value[..end]);
        }
        rest = value;
    }
    None
}

/// `new TextDecoder(label).decode(bytes)`, utf-8 when the label is unknown.
fn decode(bytes: &[u8], label: Option<&str>) -> String {
    let encoding = label
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .filter(|e| *e != encoding_rs::REPLACEMENT)
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode_with_bom_removal(bytes).0.into_owned()
}

fn is_textual(kind: &str) -> bool {
    kind.is_empty()
        || kind.starts_with("text/")
        || ["json", "xml", "javascript", "yaml", "csv", "markdown", "x-sh", "x-www-form-urlencoded"]
            .iter()
            .any(|k| kind.contains(k))
}

/// The page `fetchUrl` makes of a reply: binary types refused with their
/// type named, the body decoded by its charset, HTML reduced to text, the
/// text cut to `max_chars` UTF-16 units.
pub fn page_from_reply(url: &url::Url, reply: Reply, max_chars: usize) -> Result<FetchedPage, String> {
    let content_type = reply.content_type.unwrap_or_default().to_lowercase();
    let kind = js::trim(content_type.split(';').next().unwrap_or_default()).to_string();
    if !is_textual(&kind) {
        return Err(format!(
            "{url} is {} ({} bytes), not text. Download it with bash (curl) if you need it.",
            if kind.is_empty() { "binary" } else { &kind },
            reply.content_length.as_deref().unwrap_or("unknown"),
        ));
    }
    let raw = decode(&reply.body, charset(&content_type));
    let raw16 = u(&raw);
    let final_url = if reply.final_url.is_empty() { url.to_string() } else { reply.final_url };
    let is_html =
        kind.contains("html") || (kind.is_empty() && HTML_SNIFF.find(&raw16[..raw16.len().min(2_000)]).is_some());
    let full = if is_html { html_to_text16(&raw16, Some(&final_url)) } else { trim16(&raw16).to_vec() };
    let truncated = full.len() > max_chars;
    Ok(FetchedPage {
        url: url.to_string(),
        final_url,
        status: reply.status,
        content_type: kind,
        text: lossy(if truncated { &full[..max_chars] } else { &full }),
        total_chars: full.len(),
        truncated,
    })
}

/// `n.toLocaleString()` in the default (en-US) locale.
pub fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `describeFetched(page)`: the tool's output.
pub fn describe_fetched(page: &FetchedPage) -> String {
    let wh =
        if page.final_url != page.url { format!("{} \u{2192} {}", page.url, page.final_url) } else { page.url.clone() };
    let shown = if page.truncated {
        format!(", showing the first {}", group_thousands(js::len16(&page.text)))
    } else {
        String::new()
    };
    let ct = if page.content_type.is_empty() { String::new() } else { format!(", {}", page.content_type) };
    let head = format!("{wh} (HTTP {}{ct}, {} chars{shown})", page.status, group_thousands(page.total_chars));
    let text = if page.text.is_empty() { "(no readable text)" } else { &page.text };
    format!("{head}\n\n{text}")
}

/// Why a network read stopped, in the words Node's fetch uses.
enum Stop {
    Timeout,
    Cancel,
}

/// The client a fetch goes out on: the public-only resolver (with the hosts
/// the user approved), no proxy (a proxy would resolve names itself), and
/// redirects followed by hand so each hop is checked.
fn build_client(allowed: &HashSet<String>) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .dns_resolver(std::sync::Arc::new(PublicOnly::system().allowing(allowed.clone())))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())
}

fn client(allowed: &HashSet<String>) -> Result<reqwest::Client, String> {
    static PUBLIC: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| build_client(&HashSet::new()));
    if allowed.is_empty() { PUBLIC.clone() } else { build_client(allowed) }
}

/// The client for URLs a proxy is configured for: reqwest's own proxy
/// detection, redirects by hand.
fn proxied_client() -> Result<reqwest::Client, String> {
    static PROXIED: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| e.to_string())
    });
    PROXIED.clone()
}

/// The proxy settings reqwest reads (`HTTP_PROXY`, `HTTPS_PROXY`,
/// `ALL_PROXY`, `NO_PROXY`), read the same way.
fn proxy_matcher() -> &'static hyper_util::client::proxy::matcher::Matcher {
    static M: LazyLock<hyper_util::client::proxy::matcher::Matcher> =
        LazyLock::new(hyper_util::client::proxy::matcher::Matcher::from_system);
    &M
}

/// A proxy is configured for this URL.
pub fn uses_proxy(url: &url::Url) -> bool {
    url.as_str().parse::<http::Uri>().is_ok_and(|uri| proxy_matcher().intercept(&uri).is_some())
}

/// Before a proxied request: the host's addresses, resolved here, must all be
/// public unless the user approved the host. A name that does not resolve
/// here goes to the proxy as it is (only the proxy may know it).
async fn check_before_proxy(at: &url::Url, allowed: &HashSet<String>) -> Result<(), FetchError> {
    let Some(url::Host::Domain(name)) = at.host() else { return Ok(()) };
    match PublicOnly::system().allowing(allowed.clone()).resolve_public(name.to_string()).await {
        Err(e) if e.downcast_ref::<netguard::Blocked>().is_some() => {
            Err(FetchError::Local { url: at.to_string(), host: netguard::host_key(at) })
        }
        _ => Ok(()),
    }
}

/// Why `fetch_url` did not return a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// `url` (the first URL or a redirect hop) is on this computer or the
    /// local network, at `host`, and `host` was not approved.
    Local { url: String, host: String },
    /// Anything else, worded for the model.
    Failed(String),
}

impl From<String> for FetchError {
    fn from(e: String) -> Self {
        FetchError::Failed(e)
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Local { url, host } => {
                write!(f, "Not fetched: {url} is on this computer or the local network ({host}).")
            }
            FetchError::Failed(e) => f.write_str(e),
        }
    }
}

/// `fetchUrl(raw, { maxChars, signal })`: GET a URL and reduce it to text.
///
/// `allowed_local` names the hosts (as [`netguard::host_key`] writes them)
/// the user approved reaching on this computer or the local network.
pub async fn fetch_url(
    raw: &str,
    requested_chars: Option<f64>,
    cancel: &Cancel,
    allowed_local: &HashSet<String>,
) -> Result<FetchedPage, FetchError> {
    let url = parse_url(raw)?;
    let max = max_chars(requested_chars);
    let deadline = tokio::time::Instant::now() + FETCH_TIMEOUT;
    let pinned = client(allowed_local)?;
    let mut at = url.clone();
    let mut hops = 0;
    let res = loop {
        if let Some(host) = netguard::local_host(&at).filter(|h| !allowed_local.contains(h)) {
            return Err(FetchError::Local { url: at.to_string(), host });
        }
        let client = if uses_proxy(&at) {
            tokio::select! {
                checked = check_before_proxy(&at, allowed_local) => checked?,
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(format!("Fetching {url} took longer than {} s.", FETCH_TIMEOUT.as_secs()).into());
                }
                _ = cancel.cancelled() => return Err(format!("Could not fetch {url}: This operation was aborted").into()),
            }
            proxied_client()?
        } else {
            pinned.clone()
        };
        let request = client
            .get(at.as_str())
            .header("accept", "text/html, application/xhtml+xml, text/plain;q=0.9, application/json;q=0.8, */*;q=0.5")
            .header("accept-language", "en, *;q=0.5")
            .send();
        let res = tokio::select! {
            r = request => match r {
                Ok(r) => r,
                Err(e) if netguard::is_blocked(&e) => {
                    return Err(FetchError::Local { url: at.to_string(), host: netguard::host_key(&at) });
                }
                Err(_) => return Err(format!("Could not fetch {url}: fetch failed").into()),
            },
            _ = tokio::time::sleep_until(deadline) => {
                return Err(format!("Fetching {url} took longer than {} s.", FETCH_TIMEOUT.as_secs()).into());
            }
            _ = cancel.cancelled() => return Err(format!("Could not fetch {url}: This operation was aborted").into()),
        };
        let location = res.headers().get("location").and_then(|v| v.to_str().ok()).filter(|l| !l.is_empty());
        if let (true, Some(location)) = (matches!(res.status().as_u16(), 301 | 302 | 303 | 307 | 308), location) {
            if hops >= FETCH_MAX_REDIRECTS {
                return Err(format!("Could not fetch {url}: redirect count exceeded").into());
            }
            let next = at.join(location).map_err(|_| format!("Could not fetch {url}: fetch failed"))?;
            if next.scheme() != "http" && next.scheme() != "https" {
                return Err(format!("Could not fetch {url}: fetch failed").into());
            }
            at = next;
            hops += 1;
            continue;
        }
        break res;
    };
    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let mut reply = Reply {
        status: res.status().as_u16(),
        final_url: at.to_string(),
        content_type: header("content-type"),
        content_length: header("content-length"),
        body: Vec::new(),
    };
    let kind = reply.content_type.clone().unwrap_or_default().to_lowercase();
    let kind = js::trim(kind.split(';').next().unwrap_or_default()).to_string();
    if is_textual(&kind) {
        use futures_util::StreamExt;
        let mut stream = res.bytes_stream();
        loop {
            let next = tokio::select! {
                n = stream.next() => n,
                _ = tokio::time::sleep_until(deadline) => return Err(stop_message(Stop::Timeout).into()),
                _ = cancel.cancelled() => return Err(stop_message(Stop::Cancel).into()),
            };
            match next {
                None => break,
                Some(Err(_)) => return Err(FetchError::Failed("terminated".into())),
                Some(Ok(chunk)) => {
                    let room = FETCH_MAX_BYTES - reply.body.len();
                    reply.body.extend_from_slice(&chunk[..chunk.len().min(room)]);
                    if reply.body.len() >= FETCH_MAX_BYTES {
                        break;
                    }
                }
            }
        }
    }
    Ok(page_from_reply(&url, reply, max)?)
}

fn stop_message(stop: Stop) -> String {
    match stop {
        Stop::Timeout => "The operation was aborted due to timeout".into(),
        Stop::Cancel => "This operation was aborted".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_thousands_like_en_us() {
        assert_eq!(group_thousands(0), "0");
        assert_eq!(group_thousands(999), "999");
        assert_eq!(group_thousands(1000), "1,000");
        assert_eq!(group_thousands(1234567), "1,234,567");
    }

    #[test]
    fn clamps_max_chars() {
        assert_eq!(max_chars(None), 20_000);
        assert_eq!(max_chars(Some(5.0)), 1_000);
        assert_eq!(max_chars(Some(1e9)), 100_000);
        assert_eq!(max_chars(Some(1500.5)), 1501);
        assert_eq!(max_chars(Some(-1500.5)), 1000);
    }

    #[test]
    fn reads_the_charset() {
        assert_eq!(charset("text/html; charset=iso-8859-1"), Some("iso-8859-1"));
        assert_eq!(charset("text/html; charset=;charset=utf-8"), Some("utf-8"));
        assert_eq!(charset("text/html"), None);
    }

    #[test]
    fn decodes_entities_and_keeps_unknown_ones() {
        assert_eq!(decode_entities("&amp;&#65;&#x42;&#X43;&bogus;&#0;&#x110000;"), "&ABC&bogus;&#0;&#x110000;");
    }
}
