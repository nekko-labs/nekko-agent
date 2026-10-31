//! Whether this computer is running out of memory (`memory:state`), which app
//! holds the most, and asking that app to close (`memory:closeApp`), so the
//! desktop app can offer a way out before an allocation fails somewhere (it
//! took nekkod down once, with a game holding 14 GB).
//!
//! Low memory is judged on what is left to hand out:
//!
//! - Every platform: available physical memory (sysinfo's `available_memory`,
//!   which counts reclaimable caches).
//! - Windows also: the commit charge against its limit (`GlobalMemoryStatusEx`).
//!   That is what runs out first there: an allocation fails once the commit
//!   limit is reached, however much physical memory is on standby.
//!
//! An app is a process name, summed over its processes (a browser is many).
//! Nekko's own processes, the system's and anything under 1 GiB are never
//! named. Closing an app asks it the way a person would (Windows: `taskkill`
//! without `/F`, which sends a close to its windows; macOS: AppleScript `quit`;
//! Linux: `SIGTERM`), so it can still ask to save.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Below this share of memory left, memory is low.
pub const LOW_SHARE: f64 = 0.10;
/// Below this share, it is critical: the next big allocation may fail.
pub const CRITICAL_SHARE: f64 = 0.05;
/// An app holding less than this is not worth naming.
pub const MIN_APP_BYTES: u64 = 1 << 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Ok,
    Low,
    Critical,
}

/// The app holding the most memory.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// The process name without `.exe`.
    pub name: String,
    pub bytes: u64,
    pub processes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryState {
    pub level: Level,
    pub total_bytes: u64,
    pub available_bytes: u64,
    /// Windows only: the commit limit and what is left of it.
    pub commit_limit_bytes: Option<u64>,
    pub commit_available_bytes: Option<u64>,
    /// Only read when memory is not `ok`: listing processes costs tens of ms.
    pub top_app: Option<App>,
    /// What Nekko's own processes hold (the daemon and its model servers).
    pub nekko_bytes: Option<u64>,
}

/// One process as the judge sees it.
#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub bytes: u64,
}

/// The level for what is left: the worse of physical memory and, where there
/// is one, the commit limit.
pub fn level(total: u64, available: u64, commit: Option<(u64, u64)>) -> Level {
    let of = |total: u64, left: u64| {
        if total == 0 {
            return Level::Ok;
        }
        let share = left as f64 / total as f64;
        if share < CRITICAL_SHARE {
            Level::Critical
        } else if share < LOW_SHARE {
            Level::Low
        } else {
            Level::Ok
        }
    };
    let physical = of(total, available);
    commit.map_or(physical, |(limit, left)| physical.max(of(limit, left)))
}

/// `chrome.exe` and `Chrome` are the same app.
pub fn app_name(process: &str) -> String {
    let n = process.trim();
    n.strip_suffix(".exe").or_else(|| n.strip_suffix(".EXE")).unwrap_or(n).to_string()
}

/// Processes that keep the system up, or that a close would not help with
/// (WSL's VM, say): never offered.
fn system(name: &str) -> bool {
    const SYSTEM: &[&str] = &[
        "system",
        "registry",
        "memory compression",
        "secure system",
        "idle",
        "smss",
        "csrss",
        "wininit",
        "winlogon",
        "services",
        "lsass",
        "svchost",
        "dwm",
        "explorer",
        "fontdrvhost",
        "sihost",
        "msmpeng",
        "searchhost",
        "startmenuexperiencehost",
        "shellexperiencehost",
        "textinputhost",
        "runtimebroker",
        "vmmem",
        "vmmemwsl",
        "vmcompute",
        "kernel_task",
        "windowserver",
        "launchd",
        "loginwindow",
        "finder",
        "dock",
        "systemd",
        "xorg",
        "xwayland",
        "gnome-shell",
        "kwin_x11",
        "kwin_wayland",
        "plasmashell",
    ];
    let n = name.to_ascii_lowercase();
    SYSTEM.contains(&n.as_str()) || n.starts_with("kworker")
}

/// Nekko's processes: the daemon and every process under it (model servers),
/// and anything named Nekko (the desktop app and its helpers).
pub fn own_pids(procs: &[Proc], me: u32) -> HashSet<u32> {
    let mut own: HashSet<u32> =
        procs.iter().filter(|p| p.name.to_ascii_lowercase().contains("nekko")).map(|p| p.pid).collect();
    own.insert(me);
    let mut frontier = vec![me];
    while let Some(parent) = frontier.pop() {
        for p in procs.iter().filter(|p| p.parent == Some(parent)) {
            if own.insert(p.pid) {
                frontier.push(p.pid);
            }
        }
    }
    own
}

/// The app outside Nekko and the system that holds the most memory, if it
/// holds at least `MIN_APP_BYTES`.
pub fn top_app(procs: &[Proc], own: &HashSet<u32>) -> Option<App> {
    let mut apps: HashMap<String, App> = HashMap::new();
    for p in procs.iter().filter(|p| !own.contains(&p.pid)) {
        let name = app_name(&p.name);
        if name.is_empty() || system(&name) {
            continue;
        }
        let app = apps.entry(name.to_ascii_lowercase()).or_insert_with(|| App { name, bytes: 0, processes: 0 });
        app.bytes += p.bytes;
        app.processes += 1;
    }
    apps.into_values().filter(|a| a.bytes >= MIN_APP_BYTES).max_by_key(|a| a.bytes)
}

