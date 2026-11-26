//! Daemon-owned remote access: the persisted relay config
//! and paired-device registry in `remote.json`, the single-use pairing code,
//! and the live relay agent. The registry is the auth layer: a device must
//! complete the HELLO handshake against it before the agent serves a single
//! request; new devices enroll only with a short-lived code; revoking a
//! device kicks it live. This process is the file's only writer.

use crate::client::SigningKey;
use crate::fleet::{Admitted, Binding, FleetGate};
use crate::hello::{self, Grant, PAIRING_TTL_MS, Random, Verdict};
use crate::jsobj::JsObj;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

/// How the stored pairing works: 2 is a room credential derived from the secret
/// (decision 0036), 3 adds the host key devices pin (decision 0041). Anything
/// else is replaced at start, so a secret a revoked device kept dies with it.
const PAIRING_VERSION: u64 = 3;

/// Validates a device's HELLO, answering with the sealed reply.
pub type Verifier = Arc<dyn Fn(&Value) -> Value + Send + Sync>;

/// `Date.now()`; tests pass a fixed clock.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
    })
}

/// What connects the agent to a relay (`connectRelayAgent`).
pub trait Link: Send + Sync {
    fn connect(
        &self,
        relay_url: &str,
        room: &str,
        key: &str,
        host_key: SigningKey,
        verify: Verifier,
    ) -> Arc<dyn LinkHandle>;
}

/// A running relay agent (`RelayAgentHandle`).
pub trait LinkHandle: Send + Sync {
    fn stop(&self);
    /// Kick a device's live connections and drop its push token.
    fn kick_device(&self, device_id: &str);
    /// Kick a device's live connections and keep its push token
    /// (`remote:stop`: the phone is disconnected, not signed out).
    fn disconnect_device(&self, device_id: &str) {
        self.kick_device(device_id);
    }
    /// The owner's Read switch for a device's live connections: events stop or resume.
    fn set_reads(&self, _device_id: &str, _reads: bool) {}
    /// Device ids with a welcomed live connection.
    fn connected_devices(&self) -> Vec<String>;
    fn is_online(&self) -> bool;
    fn last_error(&self) -> Option<String>;
    /// Device ids connected through one route (`cloud` or `direct`); all of them for a single relay.
    fn connected_via(&self, _via: &str) -> Vec<String> {
        self.connected_devices()
    }
}

/// Every relay this computer is reachable through at once (decision 0116):
/// the same room on each, so a device may come in through Nekko Cloud Relay or
/// directly (Tailscale, the LAN, the owner's own relay), as its route allows.
struct Routes {
    links: Vec<(String, Arc<dyn LinkHandle>)>,
}

impl LinkHandle for Routes {
    fn stop(&self) {
        self.links.iter().for_each(|(_, h)| h.stop());
    }
    fn kick_device(&self, device_id: &str) {
        self.links.iter().for_each(|(_, h)| h.kick_device(device_id));
    }
    fn disconnect_device(&self, device_id: &str) {
        self.links.iter().for_each(|(_, h)| h.disconnect_device(device_id));
    }
    fn set_reads(&self, device_id: &str, reads: bool) {
        self.links.iter().for_each(|(_, h)| h.set_reads(device_id, reads));
    }
    fn connected_devices(&self) -> Vec<String> {
        let mut all: Vec<String> = self.links.iter().flat_map(|(_, h)| h.connected_devices()).collect();
        all.sort();
        all.dedup();
        all
    }
    /// Online while any route is: a device can still come in.
    fn is_online(&self) -> bool {
        self.links.iter().any(|(_, h)| h.is_online())
    }
    fn last_error(&self) -> Option<String> {
        if self.is_online() {
            return None;
        }
        self.links.iter().find_map(|(_, h)| h.last_error())
    }
    fn connected_via(&self, via: &str) -> Vec<String> {
        self.links
            .iter()
            .filter(|(url, _)| crate::route::via(url) == via)
            .flat_map(|(_, h)| h.connected_devices())
            .collect()
    }
}

impl Routes {
    fn rows(&self) -> Value {
        Value::Array(
            self.links
                .iter()
                .map(|(url, h)| {
                    json!({
                        "url": url,
                        "via": crate::route::via(url),
                        "online": h.is_online(),
                        "error": if h.is_online() { None } else { h.last_error() },
                    })
                })
                .collect(),
        )
    }
}

/// At most this many relays besides the main one.
pub const MAX_ALSO_RELAYS: usize = 3;

#[derive(Default)]
struct State {
    handle: Option<Arc<dyn LinkHandle>>,
    /// The same agents as `handle`, per relay, while there is more than one.
    routes: Option<Arc<Routes>>,
    grant: Option<Grant>,
}

/// A device let in through the fleet (decision 0102): kept in memory only,
/// never in `remote.json`, for as long as [`FleetGate::still`] says so.
#[derive(Debug, Clone)]
struct FleetDevice {
    admitted: Admitted,
    /// The HELLO key, which also signs its Change proofs.
    key: String,
}

pub struct RemoteService {
    file: PathBuf,
    random: Random,
    clock: Clock,
    link: Box<dyn Link>,
    state: Mutex<State>,
    /// Read-modify-write of the file, one at a time.
    io: Mutex<()>,
    me: Weak<RemoteService>,
    /// Who may connect through the fleet; none until the daemon sets it.
    fleet_gate: Mutex<Option<Arc<dyn FleetGate>>>,
    /// Fleet devices admitted, by their link id (`fleet:<device>`).
    fleet: Mutex<std::collections::HashMap<String, FleetDevice>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn s(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

impl RemoteService {
    pub fn new(data_dir: &Path, random: Random, clock: Clock, link: Box<dyn Link>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            file: data_dir.join("remote.json"),
            random,
            clock,
            link,
            state: Mutex::default(),
            io: Mutex::new(()),
            me: me.clone(),
            fleet_gate: Mutex::new(None),
            fleet: Mutex::default(),
        })
    }

