//! The model server's policy: what to load and how, when to make room,
//! when an idle model goes, what the router is told about models it does not
//! have running, and the status the Models page reads. The processes and
//! the listening port are the daemon's ([`Daemon`]: `nekko-infer`'s
//! supervisor and router). A port of `createEngineServer` in
//! `packages/host/src/engine/server.ts` as it runs under the engine daemon,
//! held to it by `tests/golden/server.json`.

use crate::capacity::{FitRequest, Hardware, PlanOptions, compute_fit};
use crate::launch::{
    Companions, build_args, diffusion_args, explain_load_error, is_missing_dll_exit, missing_dll_message, mlx_args,
    resolve_companions, unsupported_load_reason,
};
use crate::library::{default_context_tokens, model_facts_for};
use crate::{BoxFuture, num};
use nekko_tools::path::native as path;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

/// A cold start of a large model off a slow disk is genuinely slow.
const LOAD_BUDGET_SECS: u64 = 600;
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
const SYNC_INTERVAL: Duration = Duration::from_secs(3);
/// How long the GPU reading gets to catch up before a load is measured.
const MEASURE_SETTLE: Duration = Duration::from_millis(1500);
const LOG_LINES: usize = 200;
const LOAD_PROGRESS: Duration = Duration::from_millis(800);
/// Where the daemon fills in the port it picks (`DAEMON_PORT`).
pub const DAEMON_PORT: &str = "{port}";

/// The processes and the port (`EngineDaemon`).
pub trait Daemon: Send + Sync {
    /// Listen with this configuration: `{ ok, message }`.
    fn serve(&self, config: Value) -> BoxFuture<Value>;
    fn stop_serving(&self) -> BoxFuture<()>;
    /// Whether the router is listening.
    fn serving(&self) -> BoxFuture<bool>;
    /// `{ status: 'ready', port, pid }` or `{ status: 'failed', message, log }`.
    fn spawn(&self, spec: Value) -> BoxFuture<Value>;
    fn kill(&self, model_id: String) -> BoxFuture<bool>;
    /// The running children: `{ modelId, kind, port, pid, startedAt, lastUsedAt, activeRequests }`.
    fn list(&self) -> BoxFuture<Vec<Value>>;
}

/// What the policy reads from the rest of the engine (`EngineServerDeps`).
pub trait Env: Send + Sync {
    /// The engine settings, over their defaults.
    fn settings(&self) -> Value;
    fn prompt_caching(&self) -> bool;
    /// The `llama`, `diffusion` or `mlx` server binary, when installed.
    fn bin(&self, runtime: &'static str) -> BoxFuture<Option<String>>;
    /// Whether the installed engine can put layers on a GPU; `None` is "assume it can".
    fn gpu_capable(&self) -> BoxFuture<Option<bool>>;
    fn find_model(&self, id: String) -> BoxFuture<Option<Value>>;
    fn list_models(&self) -> BoxFuture<Vec<Value>>;
    /// A fresh GPU reading (`GpuStats`), or `None` without a probe.
    fn gpu(&self) -> BoxFuture<Option<Value>>;
    /// The flags a `llama-server` binary accepts.
    fn flags(&self, bin: String) -> BoxFuture<Arc<HashSet<String>>>;
    fn work_dir(&self) -> Option<String>;
    fn companions_dir(&self, model_id: &str) -> Option<String>;
    fn image_companions_dir(&self) -> Option<String>;
    /// Copy the Visual C++ runtime beside a binary when Windows lacks it.
    fn vc_runtime(&self, bin_dir: &str) -> Vec<String>;
    fn now(&self) -> f64;
    /// The clock a log line starts with (`HH:MM:SS`, UTC).
    fn clock(&self) -> String;
    /// The engine started serving at this address (the daemon keeps a provider entry pointing at it).
    fn on_serving(&self, base_url: String) -> BoxFuture<()>;
}

/// The share of a llama.cpp model's layers on the GPU under these params.
fn gpu_share(model: &Value, params: &Value, gpu_capable: bool) -> f64 {
    let layers = model.get("layers").and_then(Value::as_f64).filter(|l| *l != 0.0 && !l.is_nan());
    match (params.get("gpuLayers"), layers) {
        (Some(g), Some(l)) => (nekko_js::to_number(Some(g)) / l).clamp(0.0, 1.0),
        _ if gpu_capable => 1.0,
        _ => 0.0,
    }
}

/// What a load will take from free GPU memory: the planner's weights, KV
/// cache and overhead for its context (`capacity::compute_fit`), times its
/// share on the GPU. `None` when the model's facts do not say.
fn needed_bytes(model: &Value, params: &Value, share: f64) -> Option<f64> {
    let field = |k: &str| params.get(k).filter(|v| !v.is_null());
    let req = FitRequest {
        context_tokens: field("contextTokens").map_or_else(
            || default_context_tokens(model.get("maxContext").and_then(Value::as_f64)),
            |v| nekko_js::to_number(Some(v)),
        ),
        parallel_slots: field("parallelSlots").map_or(1.0, |v| nekko_js::to_number(Some(v))),
        kv_cache_dtype: field("kvCacheDtype").map_or_else(|| "f16".to_string(), nekko_js::display),
        gpu_layer_fraction: 1.0,
    };
    let hw = Hardware { devices: Vec::new(), unified: false, ram_total: f64::NAN, ram_free: f64::NAN };
    let plan =
        compute_fit(&model_facts_for(model), &req, &hw, &PlanOptions { overhead_floor: None, siblings: Vec::new() });
    let need = plan.required * share;
    (need.is_finite() && need > 0.0).then_some(need)
}

/// "6.3 GiB", for the log.
fn gib(bytes: f64) -> String {
    format!("{:.1} GiB", bytes / 1024.0 / 1024.0 / 1024.0)
}

/// Kept resident: its own idle TTL is 0 ("Keep resident" in Model Server).
/// The global `idleTtlSeconds` of 0 does not pin anything; it only stops the sweep.
fn kept_resident(c: &Child) -> bool {
    c.params.get("ttlSeconds").is_some_and(|t| !t.is_null() && nekko_js::to_number(Some(t)) == 0.0)
}

#[derive(Clone, Debug)]
struct Child {
    params: Value,
    prompt_caching: Option<bool>,
    started_at: f64,
    last_used_at: f64,
    vram_bytes: Option<f64>,
    size_bytes: f64,
    context_tokens: Option<Value>,
    total_layers: Option<Value>,
    gpu_layers: Option<Value>,
    loaded_on: Option<&'static str>,
    active_requests: f64,
}

#[derive(Clone, Debug)]
struct Loading {
    phase: &'static str,
    started_at: f64,
    progress: Option<f64>,
}

#[derive(Default)]
struct State {
    /// Insertion order, as the TS `Map` keeps it.
    children: Vec<(String, Child)>,
    /// The translated reason each model's last load failed, until it loads.
    errors: Vec<(String, String)>,
    loading: Vec<(String, Loading)>,
    log: Vec<String>,
    serving: bool,
    started_at: Option<f64>,
    timers: Vec<tokio::task::JoinHandle<()>>,
}

fn upsert<V>(list: &mut Vec<(String, V)>, key: &str, value: V) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value,
        None => list.push((key.to_string(), value)),
    }
}

