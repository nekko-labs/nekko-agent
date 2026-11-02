//! Usage, reply and limit accounting owned by the daemon (PF14):
//! `usage:summary`, `limits:get`, `limits:problem`, `limits:poll`,
//! `limits:clear`, and the lines a daemon-driven turn writes.
//!
//! The log formats, the summary and the parsers are `nekko-usage`'s (held to
//! the TS functions by a golden set). This is the stateful half of
//! `packages/host/src/limits.ts`: the snapshot per token key, the 30-second
//! poll throttle, one poll at a time per key, why the last read failed and
//! the backoff before the next. A sign-in is renewed by the daemon's own
//! OAuth service (`oauth.rs`, tokens.json's single writer).

use crate::hub::Hub;
use nekko_usage::{LimitsError, Problem};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The channels served here.
pub const CHANNELS: &[&str] = &["usage:summary", "limits:get", "limits:problem", "limits:poll", "limits:clear"];

const POLL_INTERVAL_MS: f64 = 30_000.0;
const CHATGPT_BASE: &str = "https://chatgpt.com/backend-api";
const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
/// A quota read that takes longer than this is a network failure.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `LimitsProblem`.
#[derive(Clone, Debug)]
struct Failure {
    kind: &'static str,
    status: Option<u16>,
    at: f64,
    retry_at: Option<f64>,
    failures: f64,
}

impl Failure {
    fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("kind".into(), json!(self.kind));
        if let Some(s) = self.status {
            o.insert("status".into(), json!(s));
        }
        o.insert("at".into(), nekko_usage::num(self.at));
        if let Some(r) = self.retry_at {
            o.insert("retryAt".into(), nekko_usage::num(r));
        }
        o.insert("failures".into(), nekko_usage::num(self.failures));
        Value::Object(o)
    }
}

#[derive(Default)]
struct State {
    store: HashMap<String, Value>,
    last_poll: HashMap<String, f64>,
    problems: HashMap<String, Failure>,
    /// Bumped by `limits:clear`, so a poll that was in flight does not write back.
    generation: HashMap<String, u64>,
    /// One poll at a time per key; a caller that waited reads what it stored.
    gates: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

/// A daemon-driven turn's accounting facts (`facts.account` in `chat:turn`).
#[derive(Clone, Debug)]
pub struct TurnAccount {
    pub provider: Value,
    pub token_key: Option<String>,
    pub subscription: bool,
    pub incognito: bool,
}

impl TurnAccount {
    /// The turn's `facts.account`; a spec without one (a test's) counts as
    /// a non-subscription turn of no known provider kind.
    pub fn from_facts(facts: &Value) -> TurnAccount {
        let none = json!({});
        let a = facts.get("account").filter(|a| a.is_object()).unwrap_or(&none);
        TurnAccount {
            provider: json!({ "auth": a.get("auth"), "kind": a.get("kind") }),
            token_key: a.get("tokenKey").and_then(Value::as_str).filter(|k| !k.is_empty()).map(str::to_string),
            subscription: a.get("auth").and_then(Value::as_str) == Some("subscription"),
            incognito: a.get("incognito") == Some(&Value::Bool(true)),
        }
    }
}

pub struct Accounts {
    dir: PathBuf,
    hub: Hub,
    http: reqwest::Client,
    state: Mutex<State>,
    /// Appends from this process, one at a time, so lines never interleave.
    append: Mutex<()>,
    /// The daemon's own sign-in service, which renews tokens.
    pub oauth: std::sync::OnceLock<std::sync::Weak<crate::oauth::OAuth>>,
}

/// `quota-history.jsonl` lines kept, by age (#1035). Nothing reads older ones back.
const QUOTA_HISTORY_DAYS: f64 = 30.0;

/// Drop quota-history lines older than [`QUOTA_HISTORY_DAYS`]. A line without
/// a readable time is kept. Rewritten through a temporary file, at startup only.
fn prune_quota_history(path: &std::path::Path, now_ms: f64) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let cutoff = now_ms - QUOTA_HISTORY_DAYS * 86_400_000.0;
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| {
            let at = serde_json::from_str::<Value>(l).ok().and_then(|v| v.get("timestamp").and_then(Value::as_f64));
            at.is_none_or(|t| t >= cutoff)
        })
        .collect();
    if kept.len() == text.lines().count() {
        return;
    }
    let body: String = kept.iter().map(|l| format!("{l}\n")).collect();
    let _ = nekko_js::fs::atomic_write(path, body.as_bytes(), Default::default());
}

