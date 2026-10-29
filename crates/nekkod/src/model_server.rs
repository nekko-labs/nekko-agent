//! The model server's policy, run in the daemon (`nekko_engine::server`)
//! over its own processes and port (`nekko-infer`): `engine:status`,
//! `engine:settings`, `engine:residentTtl` and `engine:generateImage`, the
//! router's questions about models it does not have running, and for the
//! runtime control plane, `engine:start`, `engine:stop`, `engine:load`,
//! `engine:unload`, `engine:resident`, `engine:running` and
//! `engine:loadedIds`.

use crate::installs::Installs;
use crate::library::{Library, engine_settings};
use nekko_engine::server::{Daemon, Env, ModelServer};
use nekko_engine::{BoxFuture, acquire, folders, launch};
use nekko_infer::{ServeConfig, SpawnSpec};
use nekko_tools::path::native as path;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHANNELS: &[&str] = &[
    "engine:status",
    "engine:settings",
    "engine:residentTtl",
    "engine:generateImage",
    "engine:start",
    "engine:stop",
    "engine:load",
    "engine:unload",
    "engine:resident",
    "engine:running",
    "engine:loadedIds",
];

/// The daemon's own processes and router, as the policy drives them.
struct Processes(Arc<crate::engine::Engine>);

impl Daemon for Processes {
    fn serve(&self, config: Value) -> BoxFuture<Value> {
        let engine = self.0.clone();
        Box::pin(async move {
            match serde_json::from_value::<ServeConfig>(config) {
                Ok(cfg) => match engine.router.serve(cfg).await {
                    Ok(m) => json!({ "ok": true, "message": m }),
                    Err(e) => json!({ "ok": false, "message": e }),
                },
                Err(e) => json!({ "ok": false, "message": format!("bad serve config: {e}") }),
            }
        })
    }
    fn stop_serving(&self) -> BoxFuture<()> {
        self.0.router.stop();
        Box::pin(async {})
    }
    fn serving(&self) -> BoxFuture<bool> {
        let serving = self.0.router.serving().is_some();
        Box::pin(async move { serving })
    }
    fn spawn(&self, spec: Value) -> BoxFuture<Value> {
        let engine = self.0.clone();
        Box::pin(async move {
            match serde_json::from_value::<SpawnSpec>(spec) {
                Ok(spec) => serde_json::to_value(engine.supervisor.spawn(spec).await).unwrap_or(Value::Null),
                Err(e) => json!({ "status": "failed", "message": format!("bad spawn spec: {e}"), "log": [] }),
            }
        })
    }
    fn kill(&self, model_id: String) -> BoxFuture<bool> {
        let killed = self.0.supervisor.kill(&model_id);
        Box::pin(async move { killed })
    }
    fn list(&self) -> BoxFuture<Vec<Value>> {
        let list = self.0.supervisor.list().into_iter().filter_map(|c| serde_json::to_value(c).ok()).collect();
        Box::pin(async move { list })
    }
}

/// What the policy reads from the rest of the daemon.
struct Surroundings {
    settings: Arc<crate::settings::Settings>,
    data_dir: String,
    library: Arc<Library>,
    installs: Arc<Installs>,
    machine: Arc<nekko_machine::Machine>,
    flags: Arc<Mutex<HashMap<String, Arc<HashSet<String>>>>>,
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// `--help`'s text, when it names flags (`helpText`).
async fn help_text(bin: &str) -> Option<String> {
    let mut c = tokio::process::Command::new(bin);
    c.arg("--help").stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(10), c.output()).await.ok()?.ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    text.contains("--").then_some(text)
}

