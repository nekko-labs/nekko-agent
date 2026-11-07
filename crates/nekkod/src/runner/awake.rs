//! Keeping the computer awake while someone says so: the runner's supervisor,
//! and agents running with *Keep this computer awake while agents run* on.
//! Idle sleep only: a closed lid or the power button still sleeps it.

#[cfg(not(windows))]
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub trait Awake: Send + Sync {
    /// Idempotent: called every tick with the current wish.
    fn set(&self, hold: bool);
}

/// The hold, while `true`. On macOS a `caffeinate -i -w <nekkod pid>` child and
/// on Linux `systemd-inhibit` around a `tail --pid`: both end with nekkod, so a
/// crash never leaves the computer held awake. On Windows a thread that keeps
/// `ES_SYSTEM_REQUIRED` set until it is told to stop (the OS drops it with the process).
#[derive(Default)]
pub struct Hold(Mutex<Option<Held>>);

#[cfg(not(windows))]
type Held = Child;
#[cfg(windows)]
type Held = std::sync::mpsc::Sender<()>;

#[cfg(not(windows))]
fn hold_command() -> Command {
    let pid = std::process::id().to_string();
    if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/caffeinate");
        c.args(["-i", "-w", &pid]);
        c
    } else {
        let mut c = Command::new("systemd-inhibit");
        c.args([
            "--what=idle:sleep",
            "--who=Nekko Agent",
            "--why=Agents are running",
            "--mode=block",
            "tail",
            "--pid",
            &pid,
            "-f",
            "/dev/null",
        ]);
        c
    }
}

#[cfg(not(windows))]
fn start() -> Option<Held> {
    match hold_command().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("nekkod: cannot keep the computer awake: {e}");
            None
        }
    }
}

#[cfg(windows)]
fn start() -> Option<Held> {
    use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            // SAFETY: only sets this thread's execution state flags.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            let _ = rx.recv(); // until the sender is dropped
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        })
        .map_err(|e| eprintln!("nekkod: cannot keep the computer awake: {e}"))
        .ok()?;
    Some(tx)
}

#[cfg(not(windows))]
fn stop(mut c: Held) {
    let _ = c.kill();
    let _ = c.wait();
}

#[cfg(windows)]
fn stop(_tx: Held) {}

/// A hold that ended on its own (killed by someone else) is replaced.
#[cfg(not(windows))]
fn ended(c: &mut Held) -> bool {
    !matches!(c.try_wait(), Ok(None))
}

#[cfg(windows)]
fn ended(_tx: &mut Held) -> bool {
    false
}

impl Awake for Hold {
    fn set(&self, hold: bool) {
        let Ok(mut held) = self.0.lock() else { return };
        if held.as_mut().is_some_and(ended) {
            *held = None;
        }
        match (hold, held.is_some()) {
            (true, false) => *held = start(),
            (false, true) => {
                if let Some(h) = held.take() {
                    stop(h);
                }
            }
            _ => {}
        }
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        self.set(false);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    #[test]
    fn caffeinate_holds_and_releases() {
        let c = Hold::default();
        c.set(true);
        c.set(true);
        let pid = c.0.lock().unwrap().as_ref().map(Child::id).expect("a caffeinate child");
        assert!(alive(pid));
        c.set(false);
        assert!(c.0.lock().unwrap().is_none());
        // Reaped, so not even a zombie remains.
        assert!(!alive(pid));
    }
}
