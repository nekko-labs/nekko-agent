//! The pure half of `packages/host/src/limits.ts`: rate-limit headers, the
//! providers' usage answers, window naming, merging and order, Retry-After,
//! how a failed read is classified, and the backoff after it. The stateful
//! service (the snapshot store, throttled polls, problems) is nekkod's
//! `limits.rs`.

use crate::{get, js_round, num, parse_float};
use serde_json::{Map, Value, json};

/// How long a header snapshot stays fresh.
pub const HEADER_STALE_MS: f64 = 60_000.0;
/// How long a polled snapshot stays fresh.
pub const POLL_STALE_MS: f64 = 35_000.0;
const BACKOFF_BASE_MS: f64 = 60_000.0;
const BACKOFF_MAX_MS: f64 = 30.0 * 60_000.0;

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

/// `primary` -> `Primary`, `five_hour` -> `Five Hour`.
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

fn snapshot(windows: Vec<Value>, extra: Map<String, Value>, now: f64, stale: f64) -> Value {
    let mut o = Map::new();
    o.insert("windows".into(), Value::Array(windows));
    o.extend(extra);
    o.insert("updatedAt".into(), num(now));
    o.insert("staleAfterMs".into(), num(stale));
    Value::Object(o)
}

/// The Messages API's per-key rate limits: (header family, window id, label).
/// `tokens` is the most restrictive token limit in force, so it only counts
/// when the response carries neither of the split token limits.
const API_RATE_LIMITS: &[(&str, &str, &str)] = &[
    ("requests", "rpm", "Requests per minute"),
    ("input-tokens", "itpm", "Input tokens per minute"),
    ("output-tokens", "otpm", "Output tokens per minute"),
    ("tokens", "tpm", "Tokens per minute"),
];

/// Used share at which an API rate-limit window reads as a warning.
const API_WARNING_PERCENT: f64 = 80.0;

/// The standard `anthropic-ratelimit-<family>-{limit,remaining,reset}` headers
/// an API-key response carries, as one short window per family. These are the
/// key's own limits, not a subscription plan's. The reset is an RFC 3339 time.
pub fn parse_anthropic_api_headers(pairs: &[(String, String)], now: f64) -> Value {
    let header = |name: &str| {
        pairs
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    };
    let split_tokens =
        ["input-tokens", "output-tokens"].iter().any(|f| header(&format!("anthropic-ratelimit-{f}-limit")).is_some());
    let mut windows = Vec::new();
    for (family, id, label) in API_RATE_LIMITS {
        if *family == "tokens" && split_tokens {
            continue;
        }
        let limit = header(&format!("anthropic-ratelimit-{family}-limit")).map_or(f64::NAN, parse_float);
        let remaining = header(&format!("anthropic-ratelimit-{family}-remaining")).map_or(f64::NAN, parse_float);
        if !(limit.is_finite() && limit > 0.0 && remaining.is_finite()) {
            continue;
        }
        let used = clamp_percent((limit - remaining) / limit * 100.0);
        let reset_at = header(&format!("anthropic-ratelimit-{family}-reset"))
            .map(crate::date::parse)
            .filter(|t| t.is_finite())
            .unwrap_or(0.0);
        let status = if remaining <= 0.0 {
            "rate_limited"
        } else if used >= API_WARNING_PERCENT {
            "warning"
        } else {
            "allowed"
        };
        let mut desc = Map::new();
        desc.insert("id".into(), json!(id));
        desc.insert("label".into(), json!(label));
        desc.insert("scope".into(), json!("session"));
        windows.push(window(desc, used, reset_at, status));
    }
    snapshot(windows, Map::new(), now, HEADER_STALE_MS)
}

/// `String(x ?? '')` then `parseFloat`, for a number the provider may send as text.
fn loose_number(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        None | Some(Value::Null) => f64::NAN,
        Some(other) => parse_float(&nekko_js::display(other)),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn api_headers_become_per_minute_windows() {
        let got = parse_anthropic_api_headers(
            &pairs(&[
                ("Anthropic-Ratelimit-Requests-Limit", "50"),
                ("anthropic-ratelimit-requests-remaining", "49"),
                ("anthropic-ratelimit-requests-reset", "2026-10-19T12:00:30Z"),
                ("anthropic-ratelimit-input-tokens-limit", "30000"),
                ("anthropic-ratelimit-input-tokens-remaining", "3000"),
                ("anthropic-ratelimit-output-tokens-limit", "8000"),
                ("anthropic-ratelimit-output-tokens-remaining", "0"),
                ("anthropic-ratelimit-tokens-limit", "38000"),
                ("anthropic-ratelimit-tokens-remaining", "3000"),
            ]),
            1.0,
        );
        let windows = got["windows"].as_array().unwrap();
        let ids: Vec<&str> = windows.iter().map(|w| w["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["rpm", "itpm", "otpm"], "the combined tokens limit is skipped when split limits exist");
        assert_eq!(windows[0]["usedPercent"], num(2.0));
        assert_eq!(windows[0]["status"], "allowed");
        assert_eq!(windows[0]["resetAt"], num(crate::date::parse("2026-10-19T12:00:30Z")));
        assert_eq!(windows[1]["status"], "warning");
        assert_eq!(windows[2]["status"], "rate_limited");
        assert_eq!(windows[2]["resetAt"], num(0.0));
        assert_eq!(got["staleAfterMs"], num(HEADER_STALE_MS));
    }

    #[test]
    fn combined_tokens_limit_counts_alone_and_bad_values_are_dropped() {
        let got = parse_anthropic_api_headers(
            &pairs(&[
                ("anthropic-ratelimit-tokens-limit", "1000"),
                ("anthropic-ratelimit-tokens-remaining", "250"),
                ("anthropic-ratelimit-requests-limit", "0"),
                ("anthropic-ratelimit-requests-remaining", "0"),
            ]),
            1.0,
        );
        let windows = got["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["id"], "tpm");
        assert_eq!(windows[0]["usedPercent"], num(75.0));
    }
}
