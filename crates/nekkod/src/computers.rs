//! Other computers this one is connected to (Settings > Computers): one
//! always-on relay link per computer, the way a phone reaches a computer, and
//! `computers.json`, which holds no secrets. The room secret and the device's
//! private key are in the OS key store (`scoped_vault`).
//!
//! `computers:*` is answered for the desktop window only (wire.rs): an agent's
//! tools, the CLI's API and the Local Web UI never reach a paired machine.

use crate::federation;
use crate::hub::Hub;
use nekko_cloud::vault::{FileVault, Vault, scoped_vault};
use nekko_remote::client::{Client, Config, SigningKey, State, Status};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHANNELS: &[&str] = &[
    "computers:list",
    "computers:pair",
    "computers:rename",
    "computers:setColor",
    "computers:forget",
    "computers:call",
    "computers:catalog",
    "computers:setIcon",
    "computers:createSession",
    "computers:stats",
    "computers:connectFleet",
    // Pairing a computer found on this network (pair_lobby.rs).
    "computers:nearby",
    "computers:lobbyOpen",
    "computers:lobbyAnswer",
    "computers:lobbyClose",
    "computers:lobbyJoin",
];

/// A pairing lobby's news for the window: `asking` (name, code) on the host,
/// `closed` (paired, error) on either side.
pub const LOBBY: &str = "computers:lobby";

/// The event a window refreshes on: a link's state changed, or the list did.
pub const UPDATED: &str = "computers:updated";

/// How long a pairing may take: a dial, a handshake and an enrollment.
const PAIR_LIMIT: Duration = Duration::from_secs(30);
const REFRESH_EVERY: Duration = Duration::from_secs(60);
const REFRESH_DEBOUNCE: Duration = Duration::from_millis(250);
const CALL_LIMIT: Duration = Duration::from_secs(120);
/// `chat:send` answers when the turn is over, which may be hours.
const TURN_LIMIT: Duration = Duration::from_secs(12 * 60 * 60);

/// One paired computer, as `computers.json` holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    pub relay_url: String,
    pub alts: Vec<String>,
    pub paired_at: f64,
    pub color: u32,
    /// Reached through this org's fleet with the account's keys (decision
    /// 0102), not paired: kept in memory only, never in `computers.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fleet: Option<String>,
}

/// What opens the link, kept in the OS key store under the computer's id.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Secrets {
    room: String,
    secret: String,
    /// The computer's public key, pinned from the pairing link.
    host_key: String,
    device_id: String,
    /// The device's P-256 private key, hex.
    device_key: String,
}

/// What a computer last said, so the panel paints from memory and an offline
/// computer's agents stay on it.
#[derive(Serialize, Deserialize)]
struct Seen {
    summaries: Vec<Value>,
    #[serde(skip)]
    running: Vec<String>,
    #[serde(skip)]
    pending: serde_json::Map<String, Value>,
    /// The switches it set for this one, once read after the welcome.
    #[serde(skip)]
    access: Option<Value>,
    catalog: Option<Value>,
    /// Its `machineIcon`.
    icon: Option<String>,
    /// *Let connected computers use these models*, as of the last read.
    #[serde(default = "shared_by_default")]
    models_shared: bool,
}

fn shared_by_default() -> bool {
    true
}

impl Default for Seen {
    fn default() -> Self {
        Self {
            summaries: Vec::new(),
            running: Vec::new(),
            pending: serde_json::Map::new(),
            access: None,
            catalog: None,
            icon: None,
            models_shared: true,
        }
    }
}

pub struct Computers {
    dir: PathBuf,
    file: PathBuf,
    vault: Box<dyn Vault>,
    hub: Hub,
    list: Mutex<Vec<Paired>>,
    links: Mutex<HashMap<String, Client>>,
    seen: Mutex<HashMap<String, Seen>>,
    /// Refresh this computer's lists soon; several `done`s coalesce.
    refresh: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    /// The daemon, for the generated Model Server providers.
    ctx: std::sync::OnceLock<crate::routes::Ctx>,
    /// Where those providers point: this run's listener and its token.
    tunnel: std::sync::OnceLock<(u16, Arc<str>)>,
    /// Nekko Cloud, for computers of this account found in an org's fleet.
    cloud: std::sync::OnceLock<Arc<nekko_cloud::Cloud>>,
    /// The pairing lobby this computer has open, if any: one at a time.
    lobby: Mutex<Option<HostLobby>>,
}

struct HostLobby {
    id: String,
    /// The owner's Pair or Don't pair, while the host is asking.
    answer: Option<tokio::sync::oneshot::Sender<bool>>,
    stop: Arc<tokio::sync::Notify>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn random_hex(n: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(hex(&bytes))
}

fn new_key() -> Result<(SigningKey, String), String> {
    let text = random_hex(32)?;
    let bytes = unhex(&text).ok_or("bad key")?;
    Ok((SigningKey::from_slice(&bytes).map_err(|e| e.to_string())?, text))
}

/// The nearest path first: a LAN or loopback address, then the tailnet, then a relay.
pub fn ordered_routes(relay_url: &str, alts: &[String]) -> Vec<String> {
    use nekko_remote::route::{Route, relay_route};
    let rank = |url: &String| match relay_route(url) {
        Route::Loopback => 0,
        Route::Lan => 1,
        Route::Tailscale => 2,
        Route::Internet => 3,
    };
    let mut routes: Vec<String> = std::iter::once(relay_url.to_string()).chain(alts.iter().cloned()).collect();
    routes.sort_by_key(rank);
    routes
}

/// What the window reads of a link. `update` means the computer's build is too
/// old; `denied` that it removed this one, or turned Read off.
fn state_text(s: &State) -> &'static str {
    match s {
        State::Connecting => "connecting",
        State::Online => "online",
        State::Offline | State::Stopped => "offline",
        State::Denied(r) if r == "update-required" => "update",
        State::Denied(_) => "denied",
        State::Stale => "stale",
    }
}

