//! Make sure nothing the daemon starts outlives it.
//!
//! The graceful path is stdin (or SIGTERM, SIGHUP, Ctrl-C): the app holds the
//! daemon's stdin open, so closing it stops the daemon, which stops what it
//! started, and then [`sweep`] ends whatever is left. This module also covers
//! the ungraceful one, a crash or a hard kill, where no cleanup code runs:
//!
//! - Windows: a kill-on-close job object ([`init`]).
//! - Linux: a parent-death signal for the daemon and the children that ask
//!   for one ([`on_child_spawn`]).
//! - Unix: a record of the live children in `<dataDir>/run/children.json`,
//!   refreshed every couple of seconds, which the next daemon on the same
//!   data directory reads at start and ends what is still running
//!   ([`reap_leftovers`]). On macOS the daemon also leads its own process
//!   group, so a grandchild whose parent died is still found.
//!
//! A pid is only ever signalled when its start time matches the one
//! recorded, so a recycled pid belonging to something else is left alone.
//! Processes in another session are never touched: that is how a program
//! that must outlive the daemon (the updater's install script) detaches.

// The record and its matching are Unix-only at run time (tested everywhere).
#![cfg_attr(not(unix), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::time::Duration;

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

/// macOS has no parent-death signal. The daemon leads its own process group
/// instead, so everything it starts that does not make a group of its own
/// (and their children, even once orphaned) can be found by group. Not when
/// stdin is a terminal: a background group reading the terminal is stopped.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn init() {
    // SAFETY: isatty and setpgid take plain integers.
    unsafe {
        if libc::isatty(0) == 0 {
            libc::setpgid(0, 0);
        }
    }
}

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

/// `<dataDir>/run`, where the child record lives.
pub fn run_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("run")
}

const RECORD: &str = "children.json";
/// How often the record is refreshed while the daemon runs.
const REFRESH: Duration = Duration::from_secs(2);

/// One process as the record keeps it: enough to find it again and to be
/// sure it is the same process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Proc {
    pub pid: i32,
    #[serde(default)]
    pub ppid: i32,
    pub pgid: i32,
    /// Start time in a platform unit (microseconds since the epoch on macOS,
    /// clock ticks since boot on Linux); only ever compared for equality or order.
    pub start: u64,
}

/// What `children.json` holds.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Record {
    /// The daemon that wrote it.
    pub daemon: Option<Proc>,
    /// Its process group, when it led one.
    pub group: Option<i32>,
    pub children: Vec<Proc>,
    /// Process groups its children led.
    pub groups: Vec<i32>,
}

/// What to signal: one process, or the group it leads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub proc: Proc,
    pub group: bool,
}

/// The processes `me` is responsible for in `all`: its descendants, and the
/// members of `my_group` (the group it leads, if any) and of the groups its
/// descendants lead or `extra_groups` names. `same_session` filters out what
/// detached on purpose. A group is signalled whole only when it is not ours.
pub fn ours(
    all: &[Proc],
    me: i32,
    my_group: Option<i32>,
    extra_groups: &[i32],
    same_session: &dyn Fn(i32) -> bool,
) -> Vec<Target> {
    let mut picked: Vec<Proc> = Vec::new();
    let mut frontier = vec![me];
    while let Some(parent) = frontier.pop() {
        for p in all.iter().filter(|p| p.ppid == parent && p.pid != me) {
            if !picked.iter().any(|q| q.pid == p.pid) {
                picked.push(*p);
                frontier.push(p.pid);
            }
        }
    }
    let mut groups: Vec<i32> = picked.iter().filter(|p| p.pgid == p.pid).map(|p| p.pgid).collect();
    groups.extend(extra_groups.iter().copied().filter(|g| *g > 1));
    groups.extend(my_group);
    for p in all.iter().filter(|p| p.pid != me && groups.contains(&p.pgid)) {
        if !picked.iter().any(|q| q.pid == p.pid) {
            picked.push(*p);
        }
    }
    picked
        .into_iter()
        .filter(|p| p.pid > 1 && same_session(p.pid))
        .map(|p| Target { proc: p, group: p.pgid == p.pid && Some(p.pgid) != my_group })
        .collect()
}

