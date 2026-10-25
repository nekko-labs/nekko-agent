//! CI runner VMs: the userspace NAT that is a job VM's only network, the
//! host networks it keeps the guest away from, and the physical interface it
//! sends from.

pub mod audit;
pub mod awake;
pub mod egress;
pub mod hostnets;
pub mod lan;
pub mod net;
pub mod provider;
pub mod signals;
pub mod store;
pub mod supervisor;
pub mod updates;
pub mod vm;

/// The open-file limit nekkod runs with: the soft limit raised to 10240
/// (macOS's per-process ceiling for `setrlimit`), capped by the hard limit,
/// never lowered. Each job's NAT holds a socket per guest flow, and the
/// default soft limit of 256 runs out under a busy build.
pub fn nofile_target(soft: u64, hard: u64) -> u64 {
    soft.max(hard.min(10_240))
}

/// Applies [`nofile_target`] to this process; a failure is logged, not fatal.
#[cfg(unix)]
pub fn raise_nofile() {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: getrlimit and setrlimit with a valid rlimit struct.
    let rc = unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            -1
        } else {
            lim.rlim_cur = nofile_target(lim.rlim_cur, lim.rlim_max);
            libc::setrlimit(libc::RLIMIT_NOFILE, &lim)
        }
    };
    if rc != 0 {
        eprintln!("nekkod: cannot raise the open-file limit: {}", std::io::Error::last_os_error());
    }
}
