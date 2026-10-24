//! What a paired phone sees beyond a chat's transcript: the daemon's copy of
//! `packages/shared/src/phone-views.ts`. Saved prompts, a chat's queue, its
//! pull requests, the computer's tasks and workflows, and its usage and
//! limits, each a narrow read-only projection. The field lists come from
//! `phone-access.json`; `tests/golden/phone.json` holds the two editions equal.

use serde_json::{Map, Value, json};

/// The limits and field lists of these views (`PHONE_VIEWS` and the `PHONE_*_VIEW` lists).
#[derive(Debug, Default)]
pub struct Views {
    pub text_chars: usize,
    pub usage_days: usize,
    pub usage_models: usize,
    pub prompt: Vec<String>,
    pub task: Vec<String>,
    pub workflow: Vec<String>,
    pub workflow_run: Vec<String>,
    pub pr: Vec<String>,
    pub limits: Vec<String>,
    pub limit_window: Vec<String>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

impl Views {
    pub fn from_policy(v: &Value) -> Self {
        let n = |k: &str| v["views"][k].as_u64().unwrap_or(0) as usize;
        Views {
            text_chars: n("textChars"),
            usage_days: n("usageDays"),
            usage_models: n("usageModels"),
            prompt: strings(&v["promptView"]),
            task: strings(&v["taskView"]),
            workflow: strings(&v["workflowView"]),
            workflow_run: strings(&v["workflowRunView"]),
            pr: strings(&v["prView"]),
            limits: strings(&v["limitsView"]),
            limit_window: strings(&v["limitWindowView"]),
        }
    }
}

/// `pickKeys`: only `keys` of an object, in the object's order of `keys`.
pub fn pick_keys(value: &Value, keys: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(o) = value.as_object() else { return out };
    for k in keys {
        if let Some(v) = o.get(k) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn cut_field(o: &mut Map<String, Value>, key: &str, n: usize) {
    if let Some(Value::String(s)) = o.get(key)
        && s.encode_utf16().count() > n
    {
        let cut = crate::hello::cut16(s, n).to_string();
        o.insert(key.to_string(), json!(cut));
    }
}

/// `num`: a finite number, else 0.
fn num(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => json!(0),
    }
}

fn as_f64(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// `modelName`: a model id that is a file on the computer becomes its file name.
fn model_name(id: &str) -> &str {
    let at = id.rfind(['/', '\\']).map_or(0, |i| i + 1);
    &id[at..]
}

/// `phonePromptsView`: saved prompts whose name and text are strings, as `PHONE_PROMPT_VIEW`.
pub fn prompts(prompts: &Value, views: &Views) -> Value {
    let Some(list) = prompts.as_array() else { return json!([]) };
    Value::Array(
        list.iter()
            .filter(|p| p.get("name").is_some_and(Value::is_string) && p.get("body").is_some_and(Value::is_string))
            .map(|p| Value::Object(pick_keys(p, &views.prompt)))
            .collect(),
    )
}

/// `phoneQueueView`: each queued prompt's text and skill, its photos as `''`.
pub fn queue(queue: &Value) -> Value {
    let Some(list) = queue.as_array() else { return json!([]) };
    Value::Array(
        list.iter()
            .map(|q| {
                let Some(o) = q.as_object() else { return q.clone() };
                let mut out = Map::new();
                out.insert("text".into(), json!(o.get("text").and_then(Value::as_str).unwrap_or("")));
                if let Some(skill) = o.get("skill").filter(|s| s.is_object()) {
                    out.insert("skill".into(), Value::Object(pick_keys(skill, &["input".into(), "name".into()])));
                }
                let count = |k: &str| o.get(k).and_then(Value::as_array).map_or(0, Vec::len);
                let photos = count("images") + count("videos");
                if photos > 0 {
                    out.insert("images".into(), Value::Array(vec![json!(""); photos]));
                }
                Value::Object(out)
            })
            .collect(),
    )
}

/// `phoneTasksView`.
pub fn tasks(tasks: &Value, views: &Views) -> Value {
    let Some(list) = tasks.as_array() else { return json!([]) };
    Value::Array(
        list.iter()
            .filter(|t| t.is_object())
            .map(|t| {
                let mut out = pick_keys(t, &views.task);
                cut_field(&mut out, "lastResult", views.text_chars);
                Value::Object(out)
            })
            .collect(),
    )
}

/// `phoneWorkflowsView`: the workflows of a `workflows:list` snapshot, with a step count.
pub fn workflows(snapshot: &Value, views: &Views) -> Value {
    let Some(list) = snapshot.get("workflows").and_then(Value::as_array) else { return json!([]) };
    Value::Array(
        list.iter()
            .filter(|w| w.is_object())
            .map(|w| {
                let mut out = pick_keys(w, &views.workflow);
                cut_field(&mut out, "description", views.text_chars);
                out.insert("stepCount".into(), json!(w.get("steps").and_then(Value::as_array).map_or(0, Vec::len)));
                Value::Object(out)
            })
            .collect(),
    )
}

/// `phonePrsView`.
pub fn prs(prs: &Value, views: &Views) -> Value {
    let Some(list) = prs.as_array() else { return json!([]) };
    Value::Array(list.iter().filter(|p| p.is_object()).map(|p| Value::Object(pick_keys(p, &views.pr))).collect())
}

/// `phoneWatchesView`: a chat's watches picked to `PHONE_WATCH_VIEW` (never the
/// continuation prompt), `lastError` cut to the text limit, non-objects dropped.
pub fn watches(watches: &Value, view: &[String], text_chars: usize) -> Value {
    let Some(list) = watches.as_array() else { return json!([]) };
    Value::Array(
        list.iter()
            .filter(|w| w.is_object())
            .map(|w| {
                let mut o = pick_keys(w, view);
                cut_field(&mut o, "lastError", text_chars);
                Value::Object(o)
            })
            .collect(),
    )
}

/// `phoneLimitsView`.
pub fn limits(limits: &Value, views: &Views) -> Value {
    if !limits.is_object() {
        return Value::Null;
    }
    let windows: Vec<Value> = limits
        .get("windows")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|w| w.is_object()).map(|w| Value::Object(pick_keys(w, &views.limit_window))).collect())
        .unwrap_or_default();
    let mut out = pick_keys(limits, &views.limits);
    out.insert("windows".into(), Value::Array(windows));
    Value::Object(out)
}

/// `phoneUsageView`: totals, the busiest models, the recent days.
pub fn usage(usage: &Value, views: &Views) -> Value {
    let Some(u) = usage.as_object() else { return Value::Null };
    let mut models: Vec<Map<String, Value>> = u
        .get("byModel")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v.is_object())
                .map(|(id, v)| {
                    let mut row = Map::new();
                    row.insert("model".into(), json!(model_name(id)));
                    row.insert("input".into(), num(v.get("input")));
                    row.insert("output".into(), num(v.get("output")));
                    row.insert("cost".into(), num(v.get("cost")));
                    if v.get("subscription") == Some(&Value::Bool(true)) {
                        row.insert("subscription".into(), json!(true));
                    }
                    row
                })
                .collect()
        })
        .unwrap_or_default();
    let tokens = |r: &Map<String, Value>| as_f64(&r["input"]) + as_f64(&r["output"]);
    models.sort_by(|a, b| {
        tokens(b)
            .partial_cmp(&tokens(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a["model"].as_str().cmp(&b["model"].as_str()))
    });
    models.truncate(views.usage_models);
    let days: Vec<&Value> = u
        .get("daily")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|d| d.get("date").is_some_and(Value::is_string)).collect())
        .unwrap_or_default();
    let from = days.len().saturating_sub(views.usage_days);
    let daily: Vec<Value> = days[from..]
        .iter()
        .map(|d| {
            json!({ "date": d["date"], "input": num(d.get("input")), "output": num(d.get("output")), "cost": num(d.get("cost")) })
        })
        .collect();
    json!({
        "totalInput": num(u.get("totalInput")),
        "totalOutput": num(u.get("totalOutput")),
        "totalCost": num(u.get("totalCost")),
        "byModel": models.into_iter().map(Value::Object).collect::<Vec<_>>(),
        "daily": daily,
    })
}

/// `limitsKeyFor` (packages/shared/src/limits.ts): a subscription's token
/// reference, or `provider:<id>` for an API key whose limits can be read.
fn limits_key_for(p: &Value) -> Option<String> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    if p.get("auth").and_then(Value::as_str) == Some("subscription")
        && let Some(token) = s("tokenKey")
    {
        return Some(token.to_string());
    }
    let kind = p.get("kind").and_then(Value::as_str).unwrap_or("");
    if s("apiKey").is_some() && matches!(kind, "openrouter" | "anthropic") {
        return Some(format!("provider:{}", p.get("id").and_then(Value::as_str).unwrap_or("undefined")));
    }
    None
}

/// `phoneLimitsKey`: the limits key of the provider a phone names by id.
pub fn limits_key(providers: &Value, provider_id: &str) -> Option<String> {
    providers
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p.get("id").and_then(Value::as_str) == Some(provider_id))
        .and_then(limits_key_for)
}
