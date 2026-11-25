//! Nekko Cloud for the engine daemon (`cloud:*`, `sync:*`).
//!
//! **Sign-in.** Supabase Auth proves who the user is (an emailed code, or
//! GitHub, Google or Apple in the browser with PKCE and a loopback redirect).
//! The Supabase access token is traded once for this device's Nekko Cloud
//! token and dropped; the token goes in the [`vault`].
//!
//! **Sync (Pro and Enterprise).** Every chat is sealed on this device with
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

mod coalesce;
mod fleet_link;
mod http;
pub mod library;
mod org_records;
mod orgs;
mod pace;
pub mod records;
pub mod relay_channel;
pub mod state;
pub use nekko_vault as vault;

use http::{Api, HttpError, Supabase};
use library::{LIBRARY, LibraryRecord};
use nekko_store::SessionStore;
use nekko_sync::{
    DeviceKey, JoinCode, Keyring, Recipient, RecoveryKey, b64_decode, b64_encode, epoch_proof, fingerprint, object_id,
    open_record, open_recovery, seal_record, seal_recovery, unwrap_join, unwrap_keyring, wrap_for_join, wrap_keyring,
};
use records::{AccountRecord, ChatRecord, Skip, TrustedDevice};
use serde_json::{Value, json};
use state::{Account, LibrarySynced, State, Synced};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use vault::Vault;
use zeroize::Zeroize;

pub use fleet_link::{ConnectInfo, FleetAdmitted, FleetTarget, HelloBinding};
pub use http::client;
pub use org_records::LocalModel;
/// How many wanted pictures are fetched at once.
const PICTURE_FETCHES: usize = 3;

pub use orgs::{HEARTBEAT, HostInfo, ModelFuture};

pub const CHANNELS: &[&str] = &[
    "cloud:status",
    "cloud:refresh",
    "cloud:sendCode",
    "cloud:verifyCode",
    "cloud:beginOAuth",
    "cloud:cancelOAuth",
    "cloud:signOut",
    "cloud:deleteAccount",
    "cloud:billingPlans",
    "cloud:billingCheckout",
    "cloud:billingPortal",
    "cloud:teamFeatures",
    "cloud:setTeamFeature",
    "sync:turnOn",
    "sync:confirmRecoveryKey",
    "sync:restore",
    "sync:requestJoin",
    "sync:approve",
    "sync:revoke",
    "sync:now",
    "sync:setEnabled",
    "sync:setKind",
    "sync:deleteAll",
    "library:sync",
    "org:list",
    "org:create",
    "org:get",
    "org:invite",
    "org:revokeInvite",
    "org:acceptInvite",
    "org:removeMember",
    "org:rename",
    "org:delete",
    "fleet:setSharing",
    "fleet:list",
    "fleet:status",
];

/// Pushed whenever the status changes (the animation follows `sync.phase` and `sync.progress`).
pub const EVENT: &str = "cloud:status";

/// The OAuth providers offered next to the emailed code.
pub const OAUTH_PROVIDERS: &[&str] = &["github", "google", "apple"];

const PUSH_BATCH: usize = 50;
/// Plaintext per push request; a chat bigger than this goes alone. Base64 of a full batch, or of
/// one chat at `records::MAX_CHAT_BYTES`, stays under the 24 MiB push body Nekko Cloud accepts.
const PUSH_BYTES: usize = 6 << 20;

