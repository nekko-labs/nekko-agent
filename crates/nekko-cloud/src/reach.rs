//! How this computer is reached by its account's own devices, with no pairing
//! (decision 0128). While remote access is on and the owner lets account
//! devices in, the computer keeps one `reach` record in the account's sync
//! store: its relay routes, room, room secret and the relay agent's host key,
//! sealed under the account keyring like every record, so Nekko Cloud learns
//! nothing. When that stops, the record becomes a tombstone. A phone of the
//! account reads it to add routes to its pairing, or to connect without one
//! (the account HELLO, `fleet_link.rs`).
//!
//! It is written whatever the per-kind sync switches say, as org keys are
//! (decision 0086): it is how devices connect, not something synced for the owner.

use crate::{Cloud, ConnectInfo, e, lock};
use nekko_sync::{object_id, seal_record};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

/// The sync collection.
pub const REACH: &str = "reach";

/// The record's plaintext: how to reach this computer, or the tombstone when `info` is none.
pub fn reach_plain(device_id: &str, name: &str, info: Option<&ConnectInfo>) -> Vec<u8> {
    let v = match info {
        Some(i) => json!({
            "v": 1,
            "deviceId": device_id,
            "name": name,
            "routes": i.routes,
            "room": i.room,
            "secret": i.secret,
            "hostKey": i.host_key,
        }),
        None => json!({ "v": 1, "deleted": true, "deviceId": device_id }),
    };
    serde_json::to_vec(&v).unwrap_or_default()
}

/// What was last written, for telling when to write again: the plaintext's
/// hash and the key epoch it was sealed under.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReachSynced {
    pub digest: String,
    pub key_id: u32,
    /// Whether the last write was a tombstone.
    pub deleted: bool,
}

fn digest(plain: &[u8]) -> String {
    Sha256::digest(plain).iter().map(|b| format!("{b:02x}")).collect()
}

impl Cloud {
    /// The plaintext this computer should have in the store now, and whether it is a tombstone.
    /// None when there is nothing to say: no account device id yet, or never published and off.
    fn reach_now(&self) -> Option<(Vec<u8>, bool)> {
        let device_id = lock(&self.state).device_id.clone()?;
        let host = lock(&self.host).clone()?;
        let info = host.reach.as_ref().and_then(|f| f());
        let name = (host.name)();
        let deleted = info.is_none();
        if deleted && lock(&self.state).reach.is_none() {
            return None; // never published: no tombstone to write
        }
        Some((reach_plain(&device_id, &name, info.as_ref()), deleted))
    }

    /// The digest the store should hold when it is out of date (so a pass should run), else None.
    pub(crate) fn reach_wanted(&self) -> Option<String> {
        let (mut plain, _) = self.reach_now()?;
        let now = digest(&plain);
        plain.zeroize();
        let key_id = self.key_id();
        let stale = lock(&self.state).reach.as_ref().is_none_or(|r| r.digest != now || r.key_id != key_id);
        stale.then_some(now)
    }

    /// Write the record when it changed (or the key epoch did). Part of every sync pass.
    pub(crate) async fn push_reach(&self, token: &str) -> Result<(), String> {
        let Some((mut plain, deleted)) = self.reach_now() else { return Ok(()) };
        let epoch = self.key_id();
        let now = digest(&plain);
        if lock(&self.state).reach.as_ref().is_some_and(|r| r.digest == now && r.key_id == epoch) {
            plain.zeroize();
            return Ok(());
        }
        let ring = self.keyring(epoch).ok_or("This computer has no sync keys yet.")?;
        let account_id = self.account_id()?;
        let device_id = lock(&self.state).device_id.clone().unwrap_or_default();
        let oid = object_id(&ring, REACH, &device_id).map_err(|err| err.to_string())?;
        let mut seen = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0);
        let mut result = Err("Couldn't publish how this computer is reached.".to_string());
        // This computer is the record's only writer: a conflict is an older write of its own.
        for _ in 0..4 {
            let revision = seen + 1;
            let blob =
                seal_record(&ring, &account_id, epoch, REACH, &oid, revision, &plain).map_err(|err| err.to_string())?;
            let obj =
                json!({ "collection": REACH, "objectId": oid, "revision": revision, "keyId": epoch, "blob": blob });
            let res = self
                .api
                .send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": [obj] })))
                .await
                .map_err(e)?;
            let r: &Value = &res["results"][0];
            match r["status"].as_str() {
                Some("ok") => {
                    self.edit(|s| {
                        s.revisions.insert(oid.clone(), revision);
                        s.reach = Some(ReachSynced { digest: now.clone(), key_id: epoch, deleted });
                    })?;
                    result = Ok(());
                    break;
                }
                Some("conflict") => seen = seen.max(r["revision"].as_u64().unwrap_or(revision)),
                Some("stale-key") => {
                    result = Err("Another device changed the sync keys. Sync, then try again.".into());
                    break;
                }
                other => {
                    result =
                        Err(format!("Couldn't publish how this computer is reached ({}).", other.unwrap_or("error")));
                    break;
                }
            }
        }
        plain.zeroize();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_carries_every_route_and_the_tombstone_only_the_device() {
        let info = ConnectInfo::new(
            vec!["ws://gomi.tailfd6474.ts.net:4400".into(), "wss://nekko-agent-relay.fly.dev".into()],
            "faa985fa39488785".into(),
            "0123456789abcdef".into(),
            "BAAA".into(),
        )
        .unwrap();
        let v: Value = serde_json::from_slice(&reach_plain("dev-1", "MacBook Pro", Some(&info))).unwrap();
        assert_eq!(
            v,
            json!({
                "v": 1, "deviceId": "dev-1", "name": "MacBook Pro",
                "routes": ["ws://gomi.tailfd6474.ts.net:4400", "wss://nekko-agent-relay.fly.dev"],
                "room": "faa985fa39488785", "secret": "0123456789abcdef", "hostKey": "BAAA",
            })
        );
        let gone: Value = serde_json::from_slice(&reach_plain("dev-1", "MacBook Pro", None)).unwrap();
        assert_eq!(gone, json!({ "v": 1, "deleted": true, "deviceId": "dev-1" }));
    }
}
