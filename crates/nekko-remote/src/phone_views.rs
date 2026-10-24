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
    /// The Expert monitor's views (`expertMonitor` in `phone-access.json`).
    pub system: Vec<String>,
    pub temps: Vec<String>,
    pub gpu: Vec<String>,
    pub gpu_device: Vec<String>,
    pub engine: Vec<String>,
    pub resident: Vec<String>,
    pub loading: Vec<String>,
    pub engine_memory: Vec<String>,
    pub context_sources: Vec<String>,
    /// `PHONE_MONITOR_VIEW`.
    pub monitor: MonitorCaps,
    /// `PHONE_MONITOR_SOURCES`: what `monitor:summary` reads, in order.
    pub monitor_sources: Vec<String>,
}

/// The caps of `monitor:summary` (`PHONE_MONITOR_VIEW`).
#[derive(Debug, Default)]
pub struct MonitorCaps {
    pub running: usize,
    pub needs_you: usize,
    pub automations: usize,
    pub label_chars: usize,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

impl Views {
    pub fn from_policy(v: &Value) -> Self {
        let n = |k: &str| v["views"][k].as_u64().unwrap_or(0) as usize;
        let m = |k: &str| v["monitorView"][k].as_u64().unwrap_or(0) as usize;
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
            system: strings(&v["expertMonitor"]["systemView"]),
            temps: strings(&v["expertMonitor"]["tempsView"]),
            gpu: strings(&v["expertMonitor"]["gpuView"]),
            gpu_device: strings(&v["expertMonitor"]["gpuDeviceView"]),
            engine: strings(&v["expertMonitor"]["engineView"]),
            resident: strings(&v["expertMonitor"]["residentView"]),
            loading: strings(&v["expertMonitor"]["loadingView"]),
            engine_memory: strings(&v["expertMonitor"]["engineMemoryView"]),
            context_sources: strings(&v["expertMonitor"]["contextSources"]),
            monitor: MonitorCaps {
                running: m("running"),
                needs_you: m("needsYou"),
                automations: m("automations"),
                label_chars: m("labelChars"),
            },
            monitor_sources: strings(&v["monitorSources"]),
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

/// `phoneMachineView`: a computer's summary pinned to `PHONE_MACHINE_VIEW`,
/// its resident models to `PHONE_MACHINE_RESIDENT_VIEW`; null unless an object.
pub fn machine(summary: &Value, view: &[String], resident_view: &[String]) -> Value {
    if !summary.is_object() {
        return Value::Null;
    }
    let mut o = pick_keys(summary, view);
    if let Some(Value::Object(engine)) = o.get("engine").cloned() {
        let mut engine = engine;
        let resident: Vec<Value> = engine
            .get("resident")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter().filter(|m| m.is_object()).map(|m| Value::Object(pick_keys(m, resident_view))).collect()
            })
            .unwrap_or_default();
        engine.insert("resident".into(), Value::Array(resident));
        o.insert("engine".into(), Value::Object(engine));
    }
    Value::Object(o)
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

/// `phoneSystemView`: the named numbers, temperatures as numbers only.
pub fn system(stats: &Value, views: &Views) -> Value {
    if !stats.is_object() {
        return Value::Null;
    }
    let mut out = pick_keys(stats, &views.system);
    if let Some(t) = out.get("temps").cloned() {
        out.insert("temps".into(), Value::Object(pick_keys(&t, &views.temps)));
    }
    Value::Object(out)
}

fn objects(v: Option<&Value>, keys: &[String]) -> Value {
    Value::Array(
        v.and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|d| d.is_object())
            .map(|d| Value::Object(pick_keys(d, keys)))
            .collect(),
    )
}

/// `phoneGpuView`: the pool and each device's load, memory and temperature.
pub fn gpu(stats: &Value, views: &Views) -> Value {
    if !stats.is_object() {
        return Value::Null;
    }
    let mut out = pick_keys(stats, &views.gpu);
    out.insert("devices".into(), objects(stats.get("devices"), &views.gpu_device));
    Value::Object(out)
}

/// `phoneEngineView`: installed, running, what is resident and what is loading.
pub fn engine(status: &Value, views: &Views) -> Value {
    if !status.is_object() {
        return Value::Null;
    }
    let mut out = pick_keys(status, &views.engine);
    let installed = status.pointer("/install/binPath").and_then(Value::as_str).is_some_and(|p| !p.is_empty());
    out.insert("installed".into(), json!(installed));
    out.insert("resident".into(), objects(status.get("resident"), &views.resident));
    out.insert("loading".into(), objects(status.get("loading"), &views.loading));
    if let Some(m) = status.get("memory").filter(|m| m.is_object()) {
        out.insert("memory".into(), Value::Object(pick_keys(m, &views.engine_memory)));
    }
    Value::Object(out)
}

/// `phoneContextView`: the included items' tokens, in total and by kind of source.
pub fn context(bundle: &Value, views: &Views) -> Value {
    if !bundle.is_object() {
        return Value::Null;
    }
    let mut used = 0.0;
    let mut sources = Map::new();
    for item in bundle.get("items").and_then(Value::as_array).into_iter().flatten() {
        if item.get("included") != Some(&Value::Bool(true)) {
            continue;
        }
        let tokens = item.get("tokens").and_then(Value::as_f64).filter(|t| t.is_finite()).unwrap_or(0.0);
        used += tokens;
        if let Some(src) =
            item.get("source").and_then(Value::as_str).filter(|s| views.context_sources.iter().any(|k| k == s))
        {
            let was = sources.get(src).map_or(0.0, as_f64);
            sources.insert(src.to_string(), number(was + tokens));
        }
    }
    let mut out = Map::new();
    out.insert("usedTokens".into(), number(used));
    out.insert("sources".into(), Value::Object(sources));
    if let Some(w) = bundle.get("contextWindow").filter(|w| w.as_f64().is_some_and(f64::is_finite)) {
        out.insert("contextWindow".into(), w.clone());
    }
    Value::Object(out)
}

/// A whole count as an integer, as JSON.stringify writes it.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

/// A finite number, or None.
fn finite(v: Option<&Value>) -> Option<&Value> {
    v.filter(|n| n.is_number())
}

/// The largest number among `values`, as it came.
fn highest<'a>(values: impl Iterator<Item = Option<&'a Value>>) -> Option<Value> {
    let mut best: Option<&Value> = None;
    for v in values.flatten().filter(|v| v.is_number()) {
        if best.is_none_or(|b| as_f64(v) > as_f64(b)) {
            best = Some(v);
        }
    }
    best.cloned()
}