fn remove<V>(list: &mut Vec<(String, V)>, key: &str) -> Option<V> {
    let at = list.iter().position(|(k, _)| k == key)?;
    Some(list.remove(at).1)
}

fn get<'a, V>(list: &'a [(String, V)], key: &str) -> Option<&'a V> {
    list.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn get_mut<'a, V>(list: &'a mut [(String, V)], key: &str) -> Option<&'a mut V> {
    list.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn text(v: Option<&Value>) -> String {
    v.map(nekko_js::display).unwrap_or_else(|| "undefined".into())
}

fn reply(ok: bool, message: impl Into<String>) -> Value {
    json!({ "ok": ok, "message": message.into() })
}

/// `a === b` for JSON values: numbers by value, everything else structurally.
fn js_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Object(_)), _) | (Some(Value::Array(_)), _) => false,
        (x, y) => x == y,
    }
}

/// A reload with the same settings is not a reload (`sameParams`).
fn same_params(a: &Value, b: &Value) -> bool {
    const KEYS: [&str; 21] = [
        "contextTokens",
        "gpuLayers",
        "kvCacheDtype",
        "parallelSlots",
        "batchSize",
        "ubatchSize",
        "threads",
        "flashAttention",
        "mmap",
        "mlock",
        "ropeFreqBase",
        "ropeFreqScale",
        "seed",
        "speculative",
        "draftModelId",
        "cpuMoeLayers",
        "cpuFfnLayers",
        "moeCacheMiB",
        "kvOnGpu",
        "lazyTables",
        "threadsBatch",
    ];
    let diffusion = |v: &Value| nekko_js::stringify(v.get("diffusion").filter(|d| !d.is_null()).unwrap_or(&json!({})));
    KEYS.iter().all(|k| js_eq(a.get(*k), b.get(*k))) && diffusion(a) == diffusion(b)
}

/// Where a load lives (`placementFor`).
fn placement_for(
    model: &Value,
    params: &Value,
    gpu_capable: bool,
) -> (Option<Value>, Option<Value>, Option<&'static str>) {
    let total = model.get("layers").filter(|l| !l.is_null()).cloned();
    if model.get("format").and_then(Value::as_str) == Some("mlx") {
        return (total.clone(), total, Some("gpu"));
    }
    if model.get("modality").and_then(Value::as_str) == Some("image") {
        let d = params.get("diffusion");
        let on = |k: &str| d.is_some_and(|d| nekko_js::truthy(d.get(k)));
        return (
            None,
            None,
            Some(if on("offloadToCpu") {
                "cpu"
            } else if on("clipOnCpu") {
                "gpu+cpu"
            } else {
                "gpu"
            }),
        );
    }
    if !gpu_capable {
        return (total, Some(json!(0)), Some("cpu"));
    }
    let gpu = params.get("gpuLayers").filter(|g| !g.is_null()).cloned().or_else(|| total.clone());
    let loaded_on = match &gpu {
        None => "gpu",
        Some(g) if nekko_js::to_number(Some(g)) <= 0.0 => "cpu",
        Some(g) if total.as_ref().is_some_and(|t| nekko_js::to_number(Some(g)) < nekko_js::to_number(Some(t))) => {
            "gpu+cpu"
        }
        Some(_) => "gpu",
    };
    (total, gpu, Some(loaded_on))
}

