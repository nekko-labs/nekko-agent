//! `usageSummary()` (`packages/host/src/usage.ts`) and `summarizeReplies` /
//! `replyStats` (`replies.ts`), over the same files the TS host reads.

use crate::pricing::{Tokens, estimate_cost, model_price};
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

/// Tokens and spend of one slice of usage (#2494).
#[derive(Default, Clone, Copy)]
struct Slice {
    input: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
    cost: f64,
    list_cost: f64,
}

impl Slice {
    fn add(&mut self, input: f64, cache_read: f64, cache_write: f64, output: f64, cost: f64, list_cost: f64) {
        self.input += input;
        self.cache_read += cache_read;
        self.cache_write += cache_write;
        self.output += output;
        self.cost += cost;
        self.list_cost += list_cost;
    }
    fn value(&self) -> Value {
        json!({
            "input": num(self.input),
            "cacheRead": num(self.cache_read),
            "cacheWrite": num(self.cache_write),
            "output": num(self.output),
            "cost": num(self.cost),
            "listCost": num(self.list_cost),
        })
    }
}

/// Where a day's attributed usage came from: records that carry an `origin`
/// (new ones); older records count in the totals only. `input` is new input,
/// apart from cache reads and writes.
#[derive(Default, Clone, Copy)]
struct Attribution {
    user: Slice,
    background: Slice,
    parent: Slice,
    subagent: Slice,
}

impl Attribution {
    fn value(&self) -> Value {
        json!({
            "user": self.user.value(),
            "background": self.background.value(),
            "parent": self.parent.value(),
            "subagent": self.subagent.value(),
        })
    }
}

struct Daily {
    attribution: Option<Attribution>,
    input: f64,
    output: f64,
    cost: f64,
    by_session_cost: Ordered<f64>,
    local_tokens: f64,
    avoided: Avoided,
    model_ids: Vec<Value>,
    /// Paid pictures (`kind: "picture"` lines): how many, and what they cost.
    pictures: f64,
    picture_cost: f64,
}

impl Default for Daily {
    fn default() -> Self {
        Self {
            attribution: None,
            input: 0.0,
            output: 0.0,
            cost: 0.0,
            by_session_cost: Ordered::new(),
            local_tokens: 0.0,
            avoided: Avoided::default(),
            model_ids: Vec::new(),
            pictures: 0.0,
            picture_cost: 0.0,
        }
    }
}

/// Older turns didn't stamp Claude Code's billing route. The login providers
/// created by the Claude subscription flow used the CLI login by default;
/// an explicitly configured API key or cloud route was still metered.
fn recorded_auth<'a>(record: &'a Value, provider: Option<&'a Value>) -> Option<&'a str> {
    if let Some(auth) = get(record, "auth").and_then(Value::as_str) {
        return Some(auth);
    }
    match provider.and_then(|p| get(p, "kind")).and_then(Value::as_str) {
        Some("claude-code") => match provider.and_then(|p| p.pointer("/claudeCode/authSource")).and_then(Value::as_str)
        {
            Some("nekko-anthropic-key") => Some("apikey"),
            Some("bedrock" | "vertex" | "foundry") => Some("cloud"),
            None | Some("cli" | "") => Some("subscription"),
            _ => Some("unknown"),
        },
        _ => provider.and_then(|p| get(p, "auth")).and_then(Value::as_str),
    }
}

