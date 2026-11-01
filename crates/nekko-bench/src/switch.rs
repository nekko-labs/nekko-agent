//! `nekko-bench switch`: what switching to a local model costs, by where its
//! weights are when the switch starts. Phase 0 of the model scheduler (#1462):
//! the numbers that say how much a Warm (in memory) or Staged (on a fast SSD)
//! tier buys over a cold load, and where the rest of a load goes.
//!
//! Unlike the serving benchmark this one starts the server, because the load
//! is what it measures. For each model, volume and repeat:
//!
//! - **cold**: a fresh copy of the model on that volume, written and read with
//!   the OS cache bypassed so no page of it is in memory, then loaded. Raw
//!   read speed is measured on that copy first, also uncached.
//! - **warm**: the same copy read once through the cache, then loaded again.
//!   This is the load a scheduler's prefetch would leave behind.
//!
//! Each load is split by the server's own log timestamps into startup (the
//! process, backend libraries and GPU init), weights (read, upload and
//! context) and serve (the rest, until `/health` answers). After each load the
//! first request and a second, different one (**hot**) are timed.
//!
//! `nekko-bench switch <config.json> [--out results.json] [--markdown results.md]`
//!
//! ```json
//! { "machine": "RTX 5090, Windows 11", "server": "C:/.../llama-server.exe", "repeats": 3,
//!   "args": ["--n-gpu-layers", "999", "--ctx-size", "4096"],
//!   "volumes": [ { "name": "NVMe", "dir": "C:/bench" }, { "name": "HDD", "dir": "E:/bench" } ],
//!   "models": [ { "name": "Qwen3 8B Q4_K_M", "path": "C:/models/qwen3-8b.gguf" } ] }
//! ```
//!
//! Every run checks available memory first and stops rather than push the
//! machine into swap (a loop of loads once took a session down).

use crate::client::{self, Target};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};

const CHUNK: usize = 8 << 20;
/// Sector alignment for uncached I/O.
const ALIGN: usize = 4096;
/// How much of a copy the raw read speed is measured over.
const RAW_READ_LIMIT: u64 = 2 << 30;
const LOAD_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    machine: String,
    server: String,
    #[serde(default = "three")]
    repeats: usize,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default = "port")]
    port: u16,
    /// Stop when available memory minus the model would fall under this.
    #[serde(default = "headroom")]
    min_free_gb: f64,
    volumes: Vec<Volume>,
    models: Vec<Model>,
}

fn three() -> usize {
    3
}
fn port() -> u16 {
    18431
}
fn headroom() -> f64 {
    6.0
}

#[derive(Deserialize)]
struct Volume {
    name: String,
    dir: String,
}

#[derive(Deserialize)]
struct Model {
    name: String,
    path: String,
    #[serde(default)]
    args: Vec<String>,
}

