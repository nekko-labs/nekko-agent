//! Opening a chat on a computer of this account found through an org's fleet
//! (decision 0102). Discovery (`orgs.rs`) says a computer exists; this is
//! what lets one of the same account's devices reach it, with no pairing:
//!
//! - **Publishing.** While remote access is on, a sharing computer puts a
//!   connect block in its descriptor ([`ConnectInfo`]: relay routes, room, room
//!   secret, the relay agent's host key), sealed under the *account* keyring,
//!   not the org's, so another member holding the org key still can't read it.
//! - **Connecting.** A device of the account opens that block from the fleet
//!   list ([`Cloud::fleet_target`]) and, in every HELLO, proves it holds the
//!   account's current keys ([`Cloud::fleet_hello`]): a proof sealed under the
//!   account keyring that binds the org, room, challenge, both halves of the
//!   key exchange and the HELLO key.
//! - **Admitting.** The computer opens the proof with its own current keyring
//!   and checks the rest from local state only ([`Cloud::fleet_admit`]), then
//!   again whenever asked ([`Cloud::fleet_still`]): a sign-out, a lock, a new key
//!   epoch, a device dropped from the account record, or sharing turned off for
//!   that org ends the link.
//!
//! Nekko Cloud sees none of it: the connect block is inside a sealed
//! descriptor, and the proof travels inside the relay's end-to-end channel.

use crate::org_records::{ConnectFacts, valid_uuid};
use crate::{Cloud, lock};
use nekko_sync::{open_connect, open_hello_proof, seal_connect, seal_hello_proof};
use serde_json::{Value, json};
use std::sync::Arc;

/// At most this many routes go in a connect block.
const MAX_ROUTES: usize = 4;

/// How to reach a computer's relay agent. Holds the room secret: its `Debug`
/// says nothing.
#[derive(Clone, PartialEq)]
pub struct ConnectInfo {
    /// Relay addresses, best first (`ws://` or `wss://`).
    pub routes: Vec<String>,
    pub room: String,
    pub secret: String,
    /// The relay agent's public key (base64 X9.63 P-256), which the device pins.
    pub host_key: String,
}

impl std::fmt::Debug for ConnectInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ConnectInfo({:?}, ..)", self.routes)
    }
}

fn token_ok(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_graphic())
}

impl ConnectInfo {
    /// What the connect block holds, for one org.
    pub fn to_plain(&self, org_id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "v": 1,
            "orgId": org_id,
            "routes": self.routes,
            "room": self.room,
            "secret": self.secret,
            "hostKey": self.host_key,
        }))
        .unwrap_or_default()
    }

    /// A connect block's plaintext, refused unless it is for `org_id` and in shape.
    pub fn parse(plain: &[u8], org_id: &str) -> Option<ConnectInfo> {
        let v: Value = serde_json::from_slice(plain).ok()?;
        if v["v"].as_u64() != Some(1) || v["orgId"].as_str() != Some(org_id) {
            return None;
        }
        let routes: Vec<String> = v["routes"]
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .filter(|r| (r.starts_with("ws://") || r.starts_with("wss://")) && token_ok(r, 200))
            .take(MAX_ROUTES)
            .map(str::to_string)
            .collect();
        let text = |k: &str, max: usize| v[k].as_str().filter(|t| token_ok(t, max)).map(str::to_string);
        let info = ConnectInfo {
            routes,
            room: text("room", 64)?,
            secret: text("secret", 128)?,
            host_key: text("hostKey", 200)?,
        };
        (!info.routes.is_empty()).then_some(info)
    }

    /// Clean what the daemon offers: routes in order, deduplicated, bounded.
    pub fn new(routes: Vec<String>, room: String, secret: String, host_key: String) -> Option<ConnectInfo> {
        let mut clean: Vec<String> = Vec::new();
        for r in routes {
            let r = r.trim().trim_end_matches('/').to_string();
            if (r.starts_with("ws://") || r.starts_with("wss://")) && token_ok(&r, 200) && !clean.contains(&r) {
                clean.push(r);
            }
        }
        clean.truncate(MAX_ROUTES);
        let ok = !clean.is_empty() && token_ok(&room, 64) && token_ok(&secret, 128) && token_ok(&host_key, 200);
        ok.then_some(ConnectInfo { routes: clean, room, secret, host_key })
    }
}