    /// `load()`: every key in its declared place, `undefined` included.
    fn load(&self) -> JsObj {
        ensure_private(&self.file);
        let parsed = std::fs::read(&self.file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        match parsed {
            // `JSON.parse` gave `null`: reading `.enabled` throws, so the default.
            Some(Value::Null) | None => {
                JsObj::new().with("enabled", Some(json!(false))).with("devices", Some(json!([])))
            }
            Some(cfg) => {
                let get = |k: &str| cfg.get(k).cloned();
                let or = |v: Option<Value>, d: Value| Some(v.filter(|v| !v.is_null()).unwrap_or(d));
                JsObj::new()
                    .with("enabled", or(get("enabled"), json!(false)))
                    .with("relayUrl", get("relayUrl"))
                    // Decision 0116: relays this computer is also reachable through, same room.
                    .with("alsoRelays", get("alsoRelays"))
                    .with("room", get("room"))
                    .with("secret", get("secret"))
                    .with("hostKey", get("hostKey"))
                    .with("pairing", get("pairing"))
                    .with("devices", or(get("devices"), json!([])))
                    // Relay replay protection: phones from before protocol 4
                    // are welcomed unless this is `false` (one release).
                    .with("acceptLegacyPhones", get("acceptLegacyPhones"))
                    // SK-3: `{ deviceId, name, at }` when a phone stopped remote access, for the desktop's banner.
                    .with("stoppedBy", get("stoppedBy"))
            }
        }
    }

    /// A room and secret from an older pairing: replaced, keeping the paired
    /// devices, so phones pair again with a secret no revoked device holds and
    /// a host key to pin. `None` when the pairing is already current or there
    /// is none.
    fn upgraded_pairing(&self, cfg: &JsObj) -> Option<JsObj> {
        let readable = s(cfg.get("hostKey")).and_then(crate::proof::parse_key_text).is_some();
        let current = cfg.get("pairing").and_then(Value::as_u64) == Some(PAIRING_VERSION) && readable;
        if current || !nekko_js::truthy(cfg.get("secret")) {
            return None;
        }
        Some(
            cfg.clone()
                .with("room", Some(json!(hello::new_room_code(&self.random))))
                .with("secret", Some(json!(hello::new_room_secret(&self.random))))
                .with("hostKey", Some(self.new_host_key()))
                .with("pairing", Some(json!(PAIRING_VERSION))),
        )
    }

    fn new_host_key(&self) -> Value {
        json!(crate::proof::key_text(&crate::proof::new_key(&self.random)))
    }

    fn save(&self, cfg: &JsObj) -> Result<(), String> {
        write_json_atomic(&self.file, &cfg.to_value()).map_err(|e| e.to_string())
    }

    fn devices_of(cfg: &JsObj) -> Vec<Value> {
        cfg.get("devices").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn live_grant(&self, st: &State) -> Option<Grant> {
        st.grant.clone().filter(|g| g.expires_at > (self.clock)())
    }

    /// The HELLO check the agent runs for every connection. The agent has
    /// already checked the HELLO's challenge. A phone app older than this
    /// protocol ([`hello::SESSION_PROTOCOL`]) is refused with `update-required`;
    /// otherwise the HELLO must be signed with the device's key
    /// ([`hello::check_hello_key`]) before the registry is consulted, and a
    /// device that enrolls with the live code keeps the key it signed with
    /// (`remote-hello-keys.json`).
    pub fn verify(&self, hello_frame: &Value) -> Value {
        let _io = lock(&self.io);
        let cfg = self.load();
        let protocol = hello_frame.as_object().map_or(1, crate::agent::hello_protocol);
        let known = |cfg: &JsObj| -> Option<Value> {
            let id = hello_frame.get("deviceId")?;
            Self::devices_of(cfg).into_iter().find(|d| d.get("id") == Some(id) && !nekko_js::truthy(d.get("revoked")))
        };
        if protocol < hello::SESSION_PROTOCOL {
            if let Some(d) = known(&cfg) {
                let id = d.get("id").map(nekko_js::display).unwrap_or_default();
                eprintln!("nekkod: refused phone {id}: its app can't check this computer; it needs an update");
                self.record_locked(&id, self.legacy_entry(false));
            }
            return json!({ "type": "denied", "reason": "update-required" });
        }
        if let Some(fleet) = hello_frame.get("fleet") {
            let room = cfg.get("room").and_then(Value::as_str).unwrap_or_default().to_string();
            return self.verify_fleet(hello_frame, fleet, &room);
        }
        // Fleet ids are the fleet's alone: no pairing may take one.
        if hello_frame.get("deviceId").and_then(Value::as_str).is_some_and(crate::fleet::is_fleet_id) {
            return json!({ "type": "denied", "reason": "invalid" });
        }
        let mut st = lock(&self.state);
        let now = (self.clock)();
        // A code only pairs what it was minted for, so a link can't change a
        // device's class: not a new device's, nor a paired one's, on re-pairing.
        let computer = hello_frame.get("platform").and_then(Value::as_str) == Some(hello::COMPUTER_PLATFORM);
        let is_computer = |d: &Value| d.get("kind").and_then(Value::as_str) == Some(hello::COMPUTER_PLATFORM);
        let same_class = known(&cfg).is_none_or(|d| is_computer(&d) == computer);
        let grant = self.live_grant(&st).filter(|g| g.computer == computer && same_class);
        let code_ok = grant.as_ref().is_some_and(|g| {
            hello_frame.get("pair").and_then(Value::as_str) == Some(g.code.as_str()) && g.expires_at > now
        });
        // Decision 0116: a device limited to one route is turned away on the
        // other. A live code carries the route its pairing chose instead.
        if let Some(via) = hello_frame.get("via").and_then(Value::as_str) {
            let chosen = if code_ok {
                grant.as_ref().and_then(|g| g.route.clone())
            } else {
                known(&cfg).and_then(|d| d.get("route").and_then(Value::as_str).map(str::to_string))
            };
            if !crate::route::route_allows(chosen.as_deref(), via) {
                return json!({ "type": "denied", "reason": "route" });
            }
        }
        let room = cfg.get("room").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut keys = self.load_hello_keys();
        let id_text = hello_frame.get("deviceId").and_then(Value::as_str).unwrap_or_default();
        let stored = known(&cfg).map(|_| json!({ "helloKey": keys.get(id_text) }));
        let new_key = match hello::check_hello_key(stored.as_ref(), hello_frame, &room, code_ok) {
            Ok(k) => k,
            Err(reason) => return json!({ "type": "denied", "reason": reason }),
        };
        let verdict = hello::verify_hello(&Self::devices_of(&cfg), hello_frame, grant.as_ref(), now);
        if let Verdict::Welcome { device, enrolled } = &verdict {
            let mut device = device.clone();
            if let Some(o) = device.as_object_mut() {
                o.remove("legacyProtocol");
                if *enrolled && computer {
                    o.insert("kind".into(), json!(hello::COMPUTER_PLATFORM));
                }
                // Paired (or paired again) with a code minted for one route: the device keeps that choice.
                if code_ok && let Some(route) = grant.as_ref().and_then(|g| g.route.as_deref()) {
                    o.insert("route".into(), json!(route));
                }
            }
            let id = device.get("id").cloned();
            let mut devices: Vec<Value> =
                Self::devices_of(&cfg).into_iter().filter(|d| d.get("id") != id.as_ref()).collect();
            devices.push(device.clone());
            // A registry that cannot be written turns the device away (the TS
            // host threw here and left the phone with no reply at all).
            if self.save(&cfg.clone().with("devices", Some(Value::Array(devices)))).is_err() {
                return json!({ "type": "denied", "reason": "invalid" });
            }
            if let Some(k) = &new_key {
                keys.insert(id_text.to_string(), json!(k));
                if write_json_atomic(&self.hello_keys_file(), &Value::Object(keys)).is_err() {
                    return json!({ "type": "denied", "reason": "invalid" });
                }
            }
            if *enrolled || new_key.is_some() {
                st.grant = None; // single use, re-enrolling a known device included
            }
            return Verdict::Welcome { device, enrolled: *enrolled }.reply();
        }
        verdict.reply()
    }

    /// A HELLO with a `fleet` object: a device of this computer's own account,
    /// found through an org it shares with (decision 0102). It must be signed
    /// with its HELLO key for this exchange, as any HELLO is, and its proof must
    /// satisfy the gate. It never brings a code and never reaches the registry.
    fn verify_fleet(&self, hello_frame: &Value, fleet: &Value, room: &str) -> Value {
        let deny = |reason: &str| json!({ "type": "denied", "reason": reason });
        let text = |k: &str| hello_frame.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
        let (Some(device_id), Some(challenge), Some(host_eph), Some(client_eph), Some(hello_key)) =
            (text("deviceId"), text("challenge"), text("hostEph"), text("clientEph"), text("helloKey"))
        else {
            return deny("invalid");
        };
        if !crate::fleet::is_fleet_id(device_id) || nekko_js::truthy(hello_frame.get("pair")) {
            return deny("invalid");
        }
        let signed = hello::hello_text(device_id, room, challenge, host_eph, client_eph);
        let sig = text("sig").and_then(crate::proof::b64).filter(|s| s.len() == 64);
        let key = crate::proof::parse_key(hello_key);
        if !matches!((&key, &sig), (Some(k), Some(s)) if crate::proof::verify(k, &signed, s)) {
            return deny("invalid");
        }
        let Some(gate) = lock(&self.fleet_gate).clone() else { return deny("fleet-off") };
        let binding = Binding {
            room: room.to_string(),
            challenge: challenge.to_string(),
            host_eph: host_eph.to_string(),
            client_eph: client_eph.to_string(),
            hello_key: hello_key.to_string(),
        };
        let admitted = match gate.admit(fleet, &binding) {
            Ok(a) => a,
            Err(reason) => return deny(reason),
        };
        if crate::fleet::link_device_id(&admitted.device_id) != device_id {
            return deny("invalid");
        }
        let now = hello::nekko_num((self.clock)());
        let name = if admitted.name.is_empty() { "Computer".to_string() } else { admitted.name.clone() };
        let device = json!({
            "id": device_id,
            "name": hello::cut16(&name, 60),
            "platform": hello::COMPUTER_PLATFORM,
            "kind": hello::COMPUTER_PLATFORM,
            "fleet": true,
            "changeKey": hello_key,
            "access": { "read": true, "change": true },
            "createdAt": now.clone(),
            "lastSeenAt": now,
        });
        lock(&self.fleet).insert(device_id.to_string(), FleetDevice { admitted, key: hello_key.to_string() });
        Verdict::Welcome { device, enrolled: false }.reply()
    }

    /// Let devices of this computer's account connect through the fleet.
    pub fn set_fleet_gate(&self, gate: Arc<dyn FleetGate>) {
        *lock(&self.fleet_gate) = Some(gate);
    }

    /// Ask the gate again about every fleet device let in, and cut off the ones
    /// it no longer allows: their live connections are kicked, not only their
    /// listing hidden. The daemon calls this when the account changes and on a
    /// timer. Returns the link ids cut off.
    pub fn recheck_fleet(&self) -> Vec<String> {
        let gate = lock(&self.fleet_gate).clone();
        let held: Vec<(String, Admitted)> =
            lock(&self.fleet).iter().map(|(id, d)| (id.clone(), d.admitted.clone())).collect();
        let gone: Vec<String> =
            held.into_iter().filter(|(_, a)| !gate.as_ref().is_some_and(|g| g.still(a))).map(|(id, _)| id).collect();
        if gone.is_empty() {
            return gone;
        }
        {
            let mut fleet = lock(&self.fleet);
            for id in &gone {
                fleet.remove(id);
            }
        }
        if let Some(h) = self.handle() {
            for id in &gone {
                h.kick_device(id);
            }
        }
        gone
    }

    /// The fleet devices let in, for `remote:status`: `{ id, name, orgId }`.
    fn fleet_rows(&self) -> Value {
        let fleet = lock(&self.fleet);
        let mut rows: Vec<Value> = fleet
            .iter()
            .map(|(id, d)| json!({ "id": id, "name": d.admitted.name, "orgId": d.admitted.org_id }))
            .collect();
        rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        Value::Array(rows)
    }

    /// The activity entry for a legacy phone's HELLO, welcomed or refused.
    fn legacy_entry(&self, ok: bool) -> crate::phone::Activity {
        crate::phone::Activity {
            at: (self.clock)(),
            channel: LEGACY_HELLO.to_string(),
            ok,
            reason: Some("legacy-protocol".into()),
        }
    }

    fn verifier(&self) -> Verifier {
        let me = self.me.clone();
        Arc::new(move |h: &Value| match me.upgrade() {
            Some(svc) => svc.verify(h),
            None => json!({ "type": "denied", "reason": "invalid" }),
        })
    }

    fn connect(&self, st: &mut State, cfg: &JsObj) {
        if let Some(h) = st.handle.take() {
            h.stop();
        }
        let (Some(url), Some(room), Some(key)) = (s(cfg.get("relayUrl")), s(cfg.get("room")), s(cfg.get("secret")))
        else {
            return;
        };
        let Some(host_key) = s(cfg.get("hostKey")).and_then(crate::proof::parse_key_text) else {
            eprintln!("nekkod: remote access has no usable host key; rotate the pairing to make one");
            return;
        };
        st.routes = None;
        let urls = Self::relay_urls(cfg);
        if urls.len() <= 1 {
            st.handle = Some(self.link.connect(url, room, key, host_key, self.verifier_via(crate::route::via(url))));
            return;
        }
        let links = urls
            .into_iter()
            .map(|u| {
                let h = self.link.connect(&u, room, key, host_key.clone(), self.verifier_via(crate::route::via(&u)));
                (u, h)
            })
            .collect();
        let routes = Arc::new(Routes { links });
        st.handle = Some(routes.clone());
        st.routes = Some(routes);
    }

    /// The main relay, then the others it is also reachable through, each once.
    fn relay_urls(cfg: &JsObj) -> Vec<String> {
        let mut urls: Vec<String> = Vec::new();
        let main = s(cfg.get("relayUrl")).map(str::to_string);
        let also = cfg.get("alsoRelays").and_then(Value::as_array).cloned().unwrap_or_default();
        let norm = |u: &str| u.trim().trim_end_matches('/').to_ascii_lowercase();
        for u in main.into_iter().chain(also.iter().filter_map(|v| v.as_str().map(str::to_string))) {
            if crate::route::relay_url_problem(&u).is_none() && !urls.iter().any(|x| norm(x) == norm(&u)) {
                urls.push(u.trim().trim_end_matches('/').to_string());
            }
        }
        urls.truncate(1 + MAX_ALSO_RELAYS);
        urls
    }

    /// The HELLO check for one relay: what `verify` checks, told which route
    /// the HELLO came in on. Set here, over anything the device sent.
    fn verifier_via(&self, via: &'static str) -> Verifier {
        let inner = self.verifier();
        Arc::new(move |h: &Value| match h {
            Value::Object(m) => {
                let mut m = m.clone();
                m.insert("via".into(), json!(via));
                inner(&Value::Object(m))
            }
            other => inner(other),
        })
    }

    /// The running agent, out of the lock: its own lock is taken while the
    /// agent calls `verify`, which takes ours, so never hold both.
    fn handle(&self) -> Option<Arc<dyn LinkHandle>> {
        lock(&self.state).handle.clone()
    }

    fn status_of(&self, handle: Option<Arc<dyn LinkHandle>>, cfg: &JsObj) -> Value {
        if nekko_js::truthy(cfg.get("enabled")) {
            let h = handle.as_deref();
            // Out of the lock before asking the agents anything (see `handle`).
            let routes = lock(&self.state).routes.clone();
            JsObj::new()
                .with("enabled", Some(json!(true)))
                .with("relayUrl", cfg.get("relayUrl").cloned())
                .with("room", cfg.get("room").cloned())
                .with("hasKey", Some(json!(nekko_js::truthy(cfg.get("secret")))))
                .with("devices", cfg.get("devices").cloned())
                .with("connected", Some(json!(h.map(|h| h.connected_devices()).unwrap_or_default())))
                .with("online", Some(json!(h.is_some_and(|h| h.is_online()))))
                .with("error", h.and_then(|h| h.last_error()).map(Value::from))
                .with("stoppedBy", cfg.get("stoppedBy").cloned())
                // Only while one is in: the shape is unchanged for everyone else.
                .with("fleet", Some(self.fleet_rows()).filter(|r| r.as_array().is_some_and(|a| !a.is_empty())))
                // Decision 0116, only while there is more than one relay: each route's state.
                .with(
                    "alsoRelays",
                    cfg.get("alsoRelays").cloned().filter(|v| v.as_array().is_some_and(|a| !a.is_empty())),
                )
                .with("relays", routes.map(|r| r.rows()))
                .to_value()
        } else {
            JsObj::new()
                .with("enabled", Some(json!(false)))
                .with("devices", cfg.get("devices").cloned())
                .with("stoppedBy", cfg.get("stoppedBy").cloned())
                .to_value()
        }
    }

    pub fn enable(&self, relay_url: &Value) -> Result<Value, String> {
        // Plain ws:// to the open internet is refused here as on every phone (PH1).
        if let Some(problem) = crate::route::relay_url_problem(relay_url.as_str().unwrap_or("")) {
            return Err(problem);
        }
        let _io = lock(&self.io);
        let loaded = self.load();
        let prev = self.upgraded_pairing(&loaded).unwrap_or(loaded);
        let room = match prev.get("room").filter(|v| !v.is_null()) {
            Some(r) => r.clone(),
            None => json!(hello::new_room_code(&self.random)),
        };
        let secret = match prev.get("secret").filter(|v| !v.is_null()) {
            Some(s) => s.clone(),
            None => json!(hello::new_room_secret(&self.random)),
        };
        let host_key = prev.get("hostKey").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| self.new_host_key());
        let cfg = prev
            .with("enabled", Some(json!(true)))
            // Turned on again at the computer: the banner about a phone's stop goes.
            .with("stoppedBy", None)
            .with("relayUrl", Some(relay_url.clone()))
            .with("room", Some(room))
            .with("secret", Some(secret))
            .with("hostKey", Some(host_key))
            .with("pairing", Some(json!(PAIRING_VERSION)));
        self.save(&cfg)?;
        self.connect(&mut lock(&self.state), &cfg);
        drop(_io);
        Ok(self.status_of(self.handle(), &cfg))
    }

    /// `attach({ relayUrl, room, secret, hostKey? })`: join a room someone else
    /// chose (relay-agent mode, `NEKKO_RELAY_URL` + `NEKKO_ROOM` + `NEKKO_PAIR_KEY`,
    /// and `NEKKO_HOST_KEY` when whoever chose it wrote the link), keeping the
    /// devices already paired. Internal: not an IPC channel the UI has, and a
    /// phone may not call any `remote:` channel.
    pub fn attach(&self, opts: &Value) -> Result<Value, String> {
        let relay_url = opts.get("relayUrl").cloned().unwrap_or(Value::Null);
        if let Some(problem) = crate::route::relay_url_problem(relay_url.as_str().unwrap_or("")) {
            return Err(problem);
        }
        let text = |k: &str| opts.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| json!(s));
        let (Some(room), Some(secret)) = (text("room"), text("secret")) else {
            return Err("remote:attach needs a room and a secret".into());
        };
        let _io = lock(&self.io);
        let prev = self.load();
        let host_key = match (text("hostKey"), prev.get("hostKey").filter(|v| !v.is_null())) {
            (Some(k), _) if k.as_str().and_then(crate::proof::parse_key_text).is_none() => {
                return Err("remote:attach: that host key can't be read".into());
            }
            (Some(k), _) => k,
            (None, Some(k)) => k.clone(),
            (None, None) => self.new_host_key(),
        };
        let cfg = prev
            .with("enabled", Some(json!(true)))
            .with("relayUrl", Some(relay_url))
            .with("room", Some(room))
            .with("secret", Some(secret))
            .with("hostKey", Some(host_key))
            .with("pairing", Some(json!(PAIRING_VERSION)));
        self.save(&cfg)?;
        self.connect(&mut lock(&self.state), &cfg);
        drop(_io);
        Ok(self.status_of(self.handle(), &cfg))
    }

