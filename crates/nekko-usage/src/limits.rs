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

/// How long Claude plan usage from Claude Code's stream stays fresh: it only
/// moves when the chat makes a model call.
pub const CLAUDE_CODE_STALE_MS: f64 = 5.0 * 60_000.0;

/// A Claude limit kind as a window: `five_hour` is the session, `seven_day`
/// the week, a model scope (`Opus`) narrows the window to that family.
fn describe_claude_window(kind: &str, model: Option<&str>) -> Map<String, Value> {
    let (id, label, scope) = match kind {
        "five_hour" => ("session".to_string(), "Current session".to_string(), "session"),
        "seven_day" => ("weekly".to_string(), "This week".to_string(), "weekly"),
        other => (other.replace('_', "-"), title_case(other), "weekly"),
    };
    let mut d = Map::new();
    match model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => {
            let family = m.split_whitespace().next().unwrap_or(m).to_lowercase();
            d.insert("id".into(), json!(format!("{id}-{family}")));
            d.insert("label".into(), json!(format!("{label} ({m})")));
            d.insert("scope".into(), json!("model"));
            d.insert("modelFamily".into(), json!(family));
        }
        None => {
            d.insert("id".into(), json!(id));
            d.insert("label".into(), json!(label));
            d.insert("scope".into(), json!(scope));
        }
    }
    d
}