/// A computer of this account that can be reached, from the last fleet list.
#[derive(Clone, PartialEq)]
pub struct FleetTarget {
    pub org_id: String,
    /// Its account device id.
    pub device_id: String,
    pub name: String,
    pub os: String,
    pub connect: ConnectInfo,
}

impl std::fmt::Debug for FleetTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FleetTarget({}, {}, {:?})", self.org_id, self.device_id, self.connect)
    }
}

/// A device let in through the fleet, as the computer checks it again later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetAdmitted {
    pub device_id: String,
    pub org_id: String,
    pub key_id: u32,
    pub name: String,
}

/// What one fleet HELLO is bound to (`nekko_remote::fleet::Binding`, which
/// this crate doesn't depend on).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloBinding<'a> {
    pub room: &'a str,
    pub challenge: &'a str,
    pub host_eph: &'a str,
    pub client_eph: &'a str,
    pub hello_key: &'a str,
}

fn binding_json(org_id: &str, b: &HelloBinding<'_>) -> Value {
    json!({
        "v": 1,
        "orgId": org_id,
        "room": b.room,
        "challenge": b.challenge,
        "hostEph": b.host_eph,
        "clientEph": b.client_eph,
        "helloKey": b.hello_key,
    })
}

pub(crate) fn target_key(org_id: &str, device_id: &str) -> String {
    format!("{org_id}/{device_id}")
}

/// The connect state the Computers list shows for one opened descriptor.
pub(crate) enum Reach {
    /// This device itself.
    You,
    Ready(FleetTarget),
    /// Shared by another member's account: not offered (v1 is one account).
    OtherAccount,
    /// Its own-account key could not be checked against the account record.
    Unverified,
    /// No connect block: remote access is off there, or its build is older.
    NoRemote,
    /// The block is for an epoch this device doesn't hold (yet).
    Locked,
}

impl Reach {
    pub(crate) fn word(&self) -> &'static str {
        match self {
            Reach::You => "you",
            Reach::Ready(_) => "ready",
            Reach::OtherAccount => "other-account",
            Reach::Unverified => "unverified",
            Reach::NoRemote => "no-remote",
            Reach::Locked => "locked",
        }
    }
}

impl Cloud {
    /// The connect block for this computer's descriptor in `org_id`, sealed for
    /// `revision`: `None` when remote access is off here or the account is locked.
    pub(crate) fn connect_facts(&self) -> Option<ConnectFacts> {
        let host = lock(&self.host).clone()?;
        let info = (host.connect.as_ref()?)()?;
        let key_id = self.key_id();
        self.keyring(key_id)?;
        // The org is bound when sealing; the facts hold the org-free fields for the digest.
        Some(ConnectFacts { key_id, plain: info.to_plain("") })
    }

    /// Seal the connect block for one org and revision.
    pub(crate) fn seal_connect_for(&self, org_id: &str, device_id: &str, revision: u64) -> Option<(u32, String)> {
        let host = lock(&self.host).clone()?;
        let info = (host.connect.as_ref()?)()?;
        let account = self.account_id().ok()?;
        let key_id = self.key_id();
        let ring = self.keyring(key_id)?;
        let blob = seal_connect(&ring, &account, key_id, org_id, device_id, revision, &info.to_plain(org_id)).ok()?;
        Some((key_id, blob))
    }

