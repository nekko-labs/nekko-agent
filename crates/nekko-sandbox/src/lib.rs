//! The container sandbox, ported from `packages/host/src/container-sandbox.ts`.
//!
//! A sandbox chat's tools run in a Docker container the user's locally
//! installed, digest-pinned Linux image provides: no network, a read-only
//! root, every capability dropped, no new privileges, 512 MB of memory, one
//! CPU, 128 processes, user 1000, and a private volume holding a copy of the
//! chat's folders. The copy is made by reading plain files on the host (no
//! links, no special files, no hard links, no reparse points; `.git`,
//! `node_modules` and `.env*` left out) and writing them in through the same
//! Python helper that does every file operation inside the container, so no
//! archive is ever extracted on the host. A manifest beside the daemon's data
//! records the container, the volume, their label token and the baseline
//! hashes, so a restart resumes the same container and cleanup never deletes
//! anything by name alone. Every operation re-verifies the container's
//! isolation first. Applying changes back to the host is refused at this
//! boundary.
//!
//! Docker runs through a [`Runner`], so the tests drive a scripted one.

use base64::Engine;
use nekko_js as js;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The Python run inside the container for every file operation.
pub fn helper() -> String {
    include_str!("helper.py").replace('\r', "")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub files: u64,
    pub bytes: u64,
    pub output_bytes: u64,
    pub timeout_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self { files: 5000, bytes: 32 * 1024 * 1024, output_bytes: 48 * 1024 * 1024, timeout_ms: 30_000 }
    }
}

impl Limits {
    fn json(&self) -> Value {
        json!({ "files": self.files, "bytes": self.bytes, "outputBytes": self.output_bytes, "timeoutMs": self.timeout_ms })
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub session_id: String,
    pub state_directory: PathBuf,
    pub source_folders: Vec<String>,
    /// A locally installed Linux image with python3 and /bin/sh, pinned by sha256 digest.
    pub image: String,
    pub docker_path: Option<String>,
    pub limits: Limits,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
}

pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Runs the Docker CLI: `execFile(executable, args, { timeout, maxBuffer })`.
pub trait Runner: Send + Sync {
    fn run<'a>(
        &'a self,
        exe: &'a str,
        args: &'a [String],
        timeout: Duration,
        max_buffer: u64,
    ) -> BoxFuture<'a, Result<RunResult, String>>;
}

/// The real runner: the process with no console window, killed at its time
/// limit or when its output passes the buffer limit.
pub struct ProcessRunner;

impl Runner for ProcessRunner {
    fn run<'a>(
        &'a self,
        exe: &'a str,
        args: &'a [String],
        timeout: Duration,
        max_buffer: u64,
    ) -> BoxFuture<'a, Result<RunResult, String>> {
        Box::pin(async move {
            use tokio::io::AsyncReadExt;
            let mut cmd = tokio::process::Command::new(exe);
            cmd.args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
            let line = format!("{exe} {}", args.join(" "));
            let mut child = cmd.spawn().map_err(|e| format!("spawn {exe} {e}"))?;
            let (mut out, mut err) = (child.stdout.take(), child.stderr.take());
            let work = async {
                let (mut o, mut e) = (Vec::new(), Vec::new());
                let ro = async {
                    if let Some(p) = out.as_mut() {
                        let _ = p.read_to_end(&mut o).await;
                    }
                };
                let re = async {
                    if let Some(p) = err.as_mut() {
                        let _ = p.read_to_end(&mut e).await;
                    }
                };
                tokio::join!(ro, re);
                let status = child.wait().await;
                (o, e, status)
            };
            let (o, e, status) = match tokio::time::timeout(timeout, work).await {
                Ok(r) => r,
                Err(_) => return Err(format!("Command failed: {line}\n(timed out after {} ms)", timeout.as_millis())),
            };
            if o.len() as u64 > max_buffer {
                return Err("stdout maxBuffer length exceeded".into());
            }
            if e.len() as u64 > max_buffer {
                return Err("stderr maxBuffer length exceeded".into());
            }
            let (stdout, stderr) = (String::from_utf8_lossy(&o).into_owned(), String::from_utf8_lossy(&e).into_owned());
            match status {
                Ok(s) if s.success() => Ok(RunResult { stdout, stderr }),
                _ => Err(format!("Command failed: {line}\n{stderr}")),
            }
        })
    }
}

