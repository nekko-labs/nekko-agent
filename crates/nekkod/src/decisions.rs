//! The decision-model service (`decisions:*`), served from the daemon: the
//! catalog, the installed and user-added Laya exports, loading them into the
//! daemon's own decide service, and TypeSafe's hosted Jev over HTTPS. The
//! catalog and its release URL live in `decision-catalog.json` beside this
//! file. `tests/golden/decisions.json` is a frozen record of the deleted TS
//! service's replies; edit it by hand per docs/runbooks/golden-fixtures.md.
//! The user's export folders are saved through the daemon's settings store.

use nekko_infer::BoxFuture;
use nekko_tools::path::native as path;
use serde_json::{Map, Value, json};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub const CHANNELS: &[&str] = &[
    "decisions:catalog",
    "decisions:models",
    "decisions:download",
    "decisions:delete",
    "decisions:addFolder",
    "decisions:status",
    "decisions:load",
    "decisions:unload",
    "decisions:run",
    "decisions:checkTypesafe",
];

pub const TYPESAFE_URL: &str = "https://api.typesafe.ai/v1";
const PRECISIONS: [&str; 3] = ["fp16", "int8", "fp32"];

fn model_files(precision: &str) -> &'static [&'static str] {
    match precision {
        "fp16" => &["model_fp16.onnx", "model.fp16.onnx", "laya.fp16.onnx"],
        "fp32" => &["model.onnx", "laya.onnx"],
        _ => &["model_int8.onnx", "model.int8.onnx", "laya.int8.onnx"],
    }
}

/// `decision-catalog.json`, parsed once.
fn source() -> &'static Value {
    static S: OnceLock<Value> = OnceLock::new();
    S.get_or_init(|| {
        serde_json::from_str(include_str!("decision-catalog.json")).expect("decision-catalog.json is valid JSON")
    })
}

/// The models the app offers to download (`decision-catalog.json`'s `catalog`).
pub fn catalog() -> &'static Value {
    source().get("catalog").expect("decision-catalog.json has a catalog")
}

/// The local decision model: the daemon's decide service (a stand-in in tests).
pub trait LocalModel: Send + Sync {
    fn status(&self) -> BoxFuture<Value>;
    fn load(&self, request: Value) -> BoxFuture<Result<Value, String>>;
    fn unload(&self) -> BoxFuture<()>;
    fn run(&self, request: Value) -> BoxFuture<Result<Value, String>>;
}

impl LocalModel for Arc<crate::decide::DecideService> {
    fn status(&self) -> BoxFuture<Value> {
        let s = crate::decide::DecideService::status(self);
        Box::pin(async move { s })
    }
    fn load(&self, request: Value) -> BoxFuture<Result<Value, String>> {
        let me = self.clone();
        Box::pin(async move { crate::decide::DecideService::load(&me, &[request]).await })
    }
    fn unload(&self) -> BoxFuture<()> {
        crate::decide::DecideService::unload(self);
        Box::pin(async {})
    }
    fn run(&self, request: Value) -> BoxFuture<Result<Value, String>> {
        let me = self.clone();
        Box::pin(async move { crate::decide::DecideService::run(&me, request).await.map_err(|(_, m)| m) })
    }
}

/// The settings the service reads, and the one write it makes.
pub trait Prefs: Send + Sync {
    fn get(&self) -> BoxFuture<Value>;
    fn save_folders(&self, dirs: Vec<String>) -> BoxFuture<Result<(), String>>;
}

/// The daemon's settings store, through `crate::settings`.
pub struct CtxPrefs(pub crate::routes::Ctx);

impl Prefs for CtxPrefs {
    fn get(&self) -> BoxFuture<Value> {
        let ctx = self.0.clone();
        Box::pin(async move { crate::settings::current(&ctx).await })
    }
    fn save_folders(&self, dirs: Vec<String>) -> BoxFuture<Result<(), String>> {
        let ctx = self.0.clone();
        Box::pin(async move { crate::settings::update(&ctx, json!({ "decisionModelDirs": dirs })).await.map(|_| ()) })
    }
}

fn ok(ok: bool, message: impl Into<String>) -> Value {
    json!({ "ok": ok, "message": message.into() })
}

