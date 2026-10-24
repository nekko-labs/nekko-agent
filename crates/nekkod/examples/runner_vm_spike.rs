//! Spike only, never shipped: boots a real macOS VM through `nekko-vm` with the
//! runner NAT as its only network, and forwards 127.0.0.1:2222 on the host to
//! the guest's port 22 so a person can ssh in and measure. The forward exists
//! only with the `spike` feature (decision 0022: shipped code has no
//! host-to-guest path).
//!
//!   cargo run -p nekkod --features spike --example runner_vm_spike -- [--bundle <dir>]
//!
//! The bundle defaults to Tart's cached `macos-sequoia-base` (its files only,
//! no Tart code). The clone lives under `target/runner-spike/` and is deleted
//! on a clean exit (Ctrl-C or the guest stopping); after a SIGKILL it stays,
//! as it would for the supervisor's reaper.

#[path = "../src/runner/hostnets.rs"]
#[allow(dead_code)]
mod hostnets;
#[path = "../src/runner/net.rs"]
#[allow(dead_code)]
mod net;

use std::net::{IpAddr, SocketAddr};
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
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()?;
    let work = repo.join("target/runner-spike");
    std::fs::create_dir_all(&work)?;
    let helper = build_helper(&repo, &work)?;

    // Fail closed: without the host's addresses the policy cannot keep the guest off them.
    let host = Arc::new(RwLock::new(hostnets::try_current().map_err(|e| format!("cannot read host networks: {e}"))?));
    hostnets::spawn_refresh(host.clone(), Duration::from_secs(5));

    println!("vms before: {}", count_vms(&helper)?);
    let clone = work.join(format!("clone-{}", std::process::id()));
    let out = Command::new(&helper).arg("clone").arg("--from").arg(&bundle).arg("--to").arg(&clone).output()?;
    println!("clone: {}", String::from_utf8_lossy(&out.stdout).trim());
    if !out.status.success() {
        return Err("clone failed".into());
    }

    let (vm_end, nat_end) = UnixDatagram::pair()?;
    // macOS gives unix datagram sockets 4 KiB; the helper's end needs the room too.
    net::widen_buffers(&vm_end)?;
    let vm_fd = vm_end.as_raw_fd();
    let mut cmd = Command::new(&helper);
    cmd.args(["run", "--cpus", "4", "--memory-mb", "8192", "--net-fd", "3", "--bundle"]).arg(&clone);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            // dup2 clears close-on-exec on the copy; if the fd is already 3, clear it by hand.
            let rc = if vm_fd == 3 { libc::fcntl(3, libc::F_SETFD, 0) } else { libc::dup2(vm_fd, 3) };
            if rc < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
        });
    }
    let child = tokio::process::Command::from(cmd).spawn()?;
    drop(vm_end);
    println!("nekko-vm pid {}", child.id().unwrap_or(0));

    nat_end.set_nonblocking(true)?;
    let nat_end = tokio::net::UnixDatagram::from_std(nat_end)?;
    let forward = std::net::TcpListener::bind("127.0.0.1:2222")?;
    let cfg = net::NetConfig { dns_upstream: vec![dns_upstream()], forward: Some((forward, 22)), ..Default::default() };
    println!("ssh -p 2222 admin@127.0.0.1 once the guest is up; Ctrl-C stops the VM");

    let pid = child.id().map(|p| p as libc::pid_t);
    let mut child = child;
    tokio::select! {
        r = net::serve(nat_end, host, cfg) => println!("nat ended: {r:?}"),
        s = child.wait() => println!("nekko-vm exited: {s:?}"),
        _ = tokio::signal::ctrl_c() => {
            if let Some(pid) = pid {
                // SAFETY: signalling our own child.
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
        }
    }
    // The NAT end is gone now, so the helper stops within a second if SIGTERM did not.
    let status = tokio::time::timeout(Duration::from_secs(30), child.wait()).await;
    println!("nekko-vm: {status:?}");
    std::fs::remove_dir_all(&clone)?;
    println!("vms after: {}", count_vms(&helper)?);
    Ok(())
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

/// The host's first resolver. Loopback or Tailscale's 100.100.100.100 would
/// not answer the NAT's sockets as the guest expects, so the spike uses
/// 1.1.1.1 then (shortcut: the daemon needs real resolver discovery).
fn dns_upstream() -> SocketAddr {
    let fallback: SocketAddr = ([1, 1, 1, 1], 53).into();
    let scutil = Command::new("scutil").arg("--dns").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    let first = scutil.ok().and_then(|s| {
        s.lines().find_map(|l| l.trim().strip_prefix("nameserver[0] :").and_then(|ip| ip.trim().parse::<IpAddr>().ok()))
    });
    let up = match first {
        Some(ip) if !ip.is_loopback() && ip != IpAddr::from([100, 100, 100, 100]) => SocketAddr::new(ip, 53),
        other => {
            println!("host resolver {other:?} is loopback or Tailscale; DNS goes to {fallback} for the spike");
            fallback
        }
    };
    println!("dns upstream: {up}");
    up
}