/// What a predecessor left running, from its record and the live processes:
/// its children still running under the same start time, and anything still
/// in a group it or its children led that started after it did.
pub fn leftovers(record: &Record, all: &[Proc], me: i32) -> Vec<Target> {
    let Some(daemon) = record.daemon else { return Vec::new() };
    // Still running (it would hold the data directory's lock): not ours to end.
    if all.iter().any(|p| p.pid == daemon.pid && p.start == daemon.start) {
        return Vec::new();
    }
    let mut out: Vec<Target> = Vec::new();
    let mut add = |p: &Proc, group: bool| {
        if p.pid > 1 && p.pid != me && !out.iter().any(|t| t.proc.pid == p.pid) {
            out.push(Target { proc: *p, group });
        }
    };
    for c in &record.children {
        if let Some(live) = all.iter().find(|p| p.pid == c.pid && p.start == c.start) {
            add(live, live.pgid == live.pid);
        }
    }
    let groups: Vec<i32> = record.groups.iter().copied().chain(record.group).filter(|g| *g > 1).collect();
    for p in all.iter().filter(|p| groups.contains(&p.pgid) && p.start >= daemon.start) {
        add(p, false);
    }
    out
}

#[cfg(unix)]
mod sys {
    use super::Proc;

    pub fn me() -> i32 {
        std::process::id() as i32
    }

    /// The group this process leads, if it leads one.
    pub fn my_group() -> Option<i32> {
        // SAFETY: getpgrp takes no arguments.
        let g = unsafe { libc::getpgrp() };
        (g == me()).then_some(g)
    }

    pub fn same_session(pid: i32) -> bool {
        // SAFETY: getsid takes a pid; failure (gone, or another session) is -1.
        unsafe {
            let mine = libc::getsid(0);
            let theirs = libc::getsid(pid);
            theirs >= 0 && theirs == mine
        }
    }

    pub fn signal(pid: i32, group: bool, sig: i32) {
        // SAFETY: kill and killpg take plain integers.
        unsafe {
            if group {
                libc::killpg(pid, sig);
            } else {
                libc::kill(pid, sig);
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub fn processes() -> Vec<Proc> {
        use std::os::raw::{c_int, c_void};
        // SAFETY: proc_listallpids with a null buffer returns the count; with
        // a buffer, it fills at most `size` bytes of it.
        let pids = unsafe {
            let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
            if n <= 0 {
                return Vec::new();
            }
            let mut buf = vec![0i32; n as usize + 64];
            let got =
                libc::proc_listallpids(buf.as_mut_ptr().cast::<c_void>(), (buf.len() * size_of::<i32>()) as c_int);
            buf.truncate(got.max(0) as usize);
            buf
        };
        pids.into_iter().filter(|p| *p > 0).filter_map(info).collect()
    }

    #[cfg(target_os = "macos")]
    pub fn info(pid: i32) -> Option<Proc> {
        use std::os::raw::{c_int, c_void};
        const SZOMB: u32 = 5;
        // SAFETY: proc_pidinfo fills at most `size` bytes of a zeroed proc_bsdinfo.
        unsafe {
            let mut bi: libc::proc_bsdinfo = std::mem::zeroed();
            let size = size_of::<libc::proc_bsdinfo>() as c_int;
            let got = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut bi as *mut libc::proc_bsdinfo).cast::<c_void>(),
                size,
            );
            if got != size || bi.pbi_status == SZOMB {
                return None;
            }
            Some(Proc {
                pid,
                ppid: bi.pbi_ppid as i32,
                pgid: bi.pbi_pgid as i32,
                start: bi.pbi_start_tvsec * 1_000_000 + bi.pbi_start_tvusec,
            })
        }
    }

    #[cfg(target_os = "linux")]
    pub fn processes() -> Vec<Proc> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        dir.filter_map(|e| {
            let name = e.ok()?.file_name();
            name.to_str()?.parse::<i32>().ok()
        })
        .filter_map(info)
        .collect()
    }

