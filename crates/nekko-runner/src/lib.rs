//! CI runner logic: pure decisions with no I/O, so every rule is testable on
//! any machine. Later modules (gates, keep-awake, egress) join this list.

pub mod settings;
pub mod slots;

pub use settings::{KeepAwake, Priority, RunnerConfig, RunnerSettings, Scope};
pub use slots::{HostFacts, MAX_MACOS_VMS, RUNNER_MEMORY_SHARE, cpus_per_vm, macos_slots_available, warm_slots};
