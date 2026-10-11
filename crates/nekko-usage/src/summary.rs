//! `usageSummary()` (`packages/host/src/usage.ts`) and `summarizeReplies` /
//! `replyStats` (`replies.ts`), over the same files the TS host reads.

use crate::pricing::{Tokens, estimate_cost};
use crate::{get, js_order, key_of, num, or_zero, strict_eq};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::Path;

/// `DEFAULT_LOCAL_COST_BENCHMARK`.
pub const DEFAULT_LOCAL_COST_BENCHMARK: &str = "qwen3-32b";

/// `LOCAL_PROVIDER_KINDS`: what `isLocalProvider` accepts.
pub const LOCAL_PROVIDER_KINDS: &[&str] = &["llamacpp", "ollama", "lmstudio", "vllm"];

/// The three files a summary reads, as text (`None` when the file is absent).
#[derive(Clone, Debug, Default)]
pub struct UsageFiles {
    pub settings: Option<String>,
    pub usage: Option<String>,
    pub replies: Option<String>,
}

impl UsageFiles {
    /// Read `settings.json`, `usage.jsonl` and `replies.jsonl` from a data directory.
    pub fn read(dir: &Path) -> UsageFiles {
        let read = |name: &str| std::fs::read(dir.join(name)).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
        UsageFiles { settings: read("settings.json"), usage: read("usage.jsonl"), replies: read("replies.jsonl") }
    }
}

/// What `getSettings()` gives the summary: the providers (an array, or none)
/// and the local cost benchmark as set.
struct Settings {
    providers: Vec<Value>,
    benchmark: Option<Value>,
}

fn settings(text: Option<&str>) -> Settings {
    let parsed = text.and_then(|t| serde_json::from_str::<Value>(t).ok());
    // `{ ...defaults(), ...parsed }`: only an object spreads its fields.
    let obj = parsed.as_ref().and_then(Value::as_object);
    let providers = obj.and_then(|o| o.get("providers")).and_then(Value::as_array).cloned().unwrap_or_default();
    let benchmark = obj.and_then(|o| o.get("localCostBenchmark")).cloned();
    Settings { providers, benchmark }
}

/// The lines of a JSONL log that parse, as `JSON.parse` takes them.
fn records(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.split('\n').filter(|l| !nekko_js::trim(l).is_empty()).filter_map(|l| serde_json::from_str(l).ok())
}

/// Reading a property of `null` throws in JavaScript.
fn object_or_throw(r: &Value, field: &str) -> Result<(), String> {
    if r.is_null() { Err(format!("Cannot read properties of null (reading '{field}')")) } else { Ok(()) }
}

#[derive(Default, Clone, Copy)]
struct Avoided {
    subscription: f64,
    local: f64,
    unpriced: f64,
    benchmark: f64,
}

impl Avoided {
    fn value(&self) -> Value {
        json!({
            "subscription": num(self.subscription),
            "local": num(self.local),
            "unpricedTokens": num(self.unpriced),
            "benchmarkTokens": num(self.benchmark),
        })
    }
}

#[derive(Default)]
struct ByModel {
    input: f64,
    output: f64,
    cost: f64,
    subscription: bool,
}

#[derive(Default)]
struct BySession {
    input: f64,
    output: f64,
    cost: f64,
    list_cost: f64,
}

/// Keys in first-seen order, as a JavaScript object adds them.
struct Ordered<T> {
    keys: Vec<String>,
    map: HashMap<String, T>,
}

impl<T: Default> Ordered<T> {
    fn new() -> Self {
        Self { keys: Vec::new(), map: HashMap::new() }
    }
    fn entry(&mut self, k: String) -> &mut T {
        if !self.map.contains_key(&k) {
            self.keys.push(k.clone());
        }
        self.map.entry(k).or_default()
    }
    fn to_value(&self, f: impl Fn(&T) -> Value) -> Value {
        Value::Object(self.keys.iter().map(|k| (k.clone(), f(&self.map[k]))).collect())
    }
}