fn status_value(p: &Paired, s: Option<Status>) -> Value {
    let mut v = serde_json::to_value(p).unwrap_or(Value::Null);
    let state = s.as_ref().map_or("offline", |s| state_text(&s.state));
    let on = |k: &str| s.as_ref().is_none_or(|s| s.device.pointer(&format!("/access/{k}")) != Some(&json!(false)));
    if let Some(o) = v.as_object_mut() {
        o.insert("state".into(), json!(state));
        o.insert("route".into(), json!(s.as_ref().and_then(|s| s.route.clone())));
        o.insert("read".into(), json!(on("read")));
        o.insert("change".into(), json!(on("change")));
    }
    v
}

/// The sentence for a pairing that didn't complete.
fn pair_refusal(state: &State, host: &str) -> String {
    match state {
        State::Denied(r) if r == "bad-code" => {
            format!("This link is for a phone, or it expired. On {host}, open Settings, Computers, and make a new one.")
        }
        State::Denied(r) if r == "update-required" => format!("Update Nekko Agent on {host}."),
        State::Denied(_) => format!("{host} refused this computer."),
        State::Offline => format!("{host} is offline."),
        _ => format!("Could not reach {host}."),
    }
}

impl Computers {
    pub fn new(dir: PathBuf, hub: Hub) -> Arc<Self> {
        let file = dir.join("computers-secrets.json");
        let vault: Box<dyn Vault> = if cfg!(debug_assertions) && std::env::var("NEKKO_FILE_VAULT").as_deref() == Ok("1")
        {
            // Tests: a test run writes nothing to the login keychain.
            Box::new(FileVault::new(file))
        } else {
            scoped_vault(&dir, "computers", file)
        };
        Self::with_vault(dir, hub, vault)
    }

