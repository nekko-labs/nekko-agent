//! What the user configures for a runner. One struct, camelCase JSON, with
//! every missing field falling back to the spec's default so older config
//! files keep loading as fields are added.

use serde::{Deserialize, Serialize};

/// How hard the runner may lean on the Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    /// "Only run when I'm idle".
    DoNotDisturb,
    /// "In the background".
    Balanced,
    /// "Runner first".
    RunnerFirst,
}

/// Whether the runner keeps the Mac from sleeping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepAwake {
    SystemDefault,
    WhileActive,
    Always,
}

/// What a runner is registered against: a whole org or a single repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    Org { org: String },
    Repo { owner: String, repo: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunnerSettings {
    pub enabled: bool,
    pub priority: Priority,
    pub keep_awake: KeepAwake,
    pub macos_slots: u8,
    pub linux_slots: u8,
    pub memory_per_vm_mb: u32,
    /// `None` means the mode's default share of the cores.
    pub cpus_per_vm: Option<u8>,
    pub disk_budget_gb: u32,
    pub disk_floor_gb: u32,
    pub max_job_minutes: u32,
    pub only_on_power: bool,
    pub trusted_networks_only: bool,
    pub never_on_hotspot: bool,
    pub allow_fork_prs: bool,
    pub rerun_lost_jobs: bool,
    pub trusted_cache: bool,
}

impl Default for RunnerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            priority: Priority::DoNotDisturb,
            keep_awake: KeepAwake::WhileActive,
            macos_slots: 1,
            linux_slots: 0,
            memory_per_vm_mb: 8192,
            cpus_per_vm: None,
            disk_budget_gb: 150,
            disk_floor_gb: 25,
            max_job_minutes: 120,
            only_on_power: true,
            trusted_networks_only: true,
            never_on_hotspot: true,
            allow_fork_prs: false,
            rerun_lost_jobs: true,
            trusted_cache: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerConfig {
    pub id: String,
    pub scope: Scope,
    pub label: String,
    pub settings: RunnerSettings,
}
