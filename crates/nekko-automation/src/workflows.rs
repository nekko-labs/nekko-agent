//! The workflow engine (`packages/host/src/workflows.ts` and `listeners.ts`).
//!
//! A run walks a workflow's steps by routing: each step says where control
//! goes on success and on failure, so a verify step can send the run back to
//! build (bounded by [`MAX_STEP_LOOPS`]). Steps are prompts, skills, nested
//! workflows, shell commands and actions; prompt and skill steps share one
//! chat for the whole run and report their outcome with a PASS/FAIL token.
//! Definitions live in `workflows.json`, run history in `workflow-runs.json`
//! (capped per workflow), connector-poll cursors in `workflow-cursors.json`;
//! this process is their only writer.

use crate::json::{self, num};
use crate::workflow_rules::{
    self as rules, MAX_STEP_LOOPS, MAX_WORKFLOW_DEPTH, UNCATEGORIZED, describe_event, event_context, match_workflows,
    read_step_outcome, slugify, step_outcome_instruction,
};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const TICK: Duration = Duration::from_secs(15);
const RUNS_KEPT: usize = 20;
const OUTPUT_KEPT: usize = 4_000;
const DEFAULT_SHELL_TIMEOUT_SEC: f64 = 600.0;
const LISTENER_TICK: Duration = Duration::from_secs(5);
const DEFAULT_POLL_MS: f64 = 60_000.0;
const MAX_SEEN: usize = 200;

/// The channels this engine serves.
pub const CHANNELS: &[&str] = &[
    "workflows:list",
    "workflow:create",
    "workflow:update",
    "workflow:delete",
    "workflow:duplicate",
    "workflow:run",
    "workflow:cancel",
    "workflow:runs",
    "workflow:event",
    // Internal: a webhook the host's listener authenticated by route.
    "workflow:webhook",
];

/// A shell step's result.
#[derive(Clone, Debug, Default)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    /// `exec`'s error message, when the command failed.
    pub error: Option<String>,
    /// Killed by the timeout.
    pub killed: bool,
}

