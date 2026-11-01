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
//! key or by being approved on a device that already syncs, where the user
//! types the one-time join code the new device shows (it checks the new
//! device's key on the approver, and the approver on the new device).
//! Revoking a device starts a new key epoch, wrapped (authenticated by this
//! device's key) only to the devices in the sealed account record, and
//! everything is sealed again under it.
//!
//! **Trust.** A device holds one key epoch and that epoch's account record.
//! It takes a newer epoch only from a wrap made by a device that record
//! trusts, and only once the new epoch's own record lists it. Records under an
//! older epoch are ignored, revisions never go backwards, and the recovery
//! key's public half is pinned. See `docs/SYNC-ENCRYPTION.md` for what this
//! does and doesn't stop.
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
    DeviceKey, JoinCode, Keyring, Recipient, RecoveryKey, b64_decode, b64_encode, epoch_proof, fingerprint, object_id,
    open_record, open_recovery, seal_record, seal_recovery, unwrap_join, unwrap_keyring, wrap_for_join, wrap_keyring,
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
    /// The (token, key epoch) Nekko Cloud last accepted this device's epoch proof for.
    proven: Option<(String, u32)>,
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
            "sync:approve" => self.approve(&arg(args, 0), &arg(args, 1)).await,
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

    /// The epoch proof for a keyring, base64url: a one-way value Nekko Cloud
    /// checks before it counts this sign-in as holding the epoch's keys.
    fn proof(keyring: &Keyring, key_id: u32) -> String {
        b64_encode(&epoch_proof(keyring, key_id))
    }

    fn mark_proven(&self, token: &str, key_id: u32) {
        lock(&self.live).proven = Some((token.to_string(), key_id));
    }

    /// Show Nekko Cloud this sign-in holds the epoch's keyring, once per
    /// (token, epoch). Changing keys, devices or data needs it.
    async fn prove(&self, token: &str, key_id: u32) -> Result<(), String> {
        if lock(&self.live).proven.as_ref().is_some_and(|(t, k)| t == token && *k == key_id) {
            return Ok(());
        }
        let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
        let body = json!({ "proof": Self::proof(&keyring, key_id) });
        self.api
            .send(token, reqwest::Method::POST, &format!("/v1/sync/keyrings/{key_id}/proof"), Some(body))
            .await
            .map_err(e)?;
        self.mark_proven(token, key_id);
        Ok(())
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
                            // Asked to join and can be approved with its code.
                            "askedToJoin": d.get("joinTag").is_some_and(|t| !t.is_null()),
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
        // Shown only on this device while it waits: the user types it on a device that syncs.
        let join_code = if phase == "awaiting-approval" { self.vault.get("join-code") } else { None };
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
                "joinCode": join_code,
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
                    // Anything on this machine can open this URL, so nothing it sends is shown
                    // as is, and only a code that PKCE accepts ends the wait.
                    let outcome = match q.get("code") {
                        Some(code) => match supabase.exchange(code, &verifier).await {
                            // Our own API's answer (a plan or account problem) is worth showing.
                            Ok(access) => me.finish_sign_in(&access).await.map(|_| ()).map_err(Some),
                            Err(_) => Err(None),
                        },
                        None => Err(None),
                    };
                    let (title, body) = match &outcome {
                        Ok(()) => ("Signed in", "You're signed in to Nekko Cloud. You can close this tab."),
                        Err(_) => ("Sign-in didn't finish", "Go back to Nekko Agent and try again."),
                    };
                    if outcome.is_ok() {
                        if let Some(tx) = lock(&done_tx).take() {
                            let _ = tx.send(());
                        }
                    } else if let Err(why) = outcome {
                        let why = why.unwrap_or_else(|| "Sign-in didn't finish. Try again.".into());
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
        self.vault.delete("join-code");
        lock(&self.live).proven = None;
    }

    // ------------------------------------------------------------ keys, devices

    fn device_key_or_new(&self) -> Result<DeviceKey, String> {
        if let Some(k) = self.device_key() {
            return Ok(k);
        }
        let k = DeviceKey::generate();
        let mut raw = k.to_bytes();
        self.vault.set("device-key", &b64_encode(&raw))?;
        raw.zeroize();
        Ok(k)
    }

    /// This device's key and its registered id. Registers the key when this
    /// sign-in's token isn't bound to it yet (first use, or after signing in
    /// again), so revoking the device always ends the token it is using.
    async fn ensure_device(&self, token: &str, join_tag: Option<&[u8; 32]>) -> Result<(DeviceKey, String), String> {
        let key = self.device_key_or_new()?;
        let known = lock(&self.state).device_id.clone();
        let bound = lock(&self.live).remote.as_ref().and_then(|r| r["device"].as_str().map(String::from));
        if let Some(id) = &known
            && bound.as_deref() == Some(id.as_str())
            && join_tag.is_none()
        {
            return Ok((key, id.clone()));
        }
        let label = lock(&self.state).device_label.clone();
        let mut body = json!({ "publicKey": b64_encode(&key.public()), "label": label });
        if let Some(tag) = join_tag {
            body["joinTag"] = json!(b64_encode(tag));
        }
        let id = match self.api.send(token, reqwest::Method::POST, "/v1/sync/devices", Some(body)).await {
            Ok(v) => v["deviceId"].as_str().unwrap_or("").to_string(),
            Err(err) if err.code == "device-revoked" => {
                // This key was revoked: start over with a new one.
                self.forget_keys();
                self.edit(|s| s.reset_sync())?;
                return Err("This device was removed from sync. Turn sync on again to add it back.".into());
            }
            Err(err) => return Err(err.message),
        };
        if known.as_deref().is_some_and(|k| k != id) {
            return Err("Nekko Cloud gave this device a different id. Turn sync off and on again.".into());
        }
        self.edit(|s| s.device_id = Some(id.clone()))?;
        if let Some(r) = lock(&self.live).remote.as_mut() {
            r["device"] = json!(id);
        }
        Ok((key, id))
    }

    fn account_oid(keyring: &Keyring, epoch: u32) -> Result<String, String> {
        object_id(keyring, records::ACCOUNT, &records::account_local_id(epoch)).map_err(|err| err.to_string())
    }

    /// Open an epoch's account record and check it: the right object, the
    /// epoch it claims, the pinned recovery key, and newer than any seen.
    fn open_account(
        &self,
        keyring: &Keyring,
        account_id: &str,
        epoch: u32,
        o: &Value,
    ) -> Result<(AccountRecord, String, u64), String> {
        let bad = || "Nekko Cloud sent an account record that doesn't check out.".to_string();
        let oid = Self::account_oid(keyring, epoch)?;
        let (Some(got_oid), Some(rev), Some(kid), Some(blob)) =
            (o["objectId"].as_str(), o["revision"].as_u64(), o["keyId"].as_u64(), o["blob"].as_str())
        else {
            return Err(bad());
        };
        if got_oid != oid || kid != u64::from(epoch) || o["collection"].as_str() != Some(records::ACCOUNT) {
            return Err(bad());
        }
        let plain = open_record(keyring, account_id, epoch, records::ACCOUNT, &oid, rev, blob).map_err(|_| bad())?;
        let record = AccountRecord::parse(&plain).ok_or_else(bad)?;
        if record.epoch != epoch {
            return Err(bad());
        }
        let pinned = lock(&self.state).recovery_public.clone();
        // The recovery key's public half never changes; a record naming another one is refused.
        if pinned.as_ref().is_some_and(|p| *p != record.recovery_public) {
            return Err(bad());
        }
        if lock(&self.state).revisions.get(&oid).is_some_and(|seen| *seen > rev) {
            return Err("Nekko Cloud sent an older account record than this device has seen.".into());
        }
        Ok((record, oid, rev))
    }

    /// Fetch an epoch's account record (out of feed order). None while it isn't written yet.
    async fn fetch_account(
        &self,
        token: &str,
        keyring: &Keyring,
        account_id: &str,
        epoch: u32,
    ) -> Result<Option<(AccountRecord, String, u64)>, String> {
        let oid = Self::account_oid(keyring, epoch)?;
        match self.api.get(token, &format!("/v1/sync/objects/{}/{oid}", records::ACCOUNT)).await {
            Ok(o) => self.open_account(keyring, account_id, epoch, &o).map(Some),
            Err(err) if err.status == 404 => Ok(None),
            Err(err) => Err(err.message),
        }
    }

    fn keep_account(&self, record: &AccountRecord, oid: &str, rev: u64) -> Result<(), String> {
        let text = String::from_utf8_lossy(&record.to_bytes()).to_string();
        let rp = record.recovery_public.clone();
        self.edit(|s| {
            s.recovery_public = Some(rp);
            s.account_record = Some(text);
            let seen = s.revisions.entry(oid.to_string()).or_insert(0);
            *seen = (*seen).max(rev);
        })
    }

    /// Change the current epoch's account record: apply `f` to the newest one
    /// and push it. When another device moved it first, read theirs and apply
    /// `f` again.
    async fn update_account(&self, token: &str, f: impl Fn(&mut AccountRecord)) -> Result<(), String> {
        let account_id = self.account_id()?;
        for _ in 0..3 {
            let key_id = self.key_id();
            let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
            let mut record = self
                .account_record()
                .filter(|r| r.epoch == key_id)
                .ok_or("This device hasn't read the account record yet. Sync, then try again.")?;
            f(&mut record);
            let oid = Self::account_oid(&keyring, key_id)?;
            let seen = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0);
            let revision = seen + 1;
            let blob = seal_record(&keyring, &account_id, key_id, records::ACCOUNT, &oid, revision, &record.to_bytes())
                .map_err(|err| err.to_string())?;
            let obj = json!({ "collection": records::ACCOUNT, "objectId": oid, "revision": revision, "keyId": key_id, "blob": blob });
            self.prove(token, key_id).await?;
            let res = self
                .api
                .send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": [obj] })))
                .await
                .map_err(e)?;
            let r = &res["results"][0];
            match r["status"].as_str() {
                Some("ok") => return self.keep_account(&record, &oid, revision),
                Some("conflict") => {
                    // The server's revision can only be newer than ours; anything else is a rollback.
                    if r["revision"].as_u64().unwrap_or(0) < seen {
                        return Err("Nekko Cloud sent an older account record than this device has seen.".into());
                    }
                    if let Some((rec, oid, rev)) = self.fetch_account(token, &keyring, &account_id, key_id).await? {
                        self.keep_account(&rec, &oid, rev)?;
                    }
                }
                Some("stale-key") => return Err("Another device changed the sync keys. Sync, then try again.".into()),
                other => return Err(format!("Couldn't save the account record ({}).", other.unwrap_or("error"))),
            }
        }
        Err("Couldn't save the account record.".into())
    }

    /// Hold `keyring` as the current epoch, forgetting older ones: records
    /// under an older epoch are never accepted again.
    fn hold_epoch(
        &self,
        epoch: u32,
        keyring: &Keyring,
        record: &AccountRecord,
        oid: &str,
        rev: u64,
    ) -> Result<(), String> {
        let old = lock(&self.state).key_id;
        self.store_keyring(epoch, keyring)?;
        self.edit(|s| s.key_id = Some(epoch))?;
        self.keep_account(record, oid, rev)?;
        if let Some(old) = old.filter(|o| *o != epoch) {
            for k in 1..=old {
                self.vault.delete(&format!("keyring:{k}"));
            }
        }
        Ok(())
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
        let (key, device_id) = self.ensure_device(&token, None).await?;
        let keyring = Keyring::generate();
        let recovery = RecoveryKey::generate();
        let recovery_public = recovery.public_key();
        let me = key.public();
        let wrap = wrap_keyring(&keyring, &account_id, 1, Recipient { id: &device_id, public: &me }, &device_id, &key)
            .map_err(|err| err.to_string())?;
        let recovery_wrap = seal_recovery(&recovery_public, &keyring, &account_id, 1).map_err(|err| err.to_string())?;
        self.api
            .send(
                &token,
                reqwest::Method::PUT,
                "/v1/sync/keyrings/1",
                Some(json!({
                    "recoveryWrap": recovery_wrap,
                    "proof": Self::proof(&keyring, 1),
                    "wraps": [{ "deviceId": device_id, "wrap": wrap }],
                })),
            )
            .await
            .map_err(e)?;
        self.mark_proven(&token, 1);
        let label = lock(&self.state).device_label.clone();
        let record = AccountRecord {
            epoch: 1,
            recovery_public: b64_encode(&recovery_public),
            devices: vec![TrustedDevice { id: device_id, public_key: b64_encode(&me), label }],
        };
        // Held before it is pushed, so a failed push leaves a record to push again.
        let oid = Self::account_oid(&keyring, 1)?;
        self.hold_epoch(1, &keyring, &record, &oid, 0)?;
        self.edit(|s| {
            s.recovery_confirmed = false;
            s.enabled = true;
            s.last_error = None;
        })?;
        self.update_account(&token, |_| {}).await?;
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

    /// Join with the recovery key: open the current epoch's recovery wrap,
    /// check its account record names this recovery key, then add this device.
    async fn restore(self: &Arc<Self>, text: &str) -> Result<Value, String> {
        let token = self.token()?;
        let rk =
            RecoveryKey::parse(text).map_err(|_| "That isn't a valid recovery key. Check it for typos.".to_string())?;
        self.refresh().await?;
        let account_id = self.account_id()?;
        let current = self.remote_key().ok_or("This account doesn't sync yet. Turn sync on instead.")?;
        let (key, device_id) = self.ensure_device(&token, None).await?;
        let ring = self.api.get(&token, &format!("/v1/sync/keyrings/{current}")).await.map_err(e)?;
        let keyring = open_recovery(&rk, &account_id, current, ring["recoveryWrap"].as_str().unwrap_or(""))
            .map_err(|_| "That recovery key doesn't belong to this account.".to_string())?;
        let rp = b64_encode(&rk.public_key());
        self.edit(|s| s.recovery_public = Some(rp.clone()))?;
        // Never invent a record: without the account's own, the other devices would be dropped.
        let (record, oid, rev) = self
            .fetch_account(&token, &keyring, &account_id, current)
            .await?
            .ok_or("Nekko Cloud didn't send this account's record. Try again in a moment.")?;
        let me = key.public();
        let wrap =
            wrap_keyring(&keyring, &account_id, current, Recipient { id: &device_id, public: &me }, &device_id, &key)
                .map_err(|err| err.to_string())?;
        match self
            .api
            .send(
                &token,
                reqwest::Method::PUT,
                &format!("/v1/sync/keyrings/{current}/wraps/{device_id}"),
                Some(json!({ "wrap": wrap, "proof": Self::proof(&keyring, current) })),
            )
            .await
        {
            Ok(_) => self.mark_proven(&token, current),
            Err(err) if err.code == "wrap-exists" => {}
            Err(err) => return Err(err.message),
        }
        self.hold_epoch(current, &keyring, &record, &oid, rev)?;
        self.prove(&token, current).await?;
        self.edit(|s| {
            s.recovery_confirmed = true;
            s.enabled = true;
            s.last_error = None;
        })?;
        let label = lock(&self.state).device_label.clone();
        let me = TrustedDevice { id: device_id, public_key: b64_encode(&me), label };
        self.update_account(&token, |r| r.add(me.clone())).await?;
        self.sync_once().await?;
        Ok(self.changed())
    }

    /// Join by approval: register with a join tag, and show the code to type on a device that syncs.
    async fn request_join(self: &Arc<Self>) -> Result<Value, String> {
        let token = self.token()?;
        let _ = self.refresh().await;
        let account_id = self.account_id()?;
        let key = self.device_key_or_new()?;
        let code = match self.vault.get("join-code").and_then(|t| JoinCode::parse(&t).ok()) {
            Some(c) => c,
            None => {
                let c = JoinCode::generate();
                self.vault.set("join-code", &c.to_text())?;
                c
            }
        };
        let tag = code.tag(&account_id, &key.public());
        self.ensure_device(&token, Some(&tag)).await?;
        self.edit(|s| s.enabled = true)?;
        let _ = self.refresh().await;
        self.changed();
        Ok(json!({ "joinCode": code.to_text(), "status": self.status() }))
    }

    /// The keyring a syncing device wrapped to this one with its join code, once approved.
    async fn finish_join(&self, token: &str) -> Result<bool, String> {
        let (Some(key), Some(device_id)) = (self.device_key(), lock(&self.state).device_id.clone()) else {
            return Ok(false);
        };
        let Some(code) = self.vault.get("join-code").and_then(|t| JoinCode::parse(&t).ok()) else {
            return Ok(false);
        };
        let account_id = self.account_id()?;
        let Some(current) = self.remote_key() else { return Ok(false) };
        // The approval may predate a rotation: look back a few epochs, then catch up through the chain.
        for k in (current.saturating_sub(4).max(1)..=current).rev() {
            let ring = self.api.get(token, &format!("/v1/sync/keyrings/{k}")).await.map_err(e)?;
            let Some(w) = ring["wrap"].as_str() else { continue };
            let Ok(keyring) = unwrap_join(&key, &account_id, k, &device_id, &code, w) else { continue };
            let Some((record, oid, rev)) = self.fetch_account(token, &keyring, &account_id, k).await? else {
                return Ok(false);
            };
            if !record.lists(&device_id, &b64_encode(&key.public())) {
                return Ok(false);
            }
            self.hold_epoch(k, &keyring, &record, &oid, rev)?;
            self.vault.delete("join-code");
            self.edit(|s| s.recovery_confirmed = true)?;
            if k < current {
                self.adopt(token, current).await?;
            }
            return Ok(true);
        }
        Ok(false)
    }

    /// Move to a newer key epoch, one at a time. Each epoch's keyring is taken
    /// only from a wrap made by a device the record of the epoch this device
    /// holds trusts, and only once that epoch's own record lists this device.
    /// True when caught up; false while the new epoch's record isn't written yet.
    async fn adopt(&self, token: &str, target: u32) -> Result<bool, String> {
        let (key, device_id) = match (self.device_key(), lock(&self.state).device_id.clone()) {
            (Some(k), Some(id)) => (k, id),
            _ => return Err("This device has no sync keys.".into()),
        };
        let account_id = self.account_id()?;
        let me = b64_encode(&key.public());
        while self.key_id() < target {
            let next = self.key_id() + 1;
            let trusted = self
                .account_record()
                .filter(|r| r.epoch + 1 == next)
                .ok_or("This device hasn't read the account record yet.")?;
            let ring = self.api.get(token, &format!("/v1/sync/keyrings/{next}")).await.map_err(e)?;
            let Some(w) = ring["wrap"].as_str() else {
                return Err(REMOVED.into());
            };
            let keyring = trusted
                .devices
                .iter()
                .find_map(|d| {
                    let public = b64_decode(&d.public_key).ok()?;
                    unwrap_keyring(&key, &account_id, next, &device_id, &d.id, &public, w).ok()
                })
                .ok_or("A new sync key came from a device this one doesn't trust. It was refused.")?;
            let Some((record, oid, rev)) = self.fetch_account(token, &keyring, &account_id, next).await? else {
                return Ok(false);
            };
            if !record.lists(&device_id, &me) {
                return Err(REMOVED.into());
            }
            self.hold_epoch(next, &keyring, &record, &oid, rev)?;
        }
        Ok(true)
    }

    /// On a syncing device: add a device that asked to join, with the code it shows.
    async fn approve(self: &Arc<Self>, device_id: &str, code: &str) -> Result<Value, String> {
        let token = self.token()?;
        let code = JoinCode::parse(code).map_err(|_| "Type the 16-character code the new device shows.".to_string())?;
        self.sync_once().await?;
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
        let label = d["label"].as_str().unwrap_or("").to_string();
        // The key Nekko Cloud shows must be the one the code was made for; a swapped key fails here.
        let public = b64_decode(d["publicKey"].as_str().unwrap_or("")).map_err(|_| "bad device key")?;
        let tag = d["joinTag"].as_str().and_then(|t| b64_decode(t).ok()).unwrap_or_default();
        if !code.verifies(&account_id, &public, &tag) {
            return Err(format!("That code doesn't match {label}. Check the code on that device and type it again."));
        }
        let joining = TrustedDevice { id: device_id.into(), public_key: b64_encode(&public), label };
        self.update_account(&token, |r| r.add(joining.clone())).await?;
        let key_id = self.key_id();
        let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
        let wrap = wrap_for_join(&keyring, &account_id, key_id, Recipient { id: device_id, public: &public }, &code)
            .map_err(|err| err.to_string())?;
        self.prove(&token, key_id).await?;
        self.api
            .send(
                &token,
                reqwest::Method::PUT,
                &format!("/v1/sync/keyrings/{key_id}/wraps/{device_id}"),
                Some(json!({ "wrap": wrap })),
            )
            .await
            .map_err(e)?;
        let _ = self.refresh().await;
        Ok(self.changed())
    }

    /// Remove a device and move every other trusted device to a new key epoch,
    /// then seal everything again under it.
    async fn revoke(self: &Arc<Self>, device_id: &str) -> Result<Value, String> {
        let token = self.token()?;
        let my_id = lock(&self.state).device_id.clone().unwrap_or_default();
        if my_id == device_id {
            return Err("To stop syncing this device, turn sync off or sign out.".into());
        }
        // Catch up first: a rotation starts from the newest epoch and record.
        self.sync_once().await?;
        let account_id = self.account_id()?;
        let key = self.device_key().ok_or("This device has no sync keys.")?;
        let current = self.key_id();
        let mut record = self
            .account_record()
            .filter(|r| r.epoch == current)
            .ok_or("This device hasn't read the account record yet.")?;
        self.prove(&token, current).await?;
        self.api
            .send(&token, reqwest::Method::DELETE, &format!("/v1/sync/devices/{device_id}"), None)
            .await
            .map_err(e)?;
        self.refresh().await?;
        record.devices.retain(|d| d.id != device_id);
        // Devices Nekko Cloud no longer has (removed elsewhere) can't take a wrap.
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
        record.devices.retain(|d| live_ids.contains(&d.id) || d.id == my_id);
        let old = self.keyring(current).ok_or("This device has no sync keys.")?;
        let next = current + 1;
        let new = old.rotate();
        let mut wraps = Vec::new();
        for d in &record.devices {
            let public = b64_decode(&d.public_key).map_err(|_| "bad device key")?;
            let wrap = wrap_keyring(&new, &account_id, next, Recipient { id: &d.id, public: &public }, &my_id, &key)
                .map_err(|err| err.to_string())?;
            wraps.push(json!({ "deviceId": d.id, "wrap": wrap }));
        }
        let rp = b64_decode(&record.recovery_public).map_err(|_| "bad recovery key")?;
        let recovery_wrap = seal_recovery(&rp, &new, &account_id, next).map_err(|err| err.to_string())?;
        self.api
            .send(
                &token,
                reqwest::Method::PUT,
                &format!("/v1/sync/keyrings/{next}"),
                Some(json!({ "recoveryWrap": recovery_wrap, "proof": Self::proof(&new, next), "wraps": wraps })),
            )
            .await
            .map_err(e)?;
        self.mark_proven(&token, next);
        record.epoch = next;
        let oid = Self::account_oid(&new, next)?;
        self.hold_epoch(next, &new, &record, &oid, 0)?;
        self.update_account(&token, |_| {}).await?;
        // Every chat is pushed again under the new epoch (Synced.key_id is now behind).
        self.sync_once().await?;
        Ok(self.changed())
    }

    async fn delete_all(&self) -> Result<Value, String> {
        let token = self.token()?;
        // A device holding the current keys proves it; one that doesn't falls back to a fresh sign-in.
        let _ = self.refresh().await;
        if let Some(current) = self.remote_key().filter(|k| *k == self.key_id() && self.keyring(*k).is_some()) {
            let _ = self.prove(&token, current).await;
        }
        self.api.send(&token, reqwest::Method::DELETE, "/v1/sync", None).await.map_err(|err| {
            if err.code == "needs-fresh-sign-in" {
                "To delete everything without a synced device, sign out and sign in again first.".to_string()
            } else {
                err.message
            }
        })?;
        self.forget_keys();
        self.edit(|s| s.reset_sync())?;
        let _ = self.refresh().await;
        Ok(self.changed())
    }

    // ------------------------------------------------------------------- sync

    fn remote_key(&self) -> Option<u32> {
        lock(&self.live).remote.as_ref().and_then(|r| r["currentKeyId"].as_u64()).and_then(|k| u32::try_from(k).ok())
    }

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
                s.last_sync_at = Some(nekko_js::now_ms_f64());
            }
        })?;
        self.changed();
        result
    }

    async fn pass(self: &Arc<Self>, token: &str) -> Result<(), String> {
        self.refresh().await?;
        let held = lock(&self.state).key_id;
        let remote_key = self.remote_key();
        if held.is_some() && remote_key.is_none() {
            // Everything synced was deleted (on another device, or by the server).
            self.forget_keys();
            self.edit(|s| s.reset_sync())?;
            return Err("Everything synced was deleted from Nekko Cloud. Turn sync on to start again.".into());
        }
        if self.keyring(self.key_id()).is_none() {
            if !self.finish_join(token).await? {
                return Ok(()); // still waiting to be approved
            }
        } else {
            // Signed in again since this device registered: bind the new token to it.
            self.ensure_device(token, None).await?;
        }
        let remote_key = remote_key.unwrap_or(0);
        if remote_key < self.key_id() {
            return Err("Nekko Cloud reports an older sync key than this device holds. Nothing was synced.".into());
        }
        if remote_key > self.key_id() && !self.adopt(token, remote_key).await? {
            return Ok(()); // the new epoch's record isn't written yet
        }
        for _ in 0..3 {
            if !self.pull(token).await? {
                // A newer epoch appeared mid-pull.
                let top = self.refresh().await.ok().and_then(|_| self.remote_key()).unwrap_or(0);
                if !self.adopt(token, top).await? {
                    return Ok(());
                }
                continue;
            }
            self.prove(token, self.key_id()).await?;
            if !self.push(token).await? {
                return Ok(());
            }
        }
        Ok(())
    }

    /// Pull and apply everything new. False when it stopped at a record under
    /// a newer key epoch than this device holds (it stays unread until then).
    async fn pull(&self, token: &str) -> Result<bool, String> {
        let account_id = self.account_id()?;
        loop {
            let since = lock(&self.state).cursor;
            let page =
                self.api.get(token, &format!("/v1/sync/pull?since={since}&limit={PULL_PAGE}")).await.map_err(e)?;
            let objects = page["objects"].as_array().cloned().unwrap_or_default();
            let held = self.key_id();
            for o in &objects {
                if o["keyId"].as_u64().is_some_and(|k| k > u64::from(held)) {
                    return Ok(false);
                }
                self.apply(&account_id, o)?;
                if let Some(seq) = o["seq"].as_u64() {
                    self.edit(|s| s.cursor = s.cursor.max(seq))?;
                }
            }
            let next = page["next"].as_u64().unwrap_or(since);
            self.edit(|s| s.cursor = s.cursor.max(next))?;
            if page["more"].as_bool() != Some(true) || objects.is_empty() {
                return Ok(true);
            }
        }
    }

    /// Open and apply one pulled object. Only records under the epoch this
    /// device holds count: an older epoch's are what a revoked device could
    /// still write. Anything that doesn't open, or isn't newer than a revision
    /// seen before (a rollback), is ignored.
    fn apply(&self, account_id: &str, o: &Value) -> Result<(), String> {
        let (Some(collection), Some(oid), Some(rev), Some(kid), Some(blob)) = (
            o["collection"].as_str(),
            o["objectId"].as_str(),
            o["revision"].as_u64(),
            o["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()),
            o["blob"].as_str(),
        ) else {
            return Ok(());
        };
        let key_id = self.key_id();
        if kid != key_id || lock(&self.state).revisions.get(oid).is_some_and(|seen| *seen >= rev) {
            return Ok(());
        }
        let Some(keyring) = self.keyring(kid) else { return Ok(()) };
        match collection {
            records::ACCOUNT => {
                if Self::account_oid(&keyring, kid).as_deref() != Ok(oid) {
                    return Ok(());
                }
                if let Ok((record, oid, rev)) = self.open_account(&keyring, account_id, kid, o) {
                    self.keep_account(&record, &oid, rev)?;
                    let me = lock(&self.state).device_id.clone().unwrap_or_default();
                    if !record.trusts(&me) {
                        return Err(REMOVED.into());
                    }
                }
            }
            records::CHAT => {
                let Ok(plain) = open_record(&keyring, account_id, kid, collection, oid, rev, blob) else {
                    return Ok(());
                };
                let Some(rec) = records::parse_chat(&plain) else { return Ok(()) };
                let id = match &rec {
                    ChatRecord::Chat(c) => c["id"].as_str().unwrap_or("").to_string(),
                    ChatRecord::Deleted { .. } => {
                        // A tombstone names its chat only through the object id: find it among ours.
                        let known = lock(&self.state).chats.keys().cloned().collect::<Vec<_>>();
                        match known.into_iter().find(|id| object_id(&keyring, records::CHAT, id).as_deref() == Ok(oid))
                        {
                            Some(id) => id,
                            None => {
                                return self.edit(|s| {
                                    s.revisions.insert(oid.into(), rev);
                                });
                            }
                        }
                    }
                };
                // The record must be the one filed under this chat's id: the server can't swap chats.
                if object_id(&keyring, records::CHAT, &id).as_deref() != Ok(oid) || !nekko_store::valid_id(&id) {
                    return Ok(());
                }
                let local = self.sessions.get(&id);
                let busy = (self.busy)(&id);
                match rec {
                    ChatRecord::Chat(chat) => {
                        let theirs = records::updated_at(&chat);
                        let newer = local.as_ref().is_none_or(|l| theirs > records::updated_at(l));
                        let same = local.as_ref().is_some_and(|l| theirs == records::updated_at(l));
                        if newer && !busy && self.sessions.put_synced(&chat).is_ok() {
                            lock(&self.live).pulled += 1;
                        }
                        let synced =
                            Synced { updated_at: theirs, digest: records::digest(&plain), deleted: false, key_id: kid };
                        self.edit(|s| {
                            s.revisions.insert(oid.into(), rev);
                            // Only when we took it (or already had it); otherwise our newer copy still needs pushing.
                            if (newer && !busy) || same {
                                s.chats.insert(id.clone(), synced);
                            }
                        })?;
                    }
                    ChatRecord::Deleted { at } => {
                        if let Some(l) = &local
                            && records::updated_at(l) <= at
                            && !busy
                        {
                            let _ = self.sessions.delete(&id);
                        }
                        self.edit(|s| {
                            s.revisions.insert(oid.into(), rev);
                            s.chats.insert(
                                id.clone(),
                                Synced { updated_at: at, digest: String::new(), deleted: true, key_id: kid },
                            );
                        })?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Push what changed here, and anything last written under an older
    /// epoch. True when a conflict needs another pass.
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
            let known = st.chats.get(id).filter(|k| k.key_id == key_id);
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
                    queue.push((id.to_string(), plain, Synced { updated_at: updated, digest, deleted: false, key_id }));
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
                let at = nekko_js::now_ms_f64();
                queue.push((
                    id.clone(),
                    records::tombstone(at),
                    Synced { updated_at: at, digest: String::new(), deleted: true, key_id },
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
                let seen = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0);
                let revision = seen + 1;
                let blob = seal_record(&keyring, &account_id, key_id, records::CHAT, &oid, revision, plain)
                    .map_err(|err| err.to_string())?;
                objects.push(json!({ "collection": records::CHAT, "objectId": oid, "revision": revision, "keyId": key_id, "blob": blob }));
                meta.push((id.clone(), oid, revision, seen, synced.clone()));
            }
            let res = self
                .api
                .send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": objects })))
                .await
                .map_err(e)?;
            let results = res["results"].as_array().cloned().unwrap_or_default();
            for ((id, oid, revision, seen, synced), r) in meta.into_iter().zip(results) {
                match r["status"].as_str() {
                    Some("ok") => {
                        lock(&self.live).pushed += 1;
                        self.edit(|s| {
                            s.revisions.insert(oid, revision);
                            s.chats.insert(id, synced);
                        })?;
                    }
                    Some("conflict") => {
                        // Another device wrote it: pull, merge by updatedAt, and try again. The
                        // server's revision can only be ahead of ours; behind is a rollback.
                        if r["revision"].as_u64().unwrap_or(0) < seen {
                            return Err("Nekko Cloud sent an older copy of a chat than this device has seen. Nothing more was synced.".into());
                        }
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

const REMOVED: &str = "This device was removed from sync on another device.";
