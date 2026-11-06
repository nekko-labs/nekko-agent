//! Spike only, never shipped: boots a real macOS VM through `nekko-vm` with the
//! runner NAT as its only network, and forwards 127.0.0.1:2222 on the host to
//! the guest's port 22 so a person can ssh in and measure. Job VMs have no such
//! forward (decision 0022); image builds use it too (decision 0038).
//!
//!   cargo run -p nekkod --features spike --example runner_vm_spike -- [--bundle <dir>] [--seed <iso>] [--keep]
//!
//! `--seed` attaches a NEKKOSEED image read-only, as nekkod does for a job.
//! `--keep` leaves the clone on disk after a clean exit (the T214 boot check
//! provisions one clone and boots a clone of that).
//!
//! The bundle defaults to Tart's cached `macos-sequoia-base` (its files only,
//! no Tart code). The clone lives under `target/runner-spike/` and is deleted
//! on a clean exit (Ctrl-C or the guest stopping); after a SIGKILL it stays,
//! as it would for the supervisor's reaper.

#[path = "../src/runner/egress.rs"]
#[allow(dead_code)]
mod egress;
#[path = "../src/runner/hostnets.rs"]
#[allow(dead_code)]
mod hostnets;
#[path = "../src/runner/lan.rs"]
#[allow(dead_code)]
mod lan;
#[path = "../src/runner/net.rs"]
#[allow(dead_code)]
mod net;

use std::os::fd::AsRawFd;
use std::os::unix::net::UnixDatagram;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, RwLock};
use std::time::Duration;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

#[tokio::main]
async fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let home = PathBuf::from(std::env::var("HOME")?);
    let bundle = flag("--bundle")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".tart/cache/OCIs/ghcr.io/cirruslabs/macos-sequoia-base/latest"));
    let seed = flag("--seed").map(PathBuf::from);
    let keep = args.iter().any(|a| a == "--keep");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()?;
    let work = repo.join("target/runner-spike");
    std::fs::create_dir_all(&work)?;
    let helper = build_helper(&repo, &work)?;

    // Fail closed: without the host's addresses the policy cannot keep the guest off them.
    // The router's public address is refused too, learned from the router itself.
    let route = Command::new("route").args(["-n", "get", "default"]).output()?;
    let wan = match lan::default_gateway(&String::from_utf8_lossy(&route.stdout)) {
        Some(gw) => lan::discover_wan(gw).await,
        None => vec![],
    };
    println!("router WAN address: {wan:?}");
    let host =
        Arc::new(RwLock::new(hostnets::try_current_with(&wan).map_err(|e| format!("cannot read host networks: {e}"))?));
    hostnets::spawn_refresh(host.clone(), Duration::from_secs(5), Arc::new(RwLock::new(wan)));
    // The NAT refuses every flow until the helper reports the physical interface.
    let egress = egress::spawn_watch(&helper);
    let mut index = None;
    for _ in 0..50 {
        index = egress.read().ok().and_then(|e| e.as_ref()?.physical.as_ref().map(|p| p.1));
        if index.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let index = index.ok_or("no physical network interface")?;
    let scutil = Command::new("scutil").arg("--dns").output()?;
    let dns =
        lan::dns_upstreams(&String::from_utf8_lossy(&scutil.stdout), index, &*host.read().map_err(|_| "host lock")?);
    println!("dns upstreams: {dns:?}");

    // Everything that can fail is ready before the clone exists, so no early
    // return leaves a VM or a clone behind.
    let forward = std::net::TcpListener::bind("127.0.0.1:2222")?;
    let cfg = net::NetConfig { dns_upstream: dns, forward: Some((forward, 22)), ..Default::default() };
    let (vm_end, nat_end) = UnixDatagram::pair()?;
    // macOS gives unix datagram sockets 4 KiB; the helper's end needs the room too.
    net::widen_buffers(&vm_end)?;
    nat_end.set_nonblocking(true)?;
    let nat_end = tokio::net::UnixDatagram::from_std(nat_end)?;

    let before = count_vms(&helper)?;
    println!("vms before: {before}");
    // From here every exit but SIGKILL goes through Cleanup's drop.
    let mut vm = Cleanup {
        child: None,
        clone: work.join(format!("clone-{}", std::process::id())),
        helper: helper.clone(),
        before,
        keep,
    };
    let out = Command::new(&helper).arg("clone").arg("--from").arg(&bundle).arg("--to").arg(&vm.clone).output()?;
    println!("clone: {}", String::from_utf8_lossy(&out.stdout).trim());
    if !out.status.success() {
        return Err("clone failed".into());
    }

    let vm_fd = vm_end.as_raw_fd();
    let mut cmd = Command::new(&helper);
    cmd.args(["run", "--cpus", "4", "--memory-mb", "8192", "--net-fd", "3", "--bundle"]).arg(&vm.clone);
    if let Some(seed) = &seed {
        cmd.arg("--seed").arg(seed);
    }
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            // dup2 clears close-on-exec on the copy; if the fd is already 3, clear it by hand.
            let rc = if vm_fd == 3 { libc::fcntl(3, libc::F_SETFD, 0) } else { libc::dup2(vm_fd, 3) };
            if rc < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
        });
    }
    let child = vm.child.insert(tokio::process::Command::from(cmd).spawn()?);
    drop(vm_end);
    let pid = child.id().map(|p| p as libc::pid_t);
    println!("nekko-vm pid {}", pid.unwrap_or(0));
    println!("ssh -p 2222 admin@127.0.0.1 once the guest is up; Ctrl-C stops the VM");
    let strip = tokio::spawn(strip_tart_agent(work.clone()));

    let serve = net::serve(nat_end, host, egress, cfg);
    tokio::pin!(serve);
    tokio::select! {
        r = &mut serve => println!("nat ended: {r:?}"),
        s = child.wait() => println!("nekko-vm exited: {s:?}"),
        _ = tokio::signal::ctrl_c() => {
            if let Some(pid) = pid {
                // SAFETY: signalling our own child.
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
            // Keep the NAT up through SIGTERM's grace (the helper stops the
            // guest within 20 s): dropping it closes the socket, and the
            // helper would pull the plug at once.
            tokio::select! {
                s = tokio::time::timeout(Duration::from_secs(30), child.wait()) => println!("nekko-vm exited: {s:?}"),
                r = &mut serve => println!("nat ended: {r:?}"),
            }
        }
    }
    strip.abort();
    // If the NAT ended first, the helper sees its socket close within a second.
    let status = tokio::time::timeout(Duration::from_secs(30), child.wait()).await;
    println!("nekko-vm: {status:?}");
    Ok(())
}

