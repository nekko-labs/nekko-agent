//! Pull requests for the in-chat PR card, the diff pane and the sidebar's
//! branch badges, ported from `packages/host/src/pr.ts` and the PR helpers
//! in `@nekko-agent/shared` (`parsePrUrl`, `collectSessionPrUrls`):
//! `pr:sessionList`, `pr:diff`, `pr:action`, and the branch lookup the git
//! status uses.
//!
//! Live state comes from the `gh` CLI, falling back to the GitHub REST API
//! with the GitHub connector's token (or `GH_TOKEN` / `GITHUB_TOKEN`). Reads
//! are serialized, cached for a minute and paused after a rate-limit answer,
//! as in the TS host; actions are always the user's own clicks.

use crate::proc::{Output, run};
use nekko_js as js;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::now_ms;

fn re(cell: &'static OnceLock<Regex>, src: &str, flags: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::with_flags(src, flags).expect("PR pattern compiles"))
}

/// `Number(x)` as JSON: an integral value prints without a fraction, and NaN
/// or an infinity as `null`, as `JSON.stringify` writes them.
pub fn js_num(f: f64) -> Value {
    if !f.is_finite() {
        Value::Null
    } else if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

/// `Number(v ?? 0)`.
fn num_or_zero(v: Option<&Value>) -> Value {
    if js::nullish(v) { json!(0) } else { js_num(js::to_number(v)) }
}

/// `(v as string) || fallback`: the value itself when truthy.
fn or_value(v: Option<&Value>) -> Option<Value> {
    js::truthy(v).then(|| v.cloned().unwrap_or(Value::Null))
}

/// `String(v || '').toUpperCase()` as the rollup reads a field.
fn upper(v: Option<&Value>) -> String {
    if js::truthy(v) { js::display(v.unwrap_or(&Value::Null)).to_uppercase() } else { String::new() }
}

/// `parsePrUrl(url)`.
pub fn parse_pr_url(url: &str) -> Option<(String, String, u64)> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = re(&R, r"github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/pull\/(\d+)", "");
    let m = r.find(url)?;
    let g = |i: usize| m.group(i).map(|r| url[r].to_string());
    let number = js::string_to_number(&g(3)?);
    Some((g(1)?, g(2)?, if number.is_finite() { number as u64 } else { return None }))
}

/// `collectSessionPrUrls(messages)`: only a successful `gh pr create` (or a
/// `gh api .../pulls -X POST`) whose whole output is one PR URL counts.
pub fn collect_session_pr_urls(messages: &[Value]) -> Vec<String> {
    static SHELL: OnceLock<Regex> = OnceLock::new();
    static CREATE: OnceLock<Regex> = OnceLock::new();
    static API: OnceLock<Regex> = OnceLock::new();
    static POST: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    let mut calls: HashMap<String, &Value> = HashMap::new();
    for m in messages {
        for c in m.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
            calls.insert(c.get("id").map(js::display).unwrap_or_else(|| "undefined".into()), c);
        }
    }
    let mut urls: Vec<String> = Vec::new();
    for m in messages {
        let result = m.get("toolResult").filter(|r| !r.is_null());
        let call = result
            .and_then(|r| r.get("toolCallId"))
            .filter(|id| js::truthy(Some(id)))
            .and_then(|id| calls.get(&js::display(id)));
        let Some(call) = call else { continue };
        if js::truthy(result.and_then(|r| r.get("isError"))) || call.get("name") != Some(&json!("bash")) {
            continue;
        }
        let command = call.get("input").and_then(|i| i.get("command")).filter(|c| !c.is_null());
        let command = command.map(js::display).unwrap_or_default();
        let command = js::trim(&command);
        if !command.starts_with("gh ") || re(&SHELL, r"[\r\n;&|`]", "").find(command).is_some() {
            continue;
        }
        let create = re(&CREATE, r"^gh\s+pr\s+create(?:\s|$)", "").find(command).is_some();
        let api = re(&API, r"^gh\s+api\s+(?:repos\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls(?:\s|$)", "")
            .find(command)
            .is_some()
            && re(&POST, r"(?:-X|--method)\s+POST\b", "").find(command).is_some();
        if !create && !api {
            continue;
        }
        let output = result.and_then(|r| r.get("output")).filter(|o| !o.is_null()).map(js::display).unwrap_or_default();
        let value = js::trim(&output);
        if re(&URL, r"^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$", "").find(value).is_some()
            && !urls.iter().any(|u| u == value)
        {
            urls.push(value.to_string());
        }
    }
    urls
}