/// One load, from spawn to a served request.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    /// Spawn to `/health` answering.
    pub ready_ms: f64,
    /// Spawn to the server starting on the model file.
    pub startup_ms: Option<f64>,
    /// The model file to the model loaded: read, upload, context.
    pub weights_ms: Option<f64>,
    /// Model loaded to `/health` answering.
    pub serve_ms: Option<f64>,
    /// The first request after the load, to its first token.
    pub first_token_ms: f64,
    /// A second, different request, to its first token.
    pub hot_token_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeResult {
    volume: String,
    /// Uncached sequential read of the copy, MB/s.
    raw_read_mbps: Vec<f64>,
    /// Reading the copy through the cache before the warm load, MB/s.
    cached_read_mbps: Vec<f64>,
    cold: Vec<Load>,
    warm: Vec<Load>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelResult {
    name: String,
    size_bytes: u64,
    volumes: Vec<VolumeResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    machine: String,
    server: String,
    args: Vec<String>,
    repeats: usize,
    models: Vec<ModelResult>,
}

pub async fn run(mut args: impl Iterator<Item = String>) -> anyhow::Result<()> {
    let config_path = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: nekko-bench switch <config.json> [--out f] [--markdown f]"))?;
    let (mut out, mut md) = (None, None);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--out" => out = args.next(),
            "--markdown" => md = args.next(),
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    let cfg: Config = serde_json::from_str(&std::fs::read_to_string(&config_path)?)?;
    // No pooled connections: each load is a new server on the same port, and a
    // connection kept from the last one (or closed after a stream) fails the next request.
    let http = reqwest::Client::builder().no_proxy().pool_max_idle_per_host(0).build()?;
    let mut report = Report {
        machine: cfg.machine.clone(),
        server: cfg.server.clone(),
        args: cfg.args.clone(),
        repeats: cfg.repeats,
        models: vec![],
    };

    let result = measure(&cfg, &http, &mut report).await;
    // Whatever stopped the run, what was measured is kept.
    let json = serde_json::to_string_pretty(&report)?;
    match &out {
        Some(p) => std::fs::write(p, &json)?,
        None => println!("{json}"),
    }
    if let Some(p) = md {
        std::fs::write(p, markdown(&report))?;
    }
    result
}

async fn measure(cfg: &Config, http: &reqwest::Client, report: &mut Report) -> anyhow::Result<()> {
    for model in &cfg.models {
        let src = Path::new(&model.path);
        let size = std::fs::metadata(src)?.len();
        eprintln!("== {} ({:.2} GB)", model.name, size as f64 / 1e9);
        report.models.push(ModelResult { name: model.name.clone(), size_bytes: size, volumes: vec![] });
        for vol in &cfg.volumes {
            report.models.last_mut().expect("pushed").volumes.push(VolumeResult {
                volume: vol.name.clone(),
                raw_read_mbps: vec![],
                cached_read_mbps: vec![],
                cold: vec![],
                warm: vec![],
            });
            std::fs::create_dir_all(&vol.dir)?;
            let copy = PathBuf::from(&vol.dir).join(src.file_name().unwrap_or_default());
            for i in 0..cfg.repeats {
                let mut outcome = repeat(cfg, http, model, src, &copy, size, &vol.name).await;
                // Another app can hold the GPU for a moment; one fresh try, from a fresh copy.
                if outcome.as_ref().is_err_and(|e| e.to_string().contains("out of memory")) {
                    eprintln!("   {} #{}: out of GPU memory, retrying in 20s", vol.name, i + 1);
                    let _ = std::fs::remove_file(&copy);
                    tokio::time::sleep(Duration::from_secs(20)).await;
                    outcome = repeat(cfg, http, model, src, &copy, size, &vol.name).await;
                }
                let _ = std::fs::remove_file(&copy);
                let (raw, cold, cached, warm) =
                    outcome.inspect_err(|e| eprintln!("   {} #{}: {e}", vol.name, i + 1))?;
                let res = report.models.last_mut().expect("pushed").volumes.last_mut().expect("pushed");
                res.raw_read_mbps.push(raw);
                res.cold.push(cold);
                res.cached_read_mbps.push(cached);
                res.warm.push(warm);
            }
        }
    }
    Ok(())
}

async fn repeat(
    cfg: &Config,
    http: &reqwest::Client,
    model: &Model,
    src: &Path,
    copy: &Path,
    size: u64,
    volume: &str,
) -> anyhow::Result<(f64, Load, f64, Load)> {
    let t = Instant::now();
    cold_copy(src, copy)?;
    eprintln!("   {volume}: copied uncached in {:.1}s", t.elapsed().as_secs_f64());
    let raw = raw_read_mbps(copy, RAW_READ_LIMIT)?;

    guard(size, cfg.min_free_gb)?;
    let cold = load(cfg, http, model, copy).await?;
    eprintln!("   {volume} cold: {}", describe(&cold, raw));

    let cached = cached_read_mbps(copy)?;
    guard(size, cfg.min_free_gb)?;
    let warm = load(cfg, http, model, copy).await?;
    eprintln!("   {volume} warm: {}", describe(&warm, cached));
    Ok((raw, cold, cached, warm))
}

fn describe(l: &Load, mbps: f64) -> String {
    format!(
        "ready {:.2}s (startup {}, weights {}, serve {}), first token {:.0} ms, hot {:.0} ms, read {:.0} MB/s",
        l.ready_ms / 1000.0,
        secs(l.startup_ms),
        secs(l.weights_ms),
        secs(l.serve_ms),
        l.first_token_ms,
        l.hot_token_ms,
        mbps
    )
}

fn secs(ms: Option<f64>) -> String {
    ms.map(|m| format!("{:.2}s", m / 1000.0)).unwrap_or_else(|| "n/a".into())
}

/// Refuse a load that would leave less than `min_free_gb` of memory.
fn guard(size: u64, min_free_gb: f64) -> anyhow::Result<()> {
    let available = nekko_machine::memory::state(false).available_bytes as f64;
    let after = (available - size as f64) / 1e9;
    if after < min_free_gb {
        anyhow::bail!(
            "stopping: {:.1} GB available, {:.1} GB after this model, under the {min_free_gb} GB headroom",
            available / 1e9,
            after
        );
    }
    Ok(())
}

#[derive(Default)]
struct Marks {
    loading: Option<f64>,
    loaded: Option<f64>,
    tail: Vec<String>,
}

/// `0.03.601.987` (minutes, seconds, ms, µs since the server started) in ms.
fn log_ms(line: &str) -> Option<f64> {
    // A colored log wraps the stamp in escapes: `\x1b[34m0.00.116.388\x1b[0m`.
    let stamp = line.split_whitespace().next()?;
    let stamp = match stamp.strip_prefix("\x1b[") {
        Some(rest) => rest.split_once('m')?.1.split('\x1b').next()?,
        None => stamp,
    };
    let parts: Vec<f64> = stamp.split('.').map(|p| p.parse::<f64>().ok()).collect::<Option<_>>()?;
    match parts[..] {
        [m, s, ms, us] => Some(m * 60_000.0 + s * 1000.0 + ms + us / 1000.0),
        _ => None,
    }
}

async fn load(cfg: &Config, http: &reqwest::Client, model: &Model, path: &Path) -> anyhow::Result<Load> {
    let port = cfg.port.to_string();
    let mut cmd = tokio::process::Command::new(&cfg.server);
    cmd.arg("-m").arg(path).args(["--host", "127.0.0.1", "--port", &port]);
    cmd.args(["--log-colors", "off"]).args(&cfg.args).args(&model.args);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    let started = Instant::now();
    let mut child = cmd.spawn()?;

    let marks = Arc::new(Mutex::new(Marks::default()));
    let stderr = child.stderr.take().expect("piped");
    let sink = marks.clone();
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut m = sink.lock().unwrap();
            if line.contains("load_model: loading model") {
                m.loading = m.loading.or(log_ms(&line));
            } else if line.contains("model loaded") {
                m.loaded = m.loaded.or(log_ms(&line));
            }
            m.tail.push(line);
            if m.tail.len() > 12 {
                m.tail.remove(0);
            }
        }
    });

    let health = format!("http://127.0.0.1:{port}/health");
    let ready = loop {
        if let Some(status) = child.try_wait()? {
            let tail = marks.lock().unwrap().tail.join("\n");
            anyhow::bail!("the server exited ({status}) before it was ready:\n{tail}");
        }
        if started.elapsed() > LOAD_TIMEOUT {
            let _ = child.kill().await;
            anyhow::bail!("the server was not ready within {}s", LOAD_TIMEOUT.as_secs());
        }
        let ok = match http.get(&health).timeout(Duration::from_secs(1)).send().await {
            Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default().contains("\"ok\""),
            _ => false,
        };
        if ok {
            break started.elapsed().as_secs_f64() * 1000.0;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };

    let target = Target {
        name: model.name.clone(),
        base_url: format!("http://127.0.0.1:{port}/v1"),
        model: "bench".into(),
        api_key: None,
        extra: None,
    };
    let ask = |q: &str| vec![json!({ "role": "user", "content": q })];
    let first = client::chat(http, &target, &ask("Say hi."), 8).await;
    let hot = client::chat(http, &target, &ask("Name one color."), 8).await;
    let exited = child.try_wait().ok().flatten();
    let _ = child.kill().await;
    let _ = child.wait().await;
    reader.abort();
    let failed = |e: anyhow::Error| {
        let tail = marks.lock().unwrap().tail.join("\n");
        anyhow::anyhow!("a request after the load failed ({e}); server exit: {exited:?}\n{tail}")
    };
    let (first, _) = first.map_err(failed)?;
    let (hot, _) = hot.map_err(failed)?;

    let m = marks.lock().unwrap();
    Ok(Load {
        ready_ms: ready,
        startup_ms: m.loading,
        weights_ms: m.loading.zip(m.loaded).map(|(a, b)| b - a),
        serve_ms: m.loaded.map(|b| ready - b),
        first_token_ms: first.ttft_ms,
        hot_token_ms: hot.ttft_ms,
    })
}

