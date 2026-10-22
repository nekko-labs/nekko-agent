//! Machine stats and readiness, served from the daemon (`nekko-machine`):
//! the monitor meters' `gpu:stats` and `system:stats`, the offline-stack
//! advisor's `machine:readiness`, and the hardware profile and model
//! recommendations (`machine:profile`, `machine:recommendations`). The TS host
//! keeps its own probes for the engine's build choice and for running without
//! a daemon.

use serde_json::Value;

pub const CHANNELS: &[&str] =
    &["gpu:stats", "system:stats", "machine:readiness", "machine:profile", "machine:recommendations"];

/// `{ refresh: true }` probes again rather than answering from the saved profile.
fn refresh(args: &[Value]) -> bool {
    args.first().and_then(|o| o.get("refresh")).and_then(Value::as_bool).unwrap_or(false)
}

pub async fn route(machine: &nekko_machine::Machine, channel: &str, args: &[Value]) -> Result<Value, String> {
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
            let profile = machine.profile(refresh(args)).await;
            let recs = nekko_machine::recommend(&profile, nekko_machine::bundled_feed());
            serde_json::to_value(recs).map_err(|e| e.to_string())
        }
        other => Err(format!("{other} is not a machine channel")),
    }
}