/// A whole number of ms as an integer, as JavaScript prints it.
fn ms(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 { json!(v as i64) } else { json!(v) }
}

fn label(v: Option<&Value>, views: &Views) -> Value {
    json!(v.and_then(Value::as_str).map_or("", |s| crate::hello::cut16(s, views.monitor.label_chars)))
}

/// `monitorHardware`: load, memory and temperatures, never a model name.
fn monitor_hardware(system: &Value, gpu: &Value) -> Value {
    let temps = system.get("temps").filter(|t| t.is_object()).cloned().unwrap_or(json!({}));
    let mut cpu = Map::new();
    cpu.insert("loadPct".into(), num(system.get("cpuPct")));
    cpu.insert("cores".into(), num(system.get("cpuCores")));
    if let Some(t) = finite(temps.get("cpuC")) {
        cpu.insert("tempC".into(), t.clone());
    }
    let mut memory = Map::new();
    memory.insert("usedMB".into(), num(system.get("memUsedMB")));
    memory.insert("totalMB".into(), num(system.get("memTotalMB")));
    if let Some(t) = finite(temps.get("memoryC")) {
        memory.insert("tempC".into(), t.clone());
    }
    let gpu_row = if gpu.is_object() {
        let devices: Vec<&Value> = gpu
            .get("devices")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|d| d.is_object()).collect())
            .unwrap_or_default();
        let mut row = Map::new();
        row.insert("memoryUsedMB".into(), num(gpu.get("usedMB")));
        row.insert("memoryTotalMB".into(), num(gpu.get("totalMB")));
        if let Some(load) = highest(devices.iter().map(|d| d.get("utilizationPct"))) {
            row.insert("loadPct".into(), load);
        }
        if let Some(t) =
            highest(devices.iter().map(|d| d.get("temperatureC"))).or_else(|| finite(temps.get("gpuC")).cloned())
        {
            row.insert("tempC".into(), t);
        }
        if gpu.get("unified") == Some(&Value::Bool(true)) {
            row.insert("unified".into(), json!(true));
        }
        Value::Object(row)
    } else if let Some(t) = finite(temps.get("gpuC")) {
        json!({ "tempC": t })
    } else {
        Value::Null
    };
    json!({ "cpu": cpu, "memory": memory, "gpu": gpu_row })
}