impl Accounts {
    pub fn new(dir: PathBuf, hub: Hub) -> Self {
        prune_quota_history(&dir.join("quota-history.jsonl"), nekko_oauth::now_ms());
        let http = reqwest::Client::builder().timeout(READ_TIMEOUT).build().unwrap_or_default();
        Self { dir, hub, http, state: Mutex::default(), append: Mutex::new(()), oauth: std::sync::OnceLock::new() }
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        let key = arg(0).as_str().unwrap_or_default().to_string();
        match channel {
            "usage:summary" => {
                let dir = self.dir.clone();
                tokio::task::spawn_blocking(move || nekko_usage::usage_summary(&nekko_usage::UsageFiles::read(&dir)))
                    .await
                    .map_err(|e| e.to_string())?
            }
            "limits:get" => Ok(self.get_limits(&key, arg(1) == &json!(true)).await.unwrap_or(Value::Null)),
            "limits:problem" => Ok(lock(&self.state).problems.get(&key).map_or(Value::Null, Failure::value)),
            "limits:poll" => Ok(self.poll(&key).await.unwrap_or(Value::Null)),
            "limits:clear" => {
                self.clear(arg(0).as_str());
                Ok(Value::Null)
            }
            other => Err(format!("{other} is not an accounting channel")),
        }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// `appendFileSync(path, line + '\n')`; failures are not fatal, as in TS.
    fn append_line(&self, name: &str, line: &str, private: bool) {
        let path = self.file(name);
        let _guard = lock(&self.append);
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = private;
        if let Ok(mut f) = opts.open(&path) {
            let _ = f.write_all(format!("{line}\n").as_bytes());
        }
    }

    /// `recordUsage(turnUsageRecord(...))` for one model call of a turn.
    pub fn turn_usage(&self, opts: &Value, account: &TurnAccount, event: &Value) {
        let rec = nekko_usage::turn_usage_record(opts, &account.provider, event, nekko_js::now_ms_f64() as u64);
        self.append_line("usage.jsonl", &nekko_js::stringify(&rec), false);
    }

    /// The usage of a turn's side call (the title), as `sideUsage` wrote it.
    /// A usage line made elsewhere (a compaction's summary calls, `compactionUsageRecord`).
    pub fn usage_line(&self, record: &Value) {
        self.append_line("usage.jsonl", &nekko_js::stringify(record), false);
    }

    pub fn side_usage(&self, provider: &Value, model_id: Option<&Value>, session_id: &str, usage: &[Value]) {
        for item in usage {
            let rec = nekko_usage::side_usage_record(
                provider,
                model_id,
                Some(&json!(session_id)),
                item,
                nekko_js::now_ms_f64() as u64,
            );
            self.append_line("usage.jsonl", &nekko_js::stringify(&rec), false);
        }
    }

    /// `recordTurnEnd`: the reply line, and a fresh look at the subscription's limits.
    pub fn turn_end(
        self: &Arc<Self>,
        opts: &Value,
        account: &TurnAccount,
        started_at: u64,
        done: &Value,
        stats: Option<&Value>,
    ) {
        let reply = nekko_usage::turn_reply_record(
            opts,
            account.incognito,
            started_at,
            done,
            stats,
            nekko_js::now_ms_f64() as u64,
        );
        if let Some(r) = reply {
            self.append_line("replies.jsonl", &nekko_js::stringify(&r), false);
        }
        if account.subscription
            && let Some(key) = account.token_key.clone()
        {
            let me = self.clone();
            tokio::spawn(async move {
                let _ = me.poll(&key).await;
            });
        }
    }

    fn settings(&self) -> Value {
        std::fs::read(self.file("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null)
    }

    fn providers(&self) -> Vec<Value> {
        self.settings().get("providers").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn token(&self, key: &str) -> Option<Value> {
        let tokens: Value =
            std::fs::read(self.file("tokens.json")).ok().and_then(|b| serde_json::from_slice(&b).ok())?;
        tokens.get(key).filter(|t| t.is_object()).cloned()
    }

    fn quota_history(&self, key: &str, source: &str, limits: &Value) {
        if let Some(rec) = nekko_usage::quota_history_record(&self.providers(), key, source, limits) {
            self.append_line("quota-history.jsonl", &nekko_js::stringify(&rec), true);
        }
    }

    /// Tell the UI, and the host for the phone relay.
    fn notify(&self, key: &str, limits: &Value) {
        let payload = json!({ "tokenKey": key, "limits": limits });
        self.hub.publish("limits:updated", payload, false);
    }

    fn get(&self, key: &str) -> Option<Value> {
        lock(&self.state).store.get(key).cloned()
    }

    /// `clearLimits(tokenKey?)`.
    pub fn clear(&self, key: Option<&str>) {
        let mut s = lock(&self.state);
        match key {
            Some(k) => {
                s.store.remove(k);
                s.last_poll.remove(k);
                s.problems.remove(k);
                *s.generation.entry(k.to_string()).or_default() += 1;
            }
            None => {
                s.store.clear();
                s.last_poll.clear();
                s.problems.clear();
                // The "" entry is everyone's: every poll compares it too.
                *s.generation.entry(String::new()).or_default() += 1;
            }
        }
    }

    fn generation(&self, key: &str) -> (u64, u64) {
        let s = lock(&self.state);
        (s.generation.get(key).copied().unwrap_or(0), s.generation.get("").copied().unwrap_or(0))
    }

    /// An Anthropic API-key response's own rate limits, stored under the
    /// provider's `provider:<id>` key. Each response reports every window, so
    /// the snapshot is replaced rather than merged.
    pub fn record_api_headers(&self, key: &str, pairs: &[(String, String)]) -> Option<Value> {
        let parsed = nekko_usage::parse_anthropic_api_headers(pairs, nekko_js::now_ms_f64());
        if parsed.get("windows").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return self.get(key);
        }
        lock(&self.state).store.insert(key.to_string(), parsed.clone());
        self.notify(key, &parsed);
        Some(parsed)
    }

    /// `getLimits(tokenKey, refresh)`: the snapshot while fresh, else a poll,
    /// and nothing rather than a stale snapshot.
    pub async fn get_limits(self: &Arc<Self>, key: &str, refresh: bool) -> Option<Value> {
        let fresh = |v: &Value| {
            let at = v.get("updatedAt").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let stale = v.get("staleAfterMs").and_then(Value::as_f64).unwrap_or(f64::NAN);
            at + stale > nekko_js::now_ms_f64()
        };
        if !refresh && let Some(s) = self.get(key).filter(fresh) {
            return Some(s);
        }
        self.poll(key).await.filter(fresh)
    }

    fn record_problem(&self, key: &str, e: &Problem) {
        let LimitsError { kind, status, retry_after_ms } = nekko_usage::classify_limits_error(e);
        let now = nekko_js::now_ms_f64();
        let mut s = lock(&self.state);
        let failures = s.problems.get(key).map_or(0.0, |p| p.failures) + 1.0;
        // A dead sign-in will not fix itself: wait for the user.
        let waits = kind == "auth_expired" || kind == "signed_out";
        let retry_at = (!waits).then(|| now + nekko_usage::limits_backoff_ms(failures, retry_after_ms));
        s.problems.insert(key.to_string(), Failure { kind, status, at: now, retry_at, failures });
    }

    /// `poll(tokenKey)`: at most one read per key every 30 seconds, none while
    /// a failure's backoff runs, and none for a dead sign-in until it changes.
    pub async fn poll(self: &Arc<Self>, key: &str) -> Option<Value> {
        // A `provider:<id>` key is an API-key provider read with its inference
        // key; everything else is a sign-in's token key.
        let api_provider = key.strip_prefix("provider:").and_then(|id| {
            self.providers()
                .into_iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(id) && nekko_js::truthy(p.get("enabled")))
        });
        let token = if api_provider.is_some() { None } else { self.token(key) };
        if api_provider.is_none() && token.is_none() {
            if !lock(&self.state).problems.contains_key(key) {
                self.record_problem(key, &Problem::Read(LimitsError::new("signed_out", None)));
            }
            return self.get(key);
        }
        let gate = lock(&self.state).gates.entry(key.to_string()).or_default().clone();
        let _held = gate.lock().await;
        let now = nekko_js::now_ms_f64();
        {
            let s = lock(&self.state);
            if now - s.last_poll.get(key).copied().unwrap_or(0.0) < POLL_INTERVAL_MS {
                return s.store.get(key).cloned();
            }
            if let Some(p) = s.problems.get(key) {
                let obtained = token.as_ref().and_then(|t| t.get("obtainedAt")).and_then(Value::as_f64).unwrap_or(0.0);
                let blocked = match p.retry_at {
                    None => !(token.is_some() && obtained > p.at),
                    Some(r) => now < r,
                };
                if blocked {
                    return s.store.get(key).cloned();
                }
            }
        }
        let before = self.generation(key);
        let read = match &api_provider {
            Some(p) => self.read_api_key_provider(p).await,
            None => self.read_signed_in(key).await,
        };
        if self.generation(key) != before {
            return self.get(key);
        }
        match read {
            Ok(next) => {
                if let Some(next) = &next {
                    self.quota_history(key, "poll", next);
                    {
                        let mut s = lock(&self.state);
                        s.store.insert(key.to_string(), next.clone());
                        s.problems.remove(key);
                    }
                    self.notify(key, next);
                }
                lock(&self.state).last_poll.insert(key.to_string(), nekko_js::now_ms_f64());
                next.or_else(|| self.get(key))
            }
            Err(e) => {
                lock(&self.state).last_poll.insert(key.to_string(), nekko_js::now_ms_f64());
                self.record_problem(key, &e);
                self.get(key)
            }
        }
    }

    /// A token usable now: the stored one while it is good for another
    /// minute (or never expires), else the sign-in service renews it and it is read back.
    async fn fresh_token(&self, key: &str) -> Result<Option<Value>, Problem> {
        let usable = |t: &Value| {
            let expires = token_expires_at(t);
            match expires {
                Some(e) => e - 60_000.0 > nekko_js::now_ms_f64(),
                None => !nekko_js::truthy(t.get("refreshToken")),
            }
        };
        if let Some(t) = self.token(key).filter(usable) {
            return Ok(Some(t));
        }
        let oauth = self
            .oauth
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| Problem::Message("no sign-in service to renew the token".into()))?;
        oauth.ensure_fresh(key, false).await.map_err(Problem::Message)?;
        Ok(self.token(key))
    }

    async fn read_signed_in(&self, key: &str) -> Result<Option<Value>, Problem> {
        // Signed out meanwhile: nothing to read, and nothing wrong to report.
        let Some(fresh) = self.fresh_token(key).await? else { return Ok(None) };
        let access = fresh.get("accessToken").and_then(Value::as_str).unwrap_or_default().to_string();
        let base_for = |default: &str| {
            self.providers()
                .into_iter()
                .find(|p| p.get("tokenKey").and_then(Value::as_str) == Some(key))
                .and_then(|p| p.get("baseUrl").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| default.to_string())
        };
        match fresh.get("provider").and_then(Value::as_str) {
            Some("chatgpt") => {
                let Some(account) = fresh.get("accountId").and_then(Value::as_str).filter(|a| !a.is_empty()) else {
                    return Err(Problem::Read(LimitsError::new("auth_expired", None)));
                };
                let base = base_for(CHATGPT_BASE).trim_end_matches('/').to_string();
                let req = self
                    .http
                    .get(format!("{base}/wham/usage"))
                    .header("Authorization", format!("Bearer {access}"))
                    .header("ChatGPT-Account-Id", account);
                let (status, body) = send(req).await?;
                let json = body.as_ref().and_then(Value::as_object).ok_or(unreadable(status))?;
                Ok(Some(nekko_usage::parse_chatgpt_usage(json, nekko_js::now_ms_f64())))
            }
            Some("openrouter") => read_openrouter(&self.http, &base_for(OPENROUTER_BASE), &access).await.map(Some),
            _ => Ok(None),
        }
    }

    async fn read_api_key_provider(&self, provider: &Value) -> Result<Option<Value>, Problem> {
        let Some(key) = provider.get("apiKey").and_then(Value::as_str).filter(|k| !k.is_empty()) else {
            return Ok(None);
        };
        if provider.get("kind").and_then(Value::as_str) != Some("openrouter") {
            return Ok(None);
        }
        let base = provider.get("baseUrl").and_then(Value::as_str).filter(|b| !b.is_empty()).unwrap_or(OPENROUTER_BASE);
        read_openrouter(&self.http, base, key).await.map(Some)
    }
}

/// `tokenExpiresAt`: the stored expiry, or a ChatGPT JWT's `exp` claim.
fn token_expires_at(t: &Value) -> Option<f64> {
    if let Some(e) = t.get("expiresAt").and_then(Value::as_f64).filter(|e| *e != 0.0) {
        return Some(e);
    }
    if t.get("provider").and_then(Value::as_str) != Some("chatgpt") {
        return None;
    }
    let jwt = t.get("accessToken").and_then(Value::as_str)?;
    let payload = jwt.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&base64url(payload)?).ok()?;
    claims.get("exp").and_then(Value::as_f64).map(|s| s * 1000.0)
}

