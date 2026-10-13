//! The pure half of `packages/host/src/limits.ts`: rate-limit headers, the
//! providers' usage answers, window naming, merging and order, Retry-After,
//! how a failed read is classified, and the backoff after it. The stateful
//! service (the snapshot store, throttled polls, problems) is nekkod's
//! `limits.rs`.

use crate::{get, js_entries, js_round, locale_compare, num, parse_float, parse_int10};
use serde_json::{Map, Value, json};

/// How long a header snapshot stays fresh.
pub const HEADER_STALE_MS: f64 = 60_000.0;
/// How long a polled snapshot stays fresh.
pub const POLL_STALE_MS: f64 = 35_000.0;
const BACKOFF_BASE_MS: f64 = 60_000.0;
const BACKOFF_MAX_MS: f64 = 30.0 * 60_000.0;
const ANTHROPIC_PREFIX: &str = "anthropic-ratelimit-unified-";

/// A failed quota read, as `LimitsReadError` carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct LimitsError {
    /// `signed_out`, `auth_expired`, `rate_limited`, `http`, `network` or `unreadable`.
    pub kind: &'static str,
    pub status: Option<u16>,
    pub retry_after_ms: Option<f64>,
}

impl LimitsError {
    pub fn new(kind: &'static str, status: Option<u16>) -> Self {
        Self { kind, status, retry_after_ms: None }
    }
}

/// What failed, for `classify_limits_error`: a typed read error, or anything
/// else thrown (a token refresh, the network) by its message.
#[derive(Clone, Debug)]
pub enum Problem {
    Read(LimitsError),
    Message(String),
}

/// `classifyLimitsError(e)`.
pub fn classify_limits_error(e: &Problem) -> LimitsError {
    match e {
        Problem::Read(r) => r.clone(),
        Problem::Message(m) => {
            let m = m.to_lowercase();
            let any = |words: &[&str]| words.iter().any(|w| m.contains(w));
            let kind = if any(&["sign in again", "session expired", "no refresh token", "invalid_grant", "revoked"]) {
                "auth_expired"
            } else if m.contains("no subscription token found") {
                "signed_out"
            } else if m.contains("token refresh failed") {
                "http"
            } else {
                "network"
            };
            LimitsError::new(kind, None)
        }
    }
}

/// `limitsBackoffMs(failures, retryAfterMs)`.
pub fn limits_backoff_ms(failures: f64, retry_after_ms: Option<f64>) -> f64 {
    let exp = BACKOFF_MAX_MS.min(BACKOFF_BASE_MS * 2f64.powf((failures - 1.0).max(0.0)));
    exp.max(retry_after_ms.unwrap_or(0.0))
}

/// `parseRetryAfter(value, now)`: delta seconds or an HTTP date, in ms from now.
pub fn parse_retry_after(value: Option<&str>, now: f64) -> Option<f64> {
    let value = value.filter(|v| !v.is_empty())?;
    let secs = nekko_js::string_to_number(value);
    if secs.is_finite() && secs >= 0.0 {
        return Some(secs * 1000.0);
    }
    let date = crate::date::parse(value);
    date.is_finite().then(|| (date - now).max(0.0))
}

/// The two plan-wide periods, in both spellings (`5h` on the headers,
/// `five_hour` in the usage JSON).
const PERIODS: &[(&str, &str, &str, &str, &str)] =
    &[("5h", "5h", "five_hour", "5-hour", "session"), ("7d", "7d", "seven_day", "7-day", "weekly")];

/// `fable` -> `Fable`, `claude_next` -> `Claude Next`.
fn title_case(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `describeAnthropicWindow(period, family)`: `{ id, label, scope }`, with
/// `modelFamily` for a per-model window.
pub fn describe_anthropic_window(period: &str, family: Option<&str>) -> Map<String, Value> {
    let known = PERIODS.iter().find(|p| p.0 == period);
    let label = known.map_or(period, |p| p.3);
    let mut o = Map::new();
    match family.filter(|f| !f.is_empty()) {
        None => {
            o.insert("id".into(), json!(period));
            o.insert("label".into(), json!(label));
            o.insert("scope".into(), json!(known.map_or("weekly", |p| p.4)));
        }
        Some(f) => {
            o.insert("id".into(), json!(format!("{period}_{f}")));
            o.insert("label".into(), json!(format!("{label} {}", title_case(f))));
            o.insert("scope".into(), json!("model"));
            o.insert("modelFamily".into(), json!(f));
        }
    }
    o
}

/// `splitAnthropicWindow(name)`.
fn split_window(name: &str) -> Option<(String, Option<String>)> {
    for p in PERIODS {
        for spelling in [p.1, p.2] {
            if name == spelling {
                return Some((p.0.into(), None));
            }
            if let Some(rest) = name.strip_prefix(spelling).and_then(|r| r.strip_prefix('_')) {
                return Some((p.0.into(), Some(rest.into())));
            }
        }
    }
    (!name.is_empty()).then(|| (name.to_string(), None))
}

/// `normalizeStatus(value)`.
fn normalize_status(value: Option<&str>) -> &'static str {
    match value.map(str::to_lowercase).as_deref() {
        Some("rate_limited" | "rejected") => "rate_limited",
        Some("warning" | "allowed_warning") => "warning",
        _ => "allowed",
    }
}

