//! `settings.json`: the daemon is its single writer (`nekko-settings`).
//!
//! The UI's `settings:get/update/reset` are served here. The TS host keeps a
//! cached copy for its own services and sends its writes here
//! (`settings:save`, `settings:resetHost`) instead of touching the file; the
//! backend learns that it must from `NEKKOD_OWNS=settings` in its
//! environment. After a write the UI asked for, the host hears it
//! (`settings:changed` with the new settings and the patch) so its cache
//! follows and it runs what `updateSettings` used to (stopping voice when the
//! voice settings change, re-reading the messaging config). Daemon services
//! read with [`current`] and write with [`update`].

use crate::routes::Ctx;
use nekko_settings::SettingsStore;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::mpsc;

/// The channels served here while the daemon knows the data directory.
pub const CHANNELS: &[&str] =
    &["settings:get", "settings:update", "settings:reset", "settings:save", "settings:resetHost"];

/// What the backend is told the daemon owns (`NEKKOD_OWNS`).
pub const OWNS: &str = "settings";

/// The settings store and the queue that tells the host about changes, in
/// the order they were saved.
pub struct Settings {
    pub store: Arc<SettingsStore>,
    notify: mpsc::UnboundedSender<Value>,
}

impl Settings {
    pub fn new(dir: std::path::PathBuf, backend: Arc<crate::backend::Backend>) -> Arc<Self> {
        let (notify, mut rx) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            while let Some(args) = rx.recv().await {
                // A backend that is down catches up from the file when it starts.
                let _ = backend.call("settings:changed", args).await;
            }
        });
        Arc::new(Settings { store: Arc::new(SettingsStore::new(dir)), notify })
    }

    fn changed(&self, settings: &Value, patch: &Value) {
        let _ = self.notify.send(json!([settings, patch]));
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

pub async fn route(s: &Arc<Settings>, channel: &str, args: &[Value]) -> Result<Value, String> {
    let store = s.store.clone();
    let patch = args.first().cloned().unwrap_or(Value::Null);
    match channel {
        "settings:get" => blocking(move || store.get()).await,
        "settings:update" => {
            let p = patch.clone();
            let next = blocking(move || store.update(&p)).await??;
            s.changed(&next, &patch);
            Ok(next)
        }
        "settings:reset" => {
            let next = blocking(move || store.reset()).await??;
            s.changed(&next, &Value::Null);
            Ok(next)
        }
        // The host's own writes: it already applied them to its copy.
        "settings:save" => blocking(move || store.update(&patch)).await?,
        "settings:resetHost" => blocking(move || store.reset()).await?,
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// The current settings: the daemon's when it owns them, else the host's
/// (`settings:get`), else `null` when the host does not answer in time.
pub async fn current(ctx: &Ctx) -> Value {
    if let Some(s) = &ctx.settings {
        let store = s.store.clone();
        return blocking(move || store.get()).await.unwrap_or(Value::Null);
    }
    match tokio::time::timeout(crate::routes::AUX_WAIT, ctx.backend.call("settings:get", json!([]))).await {
        Ok(Ok(v)) => v,
        _ => Value::Null,
    }
}

/// Save a patch as `saveSettings` would, from a daemon service, and tell the
/// host. Without a data directory the host saves it.
#[allow(dead_code)]
pub async fn update(ctx: &Ctx, patch: Value) -> Result<Value, String> {
    match &ctx.settings {
        Some(s) => route(s, "settings:update", &[patch]).await,
        None => ctx.backend.call("settings:update", json!([patch])).await,
    }
}