/// `usageSummary()` for the given files. `Err` where the TS throws: a record
/// whose `ts` is not a valid date (`toISOString`), a `null` line, or a model
/// id that is not a string.
pub fn usage_summary(files: &UsageFiles) -> Result<Value, String> {
    let settings = settings(files.settings.as_deref());
    let replies = files.replies.as_deref().map(replies_from_text).transpose()?.flatten();

    let mut total_input = 0.0;
    let mut total_output = 0.0;
    let mut total_cost = 0.0;
    let mut total_cache_read: Option<f64> = None;
    let mut total_cache_write: Option<f64> = None;
    let mut has_subscription = false;
    let mut avoided = Avoided::default();
    let mut by_session_avoided: Ordered<Avoided> = Ordered::new();
    let mut by_model: Ordered<ByModel> = Ordered::new();
    let mut by_provider: Ordered<(f64, f64)> = Ordered::new();
    let mut by_session: Ordered<BySession> = Ordered::new();
    let mut by_session_cost: Ordered<f64> = Ordered::new();
    let mut daily: Ordered<(f64, f64, f64)> = Ordered::new();

    let finish = |summary: &mut Map<String, Value>| {
        summary.insert("avoidedCosts".into(), Value::Null);
        summary.insert("bySessionAvoidedCosts".into(), Value::Null);
        if let Some(r) = &replies {
            summary.insert("replies".into(), r.clone());
        }
    };

    let mut summary = Map::new();
    for k in ["totalInput", "totalOutput", "totalCost", "byModel", "byProvider", "bySession", "bySessionCost", "daily"]
    {
        summary.insert(k.into(), Value::Null);
    }
    finish(&mut summary);

    if let Some(text) = files.usage.as_deref() {
        let benchmark =
            settings.benchmark.clone().filter(|b| !b.is_null()).unwrap_or(json!(DEFAULT_LOCAL_COST_BENCHMARK));
        for r in records(text) {
            object_or_throw(&r, "providerId")?;
            let provider = settings.providers.iter().find(|p| strict_eq(get(p, "id"), get(&r, "providerId")));
            let local = match get(&r, "local") {
                Some(v) if !v.is_null() => nekko_js::truthy(Some(v)),
                _ => provider.is_some_and(|p| {
                    get(p, "kind").and_then(Value::as_str).is_some_and(|k| LOCAL_PROVIDER_KINDS.contains(&k))
                }),
            };
            let subscription = get(&r, "auth").and_then(Value::as_str) == Some("subscription");
            let tokens = Tokens {
                input: get(&r, "inputTokens"),
                output: get(&r, "outputTokens"),
                cache_read: get(&r, "cacheReadTokens"),
                cache_write: get(&r, "cacheWriteTokens"),
                subscription: false,
            };
            let model = get(&r, "modelId");
            let input = nekko_js::to_number(get(&r, "inputTokens"));
            let output = nekko_js::to_number(get(&r, "outputTokens"));
            let total_in = input + or_zero(get(&r, "cacheReadTokens")) + or_zero(get(&r, "cacheWriteTokens"));
            let exact = estimate_cost(model, tokens)?;
            let list_cost = exact.unwrap_or(0.0);
            let cost = if local || subscription { 0.0 } else { list_cost };
            if local || subscription {
                let bench = if local && exact.is_none() { estimate_cost(Some(&benchmark), tokens)? } else { None };
                let equivalent = exact.or(bench);
                let session = get(&r, "sessionId").filter(|s| nekko_js::truthy(Some(s))).map(|s| key_of(Some(s)));
                let apply = |bucket: &mut Avoided| {
                    match equivalent {
                        None => bucket.unpriced += total_in + output,
                        Some(e) if local => bucket.local += e,
                        Some(e) => bucket.subscription += e,
                    }
                    if bench.is_some() {
                        bucket.benchmark += total_in + output;
                    }
                };
                apply(&mut avoided);
                if let Some(s) = session {
                    apply(by_session_avoided.entry(s));
                }
            }
            total_cache_read = Some(total_cache_read.unwrap_or(0.0) + or_zero(get(&r, "cacheReadTokens")));
            total_cache_write = Some(total_cache_write.unwrap_or(0.0) + or_zero(get(&r, "cacheWriteTokens")));
            total_input += total_in;
            total_output += output;
            total_cost += cost;

            let bm = by_model.entry(key_of(model));
            bm.input += total_in;
            bm.output += output;
            bm.cost += cost;
            bm.subscription |= subscription;

            let bp = by_provider.entry(key_of(get(&r, "providerId")));
            bp.0 += total_in;
            bp.1 += output;

            if let Some(s) = get(&r, "sessionId").filter(|s| nekko_js::truthy(Some(s))) {
                let key = key_of(Some(s));
                let bs = by_session.entry(key.clone());
                bs.input += total_in;
                bs.output += output;
                bs.cost += cost;
                bs.list_cost += list_cost;
                *by_session_cost.entry(key) += cost;
            }

            has_subscription |= subscription;

            let day = crate::date::iso_date(crate::date::from_value(get(&r, "ts"))).ok_or("Invalid time value")?;
            let d = daily.entry(day);
            d.0 += total_in;
            d.1 += output;
            d.2 += cost;
        }
    }

    summary.insert("totalInput".into(), num(total_input));
    summary.insert("totalOutput".into(), num(total_output));
    summary.insert("totalCost".into(), num(total_cost));
    summary.insert(
        "byModel".into(),
        by_model.to_value(|m| {
            let mut o = json!({ "input": num(m.input), "output": num(m.output), "cost": num(m.cost) });
            if m.subscription {
                o["subscription"] = Value::Bool(true);
            }
            o
        }),
    );
    summary.insert("byProvider".into(), by_provider.to_value(|(i, o)| json!({ "input": num(*i), "output": num(*o) })));
    summary.insert(
        "bySession".into(),
        by_session.to_value(|s| {
            json!({ "input": num(s.input), "output": num(s.output), "cost": num(s.cost), "listCost": num(s.list_cost) })
        }),
    );
    summary.insert("bySessionCost".into(), by_session_cost.to_value(|c| num(*c)));
    let mut days: Vec<(String, (f64, f64, f64))> = daily.keys.iter().map(|k| (k.clone(), daily.map[k])).collect();
    days.sort_by(|a, b| crate::locale_compare(&a.0, &b.0));
    summary.insert(
        "daily".into(),
        Value::Array(
            days.into_iter()
                .map(|(date, (i, o, c))| json!({ "date": date, "input": num(i), "output": num(o), "cost": num(c) }))
                .collect(),
        ),
    );
    summary.insert("avoidedCosts".into(), avoided.value());
    summary.insert("bySessionAvoidedCosts".into(), by_session_avoided.to_value(Avoided::value));
    // The first record adds the cache totals, and any subscription record the
    // flag after them, so they follow `replies` in this order.
    if let (Some(read), Some(write)) = (total_cache_read, total_cache_write) {
        summary.insert("totalCacheRead".into(), num(read));
        summary.insert("totalCacheWrite".into(), num(write));
    }
    if has_subscription {
        summary.insert("hasSubscriptionUsage".into(), Value::Bool(true));
    }
    Ok(js_order(Value::Object(summary)))
}

