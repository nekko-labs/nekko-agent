//! The gates: one test per row of the decision table, so a rule change shows
//! up as exactly one failing test.

use nekko_runner::{Decision, Pressure, Priority, Reason, RunnerSettings, Signals, Thermal, evaluate};

const ALL: [Priority; 3] = [Priority::DoNotDisturb, Priority::Balanced, Priority::RunnerFirst];

fn quiet() -> Signals {
    Signals {
        idle_seconds: Some(600.0),
        user_cpu_pct: 5.0,
        memory: Pressure::Normal,
        thermal: Thermal::Nominal,
        on_battery: false,
        battery_pct: Some(100.0),
        low_power_mode: false,
        network_trusted: true,
        network_expensive: false,
        in_schedule: true,
        free_disk_gb: 200.0,
        security_update_overdue_days: None,
        available_memory_mb: 32768.0,
        paused_all: false,
        vpn_carries_default: false,
        host_known: true,
    }
}

fn with(p: Priority) -> RunnerSettings {
    RunnerSettings { enabled: true, priority: p, ..RunnerSettings::default() }
}

use Priority::{Balanced, DoNotDisturb, RunnerFirst};

#[test]
fn quiet_mac_takes_jobs_in_every_mode() {
    for p in ALL {
        assert_eq!(evaluate(&with(p), &quiet(), false), Decision::Take);
        assert_eq!(evaluate(&with(p), &quiet(), true), Decision::Take);
    }
}

#[test]
fn dnd_holds_while_typing() {
    let sig = Signals { idle_seconds: Some(30.0), ..quiet() };
    assert_eq!(evaluate(&with(DoNotDisturb), &sig, false), Decision::Hold { why: vec![Reason::UserActive] });
}

#[test]
fn dnd_holds_for_both_active_and_busy() {
    let sig = Signals { idle_seconds: Some(30.0), user_cpu_pct: 80.0, ..quiet() };
    assert_eq!(
        evaluate(&with(DoNotDisturb), &sig, false),
        Decision::Hold { why: vec![Reason::UserActive, Reason::UserBusy] }
    );
}

#[test]
fn balanced_takes_while_typing_with_headroom() {
    let sig = Signals { idle_seconds: Some(30.0), user_cpu_pct: 20.0, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Take);
}

#[test]
fn balanced_holds_new_jobs_when_user_is_busy() {
    let sig = Signals { idle_seconds: Some(30.0), user_cpu_pct: 80.0, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::UserBusy] });
    let sig = Signals { user_cpu_pct: 80.0, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::UserBusy] });
}

#[test]
fn dnd_drains_running_job_when_user_is_busy_for_2_min() {
    let sig = Signals { user_cpu_pct: 80.0, ..quiet() };
    assert_eq!(
        evaluate(&with(DoNotDisturb), &sig, true),
        Decision::Drain { grace_secs: 120, why: vec![Reason::UserBusy] }
    );
}

#[test]
fn dnd_running_job_survives_an_active_user_with_no_cpu_load() {
    let sig = Signals { idle_seconds: Some(5.0), ..quiet() };
    assert_eq!(evaluate(&with(DoNotDisturb), &sig, true), Decision::Take);
}

#[test]
fn dnd_drains_running_job_on_memory_or_thermal_warning() {
    let sig = Signals { memory: Pressure::Warning, ..quiet() };
    assert_eq!(
        evaluate(&with(DoNotDisturb), &sig, true),
        Decision::Drain { grace_secs: 120, why: vec![Reason::MemoryWarning] }
    );
    let sig = Signals { thermal: Thermal::Serious, ..quiet() };
    assert_eq!(
        evaluate(&with(DoNotDisturb), &sig, true),
        Decision::Drain { grace_secs: 120, why: vec![Reason::ThermalSerious] }
    );
}

#[test]
fn balanced_keeps_running_job_when_user_is_busy() {
    let sig = Signals { user_cpu_pct: 80.0, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, true), Decision::Take);
}

#[test]
fn balanced_holds_new_jobs_on_memory_warning_but_keeps_a_running_one() {
    let sig = Signals { memory: Pressure::Warning, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::MemoryWarning] });
    assert_eq!(evaluate(&with(Balanced), &sig, true), Decision::Take);
}