fn sha256(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn omitted(name: &str) -> bool {
    name == ".git" || name == "node_modules" || name == ".env" || name.starts_with(".env.")
}

fn reserved(part: &str) -> bool {
    let lower = part.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or_default();
    let numbered = |p: &str| {
        stem.len() == 4 && stem.starts_with(p) && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0'
    };
    matches!(stem, "con" | "prn" | "aux" | "nul") || numbered("com") || numbered("lpt")
}

/// `relativeFile(value)`: a path inside the workspace copy, or "Unsafe workspace path".
pub fn relative_file(value: &str) -> Result<String, String> {
    let bad = value.is_empty()
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(|c| (c as u32) < 0x20)
        || value.starts_with('/')
        || value.split('/').any(|p| {
            p.is_empty() || p == "." || p == ".." || omitted(p) || p.ends_with('.') || p.ends_with(' ') || reserved(p)
        });
    if bad { Err("Unsafe workspace path".into()) } else { Ok(value.to_string()) }
}

#[cfg(unix)]
fn link_count(meta: &std::fs::Metadata, _path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.nlink()
}

#[cfg(windows)]
fn link_count(_meta: &std::fs::Metadata, path: &Path) -> u64 {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let Ok(f) = std::fs::File::open(path) else { return 0 };
    // SAFETY: a valid open handle and a zeroed out-structure.
    unsafe {
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) == 0 {
            return 0;
        }
        u64::from(info.nNumberOfLinks)
    }
}

fn realpath(p: &Path) -> Result<String, String> {
    let s = std::fs::canonicalize(p).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    Ok(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s))
}

/// `assertPlain(target)`: every component a plain directory or file (a file
/// with one link), and each its own real path.
pub fn assert_plain(target: &Path) -> Result<(), String> {
    let absolute = std::path::absolute(target).map_err(|e| e.to_string())?;
    let mut current = PathBuf::new();
    for comp in absolute.components() {
        current.push(comp.as_os_str());
        if matches!(comp, std::path::Component::Prefix(_) | std::path::Component::RootDir) {
            continue;
        }
        let meta = std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        let ft = meta.file_type();
        if ft.is_symlink() || (!ft.is_dir() && !ft.is_file()) || (ft.is_file() && link_count(&meta, &current) != 1) {
            return Err("Links and special files are not permitted".into());
        }
        let real = realpath(&current)?;
        let here = current.to_string_lossy().into_owned();
        let same = if cfg!(windows) { real.to_lowercase() == here.to_lowercase() } else { real == here };
        if !same {
            return Err("Reparse/alias path is not permitted".into());
        }
    }
    Ok(())
}

