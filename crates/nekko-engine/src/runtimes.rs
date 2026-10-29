//! The runtime control plane (`runtime:*`): Ollama, LM Studio and vLLM
//! adapters, the supervisor for the servers we start, the calibration record,
//! and the planner joined to the machine's real numbers. A port of
//! `packages/host/src/runtimes`, held to it by `tests/golden/runtimes.json`.
//! The engine's own adapter (`llamacpp`) asks the engine through [`HostEngine`]
//! until the engine itself moves.

use crate::capacity::{self, AutoFitInput, FitRequest, Hardware, ModelFacts, PlanOptions};
use crate::{BoxFuture, js_round, num};
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MB: f64 = 1024.0 * 1024.0;
const SHOW_TTL: Duration = Duration::from_secs(60);
const SHOW_CONCURRENCY: usize = 4;

/// One HTTP answer.
pub struct Reply {
    pub status: u16,
    pub body: String,
}

impl Reply {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// How the control plane reaches the servers and CLIs (scripted in tests).
pub trait RuntimeIo: Send + Sync {
    /// `None` when the request threw or timed out.
    fn fetch(
        &self,
        method: &'static str,
        url: String,
        body: Option<String>,
        timeout: Option<Duration>,
    ) -> BoxFuture<Option<Reply>>;
    /// `execFile`'s stdout then stderr; `None` when it failed with no output.
    fn run(&self, cmd: String, args: Vec<String>, timeout: Duration) -> BoxFuture<Option<String>>;
    /// `execFile` as `lms.ts` reads it: whether it exited 0, and stdout, a
    /// newline, then stderr.
    fn exec(&self, cmd: String, args: Vec<String>, timeout: Duration) -> BoxFuture<(bool, String)> {
        let run = self.run(cmd, args, timeout);
        Box::pin(async move {
            match run.await {
                Some(text) => (true, text),
                None => (false, String::new()),
            }
        })
    }
    /// Ollama's streamed `/api/pull`, drained to the end; the error is the message.
    fn pull(&self, url: String, body: String) -> BoxFuture<Result<(), String>> {
        let _ = (url, body);
        Box::pin(async { Err("pulling is not available here".to_string()) })
    }
}

/// `overheadFloorFor(kind, version)` over a calibration record
/// (`runtime-calibration.json`): the learned floor, else 256 MB.
pub fn overhead_floor(calibration: &Value, kind: &str, version: Option<&Value>) -> f64 {
    let key = format!("{kind}:{}", version.filter(|v| !v.is_null()).map_or("unknown".into(), nekko_js::display));
    calibration
        .get(&key)
        .and_then(|r| r.get("overheadFloorBytes"))
        .filter(|v| !v.is_null())
        .and_then(Value::as_f64)
        .unwrap_or(256.0 * MB)
}

/// The engine the host still runs (the `llamacpp` adapter's other end).
pub trait HostEngine: Send + Sync {
    fn call(&self, method: &'static str, args: Vec<Value>) -> BoxFuture<Result<Value, String>>;
}

/// The GPU and system meters (`gpu:stats`, `system:stats` shapes).
pub trait Probes: Send + Sync {
    fn gpu(&self) -> BoxFuture<Value>;
    fn system(&self) -> BoxFuture<Value>;
}

macro_rules! regex {
    ($pattern:expr, $flags:expr) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| Regex::with_flags($pattern, $flags).expect("a valid built-in pattern"))
    }};
}

fn trailing_slashes(s: &str) -> &str {
    s.trim_end_matches('/')
}

/// `apiRoot`: the base URL without trailing slashes or a `/v1`.
pub fn api_root(base: &str) -> String {
    let t = trailing_slashes(base);
    t.strip_suffix("/v1").unwrap_or(t).to_string()
}

fn trim_url(base: &str) -> String {
    trailing_slashes(base).to_string()
}

/// `isLocalhostUrl`.
pub fn is_localhost_url(base: &str) -> bool {
    match url::Url::parse(base) {
        Ok(u) => {
            matches!(u.host_str().unwrap_or("").to_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        }
        Err(_) => regex!(r"^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)", "i")
            .find(nekko_js::trim(base))
            .is_some(),
    }
}

/// `lmsBin`: LM Studio's bundled CLI, else `lms` on PATH.
pub fn lms_bin() -> String {
    let name = if cfg!(windows) { "lms.exe" } else { "lms" };
    let home = nekko_js::home_dir();
    match home.map(|h| h.join(".lmstudio").join("bin").join(name)) {
        Some(p) if p.exists() => p.to_string_lossy().into_owned(),
        _ => "lms".into(),
    }
}

/// `new URL(base).port` as a number.
fn url_port(base: &str) -> Option<u16> {
    url::Url::parse(base).ok().and_then(|u| u.port())
}

const KINDS: [&str; 4] = ["ollama", "lmstudio", "vllm", "llamacpp"];

/// `RUNTIME_CAPABILITIES[kind]`.
pub fn capabilities(kind: &str) -> Value {
    match kind {
        "ollama" => {
            json!({ "canStart": true, "canStop": true, "canLoad": true, "canSetContext": true, "canSetGpuLayers": true, "canSetParallel": "server-env", "canSetKvCacheType": "server-env", "canSetTtl": true, "configuredAtLaunch": false, "reportsPerModelVram": true })
        }
        "lmstudio" => {
            json!({ "canStart": true, "canStop": true, "canLoad": true, "canSetContext": true, "canSetGpuLayers": true, "canSetParallel": false, "canSetKvCacheType": false, "canSetTtl": true, "configuredAtLaunch": false, "reportsPerModelVram": false })
        }
        "vllm" => {
            json!({ "canStart": false, "canStop": true, "canLoad": false, "canSetContext": false, "canSetGpuLayers": false, "canSetParallel": false, "canSetKvCacheType": false, "canSetTtl": false, "configuredAtLaunch": true, "reportsPerModelVram": false })
        }
        "llamacpp" => {
            json!({ "canStart": true, "canStop": true, "canLoad": true, "canSetContext": true, "canSetGpuLayers": true, "canSetParallel": "per-load", "canSetKvCacheType": "per-load", "canSetTtl": true, "configuredAtLaunch": false, "reportsPerModelVram": true, "managed": true, "canSetCompute": true })
        }
        _ => Value::Null,
    }
}

/// An object built key by key, leaving out `undefined` values as JSON does.
#[derive(Default)]
struct Obj(Map<String, Value>);

impl Obj {
    fn set(mut self, k: &str, v: impl Into<Value>) -> Self {
        self.0.insert(k.into(), v.into());
        self
    }
    fn opt(mut self, k: &str, v: Option<Value>) -> Self {
        if let Some(v) = v {
            self.0.insert(k.into(), v);
        }
        self
    }
    fn done(self) -> Value {
        Value::Object(self.0)
    }
}

/// `a ?? b` over raw JSON values (`null` falls through, as `undefined` does).
fn coalesce(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    nekko_js::coalesce(a, b).cloned()
}

/// A runtime detection (`RuntimeDetection`).
struct Detection {
    running: bool,
    installed: bool,
    version: Option<Value>,
    reason: Option<String>,
}

const LMS_REMOTE: &str =
    "This LM Studio looks remote. Starting, stopping, and loading need the lms CLI on the machine running it.";
const LMS_MISSING: &str =
    "LM Studio's lms CLI was not found. Run `lms bootstrap` (or reinstall LM Studio) to manage it from here.";
const VLLM_REASON: &str = "vLLM is managed outside Nekko Agent: it serves one model per process, configured at launch. Start it yourself with the command shown in the fit drawer.";

fn lms_failure(text: &str) -> bool {
    regex!(r"(model not found|cannot find a model|no models are|is not loaded|not connected|failed to|error:)", "i")
        .find(text)
        .is_some()
}

/// `firstLines`: a CLI's first two non-empty lines, for a toast.
fn first_lines(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).take(2).collect();
    nekko_js::slice16(&lines.join(". "), 240).to_string()
}

