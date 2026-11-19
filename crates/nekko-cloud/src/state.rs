//! What this device remembers about Nekko Cloud between runs, none of it
//! secret (secrets are in the vault): `<data>/cloud/state.json`.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub plan: String,
    pub can_sync: bool,
    /// A Nekko team account: may turn unreleased Cloud features on (decision 0092).
    pub staff: bool,
    /// Plans and billing are switched on for this account (#2724).
    pub billing: bool,
    /// Library files sync to Nekko Cloud for this account (the `library-cloud` switch, #2748).
    pub library_cloud: bool,
}

impl Account {
    /// From the API's `account` object (`POST /v1/auth/session`, `GET /v1/auth/me`).
    pub fn from_api(a: &serde_json::Value) -> Account {
        Account {
            id: a["id"].as_str().unwrap_or("").into(),
            email: a["email"].as_str().unwrap_or("").into(),
            plan: a["plan"].as_str().unwrap_or("free").into(),
            can_sync: a["canSync"].as_bool().unwrap_or(false),
            staff: a["staff"].as_bool().unwrap_or(false),
            billing: a["features"]["billing"].as_bool().unwrap_or(false),
            library_cloud: a["features"]["library-cloud"].as_bool().unwrap_or(false),
        }
    }
}

/// A file Library lists on this computer, as the app reported it (`library:sync`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryFile {
    pub path: String,
    pub title: String,
    /// Library's kind (`doc`, `web`, `design`, `diagram`, `data`, `office`, `image`).
    pub kind: String,
    /// The chat it came from (its title), or the project for a designs-folder file.
    pub chat: String,
    /// A small thumbnail for the file (base64url PNG or WebP, capped at ~200 KB), as reported
    /// by the app. Embedded in the sealed record so other computers can show it (#3044).
    pub thumbnail_data: String,
}

/// One Library file as this device last pushed it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LibrarySynced {
    /// The file's modified time and size when pushed, to skip an unchanged file without reading it.
    pub modified_at: f64,
    pub size: u64,
    /// A digest of the record's plaintext.
    pub digest: String,
    /// A tombstone was pushed: the file is gone from this computer.
    pub deleted: bool,
    /// The key epoch it was pushed under (older ones are pushed again).
    pub key_id: u32,
    /// A digest of the last-pushed thumbnail, to push again when it changes (#3044).
    pub thumbnail_digest: String,
}

/// A Library file another computer of this account synced, kept here as a read-only copy.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteFile {
    pub device_id: String,
    /// That computer's name.
    pub device: String,
    /// Its path there.
    pub path: String,
    pub title: String,
    pub kind: String,
    pub chat: String,
    pub modified_at: f64,
    pub size: u64,
    /// Where the copy is on this computer (`<data>/cloud/library/<object id>/<name>`).
    pub copy: String,
    /// A small thumbnail from the sealed record (base64url PNG or WebP), shown before
    /// the file is opened on this computer (#3044). Empty when the record had none.
    pub thumbnail_data: String,
    /// True when only a thumbnail record was pushed (the file was over 8 MB, #3044).
    /// Such records have no copy on disk; the original path is shown as the entry path.
    pub thumb_only: bool,
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
    /// The key epoch this copy was last pushed or applied under. After a
    /// rotation, records under an older epoch are ignored, so anything older is
    /// pushed again under the new one.
    pub key_id: u32,
}

/// An organization key this device holds (the keyring itself is in the vault).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OrgKey {
    /// The newest org-key epoch held.
    pub key_id: u32,
    pub name: String,
    /// The account key epoch the `org-key` record was last written under. After
    /// the account rotates, a record under an older epoch is unreadable to
    /// other devices, so it is written again.
    pub sealed_under: u32,
}