    pub fn disable(&self) -> Result<Value, String> {
        let _io = lock(&self.io);
        lock(&self.fleet).clear();
        let mut st = lock(&self.state);
        if let Some(h) = st.handle.take() {
            h.stop();
        }
        st.routes = None;
        st.grant = None;
        drop(st);
        let cfg = self.load().with("enabled", Some(json!(false)));
        self.save(&cfg)?;
        Ok(self.status_of(None, &cfg))
    }

    pub fn status(&self) -> Value {
        let cfg = {
            let _io = lock(&self.io);
            self.load()
        };
        self.status_of(self.handle(), &cfg)
    }

    pub fn pairing(&self) -> Value {
        let cfg = {
            let _io = lock(&self.io);
            self.load()
        };
        let t = |k: &str| nekko_js::truthy(cfg.get(k));
        if !t("enabled") || !t("relayUrl") || !t("room") || !t("secret") {
            return Value::Null;
        }
        let host_key = s(cfg.get("hostKey")).and_then(crate::proof::parse_key_text);
        json!({
            "relayUrl": cfg.get("relayUrl"),
            "room": cfg.get("room"),
            "key": cfg.get("secret"),
            "hostKey": host_key.map(|k| crate::proof::public_key(&k)),
        })
    }

    pub fn pair(&self) -> Value {
        self.pair_with(&Value::Null)
    }