#[test]
fn balanced_drains_running_job_for_10_min_on_thermal_serious() {
    let sig = Signals { thermal: Thermal::Serious, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::ThermalSerious] });
    assert_eq!(
        evaluate(&with(Balanced), &sig, true),
        Decision::Drain { grace_secs: 600, why: vec![Reason::ThermalSerious] }
    );
}

#[test]
fn battery_floors() {
    let on = |pct: Option<f64>| Signals { on_battery: true, battery_pct: pct, ..quiet() };
    let off_power = |p| RunnerSettings { only_on_power: false, ..with(p) };

    // With the default only_on_power every mode holds on battery.
    for p in ALL {
        assert_eq!(evaluate(&with(p), &on(Some(100.0)), false), Decision::Hold { why: vec![Reason::OnBattery] });
    }
    assert_eq!(
        evaluate(&off_power(DoNotDisturb), &on(Some(100.0)), false),
        Decision::Hold { why: vec![Reason::OnBattery] }
    );
    assert_eq!(evaluate(&off_power(Balanced), &on(Some(79.0)), false), Decision::Hold { why: vec![Reason::OnBattery] });
    assert_eq!(evaluate(&off_power(Balanced), &on(Some(80.0)), false), Decision::Hold { why: vec![Reason::OnBattery] });
    assert_eq!(evaluate(&off_power(Balanced), &on(Some(81.0)), false), Decision::Take);
    assert_eq!(evaluate(&off_power(Balanced), &on(None), false), Decision::Hold { why: vec![Reason::OnBattery] });
    assert_eq!(
        evaluate(&off_power(RunnerFirst), &on(Some(49.0)), false),
        Decision::Hold { why: vec![Reason::OnBattery] }
    );
    assert_eq!(evaluate(&off_power(RunnerFirst), &on(Some(51.0)), false), Decision::Take);
}

#[test]
fn battery_below_floor_drains_a_running_job_with_the_mode_grace() {
    let sig = Signals { on_battery: true, battery_pct: Some(40.0), ..quiet() };
    let s = |p| RunnerSettings { only_on_power: false, ..with(p) };
    assert_eq!(evaluate(&s(Balanced), &sig, true), Decision::Drain { grace_secs: 600, why: vec![Reason::OnBattery] });
    let sig = Signals { battery_pct: Some(30.0), ..sig };
    assert_eq!(
        evaluate(&s(RunnerFirst), &sig, true),
        Decision::Drain { grace_secs: 120 * 60, why: vec![Reason::OnBattery] }
    );
}

#[test]
fn runner_first_finishes_through_thermal_serious() {
    let sig = Signals { thermal: Thermal::Serious, ..quiet() };
    assert_eq!(evaluate(&with(RunnerFirst), &sig, true), Decision::Take);
    assert_eq!(evaluate(&with(RunnerFirst), &sig, false), Decision::Hold { why: vec![Reason::ThermalSerious] });
}

#[test]
fn runner_first_holds_new_jobs_on_memory_warning_and_ignores_the_user() {
    let sig = Signals { memory: Pressure::Warning, ..quiet() };
    assert_eq!(evaluate(&with(RunnerFirst), &sig, false), Decision::Hold { why: vec![Reason::MemoryWarning] });
    assert_eq!(evaluate(&with(RunnerFirst), &sig, true), Decision::Take);
    let sig = Signals { idle_seconds: Some(1.0), user_cpu_pct: 99.0, ..quiet() };
    assert_eq!(evaluate(&with(RunnerFirst), &sig, false), Decision::Take);
}

#[test]
fn runner_first_keeps_a_running_job_through_soft_gates() {
    let sig = Signals { in_schedule: false, network_trusted: false, network_expensive: true, ..quiet() };
    assert_eq!(evaluate(&with(RunnerFirst), &sig, true), Decision::Take);
    assert_eq!(
        evaluate(&with(RunnerFirst), &sig, false),
        Decision::Hold { why: vec![Reason::Schedule, Reason::Network, Reason::Hotspot] }
    );
}