fn base64url(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter(|&c| c != b'=') {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn unreadable(status: u16) -> Problem {
    Problem::Read(LimitsError::new("unreadable", Some(status)))
}

/// One quota read: the status and the body as JSON (`None` when it does not
/// parse), or the failure a non-2xx answer or the network is.
async fn send(req: reqwest::RequestBuilder) -> Result<(u16, Option<Value>), Problem> {
    // A blocked read is quiet: it lands as a problem and the backoff applies.
    let res = nekko_net::send("limits", req)
        .await
        .map_err(|e| Problem::Message(if e.is_blocked() { e.to_string() } else { format!("fetch failed: {e}") }))?;
    let status = res.status().as_u16();
    if !res.status().is_success() {
        let retry = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_string);
        return Err(Problem::Read(match status {
            401 | 403 => LimitsError::new("auth_expired", Some(status)),
            429 => LimitsError {
                kind: "rate_limited",
                status: Some(429),
                retry_after_ms: nekko_usage::parse_retry_after(retry.as_deref(), nekko_js::now_ms_f64()),
            },
            _ => LimitsError::new("http", Some(status)),
        }));
    }
    let bytes = res.bytes().await.map_err(|e| Problem::Message(format!("fetch failed: {e}")))?;
    Ok((status, serde_json::from_str(&nekko_js::decode_text(&bytes)).ok()))
}

async fn read_openrouter(http: &reqwest::Client, base: &str, bearer: &str) -> Result<Value, Problem> {
    let url = format!("{}/key", base.trim_end_matches('/'));
    let (status, body) = send(http.get(url).header("Authorization", format!("Bearer {bearer}"))).await?;
    nekko_usage::parse_openrouter_key(body.as_ref(), status, nekko_js::now_ms_f64()).map_err(Problem::Read)
}

#[cfg(test)]
mod tests {

    #[test]
    fn quota_history_keeps_thirty_days() {
        let d = std::env::temp_dir().join(format!("nekko-quota-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("quota-history.jsonl");
        let day = 86_400_000.0;
        let now = 100.0 * day;
        std::fs::write(
            &p,
            format!("{{\"timestamp\":{}}}\n{{\"timestamp\":{}}}\nnot json\n", now - 40.0 * day, now - day),
        )
        .unwrap();
        super::prune_quota_history(&p, now);
        let kept = std::fs::read_to_string(&p).unwrap();
        assert_eq!(kept.lines().count(), 2, "{kept}");
        assert!(kept.contains(&format!("{}", now - day)) && kept.contains("not json"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nekkod-accounts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn accounts(dir: &std::path::Path) -> Arc<Accounts> {
        Arc::new(Accounts::new(dir.to_path_buf(), Hub::new()))
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[tokio::test]
    async fn api_key_headers_replace_the_provider_snapshot() {
        let dir = temp_dir("api-headers");
        let a = accounts(&dir);
        let key = "provider:anthropic-1";
        assert_eq!(a.record_api_headers(key, &pairs(&[("x", "y")])), None, "no rate-limit headers, nothing stored");
        let first = a
            .record_api_headers(
                key,
                &pairs(&[
                    ("anthropic-ratelimit-requests-limit", "50"),
                    ("anthropic-ratelimit-requests-remaining", "10"),
                    ("anthropic-ratelimit-input-tokens-limit", "1000"),
                    ("anthropic-ratelimit-input-tokens-remaining", "900"),
                ]),
            )
            .unwrap();
        assert_eq!(first["windows"].as_array().unwrap().len(), 2);
        let second = a
            .record_api_headers(
                key,
                &pairs(&[
                    ("anthropic-ratelimit-requests-limit", "50"),
                    ("anthropic-ratelimit-requests-remaining", "49"),
                ]),
            )
            .unwrap();
        let ids: Vec<&str> = second["windows"].as_array().unwrap().iter().map(|w| w["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["rpm"], "each response reports every window, so nothing is carried forward");
        assert_eq!(a.get_limits(key, false).await, Some(second));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn quota_history_is_written_only_for_a_configured_provider() {
        let dir = temp_dir("history");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"providers":[{"id":"c","kind":"chatgpt","tokenKey":"chatgpt:x"}]}"#,
        )
        .unwrap();
        let a = accounts(&dir);
        let snapshot = json!({ "windows": [{ "id": "5h", "label": "5-hour", "scope": "session", "usedPercent": 50, "resetAt": 0, "status": "allowed" }], "updatedAt": 1, "staleAfterMs": 35000 });
        a.quota_history("chatgpt:x", "poll", &snapshot);
        a.quota_history("chatgpt:y", "poll", &snapshot);
        let text = std::fs::read_to_string(dir.join("quota-history.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.starts_with(r#"{"timestamp":"#) && text.contains(r#""providerId":"c","source":"poll""#), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_missing_sign_in_is_a_signed_out_problem_and_is_not_retried() {
        let dir = temp_dir("signed-out");
        let a = accounts(&dir);
        assert_eq!(a.poll("chatgpt:none").await, None);
        let p = a.route("limits:problem", &[json!("chatgpt:none")]).await.unwrap();
        assert_eq!(p["kind"], "signed_out");
        assert_eq!(p["failures"], 1);
        assert!(p.get("retryAt").is_none(), "a dead sign-in waits for the user");
        a.poll("chatgpt:none").await;
        let p = a.route("limits:problem", &[json!("chatgpt:none")]).await.unwrap();
        assert_eq!(p["failures"], 1, "recorded once, not on every poll");
        a.clear(Some("chatgpt:none"));
        assert_eq!(a.route("limits:problem", &[json!("chatgpt:none")]).await.unwrap(), Value::Null);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chatgpt_token_expires_with_its_jwt() {
        // {"exp":2000000000}
        let t = json!({ "provider": "chatgpt", "accessToken": "h.eyJleHAiOjIwMDAwMDAwMDB9.s" });
        assert_eq!(token_expires_at(&t), Some(2_000_000_000_000.0));
        assert_eq!(token_expires_at(&json!({ "provider": "claude", "accessToken": "x" })), None);
        assert_eq!(token_expires_at(&json!({ "expiresAt": 5 })), Some(5.0));
    }

    #[test]
    fn turn_lines_are_the_hosts() {
        let dir = temp_dir("lines");
        let a = Accounts::new(dir.clone(), Hub::new());
        let account = TurnAccount::from_facts(&json!({ "account": { "auth": "apikey", "kind": "llamacpp" } }));
        let opts = json!({ "sessionId": "s", "providerId": "p", "modelId": "m" });
        a.turn_usage(&opts, &account, &json!({ "type": "usage", "inputTokens": 1, "outputTokens": 2 }));
        let line = std::fs::read_to_string(dir.join("usage.jsonl")).unwrap();
        let tail = r#","providerId":"p","modelId":"m","inputTokens":1,"outputTokens":2,"sessionId":"s","auth":"apikey","local":true}"#;
        assert!(line.starts_with(r#"{"ts":"#) && line.ends_with(&format!("{tail}\n")), "{line}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
