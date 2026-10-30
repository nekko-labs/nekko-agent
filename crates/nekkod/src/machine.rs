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
use serde_json::{Map, Value, json};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

/// `machine:summary` (2026-10-24): one read for a phone's computer page. Routed
/// with the daemon's context (it reads the model server too), see `routes.rs`.
pub const SUMMARY: &str = "machine:summary";

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

// ---- machine:summary ----

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Called once at start, so `machine:summary` can say how long the daemon has been up.
pub fn mark_started() {
    let _ = STARTED.set(Instant::now());
}

fn uptime_ms() -> u64 {
    STARTED.get().map_or(0, |t| t.elapsed().as_millis() as u64)
}

/// `machine:summary`: what a phone's computer page shows in one read, from
/// what the daemon already answers the desktop: `app:info`, `machine:profile`,
/// `system:stats`, `gpu:stats` and `engine:status`. Built to be phone-safe:
/// no paths, serial numbers, user names or addresses (`summary_value`).
pub async fn summary(ctx: &crate::routes::Ctx) -> Value {
    let profile = serde_json::to_value(ctx.machine.profile(false).await).unwrap_or(Value::Null);
    let live = ctx.machine.system_stats().await.unwrap_or(Value::Null);
    let gpu = ctx.machine.gpu_stats().await.map_or(Value::Null, |s| s.to_value());
    let engine = ctx.server.status().await;
    summary_value(&crate::small_services::app_info(&ctx.app.facts), &profile, &live, &gpu, &engine, uptime_ms())
}

/// The summary from its parts. `hardware` is the profile without its probe
/// bookkeeping; `engine` keeps the server's state and its resident models by
/// id and name (never their files), and counts what is loading.
pub fn summary_value(
    info: &Value,
    profile: &Value,
    live: &Value,
    gpu: &Value,
    engine: &Value,
    uptime_ms: u64,
) -> Value {
    let mut out = Map::new();
    for k in ["version", "platform", "edition"] {
        if let Some(v) = info.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    out.insert("uptimeMs".into(), json!(uptime_ms));
    let hardware = match profile.as_object() {
        Some(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| !matches!(k.as_str(), "format" | "probedAt"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        None => Value::Null,
    };
    out.insert("hardware".into(), hardware);
    out.insert("live".into(), if live.is_object() { live.clone() } else { Value::Null });
    out.insert("gpu".into(), if gpu.is_object() { gpu.clone() } else { Value::Null });
    let engine = match engine.as_object() {
        Some(o) => {
            let mut e = Map::new();
            e.insert("running".into(), json!(o.get("running").and_then(Value::as_bool).unwrap_or(false)));
            if let Some(t) = o.get("startedAt").filter(|t| t.is_number()) {
                e.insert("startedAt".into(), t.clone());
            }
            let resident: Vec<Value> = o
                .get("resident")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|m| {
                            let id = m.get("id")?.as_str()?;
                            let mut r = Map::new();
                            r.insert("id".into(), json!(id));
                            for k in ["name", "contextTokens"] {
                                if let Some(v) = m.get(k).filter(|v| !v.is_null()) {
                                    r.insert(k.into(), v.clone());
                                }
                            }
                            Some(Value::Object(r))
                        })
                        .collect()
                })
                .unwrap_or_default();
            e.insert("resident".into(), Value::Array(resident));
            e.insert("loading".into(), json!(o.get("loading").and_then(Value::as_array).map_or(0, Vec::len)));
            if let Some(m) = o.get("memory").filter(|m| m.is_object()) {
                e.insert("memory".into(), m.clone());
            }
            Value::Object(e)
        }
        None => Value::Null,
    };
    out.insert("engine".into(), engine);
    Value::Object(out)
}

#[cfg(test)]
mod summary_tests {
    use super::*;

    #[test]
    fn a_summary_keeps_the_phone_safe_parts_of_each_read() {
        let info = json!({ "version": "0.9.3", "platform": "darwin", "edition": "desktop" });
        let profile = json!({ "format": 1, "probedAt": 5, "platform": "darwin", "arch": "arm64", "release": "25.1.0",
            "cpu": { "model": "Apple M4 Max", "cores": 16 }, "ramBytes": 137438953472.0, "unified": true,
            "gpus": [{ "name": "Apple M4 Max", "vramBytes": 137438953472.0, "cores": 40 }], "backends": ["metal", "cpu"],
            "engine": { "backend": "metal", "version": "b7000" }, "diskFreeBytes": 1e12 });
        let live = json!({ "cpuPct": 12.5, "cpuCores": 16, "memUsedMB": 61000, "memTotalMB": 131072, "temps": { "cpuC": 48 } });
        let gpu = json!({ "source": "macos", "devices": [], "unified": true, "totalMB": 131072, "usedMB": 15000, "freeMB": 116072 });
        let engine = json!({ "install": { "state": "installed", "path": "/Users/me/engine" }, "running": true, "startedAt": 1_000,
            "resident": [{ "id": "qwen3", "name": "Qwen3 Coder", "path": "/Users/me/models/qwen3.gguf", "contextTokens": 32768 }, { "name": "no id" }],
            "loading": [{ "id": "gemma" }], "log": ["secret-looking line"], "port": 1441, "settings": { "key": "k" },
            "memory": { "totalMB": 131072, "kind": "unified" } });
        let s = summary_value(&info, &profile, &live, &gpu, &engine, 12_345);
        assert_eq!(s["version"], "0.9.3");
        assert_eq!(s["uptimeMs"], 12_345);
        assert_eq!(s["hardware"]["cpu"]["model"], "Apple M4 Max");
        assert!(s["hardware"].get("format").is_none() && s["hardware"].get("probedAt").is_none());
        assert_eq!(s["live"]["memUsedMB"], 61000);
        assert_eq!(s["gpu"]["usedMB"], 15000);
        assert_eq!(
            s["engine"],
            json!({ "running": true, "startedAt": 1_000, "resident": [{ "id": "qwen3", "name": "Qwen3 Coder", "contextTokens": 32768 }],
            "loading": 1, "memory": { "totalMB": 131072, "kind": "unified" } })
        );
        let text = s.to_string();
        assert!(!text.contains("/Users") && !text.contains("secret-looking") && !text.contains("1441"));
        let empty = summary_value(&json!({}), &Value::Null, &Value::Null, &Value::Null, &Value::Null, 0);
        assert_eq!(empty, json!({ "uptimeMs": 0, "hardware": null, "live": null, "gpu": null, "engine": null }));
    }
}
