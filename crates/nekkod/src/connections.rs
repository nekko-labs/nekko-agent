//! Settings > Connections (#1034): keeps nekko-net's switch in step with
//! `settings.connections`, writes its events to `<dataDir>/logs/connections.log`
//! and serves them to the UI.
//!
//! The switch is applied before anything that reaches the network starts, so
//! a relay reconnect or an update check at startup already sees it.

use crate::settings::Settings;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const CHANNELS: &[&str] = &["connections:status", "connections:events", "connections:clear"];

pub const LOG: &str = "connections.log";
/// The log rotates at this size, keeping [`KEEP`] older files: about 6 MB in all.
pub const ROTATE_BYTES: u64 = 2 * 1024 * 1024;
pub const KEEP: usize = 2;
/// Events one `connections:events` call returns at most.
const EVENTS_MAX: usize = nekko_net::RECENT;

/// Apply the saved switch now (later saves: [`follow`]) and log to `<dataDir>/logs`.
pub fn start(data_dir: Option<&Path>, settings: Option<&Arc<Settings>>) {
    if let Some(s) = settings {
        nekko_net::configure(&s.store.get()["connections"]);
    }
    let Some(dir) = data_dir.map(|d| d.join("logs")) else { return };
    let path = dir.join(LOG);
    for old in (1..=KEEP).rev().map(|i| dir.join(format!("{LOG}.{i}"))).chain([path.clone()]) {
        if let Ok(text) = std::fs::read_to_string(old) {
            nekko_net::restore(&text);
        }
    }
    match crate::logs::RotatingLog::open(&path, ROTATE_BYTES, KEEP) {
        Ok(log) => {
            let log = Mutex::new(log);
            nekko_net::set_sink(move |line| {
                let mut l = log.lock().unwrap_or_else(|e| e.into_inner());
                let _ = l.append(format!("{line}\n").as_bytes());
            });
        }
        Err(e) => crate::logs::note(&format!("nekkod: could not open {}: {e}", path.display())),
    }
}

/// Apply each saved change to `settings.connections`, then bring the listeners
/// in line at once rather than at their next watch tick.
pub fn follow(ctx: crate::routes::Ctx) {
    let Some(s) = ctx.settings.clone() else { return };
    let mut changes = s.store.subscribe();
    tokio::spawn(async move {
        let mut last = changes.borrow().get("connections").cloned();
        nekko_net::configure(last.as_ref().unwrap_or(&Value::Null));
        while changes.changed().await.is_ok() {
            let next = changes.borrow_and_update().get("connections").cloned();
            if next == last {
                continue;
            }
            nekko_net::configure(next.as_ref().unwrap_or(&Value::Null));
            last = next;
            if let Some(d) = &ctx.desktop {
                d.connections_changed(&ctx).await;
            }
        }
    });
}

pub async fn route(data_dir: Option<&Path>, channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "connections:status" => Ok(nekko_net::summary()),
        "connections:events" => {
            let id = args.first().and_then(Value::as_str).ok_or("connections:events needs a connection id")?;
            if !nekko_net::IDS.contains(&id) {
                return Err(format!("not-found: no connection {id}"));
            }
            let limit = args.get(1).and_then(Value::as_u64).map_or(EVENTS_MAX, |n| (n as usize).min(EVENTS_MAX));
            Ok(json!(nekko_net::recent(id, limit)))
        }
        "connections:clear" => {
            nekko_net::clear();
            if let Some(dir) = data_dir.map(|d| d.join("logs")) {
                for i in 1..=KEEP {
                    let _ = std::fs::remove_file(dir.join(format!("{LOG}.{i}")));
                }
                // Truncate rather than delete: the sink holds the file open.
                let _ = std::fs::OpenOptions::new().write(true).truncate(true).open(dir.join(LOG));
            }
            Ok(nekko_net::summary())
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// Whether a chat runs offline: its own Offline switch, or All connections off.
pub fn offline(session: &Value) -> bool {
    nekko_js::truthy(session.get("offline")) || nekko_net::all_off()
}