/// `Number.prototype.toFixed` for the small, non-negative values shown here:
/// the exact decimal value rounded half up (Rust's own rounding ties to even).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return nekko_js::number_to_string(x);
    }
    let negative = x < 0.0;
    // Enough digits to print the double exactly, so ties are real ties.
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_vec: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_vec[i] == 9 {
                digits_vec[i] = 0;
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let s: String = digits_vec.iter().map(|d| char::from(b'0' + d)).collect();
    let (i, f) = s.split_at(s.len() - digits);
    let body = if digits == 0 { i.to_string() } else { format!("{i}.{f}") };
    if negative && body.chars().any(|c| c != '0' && c != '.') { format!("-{body}") } else { body }
}

/// Where the catalog's files are fetched from (`decision-catalog.json`'s
/// `releaseUrl`).
pub fn release_url() -> String {
    source().get("releaseUrl").and_then(Value::as_str).expect("decision-catalog.json has a releaseUrl").to_string()
}

/// One file of a catalog model to fetch (the TS `DownloadRequest` it starts).
#[derive(Clone, Debug)]
pub struct Download {
    pub id: String,
    pub label: String,
    pub target: String,
    pub url: String,
    pub dest: String,
    pub group: String,
    pub group_label: String,
    pub file: String,
    /// The published size and SHA-256 the bytes must have.
    pub bytes: u64,
    pub sha256: Option<String>,
}

impl Download {
    /// The request as the TS service hands it to the queue (minus `verify`).
    pub fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "kind": "model",
            "label": self.label,
            "target": self.target,
            "url": self.url,
            "dest": self.dest,
            "group": self.group,
            "groupLabel": self.group_label,
            "file": self.file,
        })
    }
}

/// The bytes at `path` are the published file's: its size, then its SHA-256,
/// streamed. `None` when they are (`checkDecisionFile`).
pub async fn check_file(path: &str, file: &str, bytes: u64, sha256: Option<&str>) -> Option<String> {
    if file_size(path).await != bytes {
        return Some(format!("{file} is not the published size."));
    }
    let want = sha256?.to_string();
    let path = path.to_string();
    let got = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
    })
    .await;
    match got {
        Ok(Ok(h)) if h == want => None,
        _ => Some(format!("{file} is not the published file (checksum mismatch).")),
    }
}

/// The download queue the catalog's files go through (the daemon's, scripted in tests).
pub trait Queue: Send + Sync {
    fn start(&self, download: Download);
}

impl Queue for nekko_engine::download::Downloads {
    fn start(&self, d: Download) {
        let mut req = nekko_engine::download::Request::from_value(&d.to_value());
        let (file, bytes, sha) = (d.file.clone(), d.bytes, d.sha256.clone());
        req.verify = Some(Arc::new(move |part: String| {
            let (file, sha) = (file.clone(), sha.clone());
            Box::pin(async move { check_file(&part, &file, bytes, sha.as_deref()).await })
        }));
        nekko_engine::download::Downloads::start(self, req);
    }
}

pub struct Decisions {
    local: Arc<dyn LocalModel>,
    prefs: Arc<dyn Prefs>,
    /// The models directory when settings name none (`<data>/models`).
    default_models: String,
    typesafe_url: String,
    http: reqwest::Client,
    /// The daemon's download queue, when it has one.
    queue: Option<Arc<dyn Queue>>,
    /// Where the catalog's files are fetched from (`release_url()`; tests use a loopback server).
    release_url: String,
}

async fn file_size(p: &str) -> u64 {
    tokio::fs::metadata(p).await.ok().filter(|m| m.is_file()).map_or(0, |m| m.len())
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(nekko_js::display).collect()).unwrap_or_default()
}

impl Decisions {
    pub fn new(
        local: Arc<dyn LocalModel>,
        prefs: Arc<dyn Prefs>,
        default_models: String,
        typesafe_url: String,
    ) -> Self {
        static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
        let http = HTTP.get_or_init(reqwest::Client::new).clone();
        Self { local, prefs, default_models, typesafe_url, http, queue: None, release_url: release_url() }
    }

