//! The gates: every few seconds the supervisor asks `evaluate` whether a slot
//! may take a job, must hold, must drain a running job within a grace period,
//! or must stop it now. Pure, so the whole decision table is unit-testable.

use crate::settings::{Priority, RunnerSettings};
use serde::{Deserialize, Serialize};

/// Keyboard or mouse input newer than this counts as "the user is here".
pub const ACTIVE_INPUT_SECS: f64 = 120.0;
/// The user's own CPU use above this counts as "the user is busy".
pub const BUSY_CPU_PCT: f64 = 50.0;
/// A macOS security update pending longer than this blocks new VMs.
pub const SECURITY_GRACE_DAYS: u32 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Pressure {
    Normal,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Thermal {
    Nominal,
    Fair,
    Serious,
    Critical,
}

/// A snapshot of the Mac, sampled by the supervisor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signals {
    /// Seconds since the last input. `None` means there is no input device to
    /// read (a headless Mac), which counts as not active. The supervisor must
    /// never map a read error to `None`; a NaN counts as active.
    pub idle_seconds: Option<f64>,
    /// The user's own CPU use, a 30-second average supplied by the supervisor.
    /// A NaN counts as busy.
    pub user_cpu_pct: f64,
    pub memory: Pressure,
    pub thermal: Thermal,
    pub on_battery: bool,
    pub battery_pct: Option<f64>,
    pub low_power_mode: bool,
    pub network_trusted: bool,
    pub network_expensive: bool,
    pub in_schedule: bool,
    pub free_disk_gb: f64,
    pub security_update_overdue_days: Option<u32>,
    pub paused_all: bool,
}

/// Why a gate failed. Declared in the order the UI lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Off,
    PausedAll,
    Schedule,
    OnBattery,
    LowPowerMode,
    Network,
    Hotspot,
    MemoryWarning,
    MemoryCritical,
    ThermalSerious,
    ThermalCritical,
    DiskFloor,
    SecurityUpdate,
    UserActive,
    UserBusy,
}

/// What a slot does next. One JSON shape, tagged by `kind`, like `Scope`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Decision {
    Take,
    Hold {
        why: Vec<Reason>,
    },
    /// Let the running job finish within `grace_secs`, then stop the VM.
    /// `evaluate` is stateless: the supervisor records when the drain started
    /// and does not restart the grace when the reasons change. For Runner
    /// first it also caps the grace at the job's remaining max job time.
    Drain {
        grace_secs: u64,
        why: Vec<Reason>,
    },
    StopNow {
        why: Vec<Reason>,
    },
}

/// `running`: a job is in this slot now. Stateless: the supervisor owns drain
/// timing (see [`Decision::Drain`]). Every comparison is written in the
/// failing direction, so a NaN sensor value counts as unsafe. Reasons are collected, not
/// short-circuited, so the UI can list everything that is in the way.
// The negated comparisons are deliberate: `!(x >= floor)` is true for NaN.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn evaluate(s: &RunnerSettings, sig: &Signals, running: bool) -> Decision {
    let mode = s.priority;
    let grace_secs = match mode {
        Priority::DoNotDisturb => 120,
        Priority::Balanced => 600,
        Priority::RunnerFirst => u64::from(s.max_job_minutes) * 60,
    };
    let drain_or_hold = |why: Vec<Reason>| {
        if running { Decision::Drain { grace_secs, why } } else { Decision::Hold { why } }
    };

    // 1. Hard limits protect the Mac, so they stop a running VM at once.
    let hard: Vec<Reason> = [
        (!s.enabled, Reason::Off),
        (sig.paused_all, Reason::PausedAll),
        (sig.low_power_mode, Reason::LowPowerMode),
        (sig.memory == Pressure::Critical, Reason::MemoryCritical),
        (sig.thermal == Thermal::Critical, Reason::ThermalCritical),
        (!(sig.free_disk_gb >= f64::from(s.disk_floor_gb)), Reason::DiskFloor),
    ]
    .into_iter()
    .filter_map(|(hit, r)| hit.then_some(r))
    .collect();
    if !hard.is_empty() {
        return if running { Decision::StopNow { why: hard } } else { Decision::Hold { why: hard } };
    }

    // 2. A stale OS only blocks new VMs; a running job is left to finish.
    if !running && sig.security_update_overdue_days.is_some_and(|d| d > SECURITY_GRACE_DAYS) {
        return Decision::Hold { why: vec![Reason::SecurityUpdate] };
    }

    // 3. Soft gates.
    let battery_floor = match mode {
        Priority::DoNotDisturb => f64::INFINITY,
        Priority::Balanced => 80.0,
        Priority::RunnerFirst => 50.0,
    };
    let below_floor = sig.battery_pct.is_none_or(|p| !(p > battery_floor));
    let battery = sig.on_battery && (s.only_on_power || below_floor);
    let soft: Vec<Reason> = [
        (!sig.in_schedule, Reason::Schedule),
        (battery, Reason::OnBattery),
        (s.trusted_networks_only && !sig.network_trusted, Reason::Network),
        (s.never_on_hotspot && sig.network_expensive, Reason::Hotspot),
    ]
    .into_iter()
    .filter_map(|(hit, r)| hit.then_some(r))
    .collect();
    // Runner first lets a running job finish, except when it would drain the battery.
    let lets_it_finish = running && mode == Priority::RunnerFirst && !battery;
    if !soft.is_empty() && !lets_it_finish {
        return drain_or_hold(soft);
    }

    // 4. Mode activity rules.
    let active = sig.idle_seconds.is_some_and(|i| !(i >= ACTIVE_INPUT_SECS));
    let busy = !(sig.user_cpu_pct <= BUSY_CPU_PCT);
    let mem = sig.memory == Pressure::Warning;
    let hot = sig.thermal == Thermal::Serious;
    let mut why = Vec::new();
    match (mode, running) {
        (Priority::DoNotDisturb, false) => {
            why.extend([(active, Reason::UserActive), (busy, Reason::UserBusy)]);
            why.extend([(mem, Reason::MemoryWarning), (hot, Reason::ThermalSerious)]);
        }
        (Priority::DoNotDisturb, true) => {
            why.extend([(mem, Reason::MemoryWarning), (hot, Reason::ThermalSerious), (busy, Reason::UserBusy)]);
        }
        (Priority::Balanced, false) => {
            why.extend([(mem, Reason::MemoryWarning), (hot, Reason::ThermalSerious), (busy, Reason::UserBusy)]);
        }
        (Priority::Balanced, true) => why.push((hot, Reason::ThermalSerious)),
        (Priority::RunnerFirst, false) => {
            why.extend([(mem, Reason::MemoryWarning), (hot, Reason::ThermalSerious)]);
        }
        (Priority::RunnerFirst, true) => {}
    }
    let mut why: Vec<Reason> = why.into_iter().filter_map(|(hit, r)| hit.then_some(r)).collect();
    why.sort_by_key(|r| *r as u8);
    if why.is_empty() { Decision::Take } else { drain_or_hold(why) }
}