/* ------------------------------------------------------------ uncached I/O */

/// A buffer aligned for uncached reads and writes.
struct Aligned {
    ptr: *mut u8,
    layout: std::alloc::Layout,
}

impl Aligned {
    fn new(len: usize) -> Self {
        let layout = std::alloc::Layout::from_size_align(len, ALIGN).expect("layout");
        // SAFETY: the layout has a non-zero size.
        let ptr = unsafe { std::alloc::alloc_zeroed(layout) };
        assert!(!ptr.is_null(), "out of memory");
        Self { ptr, layout }
    }
    fn as_mut(&mut self) -> &mut [u8] {
        // SAFETY: `ptr` holds `layout.size()` initialized bytes owned by self.
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.layout.size()) }
    }
}

impl Drop for Aligned {
    fn drop(&mut self) {
        // SAFETY: allocated in `new` with this layout.
        unsafe { std::alloc::dealloc(self.ptr, self.layout) }
    }
}

#[cfg(windows)]
mod uncached {
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::Path;

    const FILE_FLAG_NO_BUFFERING: u32 = 0x2000_0000;
    const FILE_FLAG_WRITE_THROUGH: u32 = 0x8000_0000;

    pub fn open_read(p: &Path) -> std::io::Result<File> {
        OpenOptions::new().read(true).custom_flags(FILE_FLAG_NO_BUFFERING).open(p)
    }
    pub fn create(p: &Path) -> std::io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH)
            .open(p)
    }
    /// Uncached writes are whole sectors: pad the tail, trim it afterwards.
    pub const PADS: bool = true;
    pub fn evict(_: &File) {}
}