/// `replyStats()` over the reply log's text.
fn replies_from_text(text: &str) -> Result<Option<Value>, String> {
    let all: Vec<Value> = records(text).collect();
    summarize_replies(&all)
}

/// `percentile(sorted, p)`.
fn percentile(sorted: &[Value], p: f64) -> Value {
    if sorted.is_empty() {
        return json!(0);
    }
    let i = ((p / 100.0) * sorted.len() as f64).ceil() - 1.0;
    let i = i.min(sorted.len() as f64 - 1.0);
    sorted.get(i.max(0.0) as usize).cloned().unwrap_or(Value::Null)
}

const KNOWN_STOPS: &[&str] = &["complete", "loop", "runaway"];
const RECENT: usize = 10;

/// `summarizeReplies(records)`: `None` for no records.
pub fn summarize_replies(records: &[Value]) -> Result<Option<Value>, String> {
    if records.is_empty() {
        return Ok(None);
    }
    let mut by_stop = [0u64; 4];
    let mut steps: Vec<Value> = Vec::new();
    let mut stops: Vec<Value> = Vec::new();
    for r in records {
        object_or_throw(r, "stop")?;
        let stop = get(r, "stop").and_then(Value::as_str);
        let slot = match stop {
            Some(s) if KNOWN_STOPS.contains(&s) => KNOWN_STOPS.iter().position(|k| *k == s).unwrap_or(3),
            _ => 3,
        };
        by_stop[slot] += 1;
        if nekko_js::to_number(get(r, "steps")) > 0.0 {
            steps.push(get(r, "steps").cloned().unwrap_or(Value::Null));
        }
        if stop == Some("loop") {
            let mut o = Map::new();
            for k in ["ts", "sessionId", "modelId", "steps", "stop"] {
                if let Some(v) = get(r, k) {
                    o.insert(k.into(), v.clone());
                }
            }
            stops.push(Value::Object(o));
        }
    }
    let n = |v: &Value| nekko_js::to_number(Some(v));
    let order = |x: f64| {
        if x < 0.0 {
            std::cmp::Ordering::Less
        } else if x > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    };
    steps.sort_by(|a, b| order(n(a) - n(b)));
    stops.sort_by(|a, b| order(nekko_js::to_number(get(b, "ts")) - nekko_js::to_number(get(a, "ts"))));
    stops.truncate(RECENT);
    Ok(Some(json!({
        "total": records.len(),
        "byStop": { "complete": by_stop[0], "loop": by_stop[1], "runaway": by_stop[2], "other": by_stop[3] },
        "p50Steps": percentile(&steps, 50.0),
        "p90Steps": percentile(&steps, 90.0),
        "mostSteps": steps.last().cloned().unwrap_or(json!(0)),
        "recentStops": stops,
    })))
}
