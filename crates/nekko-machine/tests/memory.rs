//! Low memory judged, and the app to name: the rules the desktop's low-memory
//! prompt acts on. The platform reads run on this machine in `memory::tests`.

use nekko_machine::memory::{Level, MIN_APP_BYTES, Proc, app_name, level, own_pids, top_app, tree_bytes_of};

const GB: u64 = 1 << 30;

fn proc(pid: u32, parent: Option<u32>, name: &str, bytes: u64) -> Proc {
    Proc { pid, parent, name: name.into(), bytes }
}

#[test]
fn low_is_the_worse_of_physical_and_commit() {
    assert_eq!(level(64 * GB, 20 * GB, None), Level::Ok);
    assert_eq!(level(64 * GB, 5 * GB, None), Level::Low);
    assert_eq!(level(64 * GB, 2 * GB, None), Level::Critical);
    // The crash: plenty on standby, but 58 of 62.7 GB committed.
    assert_eq!(level(64 * GB, 20 * GB, Some((63 * GB, 4 * GB))), Level::Low);
    assert_eq!(level(64 * GB, 20 * GB, Some((63 * GB, GB))), Level::Critical);
    assert_eq!(level(0, 0, None), Level::Ok, "an unreadable machine is not low");
}

#[test]
fn an_app_is_its_processes_summed_without_nekko_or_the_system() {
    let procs = [
        proc(1, None, "explorer.exe", 9 * GB),
        proc(10, None, "nekkod.exe", GB / 10),
        proc(11, Some(10), "llama-server.exe", 12 * GB),
        proc(12, Some(11), "helper.exe", 3 * GB),
        proc(20, None, "Nekko Agent.exe", 2 * GB),
        proc(30, None, "chrome.exe", 3 * GB),
        proc(31, Some(30), "chrome.exe", 3 * GB),
        proc(40, None, "PioneerGame.exe", 5 * GB),
    ];
    let own = own_pids(&procs, 10);
    assert_eq!(own, [10, 11, 12, 20].into_iter().collect());
    let top = top_app(&procs, &own).unwrap();
    assert_eq!((top.name.as_str(), top.bytes, top.processes), ("chrome", 6 * GB, 2));
}

#[test]
fn a_model_server_frees_its_whole_tree() {
    let procs = [
        proc(10, None, "nekkod.exe", GB / 10),
        proc(11, Some(10), "llama-server.exe", 8 * GB),
        proc(12, Some(11), "conhost.exe", GB / 100),
        proc(13, Some(10), "llama-server.exe", 4 * GB),
        proc(14, Some(10), "claude.exe", GB),
    ];
    assert_eq!(tree_bytes_of(&procs, &[11, 13]), 12 * GB + GB / 100);
    assert_eq!(tree_bytes_of(&procs, &[]), 0);
}

#[test]
fn a_small_app_is_not_named() {
    let procs = [proc(1, None, "notepad.exe", MIN_APP_BYTES - 1)];
    assert_eq!(top_app(&procs, &own_pids(&procs, 99)), None);
}

#[test]
fn names_drop_the_exe() {
    assert_eq!(app_name("PioneerGame.exe"), "PioneerGame");
    assert_eq!(app_name("firefox"), "firefox");
}
