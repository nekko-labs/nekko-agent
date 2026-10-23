//! Where this device's secrets live: the Nekko Cloud token, the device's
//! P-256 key and each key epoch's keyring. Values are base64url strings.
//!
//! macOS and Windows use the OS keystore (Keychain, Credential Manager), one
//! item per secret under a service name scoped to the data directory, so a
//! dev profile and the installed app never share keys. Elsewhere a 0600 JSON
//! file in the cloud folder, the same protection `tokens.json` gets.

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

/// The vault for this platform.
pub fn default_vault(dir: &Path) -> Box<dyn Vault> {
    #[cfg(any(target_os = "macos", windows))]
    {
        use sha2::{Digest, Sha256};
        let scope = Sha256::digest(dir.to_string_lossy().as_bytes());
        let hex: String = scope[..6].iter().map(|b| format!("{b:02x}")).collect();
        return Box::new(KeychainVault { service: format!("dev.nekkolabs.nekko-agent.cloud.{hex}") });
    }
    #[allow(unreachable_code)]
    Box::new(FileVault::new(dir.join("secrets.json")))
}

#[cfg(any(target_os = "macos", windows))]
pub struct KeychainVault {
    service: String,
}

#[cfg(any(target_os = "macos", windows))]
impl Vault for KeychainVault {
    fn get(&self, name: &str) -> Option<String> {
        keyring::Entry::new(&self.service, name).ok()?.get_password().ok()
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(&self.service, name)
            .and_then(|e| e.set_password(value))
            .map_err(|e| format!("could not save to the keychain: {e}"))
    }

    fn delete(&self, name: &str) {
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
            .map_err(|e| format!("could not save the cloud keys: {e}"))
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