/// `rollupChecks(statusCheckRollup)`.
pub fn rollup_checks(rollup: Option<&Value>) -> &'static str {
    let Some(Value::Array(list)) = rollup else { return "none" };
    if list.is_empty() {
        return "none";
    }
    let mut pending = false;
    for c in list {
        let conclusion = upper(c.get("conclusion"));
        let status = upper(c.get("status"));
        let state = upper(c.get("state"));
        if ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"].contains(&conclusion.as_str())
            || ["FAILURE", "ERROR"].contains(&state.as_str())
        {
            return "failing";
        }
        if (!status.is_empty() && status != "COMPLETED") || state == "PENDING" || state == "EXPECTED" {
            pending = true;
        }
    }
    if pending { "pending" } else { "passing" }
}

/// `ghState(state, mergedAt)`.
pub fn gh_state(state: &str, merged_at: Option<&Value>) -> &'static str {
    let s = state.to_uppercase();
    if s == "MERGED" || js::truthy(merged_at) {
        "merged"
    } else if s == "CLOSED" {
        "closed"
    } else {
        "open"
    }
}

fn put_opt(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.into(), v);
    }
}

/// `prInfoFromGh(url, parsed, j, lifecycle)`.
pub fn pr_info_from_gh(url: &str, owner: &str, repo: &str, number: u64, j: &Value, lifecycle: bool) -> Value {
    let get = |k: &str| j.get(k);
    let mut m = Map::new();
    m.insert("url".into(), json!(url));
    m.insert("owner".into(), json!(owner));
    m.insert("repo".into(), json!(repo));
    m.insert("number".into(), json!(number));
    let title = match get("title").filter(|t| !t.is_null()) {
        Some(t) => js::display(t),
        None if lifecycle => format!("{owner}/{repo}#{number}"),
        None => format!("#{number}"),
    };
    m.insert("title".into(), json!(title));
    let state = get("state").filter(|s| !s.is_null()).map(js::display).unwrap_or_else(|| "OPEN".into());
    m.insert("state".into(), json!(gh_state(&state, get("mergedAt"))));
    m.insert("isDraft".into(), json!(js::truthy(get("isDraft"))));
    m.insert("additions".into(), num_or_zero(get("additions")));
    m.insert("deletions".into(), num_or_zero(get("deletions")));
    m.insert("changedFiles".into(), num_or_zero(get("changedFiles")));
    put_opt(&mut m, "headRefName", or_value(get("headRefName")));
    put_opt(&mut m, "baseRefName", or_value(get("baseRefName")));
    m.insert("reviewDecision".into(), or_value(get("reviewDecision")).unwrap_or(Value::Null));
    m.insert("checks".into(), json!(rollup_checks(get("statusCheckRollup"))));
    if lifecycle {
        m.insert("createdAt".into(), or_value(get("createdAt")).unwrap_or(Value::Null));
        m.insert("closedAt".into(), or_value(get("closedAt")).unwrap_or(Value::Null));
    }
    m.insert("mergedAt".into(), or_value(get("mergedAt")).unwrap_or(Value::Null));
    m.insert("updatedAt".into(), or_value(get("updatedAt")).unwrap_or(Value::Null));
    m.insert("source".into(), json!("gh"));
    Value::Object(m)
}

