//! Automation owned by the daemon (PF14): tasks (`tasks:*`, `task:*`,
//! `tasks.json` and the scheduler) from `nekko-automation`.
//!
//! A task's turn is a normal chat turn: the daemon asks the TS host to admit
//! it (`chat:send`, the same door the UI uses, so the turn's events reach the
//! UI and the phone as any chat's do). A task's chat is made by the host
//! (`session:create`, which owns the chat defaults) and named here.
//!
//! Owned only when the daemon knows the data directory; otherwise every task
//! channel goes to the TS host, which then runs its own scheduler.

use crate::backend::Backend;
use crate::hub::Hub;
use nekko_automation::tasks::{BoxFut, TaskHost, Tasks};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::Arc;

pub use nekko_automation::tasks::CHANNELS as TASK_CHANNELS;

/// What the backend is told the daemon owns (`NEKKOD_OWNS`): tasks.json and the scheduler.
pub const OWNS: &str = "tasks";

/// How long a task waits on the host for the settings before going without.
const SETTINGS_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

pub struct Automation {
    pub tasks: Option<Arc<Tasks>>,
}

impl Automation {
    pub fn new(
        store: Option<Arc<SessionStore>>,
        settings: Option<Arc<crate::settings::Settings>>,
        backend: Arc<Backend>,
        hub: Hub,
    ) -> Self {
        let tasks = store.map(|store| {
            let dir = store.dir().parent().map(std::path::Path::to_path_buf).unwrap_or_default();
            let host = Arc::new(Engine { store, settings, backend, hub });
            Tasks::new(dir, host, Tasks::system_clock(), Arc::new(nekko_automation::tasks::random_uuid))
        });
        Self { tasks }
    }

    pub fn start(&self) {
        if let Some(t) = &self.tasks {
            t.start();
        }
    }

    pub fn owns_tasks(&self) -> bool {
        self.tasks.is_some()
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        match &self.tasks {
            Some(t) if TASK_CHANNELS.contains(&channel) => t.route(channel, args).await,
            _ => Err(format!("{channel} is not served here")),
        }
    }
}

/// The engine as a task sees it: the session store, the host, the event bus.
struct Engine {
    store: Arc<SessionStore>,
    settings: Option<Arc<crate::settings::Settings>>,
    backend: Arc<Backend>,
    hub: Hub,
}

impl TaskHost for Engine {
    fn settings(&self) -> BoxFut<'_, Value> {
        Box::pin(async move {
            if let Some(s) = &self.settings {
                let store = s.store.clone();
                return tokio::task::spawn_blocking(move || store.get()).await.unwrap_or(Value::Null);
            }
            match tokio::time::timeout(SETTINGS_WAIT, self.backend.call("settings:get", json!([]))).await {
                Ok(Ok(v)) => v,
                _ => Value::Null,
            }
        })
    }

    fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> BoxFut<'_, Result<String, String>> {
        Box::pin(async move {
            let ws = workspace_id.unwrap_or(Value::Null);
            let created = self.backend.call("session:create", json!([ws])).await?;
            let id = created.get("id").and_then(Value::as_str).ok_or("the host made no chat")?.to_string();
            let (store, sid) = (self.store.clone(), id.clone());
            tokio::task::spawn_blocking(move || store.assign(&sid, &fields)).await.map_err(|e| e.to_string())??;
            Ok(id)
        })
    }

    fn get_session(&self, id: &str) -> Option<Value> {
        self.store.get(id)
    }

    fn delete_session(&self, id: &str) -> BoxFut<'_, ()> {
        let id = id.to_string();
        Box::pin(async move {
            // As `session:delete` does: the host's command log first, then the chat.
            if self.backend.call("sessions:deleteAgentLog", json!([id])).await.is_ok() {
                let store = self.store.clone();
                let _ = tokio::task::spawn_blocking(move || store.delete(&id)).await;
            }
        })
    }

    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<(), String>> {
        Box::pin(async move { self.backend.call("chat:send", json!([opts])).await.map(|_| ()) })
    }

    fn notify(&self, tasks: &Value) {
        self.hub.publish("tasks:updated", tasks.clone(), false);
    }
}
