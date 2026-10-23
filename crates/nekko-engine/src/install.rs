//! Getting a runtime onto the machine: one installed here before, one the
//! user already has (pointed at by hand, or on PATH), or a pinned
//! llama.cpp / stable-diffusion.cpp release downloaded after the user says
//! yes, unpacked with the archive tools the OS has. Ports of
//! `packages/host/src/engine/install.ts` and `vc-runtime.ts`, held to them by
//! `tests/golden/install.json`.

use crate::BoxFuture;
use crate::builds;
use crate::download::{After, Downloads, Request, Signal, Verify};
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const RECORD_FILE: &str = "engine.json";

/// How the installers reach GitHub and the machine (scripted in tests).
pub trait InstallIo: Send + Sync {
    /// A GET; `Err` is a request that threw. The answer's status and body.
    fn get(
        &self,
        url: String,
        headers: Vec<(String, String)>,
        timeout: Option<Duration>,
    ) -> BoxFuture<Result<(u16, Vec<u8>), String>>;
    /// `execFile`: stdout then stderr when it exited 0, else `None`.
    fn run(&self, cmd: String, args: Vec<String>, timeout_ms: u64) -> BoxFuture<Option<String>>;
}

/// The real network and processes.
pub struct SystemIo {
    pub client: reqwest::Client,
    /// Where GitHub's API is (`https://api.github.com`), for tests.
    pub github_api: Option<String>,
}

const GITHUB_API: &str = "https://api.github.com";

impl InstallIo for SystemIo {
    fn get(
        &self,
        url: String,
        headers: Vec<(String, String)>,
        timeout: Option<Duration>,
    ) -> BoxFuture<Result<(u16, Vec<u8>), String>> {
        let url = match (&self.github_api, url.strip_prefix(GITHUB_API)) {
            (Some(base), Some(rest)) => format!("{}{rest}", base.trim_end_matches('/')),
            _ => url,
        };
        let client = self.client.clone();
        Box::pin(async move {
            let mut req = client.get(url);
            for (k, v) in headers {
                req = req.header(k, v);
            }
            if let Some(t) = timeout {
                req = req.timeout(t);
            }
            let res = req.send().await.map_err(|_| "fetch failed".to_string())?;
            let status = res.status().as_u16();
            let body = res.bytes().await.map_err(|_| "terminated".to_string())?;
            Ok((status, body.to_vec()))
        })
    }

    fn run(&self, cmd: String, args: Vec<String>, timeout_ms: u64) -> BoxFuture<Option<String>> {
        Box::pin(async move {
            let mut c = tokio::process::Command::new(&cmd);
            c.args(&args).stdin(std::process::Stdio::null()).kill_on_drop(true);
            #[cfg(windows)]
            c.creation_flags(0x0800_0000);
            let out = tokio::time::timeout(Duration::from_millis(timeout_ms), c.output()).await.ok()?.ok()?;
            if !out.status.success() {
                return None;
            }
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            Some(text)
        })
    }
}

/// Where the Visual C++ runtime is looked for (`VcRuntimeOptions`).
#[derive(Clone, Debug, Default)]
pub struct VcOptions {
    /// Windows' own System32.
    pub system_dir: Option<String>,
    /// The app-local copies beside nekkod.
    pub runtime_dir: Option<String>,
}

/// The set `scripts/vc-runtime.mjs` stages (`VC_RUNTIME_DLLS`).
pub const VC_RUNTIME_DLLS: [&str; 7] = [
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
];

fn is_file(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

/// Copy the Visual C++ runtime in beside an engine binary when Windows lacks
/// it (`ensureVcRuntime`); the files copied.
pub fn ensure_vc_runtime(bin_dir: &str, platform: &str, opts: &VcOptions) -> Vec<String> {
    if platform != "win32" {
        return Vec::new();
    }
    let system = opts.system_dir.clone().unwrap_or_else(|| {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        path::join(&[&root, "System32"])
    });
    if ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"].iter().all(|d| is_file(&path::join(&[&system, d]))) {
        return Vec::new();
    }
    let Some(from) =
        opts.runtime_dir.clone().or_else(|| std::env::var("NEKKOD_RUNTIME_DIR").ok()).filter(|d| !d.is_empty())
    else {
        return Vec::new();
    };
    let mut copied = Vec::new();
    for dll in VC_RUNTIME_DLLS {
        let to = path::join(&[bin_dir, dll]);
        let src = path::join(&[&from, dll]);
        if is_file(&to) || !is_file(&src) {
            continue;
        }
        if std::fs::copy(&src, &to).is_ok() {
            copied.push(dll.to_string());
        }
    }
    copied
}

