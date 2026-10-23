//! The hardware profile (`machine:profile`): what this machine is, as the
//! model recommendations need it, kept in `<data>/machine-profile.json` so
//! the Models page can answer before a fresh probe (`nvidia-smi`,
//! `vulkaninfo`) finishes.
//!
//! It records what the machine *has*, not what is free right now: totals,
//! never the free figures the fit planner reads per load. A saved profile is
//! reused for a week, and probed again sooner when the installed engine build
//! changes or the caller asks.

use crate::probe::{Machine, engine_record, run_ok};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FILE: &str = "machine-profile.json";
const FORMAT: u32 = 1;
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// One GPU, as the probe found it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    /// Total memory on the card; on Apple Silicon, the shared pool.
    pub vram_bytes: f64,
    /// GPU core count, where the OS reports one (Apple Silicon): it separates
    /// variants that share a name but not a memory bus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cores: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub cores: usize,
}

/// The engine build installed, from its record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineBuild {
    pub backend: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub format: u32,
    /// When the probe ran, in ms since the epoch.
    pub probed_at: u64,
    pub platform: String,
    pub arch: String,
    pub release: String,
    pub cpu: Cpu,
    pub ram_bytes: f64,
    /// One memory pool for CPU and GPU (Apple Silicon).
    pub unified: bool,
    pub gpus: Vec<Gpu>,
    /// Compute backends the machine can run (`cuda`, `vulkan`, `metal`, `cpu`).
    pub backends: Vec<String>,
    pub engine: Option<EngineBuild>,
    /// Free space where models are stored; read fresh on every answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_free_bytes: Option<f64>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `"gpu-core-count" = 40` from `ioreg -c IOAccelerator`.
pub fn ioreg_gpu_cores(stdout: &str) -> Option<u32> {
    let at = stdout.find("\"gpu-core-count\"")?;
    let rest = stdout[at..].split_once('=')?.1.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// The installed engine's build, from `<data>/engine/engine.json`.
pub fn engine_build(data_dir: Option<&Path>) -> Option<EngineBuild> {
    let record = engine_record(data_dir?)?;
    let backend = record.get("backend")?.as_str()?.to_string();
    let version = record.get("version").and_then(|v| v.as_str()).map(str::to_string);
    Some(EngineBuild { backend, version })
}

/// A saved profile still describes this machine: recent, same format, same engine build.
pub fn still_current(saved: &HardwareProfile, engine: &Option<EngineBuild>, now: u64) -> bool {
    saved.format == FORMAT
        && now.saturating_sub(saved.probed_at) < MAX_AGE.as_millis() as u64
        && saved.engine == *engine
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

impl Machine {
    fn profile_path(&self) -> Option<PathBuf> {
        self.data_dir().map(|d| d.join(FILE))
    }

    /// `machine:profile`: the saved profile while it is current, else a fresh
    /// probe, saved for next time. `refresh` always probes.
    pub async fn profile(&self, refresh: bool) -> HardwareProfile {
        let engine = engine_build(self.data_dir());
        let disk_free = match self.data_dir().map(Path::to_path_buf) {
            Some(dir) => tokio::task::spawn_blocking(move || crate::probe::disk_free(&dir)).await.ok().flatten(),
            None => None,
        };
        let path = self.profile_path();
        if !refresh
            && let Some(saved) = path
                .as_ref()
                .and_then(|p| std::fs::read(p).ok())
                .and_then(|b| serde_json::from_slice::<HardwareProfile>(&b).ok())
            && still_current(&saved, &engine, now_ms())
        {
            return HardwareProfile { disk_free_bytes: disk_free, ..saved };
        }
        let mut profile = self.probe_profile(engine).await;
        profile.disk_free_bytes = disk_free;
        if let Some(p) = path
            && let Ok(text) = serde_json::to_string_pretty(&profile)
        {
            // Best-effort: a profile that cannot be saved is still the answer.
            let _ = write_atomic(&p, &text);
        }
        profile
    }

    async fn probe_profile(&self, engine: Option<EngineBuild>) -> HardwareProfile {
        let facts = self.facts().await;
        let (cpu_model, cpu_cores) = {
            let sys = sysinfo::System::new_with_specifics(
                sysinfo::RefreshKind::nothing().with_cpu(sysinfo::CpuRefreshKind::nothing()),
            );
            let model = sys.cpus().first().map(|c| nekko_js::trim(c.brand()).to_string()).filter(|m| !m.is_empty());
            (model, sys.cpus().len())
        };
        let apple_cores = if cfg!(target_os = "macos") {
            run_ok("ioreg", &["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], Duration::from_secs(4))
                .await
                .as_deref()
                .and_then(ioreg_gpu_cores)
        } else {
            None
        };
        HardwareProfile {
            format: FORMAT,
            probed_at: now_ms(),
            platform: facts.platform,
            arch: facts.arch,
            release: facts.release,
            cpu: Cpu { model: cpu_model, cores: cpu_cores },
            ram_bytes: facts.ram_total,
            unified: facts.unified,
            gpus: facts
                .devices
                .into_iter()
                .map(|d| Gpu {
                    name: d.name,
                    vram_bytes: d.total_bytes,
                    cores: if facts.unified { apple_cores } else { None },
                })
                .collect(),
            backends: facts.backends,
            engine,
            disk_free_bytes: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(probed_at: u64, engine: Option<EngineBuild>) -> HardwareProfile {
        HardwareProfile {
            format: FORMAT,
            probed_at,
            platform: "win32".into(),
            arch: "x64".into(),
            release: "10.0.26100".into(),
            cpu: Cpu { model: None, cores: 16 },
            ram_bytes: 64.0 * 1024.0 * 1024.0 * 1024.0,
            unified: false,
            gpus: vec![],
            backends: vec!["cuda".into(), "vulkan".into()],
            engine,
            disk_free_bytes: None,
        }
    }

    #[test]
    fn reads_the_gpu_core_count() {
        let out = "+-o AGXAcceleratorG17X  <class AGXAcceleratorG17X>\n    {\n      \"model\" = \"Apple M5 Max\"\n      \"gpu-core-count\" = 40\n    }";
        assert_eq!(ioreg_gpu_cores(out), Some(40));
        assert_eq!(ioreg_gpu_cores("\"model\" = \"Apple M1\""), None);
    }

    #[test]
    fn a_saved_profile_is_reused_until_it_ages_or_the_engine_changes() {
        let cuda = Some(EngineBuild { backend: "cuda".into(), version: Some("b11224".into()) });
        let day = 24 * 3600 * 1000;
        let saved = profile(10 * day, cuda.clone());
        assert!(still_current(&saved, &cuda, 12 * day));
        assert!(!still_current(&saved, &cuda, 18 * day), "a week old");
        let vulkan = Some(EngineBuild { backend: "vulkan".into(), version: Some("b11224".into()) });
        assert!(!still_current(&saved, &vulkan, 11 * day), "another build");
        assert!(!still_current(&saved, &None, 11 * day), "engine removed");
        assert!(!still_current(&HardwareProfile { format: 0, ..saved }, &cuda, 11 * day), "an older format");
    }

    #[test]
    fn round_trips_as_camel_case_json() {
        let p = HardwareProfile {
            gpus: vec![Gpu { name: "NVIDIA GeForce RTX 5090".into(), vram_bytes: 34_359_738_368.0, cores: None }],
            ..profile(1, None)
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["gpus"][0]["vramBytes"], serde_json::json!(34_359_738_368.0));
        assert!(v["gpus"][0].get("cores").is_none());
        assert_eq!(serde_json::from_value::<HardwareProfile>(v).unwrap(), p);
    }
}