struct Supervised {
    child: tokio::process::Child,
    started_at: f64,
    log: Arc<Mutex<Vec<String>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The control plane: the adapters, the supervisor and the calibration record.
pub struct Runtimes {
    io: Arc<dyn RuntimeIo>,
    engine: Arc<dyn HostEngine>,
    probes: Arc<dyn Probes>,
    /// The providers list (`settings.providers`), read on every call.
    providers: Box<dyn Fn() -> Value + Send + Sync>,
    calibration_file: Option<PathBuf>,
    show_cache: Mutex<HashMap<String, (Instant, Value)>>,
    owned: tokio::sync::Mutex<HashMap<String, Supervised>>,
    /// `lms version` answered, cached 15 s (`lmsInstalled`).
    lms_version: Mutex<Option<(Instant, bool)>>,
}

impl Runtimes {
    pub fn new(
        io: Arc<dyn RuntimeIo>,
        engine: Arc<dyn HostEngine>,
        probes: Arc<dyn Probes>,
        providers: Box<dyn Fn() -> Value + Send + Sync>,
        data_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            io,
            engine,
            probes,
            providers,
            calibration_file: data_dir.map(|d| d.join("runtime-calibration.json")),
            show_cache: Mutex::default(),
            owned: tokio::sync::Mutex::new(HashMap::new()),
            lms_version: Mutex::new(None),
        }
    }

    /// Kill every server this process started (daemon exit).
    pub async fn kill_all(&self) {
        for (_, mut s) in self.owned.lock().await.drain() {
            let _ = s.child.start_kill();
        }
    }

    // ---- HTTP and CLI helpers (types.ts) ----------------------------------

    async fn get_json(&self, url: String, timeout_ms: u64) -> Option<Value> {
        let r = self.io.fetch("GET", url, None, Some(Duration::from_millis(timeout_ms))).await?;
        if !r.ok() {
            return None;
        }
        serde_json::from_str(&r.body).ok()
    }

    async fn post_json(&self, url: String, body: &Value, timeout_ms: u64) -> Option<Reply> {
        self.io.fetch("POST", url, Some(nekko_js::stringify(body)), Some(Duration::from_millis(timeout_ms))).await
    }

    async fn run(&self, cmd: &str, args: &[&str], timeout_ms: u64) -> Option<String> {
        self.io
            .run(cmd.to_string(), args.iter().map(|s| s.to_string()).collect(), Duration::from_millis(timeout_ms))
            .await
    }

    async fn host(&self, method: &'static str, args: Vec<Value>) -> Value {
        self.engine.call(method, args).await.unwrap_or(Value::Null)
    }