/// What the engine needs from the rest of the daemon.
pub trait WorkflowHost: Send + Sync + 'static {
    fn settings(&self) -> BoxFut<'_, Value>;
    /// `createSession(workspaceId)`, then the fields assigned and saved; the new chat's id.
    fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> BoxFut<'_, Result<String, String>>;
    fn get_session(&self, id: &str) -> Option<Value>;
    /// `getSession(id)`, the fields assigned, `saveSession`: a run's chat
    /// between steps (an allowlist step's tools).
    fn update_session(&self, id: &str, fields: Vec<(&'static str, Value)>) -> BoxFut<'_, Result<(), String>>;
    fn delete_session(&self, id: &str) -> BoxFut<'_, ()>;
    /// A turn: `Ok(Some(message))` when the turn emitted an error event (the
    /// last one), `Err` when it threw.
    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<Option<String>, String>>;
    fn abort_chat(&self, session_id: &str);
    /// The installed skills a skill step can run (`{ id, name, template }`).
    fn skill_defs(&self) -> BoxFut<'_, Vec<Value>>;
    /// `runWorkflowAction(op, config, params, ctx)`: `{ output, isError? }`.
    fn run_action(&self, op: &str, config: Option<Value>, params: Value, ctx: Value) -> BoxFut<'_, Value>;
    /// `exec(cmd, { cwd, timeout })`.
    fn run_shell(&self, cmd: &str, cwd: &str, timeout_ms: f64) -> BoxFut<'_, ShellResult>;
    /// `connector.poll(token, settings, cursor)`, for a kind that has one.
    fn poll(&self, kind: &str, token: &str, settings: Value, cursor: f64) -> BoxFut<'_, Option<Result<Value, String>>>;
    /// `workflows:updated`.
    fn notify(&self, snapshot: &Value);
    /// The local time zone's next cron fire and schedule (the zone is the host's).
    fn next_run(&self, wf: &Value, from: f64) -> Option<f64>;
    /// Node's `path.isAbsolute` and `path.resolve` on this platform.
    fn resolve_path(&self, root: &str, rel: &str) -> String;
}

/// A connector trigger's state: polling now, the ids seen, the last poll.
type Listener = (bool, Vec<String>, f64);

pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
pub type Ids = Arc<dyn Fn() -> String + Send + Sync>;

pub struct Workflows {
    dir: PathBuf,
    host: Arc<dyn WorkflowHost>,
    clock: Clock,
    ids: Ids,
    in_flight: Mutex<HashSet<String>>,
    cancelled: Mutex<HashSet<String>>,
    io: Mutex<()>,
    /// Connector triggers: polling flag, ids seen, last poll.
    listeners: Mutex<HashMap<String, Listener>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str)
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// `a ?? b` over JSON values (missing and `null` both nullish).
fn nullish(a: Option<&Value>) -> Option<&Value> {
    a.filter(|v| !v.is_null())
}

/// `s.slice(-n)` in UTF-16 units, cut at a character boundary.
fn tail16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > n {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

/// `s.slice(0, n)` in UTF-16 units.
fn head16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// A step attempt's outcome.
struct StepResult {
    ok: bool,
    output: Option<String>,
    error: Option<String>,
    session_id: Option<String>,
}

impl StepResult {
    fn fail(error: impl Into<String>) -> Self {
        Self { ok: false, output: None, error: Some(error.into()), session_id: None }
    }
}

impl Workflows {
    pub fn new(data_dir: impl Into<PathBuf>, host: Arc<dyn WorkflowHost>, clock: Clock, ids: Ids) -> Arc<Self> {
        Arc::new(Self {
            dir: data_dir.into(),
            host,
            clock,
            ids,
            in_flight: Mutex::default(),
            cancelled: Mutex::default(),
            io: Mutex::new(()),
            listeners: Mutex::default(),
        })
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn read_list(&self, name: &str) -> Vec<Value> {
        match json::read_json(&self.dir.join(name)) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        }
    }

    fn load_workflows(&self) -> Vec<Value> {
        self.read_list("workflows.json")
    }

    fn load_runs(&self) -> Vec<Value> {
        self.read_list("workflow-runs.json")
    }

    fn write_workflows(&self, list: &[Value]) {
        let _ = json::write_json(&self.dir.join("workflows.json"), &Value::Array(list.to_vec()));
        self.announce();
    }

    fn write_runs(&self, runs: &[Value]) {
        let _ = json::write_json(&self.dir.join("workflow-runs.json"), &Value::Array(runs.to_vec()));
        self.announce();
    }

    fn announce(&self) {
        self.host.notify(&self.snapshot());
    }

    /// `listWorkflows()`: newest first, each with its next scheduled fire.
    pub fn list(&self) -> Vec<Value> {
        let now = self.now();
        let mut list: Vec<Value> = self
            .load_workflows()
            .into_iter()
            .map(|wf| {
                let next = if nekko_js::truthy(wf.get("enabled")) { self.host.next_run(&wf, now) } else { None };
                let mut m = wf.as_object().cloned().unwrap_or_default();
                match next {
                    Some(n) => {
                        m.insert("nextRunAt".into(), num(n));
                    }
                    // `nextRunAt: undefined`: keeps its place, prints nothing.
                    None => {
                        m.shift_remove("nextRunAt");
                    }
                }
                Value::Object(m)
            })
            .collect();
        list.sort_by(|a, b| {
            json::cmp_numbers(nekko_js::to_number(b.get("updatedAt")), nekko_js::to_number(a.get("updatedAt")))
        });
        list
    }

    /// `listWorkflowRuns(workflowId)`: newest first.
    pub fn runs(&self, workflow_id: Option<&str>) -> Vec<Value> {
        let mut runs: Vec<Value> = self
            .load_runs()
            .into_iter()
            .filter(|r| workflow_id.is_none_or(|w| str_field(r, "workflowId") == Some(w)))
            .collect();
        runs.sort_by(|a, b| {
            json::cmp_numbers(nekko_js::to_number(b.get("startedAt")), nekko_js::to_number(a.get("startedAt")))
        });
        runs
    }

    pub fn snapshot(&self) -> Value {
        json!({ "workflows": self.list(), "runs": self.runs(None) })
    }

    /* ------------------------------ CRUD ------------------------------ */

    /// `createWorkflow(input)`.
    pub async fn create(&self, input: &Value) -> Result<Value, String> {
        let name =
            input.get("name").and_then(Value::as_str).ok_or("Cannot read properties of undefined (reading 'trim')")?;
        let settings = self.host.settings().await;
        let now = self.now();
        let trimmed = |k: &str| {
            input.get(k).and_then(Value::as_str).map(|s| nekko_js::trim(s).to_string()).filter(|s| !s.is_empty())
        };
        let id = (self.ids)();
        let mut wf = Map::new();
        wf.insert("id".into(), json!(id));
        wf.insert(
            "name".into(),
            json!(match nekko_js::trim(name) {
                "" => "Untitled workflow",
                t => t,
            }),
        );
        if let Some(d) = trimmed("description") {
            wf.insert("description".into(), json!(d));
        }
        wf.insert("category".into(), json!(trimmed("category").unwrap_or_else(|| UNCATEGORIZED.into())));
        wf.insert("enabled".into(), nullish(input.get("enabled")).cloned().unwrap_or(json!(true)));
        wf.insert("steps".into(), nullish(input.get("steps")).cloned().unwrap_or(json!([])));
        let triggers = match nullish(input.get("triggers")) {
            Some(t) => t.clone(),
            None => json!([{ "id": (self.ids)(), "kind": "manual" }]),
        };
        wf.insert("triggers".into(), triggers);
        let ws = match nullish(input.get("workspaceId")) {
            Some(w) => Some(w.clone()),
            None => settings
                .get("workspaces")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|w| w.get("id"))
                .cloned(),
        };
        if let Some(w) = ws {
            wf.insert("workspaceId".into(), w);
        }
        if let Some(p) = input.get("providerId") {
            wf.insert("providerId".into(), p.clone());
        }
        if let Some(m) = input.get("modelId") {
            wf.insert("modelId".into(), m.clone());
        }
        for k in ["notify", "templateId", "localModelOnly", "toolAccess"] {
            if let Some(v) = input.get(k) {
                wf.insert(k.into(), v.clone());
            }
        }
        wf.insert("createdAt".into(), num(now));
        wf.insert("updatedAt".into(), num(now));
        wf.insert("runCount".into(), json!(0));
        let wf = Value::Object(wf);
        {
            let _io = lock(&self.io);
            let mut list = self.load_workflows();
            list.push(wf.clone());
            self.write_workflows(&list);
        }
        Ok(wf)
    }

    /// `updateWorkflow(id, patch)`: `id` and `createdAt` never move.
    pub fn update(&self, id: &str, patch: &Value) -> Option<Value> {
        let _io = lock(&self.io);
        let mut list = self.load_workflows();
        let i = list.iter().position(|w| id_of(w) == Some(id))?;
        let now = self.now();
        if let Value::Object(wf) = &mut list[i] {
            let (keep_id, keep_created) = (wf.get("id").cloned(), wf.get("createdAt").cloned());
            json::assign_value(wf, patch);
            if let Some(v) = keep_id {
                wf.insert("id".into(), v);
            }
            match keep_created {
                Some(v) => {
                    wf.insert("createdAt".into(), v);
                }
                None => {
                    wf.shift_remove("createdAt");
                }
            }
            wf.insert("updatedAt".into(), num(now));
        }
        let wf = list[i].clone();
        self.write_workflows(&list);
        Some(wf)
    }

    /// `deleteWorkflow(id)`: its runs go too, and any chat a run made that stayed empty.
    pub async fn delete(&self, id: &str) {
        let runs = {
            let _io = lock(&self.io);
            let list: Vec<Value> = self.load_workflows().into_iter().filter(|w| id_of(w) != Some(id)).collect();
            self.write_workflows(&list);
            self.load_runs()
        };
        let mut keep = Vec::new();
        for run in runs {
            if str_field(&run, "workflowId") != Some(id) {
                keep.push(run);
                continue;
            }
            let mut seen = Vec::new();
            for sid in
                run.get("steps").and_then(Value::as_array).into_iter().flatten().filter_map(|s| s.get("sessionId"))
            {
                if nekko_js::truthy(Some(sid)) && !seen.contains(sid) {
                    seen.push(sid.clone());
                }
            }
            for sid in seen {
                let sid = nekko_js::display(&sid);
                if let Some(s) = self.host.get_session(&sid)
                    && s.get("messages").and_then(Value::as_array).is_some_and(Vec::is_empty)
                {
                    self.host.delete_session(&sid).await;
                }
            }
        }
        let _io = lock(&self.io);
        self.write_runs(&keep);
    }

    /// `duplicateWorkflow(id)`: a disabled copy with fresh trigger ids.
    pub async fn duplicate(&self, id: &str) -> Result<Option<Value>, String> {
        let source = {
            let _io = lock(&self.io);
            self.load_workflows().into_iter().find(|w| id_of(w) == Some(id))
        };
        let Some(source) = source else { return Ok(None) };
        let triggers: Vec<Value> = source
            .get("triggers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|t| {
                let mut m = t.as_object().cloned().unwrap_or_default();
                m.insert("id".into(), json!((self.ids)()));
                Value::Object(m)
            })
            .collect();
        let mut input = Map::new();
        input.insert(
            "name".into(),
            json!(format!("{} (copy)", nekko_js::display(source.get("name").unwrap_or(&Value::Null)))),
        );
        for k in ["description", "category"] {
            if let Some(v) = source.get(k) {
                input.insert(k.into(), v.clone());
            }
        }
        input.insert("enabled".into(), json!(false));
        input.insert("steps".into(), source.get("steps").cloned().unwrap_or(json!([])));
        input.insert("triggers".into(), Value::Array(triggers));
        for k in ["workspaceId", "providerId", "modelId", "localModelOnly", "toolAccess"] {
            if let Some(v) = source.get(k) {
                input.insert(k.into(), v.clone());
            }
        }
        self.create(&Value::Object(input)).await.map(Some)
    }

    /* ------------------------------ runs ------------------------------ */

    fn persist_run(&self, run_id: &str, mutate: impl FnOnce(&mut Map<String, Value>)) {
        let _io = lock(&self.io);
        let mut runs = self.load_runs();
        let Some(Value::Object(run)) = runs.iter_mut().find(|r| id_of(r) == Some(run_id)) else { return };
        mutate(run);
        self.write_runs(&runs);
    }

    fn append_run(&self, run: &Value) {
        let _io = lock(&self.io);
        let mut runs = self.load_runs();
        runs.push(run.clone());
        let wid = run.get("workflowId");
        let mut mine: Vec<&Value> = runs.iter().filter(|r| r.get("workflowId") == wid).collect();
        mine.sort_by(|a, b| {
            json::cmp_numbers(nekko_js::to_number(b.get("startedAt")), nekko_js::to_number(a.get("startedAt")))
        });
        let drop: HashSet<String> = mine.iter().skip(RUNS_KEPT).filter_map(|r| id_of(r).map(str::to_string)).collect();
        let kept: Vec<Value> = runs.into_iter().filter(|r| !id_of(r).is_some_and(|i| drop.contains(i))).collect();
        self.write_runs(&kept);
    }

    fn roll_up(&self, workflow_id: &str, run: &Value) {
        let _io = lock(&self.io);
        let mut list = self.load_workflows();
        let Some(Value::Object(wf)) = list.iter_mut().find(|w| id_of(w) == Some(workflow_id)) else { return };
        wf.insert("lastRunAt".into(), run.get("startedAt").cloned().unwrap_or(Value::Null));
        wf.insert("lastStatus".into(), run.get("status").cloned().unwrap_or(Value::Null));
        let count = match wf.get("runCount") {
            Some(v) if !v.is_null() => nekko_js::to_number(Some(v)),
            _ => 0.0,
        };
        wf.insert("runCount".into(), num(count + 1.0));
        self.write_workflows(&list);
    }

    /// `cancelWorkflowRun(runId)`.
    pub fn cancel(&self, run_id: &str) {
        let run = {
            let _io = lock(&self.io);
            self.load_runs().into_iter().find(|r| id_of(r) == Some(run_id))
        };
        let Some(run) = run.filter(|r| str_field(r, "status") == Some("running")) else { return };
        lock(&self.cancelled).insert(run_id.to_string());
        let mut seen: Vec<String> = Vec::new();
        for sid in run.get("steps").and_then(Value::as_array).into_iter().flatten().filter_map(|s| s.get("sessionId")) {
            if nekko_js::truthy(Some(sid)) {
                let sid = nekko_js::display(sid);
                if !seen.contains(&sid) {
                    seen.push(sid);
                }
            }
        }
        for sid in &seen {
            self.host.abort_chat(sid);
        }
        let now = self.now();
        self.persist_run(run_id, |r| {
            r.insert("status".into(), json!("cancelled"));
            r.insert("endedAt".into(), num(now));
            r.insert("message".into(), json!("Cancelled."));
            if let Some(Value::Array(steps)) = r.get_mut("steps") {
                for s in steps {
                    if str_field(s, "status") == Some("running")
                        && let Value::Object(s) = s
                    {
                        s.insert("status".into(), json!("skipped"));
                        s.insert("endedAt".into(), num(now));
                    }
                }
            }
        });
    }

    fn is_cancelled(&self, run_id: &str) -> bool {
        lock(&self.cancelled).contains(run_id)
    }

    /// `dispatchWorkflowEvent(event)`: start every matching workflow.
    pub async fn dispatch_event(self: &Arc<Self>, event: &Value) -> Vec<Value> {
        let list = {
            let _io = lock(&self.io);
            self.load_workflows()
        };
        let ids: Vec<String> =
            match_workflows(&list, event).iter().filter_map(|w| id_of(w).map(str::to_string)).collect();
        let kind = event.get("kind").cloned().unwrap_or(json!("manual"));
        let runs = futures_join(ids.iter().map(|id| {
            let me = self.clone();
            let (kind, event) = (kind.clone(), event.clone());
            let id = id.clone();
            async move { me.execute(&id, kind, Some(event), 0).await }
        }))
        .await;
        runs.into_iter().flatten().collect()
    }

    /// `runWorkflow(id)`: a manual start, resolving when the run ends.
    pub async fn run(self: &Arc<Self>, id: &str) -> Option<Value> {
        self.execute(id, json!("manual"), None, 0).await
    }

    /// `execute(workflowId, triggerKind, event, depth)`.
    fn execute<'a>(
        self: &'a Arc<Self>,
        workflow_id: &'a str,
        trigger_kind: Value,
        event: Option<Value>,
        depth: u32,
    ) -> BoxFut<'a, Option<Value>> {
        Box::pin(async move {
            let wf = {
                let _io = lock(&self.io);
                self.load_workflows().into_iter().find(|w| id_of(w) == Some(workflow_id))
            }?;
            // "Pause all automations" holds back what nobody asked for just now.
            if depth == 0 {
                let kind = trigger_kind.as_str().unwrap_or("");
                if rules::paused_blocks(kind, self.host.settings().await.get("automationsPaused")) {
                    return None;
                }
            }
            let steps: Vec<Value> = wf.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
            {
                let mut flying = lock(&self.in_flight);
                // One run per workflow at a time: a schedule that fires mid-run is skipped.
                if flying.contains(workflow_id) || steps.is_empty() {
                    return None;
                }
                flying.insert(workflow_id.to_string());
            }
            let run_id = (self.ids)();
            let mut run = Map::new();
            run.insert("id".into(), json!(run_id));
            run.insert("workflowId".into(), json!(workflow_id));
            run.insert("status".into(), json!("running"));
            run.insert("triggerKind".into(), trigger_kind.clone());
            if let Some(e) = &event {
                run.insert("triggerLabel".into(), json!(describe_event(e)));
            }
            run.insert("startedAt".into(), num(self.now()));
            run.insert("steps".into(), json!([]));
            let trigger_label = run.get("triggerLabel").cloned();
            self.append_run(&Value::Object(run));

            // One chat for the whole run, so a verify step sees what build did.
            let name = nekko_js::display(wf.get("name").unwrap_or(&Value::Null));
            let mut fields: Vec<(&'static str, Value)> = vec![("title", json!(format!("{name} \u{b7} run")))];
            if let Some(p) = wf.get("providerId").filter(|v| nekko_js::truthy(Some(v))) {
                fields.push(("providerId", p.clone()));
            }
            if let Some(m) = wf.get("modelId").filter(|v| nekko_js::truthy(Some(v))) {
                fields.push(("modelId", m.clone()));
            }
            // Nobody watches the run: approvals it would need are denied, it is
            // never offered ask_user, and its tools are what the workflow's
            // access allows. A local-only workflow's chat is offline.
            fields.push(("unattended", json!(true)));
            fields.push(("workflowRunId", json!(run_id)));
            if nekko_js::truthy(wf.get("localModelOnly")) {
                fields.push(("offline", json!(true)));
            }
            if let Some(access) =
                wf.get("toolAccess").and_then(Value::as_str).filter(|a| !a.is_empty() && *a != "workspace")
            {
                fields.push(("toolAccess", json!(access)));
                fields.push(("disabledTools", json!(nekko_turn::workflow_access::disabled_tools(Some(access), &[]))));
            }
            let session = self.host.create_session(wf.get("workspaceId").cloned(), fields).await;

            let mut run_info = Map::new();
            run_info.insert("id".into(), json!(run_id));
            run_info.insert("workflowId".into(), json!(workflow_id));
            run_info.insert("workflowName".into(), wf.get("name").cloned().unwrap_or(Value::Null));
            run_info.insert("status".into(), json!("running"));
            run_info.insert("triggerKind".into(), trigger_kind);
            if let Some(l) = trigger_label {
                run_info.insert("triggerLabel".into(), l);
            }
            let run_info = Value::Object(run_info);

            let outcome = match &session {
                Ok(sid) => self.walk(&wf, &steps, &run_id, sid, event.as_ref(), depth, &run_info).await,
                Err(e) => (json!("failure"), Some(format!("Run failed: {e}"))),
            };
            lock(&self.in_flight).remove(workflow_id);
            lock(&self.cancelled).remove(&run_id);
            // A run whose steps were all shell commands never wrote to its chat.
            if let Ok(sid) = &session
                && let Some(fresh) = self.host.get_session(sid)
                && fresh.get("messages").and_then(Value::as_array).is_some_and(Vec::is_empty)
            {
                self.host.delete_session(sid).await;
            }
            let (status, message) = outcome;
            let now = self.now();
            self.persist_run(&run_id, |r| {
                // Cancelling already wrote the terminal state.
                if str_field(&Value::Object(r.clone()), "status") != Some("running") {
                    return;
                }
                r.insert("status".into(), status.clone());
                r.insert("endedAt".into(), num(now));
                match &message {
                    Some(m) => {
                        r.insert("message".into(), json!(m));
                    }
                    None => {
                        r.shift_remove("message");
                    }
                }
            });
            let saved = {
                let _io = lock(&self.io);
                self.load_runs().into_iter().find(|r| id_of(r) == Some(&run_id))
            };
            if let Some(saved) = &saved {
                self.roll_up(workflow_id, saved);
            }
            saved
        })
    }

    /// The step loop; the run's final status and message.
    #[allow(clippy::too_many_arguments)]
    async fn walk(
        self: &Arc<Self>,
        wf: &Value,
        steps: &[Value],
        run_id: &str,
        session_id: &str,
        event: Option<&Value>,
        depth: u32,
        run_info: &Value,
    ) -> (Value, Option<String>) {
        let mut visits: HashMap<String, u32> = HashMap::new();
        let mut outputs: Vec<(String, String)> = Vec::new();
        let mut cursor: usize = 0;
        let mut first = true;
        let cancelled = || (json!("cancelled"), Some("Cancelled.".to_string()));
        while cursor < steps.len() {
            if self.is_cancelled(run_id) {
                return cancelled();
            }
            let step = &steps[cursor];
            let step_id = str_field(step, "id").unwrap_or("").to_string();
            let step_name = nekko_js::display(step.get("name").unwrap_or(&Value::Null));
            let seen = visits.get(&step_id).copied().unwrap_or(0) + 1;
            visits.insert(step_id.clone(), seen);
            if seen > MAX_STEP_LOOPS {
                return (
                    json!("failure"),
                    Some(format!(
                        "\"{step_name}\" was reached {MAX_STEP_LOOPS} times without the run converging, so it was stopped."
                    )),
                );
            }
            let retries = match step.get("retries") {
                Some(v) if !v.is_null() => nekko_js::to_number(Some(v)),
                _ => 0.0,
            };
            let attempts = retries.max(0.0) as u64 + 1;
            let mut result = StepResult::fail("Step did not run.");
            for attempt in 1..=attempts {
                if self.is_cancelled(run_id) {
                    return cancelled();
                }
                let entry = json!({ "stepId": step.get("id"), "status": "running", "attempt": attempt, "startedAt": num(self.now()) });
                self.persist_run(run_id, |r| {
                    if let Some(Value::Array(s)) = r.get_mut("steps") {
                        s.push(entry.clone());
                    }
                });
                let tctx = crate::templates::template_context(event, &outputs, Some(run_info));
                result = self
                    .run_step(wf, step, session_id, if first { event } else { None }, event, depth, run_info, &tctx)
                    .await;
                first = false;
                let out = result.output.clone().or_else(|| result.error.clone()).unwrap_or_default();
                match outputs.iter_mut().find(|(k, _)| *k == step_id) {
                    Some(slot) => slot.1 = out,
                    None => outputs.push((step_id.clone(), out)),
                }
                let now = self.now();
                self.persist_run(run_id, |r| {
                    let Some(Value::Array(s)) = r.get_mut("steps") else { return };
                    let Some(Value::Object(last)) = s.last_mut() else { return };
                    last.insert("status".into(), json!(if result.ok { "success" } else { "failure" }));
                    last.insert("endedAt".into(), num(now));
                    put_opt(last, "sessionId", result.session_id.as_ref().map(|s| json!(s)));
                    put_opt(last, "output", result.output.as_ref().map(|o| json!(tail16(o, OUTPUT_KEPT))));
                    put_opt(last, "error", result.error.as_ref().map(|e| json!(e)));
                });
                if result.ok {
                    break;
                }
            }
            // A failing step with continueOnError routes as if it passed.
            let routed = if result.ok || nekko_js::truthy(step.get("continueOnError")) {
                nullish(step.get("onSuccess")).cloned().unwrap_or(json!({ "goto": "next" }))
            } else {
                nullish(step.get("onFailure")).cloned().unwrap_or(json!({ "goto": "fail" }))
            };
            match str_field(&routed, "goto") {
                Some("fail") => {
                    let why = result.error.clone().unwrap_or_else(|| "no details".into());
                    return (json!("failure"), Some(format!("\"{step_name}\" failed: {why}")));
                }
                Some("end") => break,
                Some("step") => {
                    let target = routed.get("stepId");
                    match steps.iter().position(|s| s.get("id") == target) {
                        Some(i) => {
                            cursor = i;
                            continue;
                        }
                        None => {
                            return (
                                json!("failure"),
                                Some(format!("\"{step_name}\" routes to a step that no longer exists.")),
                            );
                        }
                    }
                }
                _ => cursor += 1,
            }
        }
        (json!("success"), None)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_step(
        self: &Arc<Self>,
        wf: &Value,
        step: &Value,
        session_id: &str,
        first_event: Option<&Value>,
        event: Option<&Value>,
        depth: u32,
        run_info: &Value,
        tctx: &Value,
    ) -> StepResult {
        let render = |k: &str| step.get(k).and_then(Value::as_str).map(|s| crate::templates::render_template(s, tctx));
        let run_text = render("run").unwrap_or_else(|| nekko_js::display(step.get("run").unwrap_or(&Value::Null)));
        match str_field(step, "kind") {
            Some("shell") => self.run_shell(wf, step, &run_text).await,
            Some("workflow") => self.run_nested(&run_text, depth).await,
            Some("action") => self.run_action(step, event, run_info, tctx).await,
            Some("prompt") | Some("skill") => {
                self.run_agent(wf, step, &run_text, render("with"), session_id, first_event).await
            }
            _ => StepResult::fail("Step did not run."),
        }
    }

    async fn run_action(&self, step: &Value, event: Option<&Value>, run_info: &Value, tctx: &Value) -> StepResult {
        let op = nekko_js::trim(&nekko_js::display(step.get("run").unwrap_or(&Value::Null))).to_string();
        let Some(connector) = crate::templates::find_action(&op) else {
            return StepResult::fail(format!(
                "Unknown action \"{}\". Pick one from the action list in the editor.",
                nekko_js::display(step.get("run").unwrap_or(&Value::Null))
            ));
        };
        let mut config = None;
        if let Some(kind) = connector {
            let settings = self.host.settings().await;
            config = settings
                .get("connectors")
                .and_then(Value::as_array)
                .and_then(|cs| {
                    cs.iter().find(|c| str_field(c, "kind") == Some(kind) && nekko_js::truthy(c.get("connected")))
                })
                .cloned();
            if config.is_none() {
                let label = crate::templates::connector_label(kind);
                return StepResult::fail(format!(
                    "The {label} connector isn't connected. Connect it under Connectors."
                ));
            }
        }
        let mut params = Map::new();
        if let Some(p) = step.get("params").and_then(Value::as_object) {
            for (k, v) in p {
                params.insert(k.clone(), json!(crate::templates::render_template(&nekko_js::display(v), tctx)));
            }
        }
        let mut ctx = Map::new();
        if let Some(e) = event {
            ctx.insert("event".into(), e.clone());
        }
        ctx.insert("run".into(), run_info.clone());
        let res = self.host.run_action(&op, config, Value::Object(params), Value::Object(ctx)).await;
        let output = res.get("output").map(nekko_js::display).unwrap_or_default();
        if nekko_js::truthy(res.get("isError")) {
            let first_line = output.split('\n').next().unwrap_or("");
            let cut = head16(first_line, 300);
            let error = if cut.is_empty() { "Action failed.".to_string() } else { cut.to_string() };
            return StepResult { ok: false, output: Some(output), error: Some(error), session_id: None };
        }
        StepResult { ok: true, output: Some(output), error: None, session_id: None }
    }

    async fn run_shell(&self, wf: &Value, step: &Value, cmd: &str) -> StepResult {
        let settings = self.host.settings().await;
        let workspaces = settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
        let root = workspaces
            .iter()
            .find(|w| w.get("id") == wf.get("workspaceId"))
            .and_then(|w| nullish(w.get("path")))
            .or_else(|| workspaces.first().and_then(|w| nullish(w.get("path"))))
            .map(nekko_js::display)
            .unwrap_or_else(|| std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default());
        let cwd = match step.get("cwd").filter(|c| nekko_js::truthy(Some(c))) {
            Some(c) => self.host.resolve_path(&root, &nekko_js::display(c)),
            None => root,
        };
        let secs = match step.get("timeoutSec") {
            Some(v) if !v.is_null() => nekko_js::to_number(Some(v)),
            _ => DEFAULT_SHELL_TIMEOUT_SEC,
        };
        let timeout = json::js_max(1.0, secs) * 1000.0;
        let r = self.host.run_shell(cmd, &cwd, timeout).await;
        let output = nekko_js::trim(
            &[r.stdout.as_str(), r.stderr.as_str()]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .to_string();
        match r.error {
            None => StepResult { ok: true, output: Some(output), error: None, session_id: None },
            Some(msg) => {
                let error =
                    if r.killed { format!("Timed out after {}s", nekko_js::number_to_string(secs)) } else { msg };
                StepResult { ok: false, output: Some(output), error: Some(error), session_id: None }
            }
        }
    }

    async fn run_nested(self: &Arc<Self>, target_id: &str, depth: u32) -> StepResult {
        if depth + 1 > MAX_WORKFLOW_DEPTH {
            return StepResult::fail(format!("Nested workflows go no deeper than {MAX_WORKFLOW_DEPTH} levels."));
        }
        let target = {
            let _io = lock(&self.io);
            self.load_workflows().into_iter().find(|w| str_field(w, "id") == Some(target_id))
        };
        let Some(target) = target else { return StepResult::fail("The workflow this step triggers no longer exists.") };
        let name = nekko_js::display(target.get("name").unwrap_or(&Value::Null));
        let tid = id_of(&target).unwrap_or("").to_string();
        let Some(run) = self.execute(&tid, json!("manual"), None, depth + 1).await else {
            return StepResult::fail(format!("\"{name}\" could not start (already running, or it has no steps)."));
        };
        let status = nekko_js::display(run.get("status").unwrap_or(&Value::Null));
        let ok = status == "success";
        let error = if ok {
            None
        } else {
            Some(nullish(run.get("message")).map(nekko_js::display).unwrap_or_else(|| status.clone()))
        };
        StepResult { ok, output: Some(format!("\"{name}\" finished: {status}")), error, session_id: None }
    }

    async fn run_agent(
        &self,
        wf: &Value,
        step: &Value,
        run_text: &str,
        with: Option<String>,
        session_id: &str,
        event: Option<&Value>,
    ) -> StepResult {
        let sid = || Some(session_id.to_string());
        let fail = |e: &str| StepResult { ok: false, output: None, error: Some(e.to_string()), session_id: sid() };
        let settings = self.host.settings().await;
        let pick = |k: &str, d: &str| {
            nullish(step.get(k)).or_else(|| nullish(wf.get(k))).or_else(|| nullish(settings.get(d))).cloned()
        };
        let provider = pick("providerId", "defaultProviderId").filter(|v| nekko_js::truthy(Some(v)));
        let model = pick("modelId", "defaultModelId").filter(|v| nekko_js::truthy(Some(v)));
        let (Some(provider), Some(model)) = (provider, model) else {
            return fail("No model configured. Pick a default provider and model in Models.");
        };
        // Whichever model the step lands on is checked; a non-local one is
        // refused, never swapped for another.
        if nekko_js::truthy(wf.get("localModelOnly")) {
            let found = settings
                .get("providers")
                .and_then(Value::as_array)
                .and_then(|ps| ps.iter().find(|p| p.get("id") == Some(&provider)));
            if !found.is_some_and(nekko_turn::providers::offline_provider_allowed) {
                let label = found
                    .and_then(|p| nullish(p.get("label")))
                    .map(nekko_js::display)
                    .unwrap_or_else(|| nekko_js::display(&provider));
                return fail(&format!("This workflow uses local models only; {label} is not local."));
            }
        }
        let mut body = nekko_js::trim(run_text).to_string();
        if str_field(step, "kind") == Some("skill") {
            let want = nekko_js::trim(run_text);
            let want = want.strip_prefix('/').unwrap_or(want).to_lowercase();
            let defs = self.host.skill_defs().await;
            let skill = defs.iter().find(|s| {
                str_field(s, "id").is_some_and(|i| i.to_lowercase() == want)
                    || str_field(s, "name").is_some_and(|n| n.to_lowercase() == want)
            });
            let Some(skill) = skill else { return fail(&format!("No installed skill matches \"{run_text}\".")) };
            body = nekko_js::trim(&nekko_js::display(skill.get("template").unwrap_or(&Value::Null))).to_string();
        }
        if body.is_empty() {
            return fail("This step has nothing to run.");
        }
        // Under allowlist access each step offers only the tools it lists.
        if str_field(wf, "toolAccess") == Some("allowlist") && self.host.get_session(session_id).is_some() {
            let allowed: Vec<String> = step
                .get("allowedTools")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let disabled = nekko_turn::workflow_access::disabled_tools(Some("allowlist"), &allowed);
            let fields = vec![("allowedTools", json!(allowed)), ("disabledTools", json!(disabled))];
            if let Err(e) = self.host.update_session(session_id, fields).await {
                return fail(&e);
            }
        }
        let can_retry = nekko_js::to_number(nullish(step.get("retries")).or(Some(&json!(0)))) > 0.0
            || nekko_js::truthy(step.get("onFailure"));
        let with = with.map(|w| nekko_js::trim(&w).to_string()).filter(|w| !w.is_empty());
        let step_name = nekko_js::display(step.get("name").unwrap_or(&Value::Null));
        let parts = [
            format!("## Workflow step: {step_name}"),
            body,
            with.map(|w| format!("### Context\n{w}")).unwrap_or_default(),
            event.map(event_context).unwrap_or_default(),
            step_outcome_instruction(can_retry),
        ];
        let prompt = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n");
        let before = self
            .host
            .get_session(session_id)
            .and_then(|s| s.get("messages").and_then(Value::as_array).map(Vec::len))
            .unwrap_or(0);
        let mut opts = json!({ "sessionId": session_id, "providerId": provider, "modelId": model, "text": prompt });
        // A tools-off step reads text someone else wrote: no tool that acts.
        if str_field(step, "tools") == Some("none") {
            opts["noTools"] = json!(true);
        }
        let failed = match self.host.send_chat(opts).await {
            Ok(f) => f,
            Err(e) => return fail(&e),
        };
        let after = self.host.get_session(session_id);
        let answer = after
            .as_ref()
            .and_then(|s| s.get("messages").and_then(Value::as_array))
            .map(|m| {
                m.iter()
                    .skip(before)
                    .rev()
                    .find(|m| {
                        str_field(m, "role") == Some("assistant")
                            && !nekko_js::trim(str_field(m, "content").unwrap_or("")).is_empty()
                    })
                    .and_then(|m| str_field(m, "content"))
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_default();
        if let Some(f) = failed {
            return StepResult { ok: false, output: Some(answer), error: Some(f), session_id: sid() };
        }
        if answer.is_empty() {
            return fail("The model produced no answer for this step.");
        }
        if read_step_outcome(&answer) == "fail" {
            return StepResult {
                ok: false,
                output: Some(answer),
                error: Some("The step reported failure.".into()),
                session_id: sid(),
            };
        }
        StepResult { ok: true, output: Some(answer), error: None, session_id: sid() }
    }

    /// `dispatchWebhook(slug, secret, payload)`: `Err("unauthorized")` when a
    /// webhook trigger matched the slug but not the secret.
    pub async fn dispatch_webhook(
        self: &Arc<Self>,
        slug: &str,
        secret: &str,
        payload: &Value,
    ) -> Result<Vec<Value>, String> {
        let list = {
            let _io = lock(&self.io);
            self.load_workflows()
        };
        let mut found = false;
        for wf in &list {
            if !nekko_js::truthy(wf.get("enabled")) {
                continue;
            }
            if slugify(&nekko_js::display(wf.get("name").unwrap_or(&Value::Null))) != slug {
                continue;
            }
            for t in wf.get("triggers").and_then(Value::as_array).into_iter().flatten() {
                if str_field(t, "kind") != Some("webhook") || !nekko_js::truthy(t.get("webhookSecret")) {
                    continue;
                }
                found = true;
                if constant_time_eq(&nekko_js::display(&t["webhookSecret"]), secret) {
                    let event = json!({ "kind": "webhook", "workflowId": wf.get("id"), "secret": secret, "slug": slug, "payload": payload });
                    return Ok(self.dispatch_event(&event).await);
                }
            }
        }
        if found { Err("unauthorized".into()) } else { Ok(Vec::new()) }
    }

    /* ---------------------------- schedulers --------------------------- */

    /// The workflows whose schedule is due now.
    pub fn due(&self, now: f64) -> Vec<String> {
        let list = {
            let _io = lock(&self.io);
            self.load_workflows()
        };
        let flying = lock(&self.in_flight).clone();
        list.iter()
            .filter(|wf| nekko_js::truthy(wf.get("enabled")))
            .filter(|wf| !id_of(wf).is_some_and(|i| flying.contains(i)))
            .filter(|wf| {
                wf.get("triggers").and_then(Value::as_array).is_some_and(|ts| {
                    ts.iter().any(|t| str_field(t, "kind") == Some("schedule") && rules::trigger_enabled(t))
                })
            })
            .filter(|wf| {
                // A schedule that came due while closed fires once, not per missed slot.
                let from = nullish(wf.get("lastRunAt"))
                    .or_else(|| wf.get("createdAt"))
                    .map_or(f64::NAN, |v| nekko_js::to_number(Some(v)));
                self.host.next_run(wf, from).is_some_and(|d| d <= now)
            })
            .filter_map(|wf| id_of(wf).map(str::to_string))
            .collect()
    }

    /// Start a workflow because its schedule came due.
    pub async fn dispatch_scheduled(self: &Arc<Self>, id: &str) -> Option<Value> {
        self.execute(id, json!("schedule"), Some(json!({ "kind": "schedule" })), 0).await
    }

    /// One scheduler tick: start every due workflow.
    pub fn tick(self: &Arc<Self>) {
        for id in self.due(self.now()) {
            let me = self.clone();
            tokio::spawn(async move { me.dispatch_scheduled(&id).await });
        }
    }

    /// `reconcileWorkflowRuns()`: a run left mid-flight by a quit is written off.
    pub fn reconcile(&self) {
        let _io = lock(&self.io);
        let mut runs = self.load_runs();
        let mut changed = false;
        let now = self.now();
        for run in runs.iter_mut() {
            let Value::Object(r) = run else { continue };
            if r.get("status").and_then(Value::as_str) != Some("running") {
                continue;
            }
            r.insert("status".into(), json!("failure"));
            if nullish(r.get("endedAt")).is_none() {
                r.insert("endedAt".into(), num(now));
            }
            r.insert("message".into(), json!("Interrupted: Nekko Agent stopped while this run was in progress."));
            if let Some(Value::Array(steps)) = r.get_mut("steps") {
                for s in steps {
                    if let Value::Object(s) = s
                        && s.get("status").and_then(Value::as_str) == Some("running")
                    {
                        s.insert("status".into(), json!("skipped"));
                        s.insert("endedAt".into(), num(now));
                    }
                }
            }
            changed = true;
        }
        if changed {
            self.write_runs(&runs);
        }
    }

    /// Reconcile, then run the schedule and the connector listeners.
    pub fn start(self: &Arc<Self>) {
        self.reconcile();
        let me = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(TICK);
            tick.tick().await;
            loop {
                tick.tick().await;
                me.tick();
            }
        });
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                me.tick_listeners().await;
                tokio::time::sleep(LISTENER_TICK).await;
            }
        });
    }

    /* ----------------------------- listeners --------------------------- */

    fn load_cursors(&self) -> Map<String, Value> {
        match json::read_json(&self.dir.join("workflow-cursors.json")) {
            Some(v) if v.get("version") == Some(&json!(1)) && v.get("cursors").is_some_and(Value::is_object) => {
                v["cursors"].as_object().cloned().unwrap_or_default()
            }
            _ => Map::new(),
        }
    }

    fn save_cursors(&self, cursors: &Map<String, Value>) {
        let _ = crate::json::write_json_private(
            &self.dir.join("workflow-cursors.json"),
            &json!({ "version": 1, "cursors": cursors }),
        );
    }

    /// `tickListeners()`: poll every due, armed connector trigger.
    pub async fn tick_listeners(self: &Arc<Self>) {
        let armed: Vec<(Value, Value)> = self
            .list()
            .into_iter()
            .filter(|wf| nekko_js::truthy(wf.get("enabled")))
            .flat_map(|wf| {
                let ts = wf.get("triggers").and_then(Value::as_array).cloned().unwrap_or_default();
                ts.into_iter()
                    .filter(|t| {
                        str_field(t, "kind") == Some("connector")
                            && rules::trigger_enabled(t)
                            && nekko_js::truthy(t.get("connector"))
                    })
                    .map(move |t| (wf.clone(), t))
            })
            .collect();
        for (_wf, t) in armed {
            let tid = nekko_js::display(t.get("id").unwrap_or(&Value::Null));
            let now = self.now();
            let (polling, last) = {
                let mut l = lock(&self.listeners);
                let entry = l.entry(tid.clone()).or_insert_with(|| {
                    let cursors = self.load_cursors();
                    let rec = cursors.get(&tid);
                    let seen = rec
                        .and_then(|r| r.get("seenIds"))
                        .and_then(Value::as_array)
                        .map(|a| a.iter().map(nekko_js::display).collect())
                        .unwrap_or_default();
                    let last = rec.and_then(|r| r.get("lastPollAt")).map_or(0.0, |v| nekko_js::to_number(Some(v)));
                    (false, seen, last)
                });
                (entry.0, entry.2)
            };
            if polling {
                continue;
            }
            let interval = nullish(t.get("pollIntervalMs")).map_or(DEFAULT_POLL_MS, |v| nekko_js::to_number(Some(v)));
            if now - last < interval {
                continue;
            }
            if let Some(e) = lock(&self.listeners).get_mut(&tid) {
                e.0 = true;
            }
            let _ = self.poll_trigger(&t, &tid).await;
            if let Some(e) = lock(&self.listeners).get_mut(&tid) {
                e.0 = false;
                e.2 = self.now();
            }
        }
    }

    async fn poll_trigger(self: &Arc<Self>, t: &Value, tid: &str) -> Result<(), String> {
        let kind = nekko_js::display(&t["connector"]);
        let settings = self.host.settings().await;
        let Some(config) = settings
            .get("connectors")
            .and_then(Value::as_array)
            .and_then(|cs| {
                cs.iter().find(|c| str_field(c, "kind") == Some(&kind) && nekko_js::truthy(c.get("connected")))
            })
            .cloned()
        else {
            return Ok(());
        };
        let mut conn_settings = config.get("settings").and_then(Value::as_object).cloned().unwrap_or_default();
        for k in ["channel", "repo", "event", "filter"] {
            if let Some(v) = t.get(k).filter(|v| nekko_js::truthy(Some(v))) {
                conn_settings.insert(k.into(), v.clone());
            }
        }
        let now = self.now();
        let record_cursor = {
            let mut cursors = self.load_cursors();
            let rec = cursors
                .entry(tid.to_string())
                .or_insert_with(|| json!({ "lastCursor": num(now), "seenIds": [], "lastPollAt": 0 }));
            nekko_js::to_number(rec.get("lastCursor"))
        };
        let token = nullish(config.get("token")).map(nekko_js::display).unwrap_or_default();
        let Some(result) = self.host.poll(&kind, &token, Value::Object(conn_settings), record_cursor).await else {
            return Ok(());
        };
        let result = result?;
        let mut cursors = self.load_cursors();
        let mut rec = cursors
            .get(tid)
            .cloned()
            .unwrap_or_else(|| json!({ "lastCursor": num(now), "seenIds": [], "lastPollAt": 0 }));
        let mut advanced = false;
        let mut seen: Vec<String> = lock(&self.listeners).get(tid).map(|e| e.1.clone()).unwrap_or_default();
        for ev in result.get("events").and_then(Value::as_array).cloned().unwrap_or_default() {
            let c = nekko_js::to_number(ev.get("cursor"));
            let eid = nekko_js::display(ev.get("id").unwrap_or(&Value::Null));
            if c <= record_cursor || seen.contains(&eid) {
                continue;
            }
            seen.push(eid);
            let mut event = Map::new();
            event.insert("kind".into(), json!("connector"));
            event.insert("connector".into(), json!(kind));
            for (k, v) in [
                ("event", ev.get("event")),
                ("channel", t.get("channel")),
                ("text", ev.get("text")),
                ("payload", ev.get("payload")),
                ("actor", ev.get("actor")),
            ] {
                if let Some(v) = v {
                    event.insert(k.into(), v.clone());
                }
            }
            if kind == "github" || kind == "gitlab" {
                let repo = t.get("repo").and_then(Value::as_str).map(nekko_js::trim).filter(|r| !r.is_empty());
                match repo {
                    Some(r) => {
                        event.insert("repo".into(), json!(r));
                    }
                    None => {
                        if let Some(src) = ev.get("source") {
                            event.insert("repo".into(), src.clone());
                        }
                    }
                }
            }
            self.dispatch_event(&Value::Object(event)).await;
            if c > nekko_js::to_number(rec.get("lastCursor")) {
                rec["lastCursor"] = num(c);
                advanced = true;
            }
        }
        let next = nekko_js::to_number(result.get("nextCursor"));
        if next > nekko_js::to_number(rec.get("lastCursor")) {
            rec["lastCursor"] = num(next);
            advanced = true;
        }
        rec["lastPollAt"] = num(self.now());
        let keep: Vec<String> = seen.iter().skip(seen.len().saturating_sub(MAX_SEEN)).cloned().collect();
        rec["seenIds"] = json!(keep);
        if let Some(e) = lock(&self.listeners).get_mut(tid) {
            e.1 = seen;
        }
        if advanced {
            cursors.insert(tid.to_string(), rec);
            self.save_cursors(&cursors);
        }
        Ok(())
    }

    /* ------------------------------- IPC ------------------------------- */

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        let id = || nekko_js::display(arg(0));
        match channel {
            "workflows:list" => Ok(self.snapshot()),
            "workflow:create" => self.create(arg(0)).await,
            "workflow:update" => Ok(self.update(&id(), arg(1)).unwrap_or(Value::Null)),
            "workflow:delete" => {
                self.delete(&id()).await;
                Ok(self.snapshot())
            }
            "workflow:duplicate" => Ok(self.duplicate(&id()).await?.unwrap_or(Value::Null)),
            "workflow:run" => Ok(self.run(&id()).await.unwrap_or(Value::Null)),
            "workflow:cancel" => {
                self.cancel(&id());
                Ok(Value::Null)
            }
            "workflow:runs" => Ok(Value::Array(self.runs(arg(0).as_str()))),
            "workflow:event" => Ok(Value::Array(self.dispatch_event(arg(0)).await)),
            "workflow:webhook" => {
                self.dispatch_webhook(&id(), &nekko_js::display(arg(1)), arg(2)).await.map(Value::Array)
            }
            other => Err(format!("Unknown channel: {other}")),
        }
    }
}

fn put_opt(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    match v {
        Some(v) => {
            m.insert(k.into(), v);
        }
        None => {
            m.shift_remove(k);
        }
    }
}

/// Equal-length strings compared without an early exit (`timingSafeEqual`).
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `Promise.all` over futures, in order.
async fn futures_join<F: Future<Output = Option<Value>>>(fs: impl Iterator<Item = F>) -> Vec<Option<Value>> {
    let handles: Vec<_> = fs.collect();
    let mut out = Vec::with_capacity(handles.len());
    // Started together, as Promise.all starts them: each runs to its first
    // await before the next begins, which keeps the order the TS writes in.
    let mut pinned: Vec<Pin<Box<F>>> = handles.into_iter().map(Box::pin).collect();
    let mut done: Vec<Option<Option<Value>>> = (0..pinned.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        for (i, f) in pinned.iter_mut().enumerate() {
            if done[i].is_none()
                && let std::task::Poll::Ready(v) = f.as_mut().poll(cx)
            {
                done[i] = Some(v);
            }
        }
        if done.iter().all(Option::is_some) { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
    })
    .await;
    for d in done {
        out.push(d.flatten());
    }
    out
}
