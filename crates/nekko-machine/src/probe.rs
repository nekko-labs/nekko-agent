//! The probes themselves: processes, the OS and the disk, with the TS host's
//! timeouts and caches. Every probe is best-effort and answers `None` rather
//! than failing.

use crate::parse::{self, GpuStats};
use crate::readiness::{Device, MachineFacts};
use crate::{js_round, num};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MB: f64 = 1024.0 * 1024.0;

/// Run a command hidden, resolving its stdout (and, with `combined`, stderr
/// after it), or `None` on a spawn failure, a non-zero exit or a timeout. The
/// child is killed if it outlives the timeout.
async fn run(cmd: &Path, args: &[&str], timeout: Duration, combined: bool) -> Option<(bool, String)> {
    let mut command = tokio::process::Command::new(cmd);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().ok()?;
    let out = tokio::time::timeout(timeout, child.wait_with_output()).await.ok()?.ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let text = if combined { format!("{stdout}\n{}", String::from_utf8_lossy(&out.stderr)) } else { stdout };
    Some((out.status.success(), text))
}

/// `execFile` that resolves stdout only on success.
pub(crate) async fn run_ok(cmd: &str, args: &[&str], timeout: Duration) -> Option<String> {
    match run(Path::new(cmd), args, timeout, false).await? {
        (true, text) => Some(text),
        _ => None,
    }
}

/// Node's `process.platform`.
pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// Node's `os.arch()`.
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        other => other,
    }
}

/// Node's `os.release()`: the kernel release on Unix, `major.minor.build` on Windows.
pub fn release() -> String {
    #[cfg(unix)]
    {
        // SAFETY: uname fills a zeroed struct; `release` is NUL-terminated.
        unsafe {
            let mut u: libc::utsname = std::mem::zeroed();
            if libc::uname(&mut u) != 0 {
                return String::new();
            }
            std::ffi::CStr::from_ptr(u.release.as_ptr()).to_string_lossy().into_owned()
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
        }
        // SAFETY: RtlGetVersion fills the struct whose size we set; unlike
        // GetVersionExW it does not lie to unmanifested programs.
        unsafe {
            let mut info: OSVERSIONINFOW = std::mem::zeroed();
            info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
            if RtlGetVersion(&mut info) != 0 {
                return String::new();
            }
            format!("{}.{}.{}", info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber)
        }
    }
}

/// Free bytes on the volume holding `dir` (`statfs(dir).bavail * bsize`).
pub fn disk_free(dir: &Path) -> Option<f64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        // SAFETY: statvfs reads a NUL-terminated path into a zeroed struct.
        unsafe {
            let mut s: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(c.as_ptr(), &mut s) != 0 {
                return None;
            }
            // The field types differ by platform (u32 on macOS, u64 on Linux).
            #[allow(clippy::unnecessary_cast)]
            let free = s.f_bavail as f64 * s.f_frsize as f64;
            Some(free)
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut available = 0u64;
        // SAFETY: a NUL-terminated wide path and out-pointers to locals.
        let ok =
            unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
        (ok != 0).then_some(available as f64)
    }
}

/// `os.totalmem()` and `os.freemem()` now, in bytes.
pub fn memory_now() -> (f64, f64) {
    memory(&mut sysinfo::System::new())
}

/// System memory as Node reports it: `os.totalmem()` and `os.freemem()`
/// (available memory on Windows and Linux, free pages on macOS, as libuv reads them).
fn memory(sys: &mut sysinfo::System) -> (f64, f64) {
    sys.refresh_memory();
    let free = if cfg!(target_os = "macos") { sys.free_memory() } else { sys.available_memory() };
    (sys.total_memory() as f64, free as f64)
}

/// Where the engine's `llama-server` lives, for the GPU fallback probe: the
/// user's own binary (`engineBinPath` in settings, passed in), the managed install's
/// record (`<data>/engine/engine.json`), then PATH, as `installedBin` looks.
pub fn engine_bin(data_dir: Option<&Path>, external: Option<String>) -> Option<PathBuf> {
    let is_file = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.is_file());
    if let Some(p) = external.filter(|p| !p.is_empty()).map(PathBuf::from).filter(|p| is_file(p)) {
        return Some(p);
    }
    if let Some(dir) = data_dir {
        let managed = engine_record(dir).and_then(|r| r.get("binPath").and_then(Value::as_str).map(PathBuf::from));
        if let Some(p) = managed.filter(|p| is_file(p)) {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .find_map(|dir| ["llama-server", "llama-server.exe"].iter().map(|n| dir.join(n)).find(|p| is_file(p)))
}

/// The managed engine's install record, `<data>/engine/engine.json`.
pub(crate) fn engine_record(data_dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(data_dir.join("engine").join("engine.json")).ok()?).ok()
}

