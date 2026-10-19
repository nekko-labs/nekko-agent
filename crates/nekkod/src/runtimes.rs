//! The runtime control plane and the Models page's server calls, served from
//! the daemon (`nekko-engine::runtimes`): `runtime:*`, `model:pull/load/unload`,
//! `lms:probe` and `server:stop`, over the daemon's own library, installers
//! and model server. The daemon is the only writer of
//! `runtime-calibration.json` and owns the servers it starts.

use nekko_engine::BoxFuture;
use nekko_engine::runtimes::{HostEngine, Probes, Runtimes, SystemIo};
use serde_json::{Value, json};
use std::sync::Arc;

pub const CHANNELS: &[&str] = &[
    "runtime:status",
    "runtime:start",
    "runtime:stop",
    "runtime:load",
    "runtime:facts",
    "runtime:plan",
    "runtime:autoFit",
    "model:pull",
    "model:load",
    "model:unload",
    "lms:probe",
    "server:stop",
];

/// The engine's side: the model list (the daemon's library), the install
/// state (its installers) and the model server.
struct DaemonEngine(
    Option<Arc<crate::library::Library>>,
    Option<Arc<crate::installs::Installs>>,
    Option<Arc<crate::model_server::Server>>,
);

impl HostEngine for DaemonEngine {
    fn call(&self, method: &'static str, args: Vec<Value>) -> BoxFuture<Result<Value, String>> {
        if method == "models"
            && let Some(library) = self.0.clone()
        {
            return Box::pin(async move { library.models().await });
        }
        if method == "detectEngine"
            && let Some(installs) = self.1.clone()
        {
            return Box::pin(async move { Ok(installs.detect("llama").await) });
        }
        if let Some(server) = self.2.clone() {
            let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
            let (first, second) = (arg(0), arg(1));
            match method {
                "isRunning" => return Box::pin(async move { Ok(json!(server.model.is_running())) }),
                "status" => return Box::pin(async move { Ok(server.status().await) }),
                "resident" => return Box::pin(async move { Ok(json!(server.model.resident())) }),
                "start" => return Box::pin(async move { Ok(server.model.start().await) }),
                "stop" => return Box::pin(async move { Ok(server.model.stop().await) }),
                "load" => {
                    return Box::pin(async move {
                        let params = if second.is_object() { second } else { json!({}) };
                        Ok(server.load(&nekko_js::display(&first), params).await)
                    });
                }
                "unload" => return Box::pin(async move { Ok(server.model.unload(&nekko_js::display(&first)).await) }),
                _ => {}
            }
        }
        Box::pin(async move { Err(format!("engine:{method}: no model server runs here")) })
    }
}

struct MachineProbes(Arc<nekko_machine::Machine>);

impl Probes for MachineProbes {
    fn gpu(&self) -> BoxFuture<Value> {
        let m = self.0.clone();
        Box::pin(async move { m.gpu_stats().await.map_or(Value::Null, |s| s.to_value()) })
    }
    fn system(&self) -> BoxFuture<Value> {
        let m = self.0.clone();
        Box::pin(async move { m.system_stats().await.unwrap_or(Value::Null) })
    }
}

/// The control plane over the daemon's settings store (the providers list).
pub fn new(
    settings: &crate::settings::Settings,
    machine: Arc<nekko_machine::Machine>,
    library: Option<Arc<crate::library::Library>>,
    installs: Option<Arc<crate::installs::Installs>>,
    server: Option<Arc<crate::model_server::Server>>,
) -> Arc<Runtimes> {
    let store = settings.store.clone();
    let data_dir = store.path().parent().map(std::path::Path::to_path_buf);
    let providers = move || store.get().get("providers").cloned().unwrap_or(Value::Null);
    Arc::new(Runtimes::new(
        Arc::new(SystemIo(reqwest::Client::new())),
        Arc::new(DaemonEngine(library, installs, server)),
        Arc::new(MachineProbes(machine)),
        Box::new(providers),
        data_dir,
    ))
}

/// Whether a saved provider is switched off (an unknown id is not "disabled").
async fn disabled(ctx: &crate::routes::Ctx, id: &str) -> bool {
    crate::settings::current(ctx)
        .await
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id)))
        .is_some_and(|p| !crate::providers::is_enabled(p))
}

pub async fn route(ctx: &crate::routes::Ctx, rt: &Runtimes, channel: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let s = |i: usize| nekko_js::display(arg(i));
    let params = |i: usize| if arg(i).is_object() { arg(i).clone() } else { json!({}) };
    // The Models page polls status, facts and the `lms` probe. A provider
    // switched off there answers as absent, so polling never spawns `lms` or
    // touches its server (and so cannot wake a stopped LM Studio).
    if matches!(channel, "runtime:status" | "runtime:facts" | "runtime:plan" | "runtime:autoFit" | "lms:probe")
        && disabled(ctx, &s(0)).await
    {
        return Ok(match channel {
            "runtime:facts" => json!([]),
            "lms:probe" => json!({ "available": false, "reason": crate::providers::DISABLED }),
            _ => Value::Null,
        });
    }
    Ok(match channel {
        "runtime:status" => rt.status(&s(0)).await,
        "runtime:start" => rt.start(&s(0)).await,
        "runtime:stop" => {
            // The engine's speech server goes down with it, as in the host.
            if s(0) == "nekko-engine"
                && let Some(voice) = &ctx.voice
            {
                voice.stop().await;
            }
            rt.stop(&s(0), nekko_js::truthy(Some(arg(1)))).await
        }
        "runtime:load" => rt.load(&s(0), &s(1), &params(2)).await,
        "runtime:facts" => Value::Array(rt.facts(&s(0)).await),
        "runtime:plan" => rt.plan(&s(0), &s(1), arg(2)).await,
        "runtime:autoFit" => rt.auto_plan(&s(0), &s(1), arg(2), arg(3)).await,
        "model:pull" => rt.pull_model(&s(0), &s(1)).await,
        "model:load" => rt.load_model(&s(0), &s(1)).await,
        "model:unload" => rt.unload_model(&s(0), &s(1)).await,
        "lms:probe" => rt.lms_probe(&s(0)).await,
        "server:stop" => rt.stop_server(&s(0)).await,
        other => return Err(format!("{other} is not a runtime channel")),
    })
}
