//! Automation owned by the daemon (PF14), from `nekko-automation`: tasks
//! (`tasks:*`, `task:*`, `tasks.json`, the scheduler) and workflows
//! (`workflows:list`, `workflow:*`, `workflows.json`, `workflow-runs.json`,
//! `workflow-cursors.json`, the schedule and the connector listeners), and
//! training and goal runs (`training:*`, `training.json`, their turns; a run
//! chat's tools are answered here too, from turns.rs or `training:tool`).
//!
//! A run's turn goes through the router's `chat:send`, so the daemon admits it
//! when it admits the UI's turns.
//!
//! A task's or a workflow step's turn is a normal chat turn, sent through the
//! router (`chat:send`, the same door the UI uses, so the turn's events reach
//! the UI and the phone as any chat's do). Their chats are made the same way
//! (`session:create`) and named here. A skill step reads the installed skills
//! from nekko-workspace (`resolve_skill_defs`). Actions and polls are `nekko-connectors`'; shell steps run on
//! `nekko-tools`' shell, which kills the whole tree on a timeout.
//!
//! Owned only when the daemon knows the data directory.

use crate::hub::Hub;
use nekko_automation::tasks::{self, TaskHost, Tasks};
use nekko_automation::training::{Training, TrainingHost};
use nekko_automation::workflows::{ShellResult, WorkflowHost, Workflows};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

pub use nekko_automation::tasks::CHANNELS as TASK_CHANNELS;
pub use nekko_automation::training::{CHANNELS as TRAINING_CHANNELS, TOOL_CHANNEL as TRAINING_TOOL};
pub use nekko_automation::workflows::CHANNELS as WORKFLOW_CHANNELS;

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Runs a channel through the daemon's router.
pub type Dispatcher = Arc<dyn Fn(String, Vec<Value>) -> BoxFut<'static, Result<Value, String>> + Send + Sync>;

pub struct Automation {
    /// The data directory, when the daemon knows it.
    dir: Option<std::path::PathBuf>,
    pub tasks: Option<Arc<Tasks>>,
    pub workflows: Option<Arc<Workflows>>,
    /// Training and goal runs (`training:*`, `training.json`, their turns).
    pub training: Option<Arc<Training>>,
    dispatch: Arc<OnceLock<Dispatcher>>,
}

impl Automation {
    pub fn new(store: Option<Arc<SessionStore>>, settings: Option<Arc<crate::settings::Settings>>, hub: Hub) -> Self {
        let dispatch: Arc<OnceLock<Dispatcher>> = Arc::default();
        let data_dir = store.as_ref().and_then(|s| s.dir().parent().map(std::path::Path::to_path_buf));
        let (tasks, workflows, training) = match store {
            Some(store) => {
                let dir = store.dir().parent().map(std::path::Path::to_path_buf).unwrap_or_default();
                let engine = Arc::new(Engine { store, settings, hub, dispatch: dispatch.clone() });
                let clock = Tasks::system_clock();
                let ids: tasks::Ids = Arc::new(tasks::random_uuid);
                (
                    Some(Tasks::new(&dir, engine.clone(), clock.clone(), ids.clone())),
                    Some(Workflows::new(&dir, engine.clone(), clock.clone(), ids.clone())),
                    Some(Training::new(&dir, engine, clock, ids)),
                )
            }
            None => (None, None, None),
        };
        Self { dir: data_dir, tasks, workflows, training, dispatch }
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
            let dir = self.dir.clone();
            // Reconciling reads and writes files: off the async threads. A
            // PR checkout a stopped run left behind goes first.
            tokio::task::spawn_blocking(move || {
                if let Some(dir) = dir {
                    crate::pr_checkouts::sweep(&dir);
                }
                w.start()
            });
        }
        // Runs that were mid-flight when the last process stopped resume.
        if let Some(t) = &self.training {
            t.start();
        }
    }

    pub fn owns_training(&self) -> bool {
        self.training.is_some()
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
            _ => match &self.training {
                Some(t) if TRAINING_CHANNELS.contains(&channel) || channel == TRAINING_TOOL => {
                    t.route(channel, args).await
                }
                _ => Err(format!("{channel} is not served here")),
            },
        }
    }
}

/// Run a chat turn (`send`), listening on the bus meanwhile for the chat's
/// error events: the turn's own failure, which the caller reports (the TS
/// engine read it from its turn's callback). `Err` is a refusal of the call.
pub(crate) async fn capture_turn_error(
    hub: &Hub,
    opts: &Value,
    send: impl std::future::Future<Output = Result<(), String>>,
) -> Result<Option<String>, String> {
    let sid = opts.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
    let mut rx = hub.subscribe();
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
    let result = send.await;
    // Events published before the call returned are already queued for the watcher.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let _ = stop_tx.send(());
    let _ = watcher.await;
    result?;
    Ok(failed.lock().unwrap_or_else(|e| e.into_inner()).take())
}

