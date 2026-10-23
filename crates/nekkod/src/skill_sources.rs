//! Skills from GitHub in the daemon: `skillSources:list`,
//! `skillSources:preview`, `skillSources:fetch` and `skillSources:search`
//! (the Marketplace's GitHub shelves, install-from-URL and search). A port of
//! packages/host/src/skill-sources.ts, with the helpers it takes from
//! `@nekko-agent/shared` (packages/shared/src/skill-sources.ts):
//! `parseGitHubLocation`, `normalizeRepo`, `remoteSkillId`, `githubTreeUrl`,
//! `githubRawUrl`, `classifyLicenseText`, `remoteCategory` and
//! `remoteToMarketSkill`. `parseSkillMarkdown` is nekko-workspace's.
//!
//! The network is only touched when the user asks: loading or refreshing a
//! shelf, previewing a URL, searching, or installing. A loaded shelf is cached
//! in `skill-sources.json` in the data directory and shown from there
//! afterwards. Unauthenticated GitHub API calls are limited to 60 an hour, so a
//! shelf costs three (repo, tree, root license) plus one per skill folder with
//! its own LICENSE file. With a GitHub token (Connectors, `GH_TOKEN`,
//! `GITHUB_TOKEN`) the limit is 5,000 and search can look inside SKILL.md files.

use crate::routes::Ctx;
use nekko_connectors::js::encode_uri_component as enc;
use nekko_js as js;
use nekko_workspace::skills::parse_skill_markdown;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CHANNELS: &[&str] =
    &["skillSources:list", "skillSources:preview", "skillSources:fetch", "skillSources:search"];

/// `FETCH_TIMEOUT_MS`.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// A SKILL.md larger than this is refused (same limit as imported skills).
pub const MAX_REMOTE_SKILL_BYTES: usize = 256 * 1024;
/// Skills listed per shelf, at most.
const MAX_PER_SOURCE: usize = 200;

const API_BASE: &str = "https://api.github.com";
const RAW_BASE: &str = "https://raw.githubusercontent.com";

/// Why a proprietary skill is shown but not installable (`PROPRIETARY_REASON`).
const PROPRIETARY_REASON: &str =
    "Its license reserves all rights, so Nekko Agent links to it instead of installing a copy.";

fn re(cell: &'static OnceLock<Regex>, src: &str, flags: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::with_flags(src, flags).expect("skill source pattern compiles"))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `${v}` of a field that may be missing (`undefined`).
fn tpl(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::display)
}

/// `${v ?? ''}`.
fn tpl_or_empty(v: Option<&Value>) -> String {
    if js::nullish(v) { String::new() } else { tpl(v) }
}

/// The TypeError reading a property of `null` / `undefined` throws.
fn read_error(of: Option<&Value>, prop: &str) -> String {
    let what = if of.is_none() { "undefined" } else { "null" };
    format!("Cannot read properties of {what} (reading '{prop}')")
}

/// A value a string method is called on: `name.method(...)` throws unless it
/// is a string.
fn as_text<'a>(v: Option<&'a Value>, name: &str, method: &str) -> Result<&'a str, String> {
    match v {
        Some(Value::String(s)) => Ok(s),
        None | Some(Value::Null) => Err(read_error(v, method)),
        Some(_) => Err(format!("{name}.{method} is not a function")),
    }
}

/// The skill-sources channels (their cache lives in the data directory);
/// `None` for any other channel.
pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !CHANNELS.contains(&channel) {
        return None;
    }
    let dir = ctx.workspace.data_dir().to_path_buf();
    let settings = crate::settings::current(ctx).await;
    let gh = Gh::new(API_BASE, RAW_BASE, github_token(&settings, |k| std::env::var(k).ok()));
    let arg = args.first();
    // host.ts passes the preview input and the search query as `String(x ?? '')`.
    let text = || if js::nullish(arg) { String::new() } else { tpl(arg) };
    Some(match channel {
        "skillSources:list" => {
            list_skill_sources(&gh, &dir, arg.unwrap_or(&Value::Null), &skill_sources(&settings)).await
        }
        "skillSources:preview" => preview_skill_url(&gh, &text()).await,
        "skillSources:fetch" => fetch_remote_skill(&gh, arg).await,
        _ => search_skills(&gh, &text()).await,
    })
}

/// `skillSources(settings)`: `settings.skillSources`, else the defaults.
fn skill_sources(settings: &Value) -> Value {
    match settings.get("skillSources") {
        Some(v) if !v.is_null() => v.clone(),
        _ => json!([
            { "repo": "anthropics/skills", "label": "Anthropic", "path": "skills" },
            { "repo": "obra/superpowers", "label": "Superpowers", "path": "skills" },
            { "repo": "addyosmani/agent-skills", "label": "Addy Osmani", "path": "skills" },
        ]),
    }
}

/// `githubToken()`: a connected GitHub connector's token, else `GH_TOKEN`,
/// else `GITHUB_TOKEN`.
fn github_token(settings: &Value, env: impl Fn(&str) -> Option<String>) -> Option<String> {
    let conn = settings.get("connectors").and_then(Value::as_array).and_then(|cs| {
        cs.iter().find(|c| {
            c.get("kind").and_then(Value::as_str) == Some("github")
                && js::truthy(c.get("connected"))
                && js::truthy(c.get("token"))
        })
    });
    let non_empty = |s: String| (!s.is_empty()).then_some(s);
    conn.and_then(|c| c.get("token"))
        .map(js::display)
        .and_then(non_empty)
        .or_else(|| env("GH_TOKEN").and_then(non_empty))
        .or_else(|| env("GITHUB_TOKEN").and_then(non_empty))
}

/// `apiError(status, authed)`.
fn api_error(status: u16, authed: bool) -> String {
    match status {
        404 => "Not found on GitHub (a private repository needs a GitHub token in Connectors).".into(),
        401 => "GitHub rejected the token. Reconnect GitHub in Connectors.".into(),
        403 | 429 if authed => "GitHub rate limit reached. Try again later.".into(),
        403 | 429 => {
            "GitHub rate limit reached (60 requests an hour without a token). Connect GitHub in Connectors to raise it."
                .into()
        }
        s => format!("GitHub request failed ({s})."),
    }
}

/// What `fetch` rejects with: undici's `fetch failed`, or the timeout signal's reason.
fn fetch_error(e: reqwest::Error) -> String {
    if e.is_timeout() { "The operation was aborted due to timeout".into() } else { "fetch failed".into() }
}

/// GitHub's REST API and raw file host (`ctx(deps)`'s `api` and `raw`).
/// Tests point both at a loopback server.
pub struct Gh {
    http: reqwest::Client,
    api_base: String,
    raw_base: String,
    token: Option<String>,
}

impl Gh {
    pub fn new(api_base: &str, raw_base: &str, token: Option<String>) -> Self {
        Self {
            // Node's fetch ignores proxy settings; so does this.
            http: reqwest::Client::builder().timeout(FETCH_TIMEOUT).no_proxy().build().unwrap_or_default(),
            api_base: api_base.trim_end_matches('/').into(),
            raw_base: raw_base.trim_end_matches('/').into(),
            token,
        }
    }