type GpuProbe = Arc<dyn Fn() -> BoxFuture<Option<Value>> + Send + Sync>;
type AdapterProbe = Arc<dyn Fn() -> BoxFuture<Vec<Value>> + Send + Sync>;
type BeforeReplace = Arc<dyn Fn() -> BoxFuture<()> + Send + Sync>;

/// One runtime's installer (`createEngineInstaller`).
pub struct Installer {
    /// `llama` or `diffusion`.
    pub runtime: &'static str,
    /// `<data>/engine` (or `<data>/engine/diffusion`).
    pub engine_dir: String,
    pub platform: String,
    pub arch: String,
    pub io: Arc<dyn InstallIo>,
    pub downloads: Downloads,
    pub gpu: GpuProbe,
    pub adapters: AdapterProbe,
    /// A `llama-server` the user chose by hand.
    pub external: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Called once a new build has downloaded, just before the old files go.
    pub before_replace: BeforeReplace,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub vc: VcOptions,
    cuda: Mutex<Option<Value>>,
}

struct Release {
    tag: String,
    assets: Vec<Asset>,
}

#[derive(Clone)]
struct Asset {
    name: String,
    url: String,
    size: Value,
    digest: Option<Value>,
}

fn version_of(out: &str) -> Option<String> {
    static B: OnceLock<Regex> = OnceLock::new();
    static V: OnceLock<Regex> = OnceLock::new();
    let b = B.get_or_init(|| Regex::new(r"b(\d{3,})").expect("a valid built-in pattern"));
    let v = V.get_or_init(|| Regex::with_flags(r"version[: ]+(\S+)", "i").expect("a valid built-in pattern"));
    if let Some(m) = b.find(out) {
        return Some(out[m.range()].to_string());
    }
    v.find(out).and_then(|m| m.group(1)).map(|g| out[g].to_string())
}

/// `sha256:<hex>` against a file (`verifyDigest`).
async fn verify_digest(file: String, digest: String) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::with_flags(r"^sha256:([a-f0-9]{64})$", "i").expect("a valid built-in pattern"));
    let Some(expected) = r.find(&digest).and_then(|m| m.group(1)).map(|g| digest[g].to_lowercase()) else {
        return Some("The release supplied an unsupported checksum.".into());
    };
    let actual = tokio::task::spawn_blocking(move || sha256_file(&file)).await.ok().flatten();
    (actual.as_deref() != Some(expected.as_str()))
        .then(|| "The downloaded runtime checksum does not match its release.".into())
}

