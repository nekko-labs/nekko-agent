//! Automation owned by the daemon (PF14), from `nekko-automation`: tasks
//! (`tasks:*`, `task:*`, `tasks.json`, the scheduler) and workflows
//! (`workflows:list`, `workflow:*`, `workflows.json`, `workflow-runs.json`,
//! `workflow-cursors.json`, the schedule and the connector listeners).
//!
//! A task's or a workflow step's turn is a normal chat turn: the daemon asks
//! the TS host to admit it (`chat:send`, the same door the UI uses, so the
//! turn's events reach the UI and the phone as any chat's do). Their chats are
//! made by the host (`session:create`, which owns the chat defaults) and
//! named here. A skill step asks the host for the installed skills
//! (`workflow:skillDefs`; the marketplace catalog lives there until skills
//! move). Actions and polls are `nekko-connectors`'; shell steps run on
//! `nekko-tools`' shell, which kills the whole tree on a timeout.
//!
//! Owned only when the daemon knows the data directory; otherwise every one
//! of these channels goes to the TS host, which then runs its own timers.

use crate::backend::Backend;
use crate::hub::Hub;
use nekko_automation::tasks::{self, TaskHost, Tasks};
use nekko_automation::workflows::{ShellResult, WorkflowHost, Workflows};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

pub use nekko_automation::tasks::CHANNELS as TASK_CHANNELS;
pub use nekko_automation::workflows::CHANNELS as WORKFLOW_CHANNELS;

/// What the backend is told the daemon owns (`NEKKOD_OWNS`).
pub const OWNS: &str = "tasks,workflows";

/// How long a service waits on the host for the settings before going without.
const SETTINGS_WAIT: Duration = Duration::from_secs(10);

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Runs a channel through the daemon's router.
pub type Dispatcher = Arc<dyn Fn(String, Vec<Value>) -> BoxFut<'static, Result<Value, String>> + Send + Sync>;

pub struct Automation {
    pub tasks: Option<Arc<Tasks>>,
    pub workflows: Option<Arc<Workflows>>,
    dispatch: Arc<OnceLock<Dispatcher>>,
}

impl Automation {
    pub fn new(
        store: Option<Arc<SessionStore>>,
        settings: Option<Arc<crate::settings::Settings>>,
        backend: Arc<Backend>,
        hub: Hub,
    ) -> Self {
        let dispatch: Arc<OnceLock<Dispatcher>> = Arc::default();
        let (tasks, workflows) = match store {
            Some(store) => {
                let dir = store.dir().parent().map(std::path::Path::to_path_buf).unwrap_or_default();
                let engine = Arc::new(Engine { store, settings, backend, hub, dispatch: dispatch.clone() });
                let clock = Tasks::system_clock();
                let ids: tasks::Ids = Arc::new(tasks::random_uuid);
                (
                    Some(Tasks::new(&dir, engine.clone(), clock.clone(), ids.clone())),
                    Some(Workflows::new(&dir, engine, clock, ids)),
                )
            }
            None => (None, None),
        };
        Self { tasks, workflows, dispatch }
    }

    /// How a workflow stops a chat (`chat:abort`): through the router.
    pub fn set_dispatcher(&self, d: Dispatcher) {
        let _ = self.dispatch.set(d);
    }

    pub fn start(&self) {
        if let Some(t) = &self.tasks {
            t.start();
        }
        if let Some(w) = &self.workflows {
            let w = w.clone();
            // Reconciling reads and writes files: off the async threads.
            tokio::task::spawn_blocking(move || w.start());
        }
    }

    pub fn owns_tasks(&self) -> bool {
        self.tasks.is_some()
    }

    pub fn owns_workflows(&self) -> bool {
        self.workflows.is_some()
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        match (&self.tasks, &self.workflows) {
            (Some(t), _) if TASK_CHANNELS.contains(&channel) => t.route(channel, args).await,
            (_, Some(w)) if WORKFLOW_CHANNELS.contains(&channel) => w.route(channel, args).await,
            _ => Err(format!("{channel} is not served here")),
        }
    }
}

