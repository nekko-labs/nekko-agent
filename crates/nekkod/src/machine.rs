//! Machine stats and readiness, served from the daemon (`nekko-machine`):
//! the monitor meters' `gpu:stats` and `system:stats`, and the offline-stack
//! advisor's `machine:readiness`. The TS host keeps its own probes for the
//! engine's build choice and for running without a daemon.

use serde_json::Value;

pub const CHANNELS: &[&str] = &["gpu:stats", "system:stats", "machine:readiness"];

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
        other => Err(format!("{other} is not a machine channel")),
    }
}