    /// Downloads go through `queue`, from `release_url`.
    pub fn with_downloads(mut self, queue: Arc<dyn Queue>, release_url: String) -> Self {
        self.queue = Some(queue);
        self.release_url = release_url;
        self
    }

    async fn models_dir(&self) -> String {
        let s = self.prefs.get().await;
        nekko_js::truthy_str(s.get("modelsDir")).map(str::to_string).unwrap_or_else(|| self.default_models.clone())
    }

    fn root(models_dir: &str) -> String {
        path::join(&[models_dir, "decision"])
    }

    async fn folders(&self) -> Vec<String> {
        str_list(self.prefs.get().await.get("decisionModelDirs"))
    }

    async fn typesafe_key(&self) -> Option<String> {
        let s = self.prefs.get().await;
        nekko_js::truthy_str(s.get("typesafeApiKey"))
            .map(str::to_string)
            .or_else(|| std::env::var("TYPESAFE_API_KEY").ok().filter(|k| !k.is_empty()))
    }

    /// Ids come from the renderer: never let one name a path outside the folder.
    fn dir_of(root: &str, id: &str) -> Result<String, String> {
        let dir = path::resolve(&[root, id]);
        let sep = if cfg!(windows) { "\\" } else { "/" };
        if !dir.starts_with(&format!("{}{sep}", path::resolve(&[root]))) {
            return Err("That is not a decision model id.".into());
        }
        Ok(dir)
    }

    /// A model dir's precisions and size, or `None` when it is not a complete export.
    async fn inspect(dir: &str) -> Option<(Vec<&'static str>, u64)> {
        let tokenizer = match file_size(&path::join(&[dir, "tokenizer.json"])).await {
            0 => file_size(&path::join(&[dir, "tokenizer", "tokenizer.json"])).await,
            n => n,
        };
        if file_size(&path::join(&[dir, "rl_agent_config.json"])).await == 0 || tokenizer == 0 {
            return None;
        }
        let mut precisions = Vec::new();
        let mut size_bytes = 0;
        for p in PRECISIONS {
            for f in model_files(p) {
                let graph = file_size(&path::join(&[dir, f])).await;
                // An external-data export keeps its weights beside the graph.
                let size = graph + file_size(&path::join(&[dir, &format!("{f}.data")])).await;
                if size > 0 && graph > 0 {
                    precisions.push(p);
                    size_bytes += size;
                    break;
                }
            }
        }
        (!precisions.is_empty()).then_some((precisions, size_bytes))
    }

    pub async fn models(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for dir in self.folders().await {
            if let Some((precisions, size)) = Self::inspect(&dir).await {
                let resolved = path::resolve(&[&dir]);
                let last = dir.split(['\\', '/']).rfind(|s| !s.is_empty()).unwrap_or_default().to_string();
                out.push(json!({
                    "id": format!("folder:{resolved}"),
                    "name": format!("Laya · {last}"),
                    "dir": resolved,
                    "precisions": precisions,
                    "sizeBytes": size,
                    "external": true,
                }));
            }
        }
        let root = Self::root(&self.models_dir().await);
        let mut names: Vec<String> = match std::fs::read_dir(&root) {
            Ok(rd) => rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => Vec::new(),
        };
        // Node lists a directory in the file system's order; sorted is the
        // same on Windows and stable everywhere else.
        names.sort();
        for id in names {
            let dir = path::join(&[&root, &id]);
            if file_size(&path::join(&[&dir, "rl_agent_config.json"])).await == 0
                || file_size(&path::join(&[&dir, "tokenizer.json"])).await == 0
            {
                continue;
            }
            let mut precisions = Vec::new();
            let mut size_bytes = 0;
            for p in PRECISIONS {
                for f in model_files(p) {
                    let size = file_size(&path::join(&[&dir, f])).await;
                    if size > 0 {
                        precisions.push(p);
                        size_bytes += size;
                        break;
                    }
                }
            }
            if precisions.is_empty() {
                continue;
            }
            let entry = catalog().as_array().and_then(|c| c.iter().find(|e| e["id"] == json!(id)));
            let mut o = Map::new();
            o.insert("id".into(), json!(id));
            o.insert("name".into(), entry.map_or_else(|| json!(id), |e| e["name"].clone()));
            o.insert("dir".into(), json!(dir));
            o.insert("precisions".into(), json!(precisions));
            o.insert("sizeBytes".into(), json!(size_bytes));
            if let Some(e) = entry {
                o.insert("catalogId".into(), e["id"].clone());
            }
            out.push(Value::Object(o));
        }
        out
    }