/// `checksFromStatus(cj)`.
pub fn checks_from_status(cj: &Value) -> &'static str {
    let st = if js::truthy(cj.get("state")) { js::display(&cj["state"]).to_lowercase() } else { String::new() };
    match st.as_str() {
        "success" => "passing",
        "failure" | "error" => "failing",
        _ => {
            let total = cj.get("total_count").filter(|v| !v.is_null()).map_or(0.0, |v| js::to_number(Some(v)));
            if total > 0.0 { "pending" } else { "none" }
        }
    }
}

/// `prInfoFromApi(url, parsed, j, checks)`.
pub fn pr_info_from_api(url: &str, owner: &str, repo: &str, number: u64, j: &Value, checks: &str) -> Value {
    let get = |k: &str| j.get(k);
    let sub = |a: &str, b: &str| j.get(a).and_then(|x| x.get(b));
    let mut m = Map::new();
    m.insert("url".into(), json!(url));
    m.insert("owner".into(), json!(owner));
    m.insert("repo".into(), json!(repo));
    m.insert("number".into(), json!(number));
    let title =
        get("title").filter(|t| !t.is_null()).map(js::display).unwrap_or_else(|| format!("{owner}/{repo}#{number}"));
    m.insert("title".into(), json!(title));
    let state = if js::truthy(get("merged")) {
        "merged"
    } else if get("state") == Some(&json!("open")) {
        "open"
    } else {
        "closed"
    };
    m.insert("state".into(), json!(state));
    m.insert("isDraft".into(), json!(js::truthy(get("draft"))));
    m.insert("additions".into(), num_or_zero(get("additions")));
    m.insert("deletions".into(), num_or_zero(get("deletions")));
    m.insert("changedFiles".into(), num_or_zero(get("changed_files")));
    put_opt(&mut m, "headRefName", or_value(sub("head", "ref")));
    put_opt(&mut m, "baseRefName", or_value(sub("base", "ref")));
    m.insert("reviewDecision".into(), Value::Null);
    m.insert("checks".into(), json!(checks));
    for (k, from) in
        [("createdAt", "created_at"), ("closedAt", "closed_at"), ("mergedAt", "merged_at"), ("updatedAt", "updated_at")]
    {
        m.insert(k.into(), or_value(get(from)).unwrap_or(Value::Null));
    }
    m.insert("source".into(), json!("api"));
    Value::Object(m)
}

/// `diffFileFromApi(f)`.
pub fn diff_file_from_api(f: &Value) -> Value {
    let get = |k: &str| f.get(k);
    let mut m = Map::new();
    m.insert("path".into(), json!(get("filename").map_or_else(|| "undefined".into(), js::display)));
    put_opt(&mut m, "oldPath", or_value(get("previous_filename")));
    let status = get("status")
        .and_then(Value::as_str)
        .filter(|s| matches!(*s, "added" | "removed" | "renamed"))
        .unwrap_or("modified");
    m.insert("status".into(), json!(status));
    m.insert("additions".into(), num_or_zero(get("additions")));
    m.insert("deletions".into(), num_or_zero(get("deletions")));
    m.insert("patch".into(), json!(get("patch").and_then(Value::as_str).unwrap_or_default()));
    Value::Object(m)
}

