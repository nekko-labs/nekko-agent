//! What a job used inside its VM, and the VM size that fits a runner's jobs.
//!
//! The guest's boot script samples itself every 5 s onto a raw stats disk
//! (no filesystem): a header block nekkod wrote, then one line per sample,
//! `<unix secs> <idle %> <used MB> <compressed MB> <swapped-out MB so far>`,
//! padded with zero bytes. The guest is untrusted, so anything off that shape
//! drops the whole job's usage.

use serde::{Deserialize, Serialize};

use crate::settings::RunnerSettings;
use crate::slots::{HostFacts, MAX_MACOS_VMS, cpus_per_vm, runner_memory_mb};

/// Size of the stats disk nekkod makes for each VM.
pub const STATS_DISK_BYTES: usize = 1 << 20;
/// The first block of the stats disk; samples start right after it.
pub const STATS_HEADER: &[u8] = b"NEKKOSTATS1\n";
const STATS_BLOCK: usize = 512;

/// Jobs at the current size before a size is suggested.
pub const SUGGEST_MIN_JOBS: u32 = 3;
/// GitHub's standard hosted Mac, which passes the jobs routed to a runner.
pub const FLOOR_CPUS: u8 = 3;
pub const FLOOR_MEMORY_MB: u32 = 7 * 1024;
const MAX_MEMORY_PER_VM_MB: u32 = 64 * 1024;
const HEADROOM_MB: f64 = 2048.0;

/// One job's usage summary, kept on its audit line.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// The VM's size while the job ran.
    pub cpus: u8,
    pub memory_mb: u32,
    /// Busy vCPUs, 95th percentile.
    pub cpu_p95: f32,
    /// Share of samples with every vCPU nearly full (busy at least `cpus - 0.5`).
    pub cpu_full_share: f32,
    /// Wired plus app memory plus what the compressor holds; file cache left out.
    pub mem_peak_mb: u32,
    pub compressed_peak_mb: u32,
    pub swap_out_mb: u32,
}

/// The stats disk's starting contents: the header block, then zeros.
pub fn blank_stats_disk() -> Vec<u8> {
    let mut disk = vec![0u8; STATS_DISK_BYTES];
    disk[..STATS_HEADER.len()].copy_from_slice(STATS_HEADER);
    disk
}

/// Summarises the samples taken from `from_ts` on (when the job started). `None` when the disk is
/// not ours, any line is malformed, or fewer than 2 samples fall in the job.
pub fn parse_stats(disk: &[u8], cpus: u8, memory_mb: u32, from_ts: u64) -> Option<Usage> {
    if disk.len() > STATS_DISK_BYTES || disk.len() < STATS_BLOCK || !disk.starts_with(STATS_HEADER) {
        return None;
    }
    let body = &disk[STATS_BLOCK..];
    let body = &body[..body.iter().position(|&b| b == 0).unwrap_or(body.len())];
    let text = std::str::from_utf8(body).ok()?;
    let mut samples = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let f: Vec<f64> = line.split_ascii_whitespace().map(|v| v.parse::<f64>().ok()).collect::<Option<_>>()?;
        let [ts, idle, used, compressed, swapped] = f[..] else { return None };
        if f.iter().any(|v| !v.is_finite() || *v < 0.0) || idle > 100.0 {
            return None;
        }
        if ts >= from_ts as f64 {
            samples.push((idle, used, compressed, swapped));
        }
    }
    if samples.len() < 2 {
        return None;
    }
    let n = f64::from(cpus);
    let mut busy: Vec<f64> = samples.iter().map(|s| (100.0 - s.0) / 100.0 * n).collect();
    busy.sort_by(f64::total_cmp);
    let full = busy.iter().filter(|b| **b >= n - 0.5).count();
    let max = |i: fn(&(f64, f64, f64, f64)) -> f64| samples.iter().map(i).fold(0.0, f64::max);
    let swapped = samples.last()?.3 - samples[0].3;
    Some(Usage {
        cpus,
        memory_mb,
        cpu_p95: busy[(busy.len() * 95).div_ceil(100) - 1] as f32,
        cpu_full_share: (full as f64 / busy.len() as f64) as f32,
        mem_peak_mb: max(|s| s.1).round() as u32,
        compressed_peak_mb: max(|s| s.2).round() as u32,
        swap_out_mb: swapped.max(0.0).round() as u32,
    })
}