    /// `remote:pair [code]`: a one-time pairing code, random unless the caller
    /// brings one (a Nekko Cloud machine's, minted by Nekko Cloud and handed to
    /// the phone in its pairing link). A preset code must be 8 to 16 characters
    /// of the pairing alphabet; anything else is ignored and a random one is made.
    pub fn pair_with(&self, preset: &Value) -> Value {
        self.mint(preset, false, None)
    }

    /// `remote:pair [code, { route }]` (decision 0116): a code for a device
    /// that connects only through `route` (`cloud` or `direct`); `auto` or
    /// none lets it use either.
    pub fn pair_routed(&self, preset: &Value, opts: &Value) -> Result<Value, String> {
        let route = match opts.get("route") {
            None | Some(Value::Null) => None,
            Some(Value::String(r)) if crate::route::DEVICE_ROUTES.contains(&r.as_str()) => {
                Some(r.clone()).filter(|r| r != "auto")
            }
            Some(_) => return Err("remote:pair: route must be auto, cloud or direct".into()),
        };
        Ok(self.mint(preset, false, route))
    }

    /// `remote:pairComputer`: a one-time code that enrolls a computer, not a phone.
    pub fn pair_computer(&self) -> Value {
        self.mint(&Value::Null, true, None)
    }

    fn mint(&self, preset: &Value, computer: bool, route: Option<String>) -> Value {
        let preset = preset
            .as_str()
            .filter(|c| (8..=16).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()));
        let code = match preset {
            Some(c) => c.to_string(),
            None => hello::new_pairing_code(&self.random, 8),
        };
        let grant = Grant { code, expires_at: (self.clock)() + PAIRING_TTL_MS, computer, route };
        let v = grant.value();
        lock(&self.state).grant = Some(grant);
        v
    }

    pub fn devices(&self) -> Value {
        let _io = lock(&self.io);
        self.load().get("devices").cloned().unwrap_or(json!([]))
    }

    pub fn revoke(&self, device_id: &Value) -> Result<Value, String> {
        let _io = lock(&self.io);
        let cfg = self.load();
        let devices: Vec<Value> = Self::devices_of(&cfg)
            .into_iter()
            .map(|d| match d {
                Value::Object(mut m) if m.get("id") == Some(device_id) => {
                    m.insert("revoked".into(), json!(true));
                    Value::Object(m)
                }
                d => d,
            })
            .collect();
        self.save(&cfg.with("devices", Some(Value::Array(devices.clone()))))?;
        drop(_io);
        if let (Some(h), Some(id)) = (self.handle(), device_id.as_str()) {
            h.kick_device(id);
        }
        Ok(Value::Array(devices))
    }

    pub fn rename(&self, device_id: &Value, name: &Value) -> Result<Value, String> {
        let name = name.as_str().ok_or("name.trim is not a function")?;
        let clean = hello::cut16(nekko_js::trim(name), 60).to_string();
        let _io = lock(&self.io);
        let cfg = self.load();
        let devices: Vec<Value> = Self::devices_of(&cfg)
            .into_iter()
            .map(|d| match d {
                Value::Object(mut m) if m.get("id") == Some(device_id) && !clean.is_empty() => {
                    m.insert("name".into(), json!(clean));
                    Value::Object(m)
                }
                d => d,
            })
            .collect();
        let cfg = cfg.with("devices", Some(Value::Array(devices.clone())));
        self.save(&cfg)?;
        Ok(Value::Array(devices))
    }

    /// `remote:setAccess(deviceId, { read?, change? })` (IO-33): a paired
    /// phone's switches, saved on its record as `access` with both fields.
    /// Only the desktop calls it: every `remote:` channel is refused from a phone.
    pub fn set_access(&self, device_id: &Value, patch: &Value) -> Result<Value, String> {
        let patch = patch.as_object().ok_or("remote:setAccess needs { read?, change? }")?;
        for (k, v) in patch {
            if !matches!(k.as_str(), "read" | "change") || !v.is_boolean() {
                return Err(format!("remote:setAccess: {k} must be read or change, true or false"));
            }
        }
        let _io = lock(&self.io);
        let cfg = self.load();
        let mut found = false;
        let devices: Vec<Value> = Self::devices_of(&cfg)
            .into_iter()
            .map(|d| match d {
                Value::Object(mut m) if m.get("id") == Some(device_id) => {
                    found = true;
                    let was = crate::phone::DeviceAccess::of(&Value::Object(m.clone()));
                    let get = |k: &str, d: bool| patch.get(k).and_then(Value::as_bool).unwrap_or(d);
                    m.insert(
                        "access".into(),
                        json!({ "read": get("read", was.read), "change": get("change", was.change) }),
                    );
                    Value::Object(m)
                }
                d => d,
            })
            .collect();
        if !found {
            return Err("remote:setAccess: no device with that id".into());
        }
        self.save(&cfg.with("devices", Some(Value::Array(devices.clone()))))?;
        drop(_io);
        if let (Some(read), Some(h), Some(id)) =
            (patch.get("read").and_then(Value::as_bool), self.handle(), device_id.as_str())
        {
            h.set_reads(id, read);
        }
        Ok(Value::Array(devices))
    }

    /// `remote:setRoute(deviceId, route)` (decision 0116): how a paired device
    /// may reach this computer: `cloud` (Nekko Cloud Relay only), `direct`
    /// (Tailscale, the LAN or the owner's own relay only) or `auto` (either).
    /// A live connection on a route it no longer has is closed; the device
    /// comes back on the route it is allowed, if it knows one.
    pub fn set_route(&self, device_id: &Value, route: &Value) -> Result<Value, String> {
        let route = route
            .as_str()
            .filter(|r| crate::route::DEVICE_ROUTES.contains(r))
            .ok_or("remote:setRoute: route must be auto, cloud or direct")?;
        let _io = lock(&self.io);
        let cfg = self.load();
        let mut found = false;
        let devices: Vec<Value> = Self::devices_of(&cfg)
            .into_iter()
            .map(|d| match d {
                Value::Object(mut m) if m.get("id") == Some(device_id) && !nekko_js::truthy(m.get("revoked")) => {
                    found = true;
                    if route == "auto" {
                        m.remove("route");
                    } else {
                        m.insert("route".into(), json!(route));
                    }
                    Value::Object(m)
                }
                d => d,
            })
            .collect();
        if !found {
            return Err("remote:setRoute: no device with that id".into());
        }
        self.save(&cfg.with("devices", Some(Value::Array(devices.clone()))))?;
        drop(_io);
        if let (Some(h), Some(id)) = (self.handle(), device_id.as_str()) {
            for via in ["cloud", "direct"] {
                if !crate::route::route_allows(Some(route), via) && h.connected_via(via).iter().any(|d| d == id) {
                    h.disconnect_device(id);
                }
            }
        }
        Ok(Value::Array(devices))
    }

    /// `remote:setRelays(urls)` (decision 0116): the relays this computer is
    /// also reachable through besides its main one, at most three, each held
    /// to the same rule as the main one. Empty turns the extra routes off.
    pub fn set_relays(&self, urls: &Value) -> Result<Value, String> {
        let urls = urls.as_array().ok_or("remote:setRelays needs a list of relay addresses")?;
        let mut clean: Vec<Value> = Vec::new();
        for u in urls {
            let u = u.as_str().ok_or("remote:setRelays: each relay is an address")?.trim().trim_end_matches('/');
            if let Some(problem) = crate::route::relay_url_problem(u) {
                return Err(problem);
            }
            if !clean.iter().any(|c| c.as_str().is_some_and(|c| c.eq_ignore_ascii_case(u))) {
                clean.push(json!(u));
            }
        }
        if clean.len() > MAX_ALSO_RELAYS {
            return Err(format!("remote:setRelays: at most {MAX_ALSO_RELAYS} relays besides the main one"));
        }
        let _io = lock(&self.io);
        let cfg = self
            .load()
            .with("alsoRelays", Some(Value::Array(clean)).filter(|v| v.as_array().is_some_and(|a| !a.is_empty())));
        self.save(&cfg)?;
        let enabled = nekko_js::truthy(cfg.get("enabled")) && nekko_js::truthy(cfg.get("relayUrl"));
        if enabled {
            self.connect(&mut lock(&self.state), &cfg);
        }
        drop(_io);
        Ok(self.status_of(self.handle(), &cfg))
    }

    /// Each paired device's HELLO key (`{ [deviceId]: base64 X9.63 P-256 }`),
    /// beside `remote.json` so the registry's shape is unchanged.
    fn hello_keys_file(&self) -> PathBuf {
        self.file.with_file_name("remote-hello-keys.json")
    }

    fn load_hello_keys(&self) -> serde_json::Map<String, Value> {
        let file = self.hello_keys_file();
        ensure_private(&file);
        match std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        }
    }

    fn activity_file(&self) -> PathBuf {
        self.file.with_file_name("remote-activity.json")
    }

    /// Every device's activity list (`{ [deviceId]: PhoneActivityEntry[] }`).
    fn load_activity(&self) -> serde_json::Map<String, Value> {
        let file = self.activity_file();
        ensure_private(&file);
        match std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        }
    }

    /// `remote:activity(deviceId)`: the device's Change actions, oldest first.
    pub fn activity(&self, device_id: &Value) -> Value {
        let _io = lock(&self.io);
        let id = device_id.as_str().unwrap_or_default();
        self.load_activity().remove(id).filter(Value::is_array).unwrap_or(json!([]))
    }

    pub fn rotate(&self) -> Result<Value, String> {
        let _io = lock(&self.io);
        let prev = self.load();
        let room = hello::new_room_code(&self.random);
        let secret = hello::new_room_secret(&self.random);
        let cfg = prev
            .with("room", Some(json!(room)))
            .with("secret", Some(json!(secret)))
            .with("hostKey", Some(self.new_host_key()))
            .with("pairing", Some(json!(PAIRING_VERSION)))
            .with("devices", Some(json!([])));
        self.save(&cfg)?;
        // Every device is gone, and so is what they did.
        lock(&self.fleet).clear();
        let _ = std::fs::remove_file(self.activity_file());
        let _ = std::fs::remove_file(self.hello_keys_file());
        {
            let mut st = lock(&self.state);
            st.grant = None;
            if nekko_js::truthy(cfg.get("enabled")) && nekko_js::truthy(cfg.get("relayUrl")) {
                self.connect(&mut st, &cfg);
            }
        }
        drop(_io);
        Ok(self.status_of(self.handle(), &cfg))
    }

    /// Reconnect at startup when remote access was left enabled.
    pub fn start_if_enabled(&self) {
        let cfg = {
            let _io = lock(&self.io);
            let cfg = self.load();
            match self.upgraded_pairing(&cfg) {
                Some(next) if self.save(&next).is_ok() => next,
                _ => cfg,
            }
        };
        let t = |k: &str| nekko_js::truthy(cfg.get(k));
        if t("enabled") && t("relayUrl") && t("room") && t("secret") {
            self.connect(&mut lock(&self.state), &cfg);
        }
    }

    pub fn stop(&self) {
        let mut st = lock(&self.state);
        st.routes = None;
        if let Some(h) = st.handle.take() {
            h.stop();
        }
    }

    /// One IPC channel (`remote:*`).
    pub fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        match channel {
            "remote:enable" => self.enable(arg(0)),
            "remote:attach" => self.attach(arg(0)),
            "remote:disable" => self.disable(),
            "remote:status" => Ok(self.status()),
            "remote:pairing" => Ok(self.pairing()),
            "remote:pair" => self.pair_routed(arg(0), arg(1)),
            "remote:setRoute" => self.set_route(arg(0), arg(1)),
            "remote:setRelays" => self.set_relays(arg(0)),
            "remote:pairComputer" => Ok(self.pair_computer()),
            "remote:devices" => Ok(self.devices()),
            "remote:revoke" => self.revoke(arg(0)),
            "remote:rename" => self.rename(arg(0), arg(1)),
            "remote:rotate" => self.rotate(),
            "remote:setAccess" => self.set_access(arg(0), arg(1)),
            "remote:activity" => Ok(self.activity(arg(0))),
            other => Err(format!("Unknown channel: {other}")),
        }
    }
}

