//! Training and goal runs (`packages/host/src/training.ts`): one engine drives
//! both the Training tab (train a model for a purpose) and the Goals tab
//! (plan first, then execute and iterate until the goal is finished). A run
//! owns a chat; each turn is a normal chat turn whose agent reports
//! experiments (`report_experiment`), artifacts (`report_artifact`) and, for
//! a goal, its plan (`update_plan`), all handled here. Hints the user adds
//! mid-run are folded into the next turn. State is `training.json`; this
//! process is its only writer.
//!
//! A turn's first half (the guards, the hints it consumes, the turn count)
//! happens before the call that started it returns, as the TS `tickRun` ran
//! synchronously up to its `await sendChat`: [`Training::begin`]. The send and
//! what follows it are [`Training::finish`].

use crate::json::{self, cmp_numbers, num};
use nekko_js as js;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The pause between one turn's end and the next.
pub const TURN_DELAY: Duration = Duration::from_millis(4_000);
const MAX_LOG: usize = 400;
/// Only the last few turn groups are replayed to the model each turn.
const RUN_HISTORY_TURNS: u32 = 4;
const STALL_LIMIT: f64 = 8.0;
const ERROR_LIMIT: f64 = 5.0;
/// `RUN_MAX_TURNS_DEFAULT`.
const DEFAULT_MAX_TURNS: f64 = 400.0;
/// `RUN_DONE_TOKEN`: what a run's agent ends its reply with once finished.
pub const RUN_DONE_TOKEN: &str = "\u{27e6}RUN_DONE\u{27e7}";

/// The channels this service serves for the UI.
pub const CHANNELS: &[&str] = &[
    "training:list",
    "training:create",
    "training:update",
    "training:delete",
    "training:start",
    "training:pause",
    "training:stop",
    "training:hint",
];

/// The run tools as a channel (`training:tool`); a daemon-driven turn calls
/// them directly.
pub const TOOL_CHANNEL: &str = "training:tool";

/// What a run needs from the rest of the engine.
pub trait TrainingHost: Send + Sync + 'static {
    /// The user's settings (`defaultProviderId`, `defaultModelId`).
    fn settings(&self) -> BoxFut<'_, Value>;
    /// `createSession(workspaceId)`, then each field assigned in order and saved.
    fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> BoxFut<'_, Result<String, String>>;
    fn get_session(&self, id: &str) -> Option<Value>;
    fn delete_session(&self, id: &str) -> BoxFut<'_, ()>;
    /// `sendChat(opts)`: resolves when the turn is over.
    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<(), String>>;
    /// The runs changed (`training:updated`, with the runs as saved).
    fn notify(&self, runs: &Value);
}

/// `Date.now()`; tests pass a fixed clock.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
/// `randomUUID()`; tests pass a counter.
pub type Ids = Arc<dyn Fn() -> String + Send + Sync>;

/// A turn whose first half has run: what [`Training::finish`] sends.
pub struct Prepared {
    pub id: String,
    session_id: String,
    hints: usize,
    pub opts: Value,
}

pub struct Training {
    file: PathBuf,
    host: Arc<dyn TrainingHost>,
    clock: Clock,
    ids: Ids,
    in_flight: Mutex<HashSet<String>>,
    /// Read-modify-write of the file, one at a time.
    io: Mutex<()>,
    /// Tests re-arm by hand: the runs whose next turn is due, in arming order.
    manual: Option<Mutex<Vec<String>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// `${v}` of a value that may be absent (`undefined`).
fn show(v: Option<&Value>) -> String {
    v.map(js::display).unwrap_or_else(|| "undefined".into())
}

fn truthy(v: Option<&Value>) -> bool {
    js::truthy(v)
}

fn list_of(v: &Value, k: &str) -> Vec<Value> {
    v.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `a ?? 0` as a number.
fn count(v: Option<&Value>) -> f64 {
    if js::nullish(v) { 0.0 } else { js::to_number(v) }
}

fn n(x: f64) -> Value {
    num(x)
}

/// A trimmed non-empty string argument, cut to `max` UTF-16 units.
fn trimmed(input: &Value, k: &str, max: usize) -> Option<String> {
    match input.get(k) {
        Some(Value::String(s)) if !js::trim(s).is_empty() => Some(js::slice16(js::trim(s), max).to_string()),
        _ => None,
    }
}

/// `s.replace(token, '')`: the first occurrence only.
fn drop_first(s: &str, token: &str) -> String {
    s.replacen(token, "", 1)
}

fn plan_counts(plan: Option<&Value>) -> (usize, usize, usize) {
    let steps = plan.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let done = steps.iter().filter(|s| str_of(s, "status") == Some("done")).count();
    let skipped = steps.iter().filter(|s| str_of(s, "status") == Some("skipped")).count();
    (steps.len(), done, skipped)
}

/// `isBetterScore(candidate, incumbent, minimize)`.
fn is_better(candidate: f64, incumbent: Option<&Value>, minimize: bool) -> bool {
    if js::nullish(incumbent) {
        return true;
    }
    let inc = js::to_number(incumbent);
    if minimize { candidate < inc } else { candidate > inc }
}

fn minimize(run: &Value) -> bool {
    truthy(run.get("config").and_then(|c| c.get("minimizeMetric")))
}

/// `bestExperiment(run)`: the index of the best scored experiment.
fn best_experiment(run: &Value) -> Option<usize> {
    let exps = run.get("experiments").and_then(Value::as_array)?;
    let min = minimize(run);
    let mut best: Option<usize> = None;
    for (i, e) in exps.iter().enumerate() {
        if js::nullish(e.get("score")) {
            continue;
        }
        let score = js::to_number(e.get("score"));
        if best.is_none_or(|b| is_better(score, exps[b].get("score"), min)) {
            best = Some(i);
        }
    }
    best
}

/// `runStats(run, now).runtimeMs`.
fn runtime_ms(run: &Value, now: f64) -> f64 {
    let live = if str_of(run, "status") == Some("running") && truthy(run.get("startedAt")) {
        now - js::to_number(run.get("startedAt"))
    } else {
        0.0
    };
    count(run.get("runtimeMs")) + live
}

/// `runFolderSlug(run)`.
fn run_folder_slug(run: &Value) -> String {
    let name = show(run.get("name"));
    let kept: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ' ')).collect();
    let slug = js::trim(js::slice16(&kept, 30)).to_string();
    if slug.is_empty() { js::slice16(&show(run.get("id")), 8).to_string() } else { slug }
}