/// The VM size that fits a runner's jobs, from those that ran at its current size.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeSuggestion {
    /// Jobs at the current size the suggestion rests on.
    pub jobs: u32,
    /// Equal to the current size when it fits, or before `SUGGEST_MIN_JOBS` jobs.
    pub cpus: u8,
    pub memory_mb: u32,
    /// One sentence per change, including any limit that held it back.
    pub reasons: Vec<String>,
}

fn gb(mb: f64) -> String {
    format!("{:.1} GB", mb / 1024.0)
}

fn round_up_gb(mb: f64) -> u32 {
    (mb / 1024.0).ceil() as u32 * 1024
}

/// The spec's rules (CI runners, "Suggested VM size"): CPU and memory are judged separately, never
/// under GitHub's standard hosted Mac, never over what the Mac can give each requested slot.
pub fn suggest_size(jobs: &[Usage], s: &RunnerSettings, host: &HostFacts) -> SizeSuggestion {
    let (cpus, memory_mb) = (cpus_per_vm(s, host), s.memory_per_vm_mb);
    let here: Vec<&Usage> = jobs.iter().filter(|u| u.cpus == cpus && u.memory_mb == memory_mb).collect();
    let mut out = SizeSuggestion { jobs: here.len() as u32, cpus, memory_mb, reasons: vec![] };
    if out.jobs < SUGGEST_MIN_JOBS {
        return out;
    }
    let most = |f: fn(&Usage) -> f64| here.iter().map(|u| f(u)).fold(0.0, f64::max);

    let cpu_ceiling = host.cores.saturating_sub(2).max(2);
    let full = most(|u| f64::from(u.cpu_full_share));
    let p95 = most(|u| f64::from(u.cpu_p95));
    let (want, why) = if full >= 0.20 {
        (cpus + 2, format!("All {cpus} vCPUs were busy for {:.0}% of a job.", full * 100.0))
    } else if p95 <= f64::from(cpus) - 2.0 {
        // The floor guards cuts only: a smaller size the owner chose stays theirs.
        ((p95.ceil() as u8 + 1).max(FLOOR_CPUS), format!("Jobs kept at most {p95:.1} vCPUs busy (95th percentile)."))
    } else {
        (cpus, String::new())
    };
    out.cpus = want.min(cpu_ceiling);
    if want != cpus {
        out.reasons.push(why);
    }
    if want > cpu_ceiling {
        out.reasons.push(format!("{cpu_ceiling} vCPUs is the most this Mac can give a VM."));
    }

    let slots = u64::from(s.macos_slots.clamp(1, MAX_MACOS_VMS));
    let mem_ceiling = ((runner_memory_mb(s, host) / slots) as u32 / 1024 * 1024).clamp(4096, MAX_MEMORY_PER_VM_MB);
    let peak = most(|u| f64::from(u.mem_peak_mb));
    let swapped = most(|u| f64::from(u.swap_out_mb));
    let compressed = most(|u| f64::from(u.compressed_peak_mb));
    let m = f64::from(memory_mb);
    let (want, why) = if swapped > 0.0 || compressed * 4.0 >= m {
        let why = if swapped > 0.0 {
            format!("A job swapped {} out to disk.", gb(swapped))
        } else {
            format!("A job kept {} compressed.", gb(compressed))
        };
        ((memory_mb + 4096).max(round_up_gb(peak + HEADROOM_MB)), why)
    } else if peak + HEADROOM_MB <= m - HEADROOM_MB {
        let why = format!("The biggest job used {} at most and never swapped.", gb(peak));
        (round_up_gb(peak + HEADROOM_MB).max(FLOOR_MEMORY_MB), why)
    } else {
        (memory_mb, String::new())
    };
    out.memory_mb = want.min(mem_ceiling);
    if want != memory_mb {
        out.reasons.push(why);
    }
    if want > mem_ceiling {
        let each = if slots > 1 { format!(" each of {slots} VMs") } else { " a VM".into() };
        out.reasons.push(format!("{} is the most this Mac can give{each}.", gb(f64::from(mem_ceiling))));
    }
    out
}