/// The registry as the phone gate reads it (IO-33): a device's switches and
/// Change key from `remote.json`, its activity in `remote-activity.json`
/// beside it.
impl crate::phone::Devices for RemoteService {
    fn attachments_of(&self, chat: &str) -> Option<PathBuf> {
        // The folder name `attachment:import` writes (`safe_session` in remote_image.rs).
        let dir: String = chat
            .chars()
            .flat_map(|c| {
                let keep = c.is_ascii_alphanumeric() || c == '_' || c == '-';
                std::iter::repeat_n(if keep { c } else { '_' }, if keep { 1 } else { c.len_utf16() })
            })
            .collect();
        let dir = nekko_js::slice16(&dir, 64);
        Some(self.file.parent()?.join("attachments").join(if dir.is_empty() { "chat" } else { dir }))
    }

    fn device(&self, id: &str) -> Option<crate::phone::PhoneDevice> {
        if crate::fleet::is_fleet_id(id) {
            let d = lock(&self.fleet).get(id).cloned()?;
            return Some(crate::phone::PhoneDevice {
                access: crate::phone::DeviceAccess::default(),
                key: Some(d.key),
                computer: true,
            });
        }
        let _io = lock(&self.io);
        let cfg = self.load();
        let d = Self::devices_of(&cfg)
            .into_iter()
            .find(|d| d.get("id").and_then(Value::as_str) == Some(id) && !nekko_js::truthy(d.get("revoked")))?;
        Some(crate::phone::PhoneDevice {
            access: crate::phone::DeviceAccess::of(&d),
            key: d.get("changeKey").and_then(Value::as_str).map(String::from),
            computer: d.get("kind").and_then(Value::as_str) == Some(hello::COMPUTER_PLATFORM),
        })
    }