/// `runOutputDir(run)`.
pub fn run_output_dir(run: &Value) -> String {
    let root = if str_of(run, "kind") == Some("goal") { "nekko-goal" } else { "nekko-training" };
    format!("{root}/{}", run_folder_slug(run))
}

/// `progressSignature(run)`: plan completion and each step's status, and
/// each experiment's status and score.
pub fn progress_signature(run: &Value) -> String {
    let plan = run.get("plan");
    let (total, done, skipped) = plan_counts(plan);
    let steps = plan.and_then(Value::as_array).cloned().unwrap_or_default();
    let plan_sig: Vec<String> =
        steps.iter().map(|s| format!("{}:{}", show(s.get("id")), show(s.get("status")))).collect();
    let exps = list_of(run, "experiments");
    let exp_sig: Vec<String> = exps
        .iter()
        .map(|e| {
            let score = if js::nullish(e.get("score")) { String::new() } else { show(e.get("score")) };
            format!("{}:{}:{score}", show(e.get("id")), show(e.get("status")))
        })
        .collect();
    format!("{}/{total}|{}|{}|{}", done + skipped, plan_sig.join(","), exps.len(), exp_sig.join(","))
}

/// `outputSignature(text)`: a cheap fingerprint of a turn's final answer.
pub fn output_signature(text: &str) -> String {
    let folded = js::fold_space(&drop_first(text, RUN_DONE_TOKEN));
    let norm = js::trim(&folded);
    format!("{}:{}", js::len16(norm), js::slice16(norm, 240))
}

/// `planBrief(run)`.
fn plan_brief(run: &Value) -> String {
    let steps = run.get("plan").and_then(Value::as_array).cloned().unwrap_or_default();
    if steps.is_empty() {
        return "No plan yet. Build one with update_plan (replace=true) before doing any execution work.".into();
    }
    let (total, done, skipped) = plan_counts(run.get("plan"));
    let lines: Vec<String> = steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let note = if truthy(s.get("note")) { format!(" ({})", show(s.get("note"))) } else { String::new() };
            format!("{}. [{}] {}{note}", i + 1, show(s.get("status")), show(s.get("title")))
        })
        .collect();
    let skipped = if skipped > 0 { format!(" ({skipped} skipped)") } else { String::new() };
    format!("Plan, {done}/{total} done{skipped}:\n{}", lines.join("\n"))
}

/// `treeBrief(run)`.
fn tree_brief(run: &Value) -> String {
    let exps = list_of(run, "experiments");
    if exps.is_empty() {
        return "No experiments recorded yet.".into();
    }
    let best_id = run.get("bestExperimentId");
    let lines: Vec<String> = exps[exps.len().saturating_sub(40)..]
        .iter()
        .map(|e| {
            let score =
                if js::nullish(e.get("score")) { String::new() } else { format!(" score={}", show(e.get("score"))) };
            let parent =
                if truthy(e.get("parentId")) { format!(" parent={}", show(e.get("parentId"))) } else { String::new() };
            let star = if e.get("id") == best_id { " \u{2605}leader" } else { "" };
            let note = if truthy(e.get("note")) { format!(": {}", show(e.get("note"))) } else { String::new() };
            format!(
                "- {}{parent} [{}]{score}{star} {}{note}",
                show(e.get("id")),
                show(e.get("status")),
                show(e.get("title"))
            )
        })
        .collect();
    let best = best_experiment(run).map(|i| show(exps[i].get("score"))).unwrap_or_else(|| "n/a".into());
    let finished: Vec<&Value> =
        exps.iter().filter(|e| matches!(str_of(e, "status"), Some("succeeded" | "failed" | "repaired"))).collect();
    let ok = finished.iter().filter(|e| matches!(str_of(e, "status"), Some("succeeded" | "repaired"))).count();
    let rate = if finished.is_empty() {
        "n/a".to_string()
    } else {
        format!("{}%", js::number_to_string((ok as f64 / finished.len() as f64 * 100.0).round()))
    };
    format!("{} experiments so far (best={best}, success rate={rate}):\n{}", exps.len(), lines.join("\n"))
}

