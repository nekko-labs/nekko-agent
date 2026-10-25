//! Slot, CPU and warm-VM budgets for a host.

use nekko_runner::{
    HostFacts, Priority, RunnerSettings, SlotLimit, cpus_per_vm, macos_slots_available, macos_slots_explained,
    recommended_runner_memory_mb, runner_memory_mb, usual_memory_mb, vms_wanted, warm_slots,
};

#[test]
fn never_more_than_two_macos_vms() {
    let host = HostFacts { ram_mb: 131072, cores: 16, other_macos_vms: 0, user_memory_mb: None };
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
fn sixteen_gig_mac_default_slots() {
    // 16 GB Mac, 8 GB VMs, a quarter of RAM assumed in use: one slot.
    let host = HostFacts { ram_mb: 16384, cores: 10, other_macos_vms: 0, user_memory_mb: None };
    assert_eq!(macos_slots_available(&RunnerSettings { macos_slots: 2, ..Default::default() }, &host), 1);
}

#[test]
fn recommendation_examples() {
    let h = |ram, user| HostFacts { ram_mb: ram, cores: 10, other_macos_vms: 0, user_memory_mb: user };
    assert_eq!(recommended_runner_memory_mb(&h(16384, Some(9216))), 4096);
    assert_eq!(recommended_runner_memory_mb(&h(36864, Some(14336))), 18432);
    assert_eq!(recommended_runner_memory_mb(&h(65536, Some(20480))), 39936);
    assert_eq!(recommended_runner_memory_mb(&h(131072, Some(8192))), 98304); // capped at 75%
    assert_eq!(recommended_runner_memory_mb(&h(32768, None)), 24576); // assumes a quarter of RAM in use
}

#[test]
fn small_mac_recommends_nothing() {
    let host = HostFacts { ram_mb: 8192, cores: 8, other_macos_vms: 0, user_memory_mb: None };
    assert_eq!(recommended_runner_memory_mb(&host), 0);
    assert_eq!(macos_slots_available(&RunnerSettings::default(), &host), 0);
}

#[test]
fn usage_above_ram_recommends_zero() {
    let host = HostFacts { ram_mb: 16384, cores: 10, other_macos_vms: 0, user_memory_mb: Some(40000) };
    assert_eq!(recommended_runner_memory_mb(&host), 0);
}

#[test]
fn explicit_setting_is_used_and_capped_at_75_percent() {
    let host = HostFacts { ram_mb: 32768, cores: 10, other_macos_vms: 0, user_memory_mb: None };
    let s = |mb| RunnerSettings { runner_memory_mb: Some(mb), macos_slots: 2, ..Default::default() };
    assert_eq!(runner_memory_mb(&s(4096), &host), 4096);
    assert_eq!(runner_memory_mb(&s(30000), &host), 24576);
    assert_eq!(macos_slots_available(&s(4096), &host), 0);
    assert_eq!(macos_slots_available(&s(30000), &host), 2);
    assert_eq!(macos_slots_available(&RunnerSettings { memory_per_vm_mb: 12288, ..s(30000) }, &host), 2);
    assert_eq!(macos_slots_available(&RunnerSettings { memory_per_vm_mb: 16384, ..s(30000) }, &host), 1);
}

#[test]
fn cpus_leave_two_cores_to_the_host() {
    let host = HostFacts { ram_mb: 65536, cores: 12, other_macos_vms: 0, user_memory_mb: None };
    let s = |p| RunnerSettings { priority: p, ..Default::default() };
    assert_eq!(cpus_per_vm(&s(Priority::DoNotDisturb), &host), 4);
    assert_eq!(cpus_per_vm(&s(Priority::Balanced), &host), 6);
    assert_eq!(cpus_per_vm(&s(Priority::RunnerFirst), &host), 10);
    assert_eq!(cpus_per_vm(&s(Priority::Balanced), &HostFacts { cores: 4, ..host }), 2);
}

#[test]
fn explicit_cpus_are_clamped() {
    let host = HostFacts { ram_mb: 65536, cores: 8, other_macos_vms: 0, user_memory_mb: None };
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

#[test]
fn slot_limit_names_the_binding_bound() {
    let big = HostFacts { ram_mb: 131072, cores: 16, other_macos_vms: 0, user_memory_mb: None };
    let two = RunnerSettings { macos_slots: 2, ..Default::default() };
    assert_eq!(macos_slots_explained(&two, &HostFacts { other_macos_vms: 1, ..big }), (1, Some(SlotLimit::OtherApps)));
    assert_eq!(macos_slots_explained(&two, &HostFacts { other_macos_vms: 2, ..big }), (0, Some(SlotLimit::OtherApps)));
    assert_eq!(macos_slots_explained(&two, &HostFacts { ram_mb: 16384, ..big }), (1, Some(SlotLimit::Memory)));
    assert_eq!(
        macos_slots_explained(&RunnerSettings { macos_slots: 7, ..Default::default() }, &big),
        (2, Some(SlotLimit::AppleCap))
    );
    assert_eq!(macos_slots_explained(&RunnerSettings::default(), &big), (1, None));
}

#[test]
fn vms_wanted_by_warmth_and_demand() {
    assert_eq!(
        [
            vms_wanted(2, 0, 0, 0),
            vms_wanted(2, 0, 0, 1),
            vms_wanted(2, 1, 0, 0),
            vms_wanted(2, 1, 1, 0),
            vms_wanted(2, 1, 1, 3),
            vms_wanted(1, 2, 0, 5),
            vms_wanted(0, 2, 0, 5)
        ],
        [0, 1, 1, 1, 2, 1, 0]
    );
}

#[test]
fn usual_memory_is_the_95th_percentile() {
    assert_eq!(usual_memory_mb(&(1..=100).collect::<Vec<u64>>()), Some(95));
    assert_eq!(usual_memory_mb(&[8000; 35]), None);
}