/// `clampPercent(value)`: 0-100, two decimals, `NaN` kept.
fn clamp_percent(value: f64) -> f64 {
    // `clamp` keeps NaN, as Math.min/Math.max do.
    (js_round(value * 100.0) / 100.0).clamp(0.0, 100.0)
}

fn window(desc: Map<String, Value>, used: f64, reset_at: f64, status: &str) -> Value {
    let mut w = desc;
    w.insert("usedPercent".into(), num(used));
    w.insert("resetAt".into(), num(reset_at));
    w.insert("status".into(), json!(status));
    Value::Object(w)
}

fn rank(w: &Value) -> u8 {
    match get(w, "scope").and_then(Value::as_str) {
        Some("session") => 0,
        Some("weekly") => 1,
        _ => 2,
    }
}

/// `sortWindows(windows)`: plan-wide windows first, then by label.
pub fn sort_windows(mut windows: Vec<Value>) -> Vec<Value> {
    let label = |w: &Value| get(w, "label").map(nekko_js::display).unwrap_or_default();
    windows.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| locale_compare(&label(a), &label(b))));
    windows
}

/// `mergeWindows(previous, fresh)`: a fresh window replaces its namesake in
/// place, and windows the fresh list is silent about survive.
pub fn merge_windows(previous: &[Value], fresh: &[Value]) -> Vec<Value> {
    let mut by_id: Vec<(String, Value)> = Vec::new();
    for w in previous.iter().chain(fresh) {
        let id = crate::key_of(get(w, "id"));
        match by_id.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = w.clone(),
            None => by_id.push((id, w.clone())),
        }
    }
    sort_windows(by_id.into_iter().map(|(_, w)| w).collect())
}

fn snapshot(windows: Vec<Value>, extra: Map<String, Value>, now: f64, stale: f64) -> Value {
    let mut o = Map::new();
    o.insert("windows".into(), Value::Array(windows));
    o.extend(extra);
    o.insert("updatedAt".into(), num(now));
    o.insert("staleAfterMs".into(), num(stale));
    Value::Object(o)
}

/// `parseAnthropicHeaders(headers)` over the response's header pairs, in the
/// order a `Map` of their lower-cased names keeps them.
pub fn parse_anthropic_headers(pairs: &[(String, String)], now: f64) -> Value {
    let mut map: Vec<(String, String)> = Vec::new();
    for (k, v) in pairs {
        let k = k.to_lowercase();
        match map.iter_mut().find(|(n, _)| *n == k) {
            Some(slot) => slot.1 = v.clone(),
            None => map.push((k, v.clone())),
        }
    }
    let header = |name: &str| map.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let mut windows = Vec::new();
    for (key, util) in &map {
        const SUFFIX: &str = "-utilization";
        if !key.starts_with(ANTHROPIC_PREFIX) || !key.ends_with(SUFFIX) {
            continue;
        }
        let (start, end) = (ANTHROPIC_PREFIX.len(), key.len() - SUFFIX.len());
        let name = if end > start { &key[start..end] } else { "" };
        let Some((period, family)) = split_window(name) else { continue };
        let utilization = parse_float(util);
        if !utilization.is_finite() {
            continue;
        }
        let reset_at = match header(&format!("{ANTHROPIC_PREFIX}{name}-reset")) {
            Some(r) if !r.is_empty() => parse_int10(r) * 1000.0,
            _ => 0.0,
        };
        let status = normalize_status(Some(header(&format!("{ANTHROPIC_PREFIX}{name}-status")).unwrap_or("allowed")));
        windows.push(window(
            describe_anthropic_window(&period, family.as_deref()),
            clamp_percent(utilization * 100.0),
            reset_at,
            status,
        ));
    }
    snapshot(sort_windows(windows), Map::new(), now, HEADER_STALE_MS)
}