/// `turnPrompt(run, hints)`: the per-turn brief for a run's agent.
pub fn turn_prompt(run: &Value, hints: &[String]) -> String {
    let empty = json!({});
    let cfg = match run.get("config") {
        Some(c) if !c.is_null() => c,
        _ => &empty,
    };
    let c = |k: &str| cfg.get(k);
    let mut parts: Vec<String> = Vec::new();
    // `(run.turns ?? 0) === 0`.
    let first = js::coalesce(run.get("turns"), None).is_none_or(|t| t.as_f64() == Some(0.0));
    let kind = str_of(run, "kind");
    let goal = show(run.get("goal"));
    if first {
        if kind == Some("training") {
            parts.push("You are Nekko Agent's data-scientist agent. Your job is to actually train a model for this purpose, working hands-on in the workspace (write code, run it with the bash tool, prefer Python; set up a venv or use available tooling; install packages as needed).".into());
            parts.push(format!("PURPOSE: {goal}"));
            if let Some(d) = c("dataset").filter(|d| truthy(Some(d))) {
                let split =
                    if truthy(d.get("split")) { format!(" (split: {})", show(d.get("split"))) } else { String::new() };
                let how = match str_of(d, "source") {
                    Some("huggingface") => ". Load via the datasets library.",
                    Some("kaggle") => {
                        ". Download via the kaggle CLI (needs KAGGLE_* creds; if missing, say so in a report note and continue with an alternative if possible)."
                    }
                    _ => "",
                };
                parts.push(format!("DATASET: {}:{}{split}{how}", show(d.get("source")), show(d.get("id"))));
            }
            if let Some(b) = c("baseModel").filter(|b| truthy(Some(b)) && str_of(b, "source") != Some("none")) {
                let id = if js::nullish(b.get("id")) { String::new() } else { show(b.get("id")) };
                parts.push(format!(
                    "BASE MODEL: {}:{id}. Start from it (fine-tune / adapt) where sensible, but compare against a simpler baseline.",
                    show(b.get("source"))
                ));
            }
            let mut levers: Vec<String> = Vec::new();
            if truthy(c("framework")) && str_of(cfg, "framework") != Some("auto") {
                levers.push(format!("framework={}", show(c("framework"))));
            }
            if truthy(c("epochs")) {
                levers.push(format!("epochs\u{2248}{}", show(c("epochs"))));
            }
            if truthy(c("batchSize")) {
                levers.push(format!("batch={}", show(c("batchSize"))));
            }
            if truthy(c("learningRate")) {
                levers.push(format!("lr\u{2248}{}", show(c("learningRate"))));
            }
            if !levers.is_empty() {
                parts
                    .push(format!("EXPERT LEVERS: {} (treat as strong defaults, note deviations).", levers.join(", ")));
            }
            if truthy(c("metric")) {
                let dir = if truthy(c("minimizeMetric")) { " (lower is better)" } else { " (higher is better)" };
                parts.push(format!(
                    "METRIC: optimize {}{dir}; measure with cross-validation or a held-out split.",
                    show(c("metric"))
                ));
            }
            let h = match c("harness") {
                Some(h) if !h.is_null() => h.clone(),
                _ => json!({}),
            };
            let mut artifacts: Vec<&str> = Vec::new();
            if truthy(h.get("agentsMd")) {
                artifacts.push("an AGENTS.md agent file describing how an agent should use the model");
            }
            if truthy(h.get("skill")) {
                artifacts.push("a SKILL.md skill wrapping common usage");
            }
            if truthy(h.get("spec")) {
                artifacts.push("a SPEC.md describing the model, its data, metrics, and intended use");
            }
            if !artifacts.is_empty() {
                parts.push(format!(
                    "HARNESS: when the run completes, also produce {} in the output folder, tailored to the purpose.",
                    artifacts.join("; ")
                ));
            }
            let max_exp = if truthy(c("maxExperiments")) {
                format!(", or you have exhausted ~{} experiments", show(c("maxExperiments")))
            } else {
                String::new()
            };
            let budget = if truthy(c("timeBudgetMin")) {
                format!(", or the ~{} minute budget", show(c("timeBudgetMin")))
            } else {
                String::new()
            };
            parts.push(format!(
                "RULES: (1) Work in small, measurable experiments. Call report_experiment when an attempt STARTS (status \"running\") and when it ENDS (succeeded/failed/repaired, with score when measurable), using parent_id to show what you branched from and \"approach\" to name the idea family. (2) If something breaks, fix it and mark the experiment \"repaired\" rather than silently retrying. (3) Keep every artifact in the \"{}\" folder in the workspace, and the moment one exists on disk call report_artifact for it (kind \"model\" for the trained model itself, plus each harness file you produce) so the user can see what was built. (4) Between turns you lose nothing: this chat keeps your context. (5) When the purpose is fulfilled (model trained, artifacts written AND registered via report_artifact){max_exp}{budget}, summarize the outcome and end your reply with {RUN_DONE_TOKEN}.",
                run_output_dir(run)
            ));
            if truthy(c("extra")) {
                parts.push(format!("EXPERT NOTES: {}", show(c("extra"))));
            }
            parts.push("Start now: profile the task, form a short plan, and run your first experiments.".into());
        } else {
            parts.push("You are Nekko Agent's goal agent. You own a long-running goal and drive it to FINISHED, working hands-on in the workspace with your tools. You work in three phases: PLAN first, then EXECUTE, then ITERATE until it is genuinely done.".into());
            parts.push(format!("GOAL: {goal}"));
            parts.push("PHASE 1, PLAN FIRST: investigate the goal and the workspace, then call update_plan (replace=true) with an ordered list of 4-12 concrete, independently verifiable steps that take the goal to finished. Do this before any execution work.".into());
            parts.push("PHASE 2, EXECUTE: work the plan step by step. Mark the step you start \"active\"; mark it \"done\" the moment it is verifiably complete, with a one-line note of the outcome. Never claim a step is done without having verified it.".into());
            parts.push("PHASE 3, ITERATE: when reality disagrees with the plan (a step fails, new work surfaces, the approach is wrong), revise the plan via update_plan (upsert steps, or replace=true to rewrite it) and keep executing. Repeat until every step is done or skipped AND the goal itself is verifiably met.".into());
            let budget = if truthy(c("timeBudgetMin")) {
                format!(", or when the ~{} minute budget is exhausted", show(c("timeBudgetMin")))
            } else {
                String::new()
            };
            parts.push(format!(
                "RULES: (1) The plan is the contract; keep step statuses current via update_plan every turn. (2) When an attempt is worth measuring, you may also record it with report_experiment. (3) If something breaks, fix it; note blockers on the affected step. (4) Keep new artifacts in a \"{}\" folder in the workspace unless the goal is about existing files, and call report_artifact for each concrete deliverable you produce so it shows on the dashboard. (5) Between turns you lose nothing: this chat keeps your context. (6) End your reply with {RUN_DONE_TOKEN} only when the goal is genuinely finished and verified, never merely planned{budget}.",
                run_output_dir(run)
            ));
            if truthy(c("extra")) {
                parts.push(format!("CONTEXT & CONSTRAINTS FROM THE USER: {}", show(c("extra"))));
            }
            parts.push(
                "Start now: study the goal, then write the plan with update_plan before executing anything.".into(),
            );
        }
    } else if kind == Some("goal") {
        parts.push("Continue working toward this goal until it is verifiably finished.".into());
        parts.push(format!("GOAL: {goal}"));
        if truthy(c("extra")) {
            parts.push(format!("CONSTRAINTS: {}", show(c("extra"))));
        }
        parts.push(plan_brief(run));
        if !list_of(run, "experiments").is_empty() {
            parts.push(format!("Experiment tree:\n{}", tree_brief(run)));
        }
        parts.push(format!("Do the next concrete work now (don't just re-plan): mark the step you start \"active\" via update_plan, and \"done\" with a one-line note once you have VERIFIED it. Revise the plan only when reality demands it. End your reply with {RUN_DONE_TOKEN} only when every step is done or skipped and the goal is verifiably met, never merely planned."));
    } else {
        parts.push("Continue the run toward its purpose until met.".into());
        parts.push(format!("PURPOSE: {goal}"));
        if truthy(c("extra")) {
            parts.push(format!("CONSTRAINTS: {}", show(c("extra"))));
        }
        parts.push(format!("Current experiment tree:\n{}", tree_brief(run)));
        parts.push(format!("Push the leader further: iterate on what works, branch new idea families when progress stalls, repair failures. Keep calling report_experiment. End with {RUN_DONE_TOKEN} only when the purpose is genuinely met or budgets are exhausted."));
    }
    if !hints.is_empty() {
        let lines: Vec<String> = hints.iter().map(|h| format!("- {h}")).collect();
        parts.push(format!(
            "USER GUIDANCE (fold these into your next experiments; acknowledge each):\n{}",
            lines.join("\n")
        ));
    }
    parts.join("\n\n")
}

