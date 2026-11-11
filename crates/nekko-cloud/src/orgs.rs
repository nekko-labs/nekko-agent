//! Organizations (`org:*`) and the organization computer fleet (`fleet:*`).
//!
//! An organization owns a computer list that its members see. What a computer
//! shares (its name, OS and the local models it can serve) is sealed on this
//! device under the organization's keyring, so Nekko Cloud stores only
//! ciphertext, and a signed-in but locked device lists nothing (decision
//! 0066). Sharing is off by default and per organization, and it uploads no
//! chats: it is a separate consent from chat sync.
//!
//! **The org keyring.** 64 random bytes per epoch, made by the device that
//! creates the org (or rotates it). It is stored as an ordinary sealed record
//! of the account (`org-key`, local id `<orgId>:<orgKeyId>`) so every unlocked
//! device of the account can fetch it, whether or not chat sync is on there,
//! and in the vault as `org-keyring:<orgId>:<orgKeyId>`. Handing the key to
//! another member's account is designed and not built yet (docs/SYNC-ENCRYPTION.md):
//! until then another member sees the org and its members but cannot read or
//! publish computers.
//!
//! **Sharing.** While sharing is on this device publishes a descriptor,
//! renews its lease every 30 seconds, publishes again when its name or local
//! model set changes, and recovers from errors, sleep and restarts on the next
//! beat. It withdraws when sharing is turned off and on sign-out, account
//! switch and forget.

use crate::http::HttpError;
use crate::org_records::{
    Descriptor, HostFacts, LocalModel, ORG_KEY, OrgKeyRecord, org_key_local_id, this_os, valid_org_id, valid_uuid,
};
use crate::records::AccountRecord;
use crate::state::{OrgKey, Share, State};
use crate::{Cloud, Live, arg, e, lock};
use nekko_sync::{Keyring, b64_encode, object_id, open_descriptor, open_record, seal_descriptor, seal_record};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroize;

/// How often a sharing computer renews its lease (the API's lease is 90 seconds).
pub const HEARTBEAT: Duration = Duration::from_secs(30);

const LOCKED: &str = "Unlock your account on this computer to use organizations.";
const NO_KEY: &str = "Computers need the org key, ask an admin.";
const NOT_SIGNED_IN: &str = "Sign in to Nekko Cloud first.";
const NEEDS_PLAN: &str = "Organizations need a Pro or Team plan.";

pub type ModelFuture = Pin<Box<dyn Future<Output = Vec<LocalModel>> + Send>>;

/// What the daemon tells Nekko Cloud about this computer, read each time a
/// descriptor is made.
pub struct HostInfo {
    pub app_version: String,
    /// The name members see for this computer.
    pub name: Arc<dyn Fn() -> String + Send + Sync>,
    /// The local models this computer can serve right now (no cloud providers).
    pub models: Arc<dyn Fn() -> ModelFuture + Send + Sync>,
}

/// How sharing with one org is going, for `fleet:status`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ShareLive {
    pub state: &'static str,
    pub last_heartbeat: Option<f64>,
    pub error: Option<String>,
}