    fn register_key(&self, id: &str, key: &str) -> Result<bool, &'static str> {
        if crate::fleet::is_fleet_id(id) {
            // Its HELLO key is its Change key, from the welcome on.
            return match lock(&self.fleet).get(id) {
                Some(d) if d.key == key => Ok(false),
                Some(_) => Err("key-mismatch"),
                None => Err("device-unknown"),
            };
        }
        let _io = lock(&self.io);
        let cfg = self.load();
        let mut devices = Self::devices_of(&cfg);
        let d = devices
            .iter_mut()
            .find(|d| d.get("id").and_then(Value::as_str) == Some(id) && !nekko_js::truthy(d.get("revoked")))
            .and_then(Value::as_object_mut)
            .ok_or("device-unknown")?;
        match d.get("changeKey").and_then(Value::as_str) {
            Some(k) if k == key => return Ok(false),
            Some(_) => return Err("key-mismatch"),
            None => {}
        }
        d.insert("changeKey".into(), json!(key));
        d.insert("changeKeyAt".into(), hello::nekko_num((self.clock)()));
        self.save(&cfg.with("devices", Some(Value::Array(devices)))).map_err(|_| "device-unknown")?;
        Ok(true)
    }

    fn record(&self, id: &str, entry: crate::phone::Activity) {
        // A fleet device has no record here, so nothing about it is kept on disk.
        if crate::fleet::is_fleet_id(id) {
            return;
        }
        let _io = lock(&self.io);
        self.record_locked(id, entry);
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn name(&self, id: &str) -> Option<String> {
        if crate::fleet::is_fleet_id(id) {
            return lock(&self.fleet).get(id).map(|d| d.admitted.name.clone());
        }
        let _io = lock(&self.io);
        let cfg = self.load();
        Self::devices_of(&cfg)
            .into_iter()
            .find(|d| d.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|d| d.get("name").and_then(Value::as_str).map(String::from))
    }

    fn sign_out(&self, id: &str) -> Result<(), String> {
        self.sign_out_device(id)
    }

    fn stop_remote(&self, id: &str) -> Result<(), String> {
        self.stop_from_phone(id)
    }
}

