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
    vm(h, true).write_seed(&iso, GITLAB_SEED, "concurrent = 1\n").await.unwrap();
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
    let content = std::fs::read_to_string(mount.join("gitlab-runner.toml"));
    let _ = std::process::Command::new("hdiutil").arg("detach").arg(&mount).output();
    assert_eq!(names, ["gitlab-runner.toml"]);
    assert_eq!(content.unwrap(), "concurrent = 1\n");
    assert_eq!(std::fs::metadata(&iso).unwrap().permissions().mode() & 0o777, 0o600, "the image holds a credential");
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    left.iter()
        .for_each(|n| assert!(["seed.iso", "m", "nekko-vm"].contains(&n.to_str().unwrap()), "{n:?} left behind"));
}

#[tokio::test]
async fn seed_file_name_is_checked() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("seed.iso");
    let h = helper(dir.path(), "exit 1");
    let vm = vm(h, true);
    for bad in ["../x", "", ".", "..", "a/b", "Jit-Config", &"a".repeat(65)] {
        assert!(vm.write_seed(&p, bad, "y").await.is_err(), "{bad:?}");
    }
    assert!(!p.exists());
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(left, ["nekko-vm"], "nothing written");
}

#[test]
fn nofile_target_values() {
    use crate::runner::nofile_target;
    assert_eq!(nofile_target(256, u64::MAX), 10_240);
    assert_eq!(nofile_target(256, 4096), 4096);
    assert_eq!(nofile_target(20_000, u64::MAX), 20_000);
}

#[test]
fn the_job_network_never_has_a_forward() {
    assert!(job_net_config(vec![]).forward.is_none());
    let dns: std::net::SocketAddr = "10.0.0.1:53".parse().unwrap();
    assert_eq!(job_net_config(vec![dns]).dns_upstream, vec![dns]);
}

#[test]
fn xcode_source_is_the_enclosing_app() {
    assert_eq!(
        xcode_source("/Applications/Xcode-beta.app/Contents/Developer"),
        Some(PathBuf::from("/Applications/Xcode-beta.app"))
    );
    assert_eq!(
        xcode_source("/Applications/Xcode.app/Contents/Developer\n"),
        Some(PathBuf::from("/Applications/Xcode.app"))
    );
    assert_eq!(xcode_source("/Library/Developer/CommandLineTools"), None);
    assert_eq!(xcode_source(""), None);
}

#[test]
fn tar_rename_lands_any_app_as_xcode_app() {
    assert_eq!(tar_rename_arg(Path::new("/Applications/Xcode.app")), None);
    assert_eq!(tar_rename_arg(Path::new("/Applications/Xcode-beta.app")).unwrap(), r"/^Xcode-beta\.app/Xcode.app/");
    assert_eq!(tar_rename_arg(Path::new("/Applications/Xcode 27.2.app")).unwrap(), r"/^Xcode 27\.2\.app/Xcode.app/");
}

/// `tar_rename_arg` against the real tar: the path, a hard link's target, and nothing else moves.
// BSD tar's `-s`, which is what the Mac that runs this has.
#[cfg(target_os = "macos")]
#[test]
fn tar_rename_works_with_the_real_tar() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("Xcode-beta.app");
    std::fs::create_dir_all(app.join("Contents")).unwrap();
    std::fs::write(app.join("Contents/a"), "x").unwrap();
    std::fs::hard_link(app.join("Contents/a"), app.join("Contents/b")).unwrap();
    std::os::unix::fs::symlink("a", app.join("Contents/link")).unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let tar = dir.path().join("t.tar");
    let made = Command::new("tar")
        .arg("-C")
        .arg(dir.path())
        .args(["-s", &tar_rename_arg(&app).unwrap(), "-cf"])
        .arg(&tar)
        .arg("Xcode-beta.app")
        .status()
        .unwrap();
    assert!(made.success());
    assert!(Command::new("tar").arg("-C").arg(&out).arg("-xpf").arg(&tar).status().unwrap().success());
    let landed = out.join("Xcode.app/Contents");
    assert_eq!(std::fs::read_to_string(landed.join("a")).unwrap(), "x");
    assert_eq!(std::fs::read_to_string(landed.join("b")).unwrap(), "x");
    assert_eq!(std::fs::read_link(landed.join("link")).unwrap(), PathBuf::from("a"));
}

/// Decision 0022: nothing on the job path can ask for a forward or first-boot options.
#[test]
fn the_job_path_has_no_first_boot_and_no_forward() {
    let src = include_str!("vm.rs");
    let job = src.split("async fn start(&self, spec: RunSpec)").nth(1).unwrap();
    let job = job.split("async fn count_vms").next().unwrap();
    assert!(job.contains("job_net_config("), "start uses the job network");
    for banned in ["--first-boot", "forward", "NetConfig {", "BuildSpec"] {
        assert!(!job.contains(banned), "HelperVm::start must not mention {banned}");
    }
    let spec = src.split("pub struct RunSpec").nth(1).unwrap().split('}').next().unwrap();
    assert!(!spec.contains("first_boot") && !spec.contains("forward") && !spec.contains("ssh"));
    // The one place a forward is set.
    assert_eq!(src.matches("forward: Some(").count(), 1);
    assert!(src.split("pub async fn start_build").nth(1).unwrap().contains("forward: Some("));
}

#[tokio::test]
async fn start_build_passes_first_boot_flags_and_no_seed() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().display();
    let h = helper(
        dir.path(),
        &format!("printf '%s\\n' \"$@\" > '{d}/args'\necho '{{\"event\":\"started\"}}'\nexec sleep 30"),
    );
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let bundle = dir.path().join("b");
    let pw = dir.path().join("pw");
    let spec = BuildSpec {
        bundle: bundle.clone(),
        cpus: 4,
        memory_mb: 8192,
        first_boot: Some(("nekko-build".into(), pw.clone())),
        ssh_port_listener: listener,
    };
    let handle = vm(h, true).start_build(spec).await.unwrap();
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    let want = format!(
        "run\n--bundle\n{}\n--cpus\n4\n--memory-mb\n8192\n--net-fd\n3\n--first-boot-user\nnekko-build\n--first-boot-password-file\n{}\n",
        bundle.display(),
        pw.display()
    );
    assert_eq!(args, want);
    handle.kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle.done).await.unwrap();
}
