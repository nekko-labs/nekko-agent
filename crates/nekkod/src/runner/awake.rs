//! Keeping the Mac awake while the supervisor says so, with `caffeinate`.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub trait Awake: Send + Sync {
    /// Idempotent: called every tick with the current wish.
    fn set(&self, hold: bool);
}

/// Holds a `caffeinate -i -w <nekkod pid>` child while `true`: `-w` ends it
/// with nekkod, so a crash never leaves the Mac held awake.
#[derive(Default)]
pub struct Caffeinate(Mutex<Option<Child>>);

impl Awake for Caffeinate {
    fn set(&self, hold: bool) {
        let Ok(mut child) = self.0.lock() else { return };
        // A child that exited (killed by someone else) is replaced.
        if child.as_mut().is_some_and(|c| !matches!(c.try_wait(), Ok(None))) {
            *child = None;
        }
        match (hold, child.is_some()) {
            (true, false) => {
                let pid = std::process::id().to_string();
                match Command::new("/usr/bin/caffeinate")
                    .args(["-i", "-w", &pid])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(c) => *child = Some(c),
                    Err(e) => eprintln!("runner: cannot keep the Mac awake: {e}"),
                }
            }
            (false, true) => {
                if let Some(mut c) = child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
            _ => {}
        }
    }
}

impl Drop for Caffeinate {
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
        let c = Caffeinate::default();
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