/// `phoneMonitorView`: `monitor:summary` from the computer's own reads
/// (`sources`, by channel), at `now` ms on the computer's clock.
pub fn monitor(sources: &Map<String, Value>, now: f64, views: &Views) -> Value {
    let src = |k: &str| sources.get(k).unwrap_or(&Value::Null);
    let mut by_id: Map<String, Value> = Map::new();
    for s in src("sessions:summaries").as_array().into_iter().flatten() {
        if let Some(id) = s.get("id").and_then(Value::as_str)
            && !by_id.contains_key(id)
        {
            by_id.insert(id.to_string(), s.clone());
        }
    }
    let empty = Map::new();
    let pending = src("chat:pending").as_object().unwrap_or(&empty);
    let title = |id: &str| label(by_id.get(id).and_then(|s| s.get("title")), views);

    let mut running = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for id in src("chat:running").as_array().into_iter().flatten().filter_map(Value::as_str) {
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        let p = pending.get(id).filter(|p| p.is_object());
        let has = |k: &str| p.and_then(|p| p.get(k)).is_some_and(Value::is_object);
        let step = if has("approval") {
            "approval"
        } else if has("question") {
            "question"
        } else {
            "working"
        };
        let mut row = Map::new();
        row.insert("id".into(), json!(id));
        row.insert("title".into(), title(id));
        row.insert("step".into(), json!(step));
        if let Some(start) = by_id.get(id).and_then(|s| s.get("activeRun")).and_then(|r| finite(r.get("startedAt"))) {
            row.insert("elapsedMs".into(), ms((now - as_f64(start)).max(0.0)));
        }
        running.push(Value::Object(row));
    }
    running.truncate(views.monitor.running);

    let mut needs: Vec<Map<String, Value>> = Vec::new();
    for (id, p) in pending {
        if !p.is_object() {
            continue;
        }
        if let Some(a) = p.get("approval").filter(|a| a.is_object())
            && let Some(call) = a.get("call").filter(|c| c.is_object())
            && let Some(call_id) = call.get("id").filter(|c| c.is_string())
        {
            let risk = a
                .get("severity")
                .and_then(Value::as_str)
                .filter(|s| matches!(*s, "low" | "medium" | "high"))
                .unwrap_or("medium");
            let mut row = Map::new();
            row.insert("sessionId".into(), json!(id));
            row.insert("title".into(), title(id));
            row.insert("kind".into(), json!("approval"));
            row.insert("callId".into(), call_id.clone());
            row.insert("risk".into(), json!(risk));
            row.insert("label".into(), label(call.get("name"), views));
            if let Some(at) = finite(a.get("requestedAt")) {
                row.insert("since".into(), at.clone());
            }
            needs.push(row);
        }
        if let Some(q) = p.get("question").filter(|q| q.is_object())
            && let Some(call_id) = q.get("callId").filter(|c| c.is_string())
        {
            let questions = q.get("questions").and_then(Value::as_array);
            let first = questions.and_then(|a| a.first()).filter(|f| f.is_object());
            let mut row = Map::new();
            row.insert("sessionId".into(), json!(id));
            row.insert("title".into(), title(id));
            row.insert("kind".into(), json!("question"));
            row.insert("callId".into(), call_id.clone());
            row.insert("label".into(), label(first.and_then(|f| f.get("question")), views));
            row.insert("count".into(), json!(questions.map_or(0, Vec::len)));
            if let Some(at) = finite(q.get("askedAt")) {
                row.insert("since".into(), at.clone());
            }
            needs.push(row);
        }
    }
    let since = |r: &Map<String, Value>| r.get("since").map_or(f64::INFINITY, as_f64);
    let text = |r: &Map<String, Value>, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    needs.sort_by(|a, b| {
        since(a)
            .partial_cmp(&since(b))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| text(a, "sessionId").cmp(&text(b, "sessionId")))
            .then_with(|| text(a, "kind").cmp(&text(b, "kind")))
    });
    needs.truncate(views.monitor.needs_you);

    let mut autos: Vec<Map<String, Value>> = Vec::new();
    let mut auto = |kind: &str, id: &Value, name: Option<&Value>, next: &Value| {
        let mut row = Map::new();
        row.insert("kind".into(), json!(kind));
        row.insert("id".into(), id.clone());
        row.insert("name".into(), label(name, views));
        row.insert("nextRunAt".into(), next.clone());
        autos.push(row);
    };
    for t in src("tasks:list").as_array().into_iter().flatten() {
        if t.get("status").and_then(Value::as_str) == Some("active")
            && let Some(id) = t.get("id").filter(|i| i.is_string())
            && let Some(next) = finite(t.get("nextRunAt"))
        {
            auto("task", id, t.get("title"), next);
        }
    }
    for w in src("workflows:list").get("workflows").and_then(Value::as_array).into_iter().flatten() {
        if w.is_object()
            && w.get("enabled") != Some(&Value::Bool(false))
            && let Some(id) = w.get("id").filter(|i| i.is_string())
            && let Some(next) = finite(w.get("nextRunAt"))
        {
            auto("workflow", id, w.get("name"), next);
        }
    }
    autos.sort_by(|a, b| {
        as_f64(&a["nextRunAt"])
            .partial_cmp(&as_f64(&b["nextRunAt"]))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| text(a, "kind").cmp(&text(b, "kind")))
            .then_with(|| text(a, "id").cmp(&text(b, "id")))
    });
    autos.truncate(views.monitor.automations);

    json!({
        "hardware": monitor_hardware(src("system:stats"), src("gpu:stats")),
        "running": running,
        "needsYou": needs.into_iter().map(Value::Object).collect::<Vec<_>>(),
        "automations": autos.into_iter().map(Value::Object).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> Map<String, Value> {
        let mut tasks = vec![
            json!({ "id": "t1", "title": "Nightly", "status": "active", "nextRunAt": 50_000, "prompt": "secret instruction" }),
            json!({ "id": "t2", "title": "Paused", "status": "paused", "nextRunAt": 10 }),
        ];
        tasks.extend((0..12).map(
            |i| json!({ "id": format!("r{i}"), "title": format!("R{i}"), "status": "active", "nextRunAt": 60_000 + i }),
        ));
        let v = json!({
            "system:stats": { "cpuPct": 42.5, "cpuCores": 16, "cpuModel": "AMD Ryzen 9 7950X", "memUsedMB": 20000, "memTotalMB": 65536, "temps": { "cpuC": 71, "memoryC": 48 } },
            "gpu:stats": { "source": "nvidia-smi", "devices": [
                { "name": "NVIDIA GeForce RTX 4090", "memoryTotalMB": 24564, "memoryUsedMB": 9000, "utilizationPct": 87, "temperatureC": 66 },
                { "name": "NVIDIA GeForce RTX 3060", "memoryTotalMB": 12288, "memoryUsedMB": 100, "utilizationPct": 3, "temperatureC": 70 }
            ], "totalMB": 36852, "usedMB": 9100, "freeMB": 27752 },
            "chat:running": ["a", "b", "a", "gone"],
            "sessions:summaries": [
                { "id": "a", "title": "Fix the build", "workspaceId": "/Users/me/secret", "activeRun": { "startedAt": 1000 } },
                { "id": "b", "title": "T".repeat(500), "activeRun": { "startedAt": 9000 } },
                { "id": "c", "title": "Idle" }
            ],
            "chat:pending": {
                "a": { "sessionId": "a", "approval": { "call": { "id": "call-1", "name": "bash", "input": { "command": "rm -rf /Users/me/secret" } }, "reason": "secret", "severity": "high", "requestedAt": 500 } },
                "c": { "sessionId": "c", "question": { "callId": "q-1", "askedAt": 300, "questions": [{ "id": "x", "header": "Auth", "question": "Which auth method?", "options": [{ "label": "secret option" }] }] } }
            },
            "tasks:list": tasks,
            "workflows:list": { "workflows": [
                { "id": "w1", "name": "Deploy", "enabled": true, "nextRunAt": 20000, "steps": [{ "command": "secret.sh" }] },
                { "id": "w2", "name": "Off", "enabled": false, "nextRunAt": 1 }
            ] }
        });
        v.as_object().unwrap().clone()
    }

    #[test]
    fn the_monitor_view_matches_the_ts() {
        let views = &crate::phone::policy().views;
        assert_eq!(views.monitor_sources.len(), 7);
        let view = monitor(&sources(), 10_000.0, views);
        let text = view.to_string();
        for leak in ["secret", "Ryzen", "RTX", "NVIDIA", "rm -rf", "/Users/"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
        assert_eq!(
            view["hardware"],
            json!({
                "cpu": { "loadPct": 42.5, "cores": 16, "tempC": 71 },
                "memory": { "usedMB": 20000, "totalMB": 65536, "tempC": 48 },
                "gpu": { "memoryUsedMB": 9100, "memoryTotalMB": 36852, "loadPct": 87, "tempC": 70 }
            })
        );
        assert_eq!(
            view["running"],
            json!([
                { "id": "a", "title": "Fix the build", "step": "approval", "elapsedMs": 9000 },
                { "id": "b", "title": "T".repeat(views.monitor.label_chars), "step": "working", "elapsedMs": 1000 },
                { "id": "gone", "title": "", "step": "working" }
            ])
        );
        assert_eq!(
            view["needsYou"],
            json!([
                { "sessionId": "c", "title": "Idle", "kind": "question", "callId": "q-1", "label": "Which auth method?", "count": 1, "since": 300 },
                { "sessionId": "a", "title": "Fix the build", "kind": "approval", "callId": "call-1", "risk": "high", "label": "bash", "since": 500 }
            ])
        );
        let autos = view["automations"].as_array().unwrap();
        assert_eq!(autos.len(), views.monitor.automations);
        assert_eq!(
            autos[..3],
            [
                json!({ "kind": "workflow", "id": "w1", "name": "Deploy", "nextRunAt": 20000 }),
                json!({ "kind": "task", "id": "t1", "name": "Nightly", "nextRunAt": 50000 }),
                json!({ "kind": "task", "id": "r0", "name": "R0", "nextRunAt": 60000 })
            ]
        );
        assert_eq!(monitor(&sources(), 0.0, views)["running"][0]["elapsedMs"], json!(0));
    }

    #[test]
    fn an_empty_computer_has_empty_rows() {
        let views = &crate::phone::policy().views;
        assert_eq!(
            monitor(&Map::new(), 0.0, views),
            json!({
                "hardware": { "cpu": { "loadPct": 0, "cores": 0 }, "memory": { "usedMB": 0, "totalMB": 0 }, "gpu": null },
                "running": [], "needsYou": [], "automations": []
            })
        );
        let only = json!({ "system:stats": { "temps": { "gpuC": 55 } } });
        assert_eq!(monitor(only.as_object().unwrap(), 0.0, views)["hardware"]["gpu"], json!({ "tempC": 55 }));
    }
}
