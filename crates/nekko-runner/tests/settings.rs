//! The runner's settings: the defaults the spec fixes and the camelCase JSON
//! the UI and the config file share.

use nekko_runner::{KeepAwake, Priority, RunnerConfig, RunnerSettings, Scope};
use serde_json::json;

#[test]
fn defaults_match_the_spec() {
    let s = RunnerSettings::default();
    assert_eq!(
        (s.priority, s.keep_awake, s.macos_slots, s.memory_per_vm_mb),
        (Priority::DoNotDisturb, KeepAwake::WhileActive, 1, 8192)
    );
    assert_eq!((s.disk_budget_gb, s.disk_floor_gb, s.max_job_minutes), (150, 25, 120));
    assert!(s.only_on_power && s.trusted_networks_only && s.never_on_hotspot && !s.allow_fork_prs);
    assert!(!s.enabled && s.linux_slots == 0 && s.cpus_per_vm.is_none());
    assert!(s.rerun_lost_jobs && s.trusted_cache);
}

#[test]
fn settings_round_trip_camel_case() {
    let v = serde_json::to_value(RunnerSettings::default()).unwrap();
    assert_eq!(v["keepAwake"], "whileActive");
    assert_eq!(v["priority"], "doNotDisturb");
    assert_eq!(v["macosSlots"], 1);
    assert_eq!(v["memoryPerVmMb"], 8192);
    assert_eq!(v["cpusPerVm"], serde_json::Value::Null);
    assert_eq!(v["runnerMemoryMb"], serde_json::Value::Null);
    assert_eq!(serde_json::from_value::<RunnerSettings>(v).unwrap(), RunnerSettings::default());

    let cfg = RunnerConfig {
        id: "r1".into(),
        scope: Scope::Repo { owner: "acme".into(), repo: "app".into() },
        label: "nekko-mac".into(),
        settings: RunnerSettings::default(),
    };
    let v = serde_json::to_value(&cfg).unwrap();
    assert_eq!(v["scope"], json!({"kind": "repo", "owner": "acme", "repo": "app"}));
    assert_eq!(serde_json::from_value::<RunnerConfig>(v).unwrap(), cfg);

    let org = serde_json::to_value(Scope::Org { org: "acme".into() }).unwrap();
    assert_eq!(org, json!({"kind": "org", "org": "acme"}));
}

#[test]
fn missing_fields_take_defaults() {
    let s: RunnerSettings = serde_json::from_value(json!({"enabled": true, "priority": "runnerFirst"})).unwrap();
    assert!(s.enabled);
    assert_eq!(s.priority, Priority::RunnerFirst);
    assert_eq!(s.max_job_minutes, 120);
}

#[test]
fn runner_memory_round_trips() {
    let s = RunnerSettings { runner_memory_mb: Some(16384), ..Default::default() };
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v["runnerMemoryMb"], 16384);
    assert_eq!(serde_json::from_value::<RunnerSettings>(v).unwrap(), s);
}
