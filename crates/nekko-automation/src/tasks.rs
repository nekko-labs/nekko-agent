//! Automation tasks (`packages/host/src/tasks.ts`): scheduled (one shot at a
//! time), recurring (every N) and background agents (forever, or until a
//! condition the agent judges met). Each fire drives the task's own chat
//! through a normal turn. State is `tasks.json`, so tasks survive restarts;
//! this process is its only writer.
//!
//! The scheduler sleeps until the earliest due task (at most [`TICK`]), so a
//! task fires when it is due rather than up to a tick late, and it is woken
//! at once when a task changes.

use crate::json::{self, assign, assign_value, num};
use crate::run_policy::{self, Gate};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The longest the scheduler sleeps between looks at the file.
pub const TICK: Duration = Duration::from_secs(15);
const DEFAULT_BG_INTERVAL: f64 = 5.0 * 60_000.0;
/// `TASK_DONE_TOKEN`: what a background agent ends its reply with once its condition holds.
pub const TASK_DONE_TOKEN: &str = "\u{27e6}DONE\u{27e7}";
const NO_MODEL: &str = "No model configured, set a default provider/model in Models.";

/// The channels this service serves.
pub const CHANNELS: &[&str] = &["tasks:list", "task:create", "task:update", "task:delete", "task:runNow"];

/// What a task needs from the rest of the engine.
pub trait TaskHost: Send + Sync + 'static {
    /// The user's settings (`defaultProviderId`, `defaultModelId`).
    fn settings(&self) -> BoxFut<'_, Value>;
    /// `createSession(workspaceId)`, then `title` and each field assigned in
    /// order and saved. The new chat's id.
    fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> BoxFut<'_, Result<String, String>>;
    fn get_session(&self, id: &str) -> Option<Value>;
    fn delete_session(&self, id: &str) -> BoxFut<'_, ()>;
    /// `sendChat(opts)`: resolves when the turn (and its queue) is over.
    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<(), String>>;
    /// The task list changed (`tasks:updated`, with the list as saved).
    fn notify(&self, tasks: &Value);
    /// Whether someone is using the computer (`activity:state`), judged
    /// against `idle_after_secs`; `None` when the host cannot tell.
    fn activity(&self, idle_after_secs: f64) -> BoxFut<'_, Option<Value>> {
        let _ = idle_after_secs;
        Box::pin(async { None })
    }
}

/// How the run policy let a fire start.
#[derive(Default, Clone, Copy)]
struct RunAs {
    low_priority: bool,
    waited_ms: Option<f64>,
}

/// `Date.now()`; tests pass a fixed clock.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
/// `randomUUID()`; tests pass a counter.
pub type Ids = Arc<dyn Fn() -> String + Send + Sync>;

pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub struct Tasks {
    file: PathBuf,
    host: Arc<dyn TaskHost>,
    clock: Clock,
    ids: Ids,
    in_flight: Mutex<HashSet<String>>,
    /// Due tasks held back (paused, or waiting for idle), and when the
    /// scheduler looks at each again: not on every turn of its loop.
    held: Mutex<HashMap<String, f64>>,
    /// Read-modify-write of the file, one at a time.
    io: Mutex<()>,
    wake: tokio::sync::Notify,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn id_of(t: &Value) -> Option<&str> {
    t.get("id").and_then(Value::as_str)
}

/// `a ?? b`.
fn nullish_or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(v) if !v.is_null() => Some(v),
        _ => b.filter(|v| !v.is_null()),
    }
}

/// The prompt a firing task sends (`taskPrompt`).
pub fn task_prompt(task: &Value) -> String {
    let mut prompt = nekko_js::display(task.get("prompt").unwrap_or(&Value::Null));
    let s = |k: &str| task.get(k).and_then(Value::as_str);
    if s("kind") == Some("background") && s("keepAlive") == Some("until") && nekko_js::truthy(task.get("condition")) {
        let condition = nekko_js::display(task.get("condition").unwrap_or(&Value::Null));
        prompt.push_str(&format!(
            "\n\n(This is a background task. Keep working until: {condition}. When that condition is fully satisfied, end your reply with the token {TASK_DONE_TOKEN}.)"
        ));
    }
    prompt
}

