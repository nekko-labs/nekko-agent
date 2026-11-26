//! The model server's policy, run in the daemon (`nekko_engine::server`)
//! over its own processes and port (`nekko-infer`): `engine:status`,
//! `engine:settings`, `engine:residentTtl` and `engine:generateImage`, the
//! router's questions about models it does not have running, and for the
//! runtime control plane, `engine:start`, `engine:stop`, `engine:load`,
//! `engine:unload`, `engine:resident`, `engine:running`,
//! `engine:loadedIds`, and for the low-memory prompt, `engine:memory` (what
//! the loaded models hold) and `engine:unloadAll` ("Shut down Nekko's local
//! models"), and for the model scheduler, `engine:loadTimes`.

use crate::installs::Installs;
use crate::library::{Library, engine_settings};
use nekko_engine::load_check::EngineInUse;
use nekko_engine::server::{Daemon, Engine, Env, ModelServer};
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
    "engine:unloadAll",
    "engine:memory",
    "engine:loadTimes",
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
    fn engine(&self, runtime: &'static str) -> BoxFuture<Option<Engine>> {
        let installs = self.installs.clone();
        Box::pin(async move {
            let install = installs.detect(runtime).await;
            let bin = install.get("binPath").and_then(Value::as_str)?.to_string();
            Some(Engine { bin, in_use: EngineInUse::from_install(&install) })
        })
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
    fn ram_headroom(&self) -> BoxFuture<Option<f64>> {
        Box::pin(async {
            tokio::task::spawn_blocking(|| nekko_machine::memory::headroom() as f64).await.ok().filter(|b| *b > 0.0)
        })
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
    engine: Arc<crate::engine::Engine>,
    client: reqwest::Client,
    /// One local picture or clip at a time on this computer ([`Server::media_job`]).
    media: Arc<tokio::sync::Mutex<()>>,
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
        let model = ModelServer::new(env, Arc::new(Processes(engine.clone())), true);
        Arc::new(Self {
            model,
            library,
            installs,
            machine,
            engine,
            client: reqwest::Client::new(),
            media: Arc::default(),
        })
    }

    /// One local picture (or clip, with `video`), the way every caller makes
    /// one: Photo and Video chats, and the agents' media tools.
    ///
    /// - **One at a time on this computer.** A diffusion model already fills
    ///   the GPU, and two picture models at once would double the memory. A
    ///   job that has to wait hears `waiting` first; dropping the future (a
    ///   stopped turn) leaves the queue.
    /// - **Swap back.** When loading the media model unloaded a model that was
    ///   loaded before (usually the chat's own model, idle during a tool call),
    ///   the media model is unloaded once the job ends, however it ends, so the
    ///   chat's model can load again. Otherwise it stays for its idle timeout.
    pub async fn media_job(
        &self,
        request: &Value,
        video: bool,
        on_stage: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Value, String> {
        let turn = match self.media.clone().try_lock_owned() {
            Ok(g) => g,
            Err(_) => {
                on_stage("waiting");
                self.media.clone().lock_owned().await
            }
        };
        let id = request.get("modelId").map(nekko_js::display).unwrap_or_default();
        let release = SwapBack {
            model: self.model.clone(),
            media: self.media.clone(),
            before: self.model.loaded_ids(),
            id,
            armed: true,
        };
        let result = if video {
            self.generate_video_with(request, on_stage).await
        } else {
            self.generate_image_with(request, on_stage).await
        };
        release.finish().await;
        drop(turn);
        result
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
        let mlx = self.installs.detect("mlx").await;
        let settings = engine_settings(&self.library.settings());
        // The Engines block's rows: what this machine can run, and which is in use.
        let machine = nekko_engine::engines::Machine {
            platform: crate::installs::platform().into(),
            arch: crate::installs::arch().into(),
            gpus: gpu
                .as_ref()
                .and_then(|g| g.get("devices"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|d| d.get("name").and_then(Value::as_str).map(str::to_string))
                .collect(),
        };
        let engines = nekko_engine::engines::list(
            &machine,
            &json!({ "llama": install, "mlx": mlx }),
            settings.get("chatEngine").and_then(Value::as_str),
        );
        m.insert("install".into(), install);
        m.insert("diffusionInstall".into(), self.installs.detect("diffusion").await);
        m.insert("mlxInstall".into(), mlx);
        m.insert("engines".into(), engines);
        for k in ["running", "startedAt", "resident", "loading", "log", "port"] {
            if let Some(v) = state.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
        m.insert("settings".into(), Value::Object(settings));
        m.insert("memory".into(), launch::engine_memory(gpu.as_ref(), total));
        Value::Object(m)
    }

    /// One image from a loaded (or loadable) image model (`generateImage`),
    /// in the same queue as every other picture.
    async fn generate_image(&self, request: &Value) -> Result<Value, String> {
        self.media_job(request, false, &mut |_| {}).await
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
        let clock = std::time::Instant::now();
        let res = req.send().await.map_err(|_| "fetch failed".to_string())?;
        let status = res.status();
        let result: Value = res.json().await.map_err(|e| e.to_string())?;
        let ms = clock.elapsed().as_secs_f64() * 1000.0;
        if !status.is_success() || result.get("data").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return Err(result
                .get("error")
                .and_then(|e| e.get("message"))
                .filter(|m| !m.is_null())
                .map(nekko_js::display)
                .unwrap_or_else(|| format!("Image generation failed (HTTP {}).", status.as_u16())));
        }
        // An edit reads its pictures first and takes longer: only a picture from words is timed.
        if request.get("refImages").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            self.timed(&model, ms).await;
        }
        Ok(result)
    }

    /// Keep how long the picture or clip took against the model's file, for
    /// the recommendations' "here" figure. The model was loaded before the clock started.
    async fn timed(&self, model: &Value, ms: f64) {
        if let Some(path) = model.get("path").and_then(Value::as_str) {
            self.machine.record_picture(path, ms).await;
        }
    }

    /// The local picture models an agent can use now (`media_models`): image
    /// models in the library (not video ones) whose companion files are all
    /// on disk, or that need none: `{ id, name, capabilities, defaults }`.
    /// Whether stable-diffusion.cpp is installed is checked when one loads,
    /// not here: this runs before every chat turn and stays to file reads.
    pub async fn ready_media_models(&self) -> Vec<Value> {
        self.ready_models(false).await
    }

    /// The local video models an agent can use now (`generate_video`): as
    /// [`Server::ready_media_models`], only those whose set makes clips.
    pub async fn ready_video_models(&self) -> Vec<Value> {
        self.ready_models(true).await
    }

    async fn ready_models(&self, video: bool) -> Vec<Value> {
        let Ok(rows) = self.library.list().await else { return Vec::new() };
        let dir = self.library.models_dir();
        tokio::task::spawn_blocking(move || {
            rows.into_iter()
                .filter(nekko_remote::phone_image::eligible)
                .filter_map(|m| {
                    let id = m.get("id").map(nekko_js::display).unwrap_or_default();
                    let beside = acquire::companions_beside(&m, &[nekko_engine::folders::companions_dir(&dir, &id)]);
                    let status =
                        acquire::image_companion_status(&m, &acquire::image_companions_dir(&dir), &beside, false);
                    let (capabilities, defaults) = if status.is_null() {
                        (json!(["create"]), json!({}))
                    } else if status["ready"] == true {
                        (status["capabilities"].clone(), status["defaults"].clone())
                    } else {
                        return None;
                    };
                    if capabilities.as_array().is_some_and(|c| c.iter().any(|x| x == "video")) != video {
                        return None;
                    }
                    let name = m.get("name").filter(|n| n.is_string()).unwrap_or(&m["id"]).clone();
                    Some(json!({ "id": id, "name": name, "capabilities": capabilities, "defaults": defaults }))
                })
                .collect()
        })
        .await
        .unwrap_or_default()
    }

    /// What the library's model can do, from its companion set (`create`,
    /// `edit`, `video`), as the desktop reads `engine:imageCompanions`; empty
    /// for a model with no known set.
    pub async fn capabilities(&self, id: &str) -> Vec<String> {
        let Ok(Some(model)) = self.library.find(id).await else { return Vec::new() };
        acquire::image_companion_set_for(&model)
            .and_then(|s| s.get("capabilities").and_then(Value::as_array).cloned())
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// One clip from a video model: loaded like an image model, then a job on
    /// its own sd-server (`/sdcpp/v1/vid_gen`), polled until it finishes.
    /// The router is not in the way: a job's status reads carry no model name
    /// for it to route by. `on_stage` hears `loading`, `generating`, and
    /// `step:<n>/<total>` as sampling moves. Dropping the future (a stopped
    /// turn) cancels the job on the server.
    pub async fn generate_video_with(
        &self,
        request: &Value,
        on_stage: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Value, String> {
        let body = launch::video_generation_body(request)?;
        let id = request.get("modelId").map(nekko_js::display).unwrap_or_default();
        let model = self.library.find(&id).await?;
        let Some(model) = model.filter(|m| m.get("modality").and_then(Value::as_str) == Some("image")) else {
            return Err("Choose a video model.".into());
        };
        if !self.model.loaded_ids().contains(&id) {
            on_stage("loading");
        }
        let preset = model.get("preset").filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
        let started = self.load(&id, preset).await;
        if started.get("ok") != Some(&Value::Bool(true)) {
            return Err(started.get("message").map(nekko_js::display).unwrap_or_default());
        }
        let Some(child) = self.engine.supervisor.get(&id) else {
            return Err("The video model stopped before it could start.".into());
        };
        // Busy while the job runs, so the idle timer does not unload it under the job.
        let _busy = child.begin();
        let base = format!("http://127.0.0.1:{}", child.port);
        on_stage("generating");
        let clock = std::time::Instant::now();
        let res = self
            .client
            .post(format!("{base}/sdcpp/v1/vid_gen"))
            .header("content-type", "application/json")
            .body(body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| "The video model did not take the request.".to_string())?;
        let status = res.status();
        let job: Value = res.json().await.map_err(|e| e.to_string())?;
        let Some(job_id) = job.get("id").and_then(Value::as_str).filter(|_| status.is_success()) else {
            return Err(
                sd_error(&job).unwrap_or_else(|| format!("The clip could not be started (HTTP {}).", status.as_u16()))
            );
        };
        let cancel = CancelJob {
            client: self.client.clone(),
            url: format!("{base}/sdcpp/v1/jobs/{job_id}/cancel"),
            armed: true,
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(4 * 60 * 60);
        let mut last_step = String::new();
        // Reads in a row with no job state: a server that died or was unloaded stops answering.
        let mut misses = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if std::time::Instant::now() > deadline {
                return Err("The clip took over four hours and was stopped.".into());
            }
            if self.engine.supervisor.get(&id).is_none_or(|c| c.port != child.port) {
                return Err("The video model stopped while making the clip.".into());
            }
            let read = match self
                .client
                .get(format!("{base}/sdcpp/v1/jobs/{job_id}"))
                .timeout(Duration::from_secs(30))
                .send()
                .await
            {
                Ok(r) => r.json::<Value>().await.ok(),
                Err(_) => None,
            };
            let Some(state) = read else {
                misses += 1;
                if misses >= MAX_JOB_MISSES {
                    return Err("The video model stopped answering while making the clip.".into());
                }
                continue;
            };
            match state.get("status").and_then(Value::as_str).unwrap_or_default() {
                "completed" => {
                    let mut cancel = cancel;
                    cancel.armed = false;
                    let result = state.get("result").cloned().unwrap_or(Value::Null);
                    if result.get("b64_json").and_then(Value::as_str).is_none_or(str::is_empty) {
                        return Err("The video model finished without a clip.".into());
                    }
                    self.timed(&model, clock.elapsed().as_secs_f64() * 1000.0).await;
                    return Ok(result);
                }
                "failed" | "cancelled" => {
                    let mut cancel = cancel;
                    cancel.armed = false;
                    return Err(sd_error(&state).unwrap_or_else(|| "The clip could not be made.".into()));
                }
                // No such job (the server restarted), or an answer that is not a job.
                "" => {
                    misses += 1;
                    if misses >= MAX_JOB_MISSES {
                        return Err(
                            sd_error(&state).unwrap_or_else(|| "The video model lost track of the clip.".into())
                        );
                    }
                }
                _ => {
                    misses = 0;
                    let preview = state.get("preview").filter(|p| !p.is_null());
                    if let Some(p) = preview {
                        let step =
                            format!("step:{}/{}", nekko_js::display(&p["step"]), nekko_js::display(&p["total_steps"]));
                        if step != last_step {
                            on_stage(&step);
                            last_step = step;
                        }
                    }
                }
            }
        }
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
            "engine:unloadAll" => self.model.unload_all().await,
            "engine:loadTimes" => Value::Object(self.model.load_times()),
            // What shutting the models down would free: their processes and
            // everything under them, and how many are mid-reply.
            "engine:memory" => {
                let children = self.engine.supervisor.list();
                let busy = children.iter().filter(|c| c.active_requests > 0).count();
                let pids: Vec<u32> = children.iter().map(|c| c.pid).collect();
                let bytes = tokio::task::spawn_blocking(move || nekko_machine::memory::tree_bytes(&pids))
                    .await
                    .map_err(|e| e.to_string())?;
                json!({ "models": children.len(), "busy": busy, "bytes": bytes })
            }
            other => return Err(format!("{other} is not a model-server channel")),
        })
    }
}

/// Status reads in a row with no job state before a clip is given up (about 30 s).
const MAX_JOB_MISSES: u32 = 30;

/// sd-server's own error message, when it gave one.
fn sd_error(v: &Value) -> Option<String> {
    v.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).map(str::to_string)
}

