//! How many VMs a host can take and how big each is. Apple's Virtualization
//! framework allows two macOS guests at once, and that budget is shared with
//! any other app's VMs, so the cap counts theirs too.

use crate::settings::{Priority, RunnerSettings};

/// Apple's limit on concurrent macOS guests per Mac.
pub const MAX_MACOS_VMS: u8 = 2;

/// Share of RAM all runner VMs together may take. Fixed in this phase.
pub const RUNNER_MEMORY_SHARE: f64 = 0.5;

/// Cores always left to the host.
const HOST_CORES: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostFacts {
    pub ram_mb: u64,
    pub cores: u8,
    /// macOS VMs started by other apps right now.
    pub other_macos_vms: u8,
}

/// Slots that may run now: the request, bounded by Apple's cap net of other
/// apps' VMs and by the memory share.
pub fn macos_slots_available(s: &RunnerSettings, host: &HostFacts) -> u8 {
    let by_memory = (host.ram_mb as f64 * RUNNER_MEMORY_SHARE / f64::from(s.memory_per_vm_mb.max(1))).floor();
    let by_cap = MAX_MACOS_VMS.saturating_sub(host.other_macos_vms);
    s.macos_slots.min(by_cap).min(by_memory.min(f64::from(MAX_MACOS_VMS)) as u8)
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
