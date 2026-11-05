//! Where this device's secrets live: Nekko Cloud's token and keys, linked
//! computers' and CI runners' keys, provider API keys and sign-in tokens.
//!
//! macOS and Windows use the OS keystore (Keychain, Credential Manager), one
//! item per secret under a service name scoped to the data directory, so a
//! dev profile and the installed app never share keys. Elsewhere a 0600 JSON
//! file in the data directory.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub trait Vault: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str);
    /// Shown in Settings so the user knows where the keys are.
    fn kind(&self) -> &'static str;
}

/// The vault for this platform: Nekko Cloud's keys.
pub fn default_vault(dir: &Path) -> Box<dyn Vault> {
    scoped_vault(dir, "cloud", dir.join("secrets.json"))
}

/// A vault of its own for one part of the app (`name`), scoped to `dir`;
/// `file` is the fallback where there is no OS keystore.
pub fn scoped_vault(dir: &Path, name: &str, file: PathBuf) -> Box<dyn Vault> {
    keystore(dir, name).unwrap_or_else(|| Box::new(FileVault::new(file)))
}

/// The OS keystore's vault for one part of the app, or `None` where there is
/// no keystore (the caller keeps its 0600 file then).
pub fn keystore(dir: &Path, name: &str) -> Option<Box<dyn Vault>> {
    #[cfg(any(target_os = "macos", windows))]
    {
        return Some(Box::new(KeychainVault { service: service(dir, name) }));
    }
    #[allow(unreachable_code)]
    {
        let _ = (dir, name);
        None
    }
}

/// Characters per keystore item: Credential Manager holds 2560 bytes of
/// UTF-16, and a sign-in token's JWTs are longer than that.
const PIECE: usize = 1000;

fn piece(name: &str, i: usize) -> String {
    if i == 0 { name.to_string() } else { format!("{name}#{i}") }
}

/// Save `value` under `name`, split over as many items as it needs, then
/// read it back. True only when the vault now returns exactly `value`; on
/// false nothing is left under `name`, so the caller keeps its own copy.
pub fn put(v: &dyn Vault, name: &str, value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    let mut pieces: Vec<String> = chars.chunks(PIECE).map(|c| c.iter().collect()).collect();
    if pieces.is_empty() {
        pieces.push(String::new());
    }
    let saved = pieces.iter().enumerate().all(|(i, p)| v.set(&piece(name, i), p).is_ok());
    // A longer earlier value's tail.
    drop_from(v, name, pieces.len());
    if saved && get(v, name).as_deref() == Some(value) {
        return true;
    }
    delete(v, name);
    false
}

/// What [`put`] saved under `name`.
pub fn get(v: &dyn Vault, name: &str) -> Option<String> {
    let mut out = v.get(name)?;
    let mut i = 1;
    while let Some(p) = v.get(&piece(name, i)) {
        out.push_str(&p);
        i += 1;
    }
    Some(out)
}

/// Remove what [`put`] saved under `name`.
pub fn delete(v: &dyn Vault, name: &str) {
    v.delete(name);
    drop_from(v, name, 1);
}

fn drop_from(v: &dyn Vault, name: &str, from: usize) {
    let mut i = from;
    while v.get(&piece(name, i)).is_some() {
        v.delete(&piece(name, i));
        i += 1;
    }
}

/// The keystore service: `dev.nekkolabs.nekko-agent.<name>.<12 hex of sha256(dir)>`.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn service(dir: &Path, name: &str) -> String {
    use sha2::{Digest, Sha256};
    let scope = Sha256::digest(dir.to_string_lossy().as_bytes());
    let hex: String = scope[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("dev.nekkolabs.nekko-agent.{name}.{hex}")
}

/// The keystore calls under way. macOS holds a Keychain call until the user
/// answers its consent dialog (or unlocks the keychain), which can take
/// minutes; a daemon that is starting reports such a wait to the app that
/// started it (nekkod's `NEKKOD_WAITING`), so the app does not take it for a
/// wedged daemon and kill it, which only asks the user again.
pub mod waits {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static CALLS: Mutex<BTreeMap<u64, Instant>> = Mutex::new(BTreeMap::new());
    static NEXT: AtomicU64 = AtomicU64::new(0);

    /// One keystore call, counted until it is dropped.
    pub struct Call(u64);

    /// Count a keystore call until the returned guard is dropped.
    pub fn begin() -> Call {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        CALLS.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Instant::now());
        Call(id)
    }

    impl Drop for Call {
        fn drop(&mut self) {
            CALLS.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
        }
    }

    /// How long the oldest keystore call under way has been waiting, if any is.
    pub fn longest() -> Option<Duration> {
        CALLS.lock().unwrap_or_else(|e| e.into_inner()).values().min().map(Instant::elapsed)
    }
}

