//! Nekko Cloud for the engine daemon (`cloud:*`, `sync:*`).
//!
//! **Sign-in.** Supabase Auth proves who the user is (an emailed code, or
//! GitHub, Google or Apple in the browser with PKCE and a loopback redirect).
//! The Supabase access token is traded once for this device's Nekko Cloud
//! token and dropped; the token goes in the [`vault`].
//!
//! **Sync (Pro and Team).** Every chat is sealed on this device with
//! `nekko-sync` and only ciphertext is uploaded; see `docs/SYNC-ENCRYPTION.md`.
//! Turning sync on for an account's first device makes the keyring and the
//! recovery key (shown once). Another device joins either with the recovery
//! key or by being approved on a device that already syncs, after comparing
//! the fingerprints both show. Revoking a device starts a new key epoch,
//! wrapped only to the devices in the sealed account record.
//!
//! Merging is per chat, newest `updatedAt` wins; a chat a turn is running in
//! is never overwritten (its local copy is newer by the time it saves).

mod http;
pub mod records;
pub mod state;
pub mod vault;

use http::{Api, HttpError, Supabase};
use nekko_store::SessionStore;
use nekko_sync::{
    DeviceKey, Keyring, RecoveryKey, b64_decode, b64_encode, fingerprint, object_id, open_record, open_recovery,
    seal_record, seal_recovery, unwrap_keyring, wrap_keyring,
};
use records::{AccountRecord, ChatRecord, Skip, TrustedDevice};
use serde_json::{Value, json};
use state::{Account, State, Synced};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use vault::Vault;
use zeroize::Zeroize;

pub use http::client;

pub const CHANNELS: &[&str] = &[
    "cloud:status",
    "cloud:refresh",
    "cloud:sendCode",
    "cloud:verifyCode",
    "cloud:beginOAuth",
    "cloud:cancelOAuth",
    "cloud:signOut",
    "sync:turnOn",
    "sync:confirmRecoveryKey",
    "sync:restore",
    "sync:requestJoin",
    "sync:approve",
    "sync:revoke",
    "sync:now",
    "sync:setEnabled",
    "sync:setIncludeLocalOnly",
    "sync:deleteAll",
];

/// Pushed whenever the status changes (the animation follows `sync.phase` and `sync.progress`).
pub const EVENT: &str = "cloud:status";

/// The OAuth providers offered next to the emailed code.
pub const OAUTH_PROVIDERS: &[&str] = &["github", "google", "apple"];

const PUSH_BATCH: usize = 50;
const PULL_PAGE: u32 = 200;
const OAUTH_TTL: Duration = Duration::from_secs(10 * 60);

