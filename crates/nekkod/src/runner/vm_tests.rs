use super::*;
use nekko_runner::HostNets;
use std::os::unix::fs::PermissionsExt;

/// A fake `nekko-vm` in `dir`: `body` after a shebang.
fn helper(dir: &Path, body: &str) -> PathBuf {
    let p = dir.join("nekko-vm");
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
    p
}

fn vm(helper: PathBuf, physical: bool) -> HelperVm {
    let egress =
        Egress { physical: Some(("lo0".into(), 1)), vpn_carries_default: false, expensive: false, constrained: false };
    let mut v = HelperVm::new(
        helper,
        Arc::new(RwLock::new(HostNets::default())),
        Arc::new(RwLock::new(physical.then_some(egress))),
    );
    v.stop_grace = Duration::from_millis(200);
    v.start_timeout = Duration::from_secs(5);
    v
}

fn spec(dir: &Path) -> RunSpec {
    RunSpec { bundle: dir.join("vm.bundle"), cpus: 4, memory_mb: 8192, seed: dir.join("seed.iso") }
}

/// The pid the fake helper wrote to `dir/pid`.
async fn pid(dir: &Path) -> libc::pid_t {
    for _ in 0..100 {
        if let Ok(s) = std::fs::read_to_string(dir.join("pid"))
            && let Ok(p) = s.trim().parse()
        {
            return p;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the helper never wrote its pid");
}

fn alive(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[tokio::test]
async fn helper_vm_runs_the_documented_command_line() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    let h = helper(
        dir.path(),
        &format!(
            "[ -e /dev/fd/3 ] && echo yes > '{d}/fd3'\nprintf '%s\\n' \"$@\" > '{d}/args'\necho '{{\"event\":\"started\"}}'\nexec sleep 30"
        ),
    );
    let s = spec(dir.path());
    let handle = vm(h, true).start(s.clone()).await.unwrap();
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    let want = format!(
        "run\n--bundle\n{}\n--cpus\n4\n--memory-mb\n8192\n--net-fd\n3\n--seed\n{}\n",
        s.bundle.display(),
        s.seed.display()
    );
    assert_eq!(args, want);
    assert!(dir.path().join("fd3").exists(), "the NAT socket is fd 3");
    handle.kill();
    let done = tokio::time::timeout(Duration::from_secs(2), handle.done).await.unwrap().unwrap();
    assert!(matches!(done, Stopped::Error(_)), "{done:?}");
}

#[tokio::test]
async fn request_stop_escalates_to_sigkill() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    let h = helper(
        dir.path(),
        &format!("trap '' TERM\necho $$ > '{d}/pid'\necho '{{\"event\":\"started\"}}'\nexec sleep 30"),
    );
    let handle = vm(h, true).start(spec(dir.path())).await.unwrap();
    let pid = pid(dir.path()).await;
    handle.request_stop();
    let done = tokio::time::timeout(Duration::from_secs(2), handle.done).await.unwrap().unwrap();
    assert!(matches!(done, Stopped::Error(_) | Stopped::Signal), "{done:?}");
    assert!(!alive(pid), "the helper is killed and reaped");
}

#[tokio::test]
async fn guest_stop_resolves_done() {
    let dir = tempfile::tempdir().unwrap();
    let h = helper(
        dir.path(),
        "echo '{\"event\":\"started\"}'\necho '{\"event\":\"stopped\",\"reason\":\"guest\",\"detail\":\"\"}'\nexit 0",
    );
    let handle = vm(h, true).start(spec(dir.path())).await.unwrap();
    let done = tokio::time::timeout(Duration::from_secs(5), handle.done).await.unwrap().unwrap();
    assert_eq!(done, Stopped::Guest);
}

#[tokio::test]
async fn start_times_out_and_kills_the_helper() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    let h = helper(dir.path(), &format!("echo $$ > '{d}/pid'\nexec sleep 30"));
    let mut v = vm(h, true);
    v.start_timeout = Duration::from_secs(1);
    assert!(v.start(spec(dir.path())).await.is_err());
    assert!(!alive(pid(dir.path()).await), "the helper is killed and reaped");
}

#[tokio::test]
async fn start_refuses_without_a_physical_interface() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    let h = helper(dir.path(), &format!("echo ran > '{d}/args'\necho '{{\"event\":\"started\"}}'\nexec sleep 30"));
    assert!(vm(h, false).start(spec(dir.path())).await.is_err());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!dir.path().join("args").exists(), "the helper never ran");
}

#[tokio::test]
async fn clone_reports_the_helpers_error() {
    let dir = tempfile::tempdir().unwrap();
    let h = helper(dir.path(), "echo '{\"ok\":false,\"error\":\"x already exists\"}'\nexit 1");
    let r = vm(h, true).clone_bundle(Path::new("/a"), Path::new("/x")).await;
    assert_eq!(r, Err("x already exists".into()));
    let ok = helper(dir.path(), "echo '{\"ok\":true}'");
    assert_eq!(vm(ok, true).clone_bundle(Path::new("/a"), Path::new("/x")).await, Ok(()));
}