#[cfg(target_os = "macos")]
mod uncached {
    use std::fs::{File, OpenOptions};
    use std::os::fd::AsRawFd;
    use std::path::Path;

    fn nocache(f: File) -> File {
        // SAFETY: a valid descriptor; F_NOCACHE only changes caching.
        unsafe { libc::fcntl(f.as_raw_fd(), libc::F_NOCACHE, 1) };
        f
    }
    pub fn open_read(p: &Path) -> std::io::Result<File> {
        OpenOptions::new().read(true).open(p).map(nocache)
    }
    pub fn create(p: &Path) -> std::io::Result<File> {
        OpenOptions::new().write(true).create(true).truncate(true).open(p).map(nocache)
    }
    pub const PADS: bool = false;
    pub fn evict(_: &File) {}
}

#[cfg(all(unix, not(target_os = "macos")))]
mod uncached {
    use std::fs::{File, OpenOptions};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;

    /// Some filesystems (tmpfs) refuse O_DIRECT; their pages are memory anyway.
    pub fn open_read(p: &Path) -> std::io::Result<File> {
        OpenOptions::new().read(true).custom_flags(libc::O_DIRECT).open(p).or_else(|_| File::open(p))
    }
    pub fn create(p: &Path) -> std::io::Result<File> {
        OpenOptions::new().write(true).create(true).truncate(true).open(p)
    }
    pub const PADS: bool = false;
    /// Written through the cache, then dropped from it once on disk.
    pub fn evict(f: &File) {
        let _ = f.sync_all();
        // SAFETY: a valid descriptor; DONTNEED only drops clean cached pages.
        unsafe { libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    }
}

/// Copy `src` to `dst` without leaving either in the OS cache.
fn cold_copy(src: &Path, dst: &Path) -> anyhow::Result<()> {
    let mut input = uncached::open_read(src)?;
    let mut output = uncached::create(dst)?;
    let mut buf = Aligned::new(CHUNK);
    let mut total = 0u64;
    loop {
        let n = input.read(buf.as_mut())?;
        if n == 0 {
            break;
        }
        let len = if uncached::PADS { n.div_ceil(ALIGN) * ALIGN } else { n };
        output.write_all(&buf.as_mut()[..len])?;
        total += n as u64;
    }
    uncached::evict(&output);
    drop(output);
    if uncached::PADS {
        std::fs::OpenOptions::new().write(true).open(dst)?.set_len(total)?;
    }
    Ok(())
}

/// Sequential read of up to `limit` bytes with the cache bypassed, MB/s.
fn raw_read_mbps(path: &Path, limit: u64) -> anyhow::Result<f64> {
    let mut f = uncached::open_read(path)?;
    let mut buf = Aligned::new(CHUNK);
    let (t, mut total) = (Instant::now(), 0u64);
    while total < limit {
        let n = f.read(buf.as_mut())?;
        if n == 0 {
            break;
        }
        total += n as u64;
    }
    Ok(total as f64 / 1e6 / t.elapsed().as_secs_f64())
}

/// Read the whole file through the cache (what a prefetch does), MB/s.
fn cached_read_mbps(path: &Path) -> anyhow::Result<f64> {
    let mut f = File::open(path)?;
    let mut buf = vec![0u8; CHUNK];
    let (t, mut total) = (Instant::now(), 0u64);
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
    }
    Ok(total as f64 / 1e6 / t.elapsed().as_secs_f64())
}

