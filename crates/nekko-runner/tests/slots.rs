//! Slot, CPU and warm-VM budgets for a host.

use nekko_runner::{HostFacts, Priority, RunnerSettings, cpus_per_vm, macos_slots_available, warm_slots};

#[test]
fn never_more_than_two_macos_vms() {
    let host = HostFacts { ram_mb: 131072, cores: 16, other_macos_vms: 0 };
    assert_eq!(macos_slots_available(&RunnerSettings { macos_slots: 7, ..Default::default() }, &host), 2);
    assert_eq!(
        macos_slots_available(
            &RunnerSettings { macos_slots: 2, ..Default::default() },
            &HostFacts { other_macos_vms: 1, ..host }
        ),
        1
    );
    assert_eq!(
        macos_slots_available(
            &RunnerSettings { macos_slots: 2, ..Default::default() },
            &HostFacts { other_macos_vms: 3, ..host }
        ),
        0
    );
}

#[test]
fn memory_cap_is_half_of_ram() {
    // 16 GB Mac, 8 GB VMs, 50% cap: one slot.
    let host = HostFacts { ram_mb: 16384, cores: 10, other_macos_vms: 0 };
    assert_eq!(macos_slots_available(&RunnerSettings { macos_slots: 2, ..Default::default() }, &host), 1);
}

#[test]
fn cpus_leave_two_cores_to_the_host() {
    let host = HostFacts { ram_mb: 65536, cores: 12, other_macos_vms: 0 };
    let s = |p| RunnerSettings { priority: p, ..Default::default() };
    assert_eq!(cpus_per_vm(&s(Priority::DoNotDisturb), &host), 4);
    assert_eq!(cpus_per_vm(&s(Priority::Balanced), &host), 6);
    assert_eq!(cpus_per_vm(&s(Priority::RunnerFirst), &host), 10);
    assert_eq!(cpus_per_vm(&s(Priority::Balanced), &HostFacts { cores: 4, ..host }), 2);
}

#[test]
fn explicit_cpus_are_clamped() {
    let host = HostFacts { ram_mb: 65536, cores: 8, other_macos_vms: 0 };
    let s = |n| RunnerSettings { cpus_per_vm: Some(n), ..Default::default() };
    assert_eq!((cpus_per_vm(&s(1), &host), cpus_per_vm(&s(5), &host), cpus_per_vm(&s(16), &host)), (2, 5, 6));
    assert_eq!(cpus_per_vm(&s(8), &HostFacts { cores: 2, ..host }), 2);
}

#[test]
fn warm_slots_by_mode() {
    let s = |p| RunnerSettings { priority: p, ..Default::default() };
    assert_eq!(
        (
            warm_slots(&s(Priority::DoNotDisturb), 2),
            warm_slots(&s(Priority::Balanced), 2),
            warm_slots(&s(Priority::RunnerFirst), 2)
        ),
        (0, 1, 2)
    );
    assert_eq!(warm_slots(&s(Priority::Balanced), 0), 0);
}