/// Unloads a media model that displaced a model loaded before it
/// ([`Server::media_job`]): at once when the job ends, or, when a stopped turn
/// drops the job, in a task that first waits its turn in the media queue.
struct SwapBack {
    model: Arc<ModelServer>,
    media: Arc<tokio::sync::Mutex<()>>,
    before: Vec<String>,
    id: String,
    armed: bool,
}

/// Whether loading `id` pushed out a model loaded before it.
fn displaced(before: &[String], id: &str, now: &[String]) -> bool {
    !before.iter().any(|b| b == id) && before.iter().any(|b| b != id && !now.contains(b))
}

impl SwapBack {
    async fn finish(mut self) {
        self.armed = false;
        if displaced(&self.before, &self.id, &self.model.loaded_ids()) {
            self.model.unload(&self.id).await;
        }
    }
}

impl Drop for SwapBack {
    fn drop(&mut self) {
        if !self.armed || !displaced(&self.before, &self.id, &self.model.loaded_ids()) {
            return;
        }
        let (model, media, id) = (self.model.clone(), self.media.clone(), std::mem::take(&mut self.id));
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _turn = media.lock().await;
                model.unload(&id).await;
            });
        }
    }
}

/// Cancels a clip's job on its server unless disarmed: a stopped turn drops
/// the future that owns it, and the job should not keep the GPU busy for minutes.
struct CancelJob {
    client: reqwest::Client,
    url: String,
    armed: bool,
}

impl Drop for CancelJob {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let (client, url) = (self.client.clone(), std::mem::take(&mut self.url));
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = client.post(url).timeout(Duration::from_secs(10)).send().await;
            });
        }
    }
}

#[cfg(test)]
mod media_tests {
    use super::displaced;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_media_model_that_pushed_the_chat_model_out_is_swapped_back() {
        assert!(displaced(&ids(&["chat"]), "zimage", &ids(&["zimage"])));
    }

    #[test]
    fn a_media_model_that_fit_beside_the_chat_model_stays() {
        assert!(!displaced(&ids(&["chat"]), "zimage", &ids(&["chat", "zimage"])));
        assert!(!displaced(&[], "zimage", &ids(&["zimage"])));
    }

    #[test]
    fn a_media_model_already_loaded_before_the_job_stays() {
        assert!(!displaced(&ids(&["zimage", "chat"]), "zimage", &ids(&["zimage"])));
    }
}
