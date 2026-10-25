//! Reading the Mac for the runner gates. `HostSense` samples every reading the
//! supervisor needs into a `MacState` once a tick, and `signals_for` maps it to
//! the pure `nekko_runner::Signals`. Sources, all public and on-device:
//! input idle time and power from `nekko_machine`'s activity sampler; CPU and
//! memory from its system stats (minus the job VMs' own processes); thermal
//! state, Low Power Mode and memory pressure from `nekko-vm host`; the egress
//! interface from `nekko-vm egress`; the network from the router's hardware
//! address (`lan.rs`); pending security updates from `softwareupdate` (`updates.rs`).

use super::egress::{Egress, spawn_line_watch};
use super::lan::{default_gateway, network_id};
use super::updates::{UpdateLedger, os_major, security_labels, write_atomic};
use nekko_machine::Machine;
use nekko_machine::activity::Power;
use nekko_runner::{Pressure, RunnerSettings, Signals, Thermal};
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// One line of `nekko-vm host`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostState {
    pub thermal: Thermal,
    pub low_power_mode: bool,
    pub memory: Pressure,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostLine {
    thermal: Thermal,
    low_power_mode: bool,
    memory_pressure: Pressure,
}

/// One line of the helper's `host` output; `None` if it does not parse.
pub fn parse_host_state(line: &str) -> Option<HostState> {
    let l: HostLine = serde_json::from_str(line).ok()?;
    Some(HostState { thermal: l.thermal, low_power_mode: l.low_power_mode, memory: l.memory_pressure })
}

/// Everything read from the Mac in one tick.
#[derive(Debug, Clone, PartialEq)]
pub struct MacState {
    /// Unix seconds by the wall clock, which keeps counting through sleep.
    pub wall_secs: f64,
    pub idle_seconds: Option<f64>,
    /// The owner's CPU use (job VMs excluded), a 30-second average.
    pub user_cpu_pct: f64,
    pub power: Option<Power>,
    /// `None` until `nekko-vm host` has spoken, and while it restarts.
    pub host: Option<HostState>,
    pub egress: Option<Egress>,
    pub host_nets_ok: bool,
    /// `gw:` plus the router's MAC; `None` when it cannot be read.
    pub network_id: Option<String>,
    pub free_disk_gb: f64,
    pub available_memory_mb: f64,
    pub ram_mb: u64,
    pub cores: u8,
    pub user_memory_mb: Option<u64>,
    pub security_update_overdue_days: Option<u32>,
    pub paused_all: bool,
}

pub fn signals_for(m: &MacState, s: &RunnerSettings) -> Signals {
    // Benign without a host line: `host_known` is false then, which holds new VMs.
    let host =
        m.host.unwrap_or(HostState { thermal: Thermal::Nominal, low_power_mode: false, memory: Pressure::Normal });
    let egress = m.egress.as_ref();
    Signals {
        idle_seconds: m.idle_seconds,
        user_cpu_pct: m.user_cpu_pct,
        memory: host.memory,
        thermal: host.thermal,
        on_battery: m.power.is_some_and(|p| p.on_battery),
        battery_pct: m.power.and_then(|p| p.percent),
        low_power_mode: host.low_power_mode,
        network_trusted: m.network_id.as_ref().is_some_and(|id| s.trusted_networks.contains(id)),
        network_expensive: egress.is_some_and(|e| e.expensive || e.constrained),
        // No schedule setting in P1.
        in_schedule: true,
        free_disk_gb: m.free_disk_gb,
        security_update_overdue_days: m.security_update_overdue_days,
        available_memory_mb: m.available_memory_mb,
        paused_all: m.paused_all,
        vpn_carries_default: egress.is_some_and(|e| e.vpn_carries_default),
        host_known: m.host.is_some() && m.egress.is_some() && m.host_nets_ok,
    }
}

/// The Mac's CPU use minus the job VMs': `vm_process_pct` is per core (100 =
/// one core), `global_pct` is of all cores. Floored at 0; NaN stays NaN.
pub fn user_cpu_pct(global_pct: f64, vm_process_pct: f64, cores: u8) -> f64 {
    let user = global_pct - vm_process_pct / f64::from(cores.max(1));
    if user.is_nan() { user } else { user.max(0.0) }
}

/// The last 6 readings, 30 s at the 5 s tick.
#[derive(Debug, Default)]
pub struct CpuWindow(VecDeque<f64>);

impl CpuWindow {
    /// Adds a reading and returns the window's mean.
    pub fn push(&mut self, pct: f64) -> f64 {
        if self.0.len() == 6 {
            self.0.pop_front();
        }
        self.0.push_back(pct);
        self.0.iter().sum::<f64>() / self.0.len() as f64
    }
}

