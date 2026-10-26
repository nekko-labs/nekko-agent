//! Job VMs through the `nekko-vm` helper: cloning the golden bundle, the
//! read-only seed image that carries a job's JIT config, running a VM with
//! the userspace NAT (`net.rs`) as its only network, and reaping what a
//! crash or a sleep left under `vms/`.

use super::egress::Egress;
use super::lan;
use super::net::{self, NetConfig};
use nekko_runner::HostNets;
use serde_json::Value;
use std::future::Future;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout};
use tokio::sync::{mpsc, oneshot};

/// One VM run: the clone to boot and the job's seed image.
#[derive(Debug, Clone, PartialEq)]
pub struct RunSpec {
    pub bundle: PathBuf,
    pub cpus: u8,
    pub memory_mb: u32,
    pub seed: PathBuf,
}

/// Why a VM stopped: the helper's `reason`. A helper that exits without a
/// `stopped` line is `Error`.
#[derive(Debug, Clone, PartialEq)]
pub enum Stopped {
    Guest,
    Signal,
    Error(String),
}

/// What the supervisor asks of a running VM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Halt {
    /// SIGTERM: the helper asks the guest to shut down; SIGKILL after the grace.
    Term,
    Kill,
}

/// A running VM. `done` resolves only after the helper is reaped and its NAT
/// has ended, so a clone may be deleted once it does. Dropping the handle
/// kills the VM.
pub struct RunHandle {
    pub done: oneshot::Receiver<Stopped>,
    stop: mpsc::UnboundedSender<Halt>,
}

impl RunHandle {
    pub fn new(done: oneshot::Receiver<Stopped>, stop: mpsc::UnboundedSender<Halt>) -> Self {
        Self { done, stop }
    }

    /// SIGTERM now, SIGKILL after the driver's stop grace.
    pub fn request_stop(&self) {
        let _ = self.stop.send(Halt::Term);
    }

    pub fn kill(&self) {
        let _ = self.stop.send(Halt::Kill);
    }
}

/// The VM backend the supervisor drives; tests swap in a fake.
pub trait Vm: Send + Sync + 'static {
    fn clone_bundle(&self, from: &Path, to: &Path) -> impl Future<Output = Result<(), String>> + Send;
    fn write_seed(&self, path: &Path, jit_config: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn start(&self, spec: RunSpec) -> impl Future<Output = Result<RunHandle, String>> + Send;
    fn count_vms(&self) -> impl Future<Output = Result<u8, String>> + Send;
}

/// The real backend: the `nekko-vm` helper.
pub struct HelperVm {
    pub helper: PathBuf,
    pub host: Arc<RwLock<HostNets>>,
    pub egress: Arc<RwLock<Option<Egress>>>,
    /// SIGTERM to SIGKILL (30 s; the helper itself gives the guest 20 s).
    pub stop_grace: Duration,
    /// From spawning the helper to its `started` line (60 s).
    pub start_timeout: Duration,
    /// Limits on the one-shot calls, so a wedged helper or tool never stalls
    /// the supervisor's tick: `clone` 120 s, the seed's `hdiutil` 30 s,
    /// `count-vms` 10 s, `scutil --dns` 10 s.
    pub clone_timeout: Duration,
    pub seed_timeout: Duration,
    pub count_timeout: Duration,
    pub scutil_timeout: Duration,
}

impl HelperVm {
    /// The driver with the production limits.
    pub fn new(helper: PathBuf, host: Arc<RwLock<HostNets>>, egress: Arc<RwLock<Option<Egress>>>) -> Self {
        Self {
            helper,
            host,
            egress,
            stop_grace: Duration::from_secs(30),
            start_timeout: Duration::from_secs(60),
            clone_timeout: Duration::from_secs(120),
            seed_timeout: Duration::from_secs(30),
            count_timeout: Duration::from_secs(10),
            scutil_timeout: Duration::from_secs(10),
        }
    }