/// `log(run, kind, text)`: append, keeping the last [`MAX_LOG`] entries.
fn log(run: &mut Map<String, Value>, at: f64, kind: &str, text: String) {
    let entry = json!({ "at": n(at), "kind": kind, "text": text });
    match run.get_mut("log") {
        Some(Value::Array(log)) => {
            log.push(entry);
            if log.len() > MAX_LOG {
                let extra = log.len() - MAX_LOG;
                log.drain(..extra);
            }
        }
        _ => {
            // `run.log.push` on a run without a log threw in the TS; start one instead.
            run.insert("log".into(), json!([entry]));
        }
    }
}

/// `stopClock(run)`: fold the elapsed running time into `runtimeMs`.
fn stop_clock(run: &mut Map<String, Value>, now: f64) {
    if truthy(run.get("startedAt")) {
        let total = count(run.get("runtimeMs")) + (now - js::to_number(run.get("startedAt")));
        run.insert("runtimeMs".into(), n(total));
        run.shift_remove("startedAt");
    }
}

fn id_of(r: &Value) -> Option<&str> {
    r.get("id").and_then(Value::as_str)
}

impl Training {
    pub fn new(data_dir: impl Into<PathBuf>, host: Arc<dyn TrainingHost>, clock: Clock, ids: Ids) -> Arc<Self> {
        Self::build(data_dir.into(), host, clock, ids, false)
    }

    /// A service whose re-armed turns wait for [`Training::take_armed`] (tests).
    pub fn with_manual_timers(
        data_dir: impl Into<PathBuf>,
        host: Arc<dyn TrainingHost>,
        clock: Clock,
        ids: Ids,
    ) -> Arc<Self> {
        Self::build(data_dir.into(), host, clock, ids, true)
    }

    fn build(dir: PathBuf, host: Arc<dyn TrainingHost>, clock: Clock, ids: Ids, manual: bool) -> Arc<Self> {
        Arc::new(Self {
            file: dir.join("training.json"),
            host,
            clock,
            ids,
            in_flight: Mutex::default(),
            io: Mutex::new(()),
            manual: manual.then(Mutex::default),
        })
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn load(&self) -> Vec<Value> {
        match json::read_json(&self.file) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        }
    }

    fn save(&self, runs: &[Value]) -> Result<(), String> {
        let v = Value::Array(runs.to_vec());
        json::write_json(&self.file, &v).map_err(|e| format!("could not save the training runs: {e}"))?;
        self.host.notify(&v);
        Ok(())
    }

    /// `persistRun(id, mutate)`: re-read, change one run, stamp it, save.
    fn persist(&self, id: &str, mutate: impl FnOnce(&mut Map<String, Value>)) -> Option<Value> {
        let _io = lock(&self.io);
        let mut runs = self.load();
        let i = runs.iter().position(|r| id_of(r) == Some(id))?;
        let Value::Object(run) = &mut runs[i] else { return None };
        mutate(run);
        run.insert("updatedAt".into(), n(self.now()));
        let out = runs[i].clone();
        if let Err(e) = self.save(&runs) {
            eprintln!("nekkod: {e}");
        }
        Some(out)
    }

    /// `listTrainingRuns()`: newest first.
    pub fn list(&self) -> Vec<Value> {
        let mut runs = {
            let _io = lock(&self.io);
            self.load()
        };
        runs.sort_by(|a, b| cmp_numbers(js::to_number(b.get("createdAt")), js::to_number(a.get("createdAt"))));
        runs
    }