/// A model as the OpenAI-compatible list shows it (`modelRow`).
pub fn model_row(model: &Value, loaded: bool) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), model.get("id").cloned().unwrap_or(Value::Null));
    m.insert("object".into(), json!("model"));
    m.insert("created".into(), num((nekko_js::to_number(model.get("addedAt")) / 1000.0).floor()));
    m.insert("owned_by".into(), json!("nekko-agent"));
    m.insert("state".into(), json!(if loaded { "loaded" } else { "not-loaded" }));
    for (k, from) in [("name", "name"), ("path", "path")] {
        if let Some(v) = model.get(from) {
            m.insert(k.into(), v.clone());
        }
    }
    if let Some(label) = model.get("folderProvider").and_then(Value::as_str).and_then(folder_provider_label) {
        m.insert("location".into(), json!(label));
    }
    m.insert("modality".into(), model.get("modality").filter(|v| !v.is_null()).cloned().unwrap_or(json!("chat")));
    if let Some(inputs) = input_modalities(model) {
        m.insert("input_modalities".into(), inputs);
    }
    for (k, from) in
        [("max_context_length", "maxContext"), ("quantization", "quantization"), ("size_bytes", "sizeBytes")]
    {
        if let Some(v) = model.get(from) {
            m.insert(k.into(), v.clone());
        }
    }
    Value::Object(m)
}

/// `inputModalities` (server.ts): text always, images only with the projector;
/// nothing for rows that are not chat models.
fn input_modalities(model: &Value) -> Option<Value> {
    let modality = model.get("modality").and_then(Value::as_str).unwrap_or("chat");
    if modality != "chat" && modality != "vision" {
        return None;
    }
    Some(if model.get("hasProjector") == Some(&Value::Bool(true)) { json!(["text", "image"]) } else { json!(["text"]) })
}

/// `MODEL_FOLDER_PROVIDERS[id].label`.
fn folder_provider_label(id: &str) -> Option<&'static str> {
    Some(match id {
        "nekko" => "Nekko Agent",
        "ollama" => "Ollama",
        "lmstudio" => "LM Studio",
        "jan" => "Jan",
        "gpt4all" => "GPT4All",
        "llamacpp" => "llama.cpp",
        "huggingface" => "Hugging Face cache",
        "koboldcpp" => "KoboldCpp",
        "textgenwebui" => "Text generation web UI",
        "localai" => "LocalAI",
        "bionic" => "Bionic",
        "vllm" => "vLLM",
        _ => return None,
    })
}

/// Why a LAN bind is refused without a key (the UI shows this verbatim).
pub const LAN_NEEDS_KEY: &str = "Set an API key before making the engine reachable from your network. Without one anything on the network could use these models.";

/// The daemon's listen configuration (`{ port, host, apiKey?, corsOrigins }`)
/// from the engine settings, or the reason it must not listen. `bind: "lan"`
/// binds `0.0.0.0`, and the router only checks a Bearer token when a key is
/// set, so a LAN bind with an empty key is refused here rather than served open.
pub fn serve_config(s: &Value) -> Result<Value, String> {
    // Settings > Connections can keep the server on this computer.
    let lan = s.get("bind").and_then(Value::as_str) == Some("lan") && nekko_net::allowed("model-server-lan");
    let key = s.get("apiKey").and_then(Value::as_str).map(nekko_js::trim).filter(|k| !k.is_empty());
    if lan && key.is_none() {
        return Err(LAN_NEEDS_KEY.to_string());
    }
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let mut cfg = Map::new();
    cfg.insert("port".into(), s.get("port").cloned().unwrap_or(Value::Null));
    cfg.insert("host".into(), json!(host));
    if let Some(k) = nekko_js::truthy_str(s.get("apiKey")) {
        cfg.insert("apiKey".into(), json!(k));
    }
    let cors = s.get("corsOrigins").filter(|c| !c.is_null()).map(nekko_js::display).unwrap_or_default();
    let origins: Vec<String> =
        cors.split(',').map(|o| nekko_js::trim(o).to_string()).filter(|o| !o.is_empty()).collect();
    cfg.insert("corsOrigins".into(), json!(origins));
    Ok(Value::Object(cfg))
}

/// The model server's policy over the daemon's processes.
pub struct ModelServer {
    env: Arc<dyn Env>,
    daemon: Arc<dyn Daemon>,
    state: Mutex<State>,
    /// Loads one at a time: two at once make the VRAM measurement meaningless.
    load_chain: tokio::sync::Mutex<()>,
    /// Run the idle sweep and the residency sync on timers (off in tests).
    timers: bool,
    me: Weak<ModelServer>,
}

impl ModelServer {
    pub fn new(env: Arc<dyn Env>, daemon: Arc<dyn Daemon>, timers: bool) -> Arc<Self> {
        Arc::new_cyclic(|me| ModelServer {
            env,
            daemon,
            state: Mutex::new(State::default()),
            load_chain: tokio::sync::Mutex::new(()),
            timers,
            me: me.clone(),
        })
    }

    fn arc(&self) -> Arc<Self> {
        self.me.upgrade().expect("the server is alive while it runs")
    }

    fn push(&self, lines: &[String]) {
        let clock = self.env.clock();
        let mut s = self.state.lock().unwrap();
        for line in lines {
            s.log.push(format!("{clock} {line}"));
        }
        let over = s.log.len().saturating_sub(LOG_LINES);
        s.log.drain(..over);
    }

    fn say(&self, line: impl Into<String>) {
        self.push(&[line.into()]);
    }

    fn set_error(&self, id: &str, message: &str) {
        upsert(&mut self.state.lock().unwrap().errors, id, message.to_string());
    }

    fn settings_number(&self, key: &str) -> f64 {
        nekko_js::to_number(self.env.settings().get(key))
    }

