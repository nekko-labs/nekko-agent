//! Reading a job's stats disk, and the VM size suggested from it.

use nekko_runner::usage::{FLOOR_MEMORY_MB, STATS_DISK_BYTES, SUGGEST_MIN_JOBS};
use nekko_runner::{HostFacts, RunnerSettings, Usage, blank_stats_disk, parse_stats, suggest_size};

fn disk(lines: &str) -> Vec<u8> {
    let mut d = blank_stats_disk();
    d[512..512 + lines.len()].copy_from_slice(lines.as_bytes());
    d
}

#[test]
fn summarises_samples_from_the_job_start() {
    // 6 vCPUs. The first sample predates the job (a ready VM waiting) and is left out.
    let d = disk(
        "100 100 2000 0 0\n\
         200 50 4000 100 0\n\
         205 0 6000 300 0\n\
         210 10 5000 200 64\n\
         215 90 3000 0 64\n",
    );
    let u = parse_stats(&d, 6, 10240, 200).unwrap();
    assert_eq!((u.cpus, u.memory_mb), (6, 10240));
    assert!((u.cpu_p95 - 6.0).abs() < 1e-6, "{}", u.cpu_p95);
    // Busy 3.0, 6.0, 5.4 and 0.6: only 6.0 is within half a vCPU of full.
    assert!((u.cpu_full_share - 0.25).abs() < 1e-6, "{}", u.cpu_full_share);
    assert_eq!((u.mem_peak_mb, u.compressed_peak_mb, u.swap_out_mb), (6000, 300, 64));
}

#[test]
fn a_blank_or_foreign_disk_has_no_usage() {
    assert_eq!(parse_stats(&blank_stats_disk(), 6, 8192, 0), None);
    let mut foreign = disk("1 0 1 0 0\n2 0 1 0 0\n");
    foreign[0] = b'X';
    assert_eq!(parse_stats(&foreign, 6, 8192, 0), None);
    assert_eq!(parse_stats(&[], 6, 8192, 0), None);
    let mut big = disk("1 0 1 0 0\n2 0 1 0 0\n");
    big.push(0);
    assert_eq!(big.len(), STATS_DISK_BYTES + 1);
    assert_eq!(parse_stats(&big, 6, 8192, 0), None);
}

#[test]
fn one_bad_line_drops_the_whole_job() {
    for bad in [
        "1 0 1 0 0\n2 0 1 0\n",     // a field short
        "1 0 1 0 0\n2 0 1 0 0 9\n", // a field over
        "1 0 1 0 0\n2 x 1 0 0\n",   // not a number
        "1 0 1 0 0\n2 101 1 0 0\n", // idle over 100%
        "1 0 1 0 0\n2 -1 1 0 0\n",  // negative
        "1 0 1 0 0\n2 NaN 1 0 0\n", // not finite
        "1 0 1 0 0\n2 inf 1 0 0\n",
    ] {
        assert_eq!(parse_stats(&disk(bad), 6, 8192, 0), None, "{bad:?}");
    }
    let mut not_utf8 = disk("1 0 1 0 0\n2 0 1 0 0\n");
    not_utf8[520] = 0xff;
    assert_eq!(parse_stats(&not_utf8, 6, 8192, 0), None);
    // One sample is not a job.
    assert_eq!(parse_stats(&disk("1 0 1 0 0\n"), 6, 8192, 0), None);
}

fn mac() -> HostFacts {
    // The pilot Mac: M1 Max, 10 cores, 64 GB.
    HostFacts { ram_mb: 65536, cores: 10, other_macos_vms: 0, user_memory_mb: Some(20480) }
}

fn settings(cpus: u8, memory_mb: u32) -> RunnerSettings {
    RunnerSettings { cpus_per_vm: Some(cpus), memory_per_vm_mb: memory_mb, ..Default::default() }
}

fn job(cpus: u8, memory_mb: u32) -> Usage {
    Usage {
        cpus,
        memory_mb,
        cpu_p95: 5.5,
        cpu_full_share: 0.14,
        mem_peak_mb: 7000,
        compressed_peak_mb: 0,
        swap_out_mb: 0,
    }
}

#[test]
fn no_suggestion_before_three_jobs_at_this_size() {
    let s = settings(6, 10240);
    // Two at this size, and one at another size that does not count.
    let jobs = [job(6, 10240), job(6, 10240), job(4, 10240)];
    let out = suggest_size(&jobs, &s, &mac());
    assert_eq!(out.jobs, SUGGEST_MIN_JOBS - 1);
    assert_eq!((out.cpus, out.memory_mb), (6, 10240));
    assert!(out.reasons.is_empty());
}