struct Cached<T> {
    at: Instant,
    value: T,
}

/// The user's own `llama-server` path (`engineBinPath`), read when it is needed.
pub type ExternalBin = Box<dyn Fn() -> Option<String> + Send + Sync>;

/// The probes with their state: the GPU caches and the CPU-time baseline.
pub struct Machine {
    data_dir: Option<PathBuf>,
    external_bin: ExternalBin,
    gpu: tokio::sync::Mutex<Option<Cached<Option<GpuStats>>>>,
    engine_gpu: tokio::sync::Mutex<Option<Cached<Option<GpuStats>>>>,
    cpu: tokio::sync::Mutex<(sysinfo::System, Option<Instant>)>,
}

/// A polling meter reads the GPU at most this often.
const GPU_TTL: Duration = Duration::from_secs(1);
/// The llama-server fallback is a process spawn (~0.5-1 s), so it is read far less often.
const ENGINE_TTL: Duration = Duration::from_secs(15);
/// Past this gap the CPU baseline is too old to be a useful interval.
const CPU_STALE: Duration = Duration::from_secs(30);
/// The first reading measures over a short window rather than since boot
/// (sysinfo needs at least 200 ms between CPU refreshes; Node's was 180 ms).
const CPU_PRIME: Duration = Duration::from_millis(200);

impl Machine {
    pub fn new(data_dir: Option<PathBuf>, external_bin: ExternalBin) -> Self {
        Self {
            data_dir,
            external_bin,
            gpu: tokio::sync::Mutex::new(None),
            engine_gpu: tokio::sync::Mutex::new(None),
            cpu: tokio::sync::Mutex::new((sysinfo::System::new(), None)),
        }
    }

    /// Where the daemon keeps its data, when it knows.
    pub fn data_dir(&self) -> Option<&Path> {
        self.data_dir.as_deref()
    }

    /// `gpu:stats`: one probe at a time, shared by every caller inside the TTL.
    pub async fn gpu_stats(&self) -> Option<GpuStats> {
        let mut cache = self.gpu.lock().await;
        if let Some(c) = cache.as_ref()
            && c.at.elapsed() < GPU_TTL
        {
            return c.value.clone();
        }
        let stats = self.probe_gpu().await;
        *cache = Some(Cached { at: Instant::now(), value: stats.clone() });
        stats
    }

    /// A reading taken now rather than from the cache (`getGpuStatsFresh`):
    /// the before/after pair around a model load is a measurement.
    pub async fn gpu_stats_fresh(&self) -> Option<GpuStats> {
        let stats = self.probe_gpu().await;
        *self.gpu.lock().await = Some(Cached { at: Instant::now(), value: stats.clone() });
        stats
    }