#[cfg(any(target_os = "macos", windows))]
pub struct KeychainVault {
    service: String,
}

#[cfg(any(target_os = "macos", windows))]
impl Vault for KeychainVault {
    fn get(&self, name: &str) -> Option<String> {
        let _call = waits::begin();
        keyring::Entry::new(&self.service, name).ok()?.get_password().ok()
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let _call = waits::begin();
        keyring::Entry::new(&self.service, name)
            .and_then(|e| e.set_password(value))
            .map_err(|e| format!("could not save to the keychain: {e}"))
    }

    fn delete(&self, name: &str) {
        let _call = waits::begin();
        if let Ok(e) = keyring::Entry::new(&self.service, name) {
            let _ = e.delete_credential();
        }
    }

    fn kind(&self) -> &'static str {
        if cfg!(windows) { "Windows Credential Manager" } else { "macOS Keychain" }
    }
}

pub struct FileVault {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileVault {
    pub fn new(path: PathBuf) -> FileVault {
        FileVault { path, lock: Mutex::new(()) }
    }

    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn write(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
        let text = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
        // Readable by its owner only.
        nekko_js::fs::atomic_write(&self.path, &text, nekko_js::fs::AtomicWrite::PRIVATE)
            .map_err(|e| format!("could not save the keys: {e}"))
    }
}

impl Vault for FileVault {
    fn get(&self, name: &str) -> Option<String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read().get(name).cloned()
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read();
        map.insert(name.to_string(), value.to_string());
        self.write(&map)
    }

    fn delete(&self, name: &str) {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read();
        if map.remove(name).is_some() {
            let _ = self.write(&map);
        }
    }

    fn kind(&self) -> &'static str {
        "a file only your user can read"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_services_keep_the_cloud_name_and_separate_others() {
        let dir = Path::new("/data/cloud");
        let cloud = service(dir, "cloud");
        assert!(cloud.starts_with("dev.nekkolabs.nekko-agent.cloud.") && cloud.len() == 44);
        assert_eq!(service(dir, "runner"), cloud.replace(".cloud.", ".runner."));
        assert_ne!(service(Path::new("/other"), "cloud"), cloud);
    }

    #[test]
    fn put_splits_long_values_reads_them_back_and_drops_old_tails() {
        let dir = tempfile::tempdir().unwrap();
        let v = FileVault::new(dir.path().join("keys.json"));
        let long = "é".repeat(PIECE * 2 + 5);
        assert!(put(&v, "t", &long));
        assert_eq!(get(&v, "t").as_deref(), Some(long.as_str()));
        assert!(v.get("t#2").is_some());
        assert!(put(&v, "t", "short"));
        assert_eq!(get(&v, "t").as_deref(), Some("short"));
        assert_eq!(v.get("t#1"), None);
        assert!(put(&v, "e", ""));
        assert_eq!(get(&v, "e").as_deref(), Some(""));
        delete(&v, "t");
        assert_eq!(get(&v, "t"), None);
    }

    /// A keystore that refuses every save.
    struct Refusing;
    impl Vault for Refusing {
        fn get(&self, _: &str) -> Option<String> {
            None
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
        fn delete(&self, _: &str) {}
        fn kind(&self) -> &'static str {
            "refusing"
        }
    }

    #[test]
    fn waits_count_a_call_until_it_ends() {
        let call = waits::begin();
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(waits::longest().is_some_and(|d| d >= std::time::Duration::from_millis(20)));
        drop(call);
        // Other tests' calls may overlap this one, but none is this old.
        assert!(waits::longest().is_none_or(|d| d < std::time::Duration::from_millis(20)));
    }

    #[test]
    fn put_reports_a_save_it_cannot_read_back() {
        assert!(!put(&Refusing, "t", "secret"));
    }

    #[test]
    fn a_file_vault_round_trips_and_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let v = FileVault::new(dir.path().join("cloud").join("secrets.json"));
        assert_eq!(v.get("token"), None);
        v.set("token", "nk_abc").unwrap();
        v.set("device-key", "xyz").unwrap();
        assert_eq!(v.get("token").as_deref(), Some("nk_abc"));
        v.delete("token");
        assert_eq!(v.get("token"), None);
        assert_eq!(v.get("device-key").as_deref(), Some("xyz"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("cloud").join("secrets.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
