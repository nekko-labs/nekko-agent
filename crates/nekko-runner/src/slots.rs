//! How many VMs a host can take and how big each is. Apple's Virtualization
//! framework allows two macOS guests at once, and that budget is shared with
//! any other app's VMs, so the cap counts theirs too.

use serde::{Deserialize, Serialize};

use crate::settings::{Priority, RunnerSettings};

/// Apple's limit on concurrent macOS guests per Mac.
pub const MAX_MACOS_VMS: u8 = 2;
/// Linux guests have no Apple cap; this only keeps a typo from asking for dozens.
pub const MAX_LINUX_VMS: u8 = 8;

/// Which operating system a runner VM boots.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Guest {
    #[default]
    Macos,
    Linux,
}

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

/// Linux slots that may run now: the request, bounded by the runner memory left once the
/// macOS slots that may run (`macos_available`) have theirs, so Linux never takes a macOS VM's place.
/// Apple's cap does not apply to Linux guests.
pub fn linux_slots_available(s: &RunnerSettings, host: &HostFacts, macos_available: u8) -> u8 {
    let by_memory =
        (runner_memory_mb(s, host) / u64::from(s.memory_per_vm_mb.max(1))).saturating_sub(u64::from(macos_available));
    s.linux_slots.min(MAX_LINUX_VMS).min(by_memory.min(u64::from(MAX_LINUX_VMS)) as u8)
}

/// Which bound cut the slot count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotLimit {
    AppleCap,
    OtherApps,
    Memory,
}

/// [`macos_slots_available`] plus the bound that cut it below what was asked
/// (the request, at most Apple's cap). `None` when nothing cut it.
pub fn macos_slots_explained(s: &RunnerSettings, host: &HostFacts) -> (u8, Option<SlotLimit>) {
    let avail = macos_slots_available(s, host);
    let target = s.macos_slots.min(MAX_MACOS_VMS);
    let by_cap = MAX_MACOS_VMS.saturating_sub(host.other_macos_vms);
    let by_memory = (runner_memory_mb(s, host) / u64::from(s.memory_per_vm_mb.max(1))).min(u64::from(MAX_MACOS_VMS));
    let limit = if avail < target {
        // The smaller bound produced the count; a tie goes to the other apps.
        if by_memory < u64::from(by_cap) { Some(SlotLimit::Memory) } else { Some(SlotLimit::OtherApps) }
    } else {
        (s.macos_slots > MAX_MACOS_VMS).then_some(SlotLimit::AppleCap)
    };
    (avail, limit)
}

/// VMs the supervisor should have: the warm count or demand, whichever is more, within what is available.
pub fn vms_wanted(available: u8, warm: u8, busy: u8, queued: u32) -> u8 {
    let demand = u32::from(busy).saturating_add(queued);
    u32::from(available).min(u32::from(warm).max(demand)) as u8
}

/// The owner's usual memory use: nearest-rank 95th percentile, once there are
/// at least 36 samples (6 hours at 10 minutes).
pub fn usual_memory_mb(samples_mb: &[u64]) -> Option<u64> {
    if samples_mb.len() < 36 {
        return None;
    }
    let mut v = samples_mb.to_vec();
    v.sort_unstable();
    Some(v[(v.len() * 95).div_ceil(100) - 1])
}

/// vCPUs per VM: the explicit setting or the mode's default, always at least 2
/// and never more than leaves 2 cores to the host.
pub fn cpus_per_vm(s: &RunnerSettings, host: &HostFacts) -> u8 {
    let ceiling = host.cores.saturating_sub(HOST_CORES);
    // A default is shared out: two macOS VMs of 6 vCPUs on a 10-core Mac ask for more cores than
    // exist, and a CPU-bound Xcode job then loses its runner while the host starves. An explicit
    // setting is the owner's choice and only meets the ceiling.
    let share = ceiling / macos_slots_available(s, host).max(1);
    let want = s.cpus_per_vm.unwrap_or(
        match s.priority {
            Priority::DoNotDisturb => 4,
            Priority::Balanced => 6,
            Priority::RunnerFirst => ceiling,
        }
        .min(share),
    );
    want.min(ceiling).max(2)
}

/// VMs kept booted while idle so a job starts at once: the owner's count, or the mode's.
pub fn warm_slots(s: &RunnerSettings, available: u8) -> u8 {
    let want = s.ready_vms.unwrap_or(match s.priority {
        Priority::DoNotDisturb => 0,
        Priority::Balanced => 1,
        Priority::RunnerFirst => MAX_MACOS_VMS,
    });
    want.min(available)
}