/// `String(x ?? '')` then `parseFloat`, for a number the provider may send as text.
fn loose_number(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        None | Some(Value::Null) => f64::NAN,
        Some(other) => parse_float(&nekko_js::display(other)),
    }
}

/// `parseAnthropicCredits(json)`.
fn anthropic_credits(json: &Map<String, Value>) -> Map<String, Value> {
    let mut o = Map::new();
    let state = |o: &mut Map<String, Value>, s: &str| {
        o.insert("creditsState".into(), json!(s));
    };
    let Some(extra) = json.get("extra_usage").filter(|e| e.is_object() || e.is_array()) else {
        state(&mut o, "unknown");
        return o;
    };
    if get(extra, "is_enabled") == Some(&Value::Bool(false)) {
        state(&mut o, "disabled");
        return o;
    }
    let limit = nekko_js::to_number(get(extra, "monthly_limit"));
    let used = nekko_js::to_number(get(extra, "used_credits"));
    if !limit.is_finite() {
        state(&mut o, "unknown");
        return o;
    }
    let spent = if used.is_finite() { used } else { 0.0 };
    o.insert("creditsBalance".into(), num((limit - spent).max(0.0)));
    state(&mut o, "balance");
    o
}

/// `parseAnthropicUsageJson(json)` (`GET /api/oauth/usage`, whole percent).
pub fn parse_anthropic_usage_json(json: &Map<String, Value>, now: f64) -> Value {
    let mut windows = Vec::new();
    for (key, win) in js_entries(json) {
        if !(win.is_object() || win.is_array()) {
            continue;
        }
        let Some((period, family)) = split_window(key) else { continue };
        let Some(util) = get(win, "utilization") else { continue };
        let utilization = loose_number(Some(util));
        if !utilization.is_finite() {
            continue;
        }
        let used = clamp_percent(utilization);
        let resets = match get(win, "resets_at") {
            Some(Value::String(s)) => crate::date::parse(s),
            _ => 0.0,
        };
        let reported = normalize_status(get(win, "status").and_then(Value::as_str));
        let status = if reported == "rate_limited" || used >= 100.0 {
            "rate_limited"
        } else if reported == "warning" || used >= 80.0 {
            "warning"
        } else {
            "allowed"
        };
        windows.push(window(
            describe_anthropic_window(&period, family.as_deref()),
            used,
            if resets > 0.0 { resets } else { 0.0 },
            status,
        ));
    }
    snapshot(sort_windows(windows), anthropic_credits(json), now, POLL_STALE_MS)
}

/// `describeChatGptWindow(key, duration)`: WHAM slots are not periods.
fn describe_chatgpt_window(primary: bool, duration: Option<&Value>) -> Map<String, Value> {
    let slot = if primary { "primary" } else { "secondary" };
    let mut o = Map::new();
    let d =
        duration.and_then(Value::as_f64).filter(|d| d.fract() == 0.0 && d.abs() <= 9_007_199_254_740_991.0 && *d > 0.0);
    let Some(d) = d else {
        o.insert("id".into(), json!(slot));
        o.insert("label".into(), json!(format!("{} usage", title_case(slot))));
        o.insert("scope".into(), json!("session"));
        return o;
    };
    let (id, label, scope) = if d == 18_000.0 {
        ("5h".to_string(), "5-hour".to_string(), "session")
    } else if d == 604_800.0 {
        ("7d".to_string(), "7-day".to_string(), "weekly")
    } else {
        let units = [(86_400.0, "d", "day"), (3_600.0, "h", "hour"), (60.0, "m", "minute"), (1.0, "s", "second")];
        let (secs, suffix, name) = units.into_iter().find(|u| d % u.0 == 0.0).unwrap_or((1.0, "s", "second"));
        let count = nekko_js::number_to_string(d / secs);
        (format!("{count}{suffix}"), format!("{count}-{name}"), if d >= 604_800.0 { "weekly" } else { "session" })
    };
    o.insert("id".into(), json!(id));
    o.insert("label".into(), json!(label));
    o.insert("scope".into(), json!(scope));
    o
}