#[test]
fn soft_gates_drain_running_jobs_in_dnd_and_balanced() {
    let sig = Signals { in_schedule: false, ..quiet() };
    assert_eq!(
        evaluate(&with(DoNotDisturb), &sig, true),
        Decision::Drain { grace_secs: 120, why: vec![Reason::Schedule] }
    );
    assert_eq!(evaluate(&with(Balanced), &sig, true), Decision::Drain { grace_secs: 600, why: vec![Reason::Schedule] });
}

#[test]
fn hard_limits_stop_now_in_every_mode() {
    let cases: [(RunnerSettings, Signals, Reason); 6] = [
        (RunnerSettings::default(), quiet(), Reason::Off),
        (with(DoNotDisturb), Signals { memory: Pressure::Critical, ..quiet() }, Reason::MemoryCritical),
        (with(DoNotDisturb), Signals { thermal: Thermal::Critical, ..quiet() }, Reason::ThermalCritical),
        (with(DoNotDisturb), Signals { free_disk_gb: 24.9, ..quiet() }, Reason::DiskFloor),
        (with(DoNotDisturb), Signals { low_power_mode: true, ..quiet() }, Reason::LowPowerMode),
        (with(DoNotDisturb), Signals { paused_all: true, ..quiet() }, Reason::PausedAll),
    ];
    for (settings, sig, reason) in cases {
        for p in ALL {
            let s = RunnerSettings { priority: p, ..settings.clone() };
            assert_eq!(evaluate(&s, &sig, true), Decision::StopNow { why: vec![reason] });
            assert_eq!(evaluate(&s, &sig, false), Decision::Hold { why: vec![reason] });
        }
    }
}

#[test]
fn every_failing_hard_limit_is_listed_in_reason_order() {
    let sig = Signals { free_disk_gb: 10.0, ..quiet() };
    assert_eq!(
        evaluate(&RunnerSettings::default(), &sig, true),
        Decision::StopNow { why: vec![Reason::Off, Reason::DiskFloor] }
    );
}

#[test]
fn security_update_blocks_new_vms_but_not_running_ones() {
    let sig = Signals { security_update_overdue_days: Some(8), ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::SecurityUpdate] });
    assert_eq!(evaluate(&with(Balanced), &sig, true), Decision::Take);
    let sig = Signals { security_update_overdue_days: Some(7), ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Take);
}

#[test]
fn hotspot_and_untrusted_network_hold() {
    let sig = Signals { network_expensive: true, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::Hotspot] });
    let sig = Signals { network_trusted: false, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::Network] });
    let relaxed = RunnerSettings { trusted_networks_only: false, never_on_hotspot: false, ..with(Balanced) };
    let sig = Signals { network_trusted: false, network_expensive: true, ..quiet() };
    assert_eq!(evaluate(&relaxed, &sig, false), Decision::Take);
}

#[test]
fn vpn_carrying_all_traffic_holds() {
    let sig = Signals { vpn_carries_default: true, ..quiet() };
    for p in ALL {
        assert_eq!(evaluate(&with(p), &sig, false), Decision::Hold { why: vec![Reason::VpnCarriesAllTraffic] });
    }
    // A soft gate, listed after the hotspot.
    let sig = Signals { network_expensive: true, ..sig };
    assert_eq!(
        evaluate(&with(Balanced), &sig, false),
        Decision::Hold { why: vec![Reason::Hotspot, Reason::VpnCarriesAllTraffic] }
    );
}

#[test]
fn vpn_setting_allows_jobs() {
    let s = |p| RunnerSettings { allow_direct_with_vpn: true, ..with(p) };
    let sig = Signals { vpn_carries_default: true, ..quiet() };
    for p in ALL {
        assert_eq!(evaluate(&s(p), &sig, false), Decision::Take);
        assert_eq!(evaluate(&s(p), &sig, true), Decision::Take);
    }
}

#[test]
fn vpn_drains_running_job_with_mode_grace() {
    let sig = Signals { vpn_carries_default: true, ..quiet() };
    let why = vec![Reason::VpnCarriesAllTraffic];
    assert_eq!(evaluate(&with(DoNotDisturb), &sig, true), Decision::Drain { grace_secs: 120, why: why.clone() });
    assert_eq!(evaluate(&with(Balanced), &sig, true), Decision::Drain { grace_secs: 600, why });
    // Runner first keeps a running job through soft gates, this one included.
    assert_eq!(evaluate(&with(RunnerFirst), &sig, true), Decision::Take);
    assert_eq!(serde_json::to_value(Reason::VpnCarriesAllTraffic).unwrap(), "vpnCarriesAllTraffic");
}