#[tokio::test]
async fn clone_removes_only_its_own_partial_target() {
    let dir = tempfile::tempdir().unwrap();
    // The helper made the folder, then failed (or was killed) mid-clone.
    let h = helper(dir.path(), "mkdir \"$5\"\necho '{\"ok\":false,\"error\":\"clonefile failed\"}'\nexit 1");
    let to = dir.path().join("vm-1");
    assert_eq!(vm(h.clone(), true).clone_bundle(Path::new("/a"), &to).await, Err("clonefile failed".into()));
    assert!(!to.exists(), "the partial clone is removed");
    // A target that was already there is refused and left alone.
    std::fs::create_dir(&to).unwrap();
    std::fs::write(to.join("keep.txt"), b"keep").unwrap();
    assert!(vm(h, true).clone_bundle(Path::new("/a"), &to).await.unwrap_err().contains("already exists"));
    assert!(to.join("keep.txt").exists());
}

#[tokio::test]
async fn count_vms_times_out_and_kills_the_helper() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    let h = helper(dir.path(), &format!("echo $$ > '{d}/pid'\nexec sleep 30"));
    let mut v = vm(h, true);
    v.count_timeout = Duration::from_secs(1);
    let r = tokio::time::timeout(Duration::from_secs(3), v.count_vms()).await.expect("count-vms hung the caller");
    assert!(r.unwrap_err().contains("did not finish"));
    assert!(!alive(pid(dir.path()).await), "the helper is killed and reaped");
}

#[tokio::test]
async fn nat_failure_stops_the_vm() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    let h = helper(dir.path(), &format!("echo $$ > '{d}/pid'\nexec sleep 30"));
    let mut child = tokio::process::Command::new(&h).stdout(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let pid = pid(dir.path()).await;
    let (done_tx, done_rx) = oneshot::channel();
    let (_stop_tx, stop_rx) = mpsc::unbounded_channel();
    let nat = async { Err::<(), _>(io::Error::other("socket broke")) };
    tokio::spawn(supervise(child, lines, nat, stop_rx, Duration::from_secs(30), done_tx));
    let done = tokio::time::timeout(Duration::from_secs(2), done_rx).await.expect("the VM kept running").unwrap();
    assert_eq!(done, Stopped::Error("the VM's network failed: socket broke".into()));
    assert!(!alive(pid), "the helper is killed and reaped");
}

#[tokio::test]
async fn count_vms_parses_and_rejects_garbage() {
    let dir = tempfile::tempdir().unwrap();
    let h = helper(dir.path(), "echo '{\"count\":1}'");
    assert_eq!(vm(h, true).count_vms().await, Ok(1));
    let h = helper(dir.path(), "echo nope");
    assert!(vm(h, true).count_vms().await.is_err());
}

#[tokio::test]
async fn reap_deletes_leftovers_but_not_through_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let vms = dir.path().join("vms");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(vms.join("a")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(vms.join("a/disk.img"), b"disk").unwrap();
    std::fs::write(vms.join("seed.iso"), b"seed").unwrap();
    std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
    std::os::unix::fs::symlink(&outside, vms.join("link")).unwrap();
    assert_eq!(reap(&vms).await.unwrap(), 3);
    assert!(vms.is_dir());
    assert_eq!(std::fs::read_dir(&vms).unwrap().count(), 0);
    assert!(outside.join("keep.txt").exists());
    // A missing directory has nothing to reap.
    assert_eq!(reap(&dir.path().join("none")).await.unwrap(), 0);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn seed_image_holds_only_the_config() {
    let dir = tempfile::tempdir().unwrap();
    let iso = dir.path().join("seed.iso");
    let h = helper(dir.path(), "exit 1");
    vm(h, true).write_seed(&iso, "{\"jit\":\"abc\"}").await.unwrap();
    let mount = dir.path().join("m");
    std::fs::create_dir(&mount).unwrap();
    let ok = std::process::Command::new("hdiutil")
        .args(["attach", "-readonly", "-nobrowse", "-mountpoint"])
        .arg(&mount)
        .arg(&iso)
        .output()
        .unwrap();
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
    let names: Vec<String> = std::fs::read_dir(&mount)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_lowercase())
        .filter(|n| !n.starts_with('.'))
        .collect();
    let content = std::fs::read_to_string(mount.join("jit-config"));
    let _ = std::process::Command::new("hdiutil").arg("detach").arg(&mount).output();
    assert_eq!(names, ["jit-config"]);
    assert_eq!(content.unwrap(), "{\"jit\":\"abc\"}");
    assert_eq!(std::fs::metadata(&iso).unwrap().permissions().mode() & 0o777, 0o600, "the image holds a credential");
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    left.iter()
        .for_each(|n| assert!(["seed.iso", "m", "nekko-vm"].contains(&n.to_str().unwrap()), "{n:?} left behind"));
}

#[test]
fn nofile_target_values() {
    use crate::runner::nofile_target;
    assert_eq!(nofile_target(256, u64::MAX), 10_240);
    assert_eq!(nofile_target(256, 4096), 4096);
    assert_eq!(nofile_target(20_000, u64::MAX), 20_000);
}