    /// `helper <args>` within `limit`, its stdout as one JSON value.
    async fn call(&self, args: &[&std::ffi::OsStr], limit: Duration) -> Result<Value, String> {
        let mut cmd = tokio::process::Command::new(&self.helper);
        cmd.args(args);
        let out = output_within(cmd, limit, "nekko-vm").await?;
        let text = String::from_utf8_lossy(&out.stdout);
        serde_json::from_str(text.trim()).map_err(|_| format!("nekko-vm said: {}", text.trim()))
    }
}

/// Runs `cmd` to completion within `limit`. On a timeout the child is killed
/// and reaped before the error returns, so nothing is left running.
async fn output_within(
    mut cmd: tokio::process::Command,
    limit: Duration,
    what: &str,
) -> Result<std::process::Output, String> {
    use tokio::io::AsyncReadExt;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot run {what}: {e}"))?;
    let (mut out, mut err) = (child.stdout.take(), child.stderr.take());
    let run = async {
        let (mut o, mut e) = (vec![], vec![]);
        let read_o = async {
            if let Some(p) = &mut out {
                let _ = p.read_to_end(&mut o).await;
            }
        };
        let read_e = async {
            if let Some(p) = &mut err {
                let _ = p.read_to_end(&mut e).await;
            }
        };
        let (status, (), ()) = tokio::join!(child.wait(), read_o, read_e);
        status.map(|status| std::process::Output { status, stdout: o, stderr: e })
    };
    match tokio::time::timeout(limit, run).await {
        Ok(r) => r.map_err(|e| format!("{what} failed: {e}")),
        Err(_) => {
            let _ = child.kill().await;
            Err(format!("{what} did not finish within {} s", limit.as_secs_f32()))
        }
    }
}