    #[cfg(target_os = "linux")]
    pub fn info(pid: i32) -> Option<Proc> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // `pid (comm) state ppid pgrp session ...`; comm may hold spaces and parentheses.
        let rest = stat.get(stat.rfind(')')? + 2..)?;
        let f: Vec<&str> = rest.split_whitespace().collect();
        if f.first() == Some(&"Z") || f.first() == Some(&"X") {
            return None;
        }
        Some(Proc {
            pid,
            ppid: f.get(1)?.parse().ok()?,
            pgid: f.get(2)?.parse().ok()?,
            start: f.get(19)?.parse().ok()?,
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn processes() -> Vec<Proc> {
        Vec::new()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn info(_pid: i32) -> Option<Proc> {
        None
    }
}

#[cfg(unix)]
mod tracking {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// The record file, once tracking started; the lock also orders writes
    /// against the final removal.
    static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
    static STOPPED: AtomicBool = AtomicBool::new(false);
    /// The groups the last snapshot saw, so a group whose leader already
    /// exited is still swept at shutdown.
    static SEEN_GROUPS: Mutex<Vec<i32>> = Mutex::new(Vec::new());

    fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current() -> Vec<Target> {
        let seen = lock(&SEEN_GROUPS).clone();
        ours(&sys::processes(), sys::me(), sys::my_group(), &seen, &sys::same_session)
    }

    fn snapshot() -> Record {
        let targets = current();
        let mut groups: Vec<i32> = targets.iter().filter(|t| t.group).map(|t| t.proc.pgid).collect();
        groups.sort_unstable();
        groups.dedup();
        let mut children: Vec<Proc> = targets.iter().map(|t| t.proc).collect();
        children.sort_by_key(|p| p.pid);
        Record { daemon: sys::info(sys::me()), group: sys::my_group(), children, groups }
    }

    fn write(path: &Path, record: &Record) -> std::io::Result<()> {
        let opts = nekko_js::fs::AtomicWrite { create_dir: true, ..Default::default() };
        nekko_js::fs::atomic_write(path, &serde_json::to_vec(record)?, opts)
    }

    pub fn start(run_dir: &Path) {
        let path = run_dir.join(RECORD);
        *lock(&FILE) = Some(path.clone());
        std::thread::Builder::new()
            .name("nekkod-children".into())
            .spawn(move || {
                let mut last: Option<Record> = None;
                while !STOPPED.load(Ordering::SeqCst) {
                    let record = snapshot();
                    {
                        let mut seen = lock(&SEEN_GROUPS);
                        for g in &record.groups {
                            if !seen.contains(g) {
                                seen.push(*g);
                            }
                        }
                        // Forget groups nobody is in any more.
                        let all = sys::processes();
                        seen.retain(|g| all.iter().any(|p| p.pgid == *g));
                    }
                    if last.as_ref() != Some(&record) {
                        let guard = lock(&FILE);
                        if STOPPED.load(Ordering::SeqCst) {
                            break;
                        }
                        if let Some(p) = guard.as_ref()
                            && let Err(e) = write(p, &record)
                        {
                            eprintln!("nekkod: could not record child processes in {}: {e}", p.display());
                        }
                        last = Some(record);
                    }
                    std::thread::sleep(REFRESH);
                }
            })
            .ok();
    }

    pub fn sweep(grace: Duration) -> usize {
        STOPPED.store(true, Ordering::SeqCst);
        let targets = current();
        let n = end(&targets, grace);
        if let Some(p) = lock(&FILE).take() {
            let _ = std::fs::remove_file(p);
        }
        n
    }

    /// SIGTERM, a grace period, then SIGKILL for what is left; a target is
    /// only signalled while its start time still matches.
    pub fn end(targets: &[Target], grace: Duration) -> usize {
        let alive = |t: &Target| sys::info(t.proc.pid).is_some_and(|p| p.start == t.proc.start);
        let live: Vec<Target> = targets.iter().copied().filter(alive).collect();
        if live.is_empty() {
            return 0;
        }
        for t in &live {
            sys::signal(t.proc.pid, t.group, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline && live.iter().any(alive) {
            std::thread::sleep(Duration::from_millis(50));
        }
        for t in live.iter().filter(|t| alive(t)) {
            sys::signal(t.proc.pid, t.group, libc::SIGKILL);
        }
        // A whole group's members are gone with SIGKILL too, even those not alive-checked.
        for t in live.iter().filter(|t| t.group) {
            sys::signal(t.proc.pgid, true, libc::SIGKILL);
        }
        live.len()
    }

    pub fn reap(run_dir: &Path) -> usize {
        let path = run_dir.join(RECORD);
        let Ok(raw) = std::fs::read(&path) else { return 0 };
        let _ = std::fs::remove_file(&path);
        let Ok(record) = serde_json::from_slice::<Record>(&raw) else { return 0 };
        let targets = leftovers(&record, &sys::processes(), sys::me());
        // A target's group may be gone once its leader is: SIGKILL by group
        // needs the leader, so end members one by one.
        let n = end(&targets, Duration::from_secs(1));
        for g in record.groups.iter().copied().chain(record.group).filter(|g| *g > 1) {
            // Whatever is still in a recorded group and started after the
            // predecessor did (the group id cannot have been reused while
            // members remain).
            let daemon_start = record.daemon.map_or(u64::MAX, |d| d.start);
            if sys::processes().iter().any(|p| p.pgid == g && p.start >= daemon_start && p.pid != sys::me()) {
                sys::signal(g, true, libc::SIGKILL);
            }
        }
        n
    }
}

/// Start keeping `<run_dir>/children.json` current (Unix; elsewhere the job
/// object does this job).
pub fn track(run_dir: &Path) {
    #[cfg(unix)]
    tracking::start(run_dir);
    #[cfg(not(unix))]
    let _ = run_dir;
}

/// End what a predecessor on this data directory left running, from its
/// record. Call with the data directory locked, before starting anything.
pub fn reap_leftovers(run_dir: &Path) {
    #[cfg(unix)]
    {
        let n = tracking::reap(run_dir);
        if n > 0 {
            eprintln!("nekkod: ended {n} process(es) an earlier nekkod left running");
        }
    }
    #[cfg(not(unix))]
    let _ = run_dir;
}

/// End everything this daemon started that is still running, then drop the
/// record: the last step of a shutdown.
pub fn sweep(grace: Duration) {
    #[cfg(unix)]
    {
        let n = tracking::sweep(grace);
        if n > 0 {
            eprintln!("nekkod: ended {n} child process(es) still running at shutdown");
        }
    }
    #[cfg(not(unix))]
    let _ = grace;
}

/// A shutdown that cannot finish (a second signal, or past its deadline):
/// end the children quickly and exit.
pub fn hard_exit(why: &str) -> ! {
    eprintln!("nekkod: {why}; ending child processes and exiting");
    sweep(Duration::from_millis(500));
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: i32, ppid: i32, pgid: i32, start: u64) -> Proc {
        Proc { pid, ppid, pgid, start }
    }

    #[test]
    fn ours_takes_descendants_and_their_groups_but_not_other_sessions() {
        let all = [
            p(1, 0, 1, 0),
            p(100, 1, 100, 10),   // the daemon, leading group 100
            p(101, 100, 100, 11), // a plain child
            p(102, 100, 102, 12), // a child leading its own group
            p(103, 102, 102, 13), // its child
            p(104, 1, 102, 14),   // orphaned grandchild, still in 102
            p(105, 1, 100, 15),   // orphaned grandchild, still in ours
            p(106, 100, 106, 16), // detached (another session)
            p(200, 1, 200, 5),    // unrelated
        ];
        let got = ours(&all, 100, Some(100), &[], &|pid| pid != 106);
        let mut pids: Vec<(i32, bool)> = got.iter().map(|t| (t.proc.pid, t.group)).collect();
        pids.sort_unstable();
        assert_eq!(pids, vec![(101, false), (102, true), (103, false), (104, false), (105, false)]);
    }

    #[test]
    fn ours_keeps_groups_seen_earlier() {
        // 102 led a group and exited; 104 is still in it.
        let all = [p(100, 1, 50, 10), p(104, 1, 102, 14), p(300, 1, 300, 1)];
        let got = ours(&all, 100, None, &[102], &|_| true);
        assert_eq!(got.iter().map(|t| t.proc.pid).collect::<Vec<_>>(), vec![104]);
    }

    #[test]
    fn leftovers_match_start_times_and_skip_a_live_predecessor() {
        let record = Record {
            daemon: Some(p(100, 1, 100, 10)),
            group: Some(100),
            children: vec![p(101, 100, 100, 11), p(102, 100, 102, 12), p(103, 100, 103, 13)],
            groups: vec![102],
        };
        let all = [
            p(101, 1, 100, 11),   // our leftover
            p(102, 1, 102, 12),   // our leftover, a group leader
            p(103, 1, 103, 99),   // pid reused by something else
            p(104, 1, 102, 20),   // grandchild in a recorded group
            p(105, 1, 100, 5),    // in group 100 but older than the daemon: not ours
            p(500, 1, 500, 1000), // the new daemon
        ];
        let mut got: Vec<(i32, bool)> = leftovers(&record, &all, 500).iter().map(|t| (t.proc.pid, t.group)).collect();
        got.sort_unstable();
        assert_eq!(got, vec![(101, false), (102, true), (104, false)]);

        let mut alive = all.to_vec();
        alive.push(p(100, 1, 100, 10));
        assert!(leftovers(&record, &alive, 500).is_empty(), "a predecessor still running is left alone");
        assert!(leftovers(&Record::default(), &all, 500).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn this_process_is_listed_with_a_start_time() {
        let me = sys::info(sys::me()).expect("own process info");
        assert!(me.start > 0);
        assert!(sys::processes().iter().any(|p| p.pid == me.pid && p.start == me.start));
    }
}