#[test]
fn reasons_serialize_camel_case() {
    assert_eq!(serde_json::to_value(Reason::MemoryWarning).unwrap(), "memoryWarning");
}

#[test]
fn decisions_serialize_as_one_tagged_shape() {
    use serde_json::json;
    let cases = [
        (Decision::Take, json!({ "kind": "take" })),
        (Decision::Hold { why: vec![Reason::OnBattery] }, json!({ "kind": "hold", "why": ["onBattery"] })),
        (
            Decision::Drain { grace_secs: 120, why: vec![Reason::UserBusy] },
            json!({ "kind": "drain", "graceSecs": 120, "why": ["userBusy"] }),
        ),
        (Decision::StopNow { why: vec![Reason::DiskFloor] }, json!({ "kind": "stopNow", "why": ["diskFloor"] })),
    ];
    for (d, want) in cases {
        assert_eq!(serde_json::to_value(&d).unwrap(), want);
        assert_eq!(serde_json::from_value::<Decision>(want).unwrap(), d);
    }
}

#[test]
fn nan_free_disk_counts_as_below_the_floor() {
    let sig = Signals { free_disk_gb: f64::NAN, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, true), Decision::StopNow { why: vec![Reason::DiskFloor] });
}

#[test]
fn free_disk_exactly_at_the_floor_is_fine() {
    let sig = Signals { free_disk_gb: 25.0, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Take);
}

#[test]
fn nan_cpu_counts_as_busy() {
    let sig = Signals { user_cpu_pct: f64::NAN, ..quiet() };
    assert_eq!(evaluate(&with(DoNotDisturb), &sig, false), Decision::Hold { why: vec![Reason::UserBusy] });
}

#[test]
fn nan_battery_counts_as_below_the_floor() {
    let sig = Signals { on_battery: true, battery_pct: Some(f64::NAN), ..quiet() };
    let s = RunnerSettings { only_on_power: false, ..with(Balanced) };
    assert_eq!(evaluate(&s, &sig, false), Decision::Hold { why: vec![Reason::OnBattery] });
}

#[test]
fn nan_idle_counts_as_active() {
    let sig = Signals { idle_seconds: Some(f64::NAN), ..quiet() };
    assert_eq!(evaluate(&with(DoNotDisturb), &sig, false), Decision::Hold { why: vec![Reason::UserActive] });
}

#[test]
fn too_little_free_memory_holds_new_vms() {
    // 8192 MB per VM plus the 2 GB margin is 10240 MB.
    let at = |mb| Signals { available_memory_mb: mb, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &at(9000.0), false), Decision::Hold { why: vec![Reason::MemoryHeadroom] });
    assert_eq!(evaluate(&with(Balanced), &at(10240.0), false), Decision::Take);
    assert_eq!(evaluate(&with(Balanced), &at(1000.0), true), Decision::Take);
}

#[test]
fn memory_headroom_and_security_update_are_both_listed() {
    let sig = Signals { available_memory_mb: 100.0, security_update_overdue_days: Some(8), ..quiet() };
    assert_eq!(
        evaluate(&with(Balanced), &sig, false),
        Decision::Hold { why: vec![Reason::SecurityUpdate, Reason::MemoryHeadroom] }
    );
}

#[test]
fn nan_available_memory_holds() {
    let sig = Signals { available_memory_mb: f64::NAN, ..quiet() };
    assert_eq!(evaluate(&with(Balanced), &sig, false), Decision::Hold { why: vec![Reason::MemoryHeadroom] });
}

#[test]
fn unknown_host_state_holds_new_vms_only() {
    let sig = Signals { host_known: false, ..quiet() };
    for p in ALL {
        assert_eq!(evaluate(&with(p), &sig, false), Decision::Hold { why: vec![Reason::HostStateUnknown] });
        assert_eq!(evaluate(&with(p), &sig, true), Decision::Take);
    }
}