    /// `api(path)`: the JSON of a GitHub API call, or the error a failed one throws.
    async fn api(&self, path: &str) -> Result<Value, String> {
        let mut req = self
            .http
            .get(format!("{}/{path}", self.api_base))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "nekko-agent");
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let res = req.send().await.map_err(fetch_error)?;
        if !res.status().is_success() {
            return Err(api_error(res.status().as_u16(), self.token.is_some()));
        }
        let text = js::decode_text(&res.bytes().await.map_err(fetch_error)?);
        // `res.json()`; V8's wording for an empty body, serde's otherwise.
        serde_json::from_str::<Value>(&text)
            .map(js::js_order)
            .map_err(|e| if js::trim(&text).is_empty() { "Unexpected end of JSON input".into() } else { e.to_string() })
    }

    /// `raw(githubRawUrl(repo, ref, file))`, with every caller's
    /// `.catch(() => null)`: the file's text, or `None`.
    async fn raw(&self, repo: &str, r#ref: &str, file: &str) -> Option<String> {
        let res = self.http.get(raw_url_at(&self.raw_base, repo, r#ref, file)).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        Some(js::decode_text(&res.bytes().await.ok()?))
    }
}

// --- shared helpers (packages/shared/src/skill-sources.ts) ---

/// `SKILL_NAME_RE` (`/^[a-z0-9._-]+$/i`).
fn valid_skill_name(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// `normalizeRepo(raw)`: validate and normalise `owner/repo`.
pub fn normalize_repo(raw: &str) -> Option<String> {
    let t = js::trim(raw);
    let t = t.strip_suffix(".git").unwrap_or(t);
    let parts: Vec<&str> = t.split('/').collect();
    let part_ok = |p: &&str| {
        !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) && *p != "." && *p != ".."
    };
    (parts.len() == 2 && parts.iter().all(part_ok)).then(|| format!("{}/{}", parts[0], parts[1]))
}

/// `decodeURIComponent(s)`, throwing `URI malformed` where JavaScript does.
fn decode_uri_component(s: &str) -> Result<String, String> {
    const MALFORMED: &str = "URI malformed";
    let b = s.as_bytes();
    let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    // The byte a `%XX` at `i` stands for.
    let hex = |i: usize| -> Result<u8, String> {
        match b.get(i..i + 3) {
            Some([b'%', h, l]) => match (digit(*h), digit(*l)) {
                (Some(h), Some(l)) => Ok(h * 16 + l),
                _ => Err(MALFORMED.into()),
            },
            _ => Err(MALFORMED.into()),
        }
    };
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            // Copy the whole (possibly multi-byte) character.
            let ch = s[i..].chars().next().unwrap_or_default();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let first = hex(i)?;
        i += 3;
        if first < 0x80 {
            out.push(first as char);
            continue;
        }
        let n = match first {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return Err(MALFORMED.into()),
        };
        let mut bytes = vec![first];
        for _ in 1..n {
            let c = hex(i)?;
            if c & 0xC0 != 0x80 {
                return Err(MALFORMED.into());
            }
            bytes.push(c);
            i += 3;
        }
        // Overlong forms, surrogates and code points past U+10FFFF are refused, as in JavaScript.
        out.push_str(std::str::from_utf8(&bytes).map_err(|_| MALFORMED)?);
    }
    Ok(out)
}

/// `cleanPath(p)`: a folder path inside a repo, without leading or trailing
/// slashes, refusing `..`; throws (as `decodeURIComponent` does) on a bad escape.
fn clean_path(p: &str) -> Result<Option<String>, String> {
    let parts = p.split('/').filter(|s| !s.is_empty()).map(decode_uri_component).collect::<Result<Vec<_>, _>>()?;
    if parts.iter().any(|s| s == ".." || s == "." || s.contains('\\')) {
        return Ok(None);
    }
    Ok(Some(parts.join("/")))
}

/// What a pasted GitHub location points at (`GitHubLocation`).
#[derive(Debug, PartialEq)]
pub struct GitHubLocation {
    pub repo: String,
    pub r#ref: Option<String>,
    /// Folder inside the repo ('' = root). A pasted SKILL.md path resolves to its folder.
    pub path: String,
}