/// What each process holds. On Windows that is its private commit (what
/// counts against the limit); elsewhere its resident memory, since the
/// virtual size there includes every mapping.
fn processes() -> Vec<Proc> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_exe(UpdateKind::Never),
    );
    sys.processes()
        .values()
        .map(|p| Proc {
            pid: p.pid().as_u32(),
            parent: p.parent().map(|q| q.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            bytes: if cfg!(windows) { p.virtual_memory().max(p.memory()) } else { p.memory() },
        })
        .collect()
}

#[cfg(windows)]
fn commit() -> Option<(u64, u64)> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: a zeroed struct with its length set, as the call requires.
    unsafe {
        let mut s: MEMORYSTATUSEX = std::mem::zeroed();
        s.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (GlobalMemoryStatusEx(&mut s) != 0).then_some((s.ullTotalPageFile, s.ullAvailPageFile))
    }
}

#[cfg(not(windows))]
fn commit() -> Option<(u64, u64)> {
    None
}

/// Memory now. The process list is read only when memory is short, unless
/// `detail` asks for it anyway.
pub fn state(detail: bool) -> MemoryState {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let (total, available) = (sys.total_memory(), sys.available_memory());
    let commit = commit();
    let level = level(total, available, commit);
    let (top_app, nekko_bytes) = if detail || level != Level::Ok {
        let procs = processes();
        let own = own_pids(&procs, std::process::id());
        let nekko = procs.iter().filter(|p| own.contains(&p.pid)).map(|p| p.bytes).sum();
        (top_app(&procs, &own), Some(nekko))
    } else {
        (None, None)
    };
    MemoryState {
        level,
        total_bytes: total,
        available_bytes: available,
        commit_limit_bytes: commit.map(|c| c.0),
        commit_available_bytes: commit.map(|c| c.1),
        top_app,
        nekko_bytes,
    }
}

/// Ask every process of the app `name` to close, the way a person would. Never
/// Nekko's own or the system's. Returns how many were asked.
pub fn close_app(name: &str) -> Result<usize, String> {
    let wanted = app_name(name).to_ascii_lowercase();
    if wanted.is_empty() || system(&wanted) || wanted.contains("nekko") {
        return Err(format!("{name} cannot be closed from here."));
    }
    let procs = processes();
    let own = own_pids(&procs, std::process::id());
    let pids: Vec<u32> = procs
        .iter()
        .filter(|p| !own.contains(&p.pid) && app_name(&p.name).to_ascii_lowercase() == wanted)
        .map(|p| p.pid)
        .collect();
    if pids.is_empty() {
        return Err(format!("{name} is not running."));
    }
    ask_to_close(name, &pids)?;
    Ok(pids.len())
}

#[cfg(windows)]
fn ask_to_close(name: &str, pids: &[u32]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Without /F, taskkill posts WM_CLOSE to the app's windows: it closes as
    // if its close button were pressed. Processes without a window refuse,
    // and go when their main process does.
    let mut cmd = std::process::Command::new("taskkill");
    for pid in pids {
        cmd.arg("/PID").arg(pid.to_string());
    }
    let out = cmd.creation_flags(CREATE_NO_WINDOW).output().map_err(|e| e.to_string())?;
    let said = String::from_utf8_lossy(&out.stdout);
    if said.contains("SUCCESS") { Ok(()) } else { Err(format!("{name} did not accept the request to close.")) }
}

#[cfg(target_os = "macos")]
fn ask_to_close(name: &str, pids: &[u32]) -> Result<(), String> {
    // AppleScript's quit lets the app ask to save; a helper process with no
    // app of that name gets SIGTERM instead.
    let quoted = name.replace('\\', "\\\\").replace('"', "\\\"");
    let quit = std::process::Command::new("osascript").args(["-e", &format!("quit app \"{quoted}\"")]).output();
    if quit.is_ok_and(|o| o.status.success()) {
        return Ok(());
    }
    terminate(name, pids)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn ask_to_close(name: &str, pids: &[u32]) -> Result<(), String> {
    terminate(name, pids)
}

#[cfg(unix)]
fn terminate(name: &str, pids: &[u32]) -> Result<(), String> {
    let mut asked = 0;
    for pid in pids {
        // SAFETY: kill(2) with a pid read just now and SIGTERM.
        if unsafe { libc::kill(*pid as libc::pid_t, libc::SIGTERM) } == 0 {
            asked += 1;
        }
    }
    if asked > 0 { Ok(()) } else { Err(format!("{name} did not accept the request to close.")) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_this_machine() {
        let s = super::state(true);
        assert!(s.total_bytes > 0 && s.available_bytes <= s.total_bytes);
        assert!(s.nekko_bytes.is_some_and(|b| b > 0), "the test process itself counts as Nekko");
        assert_eq!(s.commit_limit_bytes.is_some(), cfg!(windows));
    }
}
