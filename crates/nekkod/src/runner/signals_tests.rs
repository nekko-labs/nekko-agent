use super::*;
use crate::runner::lan::{default_gateway, network_id};
use crate::runner::updates::{UpdateLedger, security_labels};
use std::net::Ipv4Addr;

fn mac() -> MacState {
    MacState {
        wall_secs: 1_700_000_000.0,
        idle_seconds: Some(600.0),
        user_cpu_pct: 5.0,
        power: Some(Power { on_battery: true, percent: Some(90.0), low: false }),
        host: Some(HostState { thermal: Thermal::Fair, low_power_mode: true, memory: Pressure::Warning }),
        egress: Some(Egress {
            physical: Some(("en0".into(), 4)),
            vpn_carries_default: false,
            expensive: false,
            constrained: false,
        }),
        host_nets_ok: true,
        network_id: Some("gw:aa:bb:cc:dd:ee:01".into()),
        free_disk_gb: 120.0,
        available_memory_mb: 20000.0,
        ram_mb: 32768,
        cores: 10,
        user_memory_mb: Some(8000),
        security_update_overdue_days: Some(3),
        paused_all: true,
    }
}

fn trusting() -> RunnerSettings {
    RunnerSettings { trusted_networks: vec!["gw:aa:bb:cc:dd:ee:01".into()], ..Default::default() }
}

#[test]
fn signals_map_every_reading() {
    let s = signals_for(&mac(), &trusting());
    assert_eq!(
        (s.idle_seconds, s.user_cpu_pct, s.memory, s.thermal),
        (Some(600.0), 5.0, Pressure::Warning, Thermal::Fair)
    );
    assert_eq!((s.on_battery, s.battery_pct, s.low_power_mode), (true, Some(90.0), true));
    assert!(s.network_trusted && !s.network_expensive && s.in_schedule && s.host_known && s.paused_all);
    assert_eq!((s.free_disk_gb, s.available_memory_mb, s.security_update_overdue_days), (120.0, 20000.0, Some(3)));
    assert!(!s.vpn_carries_default);
}

#[test]
fn host_known_needs_host_state_egress_and_nets() {
    let no_host = MacState { host: None, ..mac() };
    let s = signals_for(&no_host, &trusting());
    assert!(!s.host_known);
    // Benign values; the host_known gate holds new VMs.
    assert_eq!((s.thermal, s.memory, s.low_power_mode), (Thermal::Nominal, Pressure::Normal, false));
    let no_egress = MacState { egress: None, ..mac() };
    let s = signals_for(&no_egress, &trusting());
    assert!(!s.host_known && !s.vpn_carries_default && !s.network_expensive);
    assert!(!signals_for(&MacState { host_nets_ok: false, ..mac() }, &trusting()).host_known);
}

#[test]
fn untrusted_or_constrained_networks() {
    assert!(!signals_for(&mac(), &RunnerSettings::default()).network_trusted);
    assert!(!signals_for(&MacState { network_id: None, ..mac() }, &trusting()).network_trusted);
    let mut m = mac();
    m.egress.as_mut().unwrap().constrained = true;
    assert!(signals_for(&m, &trusting()).network_expensive);
    let mut m = mac();
    m.egress.as_mut().unwrap().expensive = true;
    m.egress.as_mut().unwrap().vpn_carries_default = true;
    let s = signals_for(&m, &trusting());
    assert!(s.network_expensive && s.vpn_carries_default);
}

#[test]
fn host_state_line_parses() {
    assert_eq!(
        parse_host_state(r#"{"thermal":"serious","lowPowerMode":false,"memoryPressure":"critical"}"#),
        Some(HostState { thermal: Thermal::Serious, low_power_mode: false, memory: Pressure::Critical })
    );
    assert_eq!(parse_host_state(r#"{"thermal":"hot"}"#), None);
    assert_eq!(parse_host_state(r#"{"thermal":"hot","lowPowerMode":false,"memoryPressure":"normal"}"#), None);
    assert_eq!(parse_host_state("not json"), None);
}

#[test]
fn user_cpu_excludes_vm_processes() {
    assert_eq!(user_cpu_pct(80.0, 400.0, 10), 40.0);
    assert_eq!(user_cpu_pct(10.0, 400.0, 10), 0.0);
    assert!(user_cpu_pct(f64::NAN, 0.0, 10).is_nan());
}

#[test]
fn cpu_window_averages_30_seconds() {
    let mut w = CpuWindow::default();
    for _ in 0..5 {
        w.push(0.0);
    }
    assert_eq!(w.push(60.0), 10.0);
    let mut last = 0.0;
    for _ in 0..6 {
        last = w.push(60.0);
    }
    assert_eq!(last, 60.0);
}

#[test]
fn memory_history_samples_every_10_minutes_for_7_days() {
    let dir = std::env::temp_dir().join(format!("nekko-memhist-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let t = 1_700_000_000;
    let mut h = MemoryHistory::load(&dir);
    h.record(t, 100);
    h.record(t + 60, 200);
    assert_eq!(h.samples, [(t, 100)]);
    assert_eq!(h.usual(), None, "too few samples");
    // 8 days at one sample per 10 minutes.
    let end = t + 8 * 86_400;
    let mut now = t + 600;
    while now <= end {
        h.record(now, 300);
        now += 600;
    }
    assert!(h.samples.iter().all(|&(at, _)| end - at <= 7 * 86_400));
    assert_eq!(h.samples.len(), 7 * 144 + 1);
    assert_eq!(h.usual(), Some(300));
    assert_eq!(MemoryHistory::load(&dir).samples, h.samples, "saved");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn security_labels_from_softwareupdate() {
    let labels = security_labels(include_str!("../../tests/fixtures/runner/softwareupdate-list.txt"));
    assert_eq!(labels, ["macOS Sequoia 15.1.1-24B91", "Background Security Improvement 15.1.1a"]); // Safari entry excluded
    assert!(security_labels("Software Update Tool\n\nNo new software available.\n").is_empty());
}

#[test]
fn overdue_days_from_first_seen() {
    let mut l = UpdateLedger::in_memory();
    assert_eq!(l.observe(&["macOS 15.1.1".into()], 0), Some(0));
    assert_eq!(l.observe(&["macOS 15.1.1".into()], 8 * 86_400 + 5), Some(8));
    assert_eq!(l.observe(&[], 9 * 86_400), None);
    assert_eq!(l.observe(&["macOS 15.1.1".into()], 9 * 86_400), Some(0)); // pruned, so seen afresh
}

#[test]
fn update_ledger_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("nekko-updates-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    UpdateLedger::load(&dir).observe(&["macOS 15.1.1".into()], 0);
    assert_eq!(UpdateLedger::load(&dir).observe(&["macOS 15.1.1".into()], 3 * 86_400), Some(3));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn gateway_and_network_id_parse() {
    let gw = default_gateway(include_str!("../../tests/fixtures/runner/route-get-default.txt")).unwrap();
    assert_eq!(gw, Ipv4Addr::new(192, 168, 1, 1));
    assert_eq!(
        network_id(include_str!("../../tests/fixtures/runner/arp-n.txt"), gw).as_deref(),
        Some("gw:0a:1b:2c:3d:4e:05")
    );
    assert_eq!(network_id("? (192.168.1.1) at (incomplete) on en0", gw), None);
    assert_eq!(default_gateway("    gateway: link#14\n"), None);
}