/// `parseUnifiedDiff(text)`: one entry per `diff --git` block.
pub fn parse_unified_diff(text: &str) -> Vec<Value> {
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    static HEADER: OnceLock<Regex> = OnceLock::new();
    static NEW: OnceLock<Regex> = OnceLock::new();
    static DELETED: OnceLock<Regex> = OnceLock::new();
    static FROM: OnceLock<Regex> = OnceLock::new();
    static TO: OnceLock<Regex> = OnceLock::new();
    // `text.split(/^diff --git .*$/m).slice(1)`.
    let mut blocks: Vec<&str> = Vec::new();
    let mut last = 0;
    for m in re(&SPLIT, r"^diff --git .*$", "m").find_iter(text) {
        if m.range().is_empty() {
            continue;
        }
        blocks.push(&text[last..m.start()]);
        last = m.end();
    }
    blocks.push(&text[last..]);
    let blocks = &blocks[1..];
    let headers: Vec<_> = re(&HEADER, r"^diff --git a\/(.+?) b\/(.+)$", "m").find_iter(text).collect();
    let mut files = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        let mut path = headers.get(i).and_then(|h| h.group(2)).map_or("file".to_string(), |r| text[r].to_string());
        let mut old_path: Option<String> = None;
        let mut status = "modified";
        if re(&NEW, r"^new file mode", "m").find(block).is_some() {
            status = "added";
        } else if re(&DELETED, r"^deleted file mode", "m").find(block).is_some() {
            status = "removed";
        }
        let from = re(&FROM, r"^rename from (.+)$", "m").find(block);
        let to = re(&TO, r"^rename to (.+)$", "m").find(block);
        if let (Some(f), Some(t)) = (from, to) {
            status = "renamed";
            old_path = f.group(1).map(|r| block[r].to_string());
            path = t.group(1).map_or(path, |r| block[r].to_string());
        }
        let lines: Vec<&str> = block.split('\n').collect();
        let (mut additions, mut deletions) = (0u64, 0u64);
        for l in &lines {
            if l.starts_with('+') && !l.starts_with("+++") {
                additions += 1;
            } else if l.starts_with('-') && !l.starts_with("---") {
                deletions += 1;
            }
        }
        let patch = lines.iter().position(|l| l.starts_with("@@")).map_or(String::new(), |h| lines[h..].join("\n"));
        let mut m = Map::new();
        m.insert("path".into(), json!(path));
        put_opt(&mut m, "oldPath", old_path.map(Value::String));
        m.insert("status".into(), json!(status));
        m.insert("additions".into(), json!(additions));
        m.insert("deletions".into(), json!(deletions));
        m.insert("patch".into(), json!(patch));
        files.push(Value::Object(m));
    }
    files
}

/// `githubReadCooldownMs(stderr)`.
pub fn read_cooldown_ms(stderr: &str) -> u64 {
    static SECONDARY: OnceLock<Regex> = OnceLock::new();
    static PRIMARY: OnceLock<Regex> = OnceLock::new();
    if re(&SECONDARY, r"secondary rate limit|abuse detection", "i").find(stderr).is_some() {
        60_000
    } else if re(&PRIMARY, r"API rate limit (?:already )?exceeded", "i").find(stderr).is_some() {
        3_600_000
    } else {
        0
    }
}

const GH_FIELDS: &str = "number,title,state,url,isDraft,createdAt,closedAt,mergedAt,additions,deletions,changedFiles,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt";
const MAX_DIFF_FILES: usize = 80;
/// A PR read is reused this long.
const INFO_TTL: u64 = 60_000;
/// A branch's PR (or its lack of one) is remembered this long.
const BRANCH_TTL: u64 = 60_000;
const API: &str = "https://api.github.com";

/// Every PR read and action, with the TS host's caches and pacing.
pub struct Prs {
    http: reqwest::Client,
    /// Serializes background `gh` reads (`PrReadQueue`).
    reads: tokio::sync::Mutex<()>,
    cooldown_until: AtomicU64,
    gh_missing: AtomicBool,
    info: Mutex<HashMap<String, (Value, u64, u64)>>,
    info_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    branch: Mutex<HashMap<String, (Value, u64, u64)>>,
    branch_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The `gh` binary (a test points it elsewhere).
    gh: String,
    api: String,
}

impl Default for Prs {
    fn default() -> Self {
        Self::new("gh", API)
    }
}

fn key_lock(map: &Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, key: &str) -> Arc<tokio::sync::Mutex<()>> {
    map.lock().unwrap_or_else(|e| e.into_inner()).entry(key.to_string()).or_default().clone()
}

fn add_stack(info: &mut Value, native: &Value) {
    if let Some(stack) = native.get("stack")
        && stack.get("number").is_some_and(Value::is_u64)
        && stack.get("size").is_some_and(Value::is_u64)
    {
        info["stack"] = json!({"number": stack["number"], "size": stack["size"]});
    }
}