impl Vm for HelperVm {
    async fn clone_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
        // An existing target is never ours to touch: refuse before the helper runs.
        if std::fs::symlink_metadata(to).is_ok() {
            return Err(format!("{} already exists", to.display()));
        }
        let r = self
            .call(
                &["clone".as_ref(), "--from".as_ref(), from.as_os_str(), "--to".as_ref(), to.as_os_str()],
                self.clone_timeout,
            )
            .await
            .and_then(|v| match (v["ok"].as_bool(), v["error"].as_str()) {
                (Some(true), _) => Ok(()),
                (_, Some(e)) => Err(e.to_owned()),
                _ => Err(format!("nekko-vm clone said: {v}")),
            });
        // `to` was absent, and vm ids are unique to this daemon, so anything there now is this
        // call's partial clone (a helper killed mid-clone leaves one).
        if r.is_err() {
            match std::fs::symlink_metadata(to) {
                Ok(m) if m.is_dir() => drop(std::fs::remove_dir_all(to)),
                Ok(_) => drop(std::fs::remove_file(to)),
                Err(_) => {}
            }
        }
        r
    }

    async fn write_seed(&self, path: &Path, jit_config: &str) -> Result<(), String> {
        let parent = path.parent().ok_or("the seed path has no folder")?;
        let nonce: u64 = rand_u64();
        let dir = parent.join(format!(".seed-{nonce:016x}"));
        // 0700 and created here, never reused: the config is a credential until the runner registers.
        std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|e| format!("cannot make the seed folder: {e}"))?;
        let r = async {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(dir.join("jit-config"))
                .and_then(|mut f| io::Write::write_all(&mut f, jit_config.as_bytes()))
                .map_err(|e| format!("cannot write the JIT config: {e}"))?;
            let mut cmd = tokio::process::Command::new("hdiutil");
            cmd.args(["makehybrid", "-iso", "-joliet", "-default-volume-name", "NEKKOSEED", "-o"]).arg(path).arg(&dir);
            let out = output_within(cmd, self.seed_timeout, "hdiutil").await?;
            if out.status.success() {
                // makehybrid honours the umask; the image holds the credential.
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| format!("cannot make the seed image private: {e}"))
            } else {
                Err(format!("hdiutil makehybrid failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
            }
        }
        .await;
        let _ = std::fs::remove_dir_all(&dir);
        r
    }

    async fn start(&self, spec: RunSpec) -> Result<RunHandle, String> {
        // Everything fallible happens before the helper exists, so no early
        // return leaves a VM running.
        let physical = self.egress.read().ok().and_then(|e| e.as_ref()?.physical.as_ref().map(|p| p.1));
        let index = physical.ok_or("no physical network interface; the job VM would have no network")?;
        // Unreadable resolvers fall back to FALLBACK_DNS, so a failure here is not fatal.
        let mut scutil = tokio::process::Command::new("scutil");
        scutil.arg("--dns");
        let scutil = output_within(scutil, self.scutil_timeout, "scutil")
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        let dns_upstream = {
            let host = self.host.read().map_err(|_| "the host networks are unreadable")?;
            lan::dns_upstreams(&scutil, index, &host)
        };
        let cfg = NetConfig { dns_upstream, ..Default::default() };
        let err = |e: io::Error| format!("cannot make the VM's network socket: {e}");
        let (vm_end, nat_end) = std::os::unix::net::UnixDatagram::pair().map_err(err)?;
        net::widen_buffers(&vm_end).map_err(err)?;
        nat_end.set_nonblocking(true).map_err(err)?;
        let nat_end = tokio::net::UnixDatagram::from_std(nat_end).map_err(err)?;

        let vm_fd = vm_end.as_raw_fd();
        let mut cmd = std::process::Command::new(&self.helper);
        cmd.arg("run")
            .arg("--bundle")
            .arg(&spec.bundle)
            .args(["--cpus", &spec.cpus.to_string(), "--memory-mb", &spec.memory_mb.to_string(), "--net-fd", "3"])
            .arg("--seed")
            .arg(&spec.seed)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                // dup2 clears close-on-exec on the copy; if the fd is already 3, clear it by hand.
                let rc = if vm_fd == 3 { libc::fcntl(3, libc::F_SETFD, 0) } else { libc::dup2(vm_fd, 3) };
                if rc < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
            });
        }
        let mut child = tokio::process::Command::from(cmd)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot run nekko-vm: {e}"))?;
        drop(vm_end);
        let Some(out) = child.stdout.take() else {
            let _ = child.kill().await;
            return Err("nekko-vm has no output".into());
        };
        let mut lines = BufReader::new(out).lines();
        let started = tokio::time::timeout(self.start_timeout, async {
            while let Ok(Some(line)) = lines.next_line().await {
                match event(&line) {
                    Some(Event::Started) => return Ok(()),
                    Some(Event::Stopped(why)) => return Err(format!("the VM did not start: {why:?}")),
                    None => {}
                }
            }
            Err("nekko-vm exited before the VM started".to_owned())
        })
        .await
        .unwrap_or_else(|_| Err(format!("the VM did not start within {} s", self.start_timeout.as_secs())));
        if let Err(e) = started {
            let _ = child.kill().await;
            return Err(e);
        }

        let (done_tx, done_rx) = oneshot::channel();
        let (stop_tx, stop_rx) = mpsc::unbounded_channel();
        let nat = net::serve(nat_end, self.host.clone(), self.egress.clone(), cfg);
        tokio::spawn(supervise(child, lines, nat, stop_rx, self.stop_grace, done_tx));
        Ok(RunHandle::new(done_rx, stop_tx))
    }

    async fn count_vms(&self) -> Result<u8, String> {
        let v = self.call(&["count-vms".as_ref()], self.count_timeout).await?;
        v["count"].as_u64().and_then(|n| u8::try_from(n).ok()).ok_or_else(|| format!("nekko-vm count-vms said: {v}"))
    }
}

enum Event {
    Started,
    Stopped(Stopped),
}

/// One line of `nekko-vm run`.
fn event(line: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(line).ok()?;
    match v["event"].as_str()? {
        "started" => Some(Event::Started),
        "stopped" => Some(Event::Stopped(match v["reason"].as_str() {
            Some("guest") => Stopped::Guest,
            Some("signal") => Stopped::Signal,
            _ => Stopped::Error(v["detail"].as_str().unwrap_or("").to_owned()),
        })),
        _ => None,
    }
}