/// The engine as tasks and workflows see it.
struct Engine {
    store: Arc<SessionStore>,
    settings: Option<Arc<crate::settings::Settings>>,
    backend: Arc<Backend>,
    hub: Hub,
    dispatch: Arc<OnceLock<Dispatcher>>,
}

impl Engine {
    async fn settings(&self) -> Value {
        if let Some(s) = &self.settings {
            let store = s.store.clone();
            return tokio::task::spawn_blocking(move || store.get()).await.unwrap_or(Value::Null);
        }
        match tokio::time::timeout(SETTINGS_WAIT, self.backend.call("settings:get", json!([]))).await {
            Ok(Ok(v)) => v,
            _ => Value::Null,
        }
    }

    async fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> Result<String, String> {
        let ws = workspace_id.unwrap_or(Value::Null);
        let created = self.backend.call("session:create", json!([ws])).await?;
        let id = created.get("id").and_then(Value::as_str).ok_or("the host made no chat")?.to_string();
        let (store, sid) = (self.store.clone(), id.clone());
        tokio::task::spawn_blocking(move || store.assign(&sid, &fields)).await.map_err(|e| e.to_string())??;
        Ok(id)
    }

    async fn delete_session(&self, id: String) {
        // As `session:delete` does: the host's command log first, then the chat.
        if self.backend.call("sessions:deleteAgentLog", json!([id])).await.is_ok() {
            let store = self.store.clone();
            let _ = tokio::task::spawn_blocking(move || store.delete(&id)).await;
        }
    }
}

impl TaskHost for Engine {
    fn settings(&self) -> tasks::BoxFut<'_, Value> {
        Box::pin(Engine::settings(self))
    }

    fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> tasks::BoxFut<'_, Result<String, String>> {
        Box::pin(Engine::create_session(self, workspace_id, fields))
    }

    fn get_session(&self, id: &str) -> Option<Value> {
        self.store.get(id)
    }

    fn delete_session(&self, id: &str) -> tasks::BoxFut<'_, ()> {
        Box::pin(Engine::delete_session(self, id.to_string()))
    }

    fn send_chat(&self, opts: Value) -> tasks::BoxFut<'_, Result<(), String>> {
        Box::pin(async move { self.backend.call("chat:send", json!([opts])).await.map(|_| ()) })
    }

    fn notify(&self, list: &Value) {
        self.hub.publish("tasks:updated", list.clone(), false);
    }
}