    /// The daemon's listen configuration from the settings, or the sentence
    /// explaining why it must not listen: a LAN bind without a key would put
    /// every route on the network for anyone to call (`serveConfig`).
    fn serve_config(&self) -> Result<Value, String> {
        serve_config(&self.env.settings())
    }

    /* ---------------------------------------------------------- lifecycle */

    /// Listen through the daemon and bring the autoload models up (`start`).
    pub async fn start(&self) -> Value {
        if self.state.lock().unwrap().serving {
            // The daemon keeps a provider entry pointing at the engine either way.
            self.env.on_serving(format!("http://127.0.0.1:{}/v1", text(self.env.settings().get("port")))).await;
            return reply(true, "The engine is already running.");
        }
        let bin = match self.env.bin("llama").await {
            Some(b) => Some(b),
            None => self.env.bin("diffusion").await,
        };
        if bin.is_none() {
            return reply(false, "No engine is installed yet. Install one from the Models tab first.");
        }
        let cfg = match self.serve_config() {
            Ok(cfg) => cfg,
            Err(why) => return reply(false, why),
        };
        let res = self.daemon.serve(cfg.clone()).await;
        if res.get("ok") != Some(&Value::Bool(true)) {
            return res;
        }
        self.begin_serving();
        let port = text(cfg.get("port"));
        self.say(format!(
            "Engine listening on http://{}:{port}/v1 (served by the engine daemon)",
            text(cfg.get("host"))
        ));
        let me = self.arc();
        tokio::spawn(async move {
            me.adopt().await;
            me.autoload().await;
        });
        self.env.on_serving(format!("http://127.0.0.1:{port}/v1")).await;
        reply(true, format!("The engine is serving on port {port}."))
    }

    /// The models configured to come up with the engine (`autoload`).
    async fn autoload(&self) {
        let ids = self.env.settings().get("autoload").and_then(Value::as_array).cloned().unwrap_or_default();
        for id in ids {
            let id = nekko_js::display(&id);
            let Some(model) = self.env.find_model(id.clone()).await else {
                self.say(format!("Autoload skipped {id}: it is no longer in the library."));
                continue;
            };
            let preset = model.get("preset").filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
            let res = self.load(&id, preset).await;
            if res.get("ok") == Some(&Value::Bool(true)) {
                self.say(format!("Autoloaded {id}."));
            } else {
                self.say(format!("Autoload {id} failed: {}", text(res.get("message"))));
            }
        }
    }