/// `parseChatGptUsage(json)` (`GET /wham/usage`).
pub fn parse_chatgpt_usage(json: &Map<String, Value>, now: f64) -> Value {
    let mut windows = Vec::new();
    let rate_limit = json.get("rate_limit");
    let plan_type = json.get("plan_type").and_then(Value::as_str);
    let mut balance: Option<f64> = None;
    let mut state = "unknown";
    if let Some(credits) = json.get("credits").filter(|c| nekko_js::truthy(Some(c))) {
        if get(credits, "unlimited") == Some(&Value::Bool(true)) {
            state = "unlimited";
        } else if let Some(b @ (Value::String(_) | Value::Number(_))) = get(credits, "balance") {
            let v = parse_float(&nekko_js::display(b));
            if v.is_finite() {
                balance = Some(v);
                state = "balance";
            }
        }
    }
    if let Some(rl) = rate_limit.filter(|r| nekko_js::truthy(Some(r))) {
        let allowed = get(rl, "allowed") == Some(&Value::Bool(true));
        let reached = get(rl, "limit_reached") == Some(&Value::Bool(true));
        for (primary, key) in [(true, "primary_window"), (false, "secondary_window")] {
            let Some(win) = get(rl, key).filter(|w| nekko_js::truthy(Some(w))) else { continue };
            let used = loose_number(get(win, "used_percent"));
            if !used.is_finite() {
                continue;
            }
            let reset_at = match get(win, "reset_at") {
                Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN) * 1000.0,
                _ => 0.0,
            };
            let status = if !allowed || reached {
                "rate_limited"
            } else if used >= 80.0 {
                "warning"
            } else {
                "allowed"
            };
            windows.push(window(
                describe_chatgpt_window(primary, get(win, "limit_window_seconds")),
                clamp_percent(used),
                reset_at,
                status,
            ));
        }
    }
    let mut extra = Map::new();
    if let Some(p) = plan_type {
        extra.insert("planType".into(), json!(p));
    }
    if let Some(b) = balance {
        extra.insert("creditsBalance".into(), num(b));
    }
    extra.insert("creditsState".into(), json!(state));
    snapshot(windows, extra, now, POLL_STALE_MS)
}

/// The next UTC midnight after `now` (`setUTCHours(24, 0, 0, 0)`).
fn next_utc_midnight(now: f64) -> f64 {
    const DAY: f64 = 86_400_000.0;
    (now / DAY).floor() * DAY + DAY
}

/// `parseOpenRouterKey(body, status)` (`GET /key`): a body without `data` is unreadable.
pub fn parse_openrouter_key(body: Option<&Value>, status: u16, now: f64) -> Result<Value, LimitsError> {
    let data = body
        .and_then(|b| get(b, "data"))
        .filter(|d| nekko_js::truthy(Some(d)))
        .ok_or(LimitsError::new("unreadable", Some(status)))?;
    let mut windows = Vec::new();
    if let Some(free) = get(data, "free_model_daily_requests").filter(|f| nekko_js::truthy(Some(f)))
        && let Some(limit) = get(free, "limit").and_then(Value::as_f64).filter(|l| *l > 0.0)
    {
        let used = match get(free, "used") {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            _ => {
                let remaining = match get(free, "remaining") {
                    None | Some(Value::Null) => limit,
                    other => nekko_js::to_number(other),
                };
                limit - remaining
            }
        };
        let used_percent = clamp_percent((used / limit) * 100.0);
        let status = if used_percent >= 100.0 {
            "rate_limited"
        } else if used_percent >= 80.0 {
            "warning"
        } else {
            "allowed"
        };
        let mut desc = Map::new();
        desc.insert("id".into(), json!("free_daily"));
        desc.insert("label".into(), json!("Free-model requests"));
        desc.insert("scope".into(), json!("session"));
        windows.push(window(desc, used_percent, next_utc_midnight(now), status));
    }
    let limit = get(data, "limit").and_then(Value::as_f64);
    let remaining = match get(data, "limit_remaining") {
        Some(Value::Number(n)) => n.as_f64(),
        _ => match (limit, get(data, "usage").and_then(Value::as_f64)) {
            (Some(l), Some(u)) => Some((l - u).max(0.0)),
            _ => None,
        },
    };
    let mut extra = Map::new();
    if get(data, "is_free_tier") == Some(&Value::Bool(true)) {
        extra.insert("planType".into(), json!("free tier"));
    }
    if let Some(r) = remaining {
        extra.insert("creditsBalance".into(), num(r));
    }
    extra.insert("creditsState".into(), json!(if limit.is_none() { "unlimited" } else { "balance" }));
    Ok(snapshot(windows, extra, now, POLL_STALE_MS))
}