    fn resolve(&self, id: &str) -> Option<(String, Value)> {
        let providers = (self.providers)();
        let p = providers.as_array()?.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id))?.clone();
        let kind = p.get("kind").and_then(Value::as_str)?.to_string();
        KINDS.contains(&kind.as_str()).then_some((kind, p))
    }

    // ---- Ollama -------------------------------------------------------------

    async fn ollama_show(&self, base: &str, model: &str) -> Value {
        let key = format!("{base}::{model}");
        if let Some((at, v)) = lock(&self.show_cache).get(&key)
            && at.elapsed() < SHOW_TTL
        {
            return v.clone();
        }
        let value = match self.post_json(format!("{}/api/show", api_root(base)), &json!({ "model": model }), 6000).await
        {
            Some(r) if r.ok() => serde_json::from_str(&r.body).unwrap_or(Value::Null),
            _ => Value::Null,
        };
        lock(&self.show_cache).insert(key, (Instant::now(), value.clone()));
        value
    }

    async fn ollama_ps(&self, base: &str) -> Vec<Value> {
        self.get_json(format!("{}/api/ps", api_root(base)), 4000)
            .await
            .and_then(|j| j.get("models").and_then(Value::as_array).cloned())
            .unwrap_or_default()
    }

    fn ps_name(e: &Value) -> String {
        coalesce(e.get("name"), e.get("model")).map(|v| nekko_js::display(&v)).unwrap_or_default()
    }

    fn ollama_resident(e: &Value) -> Value {
        let expires = e.get("expires_at").filter(|v| nekko_js::truthy(Some(v))).and_then(|v| {
            let t = nekko_usage::date::parse(&nekko_js::display(v));
            nekko_js::truthy_number(t).then(|| num(t))
        });
        Obj::default()
            .set("id", Self::ps_name(e))
            .opt("sizeBytes", e.get("size").cloned())
            .opt("vramBytes", e.get("size_vram").cloned())
            .opt("contextLength", e.get("context_length").cloned())
            .opt("expiresAt", expires)
            .done()
    }

    fn info_number(info: &Value, suffix: &str) -> Option<f64> {
        let map = info.as_object()?;
        for (k, v) in nekko_usage::js_entries(map) {
            if k == suffix || k.ends_with(&format!(".{suffix}")) {
                let n = nekko_js::to_number(Some(v));
                if n.is_finite() && n > 0.0 {
                    return Some(n);
                }
            }
        }
        None
    }

    async fn ollama_detect(&self, base: &str) -> Detection {
        if let Some(v) =
            self.get_json(format!("{}/api/version", api_root(base)), 2500).await.filter(|v| nekko_js::truthy(Some(v)))
        {
            return Detection { running: true, installed: true, version: v.get("version").cloned(), reason: None };
        }
        match self.run("ollama", &["--version"], 4000).await {
            Some(out) => Detection {
                running: false,
                installed: true,
                version: regex!(r"(\d+\.\d+\.\d+)", "").find(&out).and_then(|m| m.group(1)).map(|g| json!(&out[g])),
                reason: None,
            },
            None => Detection {
                running: false,
                installed: false,
                version: None,
                reason: Some(
                    "Ollama was not found on this machine. Install it from ollama.com, then start it here.".into(),
                ),
            },
        }
    }

    async fn ollama_list(&self, base: &str) -> Vec<Value> {
        let root = api_root(base);
        let tags = self.get_json(format!("{root}/api/tags"), 6000).await;
        let models: Vec<Value> =
            tags.and_then(|t| t.get("models").and_then(Value::as_array).cloned()).unwrap_or_default();
        let names: Vec<String> = models.iter().map(Self::ps_name).filter(|n| !n.is_empty()).collect();
        let mut sizes: HashMap<String, Option<Value>> = HashMap::new();
        for m in &models {
            sizes.insert(Self::ps_name(m), m.get("size").cloned());
        }
        let mut running: HashMap<String, Value> = HashMap::new();
        for e in self.ollama_ps(base).await {
            running.insert(Self::ps_name(&e), e);
        }
        let mut out = Vec::new();
        for batch in names.chunks(SHOW_CONCURRENCY) {
            let details = futures_util::future::join_all(batch.iter().map(|n| self.ollama_show(base, n))).await;
            for (name, detail) in batch.iter().zip(details) {
                let live = running.get(name);
                let disk = sizes.get(name).cloned().flatten();
                out.push(Self::ollama_facts(name, base, &detail, live, disk));
            }
        }
        out
    }

    fn ollama_facts(name: &str, base: &str, detail: &Value, live: Option<&Value>, disk: Option<Value>) -> Value {
        let empty = json!({});
        let info = detail.get("model_info").filter(|v| !v.is_null()).unwrap_or(&empty);
        let layers = Self::info_number(info, "block_count");
        let kv_heads = Self::info_number(info, "attention.head_count_kv");
        let heads = Self::info_number(info, "attention.head_count");
        let embedding = Self::info_number(info, "embedding_length");
        let live_get = |k: &str| live.and_then(|l| l.get(k));
        let dd = |k: &str| detail.get("details").and_then(|d| d.get(k));
        let ld = |k: &str| live.and_then(|l| l.get("details")).and_then(|d| d.get(k));
        Obj::default()
            .set("id", name)
            .set("providerId", base)
            .opt("weightsBytes", coalesce(live_get("size"), disk.as_ref()))
            .opt("layers", layers.map(num))
            .opt("kvHeads", kv_heads.or(heads).map(num))
            .opt("headDim", capacity::head_dim_of(embedding, heads).map(num))
            .opt("maxContext", Self::info_number(info, "context_length").map(num))
            .opt("quantization", coalesce(dd("quantization_level"), ld("quantization_level")))
            .opt("parameterSize", coalesce(dd("parameter_size"), ld("parameter_size")))
            .set("loaded", live.is_some())
            .opt("vramBytes", live_get("size_vram").cloned())
            .opt("loadedContext", live_get("context_length").cloned())
            .done()
    }

    // ---- LM Studio ----------------------------------------------------------

    async fn lms(&self, args: &[&str], timeout_ms: u64) -> (bool, String) {
        match self.run(&lms_bin(), args, timeout_ms).await {
            None => (false, String::new()),
            Some(out) => (!lms_failure(&out), nekko_js::trim(&out).to_string()),
        }
    }

    async fn lms_models(&self, base: &str) -> Vec<Value> {
        self.get_json(format!("{}/api/v0/models", api_root(base)), 6000)
            .await
            .and_then(|j| j.get("data").and_then(Value::as_array).cloned())
            .unwrap_or_default()
    }

    async fn lms_catalogue(&self, base: &str) -> HashMap<String, Value> {
        let mut out = HashMap::new();
        if !is_localhost_url(base) {
            return out;
        }
        let Some(text) = self.run(&lms_bin(), &["ls", "--json"], 10_000).await.filter(|t| !t.is_empty()) else {
            return out;
        };
        // `out.slice(out.indexOf('['))`: no bracket leaves the last character, which never parses.
        let from = text.find('[').unwrap_or_else(|| text.char_indices().last().map_or(0, |(i, _)| i));
        if let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&text[from..]) {
            for e in entries {
                if let Some(k) = e.get("modelKey").filter(|k| nekko_js::truthy(Some(k))) {
                    out.insert(nekko_js::display(k), e);
                }
            }
        }
        out
    }

    async fn lms_detect(&self, base: &str) -> Detection {
        let running = !self.lms_models(base).await.is_empty()
            || self.get_json(format!("{}/models", trim_url(base)), 2500).await.is_some();
        if !is_localhost_url(base) {
            return Detection { running, installed: false, version: None, reason: Some(LMS_REMOTE.into()) };
        }
        match self.run(&lms_bin(), &["version"], 4000).await {
            Some(v) => Detection {
                running,
                installed: true,
                version: regex!(r"(\d+\.\d+\.\d+)", "").find(&v).and_then(|m| m.group(1)).map(|g| json!(&v[g])),
                reason: None,
            },
            None => Detection { running, installed: false, version: None, reason: Some(LMS_MISSING.into()) },
        }
    }

    async fn lms_list(&self, base: &str) -> Vec<Value> {
        let (live, disk) = tokio::join!(self.lms_models(base), self.lms_catalogue(base));
        live.iter()
            .map(|m| {
                let d = m.get("id").map(nekko_js::display).and_then(|id| disk.get(&id));
                let dget = |k: &str| d.and_then(|d| d.get(k));
                Obj::default()
                    .opt("id", m.get("id").cloned())
                    .set("providerId", base)
                    .opt("weightsBytes", dget("sizeBytes").cloned())
                    .opt("maxContext", coalesce(m.get("max_context_length"), dget("maxContextLength")))
                    .opt(
                        "quantization",
                        coalesce(m.get("quantization"), dget("quantization").and_then(|q| q.get("name"))),
                    )
                    .opt("parameterSize", dget("paramsString").cloned())
                    .set("loaded", m.get("state") == Some(&json!("loaded")))
                    .opt("loadedContext", coalesce(m.get("loaded_context_length"), None))
                    .done()
            })
            .collect()
    }

    // ---- vLLM ---------------------------------------------------------------

    fn vllm_metric(text: &str, name: &str) -> Option<f64> {
        for line in text.split('\n') {
            let t = nekko_js::trim(line);
            if t.is_empty() || t.starts_with('#') || !t.starts_with(name) {
                continue;
            }
            let v = nekko_js::string_to_number(&t[t.rfind(' ').map_or(0, |i| i + 1)..]);
            if v.is_finite() {
                return Some(v);
            }
        }
        None
    }

    /// `parseVllmMetrics`.
    pub fn parse_vllm_metrics(text: &str) -> Value {
        Obj::default()
            .opt("requestsRunning", Self::vllm_metric(text, "vllm:num_requests_running").map(num))
            .opt("requestsWaiting", Self::vllm_metric(text, "vllm:num_requests_waiting").map(num))
            .opt("kvCacheUsagePct", Self::vllm_metric(text, "vllm:kv_cache_usage_perc").map(|k| num(k * 100.0)))
            .done()
    }

    // ---- Adapters, by kind --------------------------------------------------

    async fn detect(&self, kind: &str, base: &str) -> Detection {
        match kind {
            "ollama" => self.ollama_detect(base).await,
            "lmstudio" => self.lms_detect(base).await,
            "vllm" => Detection {
                running: self.get_json(format!("{}/models", trim_url(base)), 2500).await.is_some(),
                installed: false,
                version: None,
                reason: Some(VLLM_REASON.into()),
            },
            _ => {
                let install = self.host("detectEngine", vec![]).await;
                let running = nekko_js::truthy(Some(&self.host("isRunning", vec![]).await));
                let has_bin = nekko_js::truthy(install.get("binPath"));
                Detection {
                    running,
                    installed: has_bin,
                    version: install.get("version").cloned(),
                    reason: if has_bin { None } else { install.get("reason").map(nekko_js::display) },
                }
            }
        }
    }

    async fn adapter_status(&self, kind: &str, base: &str) -> Value {
        match kind {
            "ollama" | "lmstudio" => {
                let d = self.detect(kind, base).await;
                let resident: Vec<Value> = if kind == "ollama" {
                    if d.running {
                        self.ollama_ps(base).await.iter().map(Self::ollama_resident).collect()
                    } else {
                        vec![]
                    }
                } else {
                    self.lms_models(base)
                        .await
                        .iter()
                        .filter(|m| m.get("state") == Some(&json!("loaded")))
                        .map(|m| {
                            Obj::default()
                                .opt("id", m.get("id").cloned())
                                .opt("contextLength", m.get("loaded_context_length").cloned())
                                .done()
                        })
                        .collect()
                };
                Obj::default()
                    .set("kind", kind)
                    .set("running", d.running)
                    .set("installed", d.installed)
                    .opt("reason", d.reason.map(Value::String))
                    .set("owned", false)
                    .opt("version", d.version)
                    .set("baseUrl", base)
                    .set("resident", resident)
                    .done()
            }
            "vllm" => {
                let models = self.get_json(format!("{}/models", trim_url(base)), 2500).await;
                let metrics = match self.io.fetch("GET", format!("{}/metrics", api_root(base)), None, None).await {
                    Some(r) if r.ok() && !r.body.is_empty() => Some(Self::parse_vllm_metrics(&r.body)),
                    _ => None,
                };
                let resident: Vec<Value> = models
                    .as_ref()
                    .and_then(|m| m.get("data").and_then(Value::as_array))
                    .map(|a| a.iter().map(|m| Obj::default().opt("id", m.get("id").cloned()).done()).collect())
                    .unwrap_or_default();
                Obj::default()
                    .set("kind", "vllm")
                    .set("running", models.is_some())
                    .set("installed", false)
                    .set("owned", false)
                    .set("baseUrl", base)
                    .set("resident", resident)
                    .opt("metrics", metrics)
                    .done()
            }
            _ => {
                let state = self.host("status", vec![]).await;
                let install = state.get("install").cloned().unwrap_or(Value::Null);
                let has_bin = nekko_js::truthy(install.get("binPath"));
                Obj::default()
                    .set("kind", "llamacpp")
                    .opt("running", state.get("running").cloned())
                    .set("installed", has_bin)
                    .opt("reason", if has_bin { None } else { install.get("reason").cloned() })
                    .opt("owned", state.get("running").cloned())
                    .opt("version", install.get("version").cloned())
                    .set("baseUrl", base)
                    .opt("startedAt", state.get("startedAt").cloned())
                    .opt("resident", state.get("resident").cloned())
                    .opt("log", state.get("log").cloned())
                    .done()
            }
        }
    }

    async fn list_models(&self, kind: &str, base: &str) -> Vec<Value> {
        match kind {
            "ollama" => self.ollama_list(base).await,
            "lmstudio" => self.lms_list(base).await,
            "vllm" => self
                .get_json(format!("{}/models", trim_url(base)), 6000)
                .await
                .and_then(|m| m.get("data").and_then(Value::as_array).cloned())
                .unwrap_or_default()
                .iter()
                .map(|m| {
                    Obj::default()
                        .opt("id", m.get("id").cloned())
                        .set("providerId", base)
                        .opt("maxContext", m.get("max_model_len").cloned())
                        .set("loaded", true)
                        .done()
                })
                .collect(),
            _ => {
                let models = self.host("models", vec![]).await;
                let resident = self.host("resident", vec![]).await;
                let live =
                    |id: &Value| resident.as_array().and_then(|r| r.iter().find(|x| x.get("id") == Some(id)).cloned());
                models
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|m| {
                        let l = m.get("id").and_then(live);
                        Obj::default()
                            .opt("id", m.get("id").cloned())
                            .set("providerId", base)
                            .opt("weightsBytes", m.get("sizeBytes").cloned())
                            .opt("layers", m.get("layers").cloned())
                            .opt("kvHeads", m.get("kvHeads").cloned())
                            .opt("headDim", m.get("headDim").cloned())
                            .opt("kvLayout", m.get("kvLayout").cloned())
                            .opt("weightLayout", m.get("weightLayout").cloned())
                            .opt("maxContext", m.get("maxContext").cloned())
                            .opt("quantization", m.get("quantization").cloned())
                            .opt("parameterSize", m.get("parameterSize").cloned())
                            .opt("loaded", m.get("loaded").cloned())
                            .opt("vramBytes", l.as_ref().and_then(|l| l.get("vramBytes")).cloned())
                            .opt("loadedContext", l.as_ref().and_then(|l| l.get("contextLength")).cloned())
                            .done()
                    })
                    .collect()
            }
        }
    }

    async fn adapter_load(&self, kind: &str, base: &str, model: &str, params: &Value) -> Option<Value> {
        let p = |k: &str| params.get(k);
        Some(match kind {
            "ollama" => {
                let mut options = Map::new();
                if nekko_js::truthy(p("contextTokens")) {
                    options.insert("num_ctx".into(), p("contextTokens").cloned().unwrap_or(Value::Null));
                }
                if let Some(g) = p("gpuLayers") {
                    // Ollama, like llama.cpp, counts the output layer as one past the
                    // model's blocks: `num_gpu` equal to the block count (what a full
                    // offload's `gpuLayers` holds) leaves it on the CPU, so all of
                    // them asks for everything (see `--n-gpu-layers` in launch.rs).
                    let asked = nekko_js::to_number(Some(g));
                    let full = g.is_number()
                        && asked > 0.0
                        && Self::info_number(&self.ollama_show(base, model).await["model_info"], "block_count")
                            .is_some_and(|blocks| asked >= blocks);
                    options.insert("num_gpu".into(), if full { json!(999) } else { g.clone() });
                }
                let mut body =
                    Obj::default().set("model", model).set("prompt", "").set("options", Value::Object(options));
                if let Some(t) = p("ttlSeconds") {
                    body = body.set("keep_alive", format!("{}s", nekko_js::display(t)));
                }
                match self.post_json(format!("{}/api/generate", api_root(base)), &body.done(), 300_000).await {
                    Some(r) if r.ok() => json!({ "ok": true, "message": format!("Loaded {model}") }),
                    Some(r) => {
                        json!({ "ok": false, "message": format!("Ollama refused the load (HTTP {}).", r.status) })
                    }
                    None => json!({ "ok": false, "message": "Ollama did not respond." }),
                }
            }
            "lmstudio" => {
                if !is_localhost_url(base) {
                    return Some(json!({ "ok": false, "message": LMS_REMOTE }));
                }
                let mut args: Vec<String> = vec!["load".into(), model.into(), "-y".into()];
                if nekko_js::truthy(p("contextTokens")) {
                    args.push("--context-length".into());
                    args.push(nekko_js::display(p("contextTokens").unwrap_or(&Value::Null)));
                }
                // gpuFlag: a GPU share for `--gpu`, from the layers asked for.
                let gpu = match p("gpuLayers") {
                    None => None,
                    Some(g) if nekko_js::to_number(Some(g)) == 0.0 && g.is_number() => Some("off".to_string()),
                    Some(g) => {
                        let facts = self.lms_list(base).await.into_iter().find(|m| m.get("id") == Some(&json!(model)));
                        match facts.as_ref().and_then(|f| f.get("layers")).filter(|l| nekko_js::truthy(Some(l))) {
                            None => Some("max".into()),
                            Some(layers) => {
                                let share = capacity::jmin(
                                    1.0,
                                    capacity::jmax(
                                        0.0,
                                        nekko_js::to_number(Some(g)) / nekko_js::to_number(Some(layers)),
                                    ),
                                );
                                Some(if share >= 0.999 {
                                    "max".into()
                                } else {
                                    nekko_js::to_fixed_unsigned_zero(share, 2)
                                })
                            }
                        }
                    }
                };
                if let Some(g) = gpu {
                    args.push("--gpu".into());
                    args.push(g);
                }
                if let Some(t) = p("ttlSeconds") {
                    args.push("--ttl".into());
                    args.push(nekko_js::display(t));
                }
                let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                let (ok, text) = self.lms(&refs, 300_000).await;
                if ok {
                    json!({ "ok": true, "message": format!("Loaded {model}") })
                } else {
                    let msg = first_lines(&text);
                    json!({ "ok": false, "message": if msg.is_empty() { format!("Couldn't load {model}.") } else { msg } })
                }
            }
            "llamacpp" => self.host("load", vec![json!(model), params.clone()]).await,
            _ => return None,
        })
    }

    async fn adapter_unload(&self, kind: &str, base: &str, model: &str) -> Option<Value> {
        Some(match kind {
            "ollama" => {
                let body = json!({ "model": model, "prompt": "", "keep_alive": 0 });
                match self.post_json(format!("{}/api/generate", api_root(base)), &body, 15_000).await {
                    Some(r) if r.ok() => json!({ "ok": true, "message": format!("Unloaded {model}") }),
                    _ => json!({ "ok": false, "message": format!("Couldn't unload {model}.") }),
                }
            }
            "lmstudio" => {
                if !is_localhost_url(base) {
                    return Some(json!({ "ok": false, "message": LMS_REMOTE }));
                }
                let (ok, text) = self.lms(&["unload", model], 15_000).await;
                if ok {
                    json!({ "ok": true, "message": format!("Unloaded {model}") })
                } else {
                    let msg = first_lines(&text);
                    json!({ "ok": false, "message": if msg.is_empty() { format!("Couldn't unload {model}.") } else { msg } })
                }
            }
            "llamacpp" => self.host("unload", vec![json!(model)]).await,
            _ => return None,
        })
    }

    // ---- Calibration (calibration.ts) ---------------------------------------

    fn calibration(&self) -> Value {
        self.calibration_file
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({}))
    }

    fn overhead_floor_for(&self, kind: &str, version: Option<&Value>) -> f64 {
        overhead_floor(&self.calibration(), kind, version)
    }

    fn record_measurement(
        &self,
        kind: &str,
        version: Option<&Value>,
        measured: f64,
        projected: f64,
        projected_overhead: f64,
    ) {
        if !measured.is_finite() || measured <= 0.0 {
            return;
        }
        let implied = projected_overhead + (measured - projected);
        if !(64.0 * MB..=8.0 * 1024.0 * MB).contains(&implied) {
            return;
        }
        let Some(file) = &self.calibration_file else { return };
        let mut store = match self.calibration() {
            Value::Object(o) => o,
            _ => Map::new(),
        };
        let key = format!("{kind}:{}", version.filter(|v| !v.is_null()).map_or("unknown".into(), nekko_js::display));
        let prev = store.get(&key).cloned();
        let base =
            prev.as_ref().and_then(|p| p.get("overheadFloorBytes")).and_then(Value::as_f64).unwrap_or(256.0 * MB);
        let samples = prev.as_ref().and_then(|p| p.get("samples")).and_then(Value::as_f64).unwrap_or(0.0);
        store.insert(
            key,
            json!({ "overheadFloorBytes": num(js_round(base * (1.0 - 0.3) + implied * 0.3)), "samples": num(samples + 1.0) }),
        );
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, nekko_js::stringify_pretty(&Value::Object(store), "  "));
    }

    // ---- Supervisor (supervisor.ts) -----------------------------------------

    async fn healthy(&self, base: &str) -> bool {
        let root = trailing_slashes(base);
        if self.io.fetch("GET", format!("{root}/api/version"), None, None).await.is_some_and(|r| r.ok()) {
            return true;
        }
        self.io.fetch("GET", format!("{root}/models"), None, None).await.is_some_and(|r| r.ok())
    }

    async fn supervise(
        &self,
        id: &str,
        base: &str,
        cmd: &str,
        args: &[&str],
        env: Option<(String, String)>,
    ) -> Result<(), String> {
        if self.owned.lock().await.contains_key(id) {
            return Ok(());
        }
        if self.healthy(base).await {
            return Ok(());
        }
        let mut command = tokio::process::Command::new(resolve_program(cmd));
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some((k, v)) = env {
            command.env(k, v);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        for pipe in [
            child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let log = log.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !nekko_js::trim(&line).is_empty() {
                        let mut l = lock(&log);
                        l.push(line.trim_end().to_string());
                        let over = l.len().saturating_sub(200);
                        l.drain(..over);
                    }
                }
            });
        }
        let started_at = nekko_js::now_ms_f64();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                let tail: Vec<String> = { lock(&log).iter().rev().take(3).rev().cloned().collect() };
                let joined = tail.join(" ");
                return Err(if joined.is_empty() {
                    format!("The server exited with code {}.", status.code().map_or("null".into(), |c| c.to_string()))
                } else {
                    joined
                });
            }
            if self.healthy(base).await {
                self.owned.lock().await.insert(id.to_string(), Supervised { child, started_at, log });
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let _ = child.start_kill();
        Err("The server did not become reachable in time.".into())
    }

    async fn supervisor_stop(&self, id: &str, base: &str, force: bool) -> Value {
        if let Some(mut s) = self.owned.lock().await.remove(id) {
            let _ = s.child.start_kill();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(3), s.child.wait()).await;
                let _ = s.child.start_kill();
            });
            return json!({ "ok": true, "message": "Stopped the server." });
        }
        if !force {
            return json!({
                "ok": false,
                "message": "This server was not started by Nekko Agent. Stopping it means ending a process something else may be using.",
                "needsConfirmation": true,
                "processName": base,
            });
        }
        stop_local_server(&*self.io, base).await
    }

    // ---- The control plane (index.ts) ---------------------------------------

    async fn hardware(&self) -> Hardware {
        let (gpu, sys) = tokio::join!(self.probes.gpu(), self.probes.system());
        let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64);
        let total = n(&sys, "memTotalMB").unwrap_or(0.0);
        let used = n(&sys, "memUsedMB").unwrap_or(0.0);
        Hardware {
            devices: gpu
                .get("devices")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|d| capacity::Device {
                            name: d.get("name").map(nekko_js::display).unwrap_or_default(),
                            total: n(d, "memoryTotalMB").unwrap_or(f64::NAN) * MB,
                            free: n(d, "memoryFreeMB").unwrap_or(f64::NAN) * MB,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            unified: nekko_js::truthy(gpu.get("unified")),
            ram_total: total * MB,
            ram_free: capacity::jmax(0.0, total - used) * MB,
        }
    }

    pub async fn status(&self, id: &str) -> Value {
        let Some((kind, p)) = self.resolve(id) else { return Value::Null };
        let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        let mut s = match self.adapter_status(&kind, &base).await {
            Value::Object(o) => o,
            _ => Map::new(),
        };
        let owned = self.owned.lock().await;
        s.insert("owned".into(), json!(owned.contains_key(id)));
        if let Some(sup) = owned.get(id) {
            s.insert("startedAt".into(), num(sup.started_at));
            let log: Vec<String> = { lock(&sup.log).iter().rev().take(20).rev().cloned().collect() };
            if !log.is_empty() {
                s.insert("log".into(), json!(log));
            }
        }
        Value::Object(s)
    }

    pub async fn start(&self, id: &str) -> Value {
        let Some((kind, p)) = self.resolve(id) else { return json!({ "error": "Not a local model server." }) };
        let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        if capabilities(&kind)["canStart"] != json!(true) {
            let d = self.detect(&kind, &base).await;
            return json!({ "error": d.reason.unwrap_or_else(|| "This runtime cannot be started from here.".into()) });
        }
        match kind.as_str() {
            "ollama" => {
                let d = self.detect(&kind, &base).await;
                if !d.installed {
                    return json!({ "error": d.reason.unwrap_or_else(|| format!("{kind} was not found on this machine.")) });
                }
                // Server-wide settings Ollama reads only at startup.
                let env = url::Url::parse(&base).ok().map(|u| {
                    let port = u.port().map_or("11434".to_string(), |p| p.to_string());
                    ("OLLAMA_HOST".to_string(), format!("{}:{port}", u.host_str().unwrap_or("")))
                });
                if let Err(e) = self.supervise(id, &base, "ollama", &["serve"], env).await {
                    return json!({ "error": e });
                }
                match self.status(id).await {
                    Value::Null => json!({ "error": "Started, but the server is not answering yet." }),
                    s => s,
                }
            }
            "lmstudio" => {
                let port = url_port(&base);
                let port_s = port.map(|p| p.to_string());
                let mut args = vec!["server", "start"];
                if let Some(p) = &port_s {
                    args.push("--port");
                    args.push(p);
                }
                let (ok, text) = self.lms(&args, 30_000).await;
                if !ok {
                    return json!({ "error": if text.is_empty() { "lms server start failed.".to_string() } else { text } });
                }
                let log: Option<Vec<String>> = (!text.is_empty()).then(|| {
                    let lines: Vec<String> = text.split('\n').map(str::to_string).collect();
                    lines[lines.len().saturating_sub(20)..].to_vec()
                });
                Obj::default()
                    .set("kind", "lmstudio")
                    .set("running", true)
                    .set("owned", false)
                    .set("baseUrl", base)
                    .set("startedAt", num(nekko_js::now_ms_f64()))
                    .set("resident", json!([]))
                    .opt("log", log.map(|l| json!(l)))
                    .done()
            }
            _ => {
                let res = self.host("start", vec![]).await;
                let state = self.host("status", vec![]).await;
                if !nekko_js::truthy(res.get("ok")) {
                    return Obj::default().opt("error", res.get("message").cloned()).done();
                }
                let install = state.get("install").cloned().unwrap_or(Value::Null);
                Obj::default()
                    .set("kind", "llamacpp")
                    .opt("running", state.get("running").cloned())
                    .set("installed", nekko_js::truthy(install.get("binPath")))
                    .opt("owned", state.get("running").cloned())
                    .opt("version", install.get("version").cloned())
                    .set(
                        "baseUrl",
                        format!(
                            "http://127.0.0.1:{}/v1",
                            state.get("port").map(nekko_js::display).unwrap_or_else(|| "undefined".into())
                        ),
                    )
                    .opt("startedAt", state.get("startedAt").cloned())
                    .opt("resident", state.get("resident").cloned())
                    .opt("log", state.get("log").cloned())
                    .done()
            }
        }
    }

    pub async fn stop(&self, id: &str, force: bool) -> Value {
        let Some((kind, p)) = self.resolve(id) else {
            return json!({ "ok": false, "message": "Only local model servers can be stopped from here." });
        };
        let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        if self.owned.lock().await.contains_key(id) {
            return self.supervisor_stop(id, &base, force).await;
        }
        // Self-managed runtimes have a real shutdown of their own.
        match kind.as_str() {
            "lmstudio" => {
                if !is_localhost_url(&base) {
                    return json!({ "ok": false, "message": LMS_REMOTE });
                }
                let (ok, text) = self.lms(&["server", "stop"], 15_000).await;
                if ok {
                    json!({ "ok": true, "message": "Stopped the LM Studio server." })
                } else {
                    json!({ "ok": false, "message": if text.is_empty() { "Couldn't stop the LM Studio server.".to_string() } else { text } })
                }
            }
            "llamacpp" => self.host("stop", vec![]).await,
            _ => self.supervisor_stop(id, &base, force).await,
        }
    }

    pub async fn facts(&self, id: &str) -> Vec<Value> {
        let Some((kind, p)) = self.resolve(id) else { return Vec::new() };
        self.list_models(&kind, &p.get("baseUrl").map(nekko_js::display).unwrap_or_default()).await
    }

    /// Facts, the one model, its runtime's calibrated floor and the machine.
    async fn planning(&self, id: &str, model: &str) -> Option<(ModelFacts, PlanOptions, Hardware, Value)> {
        let (kind, p) = self.resolve(id)?;
        let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        let all = self.list_models(&kind, &base).await;
        let target = all.iter().find(|m| m.get("id") == Some(&json!(model)))?.clone();
        let d = self.detect(&kind, &base).await;
        let opts = PlanOptions {
            overhead_floor: Some(self.overhead_floor_for(&kind, d.version.as_ref())),
            siblings: all.iter().map(ModelFacts::from_value).collect(),
        };
        Some((ModelFacts::from_value(&target), opts, self.hardware().await, target))
    }

    pub async fn plan(&self, id: &str, model: &str, req: &Value) -> Value {
        let req = if req.is_null() { FitRequest::default() } else { FitRequest::from_value(req) };
        match self.planning(id, model).await {
            Some((facts, opts, hw, _)) => capacity::plan_fit(&facts, &req, &hw, &opts).to_value(),
            None => Value::Null,
        }
    }

    pub async fn auto_plan(&self, id: &str, model: &str, budget_fraction: &Value, parallel_slots: &Value) -> Value {
        match self.planning(id, model).await {
            Some((facts, options, hw, _)) => capacity::auto_fit(&AutoFitInput {
                facts: &facts,
                hardware: &hw,
                budget_fraction: nekko_js::to_number(Some(budget_fraction)),
                parallel_slots: (!parallel_slots.is_null()).then(|| nekko_js::to_number(Some(parallel_slots))),
                max_context_tokens: None,
                options,
            }),
            None => Value::Null,
        }
    }

    /// Where a load's bytes land (`runtime:place`), for the load drawer's meter.
    pub async fn place(&self, id: &str, model: &str, req: &Value) -> Value {
        match self.planning(id, model).await {
            Some((facts, _, hw, target)) => {
                let layers = facts.layers.unwrap_or(1.0);
                let resident = resident_vram(&target);
                crate::placement::place(&facts, &crate::placement::Request::from_value(req, layers), &hw, resident)
                    .to_value()
            }
            None => Value::Null,
        }
    }

    /// The fastest setup that fits, with a sentence per choice (`runtime:recommend`).
    /// `opts`: `{ goal: "speed" | "context" | "fill", request }`; `fill` keeps
    /// the request's context, precision and sessions.
    pub async fn recommend(&self, id: &str, model: &str, opts: &Value) -> Value {
        use crate::placement::{Goal, Request, recommend};
        match self.planning(id, model).await {
            Some((facts, _, hw, target)) => {
                let base = opts
                    .get("request")
                    .filter(|r| r.is_object())
                    .map(|r| Request::from_value(r, facts.layers.unwrap_or(1.0)));
                recommend(
                    &facts,
                    &hw,
                    resident_vram(&target),
                    Goal::parse(opts.get("goal").and_then(Value::as_str)),
                    base.as_ref(),
                )
            }
            None => Value::Null,
        }
    }

    pub async fn load(&self, id: &str, model: &str, params: &Value) -> Value {
        let found = self.resolve(id).filter(|(k, _)| k != "vllm");
        let Some((kind, p)) = found else {
            return json!({ "ok": false, "message": "This runtime loads its model at launch." });
        };
        let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        // The projection we are about to check ourselves against.
        let mut req = FitRequest::default();
        if nekko_js::truthy(params.get("contextTokens")) {
            req.context_tokens = nekko_js::to_number(params.get("contextTokens"));
        }
        if nekko_js::truthy(params.get("kvCacheDtype")) {
            req.kv_cache_dtype = nekko_js::display(&params["kvCacheDtype"]);
        }
        let projected =
            self.planning(id, model).await.map(|(facts, opts, hw, _)| capacity::plan_fit(&facts, &req, &hw, &opts));
        let Some(result) = self.adapter_load(&kind, &base, model, params).await else {
            return json!({ "ok": false, "message": "This runtime loads its model at launch." });
        };
        if !nekko_js::truthy(result.get("ok")) {
            return result;
        }
        // Reconcile what the runtime took against what we said it would.
        if let Some(projected) = projected
            && capabilities(&kind)["reportsPerModelVram"] == json!(true)
        {
            let after = self.adapter_status(&kind, &base).await;
            let measured = after
                .get("resident")
                .and_then(Value::as_array)
                .and_then(|r| r.iter().find(|x| x.get("id") == Some(&json!(model))).cloned());
            let d = self.detect(&kind, &base).await;
            if let Some(size) = measured.as_ref().and_then(|m| m.get("sizeBytes")).filter(|s| nekko_js::truthy(Some(s)))
            {
                self.record_measurement(
                    &kind,
                    d.version.as_ref(),
                    nekko_js::to_number(Some(size)),
                    projected.required,
                    projected.overhead,
                );
            }
        }
        result
    }

    pub async fn unload(&self, id: &str, model: &str) -> Value {
        let missing = json!({ "ok": false, "message": "This runtime cannot unload a single model." });
        let Some((kind, p)) = self.resolve(id) else { return missing };
        let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        self.adapter_unload(&kind, &base, model).await.unwrap_or(missing)
    }

    pub fn capabilities_of(&self, id: &str) -> Value {
        self.resolve(id).map_or(Value::Null, |(kind, _)| capabilities(&kind))
    }

    // ---- The Models page's own calls (host.ts, lms.ts, servers.ts) ----------

    /// Any configured provider, runtime or not (`findProvider`).
    fn provider(&self, id: &str) -> Option<Value> {
        let providers = (self.providers)();
        providers.as_array()?.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id)).cloned()
    }

    /// `OllamaProvider.base()`: the URL without a trailing `/v1`.
    fn ollama_base(p: &Value) -> String {
        let url = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        let t = url.strip_suffix('/').unwrap_or(&url);
        t.strip_suffix("/v1").map_or_else(|| url.clone(), str::to_string)
    }

    /// `model:pull`: Ollama only.
    pub async fn pull_model(&self, id: &str, model: &str) -> Value {
        let Some(p) = self.provider(id).filter(|p| p.get("kind") == Some(&json!("ollama"))) else {
            return json!({ "ok": false, "message": "Pull supported on Ollama only." });
        };
        let body = nekko_js::stringify(&json!({ "name": model, "stream": true }));
        match self.io.pull(format!("{}/api/pull", Self::ollama_base(&p)), body).await {
            Ok(()) => json!({ "ok": true, "message": format!("Pulled {model}") }),
            Err(e) => json!({ "ok": false, "message": e }),
        }
    }

    /// `OllamaProvider.setLoaded`: load (kept 30 minutes) or evict.
    async fn ollama_set_loaded(&self, p: &Value, model: &str, loaded: bool) -> Value {
        let keep = if loaded { json!("30m") } else { json!(0) };
        let body = nekko_js::stringify(&json!({ "model": model, "keep_alive": keep, "prompt": "" }));
        match self.io.fetch("POST", format!("{}/api/generate", Self::ollama_base(p)), Some(body), None).await {
            Some(r) if r.ok() => json!({ "ok": true }),
            Some(r) => json!({ "ok": false, "message": format!("Ollama refused (HTTP {}).", r.status) }),
            None => json!({ "ok": false, "message": "Ollama did not respond." }),
        }
    }

    /// `lms.ts` `run`: exit status and the ANSI-stripped, trimmed, non-empty lines.
    async fn lms_lines(&self, args: &[&str], timeout_ms: u64) -> (bool, Vec<String>) {
        let (exit0, text) = self
            .io
            .exec(lms_bin(), args.iter().map(|s| s.to_string()).collect(), Duration::from_millis(timeout_ms))
            .await;
        let stripped = regex_replace_all(regex!("\u{1b}\\[[0-9;]*m", ""), &text, "").replace('\r', "");
        let lines = stripped.split('\n').map(nekko_js::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
        (exit0, lines)
    }

    /// `lms.ts` `result`: `lms` sometimes exits 0 on failure, so read the output too.
    fn lms_result(lines: &[String], exit0: bool, ok: String, fail: String) -> Value {
        if exit0 && !lms_failure(&lines.join(" ")) {
            return json!({ "ok": true, "message": ok });
        }
        let msg = nekko_js::slice16(&lines.iter().take(2).cloned().collect::<Vec<_>>().join(". "), 240).to_string();
        json!({ "ok": false, "message": if msg.is_empty() { fail } else { msg } })
    }

    const LMS_PROBE_REMOTE: &'static str = "Per-model load/unload needs the lms CLI on the machine running LM Studio. This server looks remote, use Stop server instead.";

    /// `model:load`.
    pub async fn load_model(&self, id: &str, model: &str) -> Value {
        let p = self.provider(id);
        let kind = p.as_ref().and_then(|p| p.get("kind")).and_then(Value::as_str).unwrap_or_default().to_string();
        match (kind.as_str(), &p) {
            ("ollama", Some(p)) => self.ollama_set_loaded(p, model, true).await,
            // LM Studio has no HTTP load; its `lms` CLI drives a local instance.
            ("lmstudio", Some(p)) => {
                let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
                if !is_localhost_url(&base) {
                    return json!({ "ok": false, "message": Self::LMS_PROBE_REMOTE });
                }
                let (exit0, lines) = self.lms_lines(&["load", model, "-y"], 180_000).await;
                Self::lms_result(&lines, exit0, format!("Loaded {model}"), format!("Couldn't load {model}."))
            }
            (k, Some(_)) if KINDS.contains(&k) => self.load(id, model, &json!({})).await,
            _ => json!({ "ok": true }),
        }
    }

    /// `model:unload`.
    pub async fn unload_model(&self, id: &str, model: &str) -> Value {
        let p = self.provider(id);
        let kind = p.as_ref().and_then(|p| p.get("kind")).and_then(Value::as_str).unwrap_or_default().to_string();
        match (kind.as_str(), &p) {
            ("ollama", Some(p)) => self.ollama_set_loaded(p, model, false).await,
            ("lmstudio", Some(p)) => {
                let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
                if !is_localhost_url(&base) {
                    return json!({ "ok": false, "message": Self::LMS_PROBE_REMOTE });
                }
                let (exit0, lines) = self.lms_lines(&["unload", model], 15_000).await;
                Self::lms_result(&lines, exit0, format!("Unloaded {model}"), format!("Couldn't unload {model}."))
            }
            (k, Some(_)) if KINDS.contains(&k) => self.unload(id, model).await,
            _ => json!({ "ok": true }),
        }
    }

    /// `lms:probe`: whether per-model load/unload works for this LM Studio.
    pub async fn lms_probe(&self, id: &str) -> Value {
        let Some(p) = self.provider(id).filter(|p| p.get("kind") == Some(&json!("lmstudio"))) else {
            return json!({ "available": false });
        };
        let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
        if !is_localhost_url(&base) {
            return json!({ "available": false, "reason": Self::LMS_PROBE_REMOTE });
        }
        let cached = { *lock(&self.lms_version) };
        let ok = match cached {
            Some((at, ok)) if at.elapsed() < Duration::from_secs(15) => ok,
            _ => {
                let (exit0, _) = self.lms_lines(&["version"], 4_000).await;
                *lock(&self.lms_version) = Some((Instant::now(), exit0));
                exit0
            }
        };
        if ok {
            json!({ "available": true })
        } else {
            json!({ "available": false, "reason": "LM Studio's lms CLI wasn't found. Run `lms bootstrap` (or reinstall LM Studio) to enable per-model load/unload." })
        }
    }

    /// `server:stop`: end a local model server by its port.
    pub async fn stop_server(&self, id: &str) -> Value {
        let Some(p) = self.provider(id) else { return json!({ "ok": false, "message": "Provider not found." }) };
        let kind = p.get("kind").and_then(Value::as_str).unwrap_or_default();
        if !KINDS.contains(&kind) {
            return json!({ "ok": false, "message": "Only local model servers can be stopped from here." });
        }
        stop_local_server(&*self.io, &p.get("baseUrl").map(nekko_js::display).unwrap_or_default()).await
    }
}