    /// Fetch one precision of a catalog model, plus its tokenizer and config,
    /// through the daemon's download queue as one group. Each file is checked
    /// against its published size and SHA-256 before it is renamed into
    /// place; a file already on disk at the published size is kept.
    async fn download(&self, catalog_id: &Value, precision: Option<&Value>) -> Result<Value, String> {
        let precision = match precision {
            None => json!("fp16"),
            Some(p) => p.clone(),
        };
        let entry = catalog().as_array().and_then(|c| c.iter().find(|e| &e["id"] == catalog_id));
        let variant = entry.and_then(|e| e["variants"].as_array()?.iter().find(|v| v["precision"] == precision));
        let (Some(entry), Some(variant)) = (entry, variant) else {
            return Ok(ok(false, "That decision model is not in the catalog."));
        };
        if let Some(why) = entry.get("unavailable").and_then(Value::as_str) {
            return Ok(ok(false, why));
        }
        let Some(queue) = &self.queue else {
            return Ok(ok(false, "Downloads are not available in this engine."));
        };
        let id = nekko_js::display(&entry["id"]);
        let name = nekko_js::display(&entry["name"]);
        let p = nekko_js::display(&precision);
        let dir = Self::dir_of(&Self::root(&self.models_dir().await), &id)?;
        let mut files: Vec<&Value> = entry["shared"].as_array().map(|s| s.iter().collect()).unwrap_or_default();
        files.push(variant);
        let (mut queued, mut bytes) = (0u32, 0f64);
        for f in files {
            let file = nekko_js::display(&f["file"]);
            let size = f["bytes"].as_u64().unwrap_or(0);
            let dest = path::join(&[&dir, &file]);
            if file_size(&dest).await == size {
                continue;
            }
            let asset = f.get("asset").and_then(Value::as_str).map_or_else(|| file.clone(), str::to_string);
            let role = if std::ptr::eq(f, variant) { p.clone() } else { "shared".into() };
            queue.start(Download {
                id: format!("decision:{id}:{role}:{file}"),
                label: format!("{name} · {file}"),
                target: id.clone(),
                url: format!("{}/{asset}", self.release_url),
                dest,
                group: format!("decision:{id}:{p}"),
                group_label: format!("{name} · {p}"),
                file: file.clone(),
                bytes: size,
                sha256: f.get("sha256").and_then(Value::as_str).map(str::to_string),
            });
            queued += 1;
            bytes += size as f64;
        }
        Ok(if queued > 0 {
            ok(true, format!("Downloading {name} {p} ({} GB).", to_fixed(bytes / 1e9, 2)))
        } else {
            ok(true, format!("{name} {p} is already downloaded."))
        })
    }

    /// Point at an export folder the user made or copied; it is read in place, never moved.
    async fn add_folder(&self, raw: &Value) -> Result<Value, String> {
        let text = match raw {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            _ => return Err("path?.trim is not a function".into()),
        };
        let dir = path::resolve(&[nekko_js::trim(&text)]);
        if nekko_js::trim(&text).is_empty() {
            return Ok(ok(false, "Enter the folder that holds the export."));
        }
        let Some((precisions, _)) = Self::inspect(&dir).await else {
            return Ok(ok(
                false,
                format!(
                    "{dir} has no complete export: it needs an ONNX model file, tokenizer.json and rl_agent_config.json."
                ),
            ));
        };
        let dirs = self.folders().await;
        if !dirs.iter().any(|d| path::resolve(&[d]) == dir) {
            let mut next = dirs;
            next.push(dir.clone());
            self.prefs.save_folders(next).await?;
        }
        Ok(ok(true, format!("Added {dir} ({}).", precisions.join(", "))))
    }