impl RemoteService {
    /// `device:signOut` (SK-3): the calling phone revokes itself, as the
    /// desktop's *Revoke* does (kicked with 4001, `revoked` on its record),
    /// with `signedOutAt` so *Paired devices* says it was signed out from the phone.
    pub fn sign_out_device(&self, id: &str) -> Result<(), String> {
        if crate::fleet::is_fleet_id(id) {
            // Nothing to revoke: it is forgotten and kicked, and may come back while the account allows it.
            lock(&self.fleet).remove(id);
            if let Some(h) = self.handle() {
                h.kick_device(id);
            }
            return Ok(());
        }
        let _io = lock(&self.io);
        let cfg = self.load();
        let now = hello::nekko_num((self.clock)());
        let devices: Vec<Value> = Self::devices_of(&cfg)
            .into_iter()
            .map(|d| match d {
                Value::Object(mut m) if m.get("id").and_then(Value::as_str) == Some(id) => {
                    m.insert("revoked".into(), json!(true));
                    m.insert("signedOutAt".into(), now.clone());
                    Value::Object(m)
                }
                d => d,
            })
            .collect();
        self.save(&cfg.with("devices", Some(Value::Array(devices))))?;
        drop(_io);
        if let Some(h) = self.handle() {
            h.kick_device(id);
        }
        Ok(())
    }

