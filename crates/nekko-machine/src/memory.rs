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
//! Linux: `SIGTERM`), so it can still ask to save. WSL's VM (`vmmem`) is never
//! an app to close, but what it holds is answered on its own (`wsl_bytes`), so
//! the card can say when Docker or Linux tools hold the memory.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Below this much memory left, memory is low. A fixed amount, not a share of
/// the total: on a 64 GB machine with a big page file, 10% left was still 6 GB,
/// and asking then was a false alarm. What fails is the next allocation, and
/// that does not get bigger with the machine.
pub const LOW_BYTES: u64 = 2 << 30;
/// Below this much, it is critical: the next big allocation may fail.
pub const CRITICAL_BYTES: u64 = 1 << 30;
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
    /// Its process ids, ascending: which run of the app this is, so a person
    /// who waved it off is asked again only once it is closed and relaunched.
    pub pids: Vec<u32>,
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
    /// Windows only, read with the process list: what WSL's VM holds (Docker
    /// and Linux tools run there). Never `top_app`, since quitting it is not an
    /// app close, but the card says so when it holds the most. None when
    /// nothing of WSL's is running.
    pub wsl_bytes: Option<u64>,
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
        if left < CRITICAL_BYTES {
            Level::Critical
        } else if left < LOW_BYTES {
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
    let mut own = with_descendants(procs, &[me]);
    own.extend(procs.iter().filter(|p| p.name.to_ascii_lowercase().contains("nekko")).map(|p| p.pid));
    own
}

/// `roots` and every process under them.
fn with_descendants(procs: &[Proc], roots: &[u32]) -> HashSet<u32> {
    let mut tree: HashSet<u32> = roots.iter().copied().collect();
    let mut frontier = roots.to_vec();
    while let Some(parent) = frontier.pop() {
        for p in procs.iter().filter(|p| p.parent == Some(parent)) {
            if tree.insert(p.pid) {
                frontier.push(p.pid);
            }
        }
    }
    tree
}

/// What `roots` and the processes under them hold: what stopping them frees.
pub fn tree_bytes_of(procs: &[Proc], roots: &[u32]) -> u64 {
    let tree = with_descendants(procs, roots);
    procs.iter().filter(|p| tree.contains(&p.pid)).map(|p| p.bytes).sum()
}

/// `tree_bytes_of` the processes running now (the model servers, say).
pub fn tree_bytes(roots: &[u32]) -> u64 {
    if roots.is_empty() {
        return 0;
    }
    tree_bytes_of(&processes(), roots)
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
        let app = apps.entry(name.to_ascii_lowercase()).or_insert_with(|| App {
            name,
            bytes: 0,
            processes: 0,
            pids: Vec::new(),
        });
        app.bytes += p.bytes;
        app.processes += 1;
        app.pids.push(p.pid);
    }
    let mut top = apps.into_values().filter(|a| a.bytes >= MIN_APP_BYTES).max_by_key(|a| a.bytes)?;
    top.pids.sort_unstable();
    Some(top)
}

/// WSL's VM: `vmmem`, or `vmmemWSL` on newer Windows.
fn is_wsl(process: &str) -> bool {
    matches!(app_name(process).to_ascii_lowercase().as_str(), "vmmem" | "vmmemwsl")
}

/// What WSL's VM holds: its `vmmem` / `vmmemWSL` processes, summed. None when
/// there is none, or it holds nothing.
pub fn wsl_bytes(procs: &[Proc]) -> Option<u64> {
    let bytes: u64 = procs.iter().filter(|p| is_wsl(&p.name)).map(|p| p.bytes).sum();
    (bytes > 0).then_some(bytes)
}

/// What WSL's VM holds now, given the process list just read. sysinfo opens a
/// process to read its memory, and a person's account cannot open `vmmemWSL`,
/// so sysinfo reads it as 0 bytes: when the VM is running, its private commit
/// comes from the kernel's process snapshot instead, which needs no handle.
#[cfg(windows)]
fn wsl_now(procs: &[Proc]) -> Option<u64> {
    if !procs.iter().any(|p| is_wsl(&p.name)) {
        return None;
    }
    wsl_bytes(procs).max(wsl_bytes(&snapshot()))
}

#[cfg(not(windows))]
fn wsl_now(_procs: &[Proc]) -> Option<u64> {
    None
}