    /// `createTrainingRun(input)`: the run and its chat.
    pub async fn create(&self, input: &Value) -> Result<Value, String> {
        let now = self.now();
        let id = (self.ids)();
        let settings = self.host.settings().await;
        let kind = input.get("kind").cloned();
        let name = match input.get("name") {
            Some(Value::String(s)) if !js::trim(s).is_empty() => js::trim(s).to_string(),
            _ => {
                let goal = match input.get("goal") {
                    Some(Value::String(g)) => js::slice16(g, 48).to_string(),
                    _ => return Err("Cannot read properties of undefined (reading 'slice')".into()),
                };
                if !goal.is_empty() {
                    goal
                } else if kind.as_ref().and_then(Value::as_str) == Some("goal") {
                    "New goal".into()
                } else {
                    "New training run".into()
                }
            }
        };
        let mut fields: Vec<(&'static str, Value)> = vec![("title", json!(name)), ("trainingRunId", json!(id))];
        if let Some(p) = js::coalesce(input.get("providerId"), settings.get("defaultProviderId")) {
            fields.push(("providerId", p.clone()));
        }
        if let Some(m) = js::coalesce(input.get("modelId"), settings.get("defaultModelId")) {
            fields.push(("modelId", m.clone()));
        }
        let session = self.host.create_session(input.get("workspaceId").cloned(), fields).await?;
        let mut run = Map::new();
        run.insert("id".into(), json!(id));
        if let Some(k) = kind {
            run.insert("kind".into(), k);
        }
        run.insert("name".into(), json!(name));
        if let Some(g) = input.get("goal") {
            run.insert("goal".into(), g.clone());
        }
        run.insert("status".into(), json!("draft"));
        run.insert("config".into(), js::coalesce(input.get("config"), None).cloned().unwrap_or_else(|| json!({})));
        if let Some(a) = input.get("approachId") {
            run.insert("approachId".into(), a.clone());
        }
        run.insert("sessionId".into(), json!(session));
        if let Some(w) = input.get("workspaceId") {
            run.insert("workspaceId".into(), w.clone());
        }
        run.insert("experiments".into(), json!([]));
        run.insert("artifacts".into(), json!([]));
        run.insert("hints".into(), json!([]));
        run.insert("log".into(), json!([{ "at": n(now), "kind": "info", "text": "Run created." }]));
        run.insert("createdAt".into(), n(now));
        run.insert("updatedAt".into(), n(now));
        run.insert("turns".into(), json!(0));
        let run = Value::Object(run);
        {
            let _io = lock(&self.io);
            let mut runs = self.load();
            runs.push(run.clone());
            self.save(&runs)?;
        }
        Ok(run)
    }

    /// `updateTrainingRun(id, patch)`: only the user-editable fields.
    pub fn update(&self, id: &str, patch: &Value) -> Vec<Value> {
        self.persist(id, |run| {
            for key in ["name", "goal", "config", "approachId", "workspaceId"] {
                if let Some(v) = patch.get(key) {
                    run.insert(key.into(), v.clone());
                }
            }
        });
        self.list()
    }

    /// `deleteTrainingRun(id)`: drops the run's chat too if it never produced anything.
    pub async fn delete(&self, id: &str) -> Result<Vec<Value>, String> {
        let runs = {
            let _io = lock(&self.io);
            self.load()
        };
        let sid =
            runs.iter().find(|r| id_of(r) == Some(id)).and_then(|r| r.get("sessionId")).filter(|v| truthy(Some(v)));
        if let Some(sid) = sid.map(js::display)
            && let Some(s) = self.host.get_session(&sid)
            && s.get("messages").and_then(Value::as_array).is_some_and(Vec::is_empty)
        {
            let sid = s.get("id").and_then(Value::as_str).unwrap_or(&sid).to_string();
            self.host.delete_session(&sid).await;
        }
        {
            let _io = lock(&self.io);
            let keep: Vec<Value> = runs.into_iter().filter(|r| id_of(r) != Some(id)).collect();
            self.save(&keep)?;
        }
        Ok(self.list())
    }

    /// The first half of `startTrainingRun(id)`: whether the run exists.
    pub fn mark_started(&self, id: &str) -> bool {
        let now = self.now();
        self.persist(id, |r| {
            if r.get("status").and_then(Value::as_str) == Some("running") {
                return;
            }
            r.insert("status".into(), json!("running"));
            r.insert("startedAt".into(), n(now));
            let fresh = !truthy(r.get("endedAt")) && r.get("turns").and_then(Value::as_f64) == Some(0.0);
            log(r, now, "info", if fresh { "Run started." } else { "Run resumed." }.into());
            r.shift_remove("endedAt");
            r.insert("stallTurns".into(), json!(0));
            r.insert("errorTurns".into(), json!(0));
            let cap = js::coalesce(r.get("config").and_then(|c| c.get("maxTurns")), None)
                .map_or(DEFAULT_MAX_TURNS, |v| js::to_number(Some(v)));
            let turns = count(r.get("turns"));
            if turns >= cap {
                let mut config = Map::new();
                if let Some(c) = js::coalesce(r.get("config"), None) {
                    js::spread_into(&mut config, c);
                }
                config.insert("maxTurns".into(), n(turns + DEFAULT_MAX_TURNS));
                r.insert("config".into(), Value::Object(config));
            }
        })
        .is_some()
    }

    /// `pauseTrainingRun(id)`.
    pub fn pause(&self, id: &str) -> Vec<Value> {
        let now = self.now();
        self.persist(id, |r| {
            if r.get("status").and_then(Value::as_str) != Some("running") {
                return;
            }
            stop_clock(r, now);
            r.insert("status".into(), json!("paused"));
            log(r, now, "info", "Run paused. The current iteration finishes, then the agent stops.".into());
        });
        self.list()
    }

    /// `stopTrainingRun(id)`.
    pub fn stop(&self, id: &str) -> Vec<Value> {
        let now = self.now();
        self.persist(id, |r| {
            if matches!(r.get("status").and_then(Value::as_str), Some("completed" | "stopped")) {
                return;
            }
            stop_clock(r, now);
            r.insert("status".into(), json!("stopped"));
            r.insert("endedAt".into(), n(now));
            log(r, now, "info", "Run stopped by the user.".into());
        });
        self.list()
    }

    /// `addTrainingHint(id, text)`.
    pub fn hint(&self, id: &str, text: &str) -> Vec<Value> {
        let trimmed = js::trim(text).to_string();
        if !trimmed.is_empty() {
            let now = self.now();
            // The TS drew the hint's id inside the update, after the file was read.
            let ids = self.ids.clone();
            self.persist(id, |r| {
                let hint_id = ids();
                let h = json!({ "id": hint_id, "text": trimmed, "at": n(now) });
                match r.get_mut("hints") {
                    Some(Value::Array(a)) => a.push(h),
                    _ => {
                        r.insert("hints".into(), json!([h]));
                    }
                }
                log(r, now, "hint", format!("Hint queued: {}", js::slice16(&trimmed, 120)));
                r.insert("stallTurns".into(), json!(0));
            });
        }
        self.list()
    }

    fn run_for_session(runs: &[Value], session_id: &str) -> Option<usize> {
        runs.iter().position(|r| str_of(r, "sessionId") == Some(session_id))
    }

    /// `reportExperiment(sessionId, input)`.
    pub fn report_experiment(&self, session_id: &str, input: &Value) -> Result<String, String> {
        let _io = lock(&self.io);
        let mut runs = self.load();
        let Some(i) = Self::run_for_session(&runs, session_id) else {
            return Ok("No active run is linked to this session; the experiment was not recorded.".into());
        };
        let now = self.now();
        let status = match input.get("status") {
            None | Some(Value::Null) => "running".to_string(),
            Some(v) => js::display(v),
        };
        const VALID: &[&str] = &["planned", "running", "succeeded", "failed", "repaired"];
        if !VALID.contains(&status.as_str()) {
            return Ok(format!("Unknown status \"{status}\". Use one of: {}.", VALID.join(", ")));
        }
        let Value::Object(run) = &mut runs[i] else { return Ok(String::new()) };
        let min = truthy(run.get("config").and_then(|c| c.get("minimizeMetric")));
        if !run.get("experiments").is_some_and(Value::is_array) {
            run.insert("experiments".into(), json!([]));
        }
        let exps_len = run["experiments"].as_array().map_or(0, Vec::len);
        let id = match input.get("id") {
            Some(Value::String(s)) if !js::trim(s).is_empty() => js::trim(s).to_string(),
            _ => format!("exp_{}", exps_len + 1),
        };
        let exps = run.get_mut("experiments").and_then(Value::as_array_mut).expect("set above");
        let ni = match exps.iter().position(|e| id_of(e) == Some(id.as_str())) {
            Some(ni) => ni,
            None => {
                exps.push(json!({ "id": id, "title": "", "status": status, "createdAt": n(now), "updatedAt": n(now) }));
                exps.len() - 1
            }
        };
        {
            let node = exps[ni].as_object_mut().expect("an experiment");
            let title = js::coalesce(input.get("title"), js::coalesce(node.get("title"), None))
                .map(js::display)
                .unwrap_or_else(|| id.clone());
            node.insert("title".into(), json!(js::slice16(&title, 120)));
            node.insert("status".into(), json!(status));
            node.insert("updatedAt".into(), n(now));
            if let Some(Value::String(p)) = input.get("parent_id")
                && !js::trim(p).is_empty()
                && p != &id
            {
                node.insert("parentId".into(), json!(js::trim(p)));
            }
            for (k, max) in [("approach", 60), ("metric", 40), ("note", 300)] {
                if let Some(v) = trimmed(input, k, max) {
                    node.insert(k.into(), json!(v));
                }
            }
        }
        let exps_now = run["experiments"].as_array().cloned().unwrap_or_default();
        let node = exps_now[ni].clone();
        let leader_before: Option<Value> = if truthy(run.get("bestExperimentId")) {
            let best = run.get("bestExperimentId").cloned();
            exps_now.iter().find(|e| e.get("id") == best.as_ref()).cloned()
        } else {
            best_experiment(&Value::Object(run.clone())).map(|b| exps_now[b].clone())
        };
        let title = show(node.get("title"));
        let reply = match input.get("score").and_then(Value::as_f64) {
            Some(score) => {
                let shown = js::number_to_string(score);
                if let Some(Value::Object(node)) = run.get_mut("experiments").and_then(|e| e.get_mut(ni)) {
                    node.insert("score".into(), input["score"].clone());
                }
                let leads = match &leader_before {
                    None => true,
                    Some(l) => l.get("id") == node.get("id") || is_better(score, l.get("score"), min),
                };
                if leads {
                    run.insert("bestExperimentId".into(), node.get("id").cloned().unwrap_or(Value::Null));
                    let metric = if truthy(node.get("metric")) {
                        format!(" ({})", show(node.get("metric")))
                    } else {
                        String::new()
                    };
                    log(run, now, "milestone", format!("New leader: {title} scored {shown}{metric}."));
                    format!("Recorded {id}. It is the new leader at {shown}.")
                } else {
                    let l = leader_before.as_ref().expect("a leader");
                    log(
                        run,
                        now,
                        "info",
                        format!(
                            "Experiment {id} ({title}) scored {shown}, not better than the leader ({}).",
                            show(l.get("score"))
                        ),
                    );
                    format!(
                        "Recorded {id} at {shown}. Leader remains {} ({}) at {}.",
                        show(l.get("id")),
                        show(l.get("title")),
                        show(l.get("score"))
                    )
                }
            }
            None => {
                if status == "failed" {
                    let note =
                        if truthy(node.get("note")) { format!(": {}", show(node.get("note"))) } else { ".".into() };
                    log(run, now, "error", format!("Experiment {id} ({title}) failed{note}"));
                } else if status == "repaired" {
                    log(run, now, "milestone", format!("Experiment {id} ({title}) was self-repaired."));
                }
                let leader = if truthy(run.get("bestExperimentId")) {
                    let best = run.get("bestExperimentId").cloned();
                    exps_now.iter().find(|e| e.get("id") == best.as_ref()).cloned()
                } else {
                    None
                };
                let lead = match leader.filter(|l| !js::nullish(l.get("score"))) {
                    Some(l) => format!(
                        " Leader is {} ({}) at {}.",
                        show(l.get("id")),
                        show(l.get("title")),
                        show(l.get("score"))
                    ),
                    None => String::new(),
                };
                format!("Recorded {id} ({status}).{lead}")
            }
        };
        run.insert("updatedAt".into(), n(now));
        self.save(&runs)?;
        Ok(reply)
    }

    /// `reportArtifact(sessionId, input)`.
    pub fn report_artifact(&self, session_id: &str, input: &Value) -> Result<String, String> {
        let _io = lock(&self.io);
        let mut runs = self.load();
        let Some(i) = Self::run_for_session(&runs, session_id) else {
            return Ok("No active run is linked to this session; the artifact was not recorded.".into());
        };
        let path = match input.get("path") {
            Some(Value::String(p)) => js::trim(p).to_string(),
            _ => String::new(),
        };
        if path.is_empty() {
            return Ok("Pass the artifact path (relative to the workspace).".into());
        }
        let title = trimmed(input, "title", 120)
            .unwrap_or_else(|| path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string());
        const KINDS: &[&str] = &["model", "agents-md", "skill", "spec", "dataset", "code", "report", "other"];
        let kind = input.get("kind").and_then(Value::as_str).filter(|k| KINDS.contains(k)).unwrap_or("other");
        let note = trimmed(input, "note", 300);
        let now = self.now();
        let Value::Object(run) = &mut runs[i] else { return Ok(String::new()) };
        if !truthy(run.get("artifacts")) {
            run.insert("artifacts".into(), json!([]));
        }
        let arts = run.get_mut("artifacts").and_then(Value::as_array_mut).ok_or("artifacts is not a list")?;
        let found = arts.iter().position(|a| str_of(a, "path") == Some(path.as_str()));
        let is_new = found.is_none();
        let ai = match found {
            Some(ai) => ai,
            None => {
                arts.push(json!({
                    "id": format!("art_{}", arts.len() + 1), "kind": kind, "title": title, "path": path,
                    "createdAt": n(now), "updatedAt": n(now),
                }));
                arts.len() - 1
            }
        };
        if let Value::Object(art) = &mut arts[ai] {
            art.insert("kind".into(), json!(kind));
            art.insert("title".into(), json!(title));
            if let Some(note) = note {
                art.insert("note".into(), json!(note));
            }
            art.insert("updatedAt".into(), n(now));
        }
        if is_new {
            log(run, now, "milestone", format!("Artifact ready: {title} ({path})"));
        }
        run.insert("updatedAt".into(), n(now));
        self.save(&runs)?;
        Ok(format!("Recorded artifact \"{title}\" at {path}. It now shows on the run's Artifacts card."))
    }

    /// `updateRunPlan(sessionId, input)`: `Err` with the message where the TS threw.
    pub fn update_plan(&self, session_id: &str, input: &Value) -> Result<String, String> {
        let _io = lock(&self.io);
        let mut runs = self.load();
        let Some(i) = Self::run_for_session(&runs, session_id) else {
            return Ok("No active run is linked to this session; the plan was not recorded.".into());
        };
        let now = self.now();
        let Value::Object(run) = &mut runs[i] else { return Ok(String::new()) };
        let had_plan = run.get("plan").and_then(Value::as_array).is_some_and(|p| !p.is_empty());
        let current = run.get("plan").cloned();
        let (plan, replaced, finished, skipped_now) =
            match nekko_turn::apply_plan_update(current.as_ref(), input, now as u64) {
                nekko_turn::PlanOutcome::Applied { plan, replaced, finished, skipped_now } => {
                    (plan, replaced, finished, skipped_now)
                }
                nekko_turn::PlanOutcome::Refused(e) => return Ok(e),
                nekko_turn::PlanOutcome::Threw(m) => return Err(m),
            };
        let step_line = |s: &Value| {
            let note = if truthy(s.get("note")) { format!(" ({})", show(s.get("note"))) } else { String::new() };
            format!("{}{note}", show(s.get("title")))
        };
        for s in &finished {
            log(run, now, "milestone", format!("Plan step done: {}", step_line(s)));
        }
        for s in &skipped_now {
            log(run, now, "info", format!("Plan step skipped: {}", step_line(s)));
        }
        let echo = nekko_turn::plan_echo(&plan);
        let steps = plan.len();
        run.insert("plan".into(), Value::Array(plan));
        if replaced {
            if had_plan {
                log(run, now, "info", format!("Plan revised: {steps} steps."));
            } else {
                log(run, now, "milestone", format!("Plan created: {steps} steps."));
            }
        }
        run.insert("updatedAt".into(), n(now));
        self.save(&runs)?;
        Ok(echo)
    }

    /// `runPlanForSession(sessionId)`.
    pub fn plan_for_session(&self, session_id: &str) -> Option<Value> {
        let runs = {
            let _io = lock(&self.io);
            self.load()
        };
        runs.into_iter().find(|r| str_of(r, "sessionId") == Some(session_id)).and_then(|r| r.get("plan").cloned())
    }

    /// A run session's tool (`report_experiment`, `report_artifact`,
    /// `update_plan`): `{ output, plan? }`, or the message where the TS threw.
    pub fn tool(&self, session_id: &str, name: &str, input: &Value) -> Result<Value, String> {
        match name {
            "report_experiment" => self.report_experiment(session_id, input).map(|o| json!({ "output": o })),
            "report_artifact" => self.report_artifact(session_id, input).map(|o| json!({ "output": o })),
            "update_plan" => {
                let output = self.update_plan(session_id, input)?;
                Ok(json!({ "output": output, "plan": self.plan_for_session(session_id) }))
            }
            other => Err(format!("{other} is not a run tool")),
        }
    }

    /// The first half of `tickRun(id)`: the guards, the hints this turn
    /// consumes and the turn count. `None` when no turn starts.
    pub async fn begin(&self, id: &str) -> Option<Prepared> {
        if lock(&self.in_flight).contains(id) {
            return None;
        }
        let run = {
            let _io = lock(&self.io);
            self.load().into_iter().find(|r| id_of(r) == Some(id))
        }?;
        if str_of(&run, "status") != Some("running") {
            return None;
        }
        let settings = self.host.settings().await;
        let session =
            run.get("sessionId").filter(|v| truthy(Some(v))).and_then(|s| self.host.get_session(&js::display(s)));
        let pick = |k: &str, d: &str| js::coalesce(session.as_ref().and_then(|s| s.get(k)), settings.get(d)).cloned();
        let provider = pick("providerId", "defaultProviderId");
        let model = pick("modelId", "defaultModelId");
        let now = self.now();
        let (Some(session), Some(provider), Some(model)) =
            (session, provider.filter(|p| truthy(Some(p))), model.filter(|m| truthy(Some(m))))
        else {
            self.persist(id, |r| {
                r.insert("status".into(), json!("failed"));
                stop_clock(r, now);
                log(
                    r,
                    now,
                    "error",
                    "No model configured. Set a default provider/model in Models, then start the run again.".into(),
                );
            });
            return None;
        };
        let budget = run.get("config").and_then(|c| c.get("timeBudgetMin")).filter(|b| truthy(Some(b))).cloned();
        if let Some(b) = budget
            && runtime_ms(&run, now) >= js::to_number(Some(&b)) * 60_000.0
        {
            self.persist(id, |r| {
                stop_clock(r, now);
                r.insert("status".into(), json!("stopped"));
                r.insert("endedAt".into(), n(now));
                let turns = js::number_to_string(count(r.get("turns")));
                log(
                    r,
                    now,
                    "info",
                    format!(
                        "Stopped: reached the ~{} minute time budget after {turns} turns. Resume to keep going, or raise the budget.",
                        js::display(&b)
                    ),
                );
            });
            return None;
        }
        let cap = js::coalesce(run.get("config").and_then(|c| c.get("maxTurns")), None).cloned();
        let cap_n = cap.as_ref().map_or(DEFAULT_MAX_TURNS, |c| js::to_number(Some(c)));
        if count(run.get("turns")) >= cap_n {
            let shown = cap.as_ref().map_or_else(|| js::number_to_string(DEFAULT_MAX_TURNS), js::display);
            self.persist(id, |r| {
                stop_clock(r, now);
                r.insert("status".into(), json!("stopped"));
                r.insert("endedAt".into(), n(now));
                log(r, now, "error", format!("Stopped at the {shown}-turn safety cap. It hasn't finished on its own, so it may be stuck. Add a hint to redirect it, then Resume (which grants a fresh turn budget)."));
            });
            return None;
        }
        let mut hints: Vec<String> = Vec::new();
        self.persist(id, |r| {
            if let Some(Value::Array(list)) = r.get_mut("hints") {
                for h in list.iter_mut() {
                    if !truthy(h.get("consumedAt"))
                        && let Value::Object(h) = h
                    {
                        h.insert("consumedAt".into(), n(now));
                        hints.push(show(h.get("text")));
                    }
                }
            }
        });
        let fresh = {
            let _io = lock(&self.io);
            self.load().into_iter().find(|r| id_of(r) == Some(id))
        }?;
        let prompt = turn_prompt(&fresh, &hints);
        lock(&self.in_flight).insert(id.to_string());
        self.persist(id, |r| {
            let turns = count(r.get("turns")) + 1.0;
            r.insert("turns".into(), n(turns));
        });
        let session_id = show(session.get("id"));
        Some(Prepared {
            id: id.to_string(),
            hints: hints.len(),
            opts: json!({
                "sessionId": session_id, "providerId": provider, "modelId": model,
                "text": prompt, "maxHistoryTurns": RUN_HISTORY_TURNS,
            }),
            session_id,
        })
    }

    /// The second half of `tickRun`: the turn, what it achieved, and the next turn.
    pub async fn finish(self: &Arc<Self>, p: Prepared) {
        let sent = self.host.send_chat(p.opts.clone()).await;
        let now = self.now();
        let id = p.id.as_str();
        match sent {
            Ok(()) => {
                let done = self.host.get_session(&p.session_id);
                let last = done
                    .as_ref()
                    .and_then(|s| s.get("messages"))
                    .and_then(Value::as_array)
                    .and_then(|m| {
                        m.iter().rev().find(|m| {
                            str_of(m, "role") == Some("assistant")
                                && !js::trim(str_of(m, "content").unwrap_or("")).is_empty()
                        })
                    })
                    .and_then(|m| str_of(m, "content"))
                    .map(str::to_string);
                let finished = last.as_deref().is_some_and(|c| c.contains(RUN_DONE_TOKEN));
                self.persist(id, |r| {
                    r.insert("errorTurns".into(), json!(0));
                    let running = r.get("status").and_then(Value::as_str) == Some("running");
                    if finished {
                        if running {
                            stop_clock(r, now);
                            r.insert("status".into(), json!("completed"));
                            r.insert("endedAt".into(), n(now));
                            let summary = drop_first(last.as_deref().unwrap_or(""), RUN_DONE_TOKEN);
                            let summary = js::slice16(js::trim(&summary), 200).to_string();
                            log(r, now, "milestone", format!("Run completed: {summary}"));
                        }
                        return;
                    }
                    let snapshot = Value::Object(r.clone());
                    let progress = progress_signature(&snapshot);
                    let output = output_signature(last.as_deref().unwrap_or(""));
                    let stalled = p.hints == 0
                        && r.get("lastProgressKey").and_then(Value::as_str) == Some(progress.as_str())
                        && r.get("lastOutputSig").and_then(Value::as_str) == Some(output.as_str());
                    r.insert("lastProgressKey".into(), json!(progress));
                    r.insert("lastOutputSig".into(), json!(output));
                    let stall = if stalled { count(r.get("stallTurns")) + 1.0 } else { 0.0 };
                    r.insert("stallTurns".into(), n(stall));
                    if stall >= STALL_LIMIT && running {
                        stop_clock(r, now);
                        r.insert("status".into(), json!("paused"));
                        r.insert("stallTurns".into(), json!(0));
                        log(r, now, "error", format!("Paused after {} turns with no measurable progress (no plan step completed or revised, and the agent kept repeating itself). Add a hint to redirect it, then Resume.", js::number_to_string(STALL_LIMIT)));
                    }
                });
            }
            Err(e) => {
                self.persist(id, |r| {
                    let errors = count(r.get("errorTurns")) + 1.0;
                    r.insert("errorTurns".into(), n(errors));
                    log(r, now, "error", format!("Iteration failed: {e}"));
                    if errors >= ERROR_LIMIT && r.get("status").and_then(Value::as_str) == Some("running") {
                        stop_clock(r, now);
                        r.insert("status".into(), json!("failed"));
                        r.insert("endedAt".into(), n(now));
                        log(
                            r,
                            now,
                            "error",
                            format!(
                                "Stopped after {} failed turns in a row. Check the model/provider, then Resume.",
                                js::number_to_string(ERROR_LIMIT)
                            ),
                        );
                    }
                });
            }
        }
        lock(&self.in_flight).remove(id);
        let still = {
            let _io = lock(&self.io);
            self.load().into_iter().find(|r| id_of(r) == Some(id))
        };
        if still.as_ref().and_then(|r| str_of(r, "status")) == Some("running") {
            self.arm(id);
        }
    }

    /// Re-arm a run's next turn after [`TURN_DELAY`].
    fn arm(self: &Arc<Self>, id: &str) {
        if let Some(armed) = &self.manual {
            lock(armed).push(id.to_string());
            return;
        }
        let (me, id) = (self.clone(), id.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(TURN_DELAY).await;
            me.tick(&id).await;
        });
    }