/// What a finished fire writes back (`taskRunPatch`).
pub fn task_run_patch(task: &Value, result: &str, now: f64) -> Vec<(&'static str, Option<Value>)> {
    let mut patch: Vec<(&'static str, Option<Value>)> = vec![("lastResult", Some(json!(cut16(result, 400))))];
    let interval = || {
        let n = match task.get("intervalMs") {
            Some(v) if !v.is_null() => nekko_js::to_number(Some(v)),
            _ => DEFAULT_BG_INTERVAL,
        };
        num(now + json::js_max(60_000.0, n))
    };
    match task.get("kind").and_then(Value::as_str) {
        Some("scheduled") => patch.push(("status", Some(json!("done")))),
        Some("recurring") => patch.push(("nextRunAt", Some(interval()))),
        _ => {
            let until = task.get("keepAlive").and_then(Value::as_str) == Some("until");
            if until && (result.contains(TASK_DONE_TOKEN) || json::has_word_phrase(result, "condition met")) {
                patch.push(("status", Some(json!("done"))));
            } else {
                patch.push(("nextRunAt", Some(interval())));
            }
        }
    }
    patch
}

/// `s.slice(0, n)` in UTF-16 units; a surrogate pair cut in half is dropped
/// whole (a Rust string cannot hold the lone half JavaScript keeps).
fn cut16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

impl Tasks {
    pub fn new(data_dir: impl Into<PathBuf>, host: Arc<dyn TaskHost>, clock: Clock, ids: Ids) -> Arc<Self> {
        Arc::new(Self {
            file: data_dir.into().join("tasks.json"),
            host,
            clock,
            ids,
            in_flight: Mutex::default(),
            held: Mutex::default(),
            io: Mutex::new(()),
            wake: tokio::sync::Notify::new(),
        })
    }

    pub fn system_clock() -> Clock {
        Arc::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0)
        })
    }

    fn load(&self) -> Vec<Value> {
        match json::read_json(&self.file) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        }
    }

    fn save(&self, tasks: &[Value]) -> Result<(), String> {
        let v = Value::Array(tasks.to_vec());
        json::write_json(&self.file, &v).map_err(|e| format!("could not save tasks: {e}"))?;
        self.host.notify(&v);
        self.wake.notify_one();
        Ok(())
    }

    /// `listTasks()`: newest first.
    pub fn list(&self) -> Vec<Value> {
        let mut tasks = {
            let _io = lock(&self.io);
            self.load()
        };
        tasks.sort_by(|a, b| {
            let n = |t: &Value| nekko_js::to_number(t.get("createdAt"));
            json::cmp_numbers(n(b), n(a))
        });
        tasks
    }

    /// `createTask(input)`.
    pub async fn create(&self, input: &Value) -> Result<Vec<Value>, String> {
        let title =
            input.get("title").and_then(Value::as_str).ok_or("Cannot read properties of undefined (reading 'trim')")?;
        let title = match nekko_js::trim(title) {
            "" => "Untitled task".to_string(),
            t => t.to_string(),
        };
        let now = (self.clock)();
        let id = (self.ids)();
        let settings = self.host.settings().await;
        let provider = nullish_or(input.get("providerId"), settings.get("defaultProviderId")).cloned();
        let model = nullish_or(input.get("modelId"), settings.get("defaultModelId")).cloned();
        let mut fields: Vec<(&'static str, Value)> = vec![("title", json!(title)), ("taskId", json!(id))];
        if let Some(p) = provider.filter(|p| nekko_js::truthy(Some(p))) {
            fields.push(("providerId", p));
        }
        if let Some(m) = model.filter(|m| nekko_js::truthy(Some(m))) {
            fields.push(("modelId", m));
        }
        let session = self.host.create_session(input.get("workspaceId").cloned(), fields).await?;
        let mut task = Map::new();
        let mut put = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                task.insert(k.to_string(), v);
            }
        };
        let field = |k: &str| input.get(k).cloned();
        put("id", Some(json!(id)));
        put("title", Some(json!(title)));
        put("kind", field("kind"));
        put("prompt", field("prompt"));
        put("workspaceId", field("workspaceId"));
        put("providerId", field("providerId"));
        put("modelId", field("modelId"));
        put("runAt", field("runAt"));
        put("intervalMs", field("intervalMs"));
        put("keepAlive", field("keepAlive"));
        put("condition", field("condition"));
        put("runPolicy", field("runPolicy"));
        put("status", Some(json!("active")));
        put("createdAt", Some(num(now)));
        put("runCount", Some(json!(0)));
        put("lastSessionId", Some(json!(session)));
        // When the first fire happens: scheduled at runAt, otherwise as soon as possible.
        let next = if input.get("kind").and_then(Value::as_str) == Some("scheduled") {
            nullish_or(input.get("runAt"), None).cloned().unwrap_or(num(now))
        } else {
            num(now)
        };
        put("nextRunAt", Some(next));
        {
            let _io = lock(&self.io);
            let mut tasks = self.load();
            tasks.push(Value::Object(task));
            self.save(&tasks)?;
        }
        Ok(self.list())
    }

    /// `updateTask(id, patch)`.
    pub fn update(&self, id: &str, patch: &Value) -> Result<Vec<Value>, String> {
        {
            let _io = lock(&self.io);
            let mut tasks = self.load();
            if let Some(Value::Object(t)) = tasks.iter_mut().find(|t| id_of(t) == Some(id)) {
                assign_value(t, patch);
                // Re-arm when resumed.
                if patch.get("status").and_then(Value::as_str) == Some("active")
                    && !nekko_js::truthy(t.get("nextRunAt"))
                {
                    t.insert("nextRunAt".into(), num((self.clock)()));
                }
                self.save(&tasks)?;
            }
        }
        Ok(self.list())
    }

    /// `deleteTask(id)`: drops the task's chat too if it never produced anything.
    pub async fn delete(&self, id: &str) -> Result<Vec<Value>, String> {
        let tasks = {
            let _io = lock(&self.io);
            self.load()
        };
        let task = tasks.iter().find(|t| id_of(t) == Some(id));
        if let Some(sid) = task.and_then(|t| t.get("lastSessionId")).filter(|v| nekko_js::truthy(Some(v))) {
            let sid = nekko_js::display(sid);
            if let Some(s) = self.host.get_session(&sid)
                && s.get("messages").and_then(Value::as_array).is_some_and(Vec::is_empty)
            {
                let sid = s.get("id").and_then(Value::as_str).unwrap_or(&sid).to_string();
                self.host.delete_session(&sid).await;
            }
        }
        {
            let _io = lock(&self.io);
            let keep: Vec<Value> = self.load().into_iter().filter(|t| id_of(t) != Some(id)).collect();
            self.save(&keep)?;
        }
        Ok(self.list())
    }

    /// `persistTask(id, patch)`: re-read, assign, save.
    fn persist(&self, id: &str, patch: &[(&str, Option<Value>)]) {
        let _io = lock(&self.io);
        let mut tasks = self.load();
        if let Some(Value::Object(t)) = tasks.iter_mut().find(|t| id_of(t) == Some(id)) {
            assign(t, patch);
            let _ = self.save(&tasks);
        }
    }

    /// `runTaskNow(id)`: start a fire and return at once.
    pub fn run_now(self: &Arc<Self>, id: &str) {
        let exists = {
            let _io = lock(&self.io);
            self.load().iter().any(|t| id_of(t) == Some(id))
        };
        if exists {
            let (me, id) = (self.clone(), id.to_string());
            tokio::spawn(async move { me.fire(&id).await });
        }
    }

    /// `fireTask(id)`: one turn on the task's chat, then re-arm or finish it.
    pub async fn fire(&self, id: &str) {
        self.fire_when(id, None).await
    }

    /// The scheduler's fire: only if the task is still due at `now` once
    /// claimed. The loop picks due tasks from a read of the file that can be
    /// stale by the time the fire starts (an earlier fire of the same task may
    /// have finished and re-armed it in between), and the TS scheduler cannot
    /// interleave that way, so without this check a task could run twice.
    pub async fn fire_if_due(&self, id: &str, now: f64) {
        self.fire_when(id, Some(now)).await
    }

    async fn fire_when(&self, id: &str, due_at: Option<f64>) {
        // Claim the task before the first await, so no other fire can start
        // between the check and the claim.
        if !lock(&self.in_flight).insert(id.to_string()) {
            return;
        }
        if let Some(patch) = self.fire_claimed(id, due_at).await {
            self.persist(id, &patch);
        }
        lock(&self.in_flight).remove(id);
    }

    /// The body of a fire, with the task already claimed.
    async fn fire_claimed(&self, id: &str, due_at: Option<f64>) -> Option<Vec<(&'static str, Option<Value>)>> {
        let task = {
            let _io = lock(&self.io);
            self.load().into_iter().find(|t| id_of(t) == Some(id))
        };
        let task = task.filter(|t| t.get("status").and_then(Value::as_str) == Some("active"))?;
        if let Some(now) = due_at
            && !task.get("nextRunAt").is_some_and(|n| !n.is_null() && nekko_js::to_number(Some(n)) <= now)
        {
            return None;
        }
        let settings = self.host.settings().await;
        // "Pause all automations": a due task waits; Run now still works.
        if let Some(now) = due_at
            && nekko_js::truthy(settings.get("automationsPaused"))
        {
            self.hold(id, now);
            return None;
        }
        let provider = nullish_or(task.get("providerId"), settings.get("defaultProviderId")).cloned();
        let model = nullish_or(task.get("modelId"), settings.get("defaultModelId")).cloned();
        let (Some(provider), Some(model)) =
            (provider.filter(|v| nekko_js::truthy(Some(v))), model.filter(|v| nekko_js::truthy(Some(v))))
        else {
            return Some(vec![("status", Some(json!("error"))), ("lastResult", Some(json!(NO_MODEL)))]);
        };
        // The run policy, for the scheduler's fires: Run now is a person asking.
        let mut ran = RunAs::default();
        if let Some(now) = due_at {
            let local = run_policy::is_local_provider(&settings, Some(&provider));
            let policy = run_policy::policy_of(&task, &settings, local);
            let activity = match policy {
                run_policy::Policy::Always => None,
                _ => self.host.activity(run_policy::idle_after_secs(&settings)).await,
            };
            let due = nekko_js::to_number(task.get("nextRunAt"));
            match run_policy::gate(policy, activity.as_ref(), due, now) {
                Gate::Wait => {
                    self.hold(id, now);
                    // Said once, so the list can show the task waiting.
                    let said = task.get("waitingSince").is_some_and(|w| !w.is_null());
                    return (!said).then(|| vec![("waitingSince", Some(num(now)))]);
                }
                Gate::Go { low_priority, waited_ms } => {
                    lock(&self.held).remove(id);
                    ran = RunAs { low_priority, waited_ms };
                }
            }
        }
        Some(match self.drive(id, &task, provider, model, ran).await {
            Ok(answer) => task_run_patch(&task, &answer, (self.clock)()),
            Err(e) => vec![("status", Some(json!("error"))), ("lastResult", Some(json!(format!("Run failed: {e}"))))],
        })
    }

    /// Hold a due task back until the next look, a tick from `now`.
    fn hold(&self, id: &str, now: f64) {
        lock(&self.held).insert(id.to_string(), now + TICK.as_millis() as f64);
    }

    /// When a held task is looked at again, if it is held.
    fn held_until(&self, id: &str, now: f64) -> Option<f64> {
        lock(&self.held).get(id).copied().filter(|until| *until > now)
    }

    /// The fire's turn; the last answer, or why it failed.
    async fn drive(&self, id: &str, task: &Value, provider: Value, model: Value, ran: RunAs) -> Result<String, String> {
        // Reuse the task's chat across fires so background agents keep context.
        let existing = task
            .get("lastSessionId")
            .filter(|v| nekko_js::truthy(Some(v)))
            .map(nekko_js::display)
            .filter(|sid| self.host.get_session(sid).is_some());
        let sid = match existing {
            Some(sid) => sid,
            None => {
                let fields = vec![
                    ("title", task.get("title").cloned().unwrap_or(Value::Null)),
                    ("taskId", task.get("id").cloned().unwrap_or(Value::Null)),
                    ("providerId", provider.clone()),
                    ("modelId", model.clone()),
                ];
                self.host.create_session(task.get("workspaceId").cloned(), fields).await?
            }
        };
        let prompt = task_prompt(task);
        let runs = nekko_js::to_number(task.get("runCount")) + 1.0;
        self.persist(
            id,
            &[
                ("status", Some(json!("active"))),
                ("lastRunAt", Some(num((self.clock)()))),
                ("runCount", Some(num(runs))),
                ("lastSessionId", Some(json!(sid))),
                ("nextRunAt", None),
                ("waitingSince", None),
                // How the policy let this run start, for the list to say.
                ("lastRunLowPriority", ran.low_priority.then(|| json!(true))),
                ("lastRunWaitedMs", ran.waited_ms.map(num)),
            ],
        );
        self.host
            .send_chat(json!({ "sessionId": sid, "providerId": provider, "modelId": model, "text": prompt }))
            .await?;
        let done = self.host.get_session(&sid);
        let messages = done.as_ref().and_then(|s| s.get("messages")).and_then(Value::as_array);
        let last = messages.and_then(|m| {
            m.iter().rev().find(|m| {
                m.get("role").and_then(Value::as_str) == Some("assistant")
                    && !nekko_js::trim(m.get("content").and_then(Value::as_str).unwrap_or("")).is_empty()
            })
        });
        Ok(last.and_then(|m| m.get("content")).and_then(Value::as_str).unwrap_or("").to_string())
    }

    /// The tasks due now, in file order (`nextRunAt <= now`, active, not firing).
    pub fn due(&self, now: f64) -> Vec<String> {
        let tasks = {
            let _io = lock(&self.io);
            self.load()
        };
        let flying = lock(&self.in_flight).clone();
        tasks
            .iter()
            .filter(|t| t.get("status").and_then(Value::as_str) == Some("active"))
            .filter_map(|t| id_of(t).map(|id| (id, t)))
            .filter(|(id, _)| !flying.contains(*id) && self.held_until(id, now).is_none())
            .filter(|(_, t)| t.get("nextRunAt").is_some_and(|n| !n.is_null() && nekko_js::to_number(Some(n)) <= now))
            .map(|(id, _)| id.to_string())
            .collect()
    }

    /// How long until the next task is due, at most [`TICK`].
    fn sleep_for(&self, now: f64) -> Duration {
        let tasks = {
            let _io = lock(&self.io);
            self.load()
        };
        let next = tasks
            .iter()
            .filter(|t| t.get("status").and_then(Value::as_str) == Some("active"))
            .filter_map(|t| {
                let next = nekko_js::to_number(Some(t.get("nextRunAt").filter(|n| !n.is_null())?));
                Some(id_of(t).and_then(|id| self.held_until(id, now)).map_or(next, |until| until.max(next)))
            })
            .filter(|n| !n.is_nan())
            .fold(f64::INFINITY, f64::min);
        let wait = (next - now).max(0.0);
        if wait.is_finite() { Duration::from_millis(wait as u64).min(TICK) } else { TICK }
    }

    /// `reconcileTasks()`: an active task with no next run (its fire was cut
    /// short by a restart) is due now.
    pub fn reconcile(&self) {
        let _io = lock(&self.io);
        let mut tasks = self.load();
        let now = (self.clock)();
        let mut changed = false;
        for t in tasks.iter_mut() {
            if let Value::Object(t) = t
                && t.get("status").and_then(Value::as_str) == Some("active")
                && t.get("nextRunAt").is_none_or(Value::is_null)
            {
                t.insert("nextRunAt".into(), num(now));
                changed = true;
            }
        }
        if changed {
            let _ = self.save(&tasks);
        }
    }

    /// Reconcile, then fire tasks as they come due until the runtime stops.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            {
                let me = me.clone();
                let _ = tokio::task::spawn_blocking(move || me.reconcile()).await;
            }
            loop {
                let now = (me.clock)();
                for id in me.due(now) {
                    let me = me.clone();
                    tokio::spawn(async move { me.fire_if_due(&id, now).await });
                }
                let wait = me.sleep_for((me.clock)());
                tokio::select! {
                    _ = tokio::time::sleep(wait.max(Duration::from_millis(50))) => {}
                    _ = me.wake.notified() => {}
                }
            }
        });
    }

    /// One IPC channel.
    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        let id = || nekko_js::display(arg(0));
        match channel {
            "tasks:list" => Ok(Value::Array(self.list())),
            "task:create" => self.create(arg(0)).await.map(Value::Array),
            "task:update" => self.update(&id(), arg(1)).map(Value::Array),
            "task:delete" => self.delete(&id()).await.map(Value::Array),
            "task:runNow" => {
                self.run_now(&id());
                Ok(Value::Null)
            }
            other => Err(format!("Unknown channel: {other}")),
        }
    }
}