    /// What one opened descriptor offers this device.
    pub(crate) fn reach(
        &self,
        org_id: &str,
        desc: &crate::org_records::Descriptor,
        revision: u64,
        you: bool,
        verified: bool,
        me: &str,
    ) -> Reach {
        if you {
            return Reach::You;
        }
        if desc.account_id != me {
            return Reach::OtherAccount;
        }
        if !verified {
            return Reach::Unverified;
        }
        let Some((key_id, blob)) = &desc.connect else { return Reach::NoRemote };
        let Some(ring) = self.keyring(*key_id) else { return Reach::Locked };
        let opened = open_connect(&ring, me, *key_id, org_id, &desc.device_id, revision, blob).ok();
        match opened.and_then(|p| ConnectInfo::parse(&p, org_id)) {
            Some(connect) => Reach::Ready(FleetTarget {
                org_id: org_id.to_string(),
                device_id: desc.device_id.clone(),
                name: desc.name.clone(),
                os: desc.os.clone(),
                connect,
            }),
            None => Reach::Unverified,
        }
    }

    /// A computer of this account to connect to, from the last fleet list.
    /// None when it wasn't listed as ready, or this device is signed out or locked.
    pub fn fleet_target(&self, org_id: &str, device_id: &str) -> Option<FleetTarget> {
        if self.account_id().is_err() || self.token().is_err() || self.keyring(self.key_id()).is_none() {
            lock(&self.live).fleet_targets.clear();
            return None;
        }
        lock(&self.live).fleet_targets.get(&target_key(org_id, device_id)).cloned()
    }

    /// This device's id in the account (what a fleet link is named after), once unlocked.
    pub fn fleet_device(&self) -> Option<String> {
        lock(&self.state).device_id.clone()
    }

    /// Whether this device could prove itself to a computer of its account now.
    pub fn fleet_ready(&self) -> bool {
        self.account_id().is_ok()
            && self.token().is_ok()
            && lock(&self.state).device_id.is_some()
            && self.keyring(self.key_id()).is_some()
    }

    /// The HELLO's `fleet` object for one handshake: who this device is and a
    /// proof, sealed under the account's current keyring, that binds the org
    /// and the exchange. None when signed out or locked.
    pub fn fleet_hello(&self, org_id: &str, b: &HelloBinding<'_>) -> Option<Value> {
        let account = self.account_id().ok()?;
        let device = lock(&self.state).device_id.clone()?;
        let key_id = self.key_id();
        let ring = self.keyring(key_id)?;
        let plain = serde_json::to_vec(&binding_json(org_id, b)).ok()?;
        let proof = seal_hello_proof(&ring, &account, key_id, &device, &plain).ok()?;
        Some(json!({ "v": 1, "accountId": account, "keyId": key_id, "deviceId": device, "proof": proof }))
    }