impl Prs {
    pub fn new(gh: &str, api: &str) -> Self {
        Self {
            http: reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap_or_default(),
            reads: tokio::sync::Mutex::new(()),
            cooldown_until: AtomicU64::new(0),
            gh_missing: AtomicBool::new(false),
            info: Mutex::default(),
            info_locks: Mutex::default(),
            branch: Mutex::default(),
            branch_locks: Mutex::default(),
            gh: gh.into(),
            api: api.trim_end_matches('/').into(),
        }
    }

    fn cooling(&self) -> bool {
        now_ms() < self.cooldown_until.load(Ordering::SeqCst)
    }

    fn note_cooldown(&self, stderr: &str) {
        let until = now_ms() + read_cooldown_ms(stderr);
        self.cooldown_until.fetch_max(until, Ordering::SeqCst);
    }

    /// `runGhRead`: one background read at a time, refused while cooling down.
    async fn gh_read(&self, args: &[&str], timeout: Duration, cwd: Option<&str>) -> Output {
        let _turn = self.reads.lock().await;
        if self.cooling() {
            return Output {
                ok: false,
                stdout: String::new(),
                stderr: "GitHub background reads paused after rate limit".into(),
                missing: false,
            };
        }
        let out = run(&self.gh, args, timeout, cwd, 8 * 1024 * 1024).await;
        self.note_cooldown(&out.stderr);
        out
    }

    fn headers(&self, token: Option<&str>) -> reqwest::header::HeaderMap {
        use reqwest::header::{HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        h.insert("Accept", HeaderValue::from_static("application/vnd.github+json"));
        h.insert("X-GitHub-Api-Version", HeaderValue::from_static("2026-03-10"));
        h.insert("User-Agent", HeaderValue::from_static("nekko-agent"));
        if let Some(v) = token.and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok()) {
            h.insert("Authorization", v);
        }
        h
    }

    async fn api_json(&self, url: &str, token: Option<&str>) -> Option<Value> {
        let res = self.http.get(url).headers(self.headers(token)).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Value>().await.ok()
    }

    async fn native_pr(&self, slug: &str, number: u64, token: Option<&str>) -> Option<Value> {
        let path = format!("repos/{slug}/pulls/{number}");
        if !self.gh_missing.load(Ordering::SeqCst) {
            let result = self
                .gh_read(
                    &["api", &path, "--method", "GET", "-H", "X-GitHub-Api-Version: 2026-03-10"],
                    Duration::from_secs(15),
                    None,
                )
                .await;
            if result.ok {
                return serde_json::from_str(&result.stdout).ok();
            }
            if result.missing {
                self.gh_missing.store(true, Ordering::SeqCst);
            } else if token.is_none() {
                return None;
            }
        }
        let response = self
            .http
            .get(format!("{}/{path}", self.api))
            .headers(self.headers(token))
            .header("X-GitHub-Api-Version", "2026-03-10")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json().await.ok()
    }