fn has_paid_comparison(model: Option<&Value>) -> bool {
    model.and_then(Value::as_str).and_then(model_price).is_some_and(|p| p.input > 0.0 || p.output > 0.0)
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
    let mut daily: Ordered<Daily> = Ordered::new();

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
            // A line with the provider's own charge (`costUsd`, a paid cloud
            // picture) costs that, not a token estimate.
            let reported = get(&r, "costUsd").and_then(Value::as_f64).filter(|c| c.is_finite() && *c >= 0.0);
            let kind = get(&r, "kind").and_then(Value::as_str);
            let picture = kind == Some("picture");
            let auth = if matches!(kind, Some("picture" | "video")) { None } else { recorded_auth(&r, provider) };
            let subscription = auth == Some("subscription");
            let exact = match reported {
                Some(c) => Some(c),
                None => estimate_cost(model, tokens)?,
            };
            let list_cost = exact.unwrap_or(0.0);
            let cost = if local || subscription {
                0.0
            } else if auth == Some("unknown") {
                reported.unwrap_or(0.0)
            } else {
                list_cost
            };
            let day = crate::date::iso_date(crate::date::from_value(get(&r, "ts"))).ok_or("Invalid time value")?;
            let d = daily.entry(day);
            if local || subscription {
                // A free hosted variant (or a reported $0 local charge) is not
                // a paid comparison. Use catalog prices, then the chosen fallback.
                let (equivalent, bench) = if local && !has_paid_comparison(model) {
                    let bench = if has_paid_comparison(Some(&benchmark)) {
                        estimate_cost(Some(&benchmark), tokens)?
                    } else {
                        None
                    };
                    (bench, bench)
                } else if local {
                    (estimate_cost(model, tokens)?, None)
                } else {
                    (exact, None)
                };
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
                apply(&mut d.avoided);
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

            if let Some(s) = get(&r, "sessionId").filter(|s| nekko_js::truthy(Some(s))) {
                *d.by_session_cost.entry(key_of(Some(s))) += cost;
            }
            if local {
                d.local_tokens += total_in + output;
            }
            // Array.includes keeps first-seen model ids, including undefined
            // (serialized as null in an array) in legacy records.
            let model_id = model.cloned().unwrap_or(Value::Null);
            if !d.model_ids.contains(&model_id) {
                d.model_ids.push(model_id);
            }
            d.input += total_in;
            d.output += output;
            d.cost += cost;
            if picture {
                d.pictures += 1.0;
                d.picture_cost += cost;
            }
            if let Some(origin) = get(&r, "origin").and_then(Value::as_str) {
                let a = d.attribution.get_or_insert_with(Attribution::default);
                let (read, write) = (or_zero(get(&r, "cacheReadTokens")), or_zero(get(&r, "cacheWriteTokens")));
                let new_input = or_zero(get(&r, "inputTokens"));
                let by_origin = if origin == "background" { &mut a.background } else { &mut a.user };
                by_origin.add(new_input, read, write, output, cost, list_cost);
                let sub = get(&r, "parentSessionId").is_some_and(|p| nekko_js::truthy(Some(p)));
                let by_role = if sub { &mut a.subagent } else { &mut a.parent };
                by_role.add(new_input, read, write, output, cost, list_cost);
            }
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
    let mut days = daily.keys.clone();
    days.sort_by(|a, b| crate::locale_compare(a, b));
    summary.insert(
        "daily".into(),
        Value::Array(
            days.into_iter()
                .map(|date| {
                    let d = &daily.map[&date];
                    let mut day = json!({
                        "date": date,
                        "input": num(d.input),
                        "output": num(d.output),
                        "cost": num(d.cost),
                        "bySessionCost": d.by_session_cost.to_value(|c| num(*c)),
                        "localTokens": num(d.local_tokens),
                        "avoidedCosts": d.avoided.value(),
                        "modelIds": d.model_ids,
                    });
                    if let Some(a) = &d.attribution {
                        day["attribution"] = a.value();
                    }
                    // Only on a day with paid pictures, so older summaries read the same.
                    if d.pictures > 0.0 {
                        day["pictures"] = num(d.pictures);
                        day["pictureCost"] = num(d.picture_cost);
                    }
                    day
                })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_plan_usage_is_not_metered_in_old_or_new_records() {
        let day = 1_762_732_800_000_u64;
        let settings = json!({"providers": [
            {"id":"cli","kind":"claude-code"},
            {"id":"key","kind":"claude-code","claudeCode":{"authSource":"nekko-anthropic-key"}},
            {"id":"cloud","kind":"claude-code","claudeCode":{"authSource":"bedrock"}}
        ]});
        let row = |provider: &str, auth: Option<&str>| {
            let mut v = json!({"ts":day,"providerId":provider,"sessionId":provider,"modelId":"claude-sonnet-4",
                "inputTokens":1_000_000,"outputTokens":0,"local":false,"origin":"user"});
            if let Some(a) = auth {
                v["auth"] = json!(a);
            }
            v.to_string()
        };
        let entries = [
            row("cli", None),
            row("key", Some("subscription")),
            row("removed", Some("subscription")),
            row("unreadable", Some("unknown")),
            row("used-to-be-key", Some("api_key")),
            row("key", None),
            row("cloud", None),
        ];
        let s = usage_summary(&UsageFiles {
            settings: Some(settings.to_string()),
            usage: Some(entries.join("\n")),
            replies: None,
        })
        .unwrap();
        let list = model_price("claude-sonnet-4").unwrap().input;
        assert_eq!(s["totalCost"].as_f64(), Some(list * 3.0));
        assert_eq!(s["daily"][0]["cost"].as_f64(), Some(list * 3.0));
        assert_eq!(s["bySessionCost"]["cli"], json!(0));
        assert_eq!(s["bySessionCost"]["unreadable"], json!(0));
        assert_eq!(s["bySessionCost"]["key"].as_f64(), Some(list));
        assert_eq!(s["bySessionCost"]["cloud"].as_f64(), Some(list));
        assert_eq!(s["daily"][0]["avoidedCosts"]["subscription"].as_f64(), Some(list * 3.0));
        assert_eq!(s["bySessionAvoidedCosts"]["removed"]["subscription"].as_f64(), Some(list));
    }

    #[test]
    fn local_usage_compares_to_paid_catalog_rates_or_the_configured_fallback() {
        let day = 1_762_732_800_000_u64;
        let unknown = json!({"ts":day,"providerId":"local","sessionId":"one","modelId":"unlisted.gguf",
            "inputTokens":1_000_000,"outputTokens":0,"local":true, "costUsd":0});
        let known = json!({"ts":day,"providerId":"local","sessionId":"two","modelId":"qwen3-32b",
            "inputTokens":1_000_000,"outputTokens":0,"local":true, "costUsd":0});
        let mut free = unknown.clone();
        free["modelId"] = json!("inclusionai/ling-3.1-flash");
        let usage = format!("{unknown}\n{known}\n{free}");
        let list = model_price("qwen3-32b").unwrap().input;
        let summary = |benchmark: &str| {
            usage_summary(&UsageFiles {
                settings: Some(json!({"localCostBenchmark":benchmark}).to_string()),
                usage: Some(usage.clone()),
                replies: None,
            })
            .unwrap()
        };
        let s = summary("qwen3-32b");
        let d = &s["daily"][0];
        assert_eq!(d["cost"], json!(0));
        assert_eq!(d["localTokens"], json!(3_000_000));
        assert_eq!(d["avoidedCosts"]["local"].as_f64(), Some(list * 3.0));
        assert_eq!(d["avoidedCosts"]["benchmarkTokens"], json!(2_000_000));
        assert_eq!(s["bySessionAvoidedCosts"]["two"]["local"].as_f64(), Some(list));
        let s = summary("");
        assert_eq!(s["avoidedCosts"]["local"].as_f64(), Some(list));
        assert_eq!(s["avoidedCosts"]["unpricedTokens"], json!(2_000_000));
    }

    #[test]
    fn a_paid_picture_costs_what_the_provider_charged() {
        let day = 1_762_732_800_000_u64; // 2025-11-10 UTC
        let lines = [
            json!({ "ts": day, "providerId": "p_or", "modelId": "acme/pic", "sessionId": "s", "inputTokens": 0, "outputTokens": 0, "local": false, "kind": "picture", "costUsd": 0.031 }),
            json!({ "ts": day, "providerId": "p_or", "modelId": "acme/pic", "sessionId": "s", "inputTokens": 0, "outputTokens": 0, "local": false, "kind": "picture", "costUsd": 0.04 }),
        ]
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let s = usage_summary(&UsageFiles { settings: None, usage: Some(lines), replies: None }).unwrap();
        let close = |v: &Value, want: f64| (v.as_f64().unwrap() - want).abs() < 1e-9;
        assert!(close(&s["totalCost"], 0.071), "{}", s["totalCost"]);
        assert!(close(&s["bySessionCost"]["s"], 0.071));
        let d = &s["daily"][0];
        assert!(close(&d["cost"], 0.071));
        assert_eq!(d["pictures"], json!(2));
        assert!(close(&d["pictureCost"], 0.071));
        // A day with no pictures says nothing about them.
        let tokens =
            json!({ "ts": day, "providerId": "a", "modelId": "m", "inputTokens": 5, "outputTokens": 5 }).to_string();
        let s = usage_summary(&UsageFiles { settings: None, usage: Some(tokens), replies: None }).unwrap();
        assert!(s["daily"][0].get("pictures").is_none());
    }

    #[test]
    fn days_split_attributed_usage_by_origin_role_and_cache() {
        let day = 1_762_732_800_000_u64; // 2025-11-10 UTC
        let lines = [
            // An older record: in the totals, not in the attribution.
            json!({ "ts": day, "providerId": "a", "modelId": "m", "inputTokens": 5, "outputTokens": 5, "sessionId": "s" }),
            json!({ "ts": day, "providerId": "a", "modelId": "m", "inputTokens": 100, "cacheReadTokens": 900, "cacheWriteTokens": 50, "outputTokens": 10, "sessionId": "s", "origin": "user" }),
            json!({ "ts": day, "providerId": "a", "modelId": "m", "inputTokens": 20, "cacheReadTokens": 400, "outputTokens": 4, "sessionId": "s", "origin": "background" }),
            json!({ "ts": day, "providerId": "a", "modelId": "m", "inputTokens": 30, "outputTokens": 3, "sessionId": "c", "origin": "user", "parentSessionId": "s" }),
        ]
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let s = usage_summary(&UsageFiles { settings: None, usage: Some(lines), replies: None }).unwrap();
        let a = &s["daily"][0]["attribution"];
        assert_eq!(a["user"]["input"], json!(130));
        assert_eq!(a["user"]["cacheRead"], json!(900));
        assert_eq!(a["user"]["cacheWrite"], json!(50));
        assert_eq!(a["background"]["input"], json!(20));
        assert_eq!(a["background"]["cacheRead"], json!(400));
        assert_eq!(a["parent"]["input"], json!(120));
        assert_eq!(a["subagent"]["input"], json!(30));
        assert_eq!(a["subagent"]["output"], json!(3));
        // Older records only: no attribution at all.
        let old =
            json!({ "ts": day, "providerId": "a", "modelId": "m", "inputTokens": 5, "outputTokens": 5 }).to_string();
        let s = usage_summary(&UsageFiles { settings: None, usage: Some(old), replies: None }).unwrap();
        assert!(s["daily"][0].get("attribution").is_none());
    }
}
