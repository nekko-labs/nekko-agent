//! Where the daemon's own secrets live (decision 0046): the API keys and
//! tokens in the settings, and the sign-in tokens, in the OS keystore.

use nekko_cloud::vault::{FileVault, Vault};
use std::path::Path;

/// The keystore for one part of the daemon's data, or `None` where there is
/// none (the 0600 file stays). Tests never touch the login keychain: unit
/// tests get none, and a daemon test (`NEKKO_FILE_VAULT=1`) a file stand-in.
pub fn keystore(dir: &Path, name: &str) -> Option<Box<dyn Vault>> {
    if cfg!(test) {
        return None;
    }
    if cfg!(debug_assertions) && std::env::var("NEKKO_FILE_VAULT").as_deref() == Ok("1") {
        return Some(Box::new(FileVault::new(dir.join(format!("{name}-keystore.json")))));
    }
    nekko_cloud::vault::keystore(dir, name)
}

/// The sign-in tokens of `dir`.
pub fn tokens(dir: &Path) -> nekko_oauth::TokenStore {
    nekko_oauth::TokenStore::with_vault(dir, keystore(dir, "tokens"))
}