/// A file's SHA-256, as lowercase hex.
pub fn sha256_file(file: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(file).ok()?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Some(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

impl Installer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        runtime: &'static str,
        engine_dir: String,
        platform: String,
        arch: String,
        io: Arc<dyn InstallIo>,
        downloads: Downloads,
        gpu: GpuProbe,
        adapters: AdapterProbe,
        external: Arc<dyn Fn() -> Option<String> + Send + Sync>,
        before_replace: BeforeReplace,
        now: Arc<dyn Fn() -> f64 + Send + Sync>,
        vc: VcOptions,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            engine_dir,
            platform,
            arch,
            io,
            downloads,
            gpu,
            adapters,
            external,
            before_replace,
            now,
            vc,
            cuda: Mutex::new(None),
        })
    }

    fn runtime_name(&self) -> &'static str {
        if self.runtime == "diffusion" { "stable-diffusion.cpp" } else { "llama.cpp" }
    }

    fn server_names(&self) -> [&'static str; 2] {
        if self.runtime == "diffusion" { ["sd-server", "sd-server.exe"] } else { ["llama-server", "llama-server.exe"] }
    }

    fn candidates(&self, gpu: Option<&Value>, adapters: &[Value], cuda: Option<&Value>) -> Vec<Value> {
        if self.runtime == "diffusion" {
            builds::diffusion_builds(&self.platform, &self.arch, gpu)
        } else {
            builds::builds_for(&self.platform, &self.arch, gpu, adapters, cuda)
        }
    }

    fn select_asset(&self, build: &Value, names: &[String]) -> Option<String> {
        if self.runtime == "diffusion" {
            builds::match_diffusion_asset(build, names)
        } else {
            builds::match_asset(build, names)
        }
    }

    fn select_companion(&self, build: &Value, asset: &str, names: &[String]) -> Option<String> {
        if self.runtime == "diffusion" {
            builds::match_diffusion_companion(build, names)
        } else {
            builds::match_companion(build, asset, names)
        }
    }

    /// Whether the NVIDIA cards can run the CUDA build, asked once; a failed
    /// reading is not kept (`cudaSupport`).
    async fn cuda_support(&self, gpu: Option<&Value>) -> Option<Value> {
        if self.runtime != "llama" || gpu.and_then(|g| g.get("source")).and_then(Value::as_str) != Some("nvidia-smi") {
            return None;
        }
        if let Some(c) = self.cuda.lock().unwrap().clone() {
            return Some(c);
        }
        let out =
            self.io.run("nvidia-smi".into(), builds::CUDA_QUERY.iter().map(|s| s.to_string()).collect(), 5000).await;
        let reading = builds::cuda_support_from(out.as_deref());
        if let Some(r) = &reading {
            *self.cuda.lock().unwrap() = Some(r.clone());
        }
        reading
    }

    fn record_path(&self) -> String {
        path::join(&[&self.engine_dir, RECORD_FILE])
    }

    fn read_record(&self) -> Option<Value> {
        let bytes = std::fs::read(self.record_path()).ok()?;
        serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok().map(nekko_js::js_order)
    }

    fn record_bin(record: &Value) -> Option<String> {
        record.get("binPath").and_then(Value::as_str).filter(|p| is_file(p)).map(str::to_string)
    }

    async fn probe_version(&self, bin: &str) -> Option<String> {
        let out = self.io.run(bin.to_string(), vec!["--version".into()], 8000).await?;
        version_of(&out)
    }

    async fn find_on_path(&self) -> Option<String> {
        let finder = if self.platform == "win32" { "where" } else { "which" };
        for name in self.server_names() {
            let out = self.io.run(finder.into(), vec![name.into()], 4000).await;
            let first = out
                .as_deref()
                .and_then(|o| o.split('\n').map(nekko_js::trim).find(|l| !l.is_empty()))
                .map(str::to_string);
            if let Some(first) = first
                && is_file(&first)
            {
                return Some(first);
            }
        }
        None
    }

    /// A managed Windows CUDA build without `cublas64_NN.dll` beside it.
    fn missing_gpu_runtime(&self, record: &Value) -> Option<Value> {
        if self.runtime != "llama"
            || self.platform != "win32"
            || record.get("backend").and_then(Value::as_str) != Some("cuda")
        {
            return None;
        }
        let bin = record.get("binPath").and_then(Value::as_str)?;
        let names: Vec<String> = std::fs::read_dir(path::dirname(bin))
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        static R: OnceLock<Regex> = OnceLock::new();
        let r = R.get_or_init(|| Regex::with_flags(r"^cublas64_\d+\.dll$", "i").expect("a valid built-in pattern"));
        if names.iter().any(|n| r.find(n).is_some()) {
            return None;
        }
        Some(json!({
            "message": "The NVIDIA engine is missing its GPU libraries, so models are running on the processor and replies will be very slow or never arrive. Repair it to use your graphics card.",
            "repairBuildId": record.get("buildId").cloned().unwrap_or(Value::Null),
        }))
    }

    /// What is usable now, and what we would install if asked (`detect`).
    pub async fn detect(&self) -> Value {
        let gpu = (self.gpu)().await;
        let adapters = (self.adapters)().await;
        let cuda = self.cuda_support(gpu.as_ref()).await;
        let available = self.candidates(gpu.as_ref(), &adapters, cuda.as_ref());
        let recommended = available.first().cloned();
        let tail = |m: &mut Map<String, Value>| {
            m.insert("available".into(), json!(available));
            if let Some(r) = &recommended {
                m.insert("recommended".into(), r.clone());
            }
        };

        if let Some(external) = (self.external)().filter(|e| !e.is_empty())
            && is_file(&external)
        {
            let mut m = Map::new();
            m.insert("binPath".into(), json!(external));
            m.insert("source".into(), json!("external"));
            if let Some(v) = self.probe_version(&external).await {
                m.insert("version".into(), json!(v));
            }
            tail(&mut m);
            return Value::Object(m);
        }

        if let Some(record) = self.read_record()
            && let Some(bin) = Self::record_bin(&record)
        {
            let problem = self.missing_gpu_runtime(&record);
            let backend = record.get("backend").and_then(Value::as_str);
            let upgrade = if self.runtime == "llama" && problem.is_none() {
                builds::cuda_upgrade(&self.platform, &self.arch, gpu.as_ref(), backend, cuda.as_ref())
            } else {
                None
            };
            let mut m = Map::new();
            m.insert("binPath".into(), json!(bin));
            m.insert("source".into(), json!("managed"));
            for k in ["backend", "version", "installedAt"] {
                if let Some(v) = record.get(k) {
                    m.insert(k.into(), v.clone());
                }
            }
            if let Some(p) = problem {
                m.insert("problem".into(), p);
            }
            if let Some(u) = upgrade {
                m.insert(
                    "upgrade".into(),
                    json!({
                        "buildId": u["id"],
                        "message": format!(
                            "Your NVIDIA graphics card can run the CUDA engine, which is {} than Vulkan. It is a download of several hundred MB.",
                            builds::CUDA_FASTER.to_lowercase()
                        ),
                    }),
                );
            }
            tail(&mut m);
            return Value::Object(m);
        }

        if let Some(on_path) = self.find_on_path().await {
            let mut m = Map::new();
            m.insert("binPath".into(), json!(on_path));
            m.insert("source".into(), json!("external"));
            if let Some(v) = self.probe_version(&on_path).await {
                m.insert("version".into(), json!(v));
            }
            tail(&mut m);
            return Value::Object(m);
        }

        let mut m = Map::new();
        tail(&mut m);
        let reason = if recommended.is_some() {
            "No engine installed yet. Nekko Agent can download one, or point it at a llama-server you already have."
                .to_string()
        } else {
            format!(
                "No llama.cpp build is published for {}/{}. Point Nekko Agent at a llama-server you built yourself.",
                self.platform, self.arch
            )
        };
        m.insert("reason".into(), json!(reason));
        Value::Object(m)
    }

    /// The pinned release, or `None` when GitHub did not give it (`fetchRelease`).
    async fn fetch_release(&self) -> Option<Release> {
        let (repo, tag) = builds::release_pin(self.runtime);
        let url = format!("https://api.github.com/repos/{repo}/releases/tags/{tag}");
        let headers =
            vec![("accept".into(), "application/vnd.github+json".into()), ("user-agent".into(), "nekko-agent".into())];
        let (status, body) = self.io.get(url, headers, Some(Duration::from_secs(15))).await.ok()?;
        if !(200..300).contains(&status) {
            return None;
        }
        let row: Value = serde_json::from_slice(&body).ok()?;
        let assets = row
            .get("assets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|a| {
                nekko_js::truthy(a.get("name"))
                    && nekko_js::truthy(a.get("browser_download_url"))
                    && nekko_js::truthy(a.get("size"))
            })
            .map(|a| Asset {
                name: nekko_js::display(&a["name"]),
                url: nekko_js::display(&a["browser_download_url"]),
                size: a["size"].clone(),
                digest: a.get("digest").filter(|d| !d.is_null()).cloned(),
            })
            .collect();
        (row.get("tag_name").and_then(Value::as_str) == Some(tag)).then(|| Release { tag: tag.to_string(), assets })
    }

    /// The download one build would be (`preview`).
    pub async fn preview(&self, build_id: Option<&str>) -> Value {
        let gpu = (self.gpu)().await;
        let adapters = (self.adapters)().await;
        let cuda = self.cuda_support(gpu.as_ref()).await;
        let available = self.candidates(gpu.as_ref(), &adapters, cuda.as_ref());
        let build = match build_id {
            Some(id) => available.iter().find(|b| b["id"] == id).cloned(),
            None => available.first().cloned(),
        };
        let release = self.fetch_release().await;
        let (Some(build), Some(release)) = (build, release) else { return Value::Null };
        let names: Vec<String> = release.assets.iter().map(|a| a.name.clone()).collect();
        let Some(asset) = self.select_asset(&build, &names) else { return Value::Null };
        let companion = self.select_companion(&build, &asset, &names);
        if nekko_js::truthy(build.get("companionPattern")) && companion.is_none() {
            return Value::Null;
        }
        let files: Vec<Value> = release
            .assets
            .iter()
            .filter(|a| a.name == asset || Some(&a.name) == companion.as_ref())
            .map(|a| json!({ "name": a.name, "sizeBytes": a.size }))
            .collect();
        let size: f64 = files.iter().filter_map(|f| f["sizeBytes"].as_f64()).sum();
        json!({ "runtime": self.runtime, "version": release.tag, "build": build, "files": files, "sizeBytes": crate::num(size) })
    }

    /// Download and unpack a build; the job carries the rest (`install`).
    pub async fn install(self: &Arc<Self>, build_id: Option<&str>) -> Value {
        let gpu = (self.gpu)().await;
        let adapters = (self.adapters)().await;
        let cuda = self.cuda_support(gpu.as_ref()).await;
        let candidates = self.candidates(gpu.as_ref(), &adapters, cuda.as_ref());
        let build = match build_id {
            Some(id) => candidates.iter().find(|b| b["id"] == id).cloned(),
            None => candidates.first().cloned(),
        };
        let Some(build) = build else {
            return json!({ "ok": false, "message": "No engine build matches this machine." });
        };
        let Some(release) = self.fetch_release().await else {
            return json!({
                "ok": false,
                "message": "Couldn't reach GitHub to find a llama.cpp release. Check the connection and try again.",
            });
        };
        let names: Vec<String> = release.assets.iter().map(|a| a.name.clone()).collect();
        let backend = nekko_js::display(&build["backend"]);
        let Some(asset_name) = self.select_asset(&build, &names) else {
            return json!({ "ok": false, "message": format!("The {} release has no {backend} build for this machine.", release.tag) });
        };
        let asset = release.assets.iter().find(|a| a.name == asset_name).cloned().expect("matched from these names");
        let companion_name = self.select_companion(&build, &asset_name, &names);
        if nekko_js::truthy(build.get("companionPattern")) && companion_name.is_none() {
            return json!({ "ok": false, "message": "The release is missing required runtime libraries." });
        }
        let companion = companion_name.and_then(|c| release.assets.iter().find(|a| a.name == c).cloned());
        let build_id = nekko_js::display(&build["id"]);
        let dir = path::join(&[&self.engine_dir, &build_id]);
        let archive = path::join(&[&dir, &asset_name]);

        // Checked when the release publishes a digest; the job still passes through `verifying`.
        let digest = asset.digest.clone().filter(|d| nekko_js::truthy(Some(d))).map(|d| nekko_js::display(&d));
        let verify: Verify = Arc::new(move |p: String| {
            let digest = digest.clone();
            Box::pin(async move {
                match digest {
                    Some(d) => verify_digest(p, d).await,
                    None => None,
                }
            })
        });
        let me = self.clone();
        let (tag, dir_for_after, backend_for_after) = (release.tag.clone(), dir.clone(), backend.clone());
        let after: After = Arc::new(move |file: String, signal: Signal| {
            let (me, tag, dir, backend, companion, build_id) = (
                me.clone(),
                tag.clone(),
                dir_for_after.clone(),
                backend_for_after.clone(),
                companion.clone(),
                build_id.clone(),
            );
            Box::pin(async move {
                match me.unpack(&file, &signal, &dir, companion.as_ref(), &backend, &build_id, &tag).await {
                    Ok(None) => None,
                    Ok(Some(problem)) => Some(problem),
                    Err(e) => Some(format!("Couldn't unpack the engine: {e}")),
                }
            })
        });
        let job = self.downloads.start(Request {
            id: format!("engine:{}:{}", self.runtime, nekko_js::display(&build["id"])),
            kind: "engine".into(),
            label: format!("{} {} ({backend})", self.runtime_name(), release.tag),
            target: nekko_js::display(&build["id"]),
            url: asset.url.clone(),
            dest: archive,
            verify: Some(verify),
            after: Some(after),
            ..Request::default()
        });
        json!({ "ok": true, "message": format!("Downloading {} {}.", self.runtime_name(), release.tag), "jobId": job["id"] })
    }

    /// The archive is the download; unpacking it is what makes it an engine.
    #[allow(clippy::too_many_arguments)]
    async fn unpack(
        &self,
        file: &str,
        signal: &Signal,
        dir: &str,
        companion: Option<&Asset>,
        backend: &str,
        build_id: &str,
        tag: &str,
    ) -> Result<Option<String>, String> {
        if signal.aborted() {
            return Err("This operation was aborted".into());
        }
        // Stop a running server only now that the new build is here.
        (self.before_replace)().await;
        clear_except(dir, file);
        self.extract(file, dir).await?;
        if let Some(companion) = companion {
            // CUDA's runtime libraries ship separately; the server needs them beside it.
            let companion_path = path::join(&[dir, &companion.name]);
            let (status, body) = self.io.get(companion.url.clone(), Vec::new(), None).await?;
            if !(200..300).contains(&status) {
                return Err(format!("companion download failed (HTTP {status})"));
            }
            nodefs::mkdir_p(&path::dirname(&companion_path))?;
            std::fs::write(&companion_path, body).map_err(|e| e.to_string())?;
            if let Some(d) = companion.digest.as_ref().filter(|d| nekko_js::truthy(Some(d)))
                && verify_digest(companion_path.clone(), nekko_js::display(d)).await.is_some()
            {
                return Err("Runtime-library checksum verification failed.".into());
            }
            self.extract(&companion_path, dir).await?;
            let _ = std::fs::remove_file(&companion_path);
        }
        let names = self.server_names();
        let Some(bin) = find_server_binary(dir, 0, &names) else {
            return Ok(Some(format!("The archive did not contain {}.", names[0])));
        };
        #[cfg(unix)]
        if self.platform != "win32" {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
        }
        // The Windows builds import the Visual C++ runtime.
        ensure_vc_runtime(&path::dirname(&bin), &self.platform, &self.vc);
        if signal.aborted() {
            return Err("This operation was aborted".into());
        }
        let mut record = Map::new();
        record.insert("binPath".into(), json!(bin));
        record.insert("backend".into(), json!(backend));
        record.insert("buildId".into(), json!(build_id));
        record.insert("version".into(), json!(tag));
        record.insert("installedAt".into(), crate::num((self.now)()));
        nodefs::mkdir_p(&self.engine_dir)?;
        std::fs::write(self.record_path(), nekko_js::stringify_pretty(&Value::Object(record), "  "))
            .map_err(|e| e.to_string())?;
        Ok(None)
    }

    /// Unpack with whatever the OS has: tar, then unzip, then PowerShell (`extract`).
    async fn extract(&self, archive: &str, dest: &str) -> Result<(), String> {
        nodefs::mkdir_p(dest)?;
        static TAR: OnceLock<Regex> = OnceLock::new();
        let is_tar = TAR
            .get_or_init(|| Regex::with_flags(r"\.(tar\.gz|tgz)$", "i").expect("a valid built-in pattern"))
            .find(archive)
            .is_some();
        let s = |x: &str| x.to_string();
        let attempts: Vec<(String, Vec<String>)> = if is_tar {
            vec![(s("tar"), vec![s("-xzf"), s(archive), s("-C"), s(dest)])]
        } else {
            vec![
                (s("tar"), vec![s("-xf"), s(archive), s("-C"), s(dest)]),
                (s("unzip"), vec![s("-o"), s("-q"), s(archive), s("-d"), s(dest)]),
                (
                    s("powershell"),
                    vec![
                        s("-NoProfile"),
                        s("-Command"),
                        format!(
                            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                            ps_single_quoted(archive),
                            ps_single_quoted(dest)
                        ),
                    ],
                ),
            ]
        };
        for (cmd, args) in attempts {
            if self.io.run(cmd, args, 300_000).await.is_some() {
                let _ = std::fs::remove_file(archive);
                return Ok(());
            }
        }
        Err("no archive tool available (tried tar, unzip, PowerShell)".into())
    }

    /// Remove a managed install; an external binary is never touched (`uninstall`).
    pub fn uninstall(&self) -> Value {
        let Some(record) = self.read_record() else {
            return json!({ "ok": false, "message": "No managed engine is installed." });
        };
        let build_id = record.get("buildId").map(nekko_js::display).unwrap_or_else(|| "undefined".into());
        static R: OnceLock<Regex> = OnceLock::new();
        if R.get_or_init(|| Regex::new("^[a-z0-9-]+$").expect("a valid built-in pattern")).find(&build_id).is_none() {
            return json!({ "ok": false, "message": "Invalid managed-runtime record. No files were removed." });
        }
        let build_dir = path::join(&[&self.engine_dir, &build_id]);
        let bin = record.get("binPath").map(nekko_js::display).unwrap_or_default();
        let owned = path::relative(&build_dir, &bin);
        if owned.is_empty() || owned.starts_with("..") || path::is_absolute(&owned) {
            return json!({ "ok": false, "message": "The binary is outside its managed install. No files were removed." });
        }
        let _ = std::fs::remove_dir_all(&build_dir);
        let _ = std::fs::remove_file(self.record_path());
        json!({ "ok": true, "message": "Removed the engine." })
    }

    /// The binary `detect` would use, found without the GPU probe (`installedBin`).
    pub async fn installed_bin(&self) -> Option<String> {
        if let Some(external) = (self.external)().filter(|e| !e.is_empty() && is_file(e)) {
            return Some(external);
        }
        if let Some(bin) = self.read_record().as_ref().and_then(Self::record_bin) {
            return Some(bin);
        }
        self.find_on_path().await
    }
}