const MEMORY_SAMPLE_SECS: u64 = 600;
const MEMORY_KEEP_SECS: u64 = 7 * 86_400;

/// The owner's memory use over the last 7 days (`<data>/runners/memory.json`),
/// for the usual-use reserve.
pub struct MemoryHistory {
    path: PathBuf,
    /// (unix secs, MB), oldest first.
    samples: Vec<(u64, u64)>,
}

impl MemoryHistory {
    pub fn load(runners_dir: &Path) -> MemoryHistory {
        let path = runners_dir.join("memory.json");
        let samples = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        MemoryHistory { path, samples }
    }

    /// Keeps at most one sample per 10 minutes, drops those older than 7 days, and saves.
    pub fn record(&mut self, now_secs: u64, used_mb: u64) {
        // abs_diff: a clock set back still samples instead of waiting it out.
        if self.samples.last().is_some_and(|&(at, _)| at.abs_diff(now_secs) < MEMORY_SAMPLE_SECS) {
            return;
        }
        self.samples.push((now_secs, used_mb));
        self.samples.retain(|&(at, _)| now_secs.saturating_sub(at) <= MEMORY_KEEP_SECS);
        let write =
            serde_json::to_vec(&self.samples).map_err(std::io::Error::other).and_then(|b| write_atomic(&self.path, &b));
        if let Err(e) = write {
            eprintln!("runner memory history: cannot save {}: {e}", self.path.display());
        }
    }

    pub fn usual(&self) -> Option<u64> {
        nekko_runner::usual_memory_mb(&self.samples.iter().map(|&(_, mb)| mb).collect::<Vec<_>>())
    }
}

/// Reads the Mac once a tick. A trait so the supervisor's tests can script it.
pub trait Sense: Send + Sync + 'static {
    fn sample(&self) -> impl Future<Output = MacState> + Send;
}

const VM_PROCESS: &str = "com.apple.Virtualization.VirtualMachine";
const NETWORK_EVERY: Duration = Duration::from_secs(30);
const UPDATES_EVERY: Duration = Duration::from_secs(6 * 3600);
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

pub struct HostSense {
    machine: Arc<Machine>,
    runners_dir: PathBuf,
    settings: Box<dyn Fn() -> Value + Send + Sync>,
    host: Arc<RwLock<Option<HostState>>>,
    egress: Arc<RwLock<Option<Egress>>>,
    host_nets_ok: Arc<AtomicBool>,
    running_vm_mb: Arc<AtomicU64>,
    procs: Arc<Mutex<sysinfo::System>>,
    cpu: Mutex<CpuWindow>,
    memory: Mutex<MemoryHistory>,
    network_id: Arc<RwLock<Option<String>>>,
    /// The last successful `softwareupdate` read; a failed run keeps it.
    update_labels: Arc<RwLock<Option<Vec<String>>>>,
    ledger: Mutex<UpdateLedger>,
}

impl HostSense {
    /// Starts the background readers; call inside the runtime. Without a
    /// helper the host state stays unknown, so no VM starts.
    pub fn new(
        machine: Arc<Machine>,
        runners_dir: PathBuf,
        settings: Box<dyn Fn() -> Value + Send + Sync>,
        helper: Option<PathBuf>,
        egress: Arc<RwLock<Option<Egress>>>,
        host_nets_ok: Arc<AtomicBool>,
        running_vm_mb: Arc<AtomicU64>,
    ) -> HostSense {
        let _ = std::fs::create_dir_all(&runners_dir);
        let host = match &helper {
            Some(h) => spawn_line_watch(h, "host", parse_host_state),
            None => Arc::new(RwLock::new(None)),
        };
        let network_id = Arc::new(RwLock::new(None));
        let update_labels = Arc::new(RwLock::new(None));
        // Without a helper nothing can start, so the slow readers stay off.
        if helper.is_some() {
            Self::spawn_readers(network_id.clone(), update_labels.clone());
        }
        HostSense {
            machine,
            memory: Mutex::new(MemoryHistory::load(&runners_dir)),
            ledger: Mutex::new(UpdateLedger::load(&runners_dir)),
            runners_dir,
            settings,
            host,
            egress,
            host_nets_ok,
            running_vm_mb,
            procs: Arc::new(Mutex::new(sysinfo::System::new())),
            cpu: Mutex::new(CpuWindow::default()),
            network_id,
            update_labels,
        }
    }