    /// macOS never has `nvidia-smi`, so it goes straight to the registry.
    async fn probe_gpu(&self) -> Option<GpuStats> {
        if cfg!(target_os = "macos") {
            let out =
                run_ok("ioreg", &["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], Duration::from_secs(4)).await?;
            let total = js_round(
                sysinfo::System::new_with_specifics(
                    sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()),
                )
                .total_memory() as f64
                    / MB,
            );
            return parse::ioreg_stats(&out, total);
        }
        // Temperature rides on the same query; a driver too old to know the
        // field fails the whole query, so it is asked again without it.
        let mut smi = run_ok(
            "nvidia-smi",
            &[
                "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            Duration::from_secs(4),
        )
        .await;
        if smi.is_none() {
            smi = run_ok(
                "nvidia-smi",
                &[
                    "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu",
                    "--format=csv,noheader,nounits",
                ],
                Duration::from_secs(4),
            )
            .await;
        }
        if let Some(stats) = smi.as_deref().and_then(parse::parse_nvidia_smi) {
            return Some(stats);
        }
        self.engine_devices().await
    }

    /// The engine's own `llama-server --list-devices`, where `nvidia-smi` is
    /// missing or fails (old drivers, AMD and Intel GPUs).
    async fn engine_devices(&self) -> Option<GpuStats> {
        let mut cache = self.engine_gpu.lock().await;
        if let Some(c) = cache.as_ref()
            && c.at.elapsed() < ENGINE_TTL
        {
            return c.value.clone();
        }
        let stats = match engine_bin(self.data_dir.as_deref(), (self.external_bin)()) {
            Some(bin) => match run(&bin, &["--list-devices"], Duration::from_secs(15), true).await {
                Some((_, text)) => parse::listed_to_stats(&parse::parse_list_devices(&text)),
                None => None,
            },
            None => None,
        };
        *cache = Some(Cached { at: Instant::now(), value: stats.clone() });
        stats
    }

    /// `system:stats`: CPU busy share since the last reading, and RAM.
    pub async fn system_stats(&self) -> Option<Value> {
        let mut guard = self.cpu.lock().await;
        let (sys, last) = &mut *guard;
        if last.is_none_or(|t| t.elapsed() > CPU_STALE) {
            sys.refresh_cpu_all();
            tokio::time::sleep(CPU_PRIME).await;
        }
        sys.refresh_cpu_all();
        *last = Some(Instant::now());
        let cpu_pct = js_round(f64::from(sys.global_cpu_usage()).clamp(0.0, 100.0));
        let cores = sys.cpus().len();
        let model = sys.cpus().first().map(|c| nekko_js::trim(c.brand()).to_string()).filter(|m| !m.is_empty());
        let (total, free) = memory(sys);
        drop(guard);
        let total_mb = js_round(total / MB);
        let mut used_mb = (total_mb - js_round(free / MB)).max(0.0);
        if cfg!(target_os = "macos") {
            // VM page accounting excludes reclaimable file cache, matching
            // Activity Monitor's Memory Used. No reading beats a wrong one.
            let out = run_ok("/usr/bin/vm_stat", &[], Duration::from_secs(2)).await?;
            used_mb = total_mb.min(parse::mac_memory_used_mb(&out)?);
        }
        let mut o = serde_json::Map::new();
        o.insert("cpuPct".into(), num(cpu_pct));
        o.insert("cpuCores".into(), json!(cores));
        if let Some(m) = model {
            o.insert("cpuModel".into(), json!(m));
        }
        o.insert("memUsedMB".into(), num(used_mb));
        o.insert("memTotalMB".into(), num(total_mb));
        // Sensors are best-effort: absent rather than a failed reading.
        if let Ok(Some(temps)) = tokio::task::spawn_blocking(crate::temps::read).await {
            o.insert("temps".into(), temps);
        }
        Some(Value::Object(o))
    }

    /// `gatherMachineFacts`: what the readiness advisor plans against.
    pub async fn facts(&self) -> MachineFacts {
        let (gpu, cpu_features, backends) = tokio::join!(self.gpu_stats(), cpu_features(), backends());
        let disk_free = match self.data_dir.clone() {
            Some(dir) => tokio::task::spawn_blocking(move || disk_free(&dir)).await.ok().flatten(),
            None => None,
        };
        let mut sys = sysinfo::System::new();
        let (ram_total, ram_free) = memory(&mut sys);
        MachineFacts {
            platform: platform().into(),
            release: release(),
            arch: arch().into(),
            cpu_features,
            backends,
            devices: gpu
                .as_ref()
                .map(|g| {
                    g.devices
                        .iter()
                        .map(|d| Device {
                            name: d.name.clone(),
                            total_bytes: d.total_mb * MB,
                            free_bytes: d.free_mb * MB,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            unified: gpu.is_some_and(|g| g.unified),
            ram_total,
            ram_free,
            disk_free,
        }
    }

    /// `machine:readiness`.
    pub async fn readiness(&self, language: &str) -> Value {
        let facts = self.facts().await;
        crate::readiness::evaluate(&facts, crate::readiness::catalog(), language)
    }
}

/// Instruction features we can prove: Linux's `/proc/cpuinfo`, macOS's
/// `hw.optional.*`. Windows stays `None` (the flags need CPUID).
async fn cpu_features() -> Option<Vec<String>> {
    if cfg!(target_os = "linux") {
        let text = tokio::fs::read("/proc/cpuinfo").await.ok()?;
        return parse::cpuinfo_features(&String::from_utf8_lossy(&text));
    }
    if cfg!(target_os = "macos") {
        let out = run_ok("sysctl", &["-a"], Duration::from_secs(4)).await?;
        return Some(parse::sysctl_features(&out));
    }
    None
}

/// Compute backends the machine can run.
async fn backends() -> Vec<String> {
    if cfg!(target_os = "macos") {
        return if arch() == "arm64" { vec!["metal".into(), "cpu".into()] } else { vec!["cpu".into()] };
    }
    let smi = run_ok("nvidia-smi", &["-L"], Duration::from_secs(4)).await;
    let vk = run_ok("vulkaninfo", &["--summary"], Duration::from_secs(4)).await;
    parse::gpu_backends(smi.as_deref(), vk.as_deref())
}