    /// `githubStackRequest(path, pullRequests?)`: `gh api` (a read through the
    /// read queue, a write on its own), the REST API when gh is missing or a
    /// read failed with a token to try. A failed write is never repeated: it
    /// may already have happened.
    pub async fn stack_request(
        &self,
        path: &str,
        body: Option<&[Value]>,
        token: Option<&str>,
    ) -> Result<Value, String> {
        let method = if body.is_some() { "POST" } else { "GET" };
        if !self.gh_missing.load(Ordering::SeqCst) {
            let mut args: Vec<String> = ["api", path, "--method", method, "-H", "X-GitHub-Api-Version: 2026-03-10"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            for n in body.unwrap_or_default() {
                args.push("-F".into());
                args.push(format!("pull_requests[]={}", js::display(n)));
            }
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            let result = if body.is_some() {
                run(&self.gh, &refs, Duration::from_secs(30), None, 8 * 1024 * 1024).await
            } else {
                self.gh_read(&refs, Duration::from_secs(15), None).await
            };
            if result.missing {
                self.gh_missing.store(true, Ordering::SeqCst);
            } else if result.ok {
                return serde_json::from_str(&result.stdout).map_err(|e| e.to_string());
            } else if body.is_some() || token.is_none() {
                let text = if result.stderr.is_empty() {
                    "GitHub request failed. Sign in to gh or connect GitHub."
                } else {
                    &result.stderr
                };
                return Err(js::slice16(js::trim(text), 300).to_string());
            }
        }
        let mut req = match body {
            Some(_) => self.http.post(format!("{}/{path}", self.api)),
            None => self.http.get(format!("{}/{path}", self.api)),
        }
        .headers(self.headers(token))
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(30));
        if let Some(numbers) = body {
            req = req.body(js::stringify(&json!({ "pull_requests": numbers })));
        }
        let res = req.send().await.map_err(|_| "fetch failed".to_string())?;
        if !res.status().is_success() {
            return Err(format!(
                "GitHub request failed ({}). Check repository access and GitHub stack availability.",
                res.status().as_u16()
            ));
        }
        res.json().await.map_err(|e| e.to_string())
    }

    /// `refreshPrInfo(url)`: the by-URL read, forced.
    pub async fn refresh_info(&self, url: &str, token: Option<&str>) -> Value {
        self.cached_info(url, token, true).await
    }

    /// `fetchPrInfo(url)`: gh first, the REST API when gh is missing, not
    /// signed in, or cannot see the repository.
    pub async fn fetch_info(&self, url: &str, token: Option<&str>) -> Value {
        let Some((owner, repo, number)) = parse_pr_url(url) else { return Value::Null };
        let slug = format!("{owner}/{repo}");
        if !self.gh_missing.load(Ordering::SeqCst) && !self.cooling() {
            let n = number.to_string();
            let res = self
                .gh_read(&["pr", "view", &n, "--repo", &slug, "--json", GH_FIELDS], Duration::from_secs(15), None)
                .await;
            self.note_cooldown(&res.stderr);
            if res.missing {
                self.gh_missing.store(true, Ordering::SeqCst);
            } else if res.ok
                && let Ok(j) = serde_json::from_str::<Value>(&res.stdout)
            {
                let mut info = pr_info_from_gh(url, &owner, &repo, number, &j, true);
                if let Some(native) = self.native_pr(&slug, number, token).await {
                    add_stack(&mut info, &native);
                }
                return info;
            }
        }
        let base = format!("{}/repos/{owner}/{repo}", self.api);
        let Some(j) = self.api_json(&format!("{base}/pulls/{number}"), token).await else { return Value::Null };
        let mut checks = "none";
        if let Some(sha) = j.get("head").and_then(|h| h.get("sha")).filter(|s| js::truthy(Some(s)))
            && let Some(cj) = self.api_json(&format!("{base}/commits/{}/status", js::display(sha)), token).await
        {
            checks = checks_from_status(&cj);
        }
        let mut info = pr_info_from_api(url, &owner, &repo, number, &j, checks);
        add_stack(&mut info, &j);
        info
    }

    /// The by-URL read, cached for a minute and shared by concurrent callers.
    pub async fn cached_info(&self, url: &str, token: Option<&str>, force: bool) -> Value {
        let started = crate::read_seq();
        let lock = key_lock(&self.info_locks, url);
        let _held = lock.lock().await;
        if let Some((v, at, seq)) = self.info.lock().unwrap_or_else(|e| e.into_inner()).get(url).cloned() {
            // Fresh, or read by a caller this one waited behind.
            if (!force && now_ms().saturating_sub(at) < INFO_TTL) || seq > started {
                return v;
            }
        }
        let v = self.fetch_info(url, token).await;
        self.info
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(url.into(), (v.clone(), now_ms(), crate::next_read()));
        v
    }