/// What this device last published to one organization's fleet.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Share {
    /// The last fleet revision this device published or learned of from the API.
    pub revision: u64,
    /// The org-key epoch of that publish.
    pub key_id: u32,
    /// A digest of what was published (not the time), to publish again only on a change.
    pub digest: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub account: Option<Account>,
    /// Sync is on for this device.
    pub enabled: bool,
    /// The user said they saved the recovery key.
    pub recovery_confirmed: bool,
    pub device_id: Option<String>,
    pub device_label: String,
    /// The key epoch this device holds (only the newest is kept).
    pub key_id: Option<u32>,
    /// The recovery key's public half (base64url), pinned from the first
    /// account record this device opened, or from the recovery key itself.
    pub recovery_public: Option<String>,
    /// The current epoch's sealed account record as last opened (JSON), for the trusted devices.
    pub account_record: Option<String>,
    /// The pull cursor.
    pub cursor: u64,
    /// Highest revision seen per object id: an older one is a rollback and is
    /// ignored, and this never goes down (whatever the server says).
    pub revisions: BTreeMap<String, u64>,
    /// Per chat id.
    pub chats: BTreeMap<String, Synced>,
    pub last_sync_at: Option<f64>,
    pub last_error: Option<String>,
    /// Org keys held, per org id.
    pub org_keys: BTreeMap<String, OrgKey>,
    /// Org ids this computer shares with (off by default, per org). This is not
    /// chat sync: sharing lists this computer and its local models, and uploads no chats.
    pub sharing: BTreeSet<String>,
    /// Per org id.
    pub fleet: BTreeMap<String, Share>,
    /// Highest descriptor revision opened per `<orgId>/<deviceId>`: a lower one is a rollback.
    pub fleet_seen: BTreeMap<String, u64>,
    /// The files Library lists here, per path (#2748). Kept until the file is gone from disk.
    pub library_files: BTreeMap<String, LibraryFile>,
    /// Per path: what was last pushed of each.
    pub library: BTreeMap<String, LibrarySynced>,
    /// Other computers' Library files, per object id.
    pub library_remote: BTreeMap<String, RemoteFile>,
}

impl State {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("state.json")
    }

    pub fn load(dir: &Path) -> State {
        std::fs::read(Self::path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let text = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let opts = nekko_js::fs::AtomicWrite { create_dir: true, ..Default::default() };
        nekko_js::fs::atomic_write(&Self::path(dir), &text, opts).map_err(|e| e.to_string())
    }

    /// Forget everything about sync (another account signed in, or Delete everything synced).
    pub fn reset_sync(&mut self) {
        let keep = (self.account.clone(), self.device_label.clone());
        *self = State { account: keep.0, device_label: keep.1, ..State::default() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_file_from_before_organizations_still_loads() {
        let old = br#"{"enabled":true,"keyId":2,"cursor":9,"revisions":{"a":1}}"#;
        let s: State = serde_json::from_slice(old).unwrap();
        assert!(s.enabled && s.key_id == Some(2));
        assert!(s.sharing.is_empty() && s.org_keys.is_empty() && s.fleet.is_empty() && s.fleet_seen.is_empty());
    }

    #[test]
    fn org_state_round_trips_and_is_forgotten_with_the_sync_state() {
        let mut s = State { enabled: true, ..State::default() };
        s.org_keys.insert("o1".into(), OrgKey { key_id: 2, name: "Nekko Labs".into(), sealed_under: 3 });
        s.sharing.insert("o1".into());
        s.fleet.insert("o1".into(), Share { revision: 7, key_id: 2, digest: "d".into() });
        s.fleet_seen.insert("o1/dev".into(), 7);
        let back: State = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        // No secret is in the file: the org keyrings live in the vault.
        assert!(!serde_json::to_string(&s).unwrap().contains("keyring"));
        // Another account, Delete everything synced: sharing and org keys are gone.
        s.reset_sync();
        assert!(s.sharing.is_empty() && s.org_keys.is_empty() && s.fleet.is_empty() && s.fleet_seen.is_empty());
    }
}