    /// One whole turn (`tickRun`), when the run is still running.
    pub async fn tick(self: &Arc<Self>, id: &str) {
        if let Some(p) = self.begin(id).await {
            self.finish(p).await;
        }
    }

    /// With manual timers: the re-armed runs, in order, now cleared.
    pub fn take_armed(&self) -> Vec<String> {
        self.manual.as_ref().map(|m| std::mem::take(&mut *lock(m))).unwrap_or_default()
    }

    /// With manual timers: how many turns are armed.
    pub fn armed(&self) -> usize {
        self.manual.as_ref().map_or(0, |m| lock(m).len())
    }

    /// The first half of `startTrainingScheduler()`: runs that were mid-flight
    /// when the last process stopped are resumed, each turn's first half run.
    pub async fn resume(&self) -> Vec<Prepared> {
        let runs = {
            let _io = lock(&self.io);
            self.load()
        };
        let mut out = Vec::new();
        for run in runs {
            if str_of(&run, "status") != Some("running") {
                continue;
            }
            let Some(id) = id_of(&run).map(str::to_string) else { continue };
            let now = self.now();
            self.persist(&id, |r| {
                r.insert("startedAt".into(), n(now));
                log(r, now, "info", "Host restarted; run resumed automatically.".into());
            });
            if let Some(p) = self.begin(&id).await {
                out.push(p);
            }
        }
        out
    }