impl Env for Surroundings {
    fn settings(&self) -> Value {
        Value::Object(engine_settings(&self.settings.store.get()))
    }
    fn prompt_caching(&self) -> bool {
        self.settings.store.get().get("promptCaching") != Some(&Value::Bool(false))
    }
    fn bin(&self, runtime: &'static str) -> BoxFuture<Option<String>> {
        let installs = self.installs.clone();
        Box::pin(
            async move { installs.detect(runtime).await.get("binPath").and_then(Value::as_str).map(str::to_string) },
        )
    }
    fn gpu_capable(&self) -> BoxFuture<Option<bool>> {
        let installs = self.installs.clone();
        Box::pin(async move {
            let install = installs.detect("llama").await;
            let backend = install.get("backend").filter(|b| !b.is_null());
            Some(backend.is_some_and(|b| b.as_str() != Some("cpu")))
        })
    }
    fn find_model(&self, id: String) -> BoxFuture<Option<Value>> {
        let library = self.library.clone();
        Box::pin(async move { library.find(&id).await.ok().flatten() })
    }
    fn list_models(&self) -> BoxFuture<Vec<Value>> {
        let library = self.library.clone();
        Box::pin(async move { library.list().await.unwrap_or_default() })
    }
    fn gpu(&self) -> BoxFuture<Option<Value>> {
        let machine = self.machine.clone();
        Box::pin(async move { machine.gpu_stats_fresh().await.map(|s| s.to_value()) })
    }
    fn flags(&self, bin: String) -> BoxFuture<Arc<HashSet<String>>> {
        // Read once per binary: the engine is installed once and kept. A build
        // we cannot ask knows none of the newer flags.
        let cache = self.flags.clone();
        Box::pin(async move {
            if let Some(known) = cache.lock().unwrap().get(&bin).cloned() {
                return known;
            }
            let known = Arc::new(help_text(&bin).await.map(|t| launch::known_flags(&t)).unwrap_or_default());
            cache.lock().unwrap().insert(bin, known.clone());
            known
        })
    }
    fn work_dir(&self) -> Option<String> {
        Some(path::join(&[&self.data_dir, "engine", "templates"]))
    }
    fn companions_dir(&self, model_id: &str) -> Option<String> {
        Some(folders::companions_dir(&self.library.models_dir(), model_id))
    }
    fn image_companions_dir(&self) -> Option<String> {
        Some(acquire::image_companions_dir(&self.library.models_dir()))
    }
    fn vc_runtime(&self, bin_dir: &str) -> Vec<String> {
        let vc = nekko_engine::install::VcOptions {
            system_dir: None,
            runtime_dir: std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned())),
        };
        nekko_engine::install::ensure_vc_runtime(bin_dir, platform(), &vc)
    }
    fn now(&self) -> f64 {
        nekko_js::now_ms_f64()
    }
    fn clock(&self) -> String {
        let secs = (nekko_js::now_ms_f64() / 1000.0) as u64 % 86_400;
        format!("{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
    }
    fn on_serving(&self, base_url: String) -> BoxFuture<()> {
        let settings = self.settings.clone();
        Box::pin(async move { ensure_engine_provider(&settings, &base_url).await })
    }
}

/// Keep one provider entry pointing at the engine (`ensureEngineProvider`).
pub async fn ensure_engine_provider(settings: &Arc<crate::settings::Settings>, base_url: &str) {
    let current = settings.store.get();
    let providers: Vec<Value> = current.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
    let existing = providers.iter().find(|p| p.get("kind").and_then(Value::as_str) == Some("llamacpp"));
    if existing.and_then(|e| e.get("baseUrl")).and_then(Value::as_str) == Some(base_url) {
        return;
    }
    let pick = |k: &str, d: &str| existing.and_then(|e| e.get(k)).filter(|v| !v.is_null()).cloned().unwrap_or(json!(d));
    let entry = json!({
        "id": pick("id", "nekko-engine"),
        "kind": "llamacpp",
        "label": pick("label", "Nekko Agent engine"),
        "baseUrl": base_url,
        "enabled": true,
    });
    let mut next: Vec<Value> = providers.into_iter().filter(|p| p.get("id") != entry.get("id")).collect();
    next.push(entry);
    let _ = crate::settings::route(settings, "settings:update", &[json!({ "providers": next })]).await;
}

/// The model server and the engine facade's calls on it.
pub struct Server {
    pub model: Arc<ModelServer>,
    library: Arc<Library>,
    installs: Arc<Installs>,
    machine: Arc<nekko_machine::Machine>,
    client: reqwest::Client,
}

impl Server {
    pub fn new(
        settings: Arc<crate::settings::Settings>,
        data_dir: String,
        library: Arc<Library>,
        installs: Arc<Installs>,
        machine: Arc<nekko_machine::Machine>,
        engine: Arc<crate::engine::Engine>,
    ) -> Arc<Self> {
        let env = Arc::new(Surroundings {
            settings,
            data_dir,
            library: library.clone(),
            installs: installs.clone(),
            machine: machine.clone(),
            flags: Arc::default(),
        });
        let model = ModelServer::new(env, Arc::new(Processes(engine)), true);
        Arc::new(Self { model, library, installs, machine, client: reqwest::Client::new() })
    }