/// `parseGitHubLocation(input)`: `owner/repo`, a github.com repo/tree/blob
/// URL, or a raw.githubusercontent.com SKILL.md URL. `Err` where the TS throws
/// (a malformed percent escape in the path).
pub fn parse_github_location(input: &str) -> Result<Option<GitHubLocation>, String> {
    let raw = js::trim(input);
    if raw.is_empty() {
        return Ok(None);
    }
    if let Some(short) = normalize_repo(raw).filter(|_| !raw.contains(':')) {
        return Ok(Some(GitHubLocation { repo: short, r#ref: None, path: String::new() }));
    }

    // `new URL` resolves `..` segments, which can silently turn a pasted link
    // into a different repository. Refuse dot segments (plain or encoded) first.
    let mut raw_path = raw.find("://").map_or(raw, |i| &raw[i + 3..]);
    if let Some(cut) = raw_path.find(['?', '#']) {
        raw_path = &raw_path[..cut];
    }
    const DOT: &[&str] = &[".", "..", "%2e", "%2e%2e", ".%2e", "%2e."];
    if raw_path.split('/').any(|p| DOT.contains(&p.to_lowercase().as_str())) {
        return Ok(None);
    }

    let has_scheme = raw.len() >= 7 && raw[..7].eq_ignore_ascii_case("http://")
        || raw.len() >= 8 && raw[..8].eq_ignore_ascii_case("https://");
    let full = if has_scheme { raw.to_string() } else { format!("https://{raw}") };
    let Ok(url) = url::Url::parse(&full) else { return Ok(None) };
    let seg: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    let strip_skill_md = |parts: &[&str]| -> String {
        let keep = match parts.last() {
            Some(l) if l.eq_ignore_ascii_case("skill.md") => &parts[..parts.len() - 1],
            _ => parts,
        };
        keep.join("/")
    };
    let host = url.host_str().unwrap_or_default();

    if host == "raw.githubusercontent.com" {
        if seg.len() < 3 {
            return Ok(None);
        }
        let repo = normalize_repo(&format!("{}/{}", seg[0], seg[1]));
        // raw URLs may carry refs/heads/<branch>.
        let mut rest = &seg[2..];
        let mut r#ref = rest[0];
        if rest[0] == "refs" && rest.get(1) == Some(&"heads") && rest.get(2).is_some() {
            r#ref = rest[2];
            rest = &rest[3..];
        } else {
            rest = &rest[1..];
        }
        let path = clean_path(&strip_skill_md(rest))?;
        return Ok(match (repo, path) {
            (Some(repo), Some(path)) => Some(GitHubLocation { repo, r#ref: Some(r#ref.into()), path }),
            _ => None,
        });
    }

    if host != "github.com" && host != "www.github.com" {
        return Ok(None);
    }
    if seg.len() < 2 {
        return Ok(None);
    }
    let Some(repo) = normalize_repo(&format!("{}/{}", seg[0], seg[1])) else { return Ok(None) };
    if seg.len() == 2 {
        return Ok(Some(GitHubLocation { repo, r#ref: None, path: String::new() }));
    }
    if (seg[2] == "tree" || seg[2] == "blob") && seg.len() > 3 {
        let path = clean_path(&strip_skill_md(&seg[4..]))?;
        return Ok(path.map(|path| GitHubLocation { repo, r#ref: Some(seg[3].into()), path }));
    }
    Ok(Some(GitHubLocation { repo, r#ref: None, path: String::new() }))
}

/// `slugify(s)`: lowercase kebab id fragment.
fn slugify(s: &str) -> String {
    s.to_lowercase()
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// `remoteSkillId(repo, path)`: `gh-<owner>-<repo>-<folder>`.
pub fn remote_skill_id(repo: &str, path: &str) -> String {
    let folder = path.split('/').rfind(|p| !p.is_empty()).unwrap_or_default();
    let folder = slugify(folder);
    let folder = if folder.is_empty() { "root".to_string() } else { folder };
    ["gh".to_string(), slugify(&repo.replacen('/', "-", 1)), folder].join("-")
}

fn encode_parts(path: &str) -> String {
    path.split('/').map(enc).collect::<Vec<_>>().join("/")
}

/// `githubTreeUrl(repo, ref, path)`: github.com page for a folder.
pub fn github_tree_url(repo: &str, r#ref: &str, path: &str) -> String {
    let tail = if path.is_empty() { String::new() } else { format!("/{}", encode_parts(path)) };
    format!("https://github.com/{repo}/tree/{}{tail}", enc(r#ref))
}

/// `githubRawUrl(repo, ref, file)` on another raw host (tests).
fn raw_url_at(base: &str, repo: &str, r#ref: &str, file: &str) -> String {
    format!("{base}/{repo}/{}/{}", enc(r#ref), encode_parts(file))
}

/// `classifyLicenseText(text)`: `(label, proprietary)`; proprietary when it
/// reserves all rights and grants no recognised open license.
pub fn classify_license_text(text: &str) -> (&'static str, bool) {
    static OPEN: OnceLock<Regex> = OnceLock::new();
    static RESERVED: OnceLock<Regex> = OnceLock::new();
    let open = re(
        &OPEN,
        r"\b(MIT License|Apache License|BSD|Mozilla Public License|GNU (?:Affero |Lesser )?General Public License|ISC License|The Unlicense|Creative Commons|CC0|CC BY)\b|Permission is hereby granted, free of charge",
        "i",
    );
    if let Some(m) = open.find(text) {
        let t = text[m.range()].to_lowercase();
        let label = if t.contains("apache") {
            "Apache-2.0"
        } else if t.contains("mit") || t.starts_with("permission is hereby") {
            "MIT"
        } else if t.contains("bsd") {
            "BSD"
        } else if t.contains("mozilla") {
            "MPL-2.0"
        } else if t.contains("general public") {
            "GPL"
        } else if t.contains("isc") {
            "ISC"
        } else if t.contains("unlicense") {
            "Unlicense"
        } else {
            "CC"
        };
        return (label, false);
    }
    if re(&RESERVED, "all rights reserved", "i").find(text).is_some() {
        return ("proprietary", true);
    }
    ("custom", false)
}

/// `remoteCategory(name, description)`: a best guess from the skill's words.
fn remote_category(name: &str, description: &str) -> &'static str {
    static QUALITY: OnceLock<Regex> = OnceLock::new();
    static DELIVERY: OnceLock<Regex> = OnceLock::new();
    static PLANNING: OnceLock<Regex> = OnceLock::new();
    let t = format!("{name} {description}").to_lowercase();
    if re(&QUALITY, "review|debug|test|lint|security|refactor|quality|simplif|bug", "").find(&t).is_some() {
        return "Code quality";
    }
    if re(&DELIVERY, r"release|commit|deploy|ship|changelog|branch|pull request|ci\b|cd\b", "").find(&t).is_some() {
        return "Delivery";
    }
    if re(&PLANNING, "plan|research|brainstorm|design|spec|architect|idea", "").find(&t).is_some() {
        return "Research & planning";
    }
    "Automation"
}

/// `remoteToMarketSkill(r, skillMd)` with the SKILL.md (so its parse), key
/// order as the TS object literal, `undefined` fields left out.
fn remote_to_market_skill(r: &Map<String, Value>, md: &str, description: Option<String>, body: String) -> Value {
    let description = description.map(Value::String).or_else(|| r.get("description").cloned());
    let name = r.get("name");
    let mut m = Map::new();
    let put = |m: &mut Map<String, Value>, k: &str, v: Option<&Value>| {
        if let Some(v) = v {
            m.insert(k.into(), v.clone());
        }
    };
    put(&mut m, "id", r.get("id"));
    put(&mut m, "name", name);
    put(&mut m, "description", description.as_ref());
    let author = r.get("repo").map(js::display).unwrap_or_default();
    m.insert("author".into(), json!(author.split('/').next().unwrap_or_default()));
    m.insert("source".into(), json!("github"));
    m.insert("tier".into(), json!("community"));
    m.insert("category".into(), json!(remote_category(&tpl(name), &tpl(description.as_ref()))));
    put(&mut m, "url", r.get("sourceUrl"));
    put(&mut m, "stars", r.get("stars"));
    m.insert("template".into(), json!(format!("Use the {} skill. {}\n\n", tpl(name), tpl(description.as_ref()))));
    // `parsed.body || description`: the caller refused an empty body.
    m.insert("instructions".into(), json!(body));
    m.insert("markdown".into(), json!(md));
    let mut remote = Map::new();
    put(&mut remote, "repo", r.get("repo"));
    put(&mut remote, "ref", r.get("ref"));
    put(&mut remote, "path", r.get("path"));
    m.insert("remote".into(), Value::Object(remote));
    put(&mut m, "license", r.get("license"));
    put(&mut m, "blocked", r.get("blocked"));
    put(&mut m, "extraFiles", r.get("extraFiles"));
    Value::Object(m)
}

/// `p.replace(/\/?SKILL\.md$/, '')`.
fn strip_skill_md(p: &str) -> &str {
    match p.strip_suffix("SKILL.md") {
        Some(rest) => rest.strip_suffix('/').unwrap_or(rest),
        None => p,
    }
}

// --- cache ---

/// `cacheFile(dir)`: `skill-sources.json`, its directory made first.
fn cache_file(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    Ok(dir.join("skill-sources.json"))
}

/// `readCache(dir)`: the cached shelves by `keyOf`, `{}` when missing or unreadable.
fn read_cache(dir: &Path) -> Map<String, Value> {
    let Ok(file) = cache_file(dir) else { return Map::new() };
    let Ok(bytes) = std::fs::read(file) else { return Map::new() };
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).map(js::js_order) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// `writeCache(cache, dir)`: `JSON.stringify(cache, null, 2)`.
fn write_cache(cache: &Map<String, Value>, dir: &Path) -> Result<(), String> {
    let text = js::stringify_pretty(&Value::Object(cache.clone()), "  ");
    std::fs::write(cache_file(dir)?, text).map_err(|e| e.to_string())
}

/// `keyOf(source)`: `${repo}@${ref ?? ''}:${path ?? ''}`.
fn key_of(source: &Value) -> Result<String, String> {
    if source.is_null() {
        return Err(read_error(Some(source), "repo"));
    }
    Ok(format!("{}@{}:{}", tpl(source.get("repo")), tpl_or_empty(source.get("ref")), tpl_or_empty(source.get("path"))))
}

// --- listing ---

/// What `scanRepo` found.
struct Scan {
    branch: Value,
    stars: Option<Value>,
    spdx: Option<String>,
    folders: Vec<String>,
    files: HashSet<String>,
}

/// `scanRepo(c, repo, ref, under)`: repo metadata and every SKILL.md folder in
/// its tree (under `under`).
async fn scan_repo(gh: &Gh, repo: &str, r#ref: Option<&Value>, under: &Value) -> Result<Scan, String> {
    let meta = gh.api(&format!("repos/{repo}")).await?;
    if meta.is_null() {
        return Err(read_error(Some(&meta), "default_branch"));
    }
    let branch = match r#ref {
        Some(r) if js::truthy(Some(r)) => r.clone(),
        _ => {
            let b = meta.get("default_branch").filter(|b| js::truthy(Some(b)));
            json!(b.map_or_else(|| "main".to_string(), js::display))
        }
    };
    let tree = gh.api(&format!("repos/{repo}/git/trees/{}?recursive=1", enc(&js::display(&branch)))).await?;
    if tree.is_null() {
        return Err(read_error(Some(&tree), "tree"));
    }
    let entries: &[Value] = tree.get("tree").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let blobs: Vec<&str> = entries
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("blob"))
        .filter_map(|e| e.get("path").and_then(Value::as_str))
        .collect();
    let scoped = js::truthy(Some(under));
    let prefix = if scoped { format!("{}/", js::display(under)) } else { String::new() };
    let in_scope = |p: &str| !scoped || under.as_str() == Some(p) || p.starts_with(&prefix);
    let folders = blobs
        .iter()
        .filter(|p| (**p == "SKILL.md" || p.ends_with("/SKILL.md")) && in_scope(p))
        .map(|p| strip_skill_md(p).to_string())
        .take(MAX_PER_SOURCE)
        .collect();
    let spdx = meta
        .get("license")
        .and_then(|l| l.get("spdx_id"))
        .filter(|id| js::truthy(Some(id)) && id.as_str() != Some("NOASSERTION"))
        .map(js::display);
    Ok(Scan {
        branch,
        stars: meta.get("stargazers_count").filter(|s| s.is_number()).cloned(),
        spdx,
        folders,
        files: blobs.into_iter().map(str::to_string).collect(),
    })
}

/// `folderLicense(...)`: a skill folder's own LICENSE file wins over the repo's.
async fn folder_license(
    gh: &Gh,
    repo: &str,
    branch: &str,
    folder: &str,
    files: &HashSet<String>,
    repo_license: Option<&str>,
    memo: &mut HashMap<String, (String, bool)>,
) -> (String, bool) {
    let own = ["LICENSE", "LICENSE.txt", "LICENSE.md"]
        .iter()
        .map(|f| if folder.is_empty() { (*f).to_string() } else { format!("{folder}/{f}") })
        .find(|f| files.contains(f));
    let Some(own) = own else {
        return match repo_license.filter(|l| !l.is_empty()) {
            Some(l) => (l.to_string(), false),
            None => ("none declared".into(), false),
        };
    };
    if let Some(hit) = memo.get(&own) {
        return hit.clone();
    }
    let res = match gh.raw(repo, branch, &own).await.filter(|t| !t.is_empty()) {
        Some(text) => {
            let (label, proprietary) = classify_license_text(&text);
            (label.to_string(), proprietary)
        }
        None => (repo_license.unwrap_or("unknown").to_string(), false),
    };
    memo.insert(own, res.clone());
    res
}

/// One shelf as `listRepo` returns it.
struct Listing {
    skills: Vec<Value>,
    stars: Option<Value>,
    license: Option<String>,
}

/// `listRepo(c, source)`: one shelf's entries. Names and descriptions come
/// from each SKILL.md's frontmatter, so every listed skill costs one raw fetch
/// (not counted against the API limit).
async fn list_repo(gh: &Gh, repo: &str, r#ref: Option<&Value>, under: &Value) -> Result<Listing, String> {
    let scan = scan_repo(gh, repo, r#ref, under).await?;
    let branch = js::display(&scan.branch);
    let mut memo = HashMap::new();
    let mut skills = Vec::new();
    for folder in &scan.folders {
        let file = if folder.is_empty() { "SKILL.md".to_string() } else { format!("{folder}/SKILL.md") };
        let Some(md) = gh.raw(repo, &branch, &file).await.filter(|m| !m.is_empty()) else { continue };
        let (name, description, _) = parse_skill_markdown(&md);
        // `folder.split('/').pop()` is never undefined, so the repo-name fallback never runs.
        let name = name.unwrap_or_else(|| folder.rsplit('/').next().unwrap_or_default().to_string());
        if !valid_skill_name(&name) {
            continue;
        }
        let (license, proprietary) =
            folder_license(gh, repo, &branch, folder, &scan.files, scan.spdx.as_deref(), &mut memo).await;
        let skill_md = format!("{folder}/SKILL.md");
        let dir = format!("{folder}/");
        let extra_files = !folder.is_empty()
            && scan.files.iter().any(|f| {
                *f != skill_md
                    && f.starts_with(&dir)
                    && !(f.ends_with("/LICENSE") || f.ends_with("/LICENSE.txt") || f.ends_with("/LICENSE.md"))
            });
        let mut s = Map::new();
        s.insert("id".into(), json!(remote_skill_id(repo, folder)));
        s.insert("name".into(), json!(name));
        s.insert("description".into(), json!(description.unwrap_or_default()));
        s.insert("repo".into(), json!(repo));
        s.insert("ref".into(), scan.branch.clone());
        s.insert("path".into(), json!(folder));
        s.insert("sourceUrl".into(), json!(github_tree_url(repo, &branch, folder)));
        s.insert("license".into(), json!(license));
        if proprietary {
            s.insert("blocked".into(), json!(PROPRIETARY_REASON));
        }
        s.insert("extraFiles".into(), json!(extra_files));
        if let Some(stars) = &scan.stars {
            s.insert("stars".into(), stars.clone());
        }
        skills.push(Value::Object(s));
    }
    Ok(Listing { skills, stars: scan.stars, license: scan.spdx })
}

/// `listSkillSources(refresh)`: every configured shelf. Without `refresh` this
/// never touches the network: each shelf comes from the cache (`cached`) or is
/// empty (`none`) until the user loads it. `refresh` re-fetches either one
/// repo (its `owner/repo`) or all of them (`true`).
async fn list_skill_sources(gh: &Gh, dir: &Path, refresh: &Value, sources: &Value) -> Result<Value, String> {
    let mut cache = read_cache(dir);
    let Some(sources) = sources.as_array() else { return Err("sources is not iterable".into()) };
    let fetch = js::truthy(Some(refresh));
    let mut out = Vec::new();
    let mut dirty = false;
    for source in sources {
        let key = key_of(source)?;
        let cached = cache.get(&key).cloned();
        let cached_field = |k: &str| cached.as_ref().and_then(|c| c.get(k)).cloned();
        let wanted = *refresh == Value::Bool(true) || (refresh.is_string() && source.get("repo") == Some(refresh));
        if wanted && fetch {
            let under = js::coalesce(source.get("path"), None).cloned().unwrap_or(json!(""));
            let mut entry = Map::new();
            let mut item = Map::new();
            item.insert("source".into(), source.clone());
            match list_repo(gh, &tpl(source.get("repo")), source.get("ref"), &under).await {
                Ok(live) => {
                    entry.insert("skills".into(), Value::Array(live.skills));
                    if let Some(s) = live.stars {
                        entry.insert("stars".into(), s);
                    }
                    if let Some(l) = live.license {
                        entry.insert("license".into(), json!(l));
                    }
                    entry.insert("fetchedAt".into(), json!(now_ms()));
                    cache.insert(key, Value::Object(entry.clone()));
                    dirty = true;
                    item.extend(entry);
                    item.insert("state".into(), json!("live"));
                }
                Err(e) => {
                    let skills = js::coalesce(cached_field("skills").as_ref(), None).cloned().unwrap_or(json!([]));
                    item.insert("skills".into(), skills);
                    for k in ["stars", "license", "fetchedAt"] {
                        if let Some(v) = cached_field(k) {
                            item.insert(k.into(), v);
                        }
                    }
                    item.insert("state".into(), json!("error"));
                    item.insert("error".into(), json!(e));
                }
            }
            out.push(Value::Object(item));
            continue;
        }
        let mut item = Map::new();
        item.insert("source".into(), source.clone());
        match cached.filter(|c| js::truthy(Some(c))) {
            Some(c) => {
                js::spread_into(&mut item, &c);
                item.insert("state".into(), json!("cached"));
            }
            None => {
                item.insert("skills".into(), json!([]));
                item.insert("state".into(), json!("none"));
            }
        }
        out.push(Value::Object(item));
    }
    if dirty {
        write_cache(&cache, dir)?;
    }
    Ok(Value::Array(out))
}

/// `previewSkillUrl(input)`: what a pasted URL or `owner/repo` holds, one
/// skill (a SKILL.md folder) or every skill in the repo. Nothing is installed.
async fn preview_skill_url(gh: &Gh, input: &str) -> Result<Value, String> {
    let Some(loc) = parse_github_location(input)? else {
        return Ok(json!({
            "ok": false,
            "message": "Paste a GitHub URL (github.com/owner/repo/tree/\u{2026}/skill) or owner/repo.",
            "skills": [],
        }));
    };
    let r#ref = loc.r#ref.as_ref().map(|r| json!(r));
    Ok(match list_repo(gh, &loc.repo, r#ref.as_ref(), &json!(loc.path)).await {
        Ok(l) if l.skills.is_empty() => {
            let sub = if loc.path.is_empty() { String::new() } else { format!("/{}", loc.path) };
            json!({ "ok": false, "message": format!("No SKILL.md found in {}{sub}.", loc.repo), "repo": loc.repo, "skills": [] })
        }
        Ok(l) => json!({ "ok": true, "repo": loc.repo, "skills": l.skills }),
        Err(e) => json!({ "ok": false, "message": e, "repo": loc.repo, "skills": [] }),
    })
}

fn fetch_failed(message: &str) -> Value {
    json!({ "ok": false, "message": message })
}

/// `fetchRemoteSkill(skill)`: the verbatim SKILL.md of a GitHub skill, as a
/// marketplace skill ready for `skill:install`. Refuses proprietary and
/// oversized skills.
async fn fetch_remote_skill(gh: &Gh, skill: Option<&Value>) -> Result<Value, String> {
    let skill = match skill {
        Some(s) if !s.is_null() => s,
        other => return Err(read_error(other, "blocked")),
    };
    if let Some(blocked) = skill.get("blocked").filter(|b| js::truthy(Some(b))) {
        return Ok(json!({ "ok": false, "message": blocked }));
    }
    let Some(repo) = normalize_repo(as_text(skill.get("repo"), "raw", "trim")?) else {
        return Ok(fetch_failed("Invalid skill location."));
    };
    let path = as_text(skill.get("path"), "skill.path", "split")?;
    if path.split('/').any(|p| p == "..") {
        return Ok(fetch_failed("Invalid skill location."));
    }
    if !valid_skill_name(&tpl(skill.get("name"))) {
        return Ok(fetch_failed("Invalid skill name."));
    }
    let file = if path.is_empty() { "SKILL.md".to_string() } else { format!("{path}/SKILL.md") };
    let Some(md) = gh.raw(&repo, &tpl(skill.get("ref")), &file).await.filter(|m| !js::trim(m).is_empty()) else {
        return Ok(fetch_failed("Could not download SKILL.md from GitHub."));
    };
    if md.len() > MAX_REMOTE_SKILL_BYTES {
        return Ok(fetch_failed("SKILL.md is larger than 256 KB."));
    }
    let (_, description, body) = parse_skill_markdown(&md);
    if body.is_empty() {
        return Ok(fetch_failed("SKILL.md has no instructions."));
    }
    // `{ ...skill, id, repo }`: the skill is an object here (anything else has no `repo`).
    let mut r = match js::js_order(skill.clone()) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    r.insert("id".into(), json!(remote_skill_id(&repo, path)));
    r.insert("repo".into(), json!(repo));
    Ok(json!({ "ok": true, "skill": remote_to_market_skill(&r, &md, description, body) }))
}

/// `res.items` when it is an array, else none; a `null` body throws.
fn items_of(res: &Value) -> Result<Vec<Value>, String> {
    if res.is_null() {
        return Err(read_error(Some(res), "items"));
    }
    Ok(res.get("items").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// The code-search half of `searchSkills`: one skill per SKILL.md hit, deduped by id.
fn code_hits(res: &Value) -> Result<Vec<Value>, String> {
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for item in items_of(res)? {
        if item.is_null() {
            return Err(read_error(Some(&item), "repository"));
        }
        let repository = item.get("repository");
        let full = js::coalesce(repository.and_then(|r| r.get("full_name")), None);
        let Some(repo) = normalize_repo(&tpl_or_empty(full)) else { continue };
        let raw_path = tpl_or_empty(item.get("path"));
        let path = strip_skill_md(&raw_path).to_string();
        let id = remote_skill_id(&repo, &path);
        if !seen.insert(id.clone()) {
            continue;
        }
        let last = path.rsplit('/').next().unwrap_or_default();
        let name = if last.is_empty() { repo.split('/').nth(1).unwrap_or_default() } else { last }.to_string();
        if !valid_skill_name(&name) {
            continue;
        }
        let branch = repository.and_then(|r| r.get("default_branch")).filter(|b| !b.is_null());
        let r#ref = branch.map_or_else(|| "HEAD".to_string(), js::display);
        let url = github_tree_url(&repo, &r#ref, &path);
        skills.push(json!({
            "id": id, "name": name, "description": "", "repo": repo, "ref": r#ref, "path": path, "sourceUrl": url,
        }));
    }
    Ok(skills)
}

/// The repository-search half of `searchSkills`: one hit per valid repo.
fn repo_hits(items: &[Value]) -> Result<Vec<Value>, String> {
    let mut repos = Vec::new();
    for r in items {
        if r.is_null() {
            return Err(read_error(Some(r), "full_name"));
        }
        let Some(repo) = normalize_repo(&tpl_or_empty(r.get("full_name"))) else { continue };
        let mut hit = Map::new();
        hit.insert("repo".into(), json!(repo));
        if let Some(d) = r.get("description").filter(|d| !d.is_null()) {
            hit.insert("description".into(), d.clone());
        }
        if let Some(s) = r.get("stargazers_count").filter(|s| s.is_number()) {
            hit.insert("stars".into(), s.clone());
        }
        hit.insert("url".into(), json!(format!("https://github.com/{repo}")));
        repos.push(Value::Object(hit));
    }
    Ok(repos)
}

/// `searchSkills(query)`: with a token, code search over SKILL.md files
/// (finds individual skills). Without one GitHub refuses code search, so this
/// searches repositories that look like skill collections instead and says
/// so. Shelves already loaded are filtered by the UI, not here.
async fn search_skills(gh: &Gh, query: &str) -> Result<Value, String> {
    let trimmed = js::trim(query);
    let q = js::slice16(trimmed, 120);
    if q.is_empty() {
        return Ok(json!({ "mode": "repos", "skills": [], "repos": [] }));
    }
    // `.slice(0, 120)` through a surrogate pair leaves half of it, which
    // `encodeURIComponent` refuses.
    if js::len16(trimmed) > 120 && js::len16(q) < 120 {
        return Err("URI malformed".into());
    }
    if gh.token.is_some() {
        let res = gh.api(&format!("search/code?q={}&per_page=30", enc(&format!("{q} filename:SKILL.md")))).await?;
        return Ok(json!({
            "mode": "code",
            "skills": code_hits(&res)?,
            "repos": [],
            "note": "Open a result to read its license and instructions before installing.",
        }));
    }
    let topic = enc(&format!("{q} in:name,description,topics topic:agent-skills"));
    let res = gh.api(&format!("search/repositories?q={topic}&sort=stars&per_page=20")).await?;
    let mut items = items_of(&res)?;
    if items.is_empty() {
        let broad_q = enc(&format!("{q} skills SKILL.md in:name,description,readme"));
        let broad = gh.api(&format!("search/repositories?q={broad_q}&sort=stars&per_page=20")).await?;
        items = items_of(&broad)?;
    }
    Ok(json!({
        "mode": "repos",
        "skills": [],
        "repos": repo_hits(&items)?,
        "note": "Searching repositories. Connect GitHub in Connectors to search inside SKILL.md files.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn loc(repo: &str, r#ref: Option<&str>, path: &str) -> Option<GitHubLocation> {
        Some(GitHubLocation { repo: repo.into(), r#ref: r#ref.map(str::to_string), path: path.into() })
    }

    #[test]
    fn normalizes_repos() {
        assert_eq!(normalize_repo(" obra/superpowers.git ").as_deref(), Some("obra/superpowers"));
        assert_eq!(normalize_repo("a/b/c"), None);
        assert_eq!(normalize_repo("a/.."), None);
        assert_eq!(normalize_repo("a/b c"), None);
        assert_eq!(normalize_repo("a/"), None);
    }

    #[test]
    fn parses_pasted_locations() {
        let p = |s: &str| parse_github_location(s).unwrap();
        assert_eq!(p("obra/superpowers"), loc("obra/superpowers", None, ""));
        assert_eq!(p("  "), None);
        assert_eq!(p("https://github.com/anthropics/skills"), loc("anthropics/skills", None, ""));
        assert_eq!(p("github.com/anthropics/skills/issues"), loc("anthropics/skills", None, ""));
        assert_eq!(
            p("https://github.com/anthropics/skills/tree/main/skills/pdf?x=1#y"),
            loc("anthropics/skills", Some("main"), "skills/pdf")
        );
        assert_eq!(p("https://www.github.com/o/r/blob/dev/a/SKILL.md"), loc("o/r", Some("dev"), "a"));
        assert_eq!(p("https://github.com/o/r/tree/main/my%20skill"), loc("o/r", Some("main"), "my skill"));
        assert_eq!(
            p("https://raw.githubusercontent.com/o/r/refs/heads/feat/x/SKILL.md"),
            loc("o/r", Some("feat"), "x")
        );
        assert_eq!(p("https://raw.githubusercontent.com/o/r/main/skill.md"), loc("o/r", Some("main"), ""));
        assert_eq!(p("https://raw.githubusercontent.com/o/r"), None);
        // Dot segments are refused before the URL parser can resolve them.
        assert_eq!(p("https://github.com/o/r/tree/main/../../x/y"), None);
        assert_eq!(p("https://github.com/o/r/tree/main/%2E%2E/y"), None);
        assert_eq!(p("https://github.com/o/r/tree/main/a%5Cb"), None);
        assert_eq!(p("https://gitlab.com/o/r"), None);
        assert_eq!(p("https://github.com/o"), None);
        // A bad escape throws, as decodeURIComponent does.
        assert_eq!(parse_github_location("https://github.com/o/r/tree/main/%E0%A4").unwrap_err(), "URI malformed");
    }

    #[test]
    fn decodes_uri_components_like_javascript() {
        assert_eq!(decode_uri_component("a%20b%C3%A9").unwrap(), "a b\u{e9}");
        assert_eq!(decode_uri_component("caf\u{e9}").unwrap(), "caf\u{e9}");
        for bad in ["%", "%2", "%zz", "%C3", "%C3%28", "%ED%A0%80", "%C0%80"] {
            assert!(decode_uri_component(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn builds_ids_and_urls() {
        assert_eq!(remote_skill_id("anthropics/skills", "skills/pdf"), "gh-anthropics-skills-pdf");
        assert_eq!(remote_skill_id("Obra/Super.Powers", ""), "gh-obra-super-powers-root");
        assert_eq!(github_tree_url("o/r", "feat/x", "a b/c"), "https://github.com/o/r/tree/feat%2Fx/a%20b/c");
        assert_eq!(github_tree_url("o/r", "main", ""), "https://github.com/o/r/tree/main");
        assert_eq!(
            raw_url_at(RAW_BASE, "o/r", "main", "a b/SKILL.md"),
            "https://raw.githubusercontent.com/o/r/main/a%20b/SKILL.md"
        );
        assert_eq!(strip_skill_md("a/b/SKILL.md"), "a/b");
        assert_eq!(strip_skill_md("SKILL.md"), "");
        assert!(valid_skill_name("my-skill_1.0") && !valid_skill_name("") && !valid_skill_name("a b"));
    }

    #[test]
    fn classifies_licenses() {
        assert_eq!(classify_license_text("Apache License\nVersion 2.0"), ("Apache-2.0", false));
        assert_eq!(classify_license_text("Permission is hereby granted, free of charge, to any"), ("MIT", false));
        assert_eq!(classify_license_text("the mit license"), ("MIT", false));
        assert_eq!(classify_license_text("GNU Lesser General Public License"), ("GPL", false));
        assert_eq!(classify_license_text("CC0 1.0"), ("CC", false));
        assert_eq!(classify_license_text("(c) Anthropic. All Rights Reserved."), ("proprietary", true));
        assert_eq!(classify_license_text("Do what you like."), ("custom", false));
        // `\b` keeps a word that merely contains BSD from counting.
        assert_eq!(classify_license_text("XBSDX all rights reserved"), ("proprietary", true));
    }

    #[test]
    fn categorizes_remote_skills() {
        assert_eq!(remote_category("code-review", ""), "Code quality");
        assert_eq!(remote_category("x", "runs ci for you"), "Delivery");
        assert_eq!(remote_category("x", "circle"), "Automation");
        assert_eq!(remote_category("brainstorming", "ideas"), "Research & planning");
    }

    #[test]
    fn picks_the_github_token() {
        let settings = json!({ "connectors": [
            { "kind": "github", "connected": false, "token": "off" },
            { "kind": "github", "connected": true, "token": "conn" },
        ]});
        let env = |k: &str| (k == "GITHUB_TOKEN").then(|| "env".to_string());
        assert_eq!(github_token(&settings, env).as_deref(), Some("conn"));
        assert_eq!(github_token(&json!({}), env).as_deref(), Some("env"));
        let gh = |k: &str| match k {
            "GH_TOKEN" => Some(String::new()),
            "GITHUB_TOKEN" => Some("second".into()),
            _ => None,
        };
        assert_eq!(github_token(&Value::Null, gh).as_deref(), Some("second"));
        assert_eq!(github_token(&Value::Null, |_: &str| None), None);
    }

    #[test]
    fn shapes_search_results() {
        let res = json!({ "items": [
            { "path": "skills/pdf/SKILL.md", "repository": { "full_name": "o/r", "default_branch": "dev" } },
            { "path": "skills/pdf/SKILL.md", "repository": { "full_name": "o/r" } },
            { "path": "SKILL.md", "repository": { "full_name": "o/solo" } },
            { "path": "x/bad name/SKILL.md", "repository": { "full_name": "o/r" } },
            { "path": "a/SKILL.md", "repository": { "full_name": "not a repo" } },
        ]});
        assert_eq!(
            js::stringify(&Value::Array(code_hits(&res).unwrap())),
            r#"[{"id":"gh-o-r-pdf","name":"pdf","description":"","repo":"o/r","ref":"dev","path":"skills/pdf","sourceUrl":"https://github.com/o/r/tree/dev/skills/pdf"},{"id":"gh-o-solo-root","name":"solo","description":"","repo":"o/solo","ref":"HEAD","path":"","sourceUrl":"https://github.com/o/solo/tree/HEAD"}]"#
        );
        let items = vec![
            json!({ "full_name": "o/r", "description": null, "stargazers_count": 5 }),
            json!({ "full_name": "o/s", "description": "d" }),
            json!({ "full_name": "bad" }),
        ];
        assert_eq!(
            js::stringify(&Value::Array(repo_hits(&items).unwrap())),
            r#"[{"repo":"o/r","stars":5,"url":"https://github.com/o/r"},{"repo":"o/s","description":"d","url":"https://github.com/o/s"}]"#
        );
        assert_eq!(code_hits(&Value::Null).unwrap_err(), "Cannot read properties of null (reading 'items')");
    }

    #[test]
    fn keys_and_defaults() {
        assert_eq!(key_of(&json!({ "repo": "o/r", "path": "skills" })).unwrap(), "o/r@:skills");
        assert_eq!(key_of(&json!({ "repo": "o/r", "ref": "v1", "path": null })).unwrap(), "o/r@v1:");
        assert!(key_of(&Value::Null).is_err());
        assert_eq!(skill_sources(&json!({}))[0]["repo"], "anthropics/skills");
        assert_eq!(skill_sources(&json!({ "skillSources": [] })), json!([]));
    }

    // --- against a loopback GitHub ---

    type Routes = Arc<HashMap<String, (u16, String)>>;

    /// A GitHub whose API lives under `/api` and raw files under `/raw`,
    /// answering `routes` by path and query (404 for anything else).
    async fn github(routes: Vec<(&str, u16, String)>) -> (String, tokio::task::JoinHandle<()>) {
        use axum::extract::State;
        use axum::http::{StatusCode, Uri};
        let map: Routes = Arc::new(routes.into_iter().map(|(k, s, b)| (k.to_string(), (s, b))).collect());
        let app = axum::Router::new()
            .fallback(|State(m): State<Routes>, uri: Uri| async move {
                let key = uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
                match m.get(&key) {
                    Some((s, b)) => (StatusCode::from_u16(*s).unwrap(), b.clone()),
                    None => (StatusCode::NOT_FOUND, "{}".to_string()),
                }
            })
            .with_state(map);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        (base, tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }))
    }

    fn gh_at(base: &str, token: Option<&str>) -> Gh {
        Gh::new(&format!("{base}/api"), &format!("{base}/raw"), token.map(str::to_string))
    }

    /// `o/r`: an MIT repo whose `skills/alpha` has its own proprietary
    /// LICENSE and a script, `skills/beta` names itself from its folder, and
    /// a SKILL.md outside `skills/` is out of scope.
    fn repo_routes() -> Vec<(&'static str, u16, String)> {
        let tree = json!({ "tree": [
            { "path": "skills/alpha/SKILL.md", "type": "blob" },
            { "path": "skills/alpha/LICENSE", "type": "blob" },
            { "path": "skills/alpha/scripts/run.sh", "type": "blob" },
            { "path": "skills/beta/SKILL.md", "type": "blob" },
            { "path": "other/gamma/SKILL.md", "type": "blob" },
            { "path": "skills", "type": "tree" },
        ]});
        vec![
            (
                "/api/repos/o/r",
                200,
                json!({ "default_branch": "main", "stargazers_count": 7, "license": { "spdx_id": "MIT" } }).to_string(),
            ),
            ("/api/repos/o/r/git/trees/main?recursive=1", 200, tree.to_string()),
            ("/raw/o/r/main/skills/alpha/SKILL.md", 200, "---\nname: alpha\ndescription: Does A\n---\nBody A".into()),
            ("/raw/o/r/main/skills/alpha/LICENSE", 200, "Copyright Acme. All rights reserved.".into()),
            ("/raw/o/r/main/skills/beta/SKILL.md", 200, "---\ndescription: >\n  Does\n  B\n---\nBody B".into()),
            ("/raw/o/r/main/other/gamma/SKILL.md", 200, "---\nname: gamma\n---\nG".into()),
        ]
    }

    const ALPHA: &str = r#"{"id":"gh-o-r-alpha","name":"alpha","description":"Does A","repo":"o/r","ref":"main","path":"skills/alpha","sourceUrl":"https://github.com/o/r/tree/main/skills/alpha","license":"proprietary","blocked":"Its license reserves all rights, so Nekko Agent links to it instead of installing a copy.","extraFiles":true,"stars":7}"#;
    const BETA: &str = r#"{"id":"gh-o-r-beta","name":"beta","description":"Does B","repo":"o/r","ref":"main","path":"skills/beta","sourceUrl":"https://github.com/o/r/tree/main/skills/beta","license":"MIT","extraFiles":false,"stars":7}"#;

    #[tokio::test]
    async fn previews_a_pasted_location() {
        let (base, server) = github(repo_routes()).await;
        let gh = gh_at(&base, None);
        let all = preview_skill_url(&gh, "https://github.com/o/r/tree/main/skills").await.unwrap();
        assert_eq!(js::stringify(&all), format!(r#"{{"ok":true,"repo":"o/r","skills":[{ALPHA},{BETA}]}}"#));
        let none = preview_skill_url(&gh, "github.com/o/r/tree/main/nothing").await.unwrap();
        assert_eq!(
            js::stringify(&none),
            r#"{"ok":false,"message":"No SKILL.md found in o/r/nothing.","repo":"o/r","skills":[]}"#
        );
        let missing = preview_skill_url(&gh, "o/gone").await.unwrap();
        assert_eq!(
            js::stringify(&missing),
            r#"{"ok":false,"message":"Not found on GitHub (a private repository needs a GitHub token in Connectors).","repo":"o/gone","skills":[]}"#
        );
        let bad = preview_skill_url(&gh, "not a url").await.unwrap();
        assert_eq!(
            js::stringify(&bad),
            "{\"ok\":false,\"message\":\"Paste a GitHub URL (github.com/owner/repo/tree/\u{2026}/skill) or owner/repo.\",\"skills\":[]}"
        );
        server.abort();
    }

    #[tokio::test]
    async fn lists_shelves_from_the_cache_until_refreshed() {
        let (base, server) = github(repo_routes()).await;
        let gh = gh_at(&base, None);
        let dir = std::env::temp_dir().join(format!("nekkod-skill-sources-{}", now_ms()));
        let sources = json!([{ "repo": "o/r", "label": "R", "path": "skills" }, { "repo": "o/gone" }]);

        let first = list_skill_sources(&gh, &dir, &Value::Null, &sources).await.unwrap();
        assert_eq!(
            js::stringify(&first),
            r#"[{"source":{"repo":"o/r","label":"R","path":"skills"},"skills":[],"state":"none"},{"source":{"repo":"o/gone"},"skills":[],"state":"none"}]"#
        );

        let live = list_skill_sources(&gh, &dir, &json!("o/r"), &sources).await.unwrap();
        assert_eq!(live[0]["state"], "live");
        assert_eq!(live[0]["license"], "MIT");
        assert_eq!(live[0]["stars"], 7);
        assert_eq!(js::stringify(&live[0]["skills"]), format!("[{ALPHA},{BETA}]"));
        assert_eq!(live[1]["state"], "none");
        let keys: Vec<&String> = live[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["source", "skills", "stars", "license", "fetchedAt", "state"]);

        let cached = list_skill_sources(&gh, &dir, &json!(false), &sources).await.unwrap();
        assert_eq!(cached[0]["state"], "cached");
        assert_eq!(cached[0]["fetchedAt"], live[0]["fetchedAt"]);
        assert_eq!(js::stringify(&cached[0]["skills"]), format!("[{ALPHA},{BETA}]"));

        // A failed refresh keeps what was cached and says why.
        let all = list_skill_sources(&gh, &dir, &json!(true), &sources).await.unwrap();
        assert_eq!(all[0]["state"], "live");
        assert_eq!(
            js::stringify(&all[1]),
            r#"{"source":{"repo":"o/gone"},"skills":[],"state":"error","error":"Not found on GitHub (a private repository needs a GitHub token in Connectors)."}"#
        );
        let file = std::fs::read_to_string(dir.join("skill-sources.json")).unwrap();
        assert!(file.starts_with("{\n  \"o/r@:skills\": {\n    \"skills\": ["), "{file}");
        let _ = std::fs::remove_dir_all(&dir);
        server.abort();
    }

    #[tokio::test]
    async fn fetches_a_skill_for_install() {
        let mut routes = repo_routes();
        routes.push((
            "/raw/o/r/main/big/SKILL.md",
            200,
            format!("---\nname: big\n---\n{}", "x".repeat(MAX_REMOTE_SKILL_BYTES)),
        ));
        routes.push(("/raw/o/r/main/empty/SKILL.md", 200, "---\nname: empty\n---\n".into()));
        let (base, server) = github(routes).await;
        let gh = gh_at(&base, None);
        let beta: Value = serde_json::from_str(BETA).unwrap();
        let ok = fetch_remote_skill(&gh, Some(&beta)).await.unwrap();
        assert_eq!(
            js::stringify(&ok),
            r#"{"ok":true,"skill":{"id":"gh-o-r-beta","name":"beta","description":"Does B","author":"o","source":"github","tier":"community","category":"Automation","url":"https://github.com/o/r/tree/main/skills/beta","stars":7,"template":"Use the beta skill. Does B\n\n","instructions":"Body B","markdown":"---\ndescription: >\n  Does\n  B\n---\nBody B","remote":{"repo":"o/r","ref":"main","path":"skills/beta"},"license":"MIT","extraFiles":false}}"#
        );
        let alpha: Value = serde_json::from_str(ALPHA).unwrap();
        assert_eq!(fetch_remote_skill(&gh, Some(&alpha)).await.unwrap()["message"], PROPRIETARY_REASON);
        let with = |patch: Value| {
            let mut s = beta.clone();
            js::spread_into(s.as_object_mut().unwrap(), &patch);
            s
        };
        let msg = |v: Value| v["message"].as_str().unwrap().to_string();
        assert_eq!(
            msg(fetch_remote_skill(&gh, Some(&with(json!({ "repo": "o" })))).await.unwrap()),
            "Invalid skill location."
        );
        assert_eq!(
            msg(fetch_remote_skill(&gh, Some(&with(json!({ "path": "../x" })))).await.unwrap()),
            "Invalid skill location."
        );
        assert_eq!(
            msg(fetch_remote_skill(&gh, Some(&with(json!({ "name": "a b" })))).await.unwrap()),
            "Invalid skill name."
        );
        assert_eq!(
            msg(fetch_remote_skill(&gh, Some(&with(json!({ "path": "nope" })))).await.unwrap()),
            "Could not download SKILL.md from GitHub."
        );
        assert_eq!(
            msg(fetch_remote_skill(&gh, Some(&with(json!({ "path": "big", "name": "big" })))).await.unwrap()),
            "SKILL.md is larger than 256 KB."
        );
        assert_eq!(
            msg(fetch_remote_skill(&gh, Some(&with(json!({ "path": "empty", "name": "empty" })))).await.unwrap()),
            "SKILL.md has no instructions."
        );
        assert_eq!(
            fetch_remote_skill(&gh, None).await.unwrap_err(),
            "Cannot read properties of undefined (reading 'blocked')"
        );
        assert_eq!(
            fetch_remote_skill(&gh, Some(&json!({ "repo": 5 }))).await.unwrap_err(),
            "raw.trim is not a function"
        );
        server.abort();
    }

    #[tokio::test]
    async fn searches_repositories_or_code() {
        let topic = format!(
            "/api/search/repositories?q={}&sort=stars&per_page=20",
            enc("pdf in:name,description,topics topic:agent-skills")
        );
        let broad = format!(
            "/api/search/repositories?q={}&sort=stars&per_page=20",
            enc("pdf skills SKILL.md in:name,description,readme")
        );
        let code = format!("/api/search/code?q={}&per_page=30", enc("pdf filename:SKILL.md"));
        let routes = vec![
            (topic.as_str(), 200, json!({ "items": [] }).to_string()),
            (
                broad.as_str(),
                200,
                json!({ "items": [{ "full_name": "o/r", "description": "PDFs", "stargazers_count": 3 }] }).to_string(),
            ),
            (
                code.as_str(),
                200,
                json!({ "items": [{ "path": "pdf/SKILL.md", "repository": { "full_name": "o/r" } }] }).to_string(),
            ),
        ];
        let (base, server) = github(routes).await;
        let repos = search_skills(&gh_at(&base, None), "  pdf ").await.unwrap();
        assert_eq!(
            js::stringify(&repos),
            r#"{"mode":"repos","skills":[],"repos":[{"repo":"o/r","description":"PDFs","stars":3,"url":"https://github.com/o/r"}],"note":"Searching repositories. Connect GitHub in Connectors to search inside SKILL.md files."}"#
        );
        let code = search_skills(&gh_at(&base, Some("t")), "pdf").await.unwrap();
        assert_eq!(code["mode"], "code");
        assert_eq!(code["skills"][0]["id"], "gh-o-r-pdf");
        assert_eq!(
            js::stringify(&search_skills(&gh_at(&base, None), " ").await.unwrap()),
            r#"{"mode":"repos","skills":[],"repos":[]}"#
        );
        // A rate-limited search is the error the TS throws.
        let (base2, server2) = github(vec![(code_path_for("x").as_str(), 403, "{}".into())]).await;
        assert_eq!(
            search_skills(&gh_at(&base2, Some("t")), "x").await.unwrap_err(),
            "GitHub rate limit reached. Try again later."
        );
        let long = format!("{}\u{1F600}", "a".repeat(119));
        assert_eq!(search_skills(&gh_at(&base2, None), &long).await.unwrap_err(), "URI malformed");
        server.abort();
        server2.abort();
    }

    fn code_path_for(q: &str) -> String {
        format!("/api/search/code?q={}&per_page=30", enc(&format!("{q} filename:SKILL.md")))
    }
}