    /// Mark the endpoint up and start following residency (`beginServing`).
    fn begin_serving(&self) {
        let now = self.env.now();
        let mut s = self.state.lock().unwrap();
        s.serving = true;
        s.started_at.get_or_insert(now);
        if self.timers && s.timers.is_empty() {
            let me = self.me.clone();
            s.timers.push(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(SWEEP_INTERVAL).await;
                    let Some(me) = me.upgrade() else { return };
                    me.sweep_idle().await;
                }
            }));
            let me = self.me.clone();
            s.timers.push(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(SYNC_INTERVAL).await;
                    let Some(me) = me.upgrade() else { return };
                    me.sync().await;
                }
            }));
        }
    }

    /// Read residency back from the daemon (`sync`).
    pub async fn sync(&self) {
        if !self.state.lock().unwrap().serving {
            return;
        }
        let live = self.daemon.list().await;
        let mut stopped = Vec::new();
        {
            let mut s = self.state.lock().unwrap();
            let ids: Vec<String> = s.children.iter().map(|(k, _)| k.clone()).collect();
            for id in ids {
                match live.iter().find(|c| c.get("modelId").and_then(Value::as_str) == Some(id.as_str())) {
                    None => {
                        remove(&mut s.children, &id);
                        stopped.push(format!("{id} stopped."));
                    }
                    Some(c) => {
                        let entry = get_mut(&mut s.children, &id).expect("listed");
                        entry.last_used_at = entry.last_used_at.max(nekko_js::to_number(c.get("lastUsedAt")));
                        entry.active_requests = nekko_js::to_number(c.get("activeRequests"));
                    }
                }
            }
        }
        if !stopped.is_empty() {
            self.push(&stopped);
        }
    }

    /// Take over model servers the daemon is already running (`adopt`).
    async fn adopt(&self) {
        let live = self.daemon.list().await;
        let gpu_capable = self.env.gpu_capable().await.unwrap_or(true);
        for c in live {
            let id = c.get("modelId").map(nekko_js::display).unwrap_or_default();
            if get(&self.state.lock().unwrap().children, &id).is_some() {
                continue;
            }
            let model = self.env.find_model(id.clone()).await;
            let params =
                model.as_ref().and_then(|m| m.get("preset")).filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
            let (total, gpu, on) = match &model {
                Some(m) => placement_for(m, &params, gpu_capable),
                None => (None, None, None),
            };
            let child = Child {
                params,
                prompt_caching: None,
                started_at: nekko_js::to_number(c.get("startedAt")),
                last_used_at: nekko_js::to_number(c.get("lastUsedAt")),
                vram_bytes: None,
                size_bytes: model.as_ref().and_then(|m| m.get("sizeBytes")).and_then(Value::as_f64).unwrap_or(0.0),
                context_tokens: None,
                total_layers: total,
                gpu_layers: gpu,
                loaded_on: on,
                active_requests: nekko_js::to_number(c.get("activeRequests")),
            };
            upsert(&mut self.state.lock().unwrap().children, &id, child);
            self.say(format!("{id} was still loaded; carrying on with it."));
        }
    }

    /// Under a daemon that is already serving: follow it (`reattach`).
    pub async fn reattach(&self) {
        if !self.daemon.serving().await {
            return;
        }
        self.begin_serving();
        self.adopt().await;
    }

    /// Re-serve with new endpoint settings; loaded models stay (`reconfigure`).
    pub async fn reconfigure(&self) -> Value {
        if !self.state.lock().unwrap().serving {
            return reply(true, "Nothing to reconfigure.");
        }
        match self.serve_config() {
            Ok(cfg) => self.daemon.serve(cfg).await,
            Err(why) => reply(false, why),
        }
    }

    /// Unload everything and stop listening (`stop`).
    pub async fn stop(&self) -> Value {
        {
            let mut s = self.state.lock().unwrap();
            if !s.serving {
                return reply(true, "The engine was not running.");
            }
            for t in s.timers.drain(..) {
                t.abort();
            }
        }
        let ids: Vec<String> = self.state.lock().unwrap().children.iter().map(|(k, _)| k.clone()).collect();
        for id in ids {
            self.unload(&id).await;
        }
        self.daemon.stop_serving().await;
        {
            let mut s = self.state.lock().unwrap();
            s.serving = false;
            s.started_at = None;
        }
        self.say("Engine stopped.");
        reply(true, "Stopped the engine.")
    }

    /* --------------------------------------------------------- load state */

    /// Load a model, serialized against other loads (`load`).
    pub async fn load(&self, id: &str, params: Value) -> Value {
        let now = self.env.now();
        upsert(
            &mut self.state.lock().unwrap().loading,
            id,
            Loading { phase: "queued", started_at: now, progress: None },
        );
        let turn = self.load_chain.lock().await;
        let res = self.do_load(id, params).await;
        drop(turn);
        remove(&mut self.state.lock().unwrap().loading, id);
        res
    }

    async fn do_load(&self, id: &str, params: Value) -> Value {
        let params = if params.is_object() { params } else { json!({}) };
        if let Some(l) = get_mut(&mut self.state.lock().unwrap().loading, id) {
            l.phase = "loading";
        }
        let caching = self.env.prompt_caching();
        let existing = get(&self.state.lock().unwrap().children, id).cloned();
        if let Some(existing) = existing {
            if same_params(&existing.params, &params) && existing.prompt_caching == Some(caching) {
                let now = self.env.now();
                let mut s = self.state.lock().unwrap();
                let entry = get_mut(&mut s.children, id).expect("there");
                entry.last_used_at = now;
                // The TTL is residency policy: it applies without a reload.
                let mut p = entry.params.as_object().cloned().unwrap_or_default();
                match params.get("ttlSeconds") {
                    Some(t) => {
                        p.insert("ttlSeconds".into(), t.clone());
                    }
                    None => {
                        p.shift_remove("ttlSeconds");
                    }
                }
                entry.params = Value::Object(p);
                return reply(true, format!("{id} is already loaded."));
            }
            self.unload(id).await;
        }

        let Some(model) = self.env.find_model(id.to_string()).await else {
            return reply(false, format!("{id} is not in the library."));
        };
        let image = model.get("modality").and_then(Value::as_str) == Some("image");
        let mlx = model.get("format").and_then(Value::as_str) == Some("mlx");
        let bin = self
            .env
            .bin(if image {
                "diffusion"
            } else if mlx {
                "mlx"
            } else {
                "llama"
            })
            .await;
        let Some(bin) = bin else {
            let message = if image {
                "Install stable-diffusion.cpp from Model Server to run this image-generation model.".to_string()
            } else if mlx {
                if nekko_js::truthy(model.get("mlxRunnable")) {
                    "Install MLX from Model Server to run this model.".to_string()
                } else {
                    format!("{} is an MLX model, which runs on Apple Silicon Macs only.", text(model.get("name")))
                }
            } else {
                "No engine is installed.".to_string()
            };
            self.set_error(id, &message);
            return reply(false, message);
        };
        if !image && let Some(reason) = unsupported_load_reason(&model) {
            self.set_error(id, &reason);
            return reply(false, reason);
        }
        if !mlx {
            let copied = self.env.vc_runtime(&path::dirname(&bin));
            if !copied.is_empty() {
                self.say(format!("Added the Visual C++ runtime beside the engine ({}).", copied.join(", ")));
            }
        }

        let gpu_capable = self.env.gpu_capable().await.unwrap_or(true);
        self.sync().await;
        // Make room before spending minutes on a load that would push something
        // out anyway: under the resident limit, and (a llama.cpp model whose
        // size the planner knows, with a GPU probe that reads free memory)
        // room in free GPU memory, unified memory on Apple Silicon. Idle
        // models go first, least recently used first; a model kept resident
        // (its own TTL of 0) never goes.
        let need =
            if image || mlx { None } else { needed_bytes(&model, &params, gpu_share(&model, &params, gpu_capable)) };
        let free = match need {
            Some(_) => self.free_vram().await,
            None => None,
        };
        let mut freed = 0.0;
        loop {
            let max = self.settings_number("maxLoaded").max(1.0);
            let (full, pinned, oldest) = {
                let s = self.state.lock().unwrap();
                let full = (s.children.len() as f64) >= max;
                let pinned = s.children.iter().any(|(_, c)| c.active_requests == 0.0 && kept_resident(c));
                let mut idle: Vec<&(String, Child)> =
                    s.children.iter().filter(|(_, c)| c.active_requests == 0.0 && !kept_resident(c)).collect();
                idle.sort_by(|a, b| {
                    a.1.last_used_at.partial_cmp(&b.1.last_used_at).unwrap_or(std::cmp::Ordering::Equal)
                });
                (full, pinned, idle.first().map(|(k, c)| (k.clone(), c.vram_bytes.unwrap_or(c.size_bytes))))
            };
            let short = match (need, free) {
                (Some(need), Some(free)) => free + freed < need,
                _ => false,
            };
            if !full && !short {
                break;
            }
            let Some((oldest, size)) = oldest else {
                if full && pinned {
                    return reply(
                        false,
                        "Every resident model is busy or kept resident. Stop keeping one resident, or increase the resident limit.",
                    );
                }
                if full {
                    return reply(
                        false,
                        "All resident models are processing requests. Wait for one to finish or increase the resident limit.",
                    );
                }
                // Nothing left to unload: load as before, and say it may not fit.
                self.say(format!(
                    "{id} may not fit in free memory ({} needed, {} free); loading anyway.",
                    gib(need.unwrap_or(0.0)),
                    gib(free.unwrap_or(0.0) + freed)
                ));
                break;
            };
            if full {
                self.say(format!("Unloading {oldest} to make room for {id}."));
            } else {
                self.say(format!("Unloading {oldest} to free memory for {id}."));
            }
            self.unload(&oldest).await;
            freed += size;
        }

        let mut companions = if image || mlx {
            Companions::default()
        } else {
            match resolve_companions(&model, self.env.work_dir().as_deref(), self.env.companions_dir(id).as_deref()) {
                Ok(c) => c,
                Err(e) => return reply(false, e),
            }
        };

        // A draft model must be the same kind of file as its target.
        let mut draft_path = None;
        if let Some(draft_id) = params.get("draftModelId").filter(|d| nekko_js::truthy(Some(d))) {
            let draft_id = nekko_js::display(draft_id);
            let draft = self.env.find_model(draft_id.clone()).await;
            match draft {
                Some(d) if (d.get("format").and_then(Value::as_str) == Some("mlx")) == mlx => {
                    draft_path = Some(text(d.get("path")));
                }
                _ => self.say(format!("Draft model {draft_id} is not usable with {id}; loading without it.")),
            }
        }

        // A llama.cpp load always names its context.
        let context =
            if image || mlx {
                params.get("contextTokens").cloned()
            } else {
                Some(
                    params.get("contextTokens").filter(|c| !c.is_null()).cloned().unwrap_or_else(|| {
                        num(default_context_tokens(model.get("maxContext").and_then(Value::as_f64)))
                    }),
                )
            };
        let args = if image {
            let mut m = model.clone();
            let mut preset = m.get("preset").and_then(Value::as_object).cloned().unwrap_or_default();
            nekko_js::spread_into(&mut preset, &params);
            m["preset"] = Value::Object(preset);
            diffusion_args(
                &m,
                DAEMON_PORT,
                self.env.companions_dir(id).as_deref(),
                self.env.image_companions_dir().as_deref(),
            )
        } else if mlx {
            Ok(mlx_args(&model, DAEMON_PORT, &params, draft_path.as_deref()))
        } else {
            let flags = self.env.flags(bin.clone()).await;
            companions.draft_model = draft_path.clone();
            let mut p = params.as_object().cloned().unwrap_or_default();
            match &context {
                Some(c) if !c.is_null() => {
                    p.insert("contextTokens".into(), c.clone());
                }
                _ => {
                    p.shift_remove("contextTokens");
                }
            }
            Ok(build_args(&model, DAEMON_PORT, &Value::Object(p), &companions, &|f| flags.contains(f), caching))
        };
        let args = match args {
            Ok(a) => a,
            Err(e) => {
                self.set_error(id, &e);
                return reply(false, e);
            }
        };

        let before = self.free_vram().await;
        let gpu_share = if image {
            if params.get("diffusion").is_some_and(|d| nekko_js::truthy(d.get("offloadToCpu"))) { 0.0 } else { 1.0 }
        } else {
            gpu_share(&model, &params, gpu_capable)
        };
        let size = model.get("sizeBytes").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(before) = before
            && gpu_share > 0.0
            && size > 0.0
        {
            self.sample_progress(id.to_string(), before, size * gpu_share);
        }

        let spec = json!({
            "modelId": id,
            "bin": bin,
            "args": args,
            "kind": if image { "image" } else { "chat" },
            "healthPath": if image { "/v1/models" } else { "/health" },
        });
        let mut spec = spec.as_object().cloned().unwrap_or_default();
        if !image {
            spec.insert("healthExpect".into(), json!("\"ok\""));
        }
        spec.insert("budgetSecs".into(), json!(LOAD_BUDGET_SECS));
        let outcome = self.daemon.spawn(Value::Object(spec)).await;
        if outcome.get("status").and_then(Value::as_str) != Some("ready") {
            let log: Vec<String> = outcome
                .get("log")
                .and_then(Value::as_array)
                .map(|l| l.iter().map(nekko_js::display).collect())
                .unwrap_or_default();
            self.push(&log[log.len().saturating_sub(4)..]);
            let exit = outcome.get("message").and_then(Value::as_str);
            let explained = explain_load_error(&log);
            let message = if is_missing_dll_exit(exit) {
                missing_dll_message("The model server")
            } else if explained.is_empty() {
                exit.unwrap_or_default().to_string()
            } else {
                explained
            };
            self.set_error(id, &message);
            return reply(false, message);
        }
        if before.is_some() {
            tokio::time::sleep(MEASURE_SETTLE).await;
        }
        let after = self.free_vram().await;
        let measured = match (before, after) {
            (Some(b), Some(a)) if b - a > 0.0 => Some(b - a),
            _ => None,
        };
        let (total, gpu, on) = placement_for(&model, &params, gpu_capable);
        let now = self.env.now();
        let child = Child {
            params,
            prompt_caching: Some(caching),
            started_at: now,
            last_used_at: now,
            vram_bytes: measured,
            size_bytes: measured.unwrap_or(size),
            context_tokens: context.filter(|c| !c.is_null()),
            total_layers: total,
            gpu_layers: gpu,
            loaded_on: on,
            active_requests: 0.0,
        };
        {
            let mut s = self.state.lock().unwrap();
            upsert(&mut s.children, id, child);
            remove(&mut s.errors, id);
        }
        self.say(format!("Loaded {id} on port {}.", text(outcome.get("port"))));
        reply(true, format!("Loaded {id}."))
    }

    /// Free VRAM in bytes, when a GPU probe answers (`freeVramBytes`).
    async fn free_vram(&self) -> Option<f64> {
        let gpu = self.env.gpu().await?;
        let devices = gpu.get("devices").and_then(Value::as_array).map_or(0, Vec::len);
        (devices > 0).then(|| nekko_js::to_number(gpu.get("freeMB")) * 1024.0 * 1024.0)
    }

    /// Progress while a model lands: the free-VRAM drop against its share of the file.
    fn sample_progress(&self, id: String, before: f64, expected: f64) {
        if !self.timers {
            return;
        }
        let me = self.me.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(LOAD_PROGRESS).await;
                let Some(me) = me.upgrade() else { return };
                if get(&me.state.lock().unwrap().loading, &id).is_none() {
                    return;
                }
                if let Some(free) = me.free_vram().await
                    && let Some(entry) = get_mut(&mut me.state.lock().unwrap().loading, &id)
                {
                    // Capped under full until health agrees it is done.
                    entry.progress = Some(((before - free) / expected).clamp(0.0, 0.95));
                }
            }
        });
    }

    /// Stop one model's server (`unload`). A model kept resident goes only when asked.
    pub async fn unload(&self, id: &str) -> Value {
        if remove(&mut self.state.lock().unwrap().children, id).is_none() {
            return reply(false, format!("{id} is not loaded."));
        }
        self.daemon.kill(id.to_string()).await;
        self.say(format!("Unloaded {id}."));
        reply(true, format!("Unloaded {id}."))
    }

    fn ttl_ms(&self, child: &Child) -> f64 {
        let ttl = child
            .params
            .get("ttlSeconds")
            .filter(|t| !t.is_null())
            .cloned()
            .unwrap_or_else(|| self.env.settings().get("idleTtlSeconds").cloned().unwrap_or(Value::Null));
        nekko_js::to_number(Some(&ttl)) * 1000.0
    }

    /// Evict anything past its TTL; 0 is "stay until told otherwise" (`sweepIdle`).
    pub async fn sweep_idle(&self) {
        self.sync().await;
        let now = self.env.now();
        let due: Vec<String> = {
            let s = self.state.lock().unwrap();
            s.children
                .iter()
                .filter(|(_, c)| {
                    let ttl = self.ttl_ms(c);
                    c.active_requests == 0.0 && ttl > 0.0 && now - c.last_used_at > ttl
                })
                .map(|(k, _)| k.clone())
                .collect()
        };
        for id in due {
            self.say(format!("{id} was idle, unloading."));
            self.unload(&id).await;
        }
    }

    /// Change a resident model's idle TTL without a reload (`setResidentTtl`).
    pub fn set_resident_ttl(&self, id: &str, ttl: Option<&Value>) -> Value {
        let mut s = self.state.lock().unwrap();
        let Some(entry) = get_mut(&mut s.children, id) else {
            return reply(false, format!("{id} is not loaded."));
        };
        let mut p = entry.params.as_object().cloned().unwrap_or_default();
        match ttl {
            Some(t) => {
                p.insert("ttlSeconds".into(), t.clone());
            }
            None => {
                p.shift_remove("ttlSeconds");
            }
        }
        entry.params = Value::Object(p);
        let seconds = ttl.map_or(f64::NAN, |t| nekko_js::to_number(Some(t)));
        let message = if ttl.is_some_and(|t| nekko_js::truthy(Some(t))) && seconds > 0.0 {
            format!("{id} now unloads after {}s idle.", text(ttl))
        } else {
            format!("{id} stays loaded until you unload it.")
        };
        reply(true, message)
    }

    /// The resident models (`resident`).
    pub fn resident(&self) -> Vec<Value> {
        let s = self.state.lock().unwrap();
        s.children
            .iter()
            .map(|(id, c)| {
                let ttl = self.ttl_ms(c);
                let mut m = Map::new();
                m.insert("id".into(), json!(id));
                m.insert("sizeBytes".into(), num(c.size_bytes));
                if let Some(v) = c.vram_bytes {
                    m.insert("vramBytes".into(), num(v));
                }
                for (k, v) in [
                    ("contextLength", &c.context_tokens),
                    ("gpuLayers", &c.gpu_layers),
                    ("totalLayers", &c.total_layers),
                ] {
                    if let Some(v) = v {
                        m.insert(k.into(), v.clone());
                    }
                }
                if let Some(on) = c.loaded_on {
                    m.insert("loadedOn".into(), json!(on));
                }
                m.insert("lastUsedAt".into(), num(c.last_used_at));
                m.insert("startedAt".into(), num(c.started_at));
                if ttl > 0.0 {
                    m.insert("expiresAt".into(), num(c.last_used_at + ttl));
                }
                Value::Object(m)
            })
            .collect()
    }

    pub fn is_running(&self) -> bool {
        self.state.lock().unwrap().serving
    }

    pub fn loaded_ids(&self) -> Vec<String> {
        self.state.lock().unwrap().children.iter().map(|(k, _)| k.clone()).collect()
    }

    /// The last load failure of each model (`loadErrorFor`).
    pub fn load_errors(&self) -> Map<String, Value> {
        self.state.lock().unwrap().errors.iter().map(|(k, v)| (k.clone(), json!(v))).collect()
    }

    /* ------------------------------------------------------------ router */

    /// The router asking for a model that is not running (`routerLoad`).
    pub async fn router_load(&self, requested: &str, image: bool) -> Value {
        self.sync().await;
        let Some(model) = self.env.find_model(requested.to_string()).await else {
            return json!({ "ok": false, "status": 404, "message": format!("No model named {requested}. Check /v1/models.") });
        };
        if (model.get("modality").and_then(Value::as_str) == Some("image")) != image {
            let message = if image {
                "This endpoint needs an image-generation model."
            } else {
                "Image models use /v1/images/generations, not text inference."
            };
            return json!({ "ok": false, "status": 400, "message": message });
        }
        if get(&self.state.lock().unwrap().children, requested).is_some() {
            return json!({ "ok": true });
        }
        if !nekko_js::truthy(self.env.settings().get("jitLoad")) {
            return json!({ "ok": false, "status": 409, "message": format!("{requested} is not loaded, and load-on-demand is off.") });
        }
        let preset = model.get("preset").filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
        let res = self.load(requested, preset).await;
        if res.get("ok") == Some(&Value::Bool(true)) {
            return json!({ "ok": true });
        }
        let message = res
            .get("message")
            .filter(|m| !m.is_null())
            .map(nekko_js::display)
            .unwrap_or_else(|| format!("Couldn't load {requested}."));
        json!({ "ok": false, "status": 503, "message": message })
    }

    /// `GET /v1/models` (`routerModels`).
    pub async fn router_models(&self) -> Value {
        self.sync().await;
        let models = self.env.list_models().await;
        let loaded: HashSet<String> = self.loaded_ids().into_iter().collect();
        let data: Vec<Value> = models.iter().map(|m| model_row(m, loaded.contains(&text(m.get("id"))))).collect();
        json!({ "object": "list", "data": data })
    }

    /// `GET /v1/models/{id}` (`routerModel`).
    pub async fn router_model(&self, id: &str) -> Value {
        match self.env.find_model(id.to_string()).await {
            Some(m) => model_row(&m, get(&self.state.lock().unwrap().children, id).is_some()),
            None => Value::Null,
        }
    }

    /// The server half of the engine's status (`status`).
    pub fn status(&self) -> Value {
        let resident = self.resident();
        let s = self.state.lock().unwrap();
        let mut m = Map::new();
        m.insert("running".into(), json!(s.serving));
        if let Some(t) = s.started_at {
            m.insert("startedAt".into(), num(t));
        }
        m.insert("resident".into(), json!(resident));
        let loading: Vec<Value> = s
            .loading
            .iter()
            .map(|(id, l)| {
                let mut o = Map::new();
                o.insert("id".into(), json!(id));
                o.insert("phase".into(), json!(l.phase));
                o.insert("startedAt".into(), num(l.started_at));
                if let Some(p) = l.progress {
                    o.insert("progress".into(), num(p));
                }
                Value::Object(o)
            })
            .collect();
        m.insert("loading".into(), json!(loading));
        m.insert("log".into(), json!(s.log[s.log.len().saturating_sub(40)..].to_vec()));
        m.insert("port".into(), self.env.settings().get("port").cloned().unwrap_or(Value::Null));
        Value::Object(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_bind_needs_a_key() {
        for settings in [
            json!({ "port": 11500, "bind": "lan", "apiKey": "" }),
            json!({ "port": 11500, "bind": "lan", "apiKey": "   " }),
            json!({ "port": 11500, "bind": "lan" }),
        ] {
            assert_eq!(serve_config(&settings), Err(LAN_NEEDS_KEY.to_string()), "{settings}");
        }
    }

    #[test]
    fn lan_bind_with_a_key_serves_every_interface() {
        let s = json!({ "port": 11600, "bind": "lan", "apiKey": "k", "corsOrigins": "http://a.test, *, " });
        assert_eq!(
            serve_config(&s),
            Ok(json!({ "port": 11600, "host": "0.0.0.0", "apiKey": "k", "corsOrigins": ["http://a.test", "*"] }))
        );
    }

    #[test]
    fn loopback_needs_no_key() {
        let s = json!({ "port": 11500, "bind": "local", "apiKey": "" });
        assert_eq!(serve_config(&s), Ok(json!({ "port": 11500, "host": "127.0.0.1", "corsOrigins": [] })));
        assert_eq!(serve_config(&json!({ "port": 11500 })).unwrap()["host"], "127.0.0.1");
    }
}