    /// Resume what was running, in the background.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            for p in me.resume().await {
                let me = me.clone();
                tokio::spawn(async move { me.finish(p).await });
            }
        });
    }

    /// One IPC channel.
    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        let id = || js::display(arg(0));
        match channel {
            "training:list" => Ok(Value::Array(self.list())),
            "training:create" => self.create(arg(0)).await,
            "training:update" => Ok(Value::Array(self.update(&id(), arg(1)))),
            "training:delete" => self.delete(&id()).await.map(Value::Array),
            "training:start" => {
                let id = id();
                if self.mark_started(&id)
                    && let Some(p) = self.begin(&id).await
                {
                    let me = self.clone();
                    tokio::spawn(async move { me.finish(p).await });
                }
                Ok(Value::Array(self.list()))
            }
            "training:pause" => Ok(Value::Array(self.pause(&id()))),
            "training:stop" => Ok(Value::Array(self.stop(&id()))),
            "training:hint" => Ok(Value::Array(self.hint(&id(), &js::display(arg(1))))),
            TOOL_CHANNEL => {
                let sid = id();
                let name = js::display(arg(1));
                Ok(self.tool(&sid, &name, arg(2)).unwrap_or_else(|e| json!({ "error": e })))
            }
            other => Err(format!("Unknown channel: {other}")),
        }
    }
}