/// Runs the NAT beside the helper until the helper is reaped, handling stop
/// requests; then ends the NAT and reports why the VM stopped.
async fn supervise(
    mut child: Child,
    mut lines: Lines<BufReader<ChildStdout>>,
    nat: impl Future<Output = io::Result<()>>,
    mut stop: mpsc::UnboundedReceiver<Halt>,
    grace: Duration,
    done: oneshot::Sender<Stopped>,
) {
    let pid = child.id().map(|p| p as libc::pid_t);
    // Boxed, not pinned on the stack, so it can be dropped before `done` fires.
    let mut nat = Box::pin(nat);
    let (mut why, mut killed, mut nat_ended, mut out_open) = (None, false, false, true);
    let mut deadline: Option<tokio::time::Instant> = None;
    let mut nat_failed: Option<String> = None;
    loop {
        tokio::select! {
            _ = child.wait() => break,
            line = lines.next_line(), if out_open => match line {
                Ok(Some(l)) => if let Some(Event::Stopped(s)) = event(&l) { why = Some(s) },
                _ => out_open = false,
            },
            // The NAT stays up through SIGTERM's grace: closing it would pull the guest's plug.
            r = &mut nat, if !nat_ended => {
                nat_ended = true;
                // A VM with no network would hang its job to the max job time: stop it now.
                if let Err(e) = r {
                    eprintln!("nekkod: a job VM's network failed, stopping the VM: {e}");
                    nat_failed = Some(format!("the VM's network failed: {e}"));
                    killed = true;
                    let _ = child.start_kill();
                }
            }
            h = stop.recv(), if !killed => match h {
                Some(Halt::Term) if deadline.is_none() => {
                    if let Some(pid) = pid {
                        // SAFETY: signalling our own child, which is not reaped yet.
                        unsafe { libc::kill(pid, libc::SIGTERM) };
                    }
                    deadline = Some(tokio::time::Instant::now() + grace);
                }
                Some(Halt::Term) => {}
                // A dropped handle can never stop the VM, so it is killed now.
                Some(Halt::Kill) | None => { killed = true; let _ = child.start_kill(); }
            },
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)), if deadline.is_some() && !killed => {
                killed = true;
                let _ = child.start_kill();
            }
        }
    }
    // A `stopped` line still in the pipe; bounded, as a stray grandchild could hold it open.
    let _ = tokio::time::timeout(Duration::from_millis(500), async {
        while out_open && let Ok(Some(l)) = lines.next_line().await {
            if let Some(Event::Stopped(s)) = event(&l) {
                why = Some(s);
            }
        }
    })
    .await;
    // The helper is reaped; dropping the NAT here ends it before `done` fires.
    drop(nat);
    let why = nat_failed.map(Stopped::Error).or(why).unwrap_or_else(|| {
        Stopped::Error(if killed { "killed".into() } else { "nekko-vm exited without a reason".into() })
    });
    let _ = done.send(why);
}

/// Removes every entry under `vms_dir`, keeping the folder itself; symlinks
/// are removed, never followed. A missing folder has nothing to reap.
pub async fn reap(vms_dir: &Path) -> io::Result<u32> {
    let dir = vms_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        match std::fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
            Ok(m) if !m.is_dir() => return Err(io::Error::other(format!("{} is not a folder", dir.display()))),
            Ok(_) => {}
        }
        let (mut removed, mut failed) = (0, None);
        for entry in std::fs::read_dir(&dir)? {
            let r = entry.and_then(|e| {
                let path = e.path();
                // file_type does not follow symlinks; remove_dir_all does not follow them inside either.
                if e.file_type()?.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }
            });
            match r {
                Ok(()) => removed += 1,
                Err(e) => failed = Some(e),
            }
        }
        failed.map_or(Ok(removed), Err)
    })
    .await
    .map_err(io::Error::other)?
}

fn rand_u64() -> u64 {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    u64::from_le_bytes(b)
}

#[cfg(test)]
#[path = "vm_tests.rs"]
mod tests;