pub struct Options {
    /// `<data>/cloud`.
    pub dir: PathBuf,
    pub api_url: String,
    /// This device's name for the session list and the trusted devices ("MacBook Pro").
    pub device_label: String,
    pub sessions: Arc<SessionStore>,
    pub vault: Box<dyn Vault>,
    pub publish: Arc<dyn Fn(Value) + Send + Sync>,
    /// A turn is running in this chat: never overwrite it from the cloud.
    pub busy: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

#[derive(Default)]
struct Live {
    syncing: bool,
    progress: Option<(usize, usize)>,
    /// The last `/v1/sync/state`.
    remote: Option<Value>,
    oauth: Option<tokio::sync::oneshot::Sender<()>>,
    /// Counts from the last pass, for the status line.
    skipped: BTreeMap<&'static str, usize>,
    pushed: usize,
    pulled: usize,
}

pub struct Cloud {
    dir: PathBuf,
    api: Api,
    sessions: Arc<SessionStore>,
    vault: Box<dyn Vault>,
    publish: Arc<dyn Fn(Value) + Send + Sync>,
    busy: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    state: Mutex<State>,
    live: Mutex<Live>,
    supabase: tokio::sync::Mutex<Option<Supabase>>,
    run: tokio::sync::Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn arg(args: &[Value], i: usize) -> String {
    args.get(i).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn e(err: HttpError) -> String {
    err.message
}

impl Cloud {
    pub fn new(o: Options) -> Arc<Cloud> {
        let mut state = State::load(&o.dir);
        state.device_label = o.device_label.clone();
        let http = http::client();
        Arc::new(Cloud {
            api: Api { base: o.api_url, http },
            dir: o.dir,
            sessions: o.sessions,
            vault: o.vault,
            publish: o.publish,
            busy: o.busy,
            state: Mutex::new(state),
            live: Mutex::new(Live::default()),
            supabase: tokio::sync::Mutex::new(None),
            run: tokio::sync::Mutex::new(()),
        })
    }

    /// Sync in the background every `every` while it is on.
    pub fn start(self: &Arc<Self>, every: Duration) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                if me.ready() {
                    let _ = me.sync_once().await;
                }
                tokio::time::sleep(every).await;
            }
        });
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        match channel {
            "cloud:status" => Ok(self.status()),
            "cloud:refresh" => {
                self.refresh().await?;
                Ok(self.status())
            }
            "cloud:sendCode" => self.send_code(&arg(args, 0)).await,
            "cloud:verifyCode" => self.verify_code(&arg(args, 0), &arg(args, 1)).await,
            "cloud:beginOAuth" => self.begin_oauth(&arg(args, 0)).await,
            "cloud:cancelOAuth" => {
                if let Some(stop) = lock(&self.live).oauth.take() {
                    let _ = stop.send(());
                }
                Ok(self.changed())
            }
            "cloud:signOut" => self.sign_out().await,
            "sync:turnOn" => self.turn_on().await,
            "sync:confirmRecoveryKey" => self.confirm_recovery_key(&arg(args, 0)),
            "sync:restore" => self.restore(&arg(args, 0)).await,
            "sync:requestJoin" => self.request_join().await,
            "sync:approve" => self.approve(&arg(args, 0)).await,
            "sync:revoke" => self.revoke(&arg(args, 0)).await,
            "sync:now" => {
                self.sync_once().await?;
                Ok(self.status())
            }
            "sync:setEnabled" => {
                let on = args.first().and_then(Value::as_bool).unwrap_or(false);
                if on && self.keyring(self.key_id()).is_none() {
                    return self.turn_on().await;
                }
                self.edit(|s| s.enabled = on)?;
                if on {
                    self.kick();
                }
                Ok(self.changed())
            }
            "sync:setIncludeLocalOnly" => {
                let on = args.first().and_then(Value::as_bool).unwrap_or(false);
                self.edit(|s| s.include_local_only = on)?;
                self.kick();
                Ok(self.changed())
            }
            "sync:deleteAll" => self.delete_all().await,
            _ => Err(format!("unknown channel {channel}")),
        }
    }

    // ------------------------------------------------------------------ state

    fn edit(&self, f: impl FnOnce(&mut State)) -> Result<(), String> {
        let mut s = lock(&self.state);
        f(&mut s);
        s.save(&self.dir)
    }

    fn token(&self) -> Result<String, String> {
        self.vault.get("token").ok_or_else(|| "Sign in to Nekko Cloud first.".to_string())
    }

    fn key_id(&self) -> u32 {
        lock(&self.state).key_id.unwrap_or(0)
    }

    fn account(&self) -> Option<Account> {
        lock(&self.state).account.clone()
    }

    fn account_id(&self) -> Result<String, String> {
        self.account().map(|a| a.id).ok_or_else(|| "Sign in to Nekko Cloud first.".to_string())
    }

    fn keyring(&self, key_id: u32) -> Option<Keyring> {
        let mut raw = b64_decode(&self.vault.get(&format!("keyring:{key_id}"))?).ok()?;
        let k = Keyring::from_bytes(&raw).ok();
        raw.zeroize();
        k
    }

    fn store_keyring(&self, key_id: u32, k: &Keyring) -> Result<(), String> {
        let mut raw = k.to_bytes();
        let out = self.vault.set(&format!("keyring:{key_id}"), &b64_encode(&raw));
        raw.zeroize();
        out
    }

    fn device_key(&self) -> Option<DeviceKey> {
        let mut raw = b64_decode(&self.vault.get("device-key")?).ok()?;
        let k = DeviceKey::from_bytes(&raw).ok();
        raw.zeroize();
        k
    }

    fn account_record(&self) -> Option<AccountRecord> {
        lock(&self.state).account_record.as_deref().and_then(|t| AccountRecord::parse(t.as_bytes()))
    }

    fn ready(&self) -> bool {
        let s = lock(&self.state);
        s.enabled && s.account.as_ref().is_some_and(|a| a.can_sync) && self.vault.get("token").is_some()
    }

    fn kick(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let _ = me.sync_once().await;
        });
    }

    fn changed(&self) -> Value {
        let s = self.status();
        (self.publish)(s.clone());
        s
    }

    /// What Settings shows. Local only, no network.
    pub fn status(&self) -> Value {
        let s = lock(&self.state).clone();
        let live = lock(&self.live);
        let signed_in = s.account.is_some() && self.vault.get("token").is_some();
        let has_keys = s.key_id.is_some_and(|k| self.keyring(k).is_some());
        let remote_key = live.remote.as_ref().and_then(|r| r.get("currentKeyId")).and_then(Value::as_u64);
        let my_device = s.device_id.clone();
        let phase = if !signed_in {
            "signed-out"
        } else if !s.account.as_ref().is_some_and(|a| a.can_sync) {
            "needs-plan"
        } else if live.syncing {
            "syncing"
        } else if has_keys && s.enabled {
            if s.last_error.is_some() { "error" } else { "idle" }
        } else if has_keys {
            "paused"
        } else if s.enabled && my_device.is_some() {
            "awaiting-approval"
        } else if remote_key.is_some() {
            "needs-join"
        } else {
            "off"
        };
        let trusted = self.account_record().map(|a| a.devices).unwrap_or_default();
        let devices: Vec<Value> = live
            .remote
            .as_ref()
            .and_then(|r| r.get("devices"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|d| {
                        let id = d.get("id").and_then(Value::as_str).unwrap_or("");
                        let pk = d.get("publicKey").and_then(Value::as_str).and_then(|p| b64_decode(p).ok());
                        json!({
                            "id": id,
                            "label": d.get("label"),
                            "fingerprint": pk.map(|p| fingerprint(&p)),
                            "createdAt": d.get("createdAt"),
                            "revoked": d.get("revokedAt").is_some_and(|v| !v.is_null()),
                            "trusted": trusted.iter().any(|t| t.id == id),
                            "thisDevice": my_device.as_deref() == Some(id),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let my_fingerprint = self.device_key().map(|k| fingerprint(&k.public()));
        json!({
            "signedIn": signed_in,
            "account": s.account.as_ref().map(|a| json!({ "email": a.email, "plan": a.plan, "canSync": a.can_sync })),
            "oauthPending": live.oauth.is_some(),
            "keysStoredIn": self.vault.kind(),
            "sync": {
                "phase": phase,
                "enabled": s.enabled,
                "includeLocalOnly": s.include_local_only,
                "recoveryConfirmed": s.recovery_confirmed,
                "keyEpoch": s.key_id,
                "lastSyncAt": s.last_sync_at,
                "error": s.last_error,
                "progress": live.progress.map(|(done, total)| json!({ "done": done, "total": total })),
                "chats": s.chats.values().filter(|c| !c.deleted).count(),
                "pushed": live.pushed,
                "pulled": live.pulled,
                "skipped": live.skipped,
                "fingerprint": my_fingerprint,
                "devices": devices,
                "usage": live.remote.as_ref().and_then(|r| r.get("usage")).cloned(),
            },
        })
    }

    /// Fetch the account and the sync state from Nekko Cloud.
    async fn refresh(&self) -> Result<(), String> {
        let token = self.token()?;
        let me = self.api.get(&token, "/v1/auth/me").await.map_err(e)?;
        let a = &me["account"];
        let account = Account {
            id: a["id"].as_str().unwrap_or("").into(),
            email: a["email"].as_str().unwrap_or("").into(),
            plan: a["plan"].as_str().unwrap_or("free").into(),
            can_sync: a["canSync"].as_bool().unwrap_or(false),
        };
        self.edit(|s| s.account = Some(account))?;
        let remote = self.api.get(&token, "/v1/sync/state").await.map_err(e)?;
        lock(&self.live).remote = Some(remote);
        Ok(())
    }

    // ---------------------------------------------------------------- sign-in

    async fn supabase(&self) -> Result<Supabase, String> {
        let mut cached = self.supabase.lock().await;
        if let Some(s) = cached.as_ref() {
            return Ok(s.clone());
        }
        let cfg = self.api.config().await.map_err(|err| {
            if err.code == "sign-in-not-configured" {
                "Nekko Cloud sign-in isn't switched on yet.".to_string()
            } else {
                err.message
            }
        })?;
        let s = Supabase {
            url: cfg["supabaseUrl"].as_str().unwrap_or("").to_string(),
            anon_key: cfg["supabaseAnonKey"].as_str().unwrap_or("").to_string(),
            http: self.api.http.clone(),
        };
        if s.url.is_empty() || s.anon_key.is_empty() {
            return Err("Nekko Cloud sent no sign-in settings.".into());
        }
        *cached = Some(s.clone());
        Ok(s)
    }

    async fn send_code(&self, email: &str) -> Result<Value, String> {
        if !email.contains('@') || email.len() > 320 {
            return Err("Enter your email address.".into());
        }
        self.supabase().await?.send_code(email).await.map_err(e)?;
        Ok(json!({ "sent": true }))
    }

    async fn verify_code(self: &Arc<Self>, email: &str, code: &str) -> Result<Value, String> {
        let code: String = code.chars().filter(char::is_ascii_digit).collect();
        if code.len() < 6 {
            return Err("Enter the code from the email.".into());
        }
        let access = self.supabase().await?.verify_code(email, &code).await.map_err(e)?;
        self.finish_sign_in(&access).await
    }

    async fn begin_oauth(self: &Arc<Self>, provider: &str) -> Result<Value, String> {
        if !OAUTH_PROVIDERS.contains(&provider) {
            return Err("That sign-in isn't offered.".into());
        }
        let supabase = self.supabase().await?;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|err| format!("Couldn't open the sign-in callback: {err}"))?;
        let port = listener.local_addr().map_err(|err| err.to_string())?.port();
        let redirect = format!("http://127.0.0.1:{port}/callback");
        let (verifier, challenge) = http::pkce();
        let url = supabase.authorize_url(provider, &redirect, &challenge);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        if let Some(old) = lock(&self.live).oauth.replace(stop_tx) {
            let _ = old.send(());
        }
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        let done_tx = Arc::new(Mutex::new(Some(done_tx)));
        let me = self.clone();
        let app = axum::Router::new().route(
            "/callback",
            axum::routing::get(move |q: axum::extract::Query<BTreeMap<String, String>>| {
                let (me, supabase, verifier, done_tx) = (me.clone(), supabase.clone(), verifier.clone(), done_tx.clone());
                async move {
                    let outcome = match (q.get("code"), q.get("error_description").or(q.get("error"))) {
                        (Some(code), _) => match supabase.exchange(code, &verifier).await {
                            Ok(access) => me.finish_sign_in(&access).await.map(|_| ()),
                            Err(err) => Err(err.message),
                        },
                        (None, Some(why)) => Err(why.clone()),
                        (None, None) => Err("The sign-in came back without a code.".into()),
                    };
                    if let Some(tx) = lock(&done_tx).take() {
                        let _ = tx.send(());
                    }
                    let (title, body) = match &outcome {
                        Ok(()) => ("Signed in", "You're signed in to Nekko Cloud. You can close this tab."),
                        Err(_) => ("Sign-in didn't finish", "Go back to Nekko Agent and try again."),
                    };
                    if let Err(why) = outcome {
                        me.edit(|s| s.last_error = Some(why)).ok();
                        me.changed();
                    }
                    axum::response::Html(format!(
                        "<!doctype html><meta charset=utf-8><title>{title}</title><body style=\"font:15px system-ui;display:grid;place-items:center;height:90vh;color:#333\"><div><h1 style=\"font-size:20px\">{title}</h1><p>{body}</p></div>"
                    ))
                }
            }),
        );
        let me = self.clone();
        tokio::spawn(async move {
            let stop = async move {
                tokio::select! {
                    _ = stop_rx => {},
                    _ = done_rx => {},
                    _ = tokio::time::sleep(OAUTH_TTL) => {},
                }
                // Let the browser receive its page before the listener goes.
                tokio::time::sleep(Duration::from_millis(300)).await;
            };
            let _ = axum::serve(listener, app).with_graceful_shutdown(stop).await;
            lock(&me.live).oauth = None;
            me.changed();
        });
        self.changed();
        Ok(json!({ "authUrl": url }))
    }

    async fn finish_sign_in(self: &Arc<Self>, access_token: &str) -> Result<Value, String> {
        let label = lock(&self.state).device_label.clone();
        let res = self.api.session(access_token, &label).await.map_err(e)?;
        let token = res["token"].as_str().ok_or("Nekko Cloud sent no token.")?.to_string();
        let a = &res["account"];
        let account = Account {
            id: a["id"].as_str().unwrap_or("").into(),
            email: a["email"].as_str().unwrap_or("").into(),
            plan: a["plan"].as_str().unwrap_or("free").into(),
            can_sync: a["canSync"].as_bool().unwrap_or(false),
        };
        let other_account = lock(&self.state).account.as_ref().is_some_and(|old| old.id != account.id);
        if other_account {
            // Another account's keys never mix with this one's.
            self.forget_keys();
        }
        self.vault.set("token", &token)?;
        self.edit(|s| {
            if other_account {
                s.reset_sync();
            }
            s.account = Some(account);
            s.last_error = None;
        })?;
        let _ = self.refresh().await;
        if self.ready() {
            self.kick();
        }
        Ok(self.changed())
    }

    async fn sign_out(&self) -> Result<Value, String> {
        if let Ok(token) = self.token() {
            let _ = self.api.send(&token, reqwest::Method::DELETE, "/v1/auth/session", None).await;
        }
        self.vault.delete("token");
        // The device key and keyrings stay: signing in again to the same account
        // picks sync up where it was. Another account's sign-in clears them.
        self.edit(|s| s.enabled = false)?;
        lock(&self.live).remote = None;
        Ok(self.changed())
    }

    fn forget_keys(&self) {
        let top = lock(&self.state).key_id.unwrap_or(0);
        for k in 1..=top.max(1) {
            self.vault.delete(&format!("keyring:{k}"));
        }
        self.vault.delete("device-key");
    }

    // ------------------------------------------------------------ keys, devices

    /// This device's key and its registered id, registering it when needed.
    async fn ensure_device(&self, token: &str) -> Result<(DeviceKey, String), String> {
        let key = match self.device_key() {
            Some(k) => k,
            None => {
                let k = DeviceKey::generate();
                let mut raw = k.to_bytes();
                self.vault.set("device-key", &b64_encode(&raw))?;
                raw.zeroize();
                k
            }
        };
        if let Some(id) = lock(&self.state).device_id.clone() {
            return Ok((key, id));
        }
        let label = lock(&self.state).device_label.clone();
        let body = json!({ "publicKey": b64_encode(&key.public()), "label": label });
        let id = match self.api.send(token, reqwest::Method::POST, "/v1/sync/devices", Some(body)).await {
            Ok(v) => v["deviceId"].as_str().unwrap_or("").to_string(),
            Err(err) if err.code == "device-revoked" => {
                // This key was revoked: start over with a new one.
                self.vault.delete("device-key");
                return Err("This device was removed from sync. Turn sync on again to add it back.".into());
            }
            Err(err) => return Err(err.message),
        };
        self.edit(|s| s.device_id = Some(id.clone()))?;
        Ok((key, id))
    }

    fn seal_account(
        &self,
        record: &AccountRecord,
        keyring: &Keyring,
        account_id: &str,
        key_id: u32,
    ) -> Result<Value, String> {
        let oid = object_id(keyring, records::ACCOUNT, records::ACCOUNT_ID).map_err(|err| err.to_string())?;
        let revision = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0) + 1;
        let blob = seal_record(keyring, account_id, key_id, records::ACCOUNT, &oid, revision, &record.to_bytes())
            .map_err(|err| err.to_string())?;
        Ok(
            json!({ "collection": records::ACCOUNT, "objectId": oid, "revision": revision, "keyId": key_id, "blob": blob }),
        )
    }

    /// Push the account record; it must land (another device may have moved it, so retry once after a pull).
    async fn push_account(self: &Arc<Self>, token: &str, record: &AccountRecord) -> Result<(), String> {
        let account_id = self.account_id()?;
        for attempt in 0..2 {
            let key_id = self.key_id();
            let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
            let obj = self.seal_account(record, &keyring, &account_id, key_id)?;
            let res = self
                .api
                .send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": [obj.clone()] })))
                .await
                .map_err(e)?;
            let r = &res["results"][0];
            match r["status"].as_str() {
                Some("ok") => {
                    let (oid, rev) =
                        (obj["objectId"].as_str().unwrap_or("").to_string(), obj["revision"].as_u64().unwrap_or(0));
                    let text = String::from_utf8_lossy(&record.to_bytes()).to_string();
                    self.edit(|s| {
                        s.revisions.insert(oid, rev);
                        s.account_record = Some(text);
                    })?;
                    return Ok(());
                }
                Some("conflict") if attempt == 0 => {
                    let oid = obj["objectId"].as_str().unwrap_or("").to_string();
                    let have = r["revision"].as_u64().unwrap_or(0);
                    self.edit(|s| {
                        s.revisions.insert(oid, have);
                    })?;
                }
                _ => {
                    return Err(format!(
                        "Couldn't save the account record ({}).",
                        r["status"].as_str().unwrap_or("error")
                    ));
                }
            }
        }
        Err("Couldn't save the account record.".into())
    }

    /// First device: make the keyring and the recovery key. Returns the recovery key, shown once.
    async fn turn_on(self: &Arc<Self>) -> Result<Value, String> {
        let token = self.token()?;
        self.refresh().await?;
        if !self.account().is_some_and(|a| a.can_sync) {
            return Err("Sync needs a Pro or Team plan.".into());
        }
        if self.keyring(self.key_id()).is_some() {
            self.edit(|s| s.enabled = true)?;
            self.kick();
            return Ok(json!({ "status": self.changed() }));
        }
        let remote_key = lock(&self.live).remote.as_ref().and_then(|r| r["currentKeyId"].as_u64());
        if remote_key.is_some() {
            self.changed();
            return Err("needs-join: This account already syncs on another device. Add this one with your recovery key, or approve it on that device.".into());
        }
        let account_id = self.account_id()?;
        let (key, device_id) = self.ensure_device(&token).await?;
        let keyring = Keyring::generate();
        let recovery = RecoveryKey::generate();
        let recovery_public = recovery.public_key();
        let wrap = wrap_keyring(&keyring, &account_id, 1, &device_id, &key.public()).map_err(|err| err.to_string())?;
        let recovery_wrap = seal_recovery(&recovery_public, &keyring, &account_id, 1).map_err(|err| err.to_string())?;
        self.api
            .send(
                &token,
                reqwest::Method::PUT,
                "/v1/sync/keyrings/1",
                Some(json!({ "recoveryWrap": recovery_wrap, "wraps": [{ "deviceId": device_id, "wrap": wrap }] })),
            )
            .await
            .map_err(e)?;
        self.store_keyring(1, &keyring)?;
        let rp = b64_encode(&recovery_public);
        self.edit(|s| {
            s.key_id = Some(1);
            s.recovery_public = Some(rp.clone());
            s.recovery_confirmed = false;
            s.enabled = true;
            s.last_error = None;
        })?;
        let label = lock(&self.state).device_label.clone();
        let record = AccountRecord {
            recovery_public: rp,
            devices: vec![TrustedDevice { id: device_id, public_key: b64_encode(&key.public()), label }],
        };
        self.push_account(&token, &record).await?;
        let text = recovery.to_text();
        drop(recovery);
        self.kick();
        Ok(json!({ "recoveryKey": text, "status": self.changed() }))
    }

    /// The user typed the recovery key back: it is this account's.
    fn confirm_recovery_key(&self, text: &str) -> Result<Value, String> {
        let rk = RecoveryKey::parse(text).map_err(|err| match err {
            nekko_sync::Error::Checksum => "There's a typo in that recovery key.".to_string(),
            _ => "That isn't a recovery key. It's 11 groups of 5 letters and numbers.".to_string(),
        })?;
        let pinned = lock(&self.state).recovery_public.clone();
        if pinned.as_deref() != Some(b64_encode(&rk.public_key()).as_str()) {
            return Err("That's a recovery key, but not this account's.".into());
        }
        self.edit(|s| s.recovery_confirmed = true)?;
        Ok(self.changed())
    }

    /// Join with the recovery key: open every key epoch's recovery wrap.
    async fn restore(self: &Arc<Self>, text: &str) -> Result<Value, String> {
        let token = self.token()?;
        let rk =
            RecoveryKey::parse(text).map_err(|_| "That isn't a valid recovery key. Check it for typos.".to_string())?;
        self.refresh().await?;
        let account_id = self.account_id()?;
        let current = lock(&self.live)
            .remote
            .as_ref()
            .and_then(|r| r["currentKeyId"].as_u64())
            .ok_or("This account doesn't sync yet. Turn sync on instead.")? as u32;
        let (key, device_id) = self.ensure_device(&token).await?;
        for k in 1..=current {
            let ring = self.api.get(&token, &format!("/v1/sync/keyrings/{k}")).await.map_err(e)?;
            let keyring = open_recovery(&rk, &account_id, k, ring["recoveryWrap"].as_str().unwrap_or(""))
                .map_err(|_| "That recovery key doesn't belong to this account.".to_string())?;
            let wrap =
                wrap_keyring(&keyring, &account_id, k, &device_id, &key.public()).map_err(|err| err.to_string())?;
            self.api
                .send(
                    &token,
                    reqwest::Method::PUT,
                    &format!("/v1/sync/keyrings/{k}/wraps/{device_id}"),
                    Some(json!({ "wrap": wrap })),
                )
                .await
                .map_err(e)?;
            self.store_keyring(k, &keyring)?;
        }
        let rp = b64_encode(&rk.public_key());
        self.edit(|s| {
            s.key_id = Some(current);
            s.recovery_public = Some(rp.clone());
            s.recovery_confirmed = true;
            s.enabled = true;
            s.last_error = None;
        })?;
        // Read the account record, then add this device to it.
        self.sync_once().await?;
        let mut record = self.account_record().unwrap_or(AccountRecord { recovery_public: rp, devices: vec![] });
        let label = lock(&self.state).device_label.clone();
        record.add(TrustedDevice { id: device_id, public_key: b64_encode(&key.public()), label });
        self.push_account(&token, &record).await?;
        Ok(self.changed())
    }

    /// Join by approval: register and wait for a syncing device to add this one.
    async fn request_join(self: &Arc<Self>) -> Result<Value, String> {
        let token = self.token()?;
        let (key, _) = self.ensure_device(&token).await?;
        self.edit(|s| s.enabled = true)?;
        let _ = self.refresh().await;
        self.changed();
        Ok(json!({ "fingerprint": fingerprint(&key.public()), "status": self.status() }))
    }

    /// The keyrings a syncing device wrapped to this one, once approved.
    async fn finish_join(&self, token: &str) -> Result<bool, String> {
        let (Some(key), Some(device_id)) = (self.device_key(), lock(&self.state).device_id.clone()) else {
            return Ok(false);
        };
        let account_id = self.account_id()?;
        let current = match lock(&self.live).remote.as_ref().and_then(|r| r["currentKeyId"].as_u64()) {
            Some(k) => k as u32,
            None => return Ok(false),
        };
        let mut got = 0;
        for k in 1..=current {
            let ring = self.api.get(token, &format!("/v1/sync/keyrings/{k}")).await.map_err(e)?;
            if let Some(w) = ring["wrap"].as_str()
                && let Ok(kr) = unwrap_keyring(&key, &account_id, k, &device_id, w)
            {
                self.store_keyring(k, &kr)?;
                got = k;
            }
        }
        if got == current {
            self.edit(|s| {
                s.key_id = Some(current);
                s.recovery_confirmed = true;
            })?;
            return Ok(true);
        }
        Ok(false)
    }

    /// On a syncing device: add a device that asked to join, after the user compared fingerprints.
    async fn approve(self: &Arc<Self>, device_id: &str) -> Result<Value, String> {
        let token = self.token()?;
        self.refresh().await?;
        let account_id = self.account_id()?;
        let remote = lock(&self.live).remote.clone().unwrap_or(Value::Null);
        let d = remote["devices"]
            .as_array()
            .and_then(|l| l.iter().find(|d| d["id"].as_str() == Some(device_id)))
            .cloned()
            .ok_or("That device isn't on this account.")?;
        if d["revokedAt"].as_str().is_some() {
            return Err("That device was removed.".into());
        }
        let public = b64_decode(d["publicKey"].as_str().unwrap_or("")).map_err(|_| "bad device key")?;
        let top = self.key_id();
        for k in 1..=top {
            if let Some(kr) = self.keyring(k) {
                let wrap = wrap_keyring(&kr, &account_id, k, device_id, &public).map_err(|err| err.to_string())?;
                self.api
                    .send(
                        &token,
                        reqwest::Method::PUT,
                        &format!("/v1/sync/keyrings/{k}/wraps/{device_id}"),
                        Some(json!({ "wrap": wrap })),
                    )
                    .await
                    .map_err(e)?;
            }
        }
        let mut record =
            self.account_record().ok_or("This device hasn't read the account record yet. Sync, then try again.")?;
        record.add(TrustedDevice {
            id: device_id.into(),
            public_key: b64_encode(&public),
            label: d["label"].as_str().unwrap_or("").into(),
        });
        self.push_account(&token, &record).await?;
        Ok(self.changed())
    }

    /// Remove a device and move every other trusted device to a new key epoch.
    async fn revoke(self: &Arc<Self>, device_id: &str) -> Result<Value, String> {
        let token = self.token()?;
        if lock(&self.state).device_id.as_deref() == Some(device_id) {
            return Err("To stop syncing this device, turn sync off or sign out.".into());
        }
        let account_id = self.account_id()?;
        self.api
            .send(&token, reqwest::Method::DELETE, &format!("/v1/sync/devices/{device_id}"), None)
            .await
            .map_err(e)?;
        self.refresh().await?;
        let mut record = self.account_record().ok_or("This device hasn't read the account record yet.")?;
        record.devices.retain(|d| d.id != device_id);
        let remote = lock(&self.live).remote.clone().unwrap_or(Value::Null);
        let live_ids: BTreeSet<String> = remote["devices"]
            .as_array()
            .map(|l| {
                l.iter()
                    .filter(|d| d["revokedAt"].is_null())
                    .filter_map(|d| d["id"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        record.devices.retain(|d| live_ids.contains(&d.id));
        let current = self.key_id();
        let old = self.keyring(current).ok_or("This device has no sync keys.")?;
        let next = current + 1;
        let new = old.rotate();
        let mut wraps = Vec::new();
        for d in &record.devices {
            let public = b64_decode(&d.public_key).map_err(|_| "bad device key")?;
            wraps.push(json!({ "deviceId": d.id, "wrap": wrap_keyring(&new, &account_id, next, &d.id, &public).map_err(|err| err.to_string())? }));
        }
        let rp = b64_decode(&record.recovery_public).map_err(|_| "bad recovery key")?;
        let recovery_wrap = seal_recovery(&rp, &new, &account_id, next).map_err(|err| err.to_string())?;
        self.api
            .send(
                &token,
                reqwest::Method::PUT,
                &format!("/v1/sync/keyrings/{next}"),
                Some(json!({ "recoveryWrap": recovery_wrap, "wraps": wraps })),
            )
            .await
            .map_err(e)?;
        self.store_keyring(next, &new)?;
        self.edit(|s| s.key_id = Some(next))?;
        self.push_account(&token, &record).await?;
        let _ = self.refresh().await;
        Ok(self.changed())
    }

    async fn delete_all(&self) -> Result<Value, String> {
        let token = self.token()?;
        self.api.send(&token, reqwest::Method::DELETE, "/v1/sync", None).await.map_err(e)?;
        self.forget_keys();
        self.edit(|s| s.reset_sync())?;
        let _ = self.refresh().await;
        Ok(self.changed())
    }

    // ------------------------------------------------------------------- sync

    fn set_progress(&self, p: Option<(usize, usize)>) {
        lock(&self.live).progress = p;
        self.changed();
    }

    /// One pull and push, repeated (up to three times) while pushes conflict.
    pub async fn sync_once(self: &Arc<Self>) -> Result<(), String> {
        let _one = self.run.lock().await;
        let token = self.token()?;
        {
            let mut live = lock(&self.live);
            live.syncing = true;
            live.pushed = 0;
            live.pulled = 0;
        }
        self.changed();
        let result = self.pass(&token).await;
        {
            let mut live = lock(&self.live);
            live.syncing = false;
            live.progress = None;
        }
        let err = result.as_ref().err().cloned();
        self.edit(|s| {
            s.last_error = err.clone();
            if err.is_none() {
                s.last_sync_at = Some(now_ms());
            }
        })?;
        self.changed();
        result
    }

    async fn pass(self: &Arc<Self>, token: &str) -> Result<(), String> {
        self.refresh().await?;
        if self.keyring(self.key_id()).is_none() && !self.finish_join(token).await? {
            return Ok(()); // still waiting to be approved
        }
        // A newer key epoch than ours (another device rotated): take its wrap.
        let remote_key = lock(&self.live).remote.as_ref().and_then(|r| r["currentKeyId"].as_u64()).unwrap_or(0) as u32;
        if remote_key > self.key_id() {
            self.finish_join(token).await?;
            if self.key_id() < remote_key {
                return Err("This device was removed from sync on another device.".into());
            }
        }
        for _ in 0..3 {
            self.pull(token).await?;
            if !self.push(token).await? {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn pull(&self, token: &str) -> Result<(), String> {
        let account_id = self.account_id()?;
        loop {
            let since = lock(&self.state).cursor;
            let page =
                self.api.get(token, &format!("/v1/sync/pull?since={since}&limit={PULL_PAGE}")).await.map_err(e)?;
            let objects = page["objects"].as_array().cloned().unwrap_or_default();
            for o in &objects {
                self.apply(&account_id, o);
            }
            let next = page["next"].as_u64().unwrap_or(since);
            self.edit(|s| s.cursor = next)?;
            if page["more"].as_bool() != Some(true) || objects.is_empty() {
                return Ok(());
            }
        }
    }

    /// Open and apply one pulled object. Anything that doesn't open, or is an
    /// older revision than one seen before (a rollback), is ignored.
    fn apply(&self, account_id: &str, o: &Value) {
        let (Some(collection), Some(oid), Some(rev), Some(kid), Some(blob)) = (
            o["collection"].as_str(),
            o["objectId"].as_str(),
            o["revision"].as_u64(),
            o["keyId"].as_u64().map(|k| k as u32),
            o["blob"].as_str(),
        ) else {
            return;
        };
        if lock(&self.state).revisions.get(oid).is_some_and(|seen| *seen >= rev) {
            return;
        }
        let Some(keyring) = self.keyring(kid) else { return };
        let Ok(plain) = open_record(&keyring, account_id, kid, collection, oid, rev, blob) else { return };
        match collection {
            records::ACCOUNT => {
                if object_id(&keyring, records::ACCOUNT, records::ACCOUNT_ID).as_deref() != Ok(oid) {
                    return;
                }
                let Some(record) = AccountRecord::parse(&plain) else { return };
                let pinned = lock(&self.state).recovery_public.clone();
                // The recovery key's public half never changes; a record naming another one is refused.
                if pinned.as_ref().is_some_and(|p| *p != record.recovery_public) {
                    return;
                }
                let text = String::from_utf8_lossy(&plain).to_string();
                let _ = self.edit(|s| {
                    s.recovery_public = Some(record.recovery_public.clone());
                    s.account_record = Some(text);
                    s.revisions.insert(oid.into(), rev);
                });
            }
            records::CHAT => {
                let Some(rec) = records::parse_chat(&plain) else { return };
                let id = match &rec {
                    ChatRecord::Chat(c) => c["id"].as_str().unwrap_or("").to_string(),
                    ChatRecord::Deleted { .. } => {
                        // A tombstone names its chat only through the object id: find it among ours.
                        let known = lock(&self.state).chats.keys().cloned().collect::<Vec<_>>();
                        match known.into_iter().find(|id| object_id(&keyring, records::CHAT, id).as_deref() == Ok(oid))
                        {
                            Some(id) => id,
                            None => {
                                let _ = self.edit(|s| {
                                    s.revisions.insert(oid.into(), rev);
                                });
                                return;
                            }
                        }
                    }
                };
                // The record must be the one filed under this chat's id: the server can't swap chats.
                if object_id(&keyring, records::CHAT, &id).as_deref() != Ok(oid) || !nekko_store::valid_id(&id) {
                    return;
                }
                let local = self.sessions.get(&id);
                let busy = (self.busy)(&id);
                match rec {
                    ChatRecord::Chat(chat) => {
                        let newer = local.as_ref().is_none_or(|l| records::updated_at(&chat) > records::updated_at(l));
                        if newer && !busy && self.sessions.put_synced(&chat).is_ok() {
                            lock(&self.live).pulled += 1;
                        }
                        let synced = Synced {
                            updated_at: records::updated_at(&chat),
                            digest: records::digest(&plain),
                            deleted: false,
                        };
                        let _ = self.edit(|s| {
                            s.revisions.insert(oid.into(), rev);
                            // Only when we took it; otherwise our newer copy still needs pushing.
                            if newer && !busy {
                                s.chats.insert(id.clone(), synced);
                            }
                        });
                    }
                    ChatRecord::Deleted { at } => {
                        if let Some(l) = &local
                            && records::updated_at(l) <= at
                            && !busy
                        {
                            let _ = self.sessions.delete(&id);
                        }
                        let _ = self.edit(|s| {
                            s.revisions.insert(oid.into(), rev);
                            s.chats.insert(id.clone(), Synced { updated_at: at, digest: String::new(), deleted: true });
                        });
                    }
                }
            }
            _ => {}
        }
    }

    /// Push what changed here. True when a conflict needs another pass.
    async fn push(&self, token: &str) -> Result<bool, String> {
        let account_id = self.account_id()?;
        let key_id = self.key_id();
        let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
        let st = lock(&self.state).clone();
        let mut queue: Vec<(String, Vec<u8>, Synced)> = Vec::new();
        let mut skipped: BTreeMap<&'static str, usize> = BTreeMap::new();
        let summaries = self.sessions.summaries();
        let here: BTreeSet<String> = summaries.iter().filter_map(|s| s["id"].as_str().map(String::from)).collect();
        for s in &summaries {
            let Some(id) = s["id"].as_str() else { continue };
            let updated = s["updatedAt"].as_f64().unwrap_or(0.0);
            let known = st.chats.get(id);
            if known.is_some_and(|k| !k.deleted && k.updated_at == updated) {
                continue;
            }
            let Some(chat) = self.sessions.get(id) else { continue };
            match records::chat_plaintext(&chat, st.include_local_only) {
                Ok(plain) => {
                    let digest = records::digest(&plain);
                    if known.is_some_and(|k| k.digest == digest) {
                        continue;
                    }
                    queue.push((id.to_string(), plain, Synced { updated_at: updated, digest, deleted: false }));
                }
                Err(skip) => {
                    *skipped
                        .entry(match skip {
                            Skip::Incognito => "incognito",
                            Skip::LocalOnly => "localOnly",
                            Skip::TooLarge => "tooLarge",
                        })
                        .or_default() += 1;
                }
            }
        }
        // Chats deleted here since they were synced.
        for (id, k) in &st.chats {
            if !k.deleted && !here.contains(id) {
                let at = now_ms();
                queue.push((
                    id.clone(),
                    records::tombstone(at),
                    Synced { updated_at: at, digest: String::new(), deleted: true },
                ));
            }
        }
        lock(&self.live).skipped = skipped;
        let total = queue.len();
        let mut again = false;
        let mut done = 0;
        for batch in queue.chunks(PUSH_BATCH) {
            self.set_progress(Some((done, total)));
            let mut objects = Vec::new();
            let mut meta = Vec::new();
            for (id, plain, synced) in batch {
                let oid = object_id(&keyring, records::CHAT, id).map_err(|err| err.to_string())?;
                let revision = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0) + 1;
                let blob = seal_record(&keyring, &account_id, key_id, records::CHAT, &oid, revision, plain)
                    .map_err(|err| err.to_string())?;
                objects.push(json!({ "collection": records::CHAT, "objectId": oid, "revision": revision, "keyId": key_id, "blob": blob }));
                meta.push((id.clone(), oid, revision, synced.clone()));
            }
            let res = self
                .api
                .send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": objects })))
                .await
                .map_err(e)?;
            let results = res["results"].as_array().cloned().unwrap_or_default();
            for ((id, oid, revision, synced), r) in meta.into_iter().zip(results) {
                match r["status"].as_str() {
                    Some("ok") => {
                        lock(&self.live).pushed += 1;
                        self.edit(|s| {
                            s.revisions.insert(oid, revision);
                            s.chats.insert(id, synced);
                        })?;
                    }
                    Some("conflict") => {
                        // Another device wrote it: pull, merge by updatedAt, and try again.
                        let have = r["revision"].as_u64().unwrap_or(0);
                        self.edit(|s| {
                            let seen = s.revisions.entry(oid).or_insert(0);
                            if *seen > have {
                                *seen = have;
                            }
                        })?;
                        again = true;
                    }
                    Some("stale-key") => again = true,
                    _ => {}
                }
            }
            done += batch.len();
        }
        Ok(again)
    }
}