    /// `branchPr(cwd, branch)`: the PR gh finds for a checked-out branch, or null.
    pub async fn branch_pr(&self, cwd: &str, branch: &str) -> Value {
        if self.gh_missing.load(Ordering::SeqCst) {
            return Value::Null;
        }
        let key = format!("{cwd}|{branch}");
        let hit = || self.branch.lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned();
        if let Some((v, at, _)) = hit()
            && now_ms().saturating_sub(at) < BRANCH_TTL
        {
            return v;
        }
        if self.cooling() {
            return hit().map_or(Value::Null, |(v, _, _)| v);
        }
        let started = crate::read_seq();
        let lock = key_lock(&self.branch_locks, &key);
        let _held = lock.lock().await;
        if let Some((v, _, seq)) = hit()
            && seq > started
        {
            return v;
        }
        let res = self.gh_read(&["pr", "view", branch, "--json", GH_FIELDS], Duration::from_secs(10), Some(cwd)).await;
        self.note_cooldown(&res.stderr);
        if res.missing {
            self.gh_missing.store(true, Ordering::SeqCst);
        }
        let mut info = Value::Null;
        if res.ok
            && let Ok(j) = serde_json::from_str::<Value>(&res.stdout)
        {
            let url = j.get("url").filter(|u| !u.is_null()).map(js::display).unwrap_or_default();
            if let Some((owner, repo, number)) = parse_pr_url(&url) {
                info = pr_info_from_gh(&url, &owner, &repo, number, &j, false);
            }
        }
        self.branch.lock().unwrap_or_else(|e| e.into_inner()).insert(key, (info.clone(), now_ms(), crate::next_read()));
        info
    }

    /// `listSessionPrs`: live state for every PR the chat created.
    pub async fn session_prs(&self, messages: &[Value], token: Option<&str>, force: bool) -> Vec<Value> {
        let urls = collect_session_pr_urls(messages);
        let reads = urls.iter().map(|u| self.cached_info(u, token, force));
        futures_util::future::join_all(reads).await.into_iter().filter(|v| !v.is_null()).collect()
    }

    /// `getPrDiff(url)`: the changed files and their hunks, at most 80.
    pub async fn diff(&self, url: &str, token: Option<&str>) -> Value {
        let Some((owner, repo, number)) = parse_pr_url(url) else { return json!({ "url": url, "files": [] }) };
        if !self.gh_missing.load(Ordering::SeqCst) {
            let slug = format!("{owner}/{repo}");
            let res = run(
                &self.gh,
                &["pr", "diff", &number.to_string(), "--repo", &slug],
                Duration::from_secs(20),
                None,
                8 * 1024 * 1024,
            )
            .await;
            if res.missing {
                self.gh_missing.store(true, Ordering::SeqCst);
            } else if res.ok {
                let files = parse_unified_diff(&res.stdout);
                let truncated = files.len() > MAX_DIFF_FILES;
                return json!({ "url": url, "files": files.into_iter().take(MAX_DIFF_FILES).collect::<Vec<_>>(), "truncated": truncated });
            }
        }
        let api = format!("{}/repos/{owner}/{repo}/pulls/{number}/files?per_page=100", self.api);
        match self.api_json(&api, token).await {
            Some(Value::Array(arr)) => {
                let files: Vec<Value> = arr.iter().take(MAX_DIFF_FILES).map(diff_file_from_api).collect();
                json!({ "url": url, "files": files, "truncated": arr.len() > MAX_DIFF_FILES })
            }
            // `arr.slice` on anything else throws, which the TS host answers as no files.
            _ => json!({ "url": url, "files": [] }),
        }
    }

