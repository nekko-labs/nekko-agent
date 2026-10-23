//! Whole-or-nothing file writes: what the TS host's `writeJsonAtomic` and
//! `writeAtomic` did, once for every store that saves a file.

use std::io::Write;
use std::path::Path;

/// Who may read a file [`atomic_write`] leaves.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// A new file's default (the umask decides).
    #[default]
    Default,
    /// Owner read and write only (`0600`), for tokens, keys and settings.
    /// Set before the file takes the target's name, so no other user ever
    /// reads it. Nothing changes where the platform has no modes.
    Private,
    /// The replaced file's permissions, or the default when there is none.
    Keep,
}

/// How [`atomic_write`] writes.
#[derive(Clone, Copy, Debug, Default)]
pub struct AtomicWrite {
    pub mode: Mode,
    /// Flush the file, and on Unix its folder, to disk before the rename
    /// counts as done, so a power cut leaves the old file or the new one.
    /// It costs a disk round trip per write.
    pub fsync: bool,
    /// Create the missing folders above the file first.
    pub create_dir: bool,
}

impl AtomicWrite {
    /// Owner-only, flushed to disk, its folder created: settings, tokens and keys.
    pub const PRIVATE: AtomicWrite = AtomicWrite { mode: Mode::Private, fsync: true, create_dir: true };
}

/// Write `bytes` to `path` whole or not at all: to a temp file with a random
/// name beside it, renamed over it. A reader sees the old file or the new
/// one, never half of either; on failure the temp file is removed and the
/// old file is untouched.
pub fn atomic_write(path: &Path, bytes: &[u8], opts: AtomicWrite) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    if opts.create_dir {
        std::fs::create_dir_all(dir)?;
    }
    let keep = match opts.mode {
        Mode::Keep => std::fs::metadata(path).ok().map(|m| m.permissions()),
        _ => None,
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut tag = [0u8; 16];
    let _ = getrandom::fill(&mut tag);
    let tag: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    let temp = dir.join(format!(".{name}.{tag}.tmp"));
    let written = (|| {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        if opts.mode == Mode::Private {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&temp)?;
        f.write_all(bytes)?;
        if opts.fsync {
            f.sync_all()?;
        }
        #[cfg(unix)]
        if opts.mode == Mode::Private {
            use std::os::unix::fs::PermissionsExt;
            // Exactly 0600, whatever the umask took off at create.
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        drop(f);
        if let Some(p) = keep {
            std::fs::set_permissions(&temp, p)?;
        }
        rename_retrying(&temp, path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    #[cfg(unix)]
    if opts.fsync
        && let Ok(d) = std::fs::File::open(dir)
    {
        let _ = d.sync_all();
    }
    Ok(())
}

/// `rename`, retried for about a second while it is refused: Windows refuses
/// a rename over a file another process holds open without delete sharing,
/// and that clears in moments.
pub fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 20 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(5 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn replaces_the_file_whole_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("nekko-js-atomic-{}", crate::uuid()));
        let file = dir.join("deep").join("a.json");
        assert!(atomic_write(&file, b"{}", AtomicWrite::default()).is_err(), "no folder, no create_dir");
        atomic_write(&file, b"one", AtomicWrite { create_dir: true, ..Default::default() }).unwrap();
        atomic_write(&file, b"two", AtomicWrite { fsync: true, ..Default::default() }).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        assert!(leftovers(file.parent().unwrap()).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_failed_rename_removes_the_temp_file_and_keeps_the_target() {
        let dir = std::env::temp_dir().join(format!("nekko-js-atomic-{}", crate::uuid()));
        // A folder in the file's place: the rename fails.
        std::fs::create_dir_all(dir.join("a.json").join("stuck")).unwrap();
        assert!(atomic_write(&dir.join("a.json"), b"x", AtomicWrite::default()).is_err());
        assert!(leftovers(&dir).is_empty());
        assert!(dir.join("a.json").join("stuck").is_dir());
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only_and_kept_files_keep_their_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("nekko-js-atomic-{}", crate::uuid()));
        let secret = dir.join("tokens.json");
        atomic_write(&secret, b"{}", AtomicWrite::PRIVATE).unwrap();
        assert_eq!(std::fs::metadata(&secret).unwrap().permissions().mode() & 0o777, 0o600);
        let script = dir.join("run.sh");
        std::fs::write(&script, "old").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o751)).unwrap();
        atomic_write(&script, b"new", AtomicWrite { mode: Mode::Keep, ..Default::default() }).unwrap();
        assert_eq!(std::fs::metadata(&script).unwrap().permissions().mode() & 0o777, 0o751);
        assert_eq!(std::fs::read(&script).unwrap(), b"new");
        std::fs::remove_dir_all(dir).ok();
    }
}