    pub fn with_vault(dir: PathBuf, hub: Hub, vault: Box<dyn Vault>) -> Arc<Self> {
        let file = dir.join("computers.json");
        let list = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let list: Vec<Paired> = list;
        let seen = list
            .iter()
            .map(|p| {
                let path = dir.join("computers").join(&p.id).join("seen.json");
                let seen = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok());
                (p.id.clone(), seen.unwrap_or_default())
            })
            .collect();
        Arc::new(Self {
            dir,
            file,
            vault,
            hub,
            list: Mutex::new(list),
            links: Mutex::default(),
            seen: Mutex::new(seen),
            refresh: Mutex::default(),
            ctx: std::sync::OnceLock::new(),
            tunnel: std::sync::OnceLock::new(),
            cloud: std::sync::OnceLock::new(),
            lobby: Mutex::default(),
        })
    }

    /// A link per paired computer. Does nothing with none.
    pub fn start(self: &Arc<Self>, ctx: crate::routes::Ctx) {
        let _ = self.ctx.set(ctx);
        for p in lock(&self.list).clone() {
            if let Some(cfg) = self.config(&p) {
                self.open(&p.id, cfg);
            }
        }
        if self.any() {
            let me = self.clone();
            tokio::spawn(async move { me.sync_providers().await });
        }
    }

    /// A provider for each connected computer's Model Server, in settings like
    /// any other, so a chat here, or a phone connected here, can pick one.
    async fn sync_providers(self: &Arc<Self>) {
        const PREFIX: &str = "computer:";
        let Some(ctx) = self.ctx.get() else { return };
        let paired = lock(&self.list).clone();
        let settings = crate::settings::current(ctx).await;
        let held = settings.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
        let ours = |p: &Value| p.get("id").and_then(Value::as_str).is_some_and(|id| id.starts_with(PREFIX));
        if paired.is_empty() && !held.iter().any(ours) {
            return;
        }
        if !paired.is_empty() && self.tunnel.get().is_none() {
            let Ok(token) = random_hex(24) else { return };
            let token: Arc<str> = token.into();
            let app = crate::model_tunnel::Listener { computers: self.clone(), token: token.clone() };
            match crate::model_tunnel::listen(app).await {
                Ok(port) => {
                    let _ = self.tunnel.set((port, token));
                }
                Err(e) => eprintln!("nekkod: no listener for connected Model Servers: {e}"),
            }
        }
        let Some((port, token)) = self.tunnel.get().cloned() else { return };
        let shared: Vec<&Paired> = {
            let seen = lock(&self.seen);
            paired.iter().filter(|p| seen.get(&p.id).is_none_or(|s| s.models_shared)).collect()
        };
        let rows = shared.iter().map(|p| {
            json!({
                "id": format!("{PREFIX}{}", p.id),
                "kind": "openai-compat",
                "label": format!("{} Model Server", p.name),
                "baseUrl": format!("http://127.0.0.1:{port}/{}/v1", p.id),
                "apiKey": &*token,
                "enabled": true,
                // What makes it another machine, though its address is loopback.
                "computerId": p.id,
            })
        });
        let next: Vec<Value> = held.iter().filter(|p| !ours(p)).cloned().chain(rows).collect();
        if next != held {
            let _ = crate::settings::update(ctx, json!({ "providers": next })).await;
        }
    }

    /// The computer a tunneled model request goes to.
    pub fn client_for_models(&self, id: &str) -> Result<(String, Client), String> {
        let name = lock(&self.list).iter().find(|p| p.id == id).map(|p| p.name.clone());
        let name = name.ok_or("That computer isn't connected.")?;
        let client = self.client(id).map_err(|_| format!("{name} isn't connected."))?;
        if client.status().state != State::Online {
            return Err(format!("{name} is offline."));
        }
        Ok((name, client))
    }

    pub fn stop(&self) {
        for (_, c) in lock(&self.links).drain() {
            c.stop();
        }
    }

    fn save(&self) -> Result<(), String> {
        // A fleet link lives as long as the account allows it: never saved.
        let kept: Vec<Paired> = lock(&self.list).iter().filter(|p| p.fleet.is_none()).cloned().collect();
        let text = serde_json::to_vec_pretty(&kept).map_err(|e| e.to_string())?;
        nekko_remote::service::write_json_atomic(&self.file, &serde_json::from_slice(&text).unwrap_or(Value::Null))
            .map_err(|e| e.to_string())
    }

    fn config(&self, p: &Paired) -> Option<Config> {
        let s: Secrets = serde_json::from_str(&self.vault.get(&p.id)?).ok()?;
        let key = SigningKey::from_slice(&unhex(&s.device_key)?).ok()?;
        Some(Config {
            routes: ordered_routes(&p.relay_url, &p.alts),
            room: s.room,
            secret: s.secret,
            host_key: s.host_key,
            device_id: s.device_id,
            name: this_name(),
            key,
            pair_code: None,
            fleet: None,
        })
    }

    fn open(self: &Arc<Self>, id: &str, cfg: Config) -> Client {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let client = Client::start(cfg, tx);
        lock(&self.links).insert(id.to_string(), client.clone());
        let soon = Arc::new(tokio::sync::Notify::new());
        lock(&self.refresh).insert(id.to_string(), soon.clone());

        // Each welcome: read its lists, and catch up on turns already running.
        let (me, computer, mut changes) = (self.clone(), id.to_string(), client.watch());
        tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                me.hub.publish(UPDATED, json!({}), false);
                let online = changes.borrow().state == State::Online;
                if online && me.refreshed(&computer).await {
                    me.catch_up(&computer).await;
                }
            }
        });

        // A turn's end, a chat changing, and every minute.
        let (me, computer, wake) = (self.clone(), id.to_string(), soon.clone());
        tokio::spawn(async move {
            loop {
                let _ = tokio::time::timeout(REFRESH_EVERY, wake.notified()).await;
                tokio::time::sleep(REFRESH_DEBOUNCE).await;
                if !lock(&me.links).contains_key(&computer) {
                    return;
                }
                me.refreshed(&computer).await;
            }
        });

        let (me, computer) = (self.clone(), id.to_string());
        tokio::spawn(async move {
            while let Some((channel, mut payload)) = rx.recv().await {
                if channel != "agent:event" {
                    continue;
                }
                let turn_over =
                    matches!(payload.get("type").and_then(Value::as_str), Some("done" | "error" | "session_meta"));
                federation::qualify_ids(&computer, &mut payload);
                me.hub.publish_remote(payload);
                if turn_over {
                    soon.notify_one();
                }
            }
        });
        client
    }

    /// Whether any computer is paired: with none, no call pays for this.
    pub fn any(&self) -> bool {
        !lock(&self.list).is_empty()
    }

    /// Read a computer's chat list. False when it could not be read.
    async fn refreshed(self: &Arc<Self>, id: &str) -> bool {
        let Ok(client) = self.client(id) else { return false };
        let Ok(mut summaries) = client.call("sessions:summaries", json!([])).await else { return false };
        let mut running = client.call("chat:running", json!([])).await.unwrap_or(json!([]));
        let pending = client.call("chat:pending", json!([])).await.unwrap_or(json!({}));
        let access = client.call("device:access", json!([])).await.ok();
        let info = client.call("app:info", json!([])).await.unwrap_or(Value::Null);
        let icon = info.get("machineIcon").and_then(Value::as_str).filter(|i| !i.is_empty()).map(str::to_string);
        let shared = info.get("sharesModels") != Some(&Value::Bool(false));
        federation::qualify_chats(id, &mut summaries);
        for chat in running.as_array_mut().into_iter().flatten() {
            if let Some(raw) = chat.as_str() {
                *chat = json!(federation::qualify(id, raw));
            }
        }
        let pending: serde_json::Map<String, Value> = pending
            .as_object()
            .into_iter()
            .flatten()
            .map(|(raw, p)| {
                let mut p = p.clone();
                federation::qualify_ids(id, &mut p);
                (federation::qualify(id, raw), p)
            })
            .collect();
        let changed;
        {
            let mut seen = lock(&self.seen);
            let s = seen.entry(id.to_string()).or_default();
            s.summaries = summaries.as_array().cloned().unwrap_or_default();
            s.running =
                running.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();
            s.pending = pending;
            s.access = access;
            s.icon = icon;
            changed = s.models_shared != shared;
            s.models_shared = shared;
        }
        if changed {
            self.sync_providers().await;
        }
        self.keep(id);
        self.hub.publish(UPDATED, json!({}), false);
        true
    }

    /// What survives a restart, without the chats a person marked incognito.
    /// Nothing for a fleet link: it doesn't survive a restart.
    fn keep(&self, id: &str) {
        if lock(&self.list).iter().any(|p| p.id == id && p.fleet.is_some()) {
            return;
        }
        let path = self.dir.join("computers").join(id).join("seen.json");
        let value = {
            let seen = lock(&self.seen);
            let Some(s) = seen.get(id) else { return };
            let keep: Vec<&Value> =
                s.summaries.iter().filter(|c| c.get("incognito") != Some(&Value::Bool(true))).collect();
            json!({ "summaries": keep, "catalog": s.catalog, "icon": s.icon, "models_shared": s.models_shared })
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = nekko_remote::service::write_json_atomic(&path, &value);
    }

    /// The turns running over there, each replayed so far into this computer's
    /// event stream, so an open chat shows the reply already under way.
    async fn catch_up(&self, id: &str) {
        let Ok(client) = self.client(id) else { return };
        let running = lock(&self.seen).get(id).map(|s| s.running.clone()).unwrap_or_default();
        for chat in running {
            let Some((_, raw)) = federation::split(&chat) else { continue };
            let Ok(replay) = client.call("agent:replay", json!([raw])).await else { continue };
            for event in replay.get("events").and_then(Value::as_array).into_iter().flatten() {
                let mut event = event.clone();
                federation::qualify_ids(id, &mut event);
                self.hub.publish_remote(event);
            }
        }
    }

    /// A chat's call, on the computer it belongs to.
    pub async fn forward(&self, id: &str, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        let client = self.client(id)?;
        let limit = if federation::LONG.contains(&channel) { TURN_LIMIT } else { CALL_LIMIT };
        let mut reply = client.call_for(channel, Value::Array(args), limit).await.map_err(|e| e.to_string())?;
        federation::qualify_chats(id, &mut reply);
        Ok(reply)
    }

    /// A list the window reads, with every computer's added to this one's.
    pub fn merged(&self, channel: &str, local: Value) -> Value {
        if !matches!(channel, "sessions:summaries" | "chat:running" | "chat:pending") || !self.any() {
            return local;
        }
        let seen = lock(&self.seen);
        match (channel, local) {
            ("chat:pending", Value::Object(mut all)) => {
                all.extend(seen.values().flat_map(|s| s.pending.clone()));
                Value::Object(all)
            }
            ("chat:running", Value::Array(mut all)) => {
                all.extend(seen.values().flat_map(|s| s.running.iter().map(|id| json!(id))));
                Value::Array(all)
            }
            ("sessions:summaries", Value::Array(mut all)) => {
                all.extend(seen.values().flat_map(|s| s.summaries.clone()));
                Value::Array(all)
            }
            (_, other) => other,
        }
    }

    /// A computer's providers and folders, for its pickers (a provider's models
    /// come through `models:list`). Answers from memory while it is away.
    async fn catalog(&self, id: &str) -> Result<Value, String> {
        let client = self.client(id).ok().filter(|c| c.status().state == State::Online);
        if let Some(c) = client {
            let mut providers = c.call("providers:list", json!([])).await.map_err(|e| e.to_string())?;
            let mut workspaces = c.call("workspace:list", json!([])).await.map_err(|e| e.to_string())?;
            federation::qualify_chats(id, &mut providers);
            federation::qualify_chats(id, &mut workspaces);
            let catalog = json!({ "providers": providers, "workspaces": workspaces });
            lock(&self.seen).entry(id.to_string()).or_default().catalog = Some(catalog.clone());
            self.keep(id);
            return Ok(catalog);
        }
        Ok(lock(&self.seen).get(id).and_then(|s| s.catalog.clone()).unwrap_or(Value::Null))
    }

    fn client(&self, id: &str) -> Result<Client, String> {
        lock(&self.links).get(id).cloned().ok_or_else(|| "That computer isn't connected.".to_string())
    }

    pub fn list(&self) -> Value {
        let links = lock(&self.links);
        let list = lock(&self.list);
        let seen = lock(&self.seen);
        let row = |p: &Paired| {
            let mut v = status_value(p, links.get(&p.id).map(Client::status));
            // Newer than the welcome: the switches can change while linked.
            if let (Some(a), Some(o)) = (seen.get(&p.id).and_then(|s| s.access.as_ref()), v.as_object_mut()) {
                o.insert("read".into(), a.get("read").cloned().unwrap_or(json!(true)));
                o.insert("change".into(), a.get("change").cloned().unwrap_or(json!(true)));
            }
            if let (Some(i), Some(o)) = (seen.get(&p.id).and_then(|s| s.icon.as_ref()), v.as_object_mut()) {
                o.insert("icon".into(), json!(i));
            }
            v
        };
        Value::Array(list.iter().map(row).collect())
    }

    fn edit(&self, id: &str, change: impl FnOnce(&mut Paired)) -> Result<Value, String> {
        {
            let mut list = lock(&self.list);
            change(list.iter_mut().find(|p| p.id == id).ok_or("No computer with that id.")?);
        }
        self.save()?;
        self.hub.publish(UPDATED, json!({}), false);
        Ok(self.list())
    }

    /// Connect with a pairing link the window parsed, and keep the computer
    /// only once it has welcomed this one as a computer.
    async fn pair(self: &Arc<Self>, link: &Value) -> Result<Value, String> {
        let text = |k: &str| link.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let (relay_url, room, secret, code) = (text("relayUrl"), text("room"), text("key"), text("pair"));
        if relay_url.is_empty() || room.is_empty() || secret.is_empty() || code.is_empty() {
            return Err("This link has no pairing code. Make a new one on the other computer.".into());
        }
        let host_key = text("hostKey");
        if nekko_remote::proof::parse_key(&host_key).is_none() {
            return Err("Update Nekko Agent on the other computer, then make a new link.".into());
        }
        if let Some(problem) = nekko_remote::route::relay_url_problem(&relay_url) {
            return Err(problem);
        }
        let alts: Vec<String> = link
            .get("alts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|u| nekko_remote::route::relay_url_problem(u).is_none())
            .map(str::to_string)
            .collect();
        // The room, not the address: several computers can share one relay.
        let held = lock(&self.list).clone();
        let same_room = |p: &Paired| {
            let s = self.vault.get(&p.id).and_then(|t| serde_json::from_str::<Secrets>(&t).ok());
            s.is_some_and(|s| s.room == room)
        };
        if held.iter().any(same_room) {
            return Err("This computer is already connected.".into());
        }
        let host = nekko_remote::route::relay_host(&relay_url);
        let (key, key_text) = new_key()?;
        let device_id = random_hex(16)?;
        let cfg = Config {
            routes: ordered_routes(&relay_url, &alts),
            room: room.clone(),
            secret: secret.clone(),
            host_key: host_key.clone(),
            device_id: device_id.clone(),
            name: this_name(),
            key,
            pair_code: Some(code),
            fleet: None,
        };
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let client = Client::start(cfg.clone(), tx);
        let mut rx = client.watch();
        let settled = rx.wait_for(|s| matches!(s.state, State::Online | State::Denied(_) | State::Stale));
        let reached = tokio::time::timeout(PAIR_LIMIT, settled).await.is_ok();
        let status = client.status();
        if !reached || status.state != State::Online {
            client.stop();
            return Err(pair_refusal(&status.state, &host));
        }
        // A build from before computers enrolled this as an unknown phone.
        if status.device.get("kind").and_then(Value::as_str) != Some(nekko_remote::hello::COMPUTER_PLATFORM) {
            let _ = client.call("device:signOut", json!([])).await;
            client.stop();
            return Err(format!("Update Nekko Agent on {host}."));
        }
        let info = client.call("app:info", json!([])).await.unwrap_or(Value::Null);
        client.stop();

        let id = random_hex(4)?;
        let name = ["computerName", "hostname"]
            .iter()
            .find_map(|k| info.get(*k).and_then(Value::as_str).filter(|n| !n.trim().is_empty()))
            .unwrap_or(&host);
        let name: String = name.chars().take(60).collect();
        let platform = info.get("platform").and_then(Value::as_str).map(str::to_string);
        let at = nekko_remote::system_clock()();
        let secrets = Secrets { room, secret, host_key, device_id, device_key: key_text };
        self.vault.set(&id, &serde_json::to_string(&secrets).map_err(|e| e.to_string())?)?;
        let color = lock(&self.list).len() as u32;
        let paired = Paired { id: id.clone(), name, platform, relay_url, alts, paired_at: at, color, fleet: None };
        lock(&self.list).push(paired.clone());
        self.save()?;
        self.open(&id, Config { pair_code: None, ..cfg });
        self.sync_providers().await;
        self.hub.publish(UPDATED, json!({}), false);
        Ok(status_value(&paired, None))
    }

    /// Nekko Cloud, for fleet links (fleet.rs).
    pub fn set_cloud(&self, cloud: Arc<nekko_cloud::Cloud>) {
        let _ = self.cloud.set(cloud);
    }

    /// Open a chat link to a computer of this account listed in an org's fleet
    /// (decision 0102): no code, the account's keys prove who this is. Kept in
    /// memory only, like any link it is listed here and its Model Server is
    /// offered to chats. Asking again for one already linked answers its row.
    async fn connect_fleet(self: &Arc<Self>, org_id: &str, device_id: &str) -> Result<Value, String> {
        let cloud = self.cloud.get().ok_or("Nekko Cloud isn't available here.")?.clone();
        let id = fleet_link_id(device_id);
        if let Some(row) = self.row(&id) {
            return Ok(row);
        }
        let target = cloud
            .fleet_target(org_id, device_id)
            .ok_or("That computer can't be reached from here. Open the organization's Computers list again.")?;
        let account_device = cloud.fleet_device().ok_or("Unlock your account on this computer first.")?;
        let routes: Vec<String> = target
            .connect
            .routes
            .iter()
            .filter(|u| nekko_remote::route::relay_url_problem(u).is_none())
            .cloned()
            .collect();
        let relay_url = routes.first().cloned().ok_or("That computer's relay address can't be used from here.")?;
        let (key, _) = new_key()?;
        let cfg = Config {
            routes: ordered_routes(&relay_url, &routes[1..]),
            room: target.connect.room.clone(),
            secret: target.connect.secret.clone(),
            host_key: target.connect.host_key.clone(),
            device_id: nekko_remote::fleet::link_device_id(&account_device),
            name: this_name(),
            key,
            pair_code: None,
            fleet: Some(crate::fleet::signer(cloud.clone(), org_id.to_string())),
        };
        let name = target.name.clone();
        let mut state = self.try_fleet(&cfg).await;
        // The computer may not have heard of this device or key epoch yet: it
        // catches up when it refuses, so one more try after a moment.
        if matches!(&state, State::Denied(r) if r == "fleet-device" || r == "fleet-epoch") {
            tokio::time::sleep(FLEET_RETRY).await;
            state = self.try_fleet(&cfg).await;
        }
        if state != State::Online {
            return Err(fleet_refusal(&state, &name));
        }
        let platform = Some(
            match target.os.as_str() {
                "windows" => "win32",
                "macos" => "darwin",
                _ => "linux",
            }
            .to_string(),
        );
        let color = lock(&self.list).len() as u32;
        let at = nekko_remote::system_clock()();
        let paired = Paired {
            id: id.clone(),
            name,
            platform,
            relay_url,
            alts: routes[1..].to_vec(),
            paired_at: at,
            color,
            fleet: Some(org_id.to_string()),
        };
        lock(&self.list).push(paired.clone());
        self.open(&id, cfg);
        self.sync_providers().await;
        self.hub.publish(UPDATED, json!({}), false);
        Ok(status_value(&paired, None))
    }

    /// One fleet dial, until it is in or refused.
    async fn try_fleet(&self, cfg: &Config) -> State {
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let client = Client::start(cfg.clone(), tx);
        let mut rx = client.watch();
        let settled = rx.wait_for(|s| matches!(s.state, State::Online | State::Denied(_) | State::Stale));
        let reached = tokio::time::timeout(PAIR_LIMIT, settled).await.is_ok();
        let state = if reached { client.status().state } else { State::Offline };
        client.stop();
        state
    }

    fn row(&self, id: &str) -> Option<Value> {
        let all = self.list();
        all.as_array()?.iter().find(|r| r["id"] == id).cloned()
    }

    /// Drop every fleet link once this desktop is signed out or locked: what
    /// opened them is gone, so they go too (fleet.rs runs this).
    pub async fn drop_fleet_unless_ready(self: &Arc<Self>) {
        let ready = match self.cloud.get() {
            Some(c) => {
                let c = c.clone();
                tokio::task::spawn_blocking(move || c.fleet_ready()).await.unwrap_or(false)
            }
            None => false,
        };
        if ready {
            return;
        }
        let ids: Vec<String> = lock(&self.list).iter().filter(|p| p.fleet.is_some()).map(|p| p.id.clone()).collect();
        for id in ids {
            let _ = self.forget(&id).await;
        }
    }

    /// Stop using a computer, and sign out of it while it can still hear.
    async fn forget(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        let link = lock(&self.links).remove(id);
        if let Some(c) = link {
            if c.status().state == State::Online {
                let _ = c.call("device:signOut", json!([])).await;
            }
            c.stop();
        }
        self.vault.delete(id);
        lock(&self.list).retain(|p| p.id != id);
        lock(&self.seen).remove(id);
        lock(&self.refresh).remove(id);
        let _ = std::fs::remove_dir_all(self.dir.join("computers").join(id));
        self.sync_providers().await;
        self.save()?;
        self.hub.publish(UPDATED, json!({}), false);
        Ok(self.list())
    }

    /// Forget every linked computer (Delete everything): each one's keys
    /// leave the OS keystore and each is signed out of while it can hear.
    pub async fn forget_all(self: &Arc<Self>) -> Result<(), String> {
        let ids: Vec<String> = lock(&self.list).iter().map(|p| p.id.clone()).collect();
        for id in ids {
            self.forget(&id).await?;
        }
        Ok(())
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        let id = arg(0).as_str().unwrap_or_default();
        match channel {
            "computers:list" => Ok(self.list()),
            "computers:pair" => self.pair(arg(0)).await,
            "computers:nearby" => self.nearby().await,
            "computers:lobbyOpen" => self.lobby_open(arg(0)).await,
            "computers:lobbyAnswer" => {
                let tx = lock(&self.lobby)
                    .as_mut()
                    .and_then(|l| l.answer.take())
                    .ok_or("Nothing is waiting for an answer.")?;
                let _ = tx.send(arg(0).as_bool() == Some(true));
                Ok(Value::Null)
            }
            "computers:lobbyClose" => {
                if let Some(l) = lock(&self.lobby).as_ref() {
                    l.stop.notify_one();
                }
                Ok(Value::Null)
            }
            "computers:lobbyJoin" => self.lobby_join(arg(0)).await,
            "computers:rename" => {
                let name = arg(1).as_str().map(str::trim).filter(|n| !n.is_empty()).ok_or("A name is required.")?;
                self.edit(id, |p| p.name = name.chars().take(60).collect())
            }
            "computers:setColor" => {
                let color = arg(1).as_u64().ok_or("A color is required.")? as u32;
                self.edit(id, |p| p.color = color)
            }
            "computers:forget" => self.forget(id).await,
            "computers:connectFleet" => {
                let device = arg(1).as_str().unwrap_or_default();
                self.connect_fleet(id, device).await
            }
            "computers:call" => {
                let channel = arg(1).as_str().ok_or("A channel is required.")?;
                self.client(id)?.call(channel, arg(2).clone()).await.map_err(|e| e.to_string())
            }
            "computers:catalog" => self.catalog(id).await,
            "computers:stats" => {
                let client = self.client(id)?;
                let system = client.call("system:stats", json!([])).await.unwrap_or(Value::Null);
                let gpu = client.call("gpu:stats", json!([])).await.unwrap_or(Value::Null);
                Ok(json!({ "system": system, "gpu": gpu }))
            }
            "computers:createSession" => {
                let folder = arg(1).as_str().and_then(federation::split).map(|(_, raw)| json!(raw));
                self.forward(id, "session:create", folder.into_iter().collect()).await
            }
            "computers:setIcon" => {
                // It lives on that machine, so every device that connects shows the same one.
                let client = self.client(id)?;
                client.call("settings:update", json!([{ "machineIcon": arg(1) }])).await.map_err(|e| e.to_string())?;
                self.refreshed(id).await;
                Ok(self.list())
            }
            _ => Err(format!("No handler for {channel}")),
        }
    }
}

/// How long before the one retry of a fleet link the computer refused for
/// not knowing this device or key epoch yet (it catches up meanwhile).
const FLEET_RETRY: Duration = Duration::from_secs(3);

/// A fleet link's id here: `f` and the first 11 hex digits of the account device id.
fn fleet_link_id(device_id: &str) -> String {
    let hex: String = device_id.chars().filter(char::is_ascii_hexdigit).take(11).collect();
    format!("f{}", hex.to_lowercase())
}

/// The sentence for a fleet link that didn't open.
fn fleet_refusal(state: &State, name: &str) -> String {
    match state {
        State::Denied(r) if r == "update-required" => format!("Update Nekko Agent on {name}."),
        State::Denied(r) if r == "fleet-off" => format!("{name} stopped sharing with this organization."),
        State::Denied(r) if r == "fleet-locked" => format!("{name} is signed out of Nekko Cloud or locked."),
        State::Denied(r) if r == "fleet-epoch" || r == "fleet-device" => {
            format!("{name} doesn't trust this computer yet. Try again in a minute.")
        }
        State::Denied(r) if r == "fleet-account" => format!("{name} belongs to another account."),
        State::Denied(_) => format!("{name} refused this computer."),
        State::Stale => format!("{name}'s remote access changed. Open the Computers list again."),
        _ => format!("Could not reach {name}."),
    }
}

impl Computers {
    fn visibility(&self) -> Option<Arc<crate::mdns::NetworkVisibility>> {
        self.ctx.get()?.desktop.as_ref().map(|d| d.visibility().clone())
    }

    /// `computers:nearby`: computers on this network with a lobby open, not this one's own.
    async fn nearby(&self) -> Result<Value, String> {
        if !nekko_net::allowed("network-visibility") {
            return Err(nekko_net::blocked_message("network-visibility"));
        }
        let own = lock(&self.lobby).as_ref().map(|l| l.id.clone());
        let found = crate::mdns::browse(Duration::from_millis(1500)).await;
        Ok(Value::Array(found.into_iter().filter(|f| f["lobby"].as_str() != own.as_deref()).collect()))
    }

    /// `computers:lobbyOpen [link]`: open a lobby on the link's relay for its
    /// life, name it in the network advert, and hand the link over sealed when
    /// the owner approves a joiner whose code matches. Replaces an open one.
    async fn lobby_open(self: &Arc<Self>, link: &Value) -> Result<Value, String> {
        let relay = link.get("relayUrl").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(problem) = nekko_remote::route::relay_url_problem(&relay) {
            return Err(problem);
        }
        if let Some(old) = lock(&self.lobby).take() {
            old.stop.notify_one();
        }
        let id = crate::pair_lobby::new_lobby();
        let ticket = if nekko_remote::route::is_cloud_relay(&relay) {
            let cloud = self.cloud.get().ok_or("Sign in to Nekko Cloud to use its relay.")?;
            Some(crate::fleet::relay_tickets(cloud.clone())(id.clone())().await?.ticket)
        } else {
            None
        };
        let url = nekko_remote::agent_url(&relay, &id, &id, ticket.as_deref());
        let ws = tokio::time::timeout(PAIR_LIMIT, tokio_tungstenite::connect_async(url.as_str()))
            .await
            .map_err(|_| "The relay didn't answer.".to_string())?
            .map_err(|e| format!("Couldn't open a lobby on the relay: {e}"))?
            .0;
        let stop = Arc::new(tokio::sync::Notify::new());
        *lock(&self.lobby) = Some(HostLobby { id: id.clone(), answer: None, stop: stop.clone() });
        let visibility = self.visibility();
        if let Some(v) = &visibility {
            v.set_lobby(Some((id.clone(), relay))).await;
        }
        let (me, link, lobby) = (self.clone(), link.clone(), id.clone());
        tokio::spawn(async move {
            let ask = |name: String, code: String| {
                let (tx, rx) = tokio::sync::oneshot::channel();
                if let Some(l) = lock(&me.lobby).as_mut().filter(|l| l.id == lobby) {
                    l.answer = Some(tx);
                }
                me.hub.publish(LOBBY, json!({ "state": "asking", "name": name, "code": code }), false);
                async move { rx.await.unwrap_or(false) }
            };
            let done = tokio::select! {
                r = crate::pair_lobby::host(ws, &lobby, &link, ask) => r,
                _ = tokio::time::sleep(crate::pair_lobby::TTL) => Err("The link ran out.".into()),
                _ = stop.notified() => Ok(false),
            };
            let mine = {
                let mut held = lock(&me.lobby);
                let mine = held.as_ref().is_some_and(|l| l.id == lobby);
                if mine {
                    *held = None;
                }
                mine
            };
            if mine && let Some(v) = &visibility {
                v.set_lobby(None).await;
            }
            let (paired, error) = match done {
                Ok(p) => (p, None),
                Err(e) => (false, Some(e)),
            };
            me.hub.publish(
                LOBBY,
                json!({ "state": "closed", "role": "host", "paired": paired, "error": error }),
                false,
            );
        });
        Ok(json!({ "lobby": id }))
    }

    /// `computers:lobbyJoin [{ lobby, relay }]`: join a lobby found nearby,
    /// answer with the code to compare, and pair in the background once the
    /// other computer's owner approves.
    async fn lobby_join(self: &Arc<Self>, found: &Value) -> Result<Value, String> {
        let text = |k: &str| found.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let (lobby, relay) = (text("lobby"), text("relay"));
        if lobby.len() != 32 || !lobby.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("That computer's lobby isn't valid.".into());
        }
        if let Some(problem) = nekko_remote::route::relay_url_problem(&relay) {
            return Err(problem);
        }
        let url = nekko_remote::client::client_url(&relay, &lobby, &lobby);
        let ws = tokio::time::timeout(PAIR_LIMIT, tokio_tungstenite::connect_async(url.as_str()))
            .await
            .map_err(|_| "The relay didn't answer.".to_string())?
            .map_err(|_| "That computer's lobby has closed. Make a new link there.".to_string())?
            .0;
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<String>();
        let me = self.clone();
        tokio::spawn(async move {
            let joined = tokio::time::timeout(
                crate::pair_lobby::TTL,
                crate::pair_lobby::join(ws, &lobby, &this_name(), |c| {
                    let _ = tx.send(c);
                }),
            )
            .await
            .unwrap_or_else(|_| Err("The other computer didn't answer in time.".into()));
            let result = match joined {
                Ok(link) => me.pair(&link).await.map(|_| ()),
                Err(e) => Err(e),
            };
            if let Err(e) = &result {
                let _ = done_tx.send(e.clone());
            }
            me.hub.publish(
                LOBBY,
                json!({ "state": "closed", "role": "joiner", "paired": result.is_ok(), "error": result.err() }),
                false,
            );
        });
        tokio::select! {
            code = rx => code.map(|code| json!({ "code": code })).map_err(|_| "That computer's lobby closed.".into()),
            e = done_rx => Err(e.unwrap_or_else(|_| "That computer's lobby closed.".into())),
        }
    }
}