    async fn api_action(
        &self,
        owner: &str,
        repo: &str,
        number: u64,
        action: &str,
        token: Option<&str>,
    ) -> (bool, String) {
        let Some(token) = token else {
            return (false, "No gh CLI and no GitHub token configured. Connect GitHub in Connectors, or install and sign in to the gh CLI.".into());
        };
        let base = format!("{}/repos/{owner}/{repo}", self.api);
        let h = self.headers(Some(token));
        let sent = match action {
            "approve" => {
                self.http
                    .post(format!("{base}/pulls/{number}/reviews"))
                    .headers(h)
                    .body(r#"{"event":"APPROVE"}"#)
                    .send()
                    .await
            }
            "merge" => {
                self.http
                    .put(format!("{base}/pulls/{number}/merge"))
                    .headers(h)
                    .body(r#"{"merge_method":"merge"}"#)
                    .send()
                    .await
            }
            _ => {
                let state = if action == "reopen" { "open" } else { "closed" };
                self.http
                    .patch(format!("{base}/pulls/{number}"))
                    .headers(h)
                    .body(json!({ "state": state }).to_string())
                    .send()
                    .await
            }
        };
        let r = match sent {
            Ok(r) => r,
            Err(e) => return (false, e.to_string()),
        };
        let (ok, status) = (r.status().is_success(), r.status().as_u16());
        let message = match (action, ok) {
            ("approve", true) => "Approved.".to_string(),
            ("approve", false) => format!("Approve failed ({status})."),
            ("merge", true) => "Merged.".into(),
            ("merge", false) => format!("Merge failed ({status})."),
            ("reopen", true) => "Reopened.".into(),
            (_, true) => "Closed.".into(),
            (a, false) => format!("{a} failed ({status})."),
        };
        (ok, message)
    }

    /// `prAction(url, action)`: approve, close, reopen or merge, then the
    /// PR's state read afresh.
    pub async fn action(&self, url: &str, action: &str, token: Option<&str>) -> Value {
        let Some((owner, repo, number)) = parse_pr_url(url) else {
            return json!({ "ok": false, "message": "Not a valid PR URL." });
        };
        let slug = format!("{owner}/{repo}");
        let n = number.to_string();
        if action == "merge" {
            match self.native_pr(&slug, number, token).await {
                Some(native) if js::truthy(native.get("stack")) => {
                    return json!({"ok": false, "message": "Merge this stack on GitHub to review all included layers. Open the PR on GitHub."});
                }
                None => {
                    return json!({"ok": false, "message": "Could not verify stack membership. Refresh GitHub access before merging."});
                }
                _ => {}
            }
        }
        let (ok, message) = if !self.gh_missing.load(Ordering::SeqCst) {
            let args: Vec<&str> = match action {
                "approve" => vec!["pr", "review", &n, "--repo", &slug, "--approve"],
                "close" => vec!["pr", "close", &n, "--repo", &slug],
                "reopen" => vec!["pr", "reopen", &n, "--repo", &slug],
                "merge" => vec!["pr", "merge", &n, "--repo", &slug, "--merge"],
                // `argsByAction[action]` is undefined: execFile throws, which rejects the call.
                other => return json!({ "error": format!("Unknown PR action: {other}") }),
            };
            let res = run(&self.gh, &args, Duration::from_secs(30), None, 8 * 1024 * 1024).await;
            if res.missing {
                self.gh_missing.store(true, Ordering::SeqCst);
                self.api_action(&owner, &repo, number, action, token).await
            } else if res.ok {
                let mut chars = action.chars();
                let cap =
                    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default();
                (true, format!("{cap} succeeded."))
            } else {
                let text = if !res.stderr.is_empty() {
                    res.stderr.clone()
                } else if !res.stdout.is_empty() {
                    res.stdout.clone()
                } else {
                    format!("gh {action} failed")
                };
                let first = js::trim(&text).split('\n').next().unwrap_or_default().to_string();
                (false, js::slice16(&first, 240).to_string())
            }
        } else {
            self.api_action(&owner, &repo, number, action, token).await
        };
        self.info.lock().unwrap_or_else(|e| e.into_inner()).remove(url);
        let mut out = Map::new();
        out.insert("ok".into(), json!(ok));
        out.insert("message".into(), json!(message));
        if ok {
            let pr = self.cached_info(url, token, true).await;
            if !pr.is_null() {
                out.insert("pr".into(), pr);
            }
        }
        Value::Object(out)
    }
}