/// Every match replaced (a `g` pattern).
fn regex_replace_all(r: &Regex, s: &str, with: &str) -> String {
    let mut out = String::new();
    let mut at = 0;
    for m in r.find_iter(s) {
        out.push_str(&s[at..m.range().start]);
        out.push_str(with);
        at = m.range().end;
    }
    out.push_str(&s[at..]);
    out
}

/// `stopLocalServer`: end whatever listens on the URL's port, process tree and all.
pub async fn stop_local_server(io: &dyn RuntimeIo, base: &str) -> Value {
    let port = match url::Url::parse(base) {
        Ok(u) => Some(u.port().unwrap_or(if u.scheme() == "https" { 443 } else { 80 })),
        Err(_) => {
            regex!(r":(\d{2,5})(?:\D|$)", "").find(base).and_then(|m| m.group(1)).and_then(|g| base[g].parse().ok())
        }
    };
    let Some(port) = port else {
        return json!({ "ok": false, "message": "Could not work out the server port from its URL." });
    };
    let pids = pids_on_port(io, port).await;
    if pids.is_empty() {
        return json!({ "ok": false, "message": format!("Nothing is listening on port {port}; it may already be stopped.") });
    }
    let mut killed = 0;
    for pid in pids {
        if kill_tree(io, pid).await {
            killed += 1;
        }
    }
    if killed > 0 {
        json!({ "ok": true, "message": format!("Stopped the server on port {port}.") })
    } else {
        json!({ "ok": false, "message": format!("Couldn't stop the process on port {port} (it may need elevated permissions).") })
    }
}