    /// The router's MAC every 30 s, and pending security updates every 6 h.
    fn spawn_readers(network_id: Arc<RwLock<Option<String>>>, update_labels: Arc<RwLock<Option<Vec<String>>>>) {
        let shared = network_id;
        tokio::spawn(async move {
            loop {
                let id = read_network_id().await;
                if let Ok(mut s) = shared.write() {
                    *s = id;
                }
                tokio::time::sleep(NETWORK_EVERY).await;
            }
        });
        let shared = update_labels;
        tokio::spawn(async move {
            loop {
                // 0 when unreadable: every macOS label then counts (fails closed).
                let major = output("/usr/bin/sw_vers", &["-productVersion"], Duration::from_secs(5)).await;
                let major = major.as_deref().map_or(0, os_major);
                let out = output("/usr/sbin/softwareupdate", &["--list", "--no-scan"], Duration::from_secs(120)).await;
                if let (Some(out), Ok(mut s)) = (out, shared.write()) {
                    *s = Some(security_labels(&out, major));
                }
                tokio::time::sleep(UPDATES_EVERY).await;
            }
        });
    }

    /// CPU of the VZ VM processes, per core (100 = one core).
    async fn vm_process_pct(&self) -> f64 {
        let procs = self.procs.clone();
        let read = move || {
            use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
            let Ok(mut sys) = procs.lock() else { return f64::NAN };
            let kind = ProcessRefreshKind::nothing().with_cpu().with_exe(UpdateKind::OnlyIfNotSet);
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
            sys.processes()
                .values()
                .filter(|p| p.name() == VM_PROCESS || p.exe().is_some_and(|e| e.ends_with(VM_PROCESS)))
                .map(|p| f64::from(p.cpu_usage()))
                .sum()
        };
        tokio::task::spawn_blocking(read).await.unwrap_or(f64::NAN)
    }
}

impl Sense for HostSense {
    async fn sample(&self) -> MacState {
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let dir = self.runners_dir.clone();
        let (activity, stats, vm_pct, disk) = tokio::join!(
            self.machine.activity(),
            self.machine.system_stats(),
            self.vm_process_pct(),
            tokio::task::spawn_blocking(move || nekko_machine::probe::disk_free(&dir)),
        );
        let num = |k: &str| stats.as_ref().and_then(|s| s.get(k)).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let (cpu_pct, used_mb, total_mb) = (num("cpuPct"), num("memUsedMB"), num("memTotalMB"));
        let cores = u8::try_from(num("cpuCores") as u64).unwrap_or(u8::MAX);
        let user_cpu = user_cpu_pct(cpu_pct, vm_pct, cores);
        let user_cpu_pct = self.cpu.lock().map_or(f64::NAN, |mut w| w.push(user_cpu));
        let user_memory_mb = self.memory.lock().ok().and_then(|mut h| {
            if used_mb.is_finite() {
                let vm_mb = self.running_vm_mb.load(Ordering::SeqCst);
                h.record(wall.as_secs(), (used_mb as u64).saturating_sub(vm_mb));
            }
            h.usual()
        });
        let labels = self.update_labels.read().ok().and_then(|l| l.clone());
        let security_update_overdue_days =
            labels.and_then(|l| self.ledger.lock().ok().and_then(|mut g| g.observe(&l, wall.as_secs())));
        MacState {
            wall_secs: wall.as_secs_f64(),
            idle_seconds: activity.idle_seconds,
            user_cpu_pct,
            power: activity.power,
            host: self.host.read().ok().and_then(|h| *h),
            egress: self.egress.read().ok().and_then(|e| e.clone()),
            host_nets_ok: self.host_nets_ok.load(Ordering::SeqCst),
            network_id: self.network_id.read().ok().and_then(|n| n.clone()),
            free_disk_gb: disk.ok().flatten().map_or(f64::NAN, |b| b / GIB),
            available_memory_mb: total_mb - used_mb,
            ram_mb: if total_mb.is_finite() { total_mb as u64 } else { 0 },
            cores,
            user_memory_mb,
            security_update_overdue_days,
            paused_all: nekko_js::truthy((self.settings)().get("automationsPaused")),
        }
    }
}

/// The router's hardware address, or `None` when either command fails.
pub(super) async fn read_network_id() -> Option<String> {
    let route = output("/sbin/route", &["-n", "get", "default"], Duration::from_secs(5)).await?;
    let gateway = default_gateway(&route)?;
    let arp = output("/usr/sbin/arp", &["-n", &gateway.to_string()], Duration::from_secs(5)).await?;
    network_id(&arp, gateway)
}

/// A command's stdout when it exits 0 within `limit`.
pub(super) async fn output(cmd: &str, args: &[&str], limit: Duration) -> Option<String> {
    let run = tokio::process::Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(limit, run).await.ok()?.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
#[path = "signals_tests.rs"]
mod tests;