    /// `remote:stop` (SK-3): remote access off exactly as the desktop's
    /// switch turns it off, every phone kicked first, and who stopped it and
    /// when kept in `remote.json` (`stoppedBy`, in `remote:status`) for the
    /// desktop's banner until remote access is turned on again.
    pub fn stop_from_phone(&self, id: &str) -> Result<(), String> {
        let name = crate::phone::Devices::name(self, id);
        let at = (self.clock)();
        if let Some(h) = self.handle() {
            for device in h.connected_devices() {
                h.disconnect_device(&device);
            }
        }
        self.disable()?;
        let _io = lock(&self.io);
        let by = json!({ "deviceId": id, "name": name, "at": hello::nekko_num(at) });
        self.save(&self.load().with("stoppedBy", Some(by)))
    }
}

/// The activity channel a legacy phone's HELLO is written under.
pub const LEGACY_HELLO: &str = "relay:hello";

impl RemoteService {
    /// Append to a device's activity, the io lock already held.
    fn record_locked(&self, id: &str, entry: crate::phone::Activity) {
        let mut all = self.load_activity();
        let list = all.entry(id.to_string()).or_insert_with(|| json!([]));
        if !list.is_array() {
            *list = json!([]);
        }
        if let Value::Array(items) = list {
            items.push(entry.value());
            let limit = crate::phone::policy().activity_limit;
            if items.len() > limit {
                items.drain(..items.len() - limit);
            }
        }
        // Best effort: a log that can't be written never blocks the call.
        let _ = write_json_atomic(&self.activity_file(), &Value::Object(all));
    }
}

/// The channels `route` serves.
pub const CHANNELS: &[&str] = &[
    "remote:enable",
    "remote:attach",
    "remote:disable",
    "remote:status",
    "remote:pairing",
    "remote:pair",
    "remote:pairComputer",
    "remote:devices",
    "remote:revoke",
    "remote:rename",
    "remote:rotate",
    "remote:setAccess",
    "remote:activity",
    "remote:setRoute",
    "remote:setRelays",
];

/// `ensurePrivateFile`: owner-only, best effort.
fn ensure_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// `writeJsonAtomic`: `JSON.stringify(value, null, 2)` to an owner-only temp
/// file beside the target, flushed to disk, then renamed over it, so a crash
/// never leaves half a config. The temp file is removed if anything fails.
pub fn write_json_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let opts = nekko_js::fs::AtomicWrite { mode: nekko_js::fs::Mode::Private, fsync: true, create_dir: false };
    nekko_js::fs::atomic_write(path, nekko_js::stringify_pretty(value, "  ").as_bytes(), opts)
}

#[cfg(test)]
mod pair_tests {
    use super::*;

    #[test]
    fn a_preset_pairing_code_is_kept_only_when_it_fits_the_alphabet() {
        let keep = |v: &Value| {
            v.as_str()
                .filter(|c| {
                    (8..=16).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                })
                .map(str::to_string)
        };
        assert_eq!(keep(&json!("ABCD2345")), Some("ABCD2345".into()));
        assert_eq!(keep(&json!("abcd2345")), None, "lowercase is not the pairing alphabet");
        assert_eq!(keep(&json!("SHORT")), None);
        assert_eq!(keep(&json!("TOOLONGTOOLONGTOOLONG")), None);
        assert_eq!(keep(&Value::Null), None);
    }
}