impl WorkflowHost for Engine {
    fn settings(&self) -> BoxFut<'_, Value> {
        Box::pin(Engine::settings(self))
    }

    fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> BoxFut<'_, Result<String, String>> {
        Box::pin(Engine::create_session(self, workspace_id, fields))
    }

    fn get_session(&self, id: &str) -> Option<Value> {
        self.store.get(id)
    }

    fn delete_session(&self, id: &str) -> BoxFut<'_, ()> {
        Box::pin(Engine::delete_session(self, id.to_string()))
    }

    /// The turn through the host, listening on the bus for the chat's error
    /// events meanwhile (the TS engine read them from its turn's callback).
    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<Option<String>, String>> {
        Box::pin(async move {
            let sid = opts.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
            let mut rx = self.hub.subscribe();
            let failed = Arc::new(std::sync::Mutex::new(None::<String>));
            let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
            let watcher = {
                let failed = failed.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            _ = &mut stop_rx => break,
                            ev = rx.recv() => match ev {
                                Ok(ev) => {
                                    if !ev.text.starts_with(r#"{"channel":"agent:event""#) || !ev.text.contains(r#""error""#) {
                                        continue;
                                    }
                                    let Ok(v) = serde_json::from_str::<Value>(&ev.text) else { continue };
                                    let p = &v["payload"];
                                    if p["type"] == "error" && p["sessionId"].as_str() == Some(&sid) {
                                        *failed.lock().unwrap_or_else(|e| e.into_inner()) = p["message"].as_str().map(str::to_string);
                                    }
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(_) => break,
                            },
                        }
                    }
                })
            };
            let result = self.backend.call("chat:send", json!([opts])).await;
            // Events published before the call returned are already queued for the watcher.
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = stop_tx.send(());
            let _ = watcher.await;
            result?;
            Ok(failed.lock().unwrap_or_else(|e| e.into_inner()).take())
        })
    }

    fn abort_chat(&self, session_id: &str) {
        if let Some(d) = self.dispatch.get() {
            let fut = d("chat:abort".into(), vec![json!(session_id)]);
            tokio::spawn(fut);
        }
    }

    fn skill_defs(&self) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async move {
            match self.backend.call("workflow:skillDefs", json!([])).await {
                Ok(Value::Array(a)) => a,
                _ => Vec::new(),
            }
        })
    }

    fn run_action(&self, op: &str, config: Option<Value>, params: Value, ctx: Value) -> BoxFut<'_, Value> {
        let op = op.to_string();
        Box::pin(async move {
            nekko_connectors::run_action(crate::connectors::NET.as_ref(), &op, config.as_ref(), &params, &ctx)
                .await
                .value()
        })
    }

    fn run_shell(&self, cmd: &str, cwd: &str, timeout_ms: f64) -> BoxFut<'_, ShellResult> {
        let (cmd, cwd) = (cmd.to_string(), cwd.to_string());
        Box::pin(async move {
            use nekko_tools::{BashLimits, CommandRunner, Failure, RunRequest, ShellRunner};
            let cancel = nekko_tools::Cancel::new();
            // The step's own timeout, by cancelling: the shell's result then
            // says it was stopped, which is how a timeout is told apart.
            let limits = BashLimits {
                timeout: Duration::from_secs(365 * 24 * 3600),
                max_buffer: 8 * 1024 * 1024,
                output_cap: 8 * 1024 * 1024,
            };
            let timer = {
                let cancel = cancel.clone();
                let wait = Duration::from_millis(timeout_ms.max(0.0) as u64);
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    cancel.cancel();
                })
            };
            let out = ShellRunner
                .run(RunRequest { command: &cmd, cwd: &cwd, limits, cancel: &cancel, on_output: &|_| {} })
                .await;
            timer.abort();
            match out.failure {
                None => ShellResult { stdout: out.stdout, stderr: out.stderr, error: None, killed: false },
                Some(Failure::Cancelled) => ShellResult {
                    error: Some(format!("Command failed: {cmd}\n{}", out.stderr)),
                    stdout: out.stdout,
                    stderr: out.stderr,
                    killed: true,
                },
                Some(Failure::Error(e)) => {
                    ShellResult { stdout: out.stdout, stderr: out.stderr, error: Some(e), killed: false }
                }
            }
        })
    }

    fn poll(&self, kind: &str, token: &str, settings: Value, cursor: f64) -> BoxFut<'_, Option<Result<Value, String>>> {
        let (kind, token) = (kind.to_string(), token.to_string());
        Box::pin(async move {
            if !nekko_connectors::can_poll(&kind) {
                return None;
            }
            Some(nekko_connectors::poll(crate::connectors::NET.as_ref(), &kind, &token, &settings, cursor).await)
        })
    }

    fn notify(&self, snapshot: &Value) {
        self.hub.publish("workflows:updated", snapshot.clone(), false);
    }

    fn next_run(&self, wf: &Value, from: f64) -> Option<f64> {
        nekko_automation::workflow_rules::next_scheduled_run(&chrono::Local, wf, from)
    }

    fn resolve_path(&self, root: &str, rel: &str) -> String {
        if cfg!(windows) {
            use nekko_tools::path::win32;
            if win32::is_absolute(rel) { rel.to_string() } else { win32::resolve(&[root, rel]) }
        } else {
            use nekko_tools::path::posix;
            if posix::is_absolute(rel) { rel.to_string() } else { posix::resolve(&[root, rel]) }
        }
    }
}
