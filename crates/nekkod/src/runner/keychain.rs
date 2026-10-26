//! Where the runner's GitHub App keys live: the OS keystore under a service of
//! the runner's own (a 0600 file under `runners/` where there is none).

use nekko_cloud::vault::{Vault, scoped_vault};
use std::path::Path;

pub fn runner_vault(data_dir: &Path) -> Box<dyn Vault> {
    scoped_vault(data_dir, "runner", data_dir.join("runners/secrets.json"))
}

pub fn key_name(app_id: u64) -> String {
    format!("github-app-{app_id}")
}