/// Claude plan usage from the user's own Claude Code, out of its documented
/// stream-json: a `rate_limit_event` (one window, merged into `prev`) or an
/// assistant message's `usage_report` from `/usage` (every window, replacing
/// `prev`). Anything else is `None`. Never a credential or a plan endpoint:
/// only what the unmodified binary printed for this chat.
pub fn parse_claude_code_usage(event: &Value, prev: Option<&Value>, now: f64) -> Option<Value> {
    if get(event, "type").and_then(Value::as_str) == Some("rate_limit_event") {
        let info = get(event, "rate_limit_info")?;
        let status = match get(info, "status").and_then(Value::as_str) {
            Some("rejected") => "rate_limited",
            Some("allowed_warning") => "warning",
            Some("allowed") => "allowed",
            _ => return None,
        };
        // shortcut: the docs leave utilization's scale unstated; Claude Code reads it from the unified
        // headers, which report a fraction (TASKS.md, "the 6200% limits chip"). Above 1 reads as percent;
        // confirm against a live plan-signed-in run and drop the guess.
        let mut used = loose_number(get(info, "utilization"));
        if used.is_finite() && used <= 1.0 {
            used *= 100.0;
        }
        if !used.is_finite() {
            if status != "rate_limited" {
                return None;
            }
            used = 100.0;
        }
        let resets = loose_number(get(info, "resetsAt"));
        // Seconds, as the unified headers give it; milliseconds pass through.
        let reset_at = if !resets.is_finite() {
            0.0
        } else if resets < 1e12 {
            resets * 1000.0
        } else {
            resets
        };
        // `rateLimitType` is not in the docs yet; without it the event is the session window.
        let kind = get(info, "rateLimitType").and_then(Value::as_str).unwrap_or("five_hour");
        let w = window(describe_claude_window(kind, None), clamp_percent(used), reset_at, status);
        let mut windows: Vec<Value> = prev
            .and_then(|p| get(p, "windows"))
            .and_then(Value::as_array)
            .map(|ws| ws.iter().filter(|o| get(o, "id") != get(&w, "id")).cloned().collect())
            .unwrap_or_default();
        windows.push(w);
        let mut extra = Map::new();
        let credits = prev.and_then(|p| get(p, "creditsState")).cloned().unwrap_or(json!("unknown"));
        extra.insert("creditsState".into(), credits);
        if let Some(b) = prev.and_then(|p| get(p, "creditsBalance")) {
            extra.insert("creditsBalance".into(), b.clone());
        }
        return Some(snapshot(windows, extra, now, CLAUDE_CODE_STALE_MS));
    }
    let limits = event.pointer("/usage_report/rate_limits").filter(|l| l.is_object())?;
    let mut windows = Vec::new();
    for l in get(limits, "limits").and_then(Value::as_array).into_iter().flatten() {
        if get(l, "is_active") == Some(&Value::Bool(false)) {
            continue;
        }
        let used = loose_number(get(l, "percent"));
        let Some(kind) = get(l, "kind").and_then(Value::as_str).filter(|_| used.is_finite()) else { continue };
        let reset_at = get(l, "resets_at").and_then(Value::as_str).map(crate::date::parse).filter(|r| r.is_finite());
        let status = match get(l, "severity").and_then(Value::as_str) {
            _ if used >= 100.0 => "rate_limited",
            Some("critical" | "exceeded" | "rejected" | "error") => "rate_limited",
            Some("warning" | "high") => "warning",
            _ => "allowed",
        };
        let model = l.pointer("/scope/model/display_name").and_then(Value::as_str);
        windows.push(window(describe_claude_window(kind, model), clamp_percent(used), reset_at.unwrap_or(0.0), status));
    }
    let mut extra = Map::new();
    let state = match get(limits, "extra_usage") {
        Some(x) if get(x, "is_enabled") == Some(&Value::Bool(false)) => "disabled",
        Some(x) => {
            let (cap, spent) = (loose_number(get(x, "monthly_limit")), loose_number(get(x, "used_credits")));
            if cap.is_finite() && spent.is_finite() {
                extra.insert("creditsBalance".into(), num((cap - spent).max(0.0)));
                "balance"
            } else {
                "unknown"
            }
        }
        None => "unknown",
    };
    extra.insert("creditsState".into(), json!(state));
    Some(snapshot(windows, extra, now, CLAUDE_CODE_STALE_MS))
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

    #[test]
    fn claude_code_usage_report_becomes_every_window() {
        let event = json!({ "type": "assistant", "usage_report": { "rate_limits": {
            "limits": [
                { "kind": "five_hour", "group": "g", "percent": 42, "resets_at": "2026-10-23T15:00:00Z", "severity": "normal", "is_active": true },
                { "kind": "seven_day", "group": "g", "percent": 81, "resets_at": "2026-10-27T00:00:00Z",
                  "scope": { "model": { "display_name": "Opus" } }, "severity": "warning", "is_active": true },
                { "kind": "seven_day", "group": "g", "percent": 5, "resets_at": null, "severity": "normal", "is_active": false }
            ],
            "extra_usage": { "is_enabled": true, "monthly_limit": 50, "used_credits": 12, "utilization": 0.24 }
        } } });
        let got = parse_claude_code_usage(&event, None, 1000.0).unwrap();
        let windows = got["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2, "the inactive limit is left out");
        assert_eq!(windows[0]["id"], "session");
        assert_eq!(windows[0]["label"], "Current session");
        assert_eq!(windows[0]["usedPercent"], num(42.0));
        assert_eq!(windows[0]["resetAt"], num(crate::date::parse("2026-10-23T15:00:00Z")));
        assert_eq!(windows[1]["id"], "weekly-opus");
        assert_eq!(windows[1]["scope"], "model");
        assert_eq!(windows[1]["modelFamily"], "opus");
        assert_eq!(windows[1]["label"], "This week (Opus)");
        assert_eq!(windows[1]["status"], "warning");
        assert_eq!(got["creditsState"], "balance");
        assert_eq!(got["creditsBalance"], num(38.0));
        assert_eq!(got["staleAfterMs"], num(CLAUDE_CODE_STALE_MS));
    }

    #[test]
    fn claude_code_rate_limit_event_merges_one_window() {
        let report = json!({ "usage_report": { "rate_limits": { "limits": [
            { "kind": "five_hour", "percent": 10, "resets_at": "2026-10-23T15:00:00Z", "severity": "normal", "is_active": true },
            { "kind": "seven_day", "percent": 30, "resets_at": "2026-10-27T00:00:00Z", "severity": "normal", "is_active": true }
        ], "extra_usage": { "is_enabled": false } } } });
        let prev = parse_claude_code_usage(&report, None, 1000.0).unwrap();
        let event = json!({ "type": "rate_limit_event", "rate_limit_info": {
            "status": "allowed_warning", "resetsAt": 1_761_231_600, "utilization": 0.62
        } });
        let got = parse_claude_code_usage(&event, Some(&prev), 2000.0).unwrap();
        let windows = got["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2, "the session window is replaced, the week kept");
        assert_eq!(windows[0]["id"], "weekly");
        assert_eq!(windows[1]["id"], "session");
        assert_eq!(windows[1]["usedPercent"], num(62.0), "a fraction reads as percent");
        assert_eq!(windows[1]["resetAt"], num(1_761_231_600_000.0), "seconds become ms");
        assert_eq!(windows[1]["status"], "warning");
        assert_eq!(got["creditsState"], "disabled", "credits carry over from the report");

        let rejected = json!({ "type": "rate_limit_event", "rate_limit_info": {
            "status": "rejected", "rateLimitType": "seven_day", "errorCode": "credits_required"
        } });
        let got = parse_claude_code_usage(&rejected, None, 3000.0).unwrap();
        assert_eq!(got["windows"][0]["id"], "weekly");
        assert_eq!(got["windows"][0]["usedPercent"], num(100.0));
        assert_eq!(got["windows"][0]["status"], "rate_limited");

        let quiet = json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "allowed" } });
        assert_eq!(parse_claude_code_usage(&quiet, None, 0.0), None, "nothing to show without a number");
        assert_eq!(parse_claude_code_usage(&json!({ "type": "assistant" }), None, 0.0), None);
    }
}