/// Every process with its private commit, from `NtQuerySystemInformation`
/// (what Task Manager and `Get-Process` read). No parents: only names and bytes.
#[cfg(windows)]
fn snapshot() -> Vec<Proc> {
    use windows_sys::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};
    use windows_sys::Win32::System::WindowsProgramming::SYSTEM_PROCESS_INFORMATION;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
    let entry = std::mem::size_of::<SYSTEM_PROCESS_INFORMATION>();
    let mut len = 1usize << 20;
    // The list can grow between asking its size and reading it: a few tries.
    for _ in 0..4 {
        // u64s, so every entry the kernel writes is aligned.
        let mut buf = vec![0u64; len.div_ceil(8)];
        let bytes = buf.len() * 8;
        let mut needed = 0u32;
        // SAFETY: the buffer is `bytes` long, writable and 8-aligned.
        let status = unsafe {
            NtQuerySystemInformation(SystemProcessInformation, buf.as_mut_ptr().cast(), bytes as u32, &mut needed)
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            len = (needed as usize).max(len) + (64 << 10);
            continue;
        }
        if status < 0 {
            return Vec::new();
        }
        let base = buf.as_ptr().cast::<u8>();
        let mut procs = Vec::new();
        let mut offset = 0usize;
        while offset + entry <= bytes {
            // SAFETY: an entry the kernel wrote, inside the buffer (checked
            // above); its name points into the same buffer, which is alive.
            let info = unsafe { &*base.add(offset).cast::<SYSTEM_PROCESS_INFORMATION>() };
            let name = if info.ImageName.Buffer.is_null() {
                String::new()
            } else {
                String::from_utf16_lossy(unsafe {
                    std::slice::from_raw_parts(info.ImageName.Buffer, info.ImageName.Length as usize / 2)
                })
            };
            procs.push(Proc {
                pid: info.UniqueProcessId as usize as u32,
                parent: None,
                name,
                bytes: info.PrivatePageCount as u64,
            });
            if info.NextEntryOffset == 0 {
                break;
            }
            offset += info.NextEntryOffset as usize;
        }
        return procs;
    }
    Vec::new()
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
    let (top_app, nekko_bytes, wsl_bytes) = if detail || level != Level::Ok {
        let procs = processes();
        let own = own_pids(&procs, std::process::id());
        let nekko = procs.iter().filter(|p| own.contains(&p.pid)).map(|p| p.bytes).sum();
        (top_app(&procs, &own), Some(nekko), wsl_now(&procs))
    } else {
        (None, None, None)
    };
    MemoryState {
        level,
        total_bytes: total,
        available_bytes: available,
        commit_limit_bytes: commit.map(|c| c.0),
        commit_available_bytes: commit.map(|c| c.1),
        top_app,
        nekko_bytes,
        wsl_bytes,
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
    use super::*;

    const GB: u64 = 1 << 30;

    fn proc(pid: u32, name: &str, bytes: u64) -> Proc {
        Proc { pid, parent: None, name: name.into(), bytes }
    }

    #[test]
    fn wsl_is_its_vm_summed_and_never_the_top_app() {
        let procs = [
            proc(1, "vmmemWSL", 23 * GB),
            proc(2, "vmmem", GB),
            proc(3, "VMMEM.EXE", GB / 2),
            proc(4, "claude.exe", 6 * GB),
            proc(5, "vmmemwslhelper", 4 * GB),
        ];
        assert_eq!(wsl_bytes(&procs), Some(23 * GB + GB + GB / 2));
        // The VM is not an app to close: the card names it another way.
        assert_eq!(top_app(&procs, &HashSet::new()).map(|a| a.name), Some("claude".into()));
    }

    #[test]
    fn no_wsl_is_none() {
        assert_eq!(wsl_bytes(&[proc(1, "chrome.exe", 3 * GB)]), None);
        assert_eq!(wsl_bytes(&[proc(1, "vmmemWSL", 0)]), None);
        assert_eq!(wsl_bytes(&[]), None);
    }

    #[test]
    fn reads_this_machine() {
        let s = super::state(true);
        // WSL's VM, when it runs, is read: it always holds something.
        if cfg!(windows) && super::processes().iter().any(|p| super::is_wsl(&p.name)) {
            assert!(s.wsl_bytes.is_some_and(|b| b > 0), "vmmem is running but read as nothing");
        }
        assert!(s.total_bytes > 0 && s.available_bytes <= s.total_bytes);
        assert!(s.nekko_bytes.is_some_and(|b| b > 0), "the test process itself counts as Nekko");
        assert_eq!(s.commit_limit_bytes.is_some(), cfg!(windows));
    }
}