    /// Unload the model first when it is the one loaded from `dir`.
    async fn unload_if_loaded(&self, dir: &str) {
        let loaded = self.local.status().await;
        if nekko_js::truthy(loaded.get("loaded"))
            && nekko_js::truthy(loaded.get("dir"))
            && path::resolve(&[&nekko_js::display(&loaded["dir"])]) == dir
        {
            self.local.unload().await;
        }
    }

    async fn remove(&self, id: &str) -> Result<Value, String> {
        if let Some(dir) = id.strip_prefix("folder:") {
            self.unload_if_loaded(dir).await;
            let keep: Vec<String> = self.folders().await.into_iter().filter(|d| path::resolve(&[d]) != dir).collect();
            self.prefs.save_folders(keep).await?;
            return Ok(ok(true, "Removed the folder from the list. Its files were not touched."));
        }
        let dir = Self::dir_of(&Self::root(&self.models_dir().await), id)?;
        self.unload_if_loaded(&dir).await;
        match tokio::fs::remove_dir_all(&dir).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        Ok(ok(true, "Deleted the decision model."))
    }

    async fn status(&self) -> Value {
        let configured = self.typesafe_key().await.is_some();
        let s = self.local.status().await;
        let mut local = Map::new();
        local.insert("available".into(), json!(true));
        local.insert("loaded".into(), json!(nekko_js::truthy(s.get("loaded"))));
        for (key, from) in [
            ("model", "model"),
            ("dir", "dir"),
            ("ep", "ep"),
            ("precision", "precision"),
            ("loadMs", "loadMs"),
            ("reason", "error"),
        ] {
            if let Some(v) = s.get(from) {
                local.insert(key.into(), v.clone());
            }
        }
        json!({ "local": local, "typesafe": { "configured": configured } })
    }

    async fn load(&self, id: &Value, precision: Option<&Value>) -> Value {
        let models = self.models().await;
        let Some(model) = models.iter().find(|m| &m["id"] == id) else {
            return ok(false, "That decision model is not downloaded.");
        };
        let default = model["precisions"][0].clone();
        let precision = precision.filter(|p| !p.is_null()).cloned();
        let chosen = precision.clone().unwrap_or_else(|| default.clone());
        let name = if model.get("external") == Some(&json!(true)) { json!("laya") } else { model["id"].clone() };
        match self.local.load(json!({ "dir": model["dir"], "precision": chosen, "name": name })).await {
            Ok(s) => {
                let shown = s.get("precision").filter(|p| !p.is_null()).cloned().unwrap_or(chosen);
                let ep = s.get("ep").filter(|e| !e.is_null()).map_or_else(|| "the CPU".to_string(), nekko_js::display);
                let took = if nekko_js::truthy(s.get("loadMs")) {
                    format!(" in {} s", to_fixed(nekko_js::to_number(s.get("loadMs")) / 1000.0, 1))
                } else {
                    String::new()
                };
                ok(
                    true,
                    format!(
                        "Loaded {} ({}) on {ep}{took}.",
                        nekko_js::display(&model["name"]),
                        nekko_js::display(&shown)
                    ),
                )
            }
            Err(e) => ok(false, e),
        }
    }