    /// The computer's check of a fleet HELLO, from local state only. The
    /// reasons are the codes the connecting device sees. When the HELLO is from
    /// a device or key epoch this computer hasn't heard of yet, it catches up
    /// in the background ([`Cloud::fleet_catch_up`]) so the device's next try
    /// can succeed; the refusal stands either way.
    pub fn fleet_admit(self: &Arc<Self>, fleet: &Value, b: &HelloBinding<'_>) -> Result<FleetAdmitted, &'static str> {
        let out = self.fleet_admit_now(fleet, b);
        if matches!(out, Err("fleet-device" | "fleet-epoch")) {
            self.catch_up_soon();
        }
        out
    }

    fn catch_up_soon(self: &Arc<Self>) {
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        {
            let mut live = lock(&self.live);
            if live.fleet_catching_up {
                return;
            }
            live.fleet_catching_up = true;
        }
        let me = self.clone();
        rt.spawn(async move {
            if let Err(err) = me.fleet_catch_up().await {
                eprintln!("nekkod: couldn't catch up with the account for a fleet connection: {err}");
            }
            lock(&me.live).fleet_catching_up = false;
        });
    }

    /// Read the account again: a newer key epoch is adopted, and the current
    /// epoch's account record (which lists the account's devices) is reloaded.
    pub async fn fleet_catch_up(&self) -> Result<(), String> {
        let token = self.token()?;
        self.refresh().await?;
        if let Some(remote) = self.remote_key().filter(|r| *r > self.key_id()) {
            self.adopt(&token, remote).await?;
        }
        let key_id = self.key_id();
        let ring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
        let account = self.account_id()?;
        if let Some((record, oid, rev)) = self.fetch_account(&token, &ring, &account, key_id).await? {
            self.keep_account(&record, &oid, rev)?;
        }
        Ok(())
    }

    fn fleet_admit_now(&self, fleet: &Value, b: &HelloBinding<'_>) -> Result<FleetAdmitted, &'static str> {
        if fleet["v"].as_u64() != Some(1) {
            return Err("invalid");
        }
        let me = self.account_id().map_err(|_| "fleet-locked")?;
        if self.token().is_err() {
            return Err("fleet-locked");
        }
        if fleet["accountId"].as_str() != Some(me.as_str()) {
            return Err("fleet-account");
        }
        let key_id = self.key_id();
        let theirs = fleet["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()).ok_or("invalid")?;
        if key_id == 0 || theirs != key_id {
            return Err("fleet-epoch");
        }
        let ring = self.keyring(key_id).ok_or("fleet-locked")?;
        let device = fleet["deviceId"].as_str().filter(|d| valid_uuid(d)).ok_or("invalid")?;
        let proof = fleet["proof"].as_str().ok_or("invalid")?;
        let plain = open_hello_proof(&ring, &me, key_id, device, proof).map_err(|_| "invalid")?;
        let said: Value = serde_json::from_slice(&plain).map_err(|_| "invalid")?;
        let org_id = said["orgId"].as_str().filter(|o| valid_uuid(o)).ok_or("invalid")?.to_string();
        if said != binding_json(&org_id, b) {
            return Err("invalid");
        }
        if !lock(&self.state).sharing.contains(&org_id) {
            return Err("fleet-off");
        }
        let record = self.account_record().filter(|r| r.epoch == key_id).ok_or("fleet-epoch")?;
        let entry = record.devices.iter().find(|d| d.id == device).ok_or("fleet-device")?;
        Ok(FleetAdmitted { device_id: device.to_string(), org_id, key_id, name: entry.label.clone() })
    }

    /// Whether an admitted device may stay connected.
    pub fn fleet_still(&self, a: &FleetAdmitted) -> bool {
        self.account_id().is_ok()
            && self.token().is_ok()
            && self.key_id() == a.key_id
            && self.keyring(a.key_id).is_some()
            && lock(&self.state).sharing.contains(&a.org_id)
            && self.account_record().is_some_and(|r| r.epoch == a.key_id && r.trusts(&a.device_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_info_is_cleaned_and_bound_to_its_org() {
        let info = ConnectInfo::new(
            vec![
                "ws://gomi.tailfd6474.ts.net:4400/".into(),
                "ws://gomi.tailfd6474.ts.net:4400".into(),
                "http://nope".into(),
                "wss://relay.example".into(),
            ],
            "abcd1234".into(),
            "0123456789abcdef".into(),
            "BAAA".into(),
        )
        .unwrap();
        assert_eq!(info.routes, ["ws://gomi.tailfd6474.ts.net:4400", "wss://relay.example"]);
        let org = "0b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b";
        assert_eq!(ConnectInfo::parse(&info.to_plain(org), org), Some(info.clone()));
        assert_eq!(ConnectInfo::parse(&info.to_plain(org), "1b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b"), None);
        assert!(!format!("{info:?}").contains("0123456789abcdef"), "Debug never shows the secret");
        assert!(ConnectInfo::new(vec![], "r".into(), "s".into(), "k".into()).is_none());
        assert!(ConnectInfo::new(vec!["ws://a".into()], "".into(), "s".into(), "k".into()).is_none());
    }
}