fn org_error(err: HttpError) -> String {
    match (err.status, err.code.as_str()) {
        (403, "orgs-not-available") => "Organizations aren't available for this account yet.".into(),
        (402, _) | (_, "plan-required") => NEEDS_PLAN.into(),
        (403, "needs-synced-device") => LOCKED.into(),
        (403, "forbidden") => "Only an owner or admin can do that.".into(),
        (404, _) => "That organization wasn't found.".into(),
        (409, "last-owner") => "An organization needs at least one owner.".into(),
        (409, "org-limit") => "You are in as many organizations as Nekko Cloud allows.".into(),
        (409, "org-full") => "That organization has as many members as Nekko Cloud allows.".into(),
        (409, "already-member") => "That person is already a member.".into(),
        (409, "invite-exists") => "That person already has an invitation.".into(),
        (409, "fleet-full") => "This organization's computer list is full.".into(),
        (410, "invite-expired") => "That invitation expired.".into(),
        (400, "bad-name") => "Enter a name of up to 80 characters.".into(),
        (400, "bad-email") => "Enter an email address.".into(),
        _ => err.message,
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn org_id_arg(args: &[Value], i: usize) -> Result<String, String> {
    let id = arg(args, i);
    if valid_org_id(&id) { Ok(id) } else { Err("That organization wasn't found.".into()) }
}

fn keyring_name(org_id: &str, key_id: u32) -> String {
    format!("org-keyring:{org_id}:{key_id}")
}

/// A fleet row opened and checked, or None when it must be dropped. `seen` is
/// the highest revision of this device's descriptor opened before (a lower one
/// is a rollback); `trusted` is this account's record of its own devices.
pub(crate) struct OpenRow {
    pub desc: Descriptor,
    pub revision: u64,
    pub verified: bool,
}

pub(crate) fn open_row(
    ring: &Keyring,
    org_id: &str,
    org_key_id: u32,
    row: &Value,
    seen: u64,
    my_account: &str,
    trusted: Option<&AccountRecord>,
) -> Option<OpenRow> {
    let device_id = row["deviceId"].as_str().filter(|d| valid_uuid(d))?;
    let user_id = row["userId"].as_str()?;
    let revision = row["revision"].as_u64().filter(|r| *r >= 1)?;
    if row["orgKeyId"].as_u64() != Some(u64::from(org_key_id)) || revision < seen {
        return None;
    }
    let plain = open_descriptor(ring, org_id, org_key_id, device_id, revision, row["descriptor"].as_str()?).ok()?;
    let desc = Descriptor::parse(&plain)?;
    // The descriptor must say what the row says: whose it is and which device.
    if desc.device_id != device_id || desc.account_id != user_id {
        return None;
    }
    // Stated limit: any holder of the org key can author a descriptor. For this
    // account's own computers the host key can be checked against the account
    // record, which only a holder of the account keys can write.
    let verified = user_id == my_account && trusted.is_some_and(|r| r.lists(device_id, &desc.host_key));
    Some(OpenRow { desc, revision, verified })
}

/// The `orgs` summary on `cloud:status`: local only, from the last list.
pub(crate) fn orgs_summary(s: &State, live: &Live) -> Value {
    let orgs: Vec<Value> = live
        .orgs
        .iter()
        .flatten()
        .map(|o| {
            let id = o["id"].as_str().unwrap_or("");
            let key_id = o["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()).unwrap_or(0);
            let sharing = s.sharing.contains(id);
            let held = s.org_keys.get(id).is_some_and(|k| k.key_id == key_id && key_id >= 1);
            let state = if sharing { live.shares.get(id).map_or("publishing", |l| l.state) } else { "off" };
            json!({ "id": id, "name": o["name"], "role": o["role"], "hasKey": held, "sharing": sharing,
                    "state": if state.is_empty() { "publishing" } else { state } })
        })
        .collect();
    Value::Array(orgs)
}

impl Cloud {
    /// Tell Nekko Cloud about this computer (the daemon calls this once).
    pub fn set_host(&self, host: HostInfo) {
        *lock(&self.host) = Some(Arc::new(host));
    }

    pub(crate) async fn route_org(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        match channel {
            "org:list" => self.org_list().await,
            "org:create" => self.org_create(&arg(args, 0)).await,
            "org:get" => self.org_get(&org_id_arg(args, 0)?).await,
            "org:invite" => {
                let org = org_id_arg(args, 0)?;
                let mut body = json!({ "email": arg(args, 1) });
                let role = arg(args, 2);
                if !role.is_empty() {
                    body["role"] = json!(role);
                }
                let token = self.token()?;
                self.api
                    .send(&token, reqwest::Method::POST, &format!("/v1/orgs/{org}/invites"), Some(body))
                    .await
                    .map_err(org_error)?;
                self.org_get(&org).await
            }
            "org:revokeInvite" => {
                let org = org_id_arg(args, 0)?;
                let invite = arg(args, 1);
                if !valid_uuid(&invite) {
                    return Err("That invitation wasn't found.".into());
                }
                let token = self.token()?;
                self.api
                    .send(&token, reqwest::Method::DELETE, &format!("/v1/orgs/{org}/invites/{invite}"), None)
                    .await
                    .map_err(org_error)?;
                self.org_get(&org).await
            }
            "org:acceptInvite" => {
                let invite = arg(args, 0);
                if !valid_uuid(&invite) {
                    return Err("That invitation wasn't found.".into());
                }
                let token = self.token()?;
                self.api
                    .send(&token, reqwest::Method::POST, &format!("/v1/orgs/invites/{invite}/accept"), None)
                    .await
                    .map_err(org_error)?;
                let out = self.org_list().await?;
                self.changed();
                Ok(out)
            }
            "org:removeMember" => self.org_remove_member(&org_id_arg(args, 0)?, &arg(args, 1)).await,
            "org:rename" => {
                let org = org_id_arg(args, 0)?;
                let name = arg(args, 1);
                let token = self.token()?;
                self.api
                    .send(&token, reqwest::Method::PATCH, &format!("/v1/orgs/{org}"), Some(json!({ "name": name })))
                    .await
                    .map_err(org_error)?;
                let out = self.org_get(&org).await?;
                self.changed();
                Ok(out)
            }
            "org:delete" => {
                let org = org_id_arg(args, 0)?;
                let token = self.token()?;
                // Withdraw first: the org's rows go with it, but this device's sharing must stop.
                let _ = self.set_sharing_off(&org, Some(&token)).await;
                self.api
                    .send(&token, reqwest::Method::DELETE, &format!("/v1/orgs/{org}"), None)
                    .await
                    .map_err(org_error)?;
                self.forget_org(&org);
                let out = self.org_list().await?;
                self.changed();
                Ok(out)
            }
            "fleet:setSharing" => {
                let org = org_id_arg(args, 0)?;
                let on = args.get(1).and_then(Value::as_bool).unwrap_or(false);
                self.set_sharing(&org, on).await
            }
            "fleet:list" => self.fleet_list(&org_id_arg(args, 0)?).await,
            "fleet:status" => Ok(self.fleet_status()),
            _ => Err(format!("unknown channel {channel}")),
        }
    }

    // -------------------------------------------------------------- local keys

    fn org_keyring(&self, org_id: &str, key_id: u32) -> Option<Keyring> {
        let mut raw = nekko_sync::b64_decode(&self.vault.get(&keyring_name(org_id, key_id))?).ok()?;
        let k = Keyring::from_bytes(&raw).ok();
        raw.zeroize();
        k
    }

    /// The newest org key held for an org: its epoch and keyring.
    fn held_org_key(&self, org_id: &str) -> Option<(u32, Keyring)> {
        let key_id = lock(&self.state).org_keys.get(org_id)?.key_id;
        Some((key_id, self.org_keyring(org_id, key_id)?))
    }

    fn has_org_key(&self, org_id: &str, key_id: u32) -> bool {
        key_id >= 1 && self.held_org_key(org_id).is_some_and(|(held, _)| held == key_id)
    }

    /// Hold an org key as the org's newest. An older epoch than the one held is ignored.
    fn store_org_key(
        &self,
        org_id: &str,
        name: &str,
        key_id: u32,
        sealed_under: u32,
        k: &Keyring,
    ) -> Result<(), String> {
        let held = lock(&self.state).org_keys.get(org_id).map(|o| o.key_id);
        if held.is_some_and(|h| h > key_id) {
            return Ok(());
        }
        let mut raw = k.to_bytes();
        let out = self.vault.set(&keyring_name(org_id, key_id), &b64_encode(&raw));
        raw.zeroize();
        out?;
        let name = name.to_string();
        self.edit(|s| {
            s.org_keys.insert(org_id.to_string(), OrgKey { key_id, name, sealed_under });
        })?;
        for old in 1..key_id {
            self.vault.delete(&keyring_name(org_id, old));
        }
        Ok(())
    }

    /// Forget everything this device holds for an org (it is gone, or this device left).
    pub(crate) fn forget_org(&self, org_id: &str) {
        let top = lock(&self.state).org_keys.get(org_id).map_or(0, |o| o.key_id);
        for k in 1..=top {
            self.vault.delete(&keyring_name(org_id, k));
        }
        let prefix = format!("{org_id}/");
        let _ = self.edit(|s| {
            s.org_keys.remove(org_id);
            s.sharing.remove(org_id);
            s.fleet.remove(org_id);
            s.fleet_seen.retain(|k, _| !k.starts_with(&prefix));
        });
        lock(&self.live).shares.remove(org_id);
    }

    /// Delete every org keyring from the vault (the account keys are going).
    pub(crate) fn forget_org_keys(&self) {
        let held: Vec<(String, u32)> =
            lock(&self.state).org_keys.iter().map(|(id, o)| (id.clone(), o.key_id)).collect();
        for (id, top) in held {
            for k in 1..=top {
                self.vault.delete(&keyring_name(&id, k));
            }
        }
    }

    // ------------------------------------------------------- unlocked, record io

    /// This sign-in holds the account's current keys and Nekko Cloud knows it
    /// (the same bar as the account fleet, decision 0066). Returns the account key epoch.
    async fn org_unlocked(&self, token: &str) -> Result<u32, String> {
        if self.keyring(self.key_id()).is_none() {
            return Err(LOCKED.into());
        }
        // The last state read may predate the keys (sync was just turned on): read it again.
        if lock(&self.live).remote.is_none() || self.remote_key().is_none_or(|r| r < self.key_id()) {
            self.refresh().await?;
        }
        let remote = self.remote_key().ok_or(LOCKED)?;
        if remote > self.key_id() && !self.adopt(token, remote).await? {
            return Err(LOCKED.into());
        }
        self.ensure_device(token, None).await?;
        let key_id = self.key_id();
        self.prove(token, key_id).await?;
        Ok(key_id)
    }

    fn need_plan(&self) -> Result<(), String> {
        if self.account().is_some_and(|a| a.can_sync) { Ok(()) } else { Err(NEEDS_PLAN.into()) }
    }

    /// Read an org's key record for an epoch from the account's own store.
    /// None while it isn't written yet, or was written under another account
    /// key epoch (it is written again once a key holder sees that).
    async fn fetch_org_key(&self, token: &str, org_id: &str, key_id: u32) -> Result<Option<OrgKeyRecord>, String> {
        let epoch = self.key_id();
        let ring = self.keyring(epoch).ok_or(LOCKED)?;
        let account_id = self.account_id()?;
        let oid = object_id(&ring, ORG_KEY, &org_key_local_id(org_id, key_id)).map_err(|err| err.to_string())?;
        let o = match self.api.get(token, &format!("/v1/sync/objects/{ORG_KEY}/{oid}")).await {
            Ok(o) => o,
            Err(err) if err.status == 404 => return Ok(None),
            Err(err) => return Err(err.message),
        };
        let bad = || "Nekko Cloud sent an organization key that doesn't check out.".to_string();
        let (Some(got), Some(rev), Some(kid), Some(blob)) =
            (o["objectId"].as_str(), o["revision"].as_u64(), o["keyId"].as_u64(), o["blob"].as_str())
        else {
            return Err(bad());
        };
        if got != oid || o["collection"].as_str() != Some(ORG_KEY) {
            return Err(bad());
        }
        if kid != u64::from(epoch) {
            return Ok(None);
        }
        if lock(&self.state).revisions.get(&oid).is_some_and(|seen| *seen > rev) {
            return Err("Nekko Cloud sent an older organization key than this device has seen.".into());
        }
        let plain = open_record(&ring, &account_id, epoch, ORG_KEY, &oid, rev, blob).map_err(|_| bad())?;
        let rec = OrgKeyRecord::parse(&plain).filter(|r| r.org_id == org_id && r.key_id == key_id).ok_or_else(bad)?;
        self.edit(|s| {
            let seen = s.revisions.entry(oid).or_insert(0);
            *seen = (*seen).max(rev);
        })?;
        Ok(Some(rec))
    }

    /// Write an org key's record into the account's store. When a record for
    /// this epoch is already there (another device made the key first), that
    /// key is the one to use and is returned instead.
    async fn write_org_key(
        &self,
        token: &str,
        org_id: &str,
        key_id: u32,
        name: &str,
        keyring: &Keyring,
    ) -> Result<Keyring, String> {
        let epoch = self.key_id();
        let ring = self.keyring(epoch).ok_or(LOCKED)?;
        let account_id = self.account_id()?;
        self.prove(token, epoch).await?;
        let oid = object_id(&ring, ORG_KEY, &org_key_local_id(org_id, key_id)).map_err(|err| err.to_string())?;
        let mut plain =
            OrgKeyRecord { org_id: org_id.into(), key_id, name: name.into(), keyring: keyring.clone() }.to_bytes();
        let mut seen = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0);
        let mut result = Err("Couldn't save the organization key.".to_string());
        for _ in 0..4 {
            let revision = seen + 1;
            let blob = seal_record(&ring, &account_id, epoch, ORG_KEY, &oid, revision, &plain)
                .map_err(|err| err.to_string())?;
            let obj =
                json!({ "collection": ORG_KEY, "objectId": oid, "revision": revision, "keyId": epoch, "blob": blob });
            let res = self
                .api
                .send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": [obj] })))
                .await
                .map_err(e)?;
            let r = &res["results"][0];
            match r["status"].as_str() {
                Some("ok") => {
                    self.edit(|s| {
                        s.revisions.insert(oid.clone(), revision);
                    })?;
                    result = Ok(keyring.clone());
                    break;
                }
                Some("conflict") => {
                    let theirs = r["revision"].as_u64().unwrap_or(0);
                    if let Ok(Some(rec)) = self.fetch_org_key(token, org_id, key_id).await {
                        result = Ok(rec.keyring);
                        break;
                    }
                    // What is there can't be read (an older account key epoch): write over it.
                    seen = seen.max(theirs);
                }
                Some("stale-key") => {
                    result = Err("Another device changed the sync keys. Sync, then try again.".into());
                    break;
                }
                other => {
                    result = Err(format!("Couldn't save the organization key ({}).", other.unwrap_or("error")));
                    break;
                }
            }
        }
        plain.zeroize();
        result
    }

    /// Make the org's next key, write it to the account, then advance the
    /// org's epoch. Another device that got there first wins, and its key is used.
    async fn create_org_key(&self, token: &str, org_id: &str, name: &str, current: u32) -> Result<(), String> {
        let next = current + 1;
        let epoch = self.key_id();
        let effective = self.write_org_key(token, org_id, next, name, &Keyring::generate()).await?;
        let put = self
            .api
            .send(token, reqwest::Method::PUT, &format!("/v1/orgs/{org_id}/key"), Some(json!({ "keyId": next })))
            .await;
        match put {
            Ok(_) => self.store_org_key(org_id, name, next, epoch, &effective),
            Err(err) if err.status == 409 && err.code == "org-key-epoch" => {
                // Another device moved the epoch first: its key is the org's.
                let cur = err.body["currentKeyId"].as_u64().and_then(|k| u32::try_from(k).ok()).unwrap_or(0);
                match self.fetch_org_key(token, org_id, cur).await? {
                    Some(rec) if cur >= 1 => self.store_org_key(org_id, name, cur, epoch, &rec.keyring),
                    _ => Err(NO_KEY.into()),
                }
            }
            Err(err) => Err(org_error(err)),
        }
    }

    /// Fetch the org keys this device lacks, for the orgs in a `GET /v1/orgs` list.
    async fn collect_org_keys(&self, token: &str, orgs: &[Value]) {
        let epoch = self.key_id();
        for o in orgs {
            let (Some(id), Some(key_id)) = (o["id"].as_str(), o["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()))
            else {
                continue;
            };
            let held = lock(&self.state).org_keys.get(id).map(|k| k.key_id);
            if key_id == 0 || held.is_some_and(|h| h >= key_id) {
                continue;
            }
            if let Ok(Some(rec)) = self.fetch_org_key(token, id, key_id).await {
                let name = o["name"].as_str().unwrap_or(&rec.name).to_string();
                let _ = self.store_org_key(id, &name, key_id, epoch, &rec.keyring);
            }
        }
    }

    /// Write the org-key records again under the account's current key
    /// epoch, after the account rotated: older ones are unreadable to the rest.
    pub(crate) async fn reseal_org_keys(&self, token: &str) -> Result<(), String> {
        let epoch = self.key_id();
        let stale: Vec<(String, OrgKey)> = lock(&self.state)
            .org_keys
            .iter()
            .filter(|(_, o)| o.sealed_under != epoch)
            .map(|(i, o)| (i.clone(), o.clone()))
            .collect();
        for (id, k) in stale {
            let Some(ring) = self.org_keyring(&id, k.key_id) else { continue };
            let effective = self.write_org_key(token, &id, k.key_id, &k.name, &ring).await?;
            self.store_org_key(&id, &k.name, k.key_id, epoch, &effective)?;
        }
        Ok(())
    }

    /// The org has a usable key on this device: held, fetched from the account's
    /// store, or (for an owner or admin of an org with none yet) made now.
    async fn ensure_org_key(&self, token: &str, org: &Value) -> Result<bool, String> {
        let (Some(id), Some(key_id)) = (org["id"].as_str(), org["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()))
        else {
            return Ok(false);
        };
        if self.has_org_key(id, key_id) {
            return Ok(true);
        }
        self.org_unlocked(token).await?;
        if key_id == 0 {
            if !matches!(org["role"].as_str(), Some("owner" | "admin")) {
                return Ok(false);
            }
            self.need_plan()?;
            let name = org["name"].as_str().unwrap_or("").to_string();
            self.create_org_key(token, id, &name, 0).await?;
            return Ok(true);
        }
        self.collect_org_keys(token, std::slice::from_ref(org)).await;
        Ok(self.has_org_key(id, key_id))
    }

    /// Move the org to a new key (a member was removed, or a device revoked):
    /// the next keyring, then this computer's descriptor under it. Other
    /// devices of the account pick the key up from the account's store.
    pub(crate) async fn rotate_org_key(&self, token: &str, org_id: &str) -> Result<(), String> {
        self.org_unlocked(token).await?;
        let org = self.api.get(token, &format!("/v1/orgs/{org_id}")).await.map_err(org_error)?;
        if !matches!(org["role"].as_str(), Some("owner" | "admin")) {
            return Ok(());
        }
        let current = org["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()).unwrap_or(0);
        let name = org["name"].as_str().unwrap_or("").to_string();
        // Only a device that holds the current key rotates it.
        self.collect_org_keys(token, std::slice::from_ref(&org)).await;
        if current == 0 || !self.has_org_key(org_id, current) {
            return Ok(());
        }
        self.need_plan()?;
        self.create_org_key(token, org_id, &name, current).await?;
        if lock(&self.state).sharing.contains(org_id) {
            let _ = self.share_org(token, org_id, true).await;
        }
        Ok(())
    }

    /// After a device was revoked: a new key for every org this account's
    /// owner/admin role lets it rotate. Errors are returned for the log, not fatal.
    pub(crate) async fn rotate_org_keys(&self, token: &str) -> Vec<String> {
        let mut errors = Vec::new();
        let Ok(list) = self.api.get(token, "/v1/orgs").await else { return errors };
        let ids: Vec<String> = list["orgs"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|o| matches!(o["role"].as_str(), Some("owner" | "admin")))
                    .filter_map(|o| o["id"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            if let Err(err) = self.rotate_org_key(token, &id).await {
                errors.push(err);
            }
        }
        errors
    }

    /// Fetch the org keys this device lacks before a rotation (so none is lost).
    pub(crate) async fn collect_all_org_keys(&self, token: &str) {
        if let Ok(list) = self.api.get(token, "/v1/orgs").await
            && let Some(orgs) = list["orgs"].as_array()
        {
            self.collect_org_keys(token, orgs).await;
        }
    }

    // ------------------------------------------------------------------ orgs

    fn with_local(&self, mut org: Value) -> Value {
        let id = org["id"].as_str().unwrap_or("").to_string();
        let key_id = org["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()).unwrap_or(0);
        org["hasKey"] = json!(self.has_org_key(&id, key_id));
        org["sharing"] = json!(lock(&self.state).sharing.contains(&id));
        org
    }

    async fn org_list(&self) -> Result<Value, String> {
        let token = self.token()?;
        let res = self.api.get(&token, "/v1/orgs").await.map_err(org_error)?;
        let orgs = res["orgs"].as_array().cloned().unwrap_or_default();
        // An org this account is no longer in: its key and sharing go.
        let present: Vec<&str> = orgs.iter().filter_map(|o| o["id"].as_str()).collect();
        let gone: Vec<String> = {
            let s = lock(&self.state);
            s.org_keys.keys().chain(s.sharing.iter()).filter(|id| !present.contains(&id.as_str())).cloned().collect()
        };
        for id in gone {
            let _ = self.set_sharing_off(&id, Some(&token)).await;
            self.forget_org(&id);
        }
        // Quietly pick up keys other devices of this account made. Locked or
        // offline is not an error here: the list still shows.
        if self.org_unlocked(&token).await.is_ok() {
            self.collect_org_keys(&token, &orgs).await;
            let _ = self.reseal_org_keys(&token).await;
        }
        lock(&self.live).orgs = Some(orgs.clone());
        Ok(json!({
            "orgs": orgs.into_iter().map(|o| self.with_local(o)).collect::<Vec<_>>(),
            "invites": res["invites"].clone(),
        }))
    }

    async fn org_get(&self, org_id: &str) -> Result<Value, String> {
        let token = self.token()?;
        let org = self.api.get(&token, &format!("/v1/orgs/{org_id}")).await.map_err(org_error)?;
        // Make or fetch the key when this device can; the org still shows without it.
        let _ = self.ensure_org_key(&token, &org).await;
        let org = if org["keyId"] == json!(0) && self.has_org_key(org_id, 1) {
            self.api.get(&token, &format!("/v1/orgs/{org_id}")).await.map_err(org_error)?
        } else {
            org
        };
        Ok(self.with_local(org))
    }

    async fn org_create(&self, name: &str) -> Result<Value, String> {
        let token = self.token()?;
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("Enter a name of up to 80 characters.".into());
        }
        self.need_plan()?;
        // Unlocked first: an org with no key can't list computers.
        self.org_unlocked(&token).await?;
        let org = self
            .api
            .send(&token, reqwest::Method::POST, "/v1/orgs", Some(json!({ "name": name })))
            .await
            .map_err(org_error)?;
        let id = org["id"].as_str().unwrap_or("").to_string();
        if !valid_org_id(&id) {
            return Err("Nekko Cloud sent an organization that doesn't check out.".into());
        }
        let shown = org["name"].as_str().unwrap_or(name).to_string();
        if let Err(err) = self.create_org_key(&token, &id, &shown, 0).await {
            self.changed();
            return Err(format!("Created {shown}, but couldn't set up its key: {err} Open it to try again."));
        }
        let mut org = org;
        org["keyId"] = json!(1);
        lock(&self.live).orgs = None;
        let out = self.with_local(org);
        self.changed();
        Ok(out)
    }

    async fn org_remove_member(&self, org_id: &str, user_id: &str) -> Result<Value, String> {
        let token = self.token()?;
        if !valid_uuid(user_id) {
            return Err("That member wasn't found.".into());
        }
        let me = self.account_id().unwrap_or_default();
        let res = self
            .api
            .send(&token, reqwest::Method::DELETE, &format!("/v1/orgs/{org_id}/members/{user_id}"), None)
            .await
            .map_err(org_error)?;
        if user_id == me {
            // Left: nothing of this org stays here.
            self.forget_org(org_id);
            let out = self.org_list().await?;
            self.changed();
            return Ok(out);
        }
        let mut rotate_error = None;
        if res["rotateKey"].as_bool() == Some(true)
            && let Err(err) = self.rotate_org_key(&token, org_id).await
        {
            rotate_error = Some(err);
        }
        let mut out = self.org_get(org_id).await?;
        if let Some(err) = rotate_error {
            out["keyError"] = json!(err);
        }
        self.changed();
        Ok(out)
    }

    // --------------------------------------------------------------- sharing

    async fn host_facts(&self) -> Result<HostFacts, String> {
        let device_id = lock(&self.state).device_id.clone().ok_or(LOCKED)?;
        let account_id = self.account_id()?;
        let key = self.device_key().ok_or(LOCKED)?;
        let host = lock(&self.host).clone();
        let (name, models, app_version) = match host {
            Some(h) => ((h.name)(), (h.models)().await, h.app_version.clone()),
            None => (lock(&self.state).device_label.clone(), Vec::new(), env!("CARGO_PKG_VERSION").to_string()),
        };
        Ok(HostFacts {
            device_id,
            account_id,
            name,
            os: this_os().into(),
            arch: std::env::consts::ARCH.into(),
            app_version,
            models,
            host_key: b64_encode(&key.public()),
        })
    }

    /// Record how sharing with an org is going. Publishes a status event only
    /// when the state or the error changed (a heartbeat alone is silent).
    fn set_share(&self, org_id: &str, state: &'static str, error: Option<String>, heartbeat: bool) {
        let changed = {
            let mut live = lock(&self.live);
            let entry = live.shares.entry(org_id.to_string()).or_default();
            let changed = entry.state != state || entry.error != error;
            entry.state = state;
            entry.error = error;
            if heartbeat {
                entry.last_heartbeat = Some(nekko_js::now_ms_f64());
            }
            changed
        };
        if changed {
            self.changed();
        }
    }

    /// Publish this computer to an org now (or just renew the lease when
    /// nothing changed). `force` publishes even if nothing changed.
    pub(crate) async fn share_org(&self, token: &str, org_id: &str, force: bool) -> Result<(), String> {
        let _one = self.share.lock().await;
        if !lock(&self.state).sharing.contains(org_id) {
            return Ok(());
        }
        let result = self.share_inner(token, org_id, force).await;
        // Sharing may have been turned off while this ran.
        if !lock(&self.state).sharing.contains(org_id) {
            return result;
        }
        match &result {
            Ok(()) => self.set_share(org_id, "online", None, true),
            Err(err) => self.set_share(org_id, "error", Some(err.clone()), false),
        }
        result
    }

    async fn share_inner(&self, token: &str, org_id: &str, force: bool) -> Result<(), String> {
        self.org_unlocked(token).await?;
        let facts = self.host_facts().await?;
        let digest = facts.digest();
        let epoch = self.key_id();
        for attempt in 0..5 {
            let Some((key_id, ring)) = self.held_org_key(org_id) else { return Err(NO_KEY.into()) };
            let share = lock(&self.state).fleet.get(org_id).cloned().unwrap_or_default();
            if attempt == 0 && !force && share.revision > 0 && share.digest == digest && share.key_id == key_id {
                let beat = self
                    .api
                    .send(token, reqwest::Method::POST, &format!("/v1/orgs/{org_id}/fleet/self/heartbeat"), None)
                    .await;
                match beat {
                    Ok(_) => return Ok(()),
                    // Not published (withdrawn, another sign-in, or the org key moved): publish.
                    Err(err) if err.status == 409 => {}
                    Err(err) if err.status == 404 => return Err(self.left(org_id)),
                    Err(err) => return Err(org_error(err)),
                }
            }
            self.set_share(org_id, "publishing", None, false);
            let revision = share.revision + 1;
            let plain = facts.plaintext(&now_rfc3339());
            let blob = seal_descriptor(&ring, org_id, key_id, &facts.device_id, revision, &plain)
                .map_err(|err| err.to_string())?;
            let body = json!({ "orgKeyId": key_id, "revision": revision, "descriptor": blob });
            let put =
                self.api.send(token, reqwest::Method::PUT, &format!("/v1/orgs/{org_id}/fleet/self"), Some(body)).await;
            match put {
                Ok(_) => {
                    let digest = digest.clone();
                    self.edit(|s| {
                        s.fleet.insert(org_id.to_string(), Share { revision, key_id, digest });
                    })?;
                    return Ok(());
                }
                Err(err) if err.status == 409 && err.code == "revision" => {
                    // Another sign-in, or a withdrawal, moved the revision: continue from the API's.
                    let cur = err.body["currentRevision"].as_u64().ok_or_else(|| err.message.clone())?;
                    self.edit(|s| {
                        s.fleet.entry(org_id.to_string()).or_default().revision = cur;
                    })?;
                }
                Err(err) if err.status == 409 && err.code == "org-key-epoch" => {
                    // The org moved to a newer key: take it from the account's store. A stale payload is never reused.
                    let cur = err.body["currentKeyId"].as_u64().and_then(|k| u32::try_from(k).ok()).unwrap_or(0);
                    match self.fetch_org_key(token, org_id, cur).await? {
                        Some(rec) if cur >= 1 => self.store_org_key(org_id, &rec.name, cur, epoch, &rec.keyring)?,
                        _ => return Err(NO_KEY.into()),
                    }
                }
                Err(err) if err.status == 404 => return Err(self.left(org_id)),
                Err(err) => return Err(org_error(err)),
            }
        }
        Err("Couldn't publish this computer yet. It will try again.".into())
    }

    /// This account is no longer in the org.
    fn left(&self, org_id: &str) -> String {
        self.forget_org(org_id);
        "This account is no longer in that organization.".into()
    }

    /// Withdraw this computer from an org's list (best effort) and stop sharing.
    /// `token` None only stops locally.
    pub(crate) async fn set_sharing_off(&self, org_id: &str, token: Option<&str>) -> Result<(), String> {
        let _one = self.share.lock().await;
        let was = lock(&self.state).sharing.contains(org_id);
        self.edit(|s| {
            s.sharing.remove(org_id);
            if let Some(f) = s.fleet.get_mut(org_id) {
                f.digest.clear();
            }
        })?;
        if let Some(token) = token.filter(|_| was) {
            let _ = tokio::time::timeout(
                Duration::from_secs(8),
                self.api.send(token, reqwest::Method::DELETE, &format!("/v1/orgs/{org_id}/fleet/self"), None),
            )
            .await;
        }
        self.set_share(org_id, "off", None, false);
        Ok(())
    }

    /// Stop sharing with every org, withdrawing from each (sign-out, account switch).
    pub(crate) async fn withdraw_all(&self, token: Option<&str>) {
        let orgs: Vec<String> = lock(&self.state).sharing.iter().cloned().collect();
        for org in orgs {
            let _ = self.set_sharing_off(&org, token).await;
        }
    }

    /// Forget sharing without the network, and withdraw in the background when
    /// there is a runtime and a token to do it with.
    pub(crate) fn withdraw_in_background(&self, token: Option<String>) {
        let orgs: Vec<String> = lock(&self.state).sharing.iter().cloned().collect();
        let (Some(token), Ok(handle)) = (token, tokio::runtime::Handle::try_current()) else { return };
        let api = self.api.clone();
        handle.spawn(async move {
            for org in orgs {
                let _ = tokio::time::timeout(
                    Duration::from_secs(8),
                    api.send(&token, reqwest::Method::DELETE, &format!("/v1/orgs/{org}/fleet/self"), None),
                )
                .await;
            }
        });
    }

    async fn set_sharing(&self, org_id: &str, on: bool) -> Result<Value, String> {
        if !on {
            let token = self.token().ok();
            self.set_sharing_off(org_id, token.as_deref()).await?;
            self.changed();
            return Ok(json!({ "orgId": org_id, "sharing": false, "state": "off" }));
        }
        let token = self.token()?;
        self.need_plan()?;
        self.org_unlocked(&token).await?;
        let org = self.api.get(&token, &format!("/v1/orgs/{org_id}")).await.map_err(org_error)?;
        if !self.ensure_org_key(&token, &org).await? {
            return Err(NO_KEY.into());
        }
        self.edit(|s| {
            s.sharing.insert(org_id.to_string());
        })?;
        self.set_share(org_id, "publishing", None, false);
        let outcome = self.share_org(&token, org_id, true).await;
        self.changed();
        let live = lock(&self.live).shares.get(org_id).cloned().unwrap_or_default();
        let mut out = json!({ "orgId": org_id, "sharing": true, "state": if live.state.is_empty() { "publishing" } else { live.state } });
        if let Err(err) = outcome {
            out["error"] = json!(err);
        }
        Ok(out)
    }

    /// One beat for every org this computer shares with: renew the lease, or
    /// publish again if the name or models changed or the API asks for it.
    pub async fn share_tick(&self) {
        let orgs: Vec<String> = lock(&self.state).sharing.iter().cloned().collect();
        if orgs.is_empty() {
            return;
        }
        let Ok(token) = self.token() else {
            for org in orgs {
                self.set_share(&org, "error", Some(NOT_SIGNED_IN.into()), false);
            }
            return;
        };
        for org in orgs {
            let _ = self.share_org(&token, &org, false).await;
        }
    }

    fn fleet_status(&self) -> Value {
        let sharing_set = lock(&self.state).sharing.clone();
        let live = lock(&self.live);
        let mut ids: Vec<String> = sharing_set.iter().cloned().collect();
        for id in live.orgs.iter().flatten().filter_map(|o| o["id"].as_str()) {
            if !ids.iter().any(|i| i == id) {
                ids.push(id.to_string());
            }
        }
        let rows: Vec<Value> = ids
            .into_iter()
            .map(|id| {
                let l = live.shares.get(&id).cloned().unwrap_or_default();
                let sharing = sharing_set.contains(&id);
                let state = if !sharing {
                    "off"
                } else if l.state.is_empty() {
                    "publishing"
                } else {
                    l.state
                };
                let mut row = json!({ "orgId": id, "state": state, "lastHeartbeat": l.last_heartbeat });
                if let Some(err) = l.error.filter(|_| sharing) {
                    row["error"] = json!(err);
                }
                row
            })
            .collect();
        json!({ "sharing": rows })
    }

    // ----------------------------------------------------------------- fleet

    async fn fleet_list(&self, org_id: &str) -> Result<Value, String> {
        let token = self.token()?;
        let soft = |key_id: u32, has_key: bool, rejected: usize, error: String| json!({ "orgId": org_id, "orgKeyId": key_id, "hasKey": has_key, "computers": [], "rejected": rejected, "error": error });
        if let Err(err) = self.org_unlocked(&token).await {
            return Ok(soft(0, false, 0, err));
        }
        let res = match self.api.get(&token, &format!("/v1/orgs/{org_id}/fleet")).await {
            Ok(v) => v,
            Err(err) => {
                let held = self.held_org_key(org_id).map_or(0, |(k, _)| k);
                return Ok(soft(held, held >= 1, 0, org_error(err)));
            }
        };
        let org_key_id = res["orgKeyId"].as_u64().and_then(|k| u32::try_from(k).ok()).unwrap_or(0);
        let rows = res["computers"].as_array().cloned().unwrap_or_default();
        if org_key_id >= 1 && !self.has_org_key(org_id, org_key_id) {
            self.collect_org_keys(&token, &[json!({ "id": org_id, "keyId": org_key_id })]).await;
        }
        let ring = self.held_org_key(org_id).filter(|(k, _)| *k == org_key_id && org_key_id >= 1).map(|(_, r)| r);
        let Some(ring) = ring else {
            return Ok(soft(org_key_id, false, rows.len(), NO_KEY.into()));
        };
        // Who published a computer, for the people other than you (best effort).
        let emails: BTreeMap<String, String> = self
            .api
            .get(&token, &format!("/v1/orgs/{org_id}"))
            .await
            .ok()
            .and_then(|o| o["members"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| Some((m["userId"].as_str()?.to_string(), m["email"].as_str()?.to_string())))
            .collect();
        let me = self.account_id().unwrap_or_default();
        let trusted = self.account_record();
        let mut computers = Vec::new();
        let mut rejected = 0;
        for row in &rows {
            let seen_key = format!("{org_id}/{}", row["deviceId"].as_str().unwrap_or(""));
            let seen = lock(&self.state).fleet_seen.get(&seen_key).copied().unwrap_or(0);
            let Some(open) = open_row(&ring, org_id, org_key_id, row, seen, &me, trusted.as_ref()) else {
                rejected += 1;
                continue;
            };
            let _ = self.edit(|s| {
                let e = s.fleet_seen.entry(seen_key).or_insert(0);
                *e = (*e).max(open.revision);
            });
            let d = &open.desc;
            let mut c = json!({
                "deviceId": d.device_id,
                "name": d.name,
                "os": d.os,
                "arch": d.arch,
                "appVersion": d.app_version,
                "models": d.models.iter().map(|m| {
                    let mut o = json!({ "id": m.id, "label": m.label, "runtime": m.runtime });
                    if let Some(s) = m.size_bytes {
                        o["sizeBytes"] = json!(s);
                    }
                    o
                }).collect::<Vec<_>>(),
                "online": row["online"].as_bool().unwrap_or(false),
                "seenAt": row["seenAt"],
                "you": row["you"].as_bool().unwrap_or(false),
                "verified": open.verified,
            });
            if d.account_id != me
                && let Some(email) = emails.get(&d.account_id)
            {
                c["ownerEmail"] = json!(email);
            }
            computers.push(c);
        }
        Ok(
            json!({ "orgId": org_id, "orgKeyId": org_key_id, "hasKey": true, "computers": computers, "rejected": rejected }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::TrustedDevice;

    const ORG: &str = "0b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b";
    const DEV: &str = "7e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b";
    const ME: &str = "a1111111-2b3d-4e5f-8a6b-9c0d1e2f3a4b";
    const HOST: &str = "HOSTKEY";

    fn facts(account: &str) -> HostFacts {
        HostFacts {
            device_id: DEV.into(),
            account_id: account.into(),
            name: "Desk".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            app_version: "0.9.8".into(),
            models: vec![LocalModel {
                id: "m".into(),
                label: "M".into(),
                runtime: "llamacpp".into(),
                size_bytes: Some(7),
            }],
            host_key: HOST.into(),
        }
    }

    fn row(ring: &Keyring, key_id: u32, revision: u64, user: &str, f: &HostFacts) -> Value {
        let blob = seal_descriptor(ring, ORG, key_id, DEV, revision, &f.plaintext("2026-11-11T10:00:00Z")).unwrap();
        json!({ "deviceId": DEV, "userId": user, "orgKeyId": key_id, "revision": revision, "descriptor": blob,
                "seenAt": "2026-11-11T10:00:00Z", "online": true, "you": false })
    }

    fn record(host: &str) -> AccountRecord {
        AccountRecord {
            epoch: 1,
            recovery_public: "rp".into(),
            devices: vec![TrustedDevice { id: DEV.into(), public_key: host.into(), label: "Desk".into() }],
        }
    }

    #[test]
    fn an_own_account_computer_is_verified_only_against_the_account_record() {
        let ring = Keyring::generate();
        let r = row(&ring, 1, 3, ME, &facts(ME));
        let ok = open_row(&ring, ORG, 1, &r, 0, ME, Some(&record(HOST))).unwrap();
        assert!(ok.verified);
        assert_eq!((ok.revision, ok.desc.name.as_str()), (3, "Desk"));
        // A different host key in the account record, or no record, is shown but not verified.
        assert!(!open_row(&ring, ORG, 1, &r, 0, ME, Some(&record("OTHER"))).unwrap().verified);
        assert!(!open_row(&ring, ORG, 1, &r, 0, ME, None).unwrap().verified);
        // Another member's computer is never verified, even if the host key looks listed.
        let theirs = "b2222222-2b3d-4e5f-8a6b-9c0d1e2f3a4b";
        let r = row(&ring, 1, 3, theirs, &facts(theirs));
        assert!(!open_row(&ring, ORG, 1, &r, 0, ME, Some(&record(HOST))).unwrap().verified);
    }

    #[test]
    fn rows_that_were_tampered_replayed_or_moved_are_dropped() {
        let ring = Keyring::generate();
        let good = row(&ring, 1, 3, ME, &facts(ME));
        let open = |r: &Value, seen: u64| open_row(&ring, ORG, 1, r, seen, ME, None);
        assert!(open(&good, 3).is_some(), "the same revision again is fine");
        // Rollback: the API shows a revision below one already seen.
        assert!(open(&good, 4).is_none());
        // Relabelled revision, device, epoch or org: the AD no longer matches.
        for (k, v) in [
            ("revision", json!(4)),
            ("deviceId", json!("8e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b")),
            ("orgKeyId", json!(2)),
        ] {
            let mut r = good.clone();
            r[k] = v;
            assert!(open(&r, 0).is_none(), "{k}");
        }
        assert!(open_row(&ring, "1b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b", 1, &good, 0, ME, None).is_none(), "wrong org");
        assert!(open_row(&ring, ORG, 2, &good, 0, ME, None).is_none(), "wrong epoch");
        assert!(open_row(&Keyring::generate(), ORG, 1, &good, 0, ME, None).is_none(), "wrong key");
        // A flipped byte in the blob.
        let mut r = good.clone();
        let mut raw = nekko_sync::b64_decode(r["descriptor"].as_str().unwrap()).unwrap();
        raw[60] ^= 1;
        r["descriptor"] = json!(b64_encode(&raw));
        assert!(open(&r, 0).is_none());
        // Missing pieces.
        for k in ["deviceId", "userId", "revision", "descriptor", "orgKeyId"] {
            let mut r = good.clone();
            r.as_object_mut().unwrap().remove(k);
            assert!(open(&r, 0).is_none(), "no {k}");
        }
    }

    #[test]
    fn a_descriptor_that_lies_about_whose_it_is_is_dropped() {
        let ring = Keyring::generate();
        // The row says it is mine; the descriptor, sealed with the org key, names another account.
        let r = row(&ring, 1, 1, ME, &facts("b2222222-2b3d-4e5f-8a6b-9c0d1e2f3a4b"));
        assert!(open_row(&ring, ORG, 1, &r, 0, ME, None).is_none());
        // The descriptor names another device than its row.
        let mut f = facts(ME);
        f.device_id = "8e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b".into();
        let r = row(&ring, 1, 1, ME, &f);
        assert!(open_row(&ring, ORG, 1, &r, 0, ME, None).is_none());
    }

    #[test]
    fn org_errors_read_in_plain_words() {
        let err = |status: u16, code: &str| HttpError {
            status,
            code: code.into(),
            message: code.into(),
            body: Box::new(Value::Null),
        };
        assert_eq!(org_error(err(402, "plan-required")), NEEDS_PLAN);
        assert_eq!(org_error(err(403, "needs-synced-device")), LOCKED);
        assert!(org_error(err(403, "orgs-not-available")).contains("aren't available"));
        assert_eq!(org_error(err(500, "boom")), "boom");
    }
}
