//! Machine stats and readiness, served from the daemon (`nekko-machine`):
//! the monitor meters' `gpu:stats` and `system:stats`, the offline-stack
//! advisor's `machine:readiness`, and the hardware profile and model
//! recommendations with their upgrade nudges (`machine:profile`,
//! `machine:recommendations`, `machine:dismissNudge`). The TS host
//! keeps its own probes for the engine's build choice and for running without
//! a daemon.

use crate::library::Library;
use nekko_machine::Machine;
use nekko_machine::measured::machine_key;
use serde_json::{Value, json};
use std::sync::Arc;

pub const CHANNELS: &[&str] = &[
    "gpu:stats",
    "system:stats",
    "machine:readiness",
    "machine:profile",
    "machine:recommendations",
    "machine:dismissNudge",
];

/// The picks for this machine now, and the machine they are for.
async fn current(machine: &Machine, refresh: bool) -> (nekko_machine::Recommendations, String) {
    let profile = machine.profile(refresh).await;
    let recs = nekko_machine::recommend(&profile, nekko_machine::bundled_feed(), &machine.speeds().snapshot());
    (recs, machine_key(&profile))
}

/// The model files in the library, for "do they already have one for this task".
async fn library_files(library: Option<&Arc<Library>>) -> Vec<String> {
    let Some(library) = library else { return Vec::new() };
    library
        .list()
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m.get("path").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// `{ refresh: true }` probes again rather than answering from the saved profile.
fn refresh(args: &[Value]) -> bool {
    args.first().and_then(|o| o.get("refresh")).and_then(Value::as_bool).unwrap_or(false)
}

pub async fn route(
    machine: &Machine,
    library: Option<&Arc<Library>>,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    match channel {
        "gpu:stats" => Ok(machine.gpu_stats().await.map_or(Value::Null, |s| s.to_value())),
        "system:stats" => Ok(machine.system_stats().await.unwrap_or(Value::Null)),
        // `opts.language ?? 'en'`.
        "machine:readiness" => {
            let language = match args.first() {
                None | Some(Value::Null) => "en".to_string(),
                Some(v) => nekko_js::display(v),
            };
            Ok(machine.readiness(&language).await)
        }
        "machine:profile" => serde_json::to_value(machine.profile(refresh(args)).await).map_err(|e| e.to_string()),
        "machine:recommendations" => {
            let (recs, key) = current(machine, refresh(args)).await;
            let nudges = match machine.data_dir() {
                Some(dir) => {
                    let files = library_files(library).await;
                    nekko_machine::nudges::nudges_for(dir, &recs, nekko_machine::bundled_feed(), &key, &files)
                }
                None => Vec::new(),
            };
            let mut v = serde_json::to_value(recs).map_err(|e| e.to_string())?;
            v["nudges"] = serde_json::to_value(nudges).map_err(|e| e.to_string())?;
            Ok(v)
        }
        // `task` (or every task with `null`): remember its current pick as seen.
        "machine:dismissNudge" => {
            let task = args.first().and_then(Value::as_str).map(str::to_string);
            let (recs, key) = current(machine, false).await;
            if let Some(dir) = machine.data_dir() {
                nekko_machine::nudges::dismiss(dir, &recs, &key, task.as_deref());
            }
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("{other} is not a machine channel")),
    }
}
