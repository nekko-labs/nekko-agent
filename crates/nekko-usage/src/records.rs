//! The log lines: `turnUsageRecord` and `turnReplyRecord`
//! (`packages/host/src/usage-records.ts`) and `quotaHistoryRecord`
//! (`quota-history.ts`). Each returns the object in the TS key order, so
//! `nekko_js::stringify` of it is the line the TS host appends.

use crate::get;
use crate::summary::LOCAL_PROVIDER_KINDS;
use serde_json::{Map, Value, json};

/// Copy `from[key]` to `to[key]` when it is not `undefined`.
fn copy(to: &mut Map<String, Value>, key: &str, from: Option<&Value>) {
    if let Some(v) = from {
        to.insert(key.into(), v.clone());
    }
}

/// `turnUsageRecord(opts, provider, event, ts)`.
pub fn turn_usage_record(opts: &Value, provider: &Value, event: &Value, ts: u64) -> Value {
    let mut o = Map::new();
    o.insert("ts".into(), json!(ts));
    copy(&mut o, "providerId", get(opts, "providerId"));
    copy(&mut o, "modelId", get(opts, "modelId"));
    for k in ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"] {
        copy(&mut o, k, get(event, k));
    }
    copy(&mut o, "sessionId", get(opts, "sessionId"));
    copy(&mut o, "auth", get(provider, "auth"));
    let kind = get(provider, "kind").and_then(Value::as_str);
    o.insert("local".into(), Value::Bool(kind.is_some_and(|k| LOCAL_PROVIDER_KINDS.contains(&k))));
    Value::Object(o)
}

/// `sideUsageRecord(provider, modelId, sessionId, item, ts)`: one usage item
/// of a side call (the chat title).
pub fn side_usage_record(
    provider: &Value,
    model_id: Option<&Value>,
    session_id: Option<&Value>,
    item: &Value,
    ts: u64,
) -> Value {
    let or = |v: Option<&Value>, d: Value| v.filter(|x| !x.is_null()).cloned().unwrap_or(d);
    let mut o = Map::new();
    o.insert("ts".into(), json!(ts));
    o.insert("providerId".into(), or(get(provider, "id"), json!("")));
    o.insert("modelId".into(), or(model_id, json!("")));
    o.insert("sessionId".into(), or(session_id, json!("")));
    o.insert("inputTokens".into(), or(get(item, "inputTokens"), json!(0)));
    o.insert("outputTokens".into(), or(get(item, "outputTokens"), json!(0)));
    copy(&mut o, "cacheReadTokens", get(item, "cacheReadTokens"));
    copy(&mut o, "cacheWriteTokens", get(item, "cacheWriteTokens"));
    copy(&mut o, "auth", get(provider, "auth"));
    let kind = get(provider, "kind").and_then(Value::as_str);
    o.insert("local".into(), Value::Bool(kind.is_some_and(|k| LOCAL_PROVIDER_KINDS.contains(&k))));
    Value::Object(o)
}

/// `turnReplyRecord(opts, incognito, startedAt, event, finished, ts)`: `None`
/// when nothing is logged (no stop, or an incognito chat).
pub fn turn_reply_record(
    opts: &Value,
    incognito: bool,
    started_at: u64,
    event: &Value,
    finished: Option<&Value>,
    ts: u64,
) -> Option<Value> {
    if !nekko_js::truthy(get(event, "stop")) || incognito {
        return None;
    }
    let mut o = Map::new();
    o.insert("ts".into(), json!(ts));
    o.insert("startedAt".into(), json!(started_at));
    copy(&mut o, "sessionId", get(opts, "sessionId"));
    copy(&mut o, "providerId", get(opts, "providerId"));
    copy(&mut o, "modelId", get(opts, "modelId"));
    let steps = get(event, "steps").filter(|v| !v.is_null()).cloned().unwrap_or(json!(0));
    o.insert("steps".into(), steps);
    copy(&mut o, "stop", get(event, "stop"));
    if let Some(f) = finished.filter(|f| nekko_js::truthy(Some(f))) {
        for k in ["effort", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "outputMs", "wallMs"]
        {
            copy(&mut o, k, get(f, k));
        }
    }
    Some(Value::Object(o))
}

/// `quotaHistoryRecord(providers, tokenKey, source, limits)`: `None` for a key
/// no configured provider owns.
pub fn quota_history_record(providers: &[Value], token_key: &str, source: &str, limits: &Value) -> Option<Value> {
    let key = json!(token_key);
    let provider = providers.iter().find(|p| crate::strict_eq(get(p, "tokenKey"), Some(&key))).or_else(|| {
        providers.iter().find(|p| {
            token_key == format!("provider:{}", crate::key_of(get(p, "id"))) && nekko_js::truthy(get(p, "enabled"))
        })
    })?;
    let mut o = Map::new();
    copy(&mut o, "timestamp", get(limits, "updatedAt"));
    copy(&mut o, "providerId", get(provider, "id"));
    o.insert("source".into(), json!(source));
    let windows: Vec<Value> = get(limits, "windows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|w| {
            let mut m = Map::new();
            copy(&mut m, "id", get(w, "id"));
            copy(&mut m, "scope", get(w, "scope"));
            copy(&mut m, "usedPercent", get(w, "usedPercent"));
            copy(&mut m, "resetsAt", get(w, "resetAt"));
            copy(&mut m, "status", get(w, "status"));
            Value::Object(m)
        })
        .collect();
    o.insert("windows".into(), Value::Array(windows));
    Some(Value::Object(o))
}
