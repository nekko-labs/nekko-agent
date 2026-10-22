//! What this device remembers about Nekko Cloud between runs, none of it
//! secret (secrets are in the vault): `<data>/cloud/state.json`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub plan: String,
    pub can_sync: bool,
}

/// One synced chat as this device last pushed or applied it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Synced {
    /// The chat's `updatedAt` when its record was made, to skip unchanged chats cheaply.
    pub updated_at: f64,
    /// A digest of the record's plaintext.
    pub digest: String,
    /// A tombstone was pushed or applied.
    pub deleted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub account: Option<Account>,
    /// Sync is on for this device.
    pub enabled: bool,
    /// Include "Local only" (offline) chats.
    pub include_local_only: bool,
    /// The user said they saved the recovery key.
    pub recovery_confirmed: bool,
    pub device_id: Option<String>,
    pub device_label: String,
    /// The newest key epoch this device holds.
    pub key_id: Option<u32>,
    /// The recovery key's public half (base64url), pinned from the sealed account record.
    pub recovery_public: Option<String>,
    /// The sealed account record as last opened (JSON), for the trusted devices.
    pub account_record: Option<String>,
    /// The pull cursor.
    pub cursor: u64,
    /// Highest revision seen per object id: an older one is a rollback and is ignored.
    pub revisions: BTreeMap<String, u64>,
    /// Per chat id.
    pub chats: BTreeMap<String, Synced>,
    pub last_sync_at: Option<f64>,
    pub last_error: Option<String>,
}

impl State {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("state.json")
    }

    pub fn load(dir: &Path) -> State {
        std::fs::read(Self::path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("state.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, Self::path(dir)).map_err(|e| e.to_string())
    }

    /// Forget everything about sync (another account signed in, or Delete everything synced).
    pub fn reset_sync(&mut self) {
        let keep = (self.account.clone(), self.device_label.clone(), self.include_local_only);
        *self = State { account: keep.0, device_label: keep.1, include_local_only: keep.2, ..State::default() };
    }
}