/// The engine as tasks and workflows see it.
struct Engine {
    store: Arc<SessionStore>,
    settings: Option<Arc<crate::settings::Settings>>,
    hub: Hub,
    dispatch: Arc<OnceLock<Dispatcher>>,
}

/// Before main.rs sets the router.
const NO_ROUTER: &str = "the daemon is still starting";

impl Engine {
    async fn settings(&self) -> Value {
        let Some(s) = &self.settings else { return Value::Null };
        let store = s.store.clone();
        tokio::task::spawn_blocking(move || store.get()).await.unwrap_or(Value::Null)
    }

    async fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> Result<String, String> {
        let ws = workspace_id.unwrap_or(Value::Null);
        // Through the router: the chat defaults are applied there.
        let d = self.dispatch.get().ok_or(NO_ROUTER)?;
        let created = d("session:create".into(), vec![ws]).await?;
        let id = created.get("id").and_then(Value::as_str).ok_or("the host made no chat")?.to_string();
        let (store, sid) = (self.store.clone(), id.clone());
        tokio::task::spawn_blocking(move || store.assign(&sid, &fields)).await.map_err(|e| e.to_string())??;
        Ok(id)
    }

    /// A chat turn through the router (`chat:send`), as the UI sends one:
    /// admitted and run here.
    /// Every automation turn is unattended: nobody is watching it start.
    async fn send(&self, opts: Value) -> Result<(), String> {
        let opts = crate::claude_policy::mark_unattended(opts);
        let d = self.dispatch.get().ok_or(NO_ROUTER)?;
        d("chat:send".into(), vec![opts]).await.map(|_| ())
    }

    async fn delete_session(&self, id: String) {
        // Through the router: the chat's command log first, then the chat.
        if let Some(d) = self.dispatch.get() {
            let _ = d("session:delete".into(), vec![json!(id)]).await;
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
        Box::pin(Engine::send(self, opts))
    }

    fn notify(&self, list: &Value) {
        self.hub.publish("tasks:updated", list.clone(), false);
    }
}

impl TrainingHost for Engine {
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

    /// A run's turn is a normal chat turn, through the same door as the UI's.
    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<(), String>> {
        Box::pin(Engine::send(self, opts))
    }

    fn notify(&self, runs: &Value) {
        self.hub.publish("training:updated", runs.clone(), false);
    }
}

impl WorkflowHost for Engine {
    fn settings(&self) -> BoxFut<'_, Value> {
        Box::pin(Engine::settings(self))
    }

    fn update_session(&self, id: &str, fields: Vec<(&'static str, Value)>) -> BoxFut<'_, Result<(), String>> {
        let (store, sid) = (self.store.clone(), id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || store.assign(&sid, &fields)).await.map_err(|e| e.to_string())??;
            Ok(())
        })
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
        Box::pin(async move { capture_turn_error(&self.hub, &opts, Engine::send(self, opts.clone())).await })
    }

    fn abort_chat(&self, session_id: &str) {
        if let Some(d) = self.dispatch.get() {
            let fut = d("chat:abort".into(), vec![json!(session_id)]);
            tokio::spawn(fut);
        }
    }

    /// The skills a workflow's skill step can run: built-in, installed, other
    /// tools' `SKILL.md` folders (the user's and the projects') and Claude Code plugins.
    fn skill_defs(&self) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async move {
            let dir = self.store.dir().parent().map(std::path::Path::to_path_buf).unwrap_or_default();
            let roots: Vec<String> = Engine::settings(self)
                .await
                .get("workspaces")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|w| w.get("path").and_then(Value::as_str).map(str::to_string))
                .collect();
            let home = crate::workspace::home_dir();
            tokio::task::spawn_blocking(move || nekko_workspace::skills::resolve_skill_defs(&dir, &home, &roots))
                .await
                .unwrap_or_default()
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

    fn pr_checkout(&self, folder: &str, number: &str, run_id: &str) -> BoxFut<'_, Result<Value, String>> {
        let dir = self.store.dir().parent().map(std::path::Path::to_path_buf).unwrap_or_default();
        let (folder, number, run_id) = (folder.to_string(), number.to_string(), run_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || crate::pr_checkouts::make(&dir, &folder, &number, &run_id))
                .await
                .map_err(|e| e.to_string())?
        })
    }

    fn remove_pr_checkout(&self, checkout: &Value) -> BoxFut<'_, ()> {
        let checkout = checkout.clone();
        Box::pin(async move {
            let _ = tokio::task::spawn_blocking(move || crate::pr_checkouts::remove(&checkout)).await;
        })
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