/// `plainRead(target)`.
pub fn plain_read(target: &Path) -> Result<Vec<u8>, String> {
    assert_plain(target)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut f = opts.open(target).map_err(|e| e.to_string())?;
    let meta = f.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || link_count(&meta, target) != 1 {
        return Err("Not a plain file".into());
    }
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut f, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn is_token(t: &str) -> bool {
    t.len() == 36 && t.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-')
}

/// `^\S+@sha256:[a-f0-9]{64}$`.
pub fn is_pinned_image(image: &str) -> bool {
    let Some((name, digest)) = image.rsplit_once("@sha256:") else { return false };
    !name.is_empty()
        && !name.chars().any(char::is_whitespace)
        && digest.len() == 64
        && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_image_id(id: &str) -> bool {
    id.strip_prefix("sha256:")
        .is_some_and(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn parse(stdout: &str) -> Result<Value, String> {
    serde_json::from_str(stdout).map_err(|e| e.to_string())
}

fn first(v: &Value) -> &Value {
    v.get(0).unwrap_or(&Value::Null)
}

fn truthy(v: Option<&Value>) -> bool {
    js::truthy(v)
}

fn len_of(v: Option<&Value>) -> usize {
    match v {
        Some(Value::Array(a)) => a.len(),
        Some(Value::Object(o)) => o.len(),
        _ => 0,
    }
}

fn has(v: Option<&Value>, item: &str) -> bool {
    v.and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(item)))
}

fn num_eq(v: Option<&Value>, n: f64) -> bool {
    v.and_then(Value::as_f64) == Some(n)
}

/// One change between the copy as made and the copy now.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<Value>,
}

impl Change {
    pub fn json(&self) -> Value {
        json!({ "path": self.path, "before": self.before, "after": self.after })
    }
}

pub struct ContainerSandbox {
    config: Config,
    runner: std::sync::Arc<dyn Runner>,
    manifest_path: PathBuf,
    docker: Mutex<String>,
    manifest: Mutex<Option<Value>>,
    busy: AtomicBool,
}

struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

const MEM: f64 = 512.0 * 1024.0 * 1024.0;

impl ContainerSandbox {
    pub fn new(config: Config, runner: std::sync::Arc<dyn Runner>) -> Result<Self, String> {
        let sid_ok = !config.session_id.is_empty()
            && config.session_id.len() <= 100
            && config.session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !sid_ok {
            return Err("Invalid session id".into());
        }
        if !is_pinned_image(&config.image) {
            return Err("Explicit digest-pinned image required".into());
        }
        let l = config.limits;
        if [l.files, l.bytes, l.output_bytes, l.timeout_ms].iter().any(|&v| v == 0 || v > 9_007_199_254_740_991) {
            return Err("Invalid limits".into());
        }
        let dir = std::path::absolute(&config.state_directory).unwrap_or(config.state_directory.clone());
        let manifest_path = dir.join(format!("{}.sandbox.json", config.session_id));
        Ok(Self {
            config,
            runner,
            manifest_path,
            docker: Mutex::default(),
            manifest: Mutex::default(),
            busy: AtomicBool::new(false),
        })
    }

    fn exclusive(&self) -> Result<Busy<'_>, String> {
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err("Sandbox operation already in progress".into());
        }
        Ok(Busy(&self.busy))
    }

    fn manifest(&self) -> Option<Value> {
        self.manifest.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_manifest(&self, m: Value) {
        *self.manifest.lock().unwrap_or_else(|e| e.into_inner()) = Some(m);
    }

    /// The container the manifest names (for a cancellation's `docker kill`).
    pub fn container(&self) -> Option<String> {
        self.manifest().and_then(|m| m["container"].as_str().map(str::to_string))
    }

    pub fn docker(&self) -> String {
        self.docker.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    async fn run(&self, args: &[&str]) -> Result<RunResult, String> {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let docker = self.docker();
        let l = self.config.limits;
        self.runner.run(&docker, &args, Duration::from_millis(l.timeout_ms), l.output_bytes).await
    }

    fn save(&self) -> Result<(), String> {
        let m = self.manifest().unwrap_or(Value::Null);
        nekko_settings::write_json_atomic(&self.manifest_path, &m).map_err(|e| e.to_string())
    }

    async fn discover(&self, require_image: bool) -> Result<String, String> {
        let candidates: Vec<String> = match &self.config.docker_path {
            Some(p) => vec![p.clone()],
            None if cfg!(windows) => {
                vec!["C:/Program Files/Docker/Docker/resources/bin/docker.exe".into(), "docker.exe".into()]
            }
            None => vec!["docker".into()],
        };
        let mut found = false;
        for c in candidates {
            let args = vec!["--version".to_string()];
            if self.runner.run(&c, &args, Duration::from_millis(5000), 65536).await.is_ok() {
                *self.docker.lock().unwrap_or_else(|e| e.into_inner()) = c;
                found = true;
                break;
            }
        }
        if !found {
            return Err("Docker CLI unavailable".into());
        }
        let info = parse(&self.run(&["info", "--format", "{{json .}}"]).await?.stdout)?;
        if info.get("OSType") != Some(&json!("linux")) || !truthy(info.get("ServerVersion")) {
            return Err("Ready Linux Docker engine required".into());
        }
        if !require_image {
            return Ok(String::new());
        }
        let images = parse(&self.run(&["image", "inspect", &self.config.image]).await?.stdout)?;
        let image = first(&images);
        let id = image.get("Id").and_then(Value::as_str).unwrap_or_default();
        if image.get("Os") != Some(&json!("linux")) || len_of(image.pointer("/Config/Volumes")) > 0 || !is_image_id(id)
        {
            return Err("Pinned Linux image must already be installed".into());
        }
        Ok(id.to_string())
    }

    async fn verify(&self) -> Result<(), String> {
        let Some(m) = self.manifest().filter(|m| m["phase"] == "ready") else {
            return Err("Sandbox is not ready".into());
        };
        let (container, volume, token, image) = (
            m["container"].as_str().unwrap_or_default(),
            m["volume"].as_str().unwrap_or_default(),
            m["token"].as_str().unwrap_or_default(),
            m["image"].as_str().unwrap_or_default(),
        );
        let c = parse(&self.run(&["inspect", container]).await?.stdout)?;
        let c = first(&c);
        let h = c.get("HostConfig");
        let hp = |k: &str| h.and_then(|h| h.get(k));
        let v = parse(&self.run(&["volume", "inspect", volume]).await?.stdout)?;
        let v = first(&v);
        let volume_bad = v.pointer("/Labels/dev.nekko.sandbox").and_then(Value::as_str) != Some(token)
            || hp("Tmpfs").and_then(|t| t.get("/tmp")).and_then(Value::as_str)
                != Some("rw,noexec,nosuid,nodev,size=64m")
            || !num_eq(hp("MemorySwap"), MEM)
            || truthy(hp("PidMode"))
            || hp("IpcMode").and_then(Value::as_str) == Some("host")
            || len_of(hp("Devices")) > 0
            || len_of(hp("DeviceRequests")) > 0
            || len_of(hp("PortBindings")) > 0;
        if volume_bad {
            return Err("Container resource or volume isolation mismatch".into());
        }
        let mounts: Vec<&Value> =
            c.get("Mounts").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
        let bad_mount = mounts.iter().filter(|x| x["Type"] != "tmpfs").any(|x| {
            x["Type"] != "volume"
                || x["Name"].as_str() != Some(volume)
                || x["Destination"] != "/workspace"
                || !truthy(x.get("RW"))
        });
        let workspace_mounts = mounts.iter().filter(|x| x["Destination"] == "/workspace").count();
        let identity_bad = c.pointer("/Config/Labels/dev.nekko.sandbox").and_then(Value::as_str) != Some(token)
            || c.get("Image").and_then(Value::as_str) != Some(image)
            || !truthy(c.pointer("/State/Running"))
            || c.pointer("/Config/User").and_then(Value::as_str) != Some("1000:1000")
            || hp("NetworkMode").and_then(Value::as_str) != Some("none")
            || !truthy(hp("ReadonlyRootfs"))
            || !has(hp("CapDrop"), "ALL")
            || !has(hp("SecurityOpt"), "no-new-privileges")
            || truthy(hp("Privileged"))
            || len_of(hp("Binds")) > 0
            || !num_eq(hp("Memory"), MEM)
            || !num_eq(hp("PidsLimit"), 128.0)
            || !num_eq(hp("NanoCpus"), 1_000_000_000.0)
            || bad_mount
            || workspace_mounts != 1;
        if identity_bad {
            return Err("Container identity or isolation mismatch".into());
        }
        Ok(())
    }

    async fn python(&self, op: &str, args: Map<String, Value>) -> Result<Value, String> {
        let mut q = args;
        q.insert("op".into(), json!(op));
        q.insert("limits".into(), self.config.limits.json());
        let container = self.container().unwrap_or_default();
        let helper = helper();
        let q = js::stringify(&Value::Object(q));
        parse(&self.run(&["exec", "--user", "1000:1000", &container, "python3", "-I", "-c", &helper, &q]).await?.stdout)
    }

    async fn write_chunks(&self, p: &str, data: &[u8]) -> Result<Value, String> {
        if data.len() as u64 > self.config.limits.bytes {
            return Err("File size limit exceeded".into());
        }
        // Keep Windows command lines well below their 32K UTF-16 ceiling.
        let chunk = |range: &[u8]| {
            let mut m = Map::new();
            m.insert("path".into(), json!(p));
            m.insert("base64".into(), json!(B64.encode(range)));
            m
        };
        let mut result = self.python("write", chunk(&data[..data.len().min(4096)])).await?;
        let mut offset = 4096;
        while offset < data.len() {
            result = self.python("append", chunk(&data[offset..data.len().min(offset + 4096)])).await?;
            offset += 4096;
        }
        Ok(result)
    }

    fn check_manifest(&self, m: &Value) -> bool {
        let token = m["token"].as_str().unwrap_or_default();
        m["version"] == 1
            && m["sessionId"].as_str() == Some(&self.config.session_id)
            && is_token(token)
            && m["container"].as_str() == Some(&format!("nekko-{token}"))
            && m["volume"].as_str() == Some(&format!("nekko-{token}-workspace"))
    }

    /// `initialize()`: resume the recorded container, or copy the folders
    /// into a new one.
    pub async fn initialize(&self) -> Result<(), String> {
        let _busy = self.exclusive()?;
        let image = self.discover(true).await?;
        std::fs::create_dir_all(&self.config.state_directory).map_err(|e| e.to_string())?;
        assert_plain(&self.config.state_directory)?;
        let roots: Vec<String> = self
            .config
            .source_folders
            .iter()
            .map(|p| std::path::absolute(p).map(|a| a.to_string_lossy().into_owned()).unwrap_or_else(|_| p.clone()))
            .collect();
        let unique: std::collections::HashSet<String> = roots.iter().map(|p| p.to_lowercase()).collect();
        if roots.is_empty() || unique.len() != roots.len() {
            return Err("Select unique source folders".into());
        }
        for root in &roots {
            assert_plain(Path::new(root))?;
            if !Path::new(root).is_dir() {
                return Err("Source must be a folder".into());
            }
        }
        if self.manifest_path.exists() {
            let m = parse(&String::from_utf8_lossy(&plain_read(&self.manifest_path)?))?;
            if !self.check_manifest(&m) || m["image"].as_str() != Some(&image) || m["roots"] != json!(roots) {
                return Err("Manifest identity mismatch".into());
            }
            self.set_manifest(m);
            return self.verify().await;
        }
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();
        let mut bytes: u64 = 0;
        let limits = self.config.limits;
        fn walk(
            root: &Path,
            rel: &Path,
            index: usize,
            files: &mut Vec<(String, Vec<u8>)>,
            bytes: &mut u64,
            limits: &Limits,
        ) -> Result<(), String> {
            let dir = root.join(rel);
            let mut names: Vec<String> = std::fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                .collect();
            names.sort();
            for name in names {
                if omitted(&name) {
                    continue;
                }
                let local = dir.join(&name);
                assert_plain(&local)?;
                let meta = std::fs::symlink_metadata(&local).map_err(|e| e.to_string())?;
                let rel_name = rel.join(&name);
                if meta.is_dir() {
                    walk(root, &rel_name, index, files, bytes, limits)?;
                } else {
                    if meta.len() > limits.bytes.saturating_sub(*bytes) || files.len() as u64 >= limits.files {
                        return Err("Source copy limit exceeded".into());
                    }
                    let b = plain_read(&local)?;
                    *bytes += b.len() as u64;
                    if *bytes > limits.bytes {
                        return Err("Source copy limit exceeded".into());
                    }
                    let rel_text: Vec<String> =
                        rel_name.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                    let p = relative_file(&format!("folder-{index}/{}", rel_text.join("/")))?;
                    files.push((p, b));
                }
            }
            Ok(())
        }
        for (i, root) in roots.iter().enumerate() {
            walk(Path::new(root), Path::new(""), i, &mut files, &mut bytes, &limits)?;
        }
        let token = uuid();
        let mut baseline = Map::new();
        for (p, b) in &files {
            baseline.insert(p.clone(), json!(sha256(b)));
        }
        let m = json!({
            "version": 1, "sessionId": self.config.session_id, "token": token,
            "container": format!("nekko-{token}"), "volume": format!("nekko-{token}-workspace"),
            "image": image, "roots": roots, "baseline": baseline, "phase": "creating",
        });
        self.set_manifest(m);
        self.save()?;
        let (container, volume) = (format!("nekko-{token}"), format!("nekko-{token}-workspace"));
        let label = format!("dev.nekko.sandbox={token}");
        self.run(&["volume", "create", "--label", &label, &volume]).await?;
        let mount = format!("type=volume,src={volume},dst=/workspace,volume-nocopy");
        self.run(&[
            "create",
            "--pull=never",
            "--name",
            &container,
            "--label",
            &label,
            "--network",
            "none",
            "--user",
            "1000:1000",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--cpus",
            "1",
            "--pids-limit",
            "128",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64m",
            "--mount",
            &mount,
            "--workdir",
            "/workspace",
            "--entrypoint",
            "python3",
            &image,
            "-I",
            "-c",
            "import time; time.sleep(2147483647)",
        ])
        .await?;
        self.run(&["start", &container]).await?;
        // Only the private empty volume is initialized as root, never agent commands.
        self.run(&[
            "exec",
            "--user",
            "0:0",
            &container,
            "python3",
            "-I",
            "-c",
            "import os; os.chmod(\"/workspace\",0o1777)",
        ])
        .await?;
        for (p, b) in &files {
            self.write_chunks(p, b).await?;
        }
        let mut m = self.manifest().unwrap_or(Value::Null);
        m["phase"] = json!("ready");
        self.set_manifest(m);
        self.save()?;
        self.verify().await
    }

    /// `execute(tool, args)`: one tool inside the container. A string for
    /// `read_file`, the helper's JSON otherwise, `{ stdout, stderr }` for bash.
    pub async fn execute(&self, tool: &str, args: &Value) -> Result<Value, String> {
        let op = match tool {
            "read_file" => "read",
            "write_file" => "write",
            "edit_file" => "edit",
            "list_dir" => "list",
            "grep" => "grep",
            "glob" => "glob",
            "bash" => "",
            _ => return Err(format!("Unsupported sandbox tool: {tool}")),
        };
        let _busy = self.exclusive()?;
        self.verify().await?;
        let container = self.container().unwrap_or_default();
        let show = |v: Option<&Value>| v.map(js::display).unwrap_or_else(|| "undefined".into());
        if tool == "bash" {
            let command = match args.get("command") {
                Some(Value::String(c)) if !c.is_empty() => c.clone(),
                _ => return Err("Command required".into()),
            };
            let cwd = match args.get("cwd") {
                None => "/workspace".to_string(),
                Some(v) => format!("/workspace/{}", relative_file(&show(Some(v)))?),
            };
            let r = self
                .run(&["exec", "--user", "1000:1000", "--workdir", &cwd, &container, "/bin/sh", "-c", &command])
                .await?;
            return Ok(json!({ "stdout": r.stdout, "stderr": r.stderr }));
        }
        let mut input = args.as_object().cloned().unwrap_or_default();
        if let Some(p) = args.get("path") {
            input.insert("path".into(), json!(relative_file(&show(Some(p)))?));
        }
        if tool == "write_file" {
            let Some(Value::String(content)) = args.get("content") else { return Err("Text content required".into()) };
            let p = relative_file(&show(args.get("path")))?;
            return self.write_chunks(&p, content.as_bytes()).await;
        }
        let result = self.python(op, input).await?;
        if tool == "read_file" {
            let b = B64.decode(result["base64"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
            return Ok(json!(String::from_utf8_lossy(&b)));
        }
        Ok(result)
    }

    fn validate_snapshot(&self, raw: &Value) -> Result<Vec<Value>, String> {
        let Some(list) = raw.as_array().filter(|a| a.len() as u64 <= self.config.limits.files) else {
            return Err("Invalid snapshot".into());
        };
        let mut bytes = 0u64;
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for f in list {
            let p = relative_file(&f.get("path").map(js::display).unwrap_or_else(|| "undefined".into()))?;
            let b64 = f.get("base64").and_then(Value::as_str);
            let canonical = b64.is_some_and(|s| B64.decode(s).is_ok_and(|b| B64.encode(&b) == s));
            if seen.contains(&p.to_lowercase()) || !canonical {
                return Err("Invalid snapshot entry".into());
            }
            seen.insert(p.to_lowercase());
            let b = B64.decode(b64.unwrap_or_default()).unwrap_or_default();
            bytes += b.len() as u64;
            if bytes > self.config.limits.bytes || f.get("hash").and_then(Value::as_str) != Some(&sha256(&b)) {
                return Err("Snapshot hash/size mismatch".into());
            }
            out.push(json!({ "path": p, "base64": b64, "hash": f["hash"] }));
        }
        Ok(out)
    }

    pub async fn snapshot(&self) -> Result<Vec<Value>, String> {
        let _busy = self.exclusive()?;
        self.verify().await?;
        let raw = self.python("snapshot", Map::new()).await?;
        self.validate_snapshot(&raw)
    }

    /// `diff()`: every path whose content differs from the copy as made.
    pub async fn diff(&self) -> Result<Vec<Change>, String> {
        let files = self.snapshot().await?;
        let baseline = self.manifest().and_then(|m| m["baseline"].as_object().cloned()).unwrap_or_default();
        let current: std::collections::HashMap<String, Value> =
            files.into_iter().map(|f| (f["path"].as_str().unwrap_or_default().to_string(), f)).collect();
        let mut paths: Vec<String> = baseline.keys().cloned().chain(current.keys().cloned()).collect();
        paths.sort();
        paths.dedup();
        Ok(paths
            .into_iter()
            .filter_map(|p| {
                let before = baseline.get(&p).and_then(Value::as_str).map(str::to_string);
                let after = current.get(&p).cloned();
                let after_hash = after.as_ref().and_then(|a| a["hash"].as_str().map(str::to_string));
                (before != after_hash).then_some(Change { path: p, before, after })
            })
            .collect())
    }

    /// Refused at the lowest boundary: hashes and advisory locks cannot keep
    /// external writers out.
    pub fn apply_back(&self, selected: &[Change]) -> Result<(), String> {
        if selected.is_empty() {
            return Ok(());
        }
        Err("Apply-back is disabled: exclusive host filesystem ownership cannot be guaranteed against concurrent external writes.".into())
    }

    /// `destroy()`: remove the container and volume, each only after its
    /// label proves it is ours; works after a restart or a failed creation.
    pub async fn destroy(&self) -> Result<(), String> {
        let _busy = self.exclusive()?;
        if self.docker().is_empty() {
            self.discover(false).await?;
        }
        let m = match self.manifest() {
            Some(m) => m,
            None => parse(&String::from_utf8_lossy(&plain_read(&self.manifest_path)?))?,
        };
        if !self.check_manifest(&m) {
            return Err("Manifest identity mismatch".into());
        }
        if m["phase"] == "destroyed" {
            return Ok(());
        }
        let (container, volume, token) = (
            m["container"].as_str().unwrap_or_default().to_string(),
            m["volume"].as_str().unwrap_or_default().to_string(),
            m["token"].as_str().unwrap_or_default().to_string(),
        );
        let listed = self.run(&["container", "ls", "-a", "--format", "{{json .Names}}"]).await?.stdout;
        let containers: Vec<String> = listed
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str::<String>(l).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        let volumes = self.run(&["volume", "ls", "--format", "{{.Name}}"]).await?.stdout;
        let has_container = containers.contains(&container);
        let has_volume = volumes.split('\n').any(|v| v == volume);
        if has_container {
            let c = parse(&self.run(&["inspect", &container]).await?.stdout)?;
            if first(&c).pointer("/Config/Labels/dev.nekko.sandbox").and_then(Value::as_str) != Some(&token) {
                return Err("Container identity mismatch".into());
            }
        }
        if has_volume {
            let v = parse(&self.run(&["volume", "inspect", &volume]).await?.stdout)?;
            if first(&v).pointer("/Labels/dev.nekko.sandbox").and_then(Value::as_str) != Some(&token) {
                return Err("Volume identity mismatch".into());
            }
        }
        if has_container {
            self.run(&["rm", "-f", &container]).await?;
        }
        if has_volume {
            self.run(&["volume", "rm", &volume]).await?;
        }
        let mut m = m;
        m["phase"] = json!("destroyed");
        self.set_manifest(m);
        self.save()
    }
}

#[cfg(test)]
mod tests;