/* ---------------------------------------------------------------- report */

fn median(xs: impl Iterator<Item = f64>) -> Option<f64> {
    let mut v: Vec<f64> = xs.filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let mid = v.len() / 2;
    Some(if v.len() % 2 == 0 { (v[mid - 1] + v[mid]) / 2.0 } else { v[mid] })
}

fn markdown(r: &Report) -> String {
    let mut s = format!(
        "Machine: **{}** · server args `{}` · median of {} runs\n\n\
         | Model | Size | Volume | From | Read MB/s | Ready | Startup | Weights | Serve | First token | Hot token |\n\
         | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n",
        r.machine,
        r.args.join(" "),
        r.repeats
    );
    let ms = |v: Option<f64>| v.map(|x| format!("{:.2} s", x / 1000.0)).unwrap_or_else(|| "n/a".into());
    let small = |v: Option<f64>| v.map(|x| format!("{x:.0} ms")).unwrap_or_else(|| "n/a".into());
    for m in &r.models {
        for v in &m.volumes {
            for (from, loads, reads) in [("cold", &v.cold, &v.raw_read_mbps), ("warm", &v.warm, &v.cached_read_mbps)] {
                if loads.is_empty() {
                    continue;
                }
                let get = |f: fn(&Load) -> Option<f64>| median(loads.iter().filter_map(f));
                s.push_str(&format!(
                    "| {} | {:.2} GB | {} | {from} | {} | {} | {} | {} | {} | {} | {} |\n",
                    m.name,
                    m.size_bytes as f64 / 1e9,
                    v.volume,
                    median(reads.iter().copied()).map(|x| format!("{x:.0}")).unwrap_or_else(|| "n/a".into()),
                    ms(get(|l| Some(l.ready_ms))),
                    ms(get(|l| l.startup_ms)),
                    ms(get(|l| l.weights_ms)),
                    ms(get(|l| l.serve_ms)),
                    small(get(|l| Some(l.first_token_ms))),
                    small(get(|l| Some(l.hot_token_ms))),
                ));
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_servers_log_clock() {
        assert_eq!(log_ms("0.03.601.987 I srv    load_model: initializing"), Some(3601.987));
        assert_eq!(log_ms("1.02.000.500 I srv  llama_server: model loaded"), Some(62_000.5));
        assert_eq!(log_ms("load: control-looking token"), None);
        assert_eq!(log_ms("\x1b[34m0.00.116.388\x1b[0m W srv  llama_server"), Some(116.388));
    }

    #[test]
    fn copies_uncached_byte_for_byte() {
        let dir = std::env::temp_dir().join(format!("nekko-switch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (src, dst) = (dir.join("src.bin"), dir.join("dst.bin"));
        // Not a whole number of sectors, and more than one chunk.
        let data: Vec<u8> = (0..CHUNK + 12_345).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &data).unwrap();
        cold_copy(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), data);
        assert!(raw_read_mbps(&dst, RAW_READ_LIMIT).unwrap() > 0.0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn medians_skip_missing_values() {
        assert_eq!(median([3.0, 1.0, 2.0].into_iter()), Some(2.0));
        assert_eq!(median([4.0, 1.0].into_iter()), Some(2.5));
        assert_eq!(median(std::iter::empty()), None);
    }
}