/// Spike only: the Cirrus base image ships Tart's guest agent, which makes
/// the guest reboot every 12 to 15 s when Tart is not the host. Once SSH is
/// up, the agent's launchd plists are moved aside in this clone (the source
/// image is untouched). Our own golden image (T214) will not contain it.
async fn strip_tart_agent(work: PathBuf) {
    let askpass = work.join("askpass.sh");
    if std::fs::write(&askpass, "#!/bin/sh\necho admin\n").is_err()
        || std::fs::set_permissions(&askpass, std::os::unix::fs::PermissionsExt::from_mode(0o700)).is_err()
    {
        return println!("tart agent: cannot write the askpass script");
    }
    let script = "mkdir -p ~/tart-agent-disabled; for f in /Library/LaunchDaemons/org.cirruslabs.tart-guest-daemon.plist \
        /Library/LaunchAgents/org.cirruslabs.tart-guest-agent.plist; do [ -e $f ] && sudo -n mv $f ~/tart-agent-disabled/; done; \
        ls /Library/LaunchDaemons/org.cirruslabs.* /Library/LaunchAgents/org.cirruslabs.* >/dev/null 2>&1 || echo agent-off";
    for _ in 0..100 {
        let out = tokio::process::Command::new("ssh")
            .args(["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"])
            .args(["-o", "ConnectTimeout=5", "-o", "PubkeyAuthentication=no", "-p", "2222", "admin@127.0.0.1", script])
            .env("SSH_ASKPASS", &askpass)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .stdin(std::process::Stdio::null())
            .output()
            .await;
        if out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("agent-off")) {
            return println!("tart agent: moved aside in the guest");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    println!("tart agent: could not reach the guest over ssh");
}

/// The one cleanup path, for every exit but SIGKILL (that leaves the clone
/// for the reaper): the helper is killed and reaped first, then the VM count
/// is checked, then the clone is removed.
struct Cleanup {
    child: Option<tokio::process::Child>,
    clone: PathBuf,
    helper: PathBuf,
    before: String,
    keep: bool,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.start_kill();
            let end = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                match child.try_wait() {
                    Ok(Some(s)) => break println!("nekko-vm reaped: {s}"),
                    Err(e) => break println!("nekko-vm wait failed: {e}"),
                    Ok(None) if std::time::Instant::now() > end => break println!("nekko-vm still running after 10 s"),
                    Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        }
        match count_vms(&self.helper) {
            Ok(after) => println!("vms after: {after} (before: {})", self.before),
            Err(e) => println!("vms after: count failed: {e}"),
        }
        if self.keep {
            return println!("clone kept: {}", self.clone.display());
        }
        match std::fs::remove_dir_all(&self.clone) {
            Ok(()) => println!("clone removed: {}", self.clone.display()),
            Err(e) => println!("clone NOT removed: {}: {e}", self.clone.display()),
        }
    }
}

/// target/runner-spike/nekko-vm, built and ad-hoc signed when the source is newer.
fn build_helper(repo: &Path, work: &Path) -> Res<PathBuf> {
    let src = repo.join("crates/nekkod/vm/nekko-vm.swift");
    let ent = repo.join("crates/nekkod/vm/nekko-vm.entitlements");
    let out = work.join("nekko-vm");
    let stale = |p: &Path| -> std::io::Result<bool> {
        Ok(std::fs::metadata(&out).and_then(|o| o.modified())? < std::fs::metadata(p)?.modified()?)
    };
    if !out.exists() || stale(&src)? || stale(&ent)? {
        let ok = Command::new("xcrun")
            .args(["swiftc", "-O", "-target", "arm64-apple-macos14", "-framework", "Virtualization"])
            .arg(&src)
            .arg("-o")
            .arg(&out)
            .status()?
            .success()
            && Command::new("codesign")
                .args(["--force", "-s", "-", "--entitlements"])
                .arg(&ent)
                .arg(&out)
                .status()?
                .success();
        if !ok {
            let _ = std::fs::remove_file(&out);
            return Err("building nekko-vm failed".into());
        }
    }
    Ok(out)
}

fn count_vms(helper: &Path) -> Res<String> {
    Ok(String::from_utf8(Command::new(helper).arg("count-vms").output()?.stdout)?.trim().to_owned())
}
