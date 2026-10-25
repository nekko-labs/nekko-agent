//! CI runner logic: pure decisions with no I/O, so every rule is testable on
//! any machine. `settings` and `slots` size the runner, `gates` decides take,
//! hold, drain or stop, `awake` decides whether to hold the Mac awake, and
//! `egress` decides which addresses a guest may connect to.

pub mod awake;
pub mod egress;
pub mod gates;
pub mod settings;
pub mod slots;

pub use awake::hold_awake;
pub use egress::{HostNets, guest_may_connect, guest_may_reach};
pub use gates::{
    ACTIVE_INPUT_SECS, BUSY_CPU_PCT, Decision, Pressure, Reason, SECURITY_GRACE_DAYS, Signals, Thermal,
    VM_START_MARGIN_MB, evaluate,
};
pub use settings::{KeepAwake, Priority, RunnerConfig, RunnerSettings, Scope};
pub use slots::{
    HostFacts, MAX_MACOS_VMS, MAX_RUNNER_MEMORY_SHARE, OWNER_RESERVE_MIN_MB, OWNER_USE_HEADROOM, SlotLimit,
    cpus_per_vm, macos_slots_available, macos_slots_explained, recommended_runner_memory_mb, runner_memory_mb,
    usual_memory_mb, vms_wanted, warm_slots,
};