    async fn run(&self, provider: &Value, request: &Value) -> Result<Value, String> {
        if let Some(problem) = nekko_turn::decide::check_decision_request(request) {
            return Err(problem);
        }
        let started = Instant::now();
        let elapsed = |started: Instant| json!(started.elapsed().as_millis() as u64);
        if provider == "local" {
            let res = self.local.run(request.clone()).await?;
            let mut o = match res {
                Value::Object(o) => o,
                _ => Map::new(),
            };
            o.insert("provider".into(), json!("local"));
            o.insert("latencyMs".into(), elapsed(started));
            return Ok(Value::Object(o));
        }
        let key = self.typesafe_key().await.ok_or("Add a TypeSafe API key to use Jev.")?;
        let mut body = match request {
            Value::Object(o) => o.clone(),
            _ => Map::new(),
        };
        let model = if nekko_js::truthy(body.get("model")) { body["model"].clone() } else { json!("jev-latest") };
        body.insert("model".into(), model);
        let req = self
            .http
            .post(format!("{}/systemone", self.typesafe_url))
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .body(nekko_js::stringify(&Value::Object(body)))
            .timeout(Duration::from_secs(60));
        let res = nekko_net::send("decide", req)
            .await
            .map_err(|e| if e.is_blocked() { e.to_string() } else { "fetch failed".to_string() })?;
        let status = res.status();
        let text = res.text().await.map_err(|e| e.to_string())?;
        let parsed: Value =
            if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) };
        if !status.is_success() {
            let message = parsed.get("error");
            let shown = match message {
                Some(Value::String(s)) => s.clone(),
                Some(m) => match m.get("message") {
                    Some(v) if !v.is_null() => nekko_js::display(v),
                    _ => nekko_js::slice16(&text, 200).to_string(),
                },
                None => nekko_js::slice16(&text, 200).to_string(),
            };
            return Err(format!("TypeSafe answered {}: {shown}", status.as_u16()));
        }
        let mut o = match parsed {
            Value::Object(o) => o,
            _ => Map::new(),
        };
        o.insert("provider".into(), json!("typesafe"));
        o.insert("latencyMs".into(), elapsed(started));
        Ok(Value::Object(o))
    }

    /// A key check that costs nothing: TypeSafe's model list.
    async fn check_typesafe(&self) -> Value {
        let Some(key) = self.typesafe_key().await else { return ok(false, "No TypeSafe API key is set.") };
        let req = self
            .http
            .get(format!("{}/models", self.typesafe_url))
            .header("Authorization", format!("Bearer {key}"))
            .timeout(Duration::from_secs(15));
        let res = match nekko_net::send("decide", req).await {
            Ok(r) => r,
            Err(e) if e.is_blocked() => return ok(false, e.to_string()),
            Err(_) => return ok(false, "Could not reach TypeSafe: fetch failed"),
        };
        let status = res.status().as_u16();
        if status == 401 || status == 403 {
            return ok(false, "TypeSafe rejected the key.");
        }
        if !res.status().is_success() {
            return ok(false, format!("TypeSafe answered {status}."));
        }
        let body: Value = res.json().await.unwrap_or(Value::Null);
        let ids: Vec<String> = body
            .get("data")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|m| m.get("id").map(nekko_js::display).unwrap_or_default()).collect())
            .unwrap_or_default();
        if ids.is_empty() {
            ok(true, "Key works.")
        } else {
            ok(true, format!("Key works. Models: {}.", ids.join(", ")))
        }
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        match channel {
            "decisions:catalog" => Ok(catalog().clone()),
            "decisions:models" => Ok(Value::Array(self.models().await)),
            "decisions:download" => self.download(arg(0), args.get(1).filter(|p| !p.is_null())).await,
            "decisions:delete" => self.remove(&nekko_js::display(arg(0))).await,
            "decisions:addFolder" => self.add_folder(arg(0)).await,
            "decisions:status" => Ok(self.status().await),
            "decisions:load" => Ok(self.load(arg(0), args.get(1)).await),
            "decisions:unload" => {
                self.local.unload().await;
                Ok(ok(true, "Unloaded the decision model."))
            }
            "decisions:run" => self.run(arg(0), arg(1)).await,
            "decisions:checkTypesafe" => Ok(self.check_typesafe().await),
            other => Err(format!("{other} is not a decisions channel")),
        }
    }
}

/// Serve a `decisions:*` call for the daemon: its decide service, its settings.
pub async fn route(
    ctx: &crate::routes::Ctx,
    data_dir: &std::path::Path,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let default_models = path::join(&[&data_dir.to_string_lossy(), "models"]);
    let mut d = Decisions::new(
        Arc::new(ctx.engine.decide.clone()),
        Arc::new(CtxPrefs(ctx.clone())),
        default_models,
        TYPESAFE_URL.into(),
    );
    if let Some(downloads) = &ctx.downloads {
        // Where the release is: the config's `decisionModelsUrl` (tests serve one on loopback),
        // else the pinned GitHub release.
        let base = ctx.app.decision_models_url.clone().unwrap_or_else(release_url);
        d = d.with_downloads(Arc::new(downloads.queue()), base);
    }
    d.route(channel, args).await
}

#[cfg(test)]
#[path = "decisions_tests.rs"]
mod tests;
