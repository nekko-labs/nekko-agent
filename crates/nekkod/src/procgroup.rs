//! Make sure nothing the daemon starts outlives it.
//!
//! The graceful path is stdin: the app holds the daemon's stdin open, so
//! closing it stops the daemon, which stops what it started. This module covers the ungraceful one, a crash or a hard kill, where no cleanup
//! code runs at all.

/// Windows: put this process in a job object that kills every member when its
/// last handle closes. Children inherit the job, and the handle closes when
/// this process dies however it dies. `BREAKAWAY_OK` still lets a program the
/// user launches from a terminal opt out explicitly.
#[cfg(windows)]
pub fn init() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: plain Win32 calls with valid arguments; the job handle is leaked
    // on purpose so it lives exactly as long as the process.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok != 0 {
            AssignProcessToJobObject(job, GetCurrentProcess());
        }
    }
}

/// Linux: die with the parent. (Children get the same in `on_child_spawn`.)
#[cfg(target_os = "linux")]
pub fn init() {
    // SAFETY: prctl with PR_SET_PDEATHSIG takes a signal number and no pointers.
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
    }
}

/// macOS has no parent-death signal; the stdin rule covers the graceful path.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn init() {}

/// Applied to each child before exec.
#[cfg(target_os = "linux")]
pub fn on_child_spawn(cmd: &mut tokio::process::Command) {
    // SAFETY: the closure only calls the async-signal-safe prctl.
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
pub fn on_child_spawn(_cmd: &mut tokio::process::Command) {}