/// Empty a build folder of everything but the archive about to be unpacked.
fn clear_except(dir: &str, keep: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let p = path::join(&[dir, &entry.file_name().to_string_lossy()]);
        if p == keep {
            continue;
        }
        let meta = std::fs::symlink_metadata(&p);
        let _ = match meta {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p),
            _ => std::fs::remove_file(&p),
        };
    }
}

/// A depth-limited walk for the server binary: files first, then folders.
fn find_server_binary(dir: &str, depth: u32, names: &[&str]) -> Option<String> {
    if depth > 3 {
        return None;
    }
    let entries = nodefs::read_dir(dir).ok()?;
    for e in &entries {
        if e.is_file && names.contains(&e.name.as_str()) {
            return Some(path::join(&[dir, &e.name]));
        }
    }
    for e in &entries {
        if e.is_dir
            && let Some(hit) = find_server_binary(&path::join(&[dir, &e.name]), depth + 1, names)
        {
            return Some(hit);
        }
    }
    None
}

/// `s` for the inside of a PowerShell single-quoted string: every quote
/// doubled. PowerShell also closes a single-quoted string on the curly
/// quotes U+2018 to U+201B, so those are doubled too.
fn ps_single_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::ps_single_quoted;

    #[test]
    fn powershell_paths_cannot_close_their_quotes() {
        assert_eq!(ps_single_quoted(r"C:\Users\me\x.zip"), r"C:\Users\me\x.zip");
        assert_eq!(ps_single_quoted("a'; Remove-Item -Recurse ~; '"), "a''; Remove-Item -Recurse ~; ''");
        assert_eq!(ps_single_quoted("o\u{2019}brien"), "o\u{2019}\u{2019}brien");
    }
}
