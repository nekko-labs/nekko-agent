//! One daemon per data directory.
//!
//! Two daemons on one directory (the desktop app and the CLI's local engine,
//! say) would both write the same chats and settings. The first takes an
//! exclusive lock on `<dataDir>/nekkod.lock` and holds it for its whole life;
//! the OS drops it when the process ends, however it ends. A second waits a
//! little (its predecessor may still be shutting down), then exits with
//! [`LOCKED_EXIT`] and says who holds the directory.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, Write};
use std::path::Path;
use std::time::{Duration, Instant};

/// The exit code a launcher reads as "another nekkod has this data directory".
pub const LOCKED_EXIT: u8 = 3;
pub const LOCK_FILE: &str = "nekkod.lock";

/// Take the lock, waiting up to `wait` for a predecessor to let go. The file
/// returned holds it; it also names this process's pid for the next one's message.
pub fn acquire(data_dir: &Path, wait: Duration) -> Result<File, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("cannot create {}: {e}", data_dir.display()))?;
    let path = data_dir.join(LOCK_FILE);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let deadline = Instant::now() + wait;
    let mut said = false;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    let holder = holder(&path).map(|p| format!(" (pid {p})")).unwrap_or_default();
                    return Err(format!(
                        "another nekkod{holder} is already running on {}; stop it (quit the other Nekko Agent app, CLI or Local Web UI using this folder) and try again",
                        data_dir.display()
                    ));
                }
                if !said {
                    eprintln!("nekkod: waiting for another nekkod to release {}", data_dir.display());
                    said = true;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(TryLockError::Error(e)) => return Err(format!("cannot lock {}: {e}", path.display())),
        }
    }
    let _ = file.set_len(0);
    let _ = file.rewind();
    let _ = write!(file, "{}", std::process::id());
    let _ = file.flush();
    Ok(file)
}

/// The pid the holder wrote, where the platform lets another process read a
/// locked file (Windows does not).
fn holder(path: &Path) -> Option<u32> {
    let mut s = String::new();
    File::open(path).ok()?.read_to_string(&mut s).ok()?;
    s.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_lock_on_the_same_directory_is_refused_until_the_first_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path(), Duration::ZERO).expect("first lock");
        let err = acquire(dir.path(), Duration::from_millis(300)).expect_err("second lock refused");
        assert!(err.contains("another nekkod"), "{err}");
        drop(first);
        // The OS releases the lock on close, but under parallel test load it is
        // not always free on the very next call (#881): wait as a daemon would.
        acquire(dir.path(), Duration::from_secs(5)).expect("free again once dropped");
    }
}