    /// Loading is the moment a user expects the engine up, so it starts it (`load`).
    pub async fn load(&self, id: &str, params: Value) -> Value {
        if !self.model.is_running() {
            let started = self.model.start().await;
            if started.get("ok") != Some(&Value::Bool(true)) {
                return json!({ "ok": false, "message": started.get("message").cloned().unwrap_or(Value::Null) });
            }
        }
        self.model.load(id, params).await
    }

    /// Everything the engine card needs in one read (`status`).
    pub async fn status(&self) -> Value {
        let install = self.installs.detect("llama").await;
        let state = self.model.status();
        let gpu = self.machine.gpu_stats().await.map(|s| s.to_value());
        let (total, _) = nekko_machine::probe::memory_now();
        let mut m = Map::new();
        m.insert("install".into(), install);
        m.insert("diffusionInstall".into(), self.installs.detect("diffusion").await);
        m.insert("mlxInstall".into(), self.installs.detect("mlx").await);
        for k in ["running", "startedAt", "resident", "loading", "log", "port"] {
            if let Some(v) = state.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
        m.insert("settings".into(), Value::Object(engine_settings(&self.library.settings())));
        m.insert("memory".into(), launch::engine_memory(gpu.as_ref(), total));
        Value::Object(m)
    }

    /// One image from a loaded (or loadable) image model (`generateImage`).
    async fn generate_image(&self, request: &Value) -> Result<Value, String> {
        self.generate_image_with(request, &mut |_| {}).await
    }

    /// `generateImage(request, onStage)`: `on_stage` hears `loading` when the
    /// model has to be loaded first (most of a cold request), then `generating`.
    pub async fn generate_image_with(
        &self,
        request: &Value,
        on_stage: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Value, String> {
        let body = launch::image_generation_body(request)?;
        let id = request.get("modelId").map(nekko_js::display).unwrap_or_default();
        let model = self.library.find(&id).await?;
        let Some(model) = model.filter(|m| m.get("modality").and_then(Value::as_str) == Some("image")) else {
            return Err("Choose an image-generation model.".into());
        };
        if !self.model.loaded_ids().contains(&id) {
            on_stage("loading");
        }
        let preset = model.get("preset").filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
        let started = self.load(&id, preset).await;
        if started.get("ok") != Some(&Value::Bool(true)) {
            return Err(started.get("message").map(nekko_js::display).unwrap_or_default());
        }
        on_stage("generating");
        let settings = engine_settings(&self.library.settings());
        let port = settings.get("port").map(nekko_js::display).unwrap_or_default();
        let mut req = self
            .client
            .post(format!("http://127.0.0.1:{port}/v1/images/generations"))
            .header("content-type", "application/json")
            .body(body)
            .timeout(Duration::from_secs(30 * 60));
        if let Some(key) = nekko_js::truthy_str(settings.get("apiKey")) {
            req = req.header("authorization", format!("Bearer {key}"));
        }
        let res = req.send().await.map_err(|_| "fetch failed".to_string())?;
        let status = res.status();
        let result: Value = res.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() || result.get("data").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return Err(result
                .get("error")
                .and_then(|e| e.get("message"))
                .filter(|m| !m.is_null())
                .map(nekko_js::display)
                .unwrap_or_else(|| format!("Image generation failed (HTTP {}).", status.as_u16())));
        }
        Ok(result)
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let text = |i: usize| nekko_js::display(&arg(i));
        Ok(match channel {
            "engine:status" => self.status().await,
            "engine:settings" => {
                let patch = if arg(0).is_object() { arg(0) } else { json!({}) };
                let next = self.library.save_engine(patch.clone()).await?;
                // The port, binding, key and CORS list are the listener's: re-serve, models stay.
                if self.model.is_running() && launch::reserves_endpoint(&patch) {
                    self.model.reconfigure().await;
                }
                next
            }
            "engine:residentTtl" => {
                let r = self.model.set_resident_ttl(&text(0), args.get(1));
                json!({ "ok": r["ok"], "message": r.get("message").cloned().unwrap_or(json!("")) })
            }
            "engine:generateImage" => return self.generate_image(&arg(0)).await,
            "engine:start" => self.model.start().await,
            "engine:stop" => self.model.stop().await,
            "engine:load" => {
                let params = if arg(1).is_object() { arg(1) } else { json!({}) };
                self.load(&text(0), params).await
            }
            "engine:unload" => self.model.unload(&text(0)).await,
            "engine:resident" => json!(self.model.resident()),
            "engine:running" => json!(self.model.is_running()),
            "engine:loadedIds" => json!(self.model.loaded_ids()),
            other => return Err(format!("{other} is not a model-server channel")),
        })
    }
}
