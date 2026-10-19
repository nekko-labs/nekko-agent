//! The model server's data plane, served from the daemon (`nekko-infer`).
//!
//! The daemon owns the model processes and the OpenAI-compatible port in
//! front of them. When the router needs a model that is not running, the
//! model server's policy (model_server.rs) loads it.

use crate::decide::{DecideService, RouterDecisions};
use nekko_infer::{BoxFuture, EngineRouter, Policy, ServeConfig, SpawnSpec, Supervisor};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct Engine {
    pub supervisor: Arc<Supervisor>,
    /// The model server's policy, once the daemon runs it (`model_server.rs`);
    /// until then the router asks the TS engine.
    pub server: Arc<std::sync::OnceLock<Arc<nekko_engine::server::ModelServer>>>,
    pub router: EngineRouter,
    /// The resident decision model, shared by the `decide:*` channels and the router.
    pub decide: Arc<DecideService>,
}

impl Engine {
    pub fn new() -> Self {
        let supervisor = Arc::new(Supervisor::new());
        let decide = DecideService::new();
        let server: Arc<std::sync::OnceLock<Arc<nekko_engine::server::ModelServer>>> = Arc::default();
        let router = EngineRouter::new(supervisor.clone(), Arc::new(ServerPolicy { server: server.clone() }))
            .with_decisions(Arc::new(RouterDecisions(decide.clone())));
        Self { supervisor, server, router, decide }
    }

    pub fn shutdown(&self) {
        self.router.stop();
        self.supervisor.kill_all();
    }
}

/// The model server's answers, from the daemon's own policy once it runs it
/// (no data directory, no model server).
struct ServerPolicy {
    server: Arc<std::sync::OnceLock<Arc<nekko_engine::server::ModelServer>>>,
}

const NO_SERVER: &str = "No model server runs here.";

impl Policy for ServerPolicy {
    fn load(&self, model: String, image: bool) -> BoxFuture<Result<(), (u16, String)>> {
        let server = self.server.get().cloned();
        Box::pin(async move {
            let server = server.ok_or((503, NO_SERVER.to_string()))?;
            let r = server.router_load(&model, image).await;
            if r.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            let status = r.get("status").and_then(Value::as_u64).unwrap_or(503) as u16;
            let message = r.get("message").and_then(Value::as_str).unwrap_or("Couldn't load the model.").to_string();
            Err((status, message))
        })
    }

    fn models(&self) -> BoxFuture<Result<Value, String>> {
        let server = self.server.get().cloned();
        Box::pin(async move { Ok(server.ok_or(NO_SERVER)?.router_models().await) })
    }

    fn model(&self, id: String) -> BoxFuture<Result<Option<Value>, String>> {
        let server = self.server.get().cloned();
        Box::pin(async move {
            let v = server.ok_or(NO_SERVER)?.router_model(&id).await;
            Ok((!v.is_null()).then_some(v))
        })
    }
}

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

/// The `infer:*` and `decide:*` channels.
pub async fn route(engine: &Engine, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if channel.starts_with("decide:") {
        return crate::decide::route(&engine.decide, channel, args).await;
    }
    Some(match channel {
        "infer:serve" => match serde_json::from_value::<ServeConfig>(arg(args, 0).clone()) {
            Ok(cfg) => engine.router.serve(cfg).await.map(|m| json!({ "ok": true, "message": m })),
            Err(e) => Err(format!("bad serve config: {e}")),
        },
        "infer:stopServing" => {
            engine.router.stop();
            Ok(Value::Null)
        }
        "infer:serving" => Ok(serde_json::to_value(engine.router.serving()).unwrap_or(Value::Null)),
        "infer:spawn" => match serde_json::from_value::<SpawnSpec>(arg(args, 0).clone()) {
            Ok(spec) => Ok(serde_json::to_value(engine.supervisor.spawn(spec).await).unwrap_or(Value::Null)),
            Err(e) => Err(format!("bad spawn spec: {e}")),
        },
        "infer:kill" => Ok(json!(engine.supervisor.kill(arg(args, 0).as_str().unwrap_or_default()))),
        "infer:list" => Ok(serde_json::to_value(engine.supervisor.list()).unwrap_or(json!([]))),
        "infer:log" => Ok(json!(engine.supervisor.log(arg(args, 0).as_str().unwrap_or_default()))),
        _ => return None,
    })
}