#[test]
fn native_ios_on_2026_11_03_keeps_six_vcpus() {
    // 14% of the job with all 6 full, 95th percentile at least 5: neither rule fires.
    let s = settings(6, 10240);
    let out = suggest_size(&[job(6, 10240); 3], &s, &mac());
    assert_eq!(out.cpus, 6);
    // 7000 MB peak + 2 GB headroom is not 2 GB under 10 GB, so memory stays too.
    assert_eq!(out.memory_mb, 10240);
    assert!(out.reasons.is_empty(), "{:?}", out.reasons);
}

#[test]
fn cpu_goes_up_when_full_a_fifth_of_the_time() {
    let s = settings(6, 10240);
    let busy = Usage { cpu_full_share: 0.25, ..job(6, 10240) };
    let out = suggest_size(&[job(6, 10240), job(6, 10240), busy], &s, &mac());
    assert_eq!(out.cpus, 8);
    assert_eq!(out.reasons, ["All 6 vCPUs were busy for 25% of a job."]);
}

#[test]
fn cpu_never_goes_past_the_cores_left_to_the_host() {
    let s = settings(8, 10240);
    let busy = Usage { cpu_full_share: 0.5, ..job(8, 10240) };
    let out = suggest_size(&[busy; 3], &s, &mac());
    assert_eq!(out.cpus, 8);
    assert_eq!(out.reasons[1], "8 vCPUs is the most this Mac can give a VM.");
}

#[test]
fn cpu_comes_down_to_the_p95_plus_one_never_under_the_hosted_floor() {
    let s = settings(8, 10240);
    let light = Usage { cpu_p95: 3.2, cpu_full_share: 0.0, ..job(8, 10240) };
    assert_eq!(suggest_size(&[light; 3], &s, &mac()).cpus, 5);
    let idle = Usage { cpu_p95: 0.4, ..light };
    let out = suggest_size(&[idle; 3], &s, &mac());
    assert_eq!(out.cpus, 3);
    assert_eq!(out.reasons, ["Jobs kept at most 0.4 vCPUs busy (95th percentile)."]);
}

#[test]
fn memory_comes_down_to_the_peak_plus_headroom_never_under_the_hosted_floor() {
    let s = settings(6, 16384);
    let out = suggest_size(&[Usage { mem_peak_mb: 5500, ..job(6, 16384) }; 3], &s, &mac());
    assert_eq!(out.memory_mb, 8192);
    assert_eq!(out.reasons, ["The biggest job used 5.4 GB at most and never swapped."]);
    let small = suggest_size(&[Usage { mem_peak_mb: 2000, ..job(6, 16384) }; 3], &s, &mac());
    assert_eq!(small.memory_mb, FLOOR_MEMORY_MB);
}

#[test]
fn any_swap_or_heavy_compression_adds_memory() {
    let s = settings(6, 8192);
    let swapped = Usage { swap_out_mb: 300, ..job(6, 8192) };
    let out = suggest_size(&[job(6, 8192), job(6, 8192), swapped], &s, &mac());
    assert_eq!(out.memory_mb, 12288);
    assert_eq!(out.reasons, ["A job swapped 0.3 GB out to disk."]);
    let squeezed = Usage { compressed_peak_mb: 2048, ..job(6, 8192) };
    assert_eq!(suggest_size(&[squeezed; 3], &s, &mac()).memory_mb, 12288);
    // A peak far above the allocation asks for the peak plus headroom.
    let huge = Usage { mem_peak_mb: 13000, swap_out_mb: 900, ..job(6, 8192) };
    assert_eq!(suggest_size(&[huge; 3], &s, &mac()).memory_mb, 15360);
}

#[test]
fn memory_never_costs_a_slot() {
    // 32 GB for runners over 2 requested slots: 16 GB each at most.
    let s = RunnerSettings { macos_slots: 2, runner_memory_mb: Some(32768), ..settings(6, 16384) };
    let swapped = Usage { swap_out_mb: 10, ..job(6, 16384) };
    let out = suggest_size(&[swapped; 3], &s, &mac());
    assert_eq!(out.memory_mb, 16384);
    assert_eq!(out.reasons[1], "16.0 GB is the most this Mac can give each of 2 VMs.");
}