/// Split queued records (their plaintext sizes, in order) into push requests.
fn push_batches(sizes: &[usize]) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let (mut start, mut bytes) = (0, 0);
    for (i, &n) in sizes.iter().enumerate() {
        if i > start && (i - start == PUSH_BATCH || bytes + n > PUSH_BYTES) {
            out.push(start..i);
            (start, bytes) = (i, 0);
        }
        bytes += n;
    }
    if start < sizes.len() {
        out.push(start..sizes.len());
    }
    out
}
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
    /// The last `GET /v1/orgs` list, for the `orgs` summary on the status.
    orgs: Option<Vec<Value>>,
    /// How sharing with each org is going.
    shares: BTreeMap<String, orgs::ShareLive>,
    /// Computers of this account that can be reached, from the last fleet
    /// lists (`org/device`), with how to reach them (decision 0102).
    fleet_targets: BTreeMap<String, fleet_link::FleetTarget>,
    /// A fleet HELLO named a device or epoch this computer hadn't heard of: reading the account again.
    fleet_catching_up: bool,
    /// Library files the last pass could not sync, per path, and why (`tooLarge`, `unreadable`).
    library_skipped: BTreeMap<String, &'static str>,
    /// Library files being pushed right now.
    library_sending: BTreeSet<String>,
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
    /// What the daemon says about this computer (name, models, version) for org descriptors.
    host: Mutex<Option<Arc<HostInfo>>>,
    /// One publish, withdrawal or sharing change at a time.
    share: tokio::sync::Mutex<()>,
    /// The Nekko Cloud Relay account channel: presence and sync nudges (decision 0116).
    relay: relay_channel::Channel,
    /// When `refresh` last finished; held while `cloud:refresh` runs so concurrent callers share it.
    refreshed: tokio::sync::Mutex<coalesce::Refreshed>,
    /// Relay tickets kept until they are due for renewal (`renewAfterSeconds`).
    tickets: pace::Tickets,
    /// A pass started by a Relay nudge is waiting out its jitter; more nudges join it.
    nudge_pending: pace::Pending,
    /// The lease, in seconds, the API last said it granted this computer's heartbeat (0: not known).
    lease_seconds: std::sync::atomic::AtomicU64,
    /// A nudge in that burst said settings or organizations changed: the pass reads the account in full.
    nudge_full: std::sync::atomic::AtomicBool,
    /// The longest a nudge's pass is held, in milliseconds (a field so tests need not wait).
    nudge_window_ms: std::sync::atomic::AtomicU64,
    /// When the account and sync state were last read in full.
    full_read: Mutex<pace::FullRead>,
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
            host: Mutex::new(None),
            share: tokio::sync::Mutex::new(()),
            relay: relay_channel::Channel::default(),
            refreshed: tokio::sync::Mutex::new(coalesce::Refreshed::default()),
            tickets: pace::Tickets::default(),
            nudge_pending: pace::Pending::default(),
            lease_seconds: std::sync::atomic::AtomicU64::new(0),
            nudge_full: Default::default(),
            nudge_window_ms: std::sync::atomic::AtomicU64::new(pace::NUDGE_WINDOW.as_millis() as u64),
            full_read: Mutex::default(),
        })
    }

    /// Sync in the background while it is on. Without the Relay account channel the pass runs about
    /// every `every`; with it up, changes arrive as nudges and the timer is a 5 minute safety poll.
    /// A timer pass only pulls (one call); the account and sync state are read in full on start, on
    /// a settings or organizations nudge, on a user action, when a pull meets a newer key epoch, and
    /// every 10 minutes. Each computer starts at a random point in the first quarter of the
    /// interval and each wait varies by 20% either way, so computers that started or stalled
    /// together don't call Nekko Cloud together. The loop also looks at the clock every 30 s: a
    /// jump means the computer woke from sleep, and it pulls at once.
    pub fn start(self: &Arc<Self>, every: Duration) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(pace::start_offset(every, pace::unit())).await;
            let mut watch = pace::WakeWatch::new(std::time::SystemTime::now());
            loop {
                if me.ready() {
                    let _ = me.sync_quick().await;
                }
                let spread = pace::unit();
                let mut waited = Duration::ZERO;
                loop {
                    // The target follows the channel: it may come up or go down while waiting.
                    let target = pace::jittered(pace::poll_interval(me.relay.connected(), every), spread);
                    if waited >= target {
                        break;
                    }
                    let step = (target - waited).min(pace::WAKE_TICK);
                    tokio::time::sleep(step).await;
                    waited += step;
                    if watch.woke(std::time::SystemTime::now()) {
                        // Several computers may wake together (a shared power event): don't call in step.
                        tokio::time::sleep(pace::nudge_delay(pace::NUDGE_WINDOW, pace::unit())).await;
                        break;
                    }
                }
            }
        });
        // Sharing with organizations: a beat about every 30 seconds (it also picks up after sleep or a lost
        // connection). On the Relay channel, with an API lease that outlasts it, every 10 minutes (see
        // `orgs::heartbeat_wait`; off in this build). A descriptor is published only when it changed.
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(pace::start_offset(HEARTBEAT, pace::unit())).await;
            loop {
                me.share_tick().await;
                tokio::time::sleep(pace::jittered(me.next_heartbeat(), pace::unit())).await;
            }
        });
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        match channel {
            "cloud:status" => Ok(self.status()),
            "cloud:refresh" => {
                self.refresh_coalesced().await?;
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
            "cloud:deleteAccount" => self.delete_account().await,
            // Plans and billing (#2724): the app opens the answered `url` in the browser.
            "cloud:billingPlans" => self.api.get(&self.token()?, "/v1/billing/plans").await.map_err(e),
            "cloud:billingCheckout" => {
                let body = json!({ "plan": arg(args, 0) });
                self.api
                    .send(&self.token()?, reqwest::Method::POST, "/v1/billing/checkout", Some(body))
                    .await
                    .map_err(e)
            }
            "cloud:billingPortal" => {
                self.api.send(&self.token()?, reqwest::Method::POST, "/v1/billing/portal", None).await.map_err(e)
            }
            // Team accounts only (decision 0092); the API answers 404 to everyone else.
            "cloud:teamFeatures" => self.api.get(&self.token()?, "/v1/staff/features").await.map_err(e),
            "cloud:setTeamFeature" => {
                let key = arg(args, 0);
                if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
                    return Err("Unknown feature.".into());
                }
                let path = format!("/v1/staff/features/{key}");
                let body = json!({ "state": arg(args, 1) });
                let out = self.api.send(&self.token()?, reqwest::Method::PUT, &path, Some(body)).await.map_err(e)?;
                // What this account sees follows the switch at once.
                self.refresh().await?;
                self.changed();
                Ok(out)
            }
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
            // One kind of record (`chats`, `library`) on or off for this computer (#3089).
            "sync:setKind" => {
                let kind = arg(args, 0);
                let on = args.get(1).and_then(Value::as_bool).unwrap_or(false);
                let mut known = false;
                self.edit(|s| known = s.set_kind(&kind, on))?;
                if !known {
                    return Err("Unknown kind of sync.".into());
                }
                if on && self.ready() {
                    self.kick();
                }
                Ok(self.changed())
            }
            "sync:deleteAll" => self.delete_all().await,
            // The files Library lists on this computer (#2748). Kept only while Library sync is
            // available to this account; a new or changed file starts a sync at once.
            "library:sync" => {
                if !self.library_available() {
                    return Ok(self.status());
                }
                let files = library::files_from_app(args.first().unwrap_or(&Value::Null));
                let mut fresh = false;
                self.edit(|s| {
                    for f in files {
                        if s.library_files.len() >= library::MAX_FILES && !s.library_files.contains_key(&f.path) {
                            continue;
                        }
                        if s.library_files.get(&f.path) != Some(&f) {
                            fresh = true;
                            s.library_files.insert(f.path.clone(), f);
                        }
                    }
                })?;
                if fresh && self.ready() && lock(&self.state).kind_on("library") {
                    self.kick();
                }
                Ok(self.changed())
            }
            c if c.starts_with("org:") || c.starts_with("fleet:") => self.route_org(c, args).await,
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

    /// A Nekko Cloud Relay ticket (decision 0116): `agent` for this computer's
    /// relay room, `account` for the account channel. The ticket, and how long
    /// to keep it before asking for the next. Errors are what the owner reads.
    pub async fn relay_ticket(&self, scope: &str, room: Option<&str>) -> Result<(String, Duration), String> {
        let token = self.token().map_err(|_| "Sign in to Nekko Cloud to use Nekko Cloud Relay.".to_string())?;
        // Kept until it is due for renewal: a redial, or a second user of the same room, doesn't ask again.
        if let Some(held) = self.tickets.get(&token, scope, room, Instant::now()) {
            return Ok(held);
        }
        let mut body = json!({ "scope": scope });
        if let Some(room) = room {
            body["room"] = json!(room);
        }
        match self.api.send(&token, reqwest::Method::POST, "/v1/relay/ticket", Some(body)).await {
            Ok(v) => {
                let ticket = v["ticket"]
                    .as_str()
                    .filter(|t| t.starts_with("nkr1."))
                    .ok_or("Nekko Cloud sent no relay ticket.")?;
                // At least a minute, so a short answer can't make the agent ask in a loop.
                let renew = Duration::from_secs(v["renewAfterSeconds"].as_u64().unwrap_or(3 * 3600).max(60));
                self.tickets.put(&token, scope, room, ticket, renew, Instant::now());
                Ok((ticket.to_string(), renew))
            }
            Err(err) => Err(match (err.status, err.code.as_str()) {
                (402, _) => "Nekko Cloud Relay is part of Nekko Cloud Pro. Upgrade, or use Tailscale for free.".into(),
                (404, _) => "Nekko Cloud Relay isn't available for this account yet.".into(),
                (401, _) => "Sign in to Nekko Cloud again to use Nekko Cloud Relay.".into(),
                _ => format!("Couldn't get a Nekko Cloud Relay ticket: {}", err.message),
            }),
        }
    }

    fn key_id(&self) -> u32 {
        lock(&self.state).key_id.unwrap_or(0)
    }

    fn account(&self) -> Option<Account> {
        lock(&self.state).account.clone()
    }

    /// Signed in with a Nekko team account (decision 0092).
    pub fn is_staff(&self) -> bool {
        self.account().is_some_and(|a| a.staff)
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

    /// Library sync is open to this account: a plan that syncs and the `library-cloud` switch.
    fn library_available(&self) -> bool {
        lock(&self.state).account.as_ref().is_some_and(|a| a.can_sync && a.library_cloud)
    }

    /// Where other computers' Library files are copied.
    fn library_dir(&self) -> PathBuf {
        self.dir.join("library")
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
        // Library sync (#2748): each listed file's state, and other computers' files. Null when it
        // isn't open to this account, so the app shows no trace of it.
        let library = if s.account.as_ref().is_some_and(|a| a.can_sync && a.library_cloud) {
            let key = s.key_id.unwrap_or(0);
            let on = has_keys && s.enabled && s.kind_on("library");
            let files: serde_json::Map<String, Value> = s
                .library_files
                .keys()
                .map(|p| {
                    let state = if !on {
                        "off"
                    } else if live.library_sending.contains(p) {
                        "syncing"
                    } else if let Some(why) = live.library_skipped.get(p) {
                        why
                    } else if s.library.get(p).is_some_and(|k| !k.deleted && k.key_id == key) {
                        "synced"
                    } else {
                        "pending"
                    };
                    (p.clone(), json!(state))
                })
                .collect();
            let remote: Vec<Value> = s
                .library_remote
                .iter()
                // Include files with a local copy, and thumb-only files that have a thumbnail.
                .filter(|(_, f)| !f.copy.is_empty() || (f.thumb_only && !f.thumbnail_data.is_empty()))
                .map(|(id, f)| {
                    // Thumb-only files have no local copy; expose the original path instead.
                    let path = if f.thumb_only { f.path.clone() } else { f.copy.clone() };
                    let mut obj = json!({
                        "id": id, "deviceId": f.device_id, "device": f.device, "path": path, "originalPath": f.path,
                        "title": f.title, "kind": f.kind, "chat": f.chat, "modifiedAt": f.modified_at, "size": f.size,
                    });
                    if !f.thumbnail_data.is_empty() {
                        obj["thumbnailData"] = json!(f.thumbnail_data);
                    }
                    if f.thumb_only {
                        obj["thumbOnly"] = json!(true);
                    }
                    obj
                })
                .collect();
            json!({ "on": on, "files": files, "remote": remote })
        } else {
            Value::Null
        };
        json!({
            "signedIn": signed_in,
            // Decision 0116: the account channel, while this account may use Nekko Cloud Relay.
            "relay": if self.relay_included() { self.relay.status() } else { Value::Null },
            "account": s.account.as_ref().map(|a| json!({
                "email": a.email, "plan": a.plan, "canSync": a.can_sync,
                "staff": a.staff, "features": { "billing": a.billing, "libraryCloud": a.library_cloud, "cloudRelay": a.cloud_relay },
            })),
            "library": library,
            "oauthPending": live.oauth.is_some(),
            "keysStoredIn": self.vault.kind(),
            "orgs": orgs::orgs_summary(&s, &live),
            "sync": {
                "phase": phase,
                "enabled": s.enabled,
                // What syncs on this computer, kind by kind (#3089).
                "kinds": { "chats": s.kind_on("chats"), "library": s.kind_on("library") },
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

    /// `cloud:refresh` from a window: the account and sync state are read again unless a refresh
    /// finished in the last few seconds (Settings > Sync on every mount, sign-in and Plan on every
    /// window focus all ask), and callers that arrive together share one.
    async fn refresh_coalesced(&self) -> Result<(), String> {
        let token = self.token()?;
        let mut last = self.refreshed.lock().await;
        if last.is_fresh(&token, Instant::now(), coalesce::REFRESH_WITHIN) {
            return Ok(());
        }
        self.refresh().await?;
        last.mark(&token, Instant::now());
        Ok(())
    }

    /// Fetch the account and the sync state from Nekko Cloud.
    async fn refresh(&self) -> Result<(), String> {
        let token = self.token()?;
        let me = self.api.get(&token, "/v1/auth/me").await.map_err(e)?;
        let account = Account::from_api(&me["account"]);
        self.edit(|s| s.account = Some(account))?;
        let remote = self.api.get(&token, "/v1/sync/state").await.map_err(e)?;
        lock(&self.live).remote = Some(remote);
        lock(&self.full_read).done(&token, Instant::now());
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
        let account = Account::from_api(&res["account"]);
        let other_account = lock(&self.state).account.as_ref().is_some_and(|old| old.id != account.id);
        if other_account {
            // This computer leaves the old account's org lists, then another account's keys never mix with this one's.
            let old = self.vault.get("token");
            self.withdraw_all(old.as_deref()).await;
            lock(&self.live).orgs = None;
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
        let token = self.token().ok();
        // This computer stops sharing and leaves every org's list while its token still works.
        self.withdraw_all(token.as_deref()).await;
        if let Some(token) = token {
            let _ = self.api.send(&token, reqwest::Method::DELETE, "/v1/auth/session", None).await;
        }
        self.vault.delete("token");
        // The device key and keyrings stay: signing in again to the same account
        // picks sync up where it was. Another account's sign-in clears them.
        self.edit(|s| s.enabled = false)?;
        {
            let mut live = lock(&self.live);
            live.remote = None;
            live.orgs = None;
            // How to reach this account's computers goes with the sign-in.
            live.fleet_targets.clear();
        }
        Ok(self.changed())
    }

    /// `DELETE /v1/account`: Nekko Cloud erases the account, its synced data
    /// and its cloud machines. Only once it says so (204) does this device
    /// forget its token, keys and sync state; any other answer keeps them.
    async fn delete_account(&self) -> Result<Value, String> {
        let token = self.token()?;
        match self.api.send(&token, reqwest::Method::DELETE, "/v1/account", None).await {
            Ok(_) => {}
            Err(err) if err.status == 401 => {
                return Err("You're signed out of Nekko Cloud. Sign in again, then delete the account.".into());
            }
            Err(err) if err.status == 502 && err.code == "billing-teardown-failed" => {
                return Err("Nekko Cloud couldn't cancel your subscription, so your account was not deleted. Try again in a few minutes.".into());
            }
            Err(err) if err.status == 502 => {
                return Err("Nekko Cloud couldn't shut down your cloud computer, so your account was not deleted. Try again in a few minutes.".into());
            }
            Err(err) => return Err(err.message),
        }
        self.forget_this_device()?;
        Ok(self.changed())
    }

    /// Forget Nekko Cloud on this device: the token, the device key, every
    /// keyring and the sync state, from the OS keystore and the cloud folder.
    /// Nothing is sent: [`Self::sign_out`] first to end the session too.
    pub fn forget_this_device(&self) -> Result<(), String> {
        // Leave the org lists while the token still exists (in the background; nothing waits on the network).
        self.withdraw_in_background(self.vault.get("token"));
        self.forget_keys();
        self.vault.delete("token");
        let label = lock(&self.state).device_label.clone();
        *lock(&self.state) = State { device_label: label, ..State::default() };
        *lock(&self.live) = Live::default();
        match std::fs::remove_file(State::path(&self.dir)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    /// `cloud:signOut`, for Delete everything.
    pub async fn sign_out_and_forget(&self) -> Result<(), String> {
        self.sign_out().await?;
        self.forget_this_device()
    }

    fn forget_keys(&self) {
        let top = lock(&self.state).key_id.unwrap_or(0);
        for k in 1..=top.max(1) {
            self.vault.delete(&format!("keyring:{k}"));
        }
        self.vault.delete("device-key");
        self.vault.delete("join-code");
        self.forget_org_keys();
        lock(&self.live).proven = None;
        // Other computers' Library files were copies of synced data: they go with the keys.
        let _ = std::fs::remove_dir_all(self.library_dir());
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
            return Err("Sync needs a Pro or Enterprise plan.".into());
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
        // And hold every org key this account has: they are written again under the new epoch.
        self.collect_all_org_keys(&token).await;
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
        // Org keys follow the account to the new epoch, and each org this account can rotate gets a
        // new key too: the removed device may have held the old one. Best effort; the next list retries.
        let _ = self.reseal_org_keys(&token).await;
        let _ = self.rotate_org_keys(&token).await;
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
        {
            let mut live = lock(&self.live);
            live.shares.clear();
            live.orgs = None;
        }
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

    /// One pass, from a user action: the account and sync state are read in full first, then one
    /// pull and push, repeated (up to three times) while pushes conflict.
    pub async fn sync_once(self: &Arc<Self>) -> Result<(), String> {
        self.sync_with(false).await
    }

    /// A pass from a timer, a nudge, the channel coming up or a wake from sleep: it only pulls (and
    /// pushes what changed here), without reading the account and sync state again, unless a full
    /// read is due (on start, asked for by a settings or organizations nudge, or 10 minutes old).
    pub async fn sync_quick(self: &Arc<Self>) -> Result<(), String> {
        let token = self.token()?;
        let due = lock(&self.full_read).due(&token, Instant::now()) || lock(&self.live).remote.is_none();
        self.sync_with(!due).await
    }

    async fn sync_with(self: &Arc<Self>, pull_only: bool) -> Result<(), String> {
        let _one = self.run.lock().await;
        let token = self.token()?;
        {
            let mut live = lock(&self.live);
            live.syncing = true;
            live.pushed = 0;
            live.pulled = 0;
        }
        self.changed();
        let result = self.pass(&token, pull_only).await;
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
        // Something new is in Nekko Cloud: the account's other devices pull now (decision 0116).
        if err.is_none() && lock(&self.live).pushed > 0 {
            self.relay.nudge("sync");
        }
        self.changed();
        result
    }

    async fn pass(self: &Arc<Self>, token: &str, pull_only: bool) -> Result<(), String> {
        if !pull_only {
            self.refresh().await?;
        }
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
            // Pictures chats here are still waiting for; one that fails waits for the next pass.
            let _ = self.fetch_wanted_pictures(token).await;
            self.prove(token, self.key_id()).await?;
            let chats_again = self.push(token).await?;
            let library_again = self.push_library(token).await?;
            if !chats_again && !library_again {
                return Ok(());
            }
        }
        // Org keys written under an older account epoch are written again for the other devices.
        let _ = self.reseal_org_keys(token).await;
        Ok(())
    }

    /// Pull and apply everything new. False when it stopped at a record under
    /// a newer key epoch than this device holds (it stays unread until then).
    /// A record whose kind is off here is passed over unapplied (`State::kinds_off`).
    /// A kind turned back on mid-pull moves the cursor back: the pull notices
    /// (`State::rewinds`) and carries on from there rather than past it.
    async fn pull(&self, token: &str) -> Result<bool, String> {
        let account_id = self.account_id()?;
        'pages: loop {
            let (since, rewinds) = {
                let s = lock(&self.state);
                (s.cursor, s.rewinds)
            };
            let page =
                self.api.get(token, &format!("/v1/sync/pull?since={since}&limit={PULL_PAGE}")).await.map_err(e)?;
            let objects = page["objects"].as_array().cloned().unwrap_or_default();
            let held = self.key_id();
            // Moves the cursor on, unless a kind came back on since this page began.
            let advance = |to: u64| -> Result<bool, String> {
                let mut rewound = false;
                self.edit(|s| {
                    if s.rewinds == rewinds {
                        s.cursor = s.cursor.max(to);
                    } else {
                        rewound = true;
                    }
                })?;
                Ok(!rewound)
            };
            for o in &objects {
                if o["keyId"].as_u64().is_some_and(|k| k > u64::from(held)) {
                    return Ok(false);
                }
                let skip = lock(&self.state).skips_collection(o["collection"].as_str().unwrap_or(""));
                if !skip {
                    self.apply(&account_id, o)?;
                }
                if let Some(seq) = o["seq"].as_u64()
                    && !advance(seq)?
                {
                    continue 'pages;
                }
            }
            let next = page["next"].as_u64().unwrap_or(since);
            if !advance(next)? {
                continue 'pages;
            }
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
        // A picture is checked against its own name, so an older revision of one is no rollback:
        // it is opened again when a chat here still wants it (fetched one by one).
        let seen_before = lock(&self.state).revisions.get(oid).is_some_and(|seen| *seen >= rev);
        if kid != key_id || (seen_before && collection != records::PICTURE) {
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
                    ChatRecord::Chat(mut chat) => {
                        let theirs = records::updated_at(&chat);
                        let me = lock(&self.state).device_id.clone().unwrap_or_default();
                        // Its pictures (#3298): the chat store puts each back from beside the
                        // chats; those not there yet are fetched after the pull.
                        let home = records::home_of(&chat).unwrap_or(&me).to_string();
                        let pictures: Vec<String> =
                            records::picture_refs(&chat).iter().map(|n| records::picture_local_id(&home, n)).collect();
                        let missing: Vec<String> = records::picture_refs(&chat)
                            .into_iter()
                            .filter(|n| !self.sessions.has_blob(n))
                            .map(|n| records::picture_local_id(&home, &n))
                            .collect();
                        // Whose chat it is (#3143): another computer's, this one's, or not said
                        // (a record from before records named their computer).
                        let named = records::home_of(&chat).is_some();
                        let foreign = records::home_of(&chat).is_some_and(|h| h != me);
                        let take = if foreign {
                            // A copy removed here stays removed.
                            let removed = lock(&self.state).chats.get(&id).is_some_and(|k| k.foreign && k.deleted);
                            // Its computer's copy wins, unless this computer carried on a chat
                            // nobody had claimed yet: then this one claims it with its newer copy.
                            !removed
                                && local
                                    .as_ref()
                                    .is_none_or(|l| records::home_of(l).is_some() || theirs >= records::updated_at(l))
                        } else {
                            local.as_ref().is_none_or(|l| theirs > records::updated_at(l))
                        };
                        let same = !foreign && local.as_ref().is_some_and(|l| theirs == records::updated_at(l));
                        if foreign {
                            // How the copy is arranged here is this computer's.
                            if let (Some(l), Some(o)) = (&local, chat.as_object_mut()) {
                                for key in records::KEPT_HERE {
                                    match l.get(key) {
                                        Some(v) => o.insert(key.into(), v.clone()),
                                        None => o.remove(key),
                                    };
                                }
                            }
                        } else if let Some(o) = chat.as_object_mut() {
                            // This computer's own chat: the file says nothing about a home.
                            o.remove(records::HOME);
                        }
                        if take && !busy && self.sessions.put_synced(&chat).is_ok() {
                            lock(&self.live).pulled += 1;
                        }
                        let synced = Synced {
                            updated_at: theirs,
                            digest: records::digest(&plain),
                            deleted: false,
                            key_id: kid,
                            homed: named,
                            foreign,
                            pictured: true,
                            pictures,
                        };
                        self.edit(|s| {
                            s.revisions.insert(oid.into(), rev);
                            // Only when we took it (or already had it); otherwise our newer copy still needs pushing.
                            if (take && !busy) || same {
                                s.chats.insert(id.clone(), synced);
                                s.pictures_wanted.extend(missing);
                            }
                        })?;
                    }
                    ChatRecord::Deleted { at } => {
                        let foreign = local.as_ref().is_some_and(|l| {
                            records::home_of(l).is_some_and(|h| Some(h) != lock(&self.state).device_id.as_deref())
                        });
                        if let Some(l) = &local
                            && (foreign || records::updated_at(l) <= at)
                            && !busy
                        {
                            let _ = self.sessions.delete(&id);
                        }
                        self.edit(|s| {
                            s.revisions.insert(oid.into(), rev);
                            s.chats.insert(
                                id.clone(),
                                Synced {
                                    updated_at: at,
                                    digest: String::new(),
                                    deleted: true,
                                    key_id: kid,
                                    homed: true,
                                    foreign,
                                    pictured: true,
                                    pictures: Vec::new(),
                                },
                            );
                        })?;
                    }
                }
            }
            records::PICTURE => self.apply_picture(&keyring, account_id, kid, oid, rev, blob, seen_before)?,
            LIBRARY => self.apply_library(&keyring, account_id, kid, oid, rev, blob)?,
            _ => {}
        }
        Ok(())
    }

    /// A chat's picture (#3298): kept beside the chats under its blob name, where a chat's
    /// `nekko-blob:` reference finds it. One that isn't the record filed under its computer and
    /// name, or whose bytes don't hash to its name, is ignored. A tombstone only notes that its
    /// computer's chats no longer refer to it; a copy here that still does keeps its picture.
    #[allow(clippy::too_many_arguments)]
    fn apply_picture(
        &self,
        keyring: &Keyring,
        account_id: &str,
        kid: u32,
        oid: &str,
        rev: u64,
        blob: &str,
        seen_before: bool,
    ) -> Result<(), String> {
        let Ok(plain) = open_record(keyring, account_id, kid, records::PICTURE, oid, rev, blob) else {
            return Ok(());
        };
        let Some(rec) = records::parse_picture(&plain) else { return Ok(()) };
        let local = rec.local_id();
        if object_id(keyring, records::PICTURE, &local).as_deref() != Ok(oid) {
            return Ok(());
        }
        let deleted = matches!(rec, records::PictureRecord::Deleted { .. });
        if let records::PictureRecord::Picture { name, bytes, .. } = &rec
            && self.sessions.put_blob(name, bytes).is_ok()
        {
            lock(&self.live).pulled += usize::from(!seen_before);
        }
        self.edit(|s| {
            s.pictures_wanted.remove(&local);
            if !seen_before {
                s.revisions.insert(oid.into(), rev);
                s.pictures.insert(local.clone(), state::PictureSynced { key_id: kid, deleted });
            }
        })
    }

    /// Fetch, a few at a time, the pictures chats here refer to that are not beside them yet (a chat
    /// that arrived before its picture, or a picture removed here since). One Nekko Cloud has no
    /// record of, or only a tombstone for, is no longer looked for.
    async fn fetch_wanted_pictures(&self, token: &str) -> Result<(), String> {
        let wanted: Vec<String> = lock(&self.state).pictures_wanted.iter().take(PULL_PAGE as usize).cloned().collect();
        if wanted.is_empty() {
            return Ok(());
        }
        let account_id = self.account_id()?;
        let Some(keyring) = self.keyring(self.key_id()) else { return Ok(()) };
        coalesce::for_each_bounded(wanted, PICTURE_FETCHES, |local| {
            let (account_id, keyring) = (&account_id, &keyring);
            async move {
                let name = local.rsplit('\n').next().unwrap_or("");
                if !self.sessions.has_blob(name) {
                    let oid = object_id(keyring, records::PICTURE, &local).map_err(|err| err.to_string())?;
                    match self.api.get(token, &format!("/v1/sync/objects/{}/{oid}", records::PICTURE)).await {
                        Ok(o) => self.apply(account_id, &o)?,
                        Err(err) if err.status == 404 => {}
                        Err(err) => return Err(e(err)),
                    }
                }
                // Arrived, or nothing more will: either way it is not looked for again.
                self.edit(|s| {
                    s.pictures_wanted.remove(&local);
                })
            }
        })
        .await
    }

    /// Another computer's Library file: a read-only copy under `<data>/cloud/library/<folder key>/`,
    /// replaced by each newer revision and removed by its tombstone. This computer's own records only
    /// move the revision on. A record that doesn't open, or isn't the one filed under its own
    /// computer and path, is ignored. Applied whatever the switch says, so nothing pulled is lost.
    fn apply_library(
        &self,
        keyring: &Keyring,
        account_id: &str,
        kid: u32,
        oid: &str,
        rev: u64,
        blob: &str,
    ) -> Result<(), String> {
        let Ok(plain) = open_record(keyring, account_id, kid, LIBRARY, oid, rev, blob) else { return Ok(()) };
        let Some(rec) = library::parse(&plain) else { return Ok(()) };
        if object_id(keyring, LIBRARY, &rec.local_id()).as_deref() != Ok(oid) {
            return Ok(());
        }
        let mine = lock(&self.state).device_id.clone().unwrap_or_default();
        let from = match &rec {
            LibraryRecord::File(f, _) => f.device_id.clone(),
            LibraryRecord::Deleted { device_id, .. } => device_id.clone(),
        };
        if from == mine {
            return self.edit(|s| {
                s.revisions.insert(oid.into(), rev);
            });
        }
        // The copy this record replaces, if any, goes first (and its folder, once empty).
        if let Some(old) = lock(&self.state).library_remote.get(oid).map(|f| PathBuf::from(&f.copy)) {
            let _ = std::fs::remove_file(&old);
            if let Some(dir) = old.parent() {
                let _ = std::fs::remove_dir(dir);
            }
        }
        match rec {
            LibraryRecord::File(mut f, data) => {
                if f.thumb_only {
                    // Thumb-only record (#3044): the file was too large on the other computer.
                    // Store the metadata and thumbnail but write nothing to disk.
                    lock(&self.live).pulled += 1;
                    return self.edit(|s| {
                        s.revisions.insert(oid.into(), rev);
                        s.library_remote.insert(oid.into(), f);
                    });
                }
                // Files from one folder on one computer share a folder here, so a design's
                // numbered versions still read as one design.
                let folder = self.library_dir().join(library::folder_key(&f.device_id, &f.path));
                let copy = folder.join(library::safe_name(&f.path));
                let written = std::fs::create_dir_all(&folder).and_then(|_| std::fs::write(&copy, &data)).is_ok();
                if written {
                    f.copy = copy.to_string_lossy().into_owned();
                    lock(&self.live).pulled += 1;
                }
                self.edit(|s| {
                    s.revisions.insert(oid.into(), rev);
                    if written {
                        s.library_remote.insert(oid.into(), f);
                    } else {
                        s.library_remote.remove(oid);
                    }
                })
            }
            LibraryRecord::Deleted { .. } => self.edit(|s| {
                s.revisions.insert(oid.into(), rev);
                s.library_remote.remove(oid);
            }),
        }
    }

    /// Push what changed here, and anything last written under an older
    /// epoch. True when a conflict needs another pass. Nothing while Chats is
    /// off here: chats changed or deleted meanwhile go up once it is back on.
    async fn push(&self, token: &str) -> Result<bool, String> {
        if !lock(&self.state).kind_on("chats") {
            lock(&self.live).skipped.clear();
            return Ok(false);
        }
        let account_id = self.account_id()?;
        let key_id = self.key_id();
        let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
        let st = lock(&self.state).clone();
        let mut queue: Vec<(String, Vec<u8>, Synced)> = Vec::new();
        // Chats synced before pictures did that hold none: noted, not sent again.
        let mut pictured: Vec<String> = Vec::new();
        let mut skipped: BTreeMap<&'static str, usize> = BTreeMap::new();
        let me = st.device_id.clone().ok_or("This device isn't registered for sync.")?;
        let summaries = self.sessions.summaries();
        let here: BTreeSet<String> = summaries.iter().filter_map(|s| s["id"].as_str().map(String::from)).collect();
        for s in &summaries {
            let Some(id) = s["id"].as_str() else { continue };
            let updated = s["updatedAt"].as_f64().unwrap_or(0.0);
            // Another computer's chat: only that computer changes it (#3143). This computer pushes
            // its copy, as it is and still naming that computer, only to carry it into a newer key
            // epoch, so a chat of a removed computer stays readable to the computers left.
            let foreign = records::home_of(s).is_some_and(|h| h != me);
            if foreign && st.chats.get(id).is_none_or(|k| k.deleted || !k.foreign || k.key_id == key_id) {
                continue;
            }
            let known = st.chats.get(id).filter(|k| k.key_id == key_id);
            if known.is_some_and(|k| !k.deleted && k.homed && k.pictured && k.updated_at == updated) {
                continue;
            }
            let Some(chat) = self.sessions.get(id) else { continue };
            match records::chat_plaintext(&chat, &me, &st.device_label) {
                Ok(plain) => {
                    let digest = records::digest(&plain.bytes);
                    if known.is_some_and(|k| k.digest == digest) {
                        // Synced before pictures did, and has none: nothing to send again.
                        if known.is_some_and(|k| !k.pictured) {
                            pictured.push(id.to_string());
                        }
                        continue;
                    }
                    // Each picture is read again from beside the chats when it is sent.
                    let mut pictures = Vec::new();
                    for (name, bytes) in &plain.pictures {
                        if let Some(bytes) = bytes {
                            let _ = self.sessions.put_blob(name, bytes);
                        }
                        pictures.push(records::picture_local_id(&plain.home, name));
                    }
                    queue.push((
                        id.to_string(),
                        plain.bytes,
                        Synced {
                            updated_at: updated,
                            digest,
                            deleted: false,
                            key_id,
                            homed: true,
                            foreign,
                            pictured: true,
                            pictures,
                        },
                    ));
                }
                Err(skip) => {
                    *skipped
                        .entry(match skip {
                            Skip::Incognito => "incognito",
                            Skip::SyncOff => "syncOff",
                            Skip::TooLarge => "tooLarge",
                        })
                        .or_default() += 1;
                }
            }
        }
        // Chats deleted here since they were synced. Another computer's copy removed here is only
        // forgotten here: its computer still has it, and a newer copy isn't taken again.
        let mut removed_copies = Vec::new();
        for (id, k) in &st.chats {
            if !k.deleted && !here.contains(id) {
                if k.foreign {
                    removed_copies.push(id.clone());
                    continue;
                }
                let at = nekko_js::now_ms_f64();
                queue.push((
                    id.clone(),
                    records::tombstone(at),
                    Synced {
                        updated_at: at,
                        digest: String::new(),
                        deleted: true,
                        key_id,
                        homed: true,
                        foreign: false,
                        pictured: true,
                        pictures: Vec::new(),
                    },
                ));
            }
        }
        if !removed_copies.is_empty() || !pictured.is_empty() {
            self.edit(|s| {
                for id in &removed_copies {
                    if let Some(k) = s.chats.get_mut(id) {
                        k.deleted = true;
                    }
                }
                for id in &pictured {
                    if let Some(k) = s.chats.get_mut(id) {
                        k.pictured = true;
                    }
                }
            })?;
        }
        // Pictures go first, so a computer pulling the chat finds them already there (#3298).
        let (sends, removes) = picture_work(&st, &me, key_id, &queue, |name| self.sessions.has_blob(name));
        let (unsent, mut again) = self.push_pictures(token, &sends, false).await?;
        if unsent > 0 {
            skipped.insert("pictures", unsent);
        }
        lock(&self.live).skipped = skipped;
        let total = queue.len();
        let mut done = 0;
        let sizes: Vec<usize> = queue.iter().map(|(_, plain, _)| plain.len()).collect();
        for range in push_batches(&sizes) {
            let batch = &queue[range];
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
        // Then the pictures no chat of this computer refers to any more leave Nekko Cloud.
        if !removes.is_empty() {
            again |= self.push_pictures(token, &removes, true).await?.1;
        }
        Ok(again)
    }

    /// Push `picture` records (#3298), each read from beside the chats as its request is made,
    /// or (`gone`) their tombstones. Returns how many could not be sent because the plan's
    /// storage is full, and whether a conflict (another computer wrote one) needs another pass.
    async fn push_pictures(
        &self,
        token: &str,
        items: &[(String, String, String)],
        gone: bool,
    ) -> Result<(usize, bool), String> {
        if items.is_empty() {
            return Ok((0, false));
        }
        let account_id = self.account_id()?;
        let key_id = self.key_id();
        let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;
        let (mut again, mut i) = (false, 0);
        while i < items.len() {
            let (mut objects, mut meta, mut bytes) = (Vec::new(), Vec::new(), 0);
            while i < items.len() && objects.len() < PUSH_BATCH {
                let (local, home, name) = &items[i];
                let plain = if gone {
                    records::picture_tombstone(home, name)
                } else {
                    match self.sessions.blob(name).filter(|b| b.len() <= records::MAX_PICTURE_BYTES) {
                        Some(b) => records::picture_plaintext(home, name, &b),
                        None => {
                            i += 1;
                            continue;
                        }
                    }
                };
                if !objects.is_empty() && bytes + plain.len() > PUSH_BYTES {
                    break;
                }
                i += 1;
                bytes += plain.len();
                let oid = object_id(&keyring, records::PICTURE, local).map_err(|err| err.to_string())?;
                let revision = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0) + 1;
                let blob = seal_record(&keyring, &account_id, key_id, records::PICTURE, &oid, revision, &plain)
                    .map_err(|err| err.to_string())?;
                objects.push(json!({ "collection": records::PICTURE, "objectId": oid, "revision": revision, "keyId": key_id, "blob": blob }));
                meta.push((local.clone(), oid, revision));
            }
            if objects.is_empty() {
                continue;
            }
            let sent =
                self.api.send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": objects }))).await;
            let res = match sent {
                Ok(res) => res,
                // The plan's storage is full: these and the rest wait, and the chats still sync.
                Err(err) if err.status == 413 => return Ok((meta.len() + items.len() - i, again)),
                Err(err) => return Err(e(err)),
            };
            let results = res["results"].as_array().cloned().unwrap_or_default();
            for ((local, oid, revision), r) in meta.into_iter().zip(results) {
                match r["status"].as_str() {
                    Some("ok") => {
                        lock(&self.live).pushed += 1;
                        self.edit(|s| {
                            s.revisions.insert(oid, revision);
                            s.pictures.insert(local, state::PictureSynced { key_id, deleted: gone });
                        })?;
                    }
                    // Another computer wrote it (the same picture, checked by its name): the pull takes it in.
                    Some("conflict") | Some("stale-key") => again = true,
                    _ => {}
                }
            }
        }
        Ok((0, again))
    }

    /// Push the Library files that are new or changed here, and a tombstone for each synced
    /// one gone from disk (#2748). Files are read a request at a time, never all at once. A file
    /// over `MAX_FILE_BYTES` or that can't be read is skipped and says why; a full plan stops
    /// the Library push without failing the sync. True when a conflict needs another pass.
    async fn push_library(&self, token: &str) -> Result<bool, String> {
        let st = lock(&self.state).clone();
        let device_id = st.device_id.clone().unwrap_or_default();
        if !st.account.as_ref().is_some_and(|a| a.library_cloud) || device_id.is_empty() || !st.kind_on("library") {
            lock(&self.live).library_skipped.clear();
            return Ok(false);
        }
        let account_id = self.account_id()?;
        let key_id = self.key_id();
        let keyring = self.keyring(key_id).ok_or("This device has no sync keys.")?;

        enum Work {
            File {
                path: String,
                size: u64,
                modified: f64,
            },
            /// A file over 8 MB: push only a thumbnail record (#3044).
            Thumb {
                path: String,
                size: u64,
                modified: f64,
            },
            Gone {
                path: String,
            },
        }
        let mut work = Vec::new();
        let mut skipped: BTreeMap<String, &'static str> = BTreeMap::new();
        let mut gone_from_list = Vec::new();
        // Everything listed, and everything still synced that might have been deleted since.
        let paths: BTreeSet<&String> =
            st.library_files.keys().chain(st.library.iter().filter(|(_, k)| !k.deleted).map(|(p, _)| p)).collect();
        for path in paths {
            let synced = st.library.get(path).filter(|k| !k.deleted);
            match std::fs::metadata(path) {
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    gone_from_list.push(path.clone());
                    if synced.is_some() {
                        work.push(Work::Gone { path: path.clone() });
                    }
                }
                Ok(m) if m.is_file() => {
                    if !st.library_files.contains_key(path) {
                        continue; // synced once, no longer listed, still there: left as it is
                    }
                    let size = m.len();
                    let modified = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map_or(0.0, |d| d.as_millis() as f64);
                    if size > library::MAX_FILE_BYTES {
                        skipped.insert(path.clone(), "tooLarge");
                        // Even for oversized files, sync a thumbnail record if one is available (#3044).
                        let thumb = st.library_files.get(path).map(|f| f.thumbnail_data.as_str()).unwrap_or("");
                        if !thumb.is_empty() {
                            let thumb_digest = records::digest(thumb.as_bytes());
                            if synced.is_none_or(|k| k.key_id != key_id || k.thumbnail_digest != thumb_digest) {
                                work.push(Work::Thumb { path: path.clone(), size, modified });
                            }
                        }
                    } else if !synced.is_some_and(|k| {
                        k.key_id == key_id
                            && k.size == size
                            && k.modified_at == modified
                            && k.thumbnail_digest
                                == st
                                    .library_files
                                    .get(path)
                                    .map(|f| {
                                        if f.thumbnail_data.is_empty() {
                                            String::new()
                                        } else {
                                            records::digest(f.thumbnail_data.as_bytes())
                                        }
                                    })
                                    .unwrap_or_default()
                    }) {
                        work.push(Work::File { path: path.clone(), size, modified });
                    }
                }
                _ => {
                    skipped.insert(path.clone(), "unreadable");
                }
            }
        }
        if !gone_from_list.is_empty() {
            self.edit(|s| {
                for p in &gone_from_list {
                    s.library_files.remove(p);
                }
            })?;
        }

        let total = work.len();
        let mut again = false;
        let mut done = 0;
        let mut items = work.into_iter().peekable();
        while items.peek().is_some() {
            // One request: up to PUSH_BATCH records and PUSH_BYTES of plaintext (a big file goes alone).
            let mut objects = Vec::new();
            let mut meta: Vec<(String, String, u64, u64, LibrarySynced)> = Vec::new();
            let mut bytes = 0usize;
            while let Some(next) = items.peek() {
                let estimate = match next {
                    Work::File { size, .. } => (*size as usize) * 4 / 3 + 1024,
                    Work::Thumb { .. } | Work::Gone { .. } => 512,
                };
                if !objects.is_empty() && (objects.len() == PUSH_BATCH || bytes + estimate > PUSH_BYTES) {
                    break;
                }
                let Some(item) = items.next() else { break };
                done += 1;
                let (path, plain, synced) = match item {
                    Work::Gone { path } => {
                        let at = nekko_js::now_ms_f64();
                        let plain = library::tombstone(&device_id, &path, at);
                        (
                            path,
                            plain,
                            LibrarySynced {
                                modified_at: at,
                                size: 0,
                                digest: String::new(),
                                deleted: true,
                                key_id,
                                thumbnail_digest: String::new(),
                            },
                        )
                    }
                    Work::Thumb { path, size, modified } => {
                        // Thumb-only record for a file over 8 MB (#3044).
                        let Some(f) = st.library_files.get(&path) else { continue };
                        if f.thumbnail_data.is_empty() {
                            continue;
                        }
                        let thumbnail_digest = records::digest(f.thumbnail_data.as_bytes());
                        let plain = library::thumb_plaintext(&device_id, &st.device_label, f, modified, size);
                        let synced = LibrarySynced {
                            modified_at: modified,
                            size,
                            digest: String::new(),
                            deleted: false,
                            key_id,
                            thumbnail_digest,
                        };
                        (path, plain, synced)
                    }
                    Work::File { path, size, modified } => {
                        let Some(f) = st.library_files.get(&path) else { continue };
                        let Ok(data) = std::fs::read(&path) else {
                            skipped.insert(path, "unreadable");
                            continue;
                        };
                        if data.len() as u64 > library::MAX_FILE_BYTES {
                            skipped.insert(path, "tooLarge");
                            continue;
                        }
                        // The content, metadata, and thumbnail: a file saved again unchanged (and
                        // whose thumbnail hasn't changed) is only noted, not uploaded.
                        let what = serde_json::to_vec(&json!([f.title, f.kind, f.chat])).unwrap_or_default();
                        let digest = records::digest(&[what, data.clone()].concat());
                        let thumbnail_digest = if f.thumbnail_data.is_empty() {
                            String::new()
                        } else {
                            records::digest(f.thumbnail_data.as_bytes())
                        };
                        let synced = LibrarySynced {
                            modified_at: modified,
                            size,
                            digest,
                            deleted: false,
                            key_id,
                            thumbnail_digest,
                        };
                        if st.library.get(&path).is_some_and(|k| {
                            !k.deleted
                                && k.key_id == key_id
                                && k.digest == synced.digest
                                && k.thumbnail_digest == synced.thumbnail_digest
                        }) {
                            self.edit(|s| {
                                s.library.insert(path.clone(), synced.clone());
                            })?;
                            continue;
                        }
                        let plain = library::file_plaintext(&device_id, &st.device_label, f, modified, &data);
                        (path, plain, synced)
                    }
                };
                let local = library::local_id(&device_id, &path);
                let oid = object_id(&keyring, LIBRARY, &local).map_err(|err| err.to_string())?;
                let seen = lock(&self.state).revisions.get(&oid).copied().unwrap_or(0);
                let revision = seen + 1;
                let blob = seal_record(&keyring, &account_id, key_id, LIBRARY, &oid, revision, &plain)
                    .map_err(|err| err.to_string())?;
                bytes += plain.len();
                objects.push(json!({ "collection": LIBRARY, "objectId": oid, "revision": revision, "keyId": key_id, "blob": blob }));
                meta.push((path, oid, revision, seen, synced));
            }
            if objects.is_empty() {
                continue;
            }
            lock(&self.live).library_sending = meta.iter().map(|(p, ..)| p.clone()).collect();
            self.set_progress(Some((done - meta.len(), total)));
            let sent =
                self.api.send(token, reqwest::Method::POST, "/v1/sync/push", Some(json!({ "objects": objects }))).await;
            lock(&self.live).library_sending.clear();
            let res = match sent {
                Ok(res) => res,
                // The plan's storage is full: these and the rest wait, and the chats still sync.
                Err(err) if err.status == 413 => {
                    for (path, ..) in &meta {
                        skipped.insert(path.clone(), "noRoom");
                    }
                    for rest in items {
                        if let Work::File { path, .. } = rest {
                            skipped.insert(path, "noRoom");
                        }
                    }
                    break;
                }
                Err(err) => {
                    lock(&self.live).library_skipped = skipped;
                    return Err(e(err));
                }
            };
            let results = res["results"].as_array().cloned().unwrap_or_default();
            for ((path, oid, revision, seen, synced), r) in meta.into_iter().zip(results) {
                match r["status"].as_str() {
                    Some("ok") => {
                        lock(&self.live).pushed += 1;
                        self.edit(|s| {
                            s.revisions.insert(oid, revision);
                            s.library.insert(path, synced);
                        })?;
                    }
                    Some("conflict") => {
                        if r["revision"].as_u64().unwrap_or(0) < seen {
                            lock(&self.live).library_skipped = skipped;
                            return Err("Nekko Cloud sent an older copy of a Library file than this device has seen. Nothing more was synced.".into());
                        }
                        again = true;
                    }
                    Some("stale-key") => again = true,
                    _ => {}
                }
            }
        }
        lock(&self.live).library_skipped = skipped;
        Ok(again)
    }
}

const REMOVED: &str = "This device was removed from sync on another device.";

/// A `picture` record to push: its local id, its computer and its blob name.
type PictureItem = (String, String, String);

/// Which `picture` records a push sends (#3298), as `(local id, home, name)`: each picture the
/// chats being pushed refer to, and each a chat of this computer synced before refers to (one a
/// full plan held back), that Nekko Cloud doesn't hold under this key epoch and that is here to
/// send. And which it removes: this computer's pictures that none of its chats refers to any more.
fn picture_work(
    st: &State,
    me: &str,
    key_id: u32,
    queue: &[(String, Vec<u8>, Synced)],
    here: impl Fn(&str) -> bool,
) -> (Vec<PictureItem>, Vec<PictureItem>) {
    let split = |local: &str| {
        let (home, name) = local.rsplit_once('\n').unwrap_or(("", local));
        (local.to_string(), home.to_string(), name.to_string())
    };
    // What each chat refers to once this push lands: the queued copy, else the one synced before.
    let mut refers: BTreeMap<&str, &Synced> =
        st.chats.iter().filter(|(_, k)| !k.deleted && !k.foreign).map(|(id, k)| (id.as_str(), k)).collect();
    for (id, _, k) in queue {
        refers.insert(id.as_str(), k);
    }
    let used: BTreeSet<&String> = refers.values().filter(|k| !k.deleted).flat_map(|k| k.pictures.iter()).collect();
    let queued = queue.iter().flat_map(|(_, _, k)| k.pictures.iter());
    let held = |local: &str| st.pictures.get(local).is_some_and(|p| p.key_id == key_id && !p.deleted);
    let mut sends: BTreeSet<&String> = BTreeSet::new();
    for local in used.iter().copied().chain(queued) {
        let (_, _, name) = split(local);
        if !held(local) && here(&name) {
            sends.insert(local);
        }
    }
    let removes = st
        .pictures
        .iter()
        .filter(|(local, p)| !p.deleted && !used.contains(local) && split(local).1 == me)
        .map(|(local, _)| split(local))
        .collect();
    (sends.into_iter().map(|l| split(l)).collect(), removes)
}

#[cfg(test)]
mod idle_tests;

#[cfg(test)]
mod push_batch_tests {
    use super::*;

    #[test]
    fn pictures_go_up_once_per_epoch_and_only_this_computers_leave() {
        let pic = |home: &str, n: &str| records::picture_local_id(home, &format!("{}.png", n.repeat(64)));
        let synced = |pictures: Vec<String>, foreign: bool| Synced {
            pictures,
            foreign,
            key_id: 2,
            pictured: true,
            homed: true,
            ..Synced::default()
        };
        let mut st = State::default();
        // A chat of this computer synced before, with a picture held under the current epoch and
        // one a full plan held back; another computer's copy, whose picture is that computer's.
        st.chats.insert("s_old".into(), synced(vec![pic("me", "a"), pic("me", "b")], false));
        st.chats.insert("s_copy".into(), synced(vec![pic("lap", "c")], true));
        st.pictures.insert(pic("me", "a"), state::PictureSynced { key_id: 2, deleted: false });
        // Pictures no chat refers to any more: this computer's, held under an older epoch, and another's.
        st.pictures.insert(pic("me", "d"), state::PictureSynced { key_id: 1, deleted: false });
        st.pictures.insert(pic("me", "f"), state::PictureSynced { key_id: 2, deleted: true });
        st.pictures.insert(pic("lap", "e"), state::PictureSynced { key_id: 2, deleted: false });
        // Pushed now: a new chat with a new picture and one already held; a picture not here.
        let queue =
            vec![("s_new".to_string(), vec![], synced(vec![pic("me", "a"), pic("me", "g"), pic("me", "h")], false))];
        let here = |name: &str| !name.starts_with('h');
        let (sends, removes) = picture_work(&st, "me", 2, &queue, here);
        let locals = |v: &[PictureItem]| v.iter().map(|(l, ..)| l.clone()).collect::<Vec<_>>();
        assert_eq!(locals(&sends), vec![pic("me", "b"), pic("me", "g")]);
        assert_eq!(sends[0].1, "me");
        assert_eq!(sends[0].2, format!("{}.png", "b".repeat(64)));
        assert_eq!(locals(&removes), vec![pic("me", "d")]);
        // The new chat deleted in the same push: its pictures are no longer needed.
        let gone = vec![("s_old".to_string(), vec![], Synced { deleted: true, ..Synced::default() })];
        let (_, removes) = picture_work(&st, "me", 2, &gone, here);
        assert_eq!(locals(&removes), vec![pic("me", "a"), pic("me", "d")]);
    }

    #[test]
    fn batches_cap_count_and_bytes_and_send_a_big_chat_alone() {
        assert_eq!(push_batches(&[]), Vec::<std::ops::Range<usize>>::new());
        assert_eq!(push_batches(&vec![10; 120]), vec![0..50, 50..100, 100..120]);
        let mb = 1 << 20;
        assert_eq!(push_batches(&[2 * mb, 3 * mb, 2 * mb, 15 * mb, mb]), vec![0..2, 2..3, 3..4, 4..5]);
        // Never an empty request, whatever the sizes.
        assert!(push_batches(&[20 * mb, 20 * mb]).iter().all(|r| !r.is_empty()));
    }
}