/// What the other computer calls this one.
fn this_name() -> String {
    crate::host_name::friendly_host_name()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn computers(dir: &std::path::Path) -> Arc<Computers> {
        let vault = Box::new(FileVault::new(dir.join("secrets.json")));
        Computers::with_vault(dir.to_path_buf(), Hub::new(), vault)
    }

    fn paired(id: &str) -> Paired {
        Paired {
            id: id.into(),
            name: "gomi".into(),
            platform: Some("win32".into()),
            relay_url: "ws://100.100.1.1:4400".into(),
            alts: vec!["ws://192.168.1.20:4400".into()],
            paired_at: 5.0,
            color: 0,
            fleet: None,
        }
    }

    #[test]
    fn the_nearest_route_comes_first() {
        let alts = vec!["ws://192.168.1.20:4400".to_string(), "wss://relay.example".to_string()];
        assert_eq!(
            ordered_routes("ws://100.100.1.1:4400", &alts),
            ["ws://192.168.1.20:4400", "ws://100.100.1.1:4400", "wss://relay.example"]
        );
    }

    #[test]
    fn the_list_file_holds_no_secrets_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let c = computers(dir.path());
        lock(&c.list).push(paired("ab12cd34"));
        c.vault
            .set(
                "ab12cd34",
                &serde_json::to_string(&Secrets {
                    room: "r00m".into(),
                    secret: "s3cret".into(),
                    host_key: "h0stkey".into(),
                    device_id: "d".into(),
                    device_key: "k3y".into(),
                })
                .unwrap(),
            )
            .unwrap();
        c.save().unwrap();
        let text = std::fs::read_to_string(dir.path().join("computers.json")).unwrap();
        assert!(!text.contains("s3cret") && !text.contains("r00m") && !text.contains("k3y"));
        assert_eq!(*lock(&computers(dir.path()).list), vec![paired("ab12cd34")]);
    }

    #[tokio::test]
    async fn rename_and_color_edit_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let c = computers(dir.path());
        lock(&c.list).push(paired("ab12cd34"));
        c.route("computers:rename", &[json!("ab12cd34"), json!("  studio ")]).await.unwrap();
        c.route("computers:setColor", &[json!("ab12cd34"), json!(3)]).await.unwrap();
        let v = c.list();
        assert_eq!((v[0]["name"].as_str(), v[0]["color"].as_u64()), (Some("studio"), Some(3)));
        assert_eq!(v[0]["state"], "offline", "no link yet");
        assert!(c.route("computers:rename", &[json!("ab12cd34"), json!("  ")]).await.is_err());
        assert!(c.route("computers:rename", &[json!("nope"), json!("x")]).await.is_err());
    }

    #[tokio::test]
    async fn pairing_refuses_a_link_it_cant_use() {
        let dir = tempfile::tempdir().unwrap();
        let c = computers(dir.path());
        let host_key = nekko_remote::proof::public_key(&new_key().unwrap().0);
        let link = |relay: &str, pair: &str| json!({ "relayUrl": relay, "room": "abcd1234", "key": "0123456789abcdef", "hostKey": host_key, "pair": pair, "alts": [] });
        let e = c.route("computers:pair", &[link("ws://100.100.1.1:4400", "")]).await.unwrap_err();
        assert!(e.contains("no pairing code"), "{e}");
        let e = c.route("computers:pair", &[link("ws://example.com", "ABCD2345")]).await.unwrap_err();
        assert!(e.contains("not encrypted"), "{e}");
        assert_eq!(c.list(), json!([]));
    }

    #[test]
    fn a_refusal_says_what_to_do() {
        assert!(pair_refusal(&State::Denied("bad-code".into()), "gomi").contains("for a phone"));
        assert!(pair_refusal(&State::Denied("update-required".into()), "gomi").contains("Update"));
    }

    #[test]
    fn the_state_a_window_reads() {
        assert_eq!(state_text(&State::Denied("update-required".into())), "update");
        assert_eq!(state_text(&State::Denied("kicked".into())), "denied");
    }

    #[test]
    fn a_fleet_link_is_listed_but_never_saved() {
        let dir = tempfile::tempdir().unwrap();
        let c = computers(dir.path());
        lock(&c.list).push(paired("ab12cd34"));
        lock(&c.list).push(Paired { fleet: Some("org".into()), ..paired(&fleet_link_id("7e1f0a9c-2b3d-4e5f")) });
        c.save().unwrap();
        let saved = std::fs::read_to_string(dir.path().join("computers.json")).unwrap();
        assert!(saved.contains("ab12cd34") && !saved.contains("f7e1f0a9c2b3") && !saved.contains("fleet"), "{saved}");
        let listed = c.list();
        assert_eq!(listed.as_array().unwrap().len(), 2);
        assert_eq!(listed[1]["fleet"], "org", "the window can tell a fleet link from a paired one");
        // Restarted: only the paired one comes back.
        let again = computers(dir.path());
        assert_eq!(again.list().as_array().unwrap().len(), 1);
    }

    #[test]
    fn fleet_link_ids_and_refusals_read_well() {
        assert_eq!(fleet_link_id("7e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b"), "f7e1f0a9c2b3");
        let r = |reason: &str| fleet_refusal(&State::Denied(reason.into()), "gomi");
        assert_eq!(r("fleet-off"), "gomi stopped sharing with this organization.");
        assert_eq!(r("fleet-device"), "gomi doesn't trust this computer yet. Try again in a minute.");
        assert_eq!(r("update-required"), "Update Nekko Agent on gomi.");
    }
}
