//! How many VMs a host can take and how big each is. Apple's Virtualization
//! framework allows two macOS guests at once, and that budget is shared with
//! any other app's VMs, so the cap counts theirs too.

use crate::settings::{Priority, RunnerSettings};

/// Apple's limit on concurrent macOS guests per Mac.
pub const MAX_MACOS_VMS: u8 = 2;

/// Most of RAM all runner VMs together may take, whatever the setting says,
/// so the owner's Mac always keeps a quarter for itself.
pub const MAX_RUNNER_MEMORY_SHARE: f64 = 0.75;
/// Memory always kept for the owner, however little they use.
pub const OWNER_RESERVE_MIN_MB: u64 = 8192;
/// Margin over the owner's usual use, since usage swings above its typical level.
pub const OWNER_USE_HEADROOM: f64 = 1.25;

/// Cores always left to the host.
const HOST_CORES: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostFacts {
    pub ram_mb: u64,
    pub cores: u8,
    /// macOS VMs started by other apps right now.
    pub other_macos_vms: u8,
    /// The owner's usual memory in use outside runner VMs. The supervisor
    /// measures it as a high percentile over recent days, not one instant.
    /// `None` until measured.
    pub user_memory_mb: Option<u64>,
}

/// The runner budget this Mac can spare: RAM minus what the owner needs (the
/// larger of 8 GB and 1.25 times their usual use; a quarter of RAM when
/// unmeasured), capped at 75% of RAM, whole GB, never negative.
pub fn recommended_runner_memory_mb(host: &HostFacts) -> u64 {
    let reserve = match host.user_memory_mb {
        Some(u) => (u as f64 * OWNER_USE_HEADROOM).ceil() as u64,
        None => host.ram_mb / 4,
    }
    .max(OWNER_RESERVE_MIN_MB);
    let budget = host.ram_mb.saturating_sub(reserve).min(memory_cap_mb(host));
    budget / 1024 * 1024
}

fn memory_cap_mb(host: &HostFacts) -> u64 {
    (host.ram_mb as f64 * MAX_RUNNER_MEMORY_SHARE) as u64
}

/// Total runner memory: the setting clamped to the 75% cap, else the recommendation.
pub fn runner_memory_mb(s: &RunnerSettings, host: &HostFacts) -> u64 {
    s.runner_memory_mb.map_or_else(|| recommended_runner_memory_mb(host), |m| u64::from(m).min(memory_cap_mb(host)))
}

/// Slots that may run now: the request, bounded by Apple's cap net of other
/// apps' VMs and by the runner memory budget.
pub fn macos_slots_available(s: &RunnerSettings, host: &HostFacts) -> u8 {
    let by_memory = runner_memory_mb(s, host) / u64::from(s.memory_per_vm_mb.max(1));
    let by_cap = MAX_MACOS_VMS.saturating_sub(host.other_macos_vms);
    s.macos_slots.min(by_cap).min(by_memory.min(u64::from(MAX_MACOS_VMS)) as u8)
}

/// vCPUs per VM: the explicit setting or the mode's default, always at least 2
/// and never more than leaves 2 cores to the host.
pub fn cpus_per_vm(s: &RunnerSettings, host: &HostFacts) -> u8 {
    let ceiling = host.cores.saturating_sub(HOST_CORES);
    let want = s.cpus_per_vm.unwrap_or(match s.priority {
        Priority::DoNotDisturb => 4,
        Priority::Balanced => 6,
        Priority::RunnerFirst => ceiling,
    });
    want.min(ceiling).max(2)
}

/// VMs kept booted while idle so a job starts at once.
pub fn warm_slots(s: &RunnerSettings, available: u8) -> u8 {
    match s.priority {
        Priority::DoNotDisturb => 0,
        Priority::Balanced => available.min(1),
        Priority::RunnerFirst => available,
    }
}