async fn pids_on_port(io: &dyn RuntimeIo, port: u16) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    if cfg!(windows) {
        let Some(text) =
            io.run("netstat".into(), vec!["-ano".into(), "-p".into(), "tcp".into()], Duration::from_secs(5)).await
        else {
            return out;
        };
        for line in text.split('\n') {
            if regex!("LISTENING", "i").find(line).is_none() {
                continue;
            }
            let cols: Vec<&str> = nekko_js::trim(line).split_whitespace().collect();
            if cols.get(1).is_some_and(|l| l.ends_with(&format!(":{port}")))
                && let Some(pid) = cols.last().and_then(|p| p.parse::<u32>().ok()).filter(|p| *p > 0)
                && !out.contains(&pid)
            {
                out.push(pid);
            }
        }
        return out;
    }
    let args = vec!["-nP".into(), format!("-iTCP:{port}"), "-sTCP:LISTEN".into(), "-t".into()];
    let Some(text) = io.run("lsof".into(), args, Duration::from_secs(5)).await else { return out };
    for pid in text.split('\n').filter_map(|s| nekko_js::trim(s).parse::<u32>().ok()).filter(|p| *p > 0) {
        if !out.contains(&pid) {
            out.push(pid);
        }
    }
    out
}

async fn kill_tree(io: &dyn RuntimeIo, pid: u32) -> bool {
    if cfg!(windows) {
        return io
            .run(
                "taskkill".into(),
                vec!["/PID".into(), pid.to_string(), "/T".into(), "/F".into()],
                Duration::from_secs(5),
            )
            .await
            .is_some();
    }
    #[cfg(unix)]
    {
        // SAFETY: kill(2) with a pid and a signal number.
        if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
            return false;
        }
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            // SAFETY: as above; an already-gone process just fails.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        });
        true
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// The real servers and CLIs.
pub struct SystemIo(pub reqwest::Client);

impl RuntimeIo for SystemIo {
    fn fetch(
        &self,
        method: &'static str,
        url: String,
        body: Option<String>,
        timeout: Option<Duration>,
    ) -> BoxFuture<Option<Reply>> {
        let client = self.0.clone();
        Box::pin(async move {
            let mut req = if method == "POST" { client.post(url) } else { client.get(url) };
            if let Some(b) = body {
                req = req.header("content-type", "application/json").body(b);
            }
            if let Some(t) = timeout {
                req = req.timeout(t);
            }
            let res = req.send().await.ok()?;
            let status = res.status().as_u16();
            let body = res.text().await.ok()?;
            Some(Reply { status, body })
        })
    }

    fn run(&self, cmd: String, args: Vec<String>, timeout: Duration) -> BoxFuture<Option<String>> {
        Box::pin(async move {
            let mut c = tokio::process::Command::new(resolve_program(&cmd));
            c.args(&args).stdin(std::process::Stdio::null()).kill_on_drop(true);
            #[cfg(windows)]
            c.creation_flags(0x0800_0000);
            let out = tokio::time::timeout(timeout, c.output()).await;
            match out {
                Ok(Ok(o)) => {
                    let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
                    (o.status.success() || !text.is_empty()).then_some(text)
                }
                _ => None,
            }
        })
    }

    fn exec(&self, cmd: String, args: Vec<String>, timeout: Duration) -> BoxFuture<(bool, String)> {
        Box::pin(async move {
            let mut c = tokio::process::Command::new(resolve_program(&cmd));
            c.args(&args).stdin(std::process::Stdio::null()).kill_on_drop(true);
            #[cfg(windows)]
            c.creation_flags(0x0800_0000);
            match tokio::time::timeout(timeout, c.output()).await {
                Ok(Ok(o)) => (
                    o.status.success(),
                    format!(
                        "{}
{}",
                        String::from_utf8_lossy(&o.stdout),
                        String::from_utf8_lossy(&o.stderr)
                    ),
                ),
                _ => (false, String::new()),
            }
        })
    }

    fn pull(&self, url: String, body: String) -> BoxFuture<Result<(), String>> {
        let client = self.0.clone();
        Box::pin(async move {
            // `fetch` with a string body sends it as text.
            let mut res = client
                .post(url)
                .header("content-type", "text/plain;charset=UTF-8")
                .body(body)
                .send()
                .await
                .map_err(|_| "fetch failed".to_string())?;
            if !res.status().is_success() {
                return Err(format!("pull {}", res.status().as_u16()));
            }
            let idle = stream_idle_ms();
            loop {
                let next = res.chunk();
                let chunk = if idle > 0 {
                    tokio::time::timeout(Duration::from_millis(idle), next).await.map_err(|_| {
                        format!(
                            "The model stopped sending after {} s of silence.",
                            nekko_js::number_to_string(js_round(idle as f64 / 1000.0))
                        )
                    })?
                } else {
                    next.await
                };
                match chunk {
                    Ok(Some(_)) => {}
                    Ok(None) => return Ok(()),
                    Err(e) => return Err(e.to_string()),
                }
            }
        })
    }
}

/// `streamIdleMs`: five minutes, or `NEKKO_STREAM_IDLE_MS` (0 disables).
fn stream_idle_ms() -> u64 {
    std::env::var("NEKKO_STREAM_IDLE_MS")
        .ok()
        .map(|v| nekko_js::string_to_number(&v))
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map_or(300_000, |n| n as u64)
}

/// Where a bare program name runs from, found the way Node's `execFile` (libuv)
/// finds it: each `PATH` entry split on the separator with quotes dropped,
/// trying the name, then `.com` and `.exe` on Windows. Rust's own lookup reads
/// a stray quote in `PATH` as opening one long entry and then finds nothing
/// after it, which Node never does. Unchanged when nothing is found, so the
/// spawn reports its own error.
pub fn resolve_program(name: &str) -> PathBuf {
    let as_is = PathBuf::from(name);
    if name.contains(['/', '\\']) {
        return as_is;
    }
    let Some(path) = std::env::var_os("PATH") else { return as_is };
    let path = path.to_string_lossy().into_owned();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exts: &[&str] = if cfg!(windows) { &["", ".com", ".exe"] } else { &[""] };
    for dir in path.split(sep).map(|d| d.replace('"', "")).filter(|d| !d.is_empty()) {
        for ext in exts {
            let candidate = PathBuf::from(&dir).join(format!("{name}{ext}"));
            if std::fs::metadata(&candidate).is_ok_and(|m| m.is_file()) {
                return candidate;
            }
        }
    }
    as_is
}

/// VRAM a resident model already holds: a reload gets it back.
fn resident_vram(target: &Value) -> f64 {
    if target.get("loaded") != Some(&Value::Bool(true)) {
        return 0.0;
    }
    target.get("vramBytes").and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0)
}
