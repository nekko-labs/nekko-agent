//! Remote access (`packages/host/src/remote.ts`): the persisted relay config
//! and paired-device registry in `remote.json`, the single-use pairing code,
//! and the live relay agent. The registry is the auth layer: a device must
//! complete the HELLO handshake against it before the agent serves a single
//! request; new devices enroll only with a short-lived code; revoking a
//! device kicks it live. This process is the file's only writer.

use crate::hello::{self, Grant, PAIRING_TTL_MS, Random, Verdict};
use crate::jsobj::JsObj;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

/// How the stored pairing reaches the relay: 2 is a room credential derived
/// from the secret (decision 0035). Anything else is replaced at start.
const PAIRING_VERSION: u64 = 2;

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
    fn connect(&self, relay_url: &str, room: &str, key: &str, verify: Verifier) -> Arc<dyn LinkHandle>;
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
    /// Device ids with a welcomed live connection.
    fn connected_devices(&self) -> Vec<String>;
    fn is_online(&self) -> bool;
    fn last_error(&self) -> Option<String>;
}

#[derive(Default)]
struct State {
    handle: Option<Arc<dyn LinkHandle>>,
    grant: Option<Grant>,
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
                    .with("room", get("room"))
                    .with("secret", get("secret"))
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

    /// A room and secret from before relay credentials were derived
    /// (decision 0035) were sent to the relay as they are: replace them, keeping
    /// the paired devices, so phones pair again with a secret the relay never
    /// saw. `None` when the pairing is already current or there is none.
    fn upgraded_pairing(&self, cfg: &JsObj) -> Option<JsObj> {
        let current = cfg.get("pairing").and_then(Value::as_u64) == Some(PAIRING_VERSION);
        if current || !nekko_js::truthy(cfg.get("secret")) {
            return None;
        }
        Some(
            cfg.clone()
                .with("room", Some(json!(hello::new_room_code(&self.random))))
                .with("secret", Some(json!(hello::new_room_secret(&self.random))))
                .with("pairing", Some(json!(PAIRING_VERSION))),
        )
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

    /// Whether phones from before relay replay protection are still welcomed
    /// (`acceptLegacyPhones` in remote.json; missing means yes, for one release).
    fn accepts_legacy(cfg: &JsObj) -> bool {
        cfg.get("acceptLegacyPhones") != Some(&Value::Bool(false))
    }

    /// The HELLO check the agent runs for every connection. The agent has
    /// already checked a protocol 4 HELLO's challenge; an older phone's HELLO
    /// (legacy: no challenge, no request counter) is refused with
    /// `update-required` when the owner turned legacy phones off, and
    /// otherwise welcomed, logged and marked on the device (`legacyProtocol`,
    /// and once in its activity) so the owner sees which phone to update.
    pub fn verify(&self, hello_frame: &Value) -> Value {
        let _io = lock(&self.io);
        let cfg = self.load();
        let legacy =
            hello_frame.as_object().is_some_and(|h| crate::agent::hello_protocol(h) < crate::agent::CHALLENGE_PROTOCOL);
        let known = |cfg: &JsObj| -> Option<Value> {
            let id = hello_frame.get("deviceId")?;
            Self::devices_of(cfg).into_iter().find(|d| d.get("id") == Some(id) && !nekko_js::truthy(d.get("revoked")))
        };
        if legacy && !Self::accepts_legacy(&cfg) {
            if let Some(d) = known(&cfg) {
                let id = d.get("id").map(nekko_js::display).unwrap_or_default();
                eprintln!(
                    "nekkod: refused phone {id}: its app predates relay replay protection (acceptLegacyPhones is off)"
                );
                self.record_locked(&id, self.legacy_entry(false));
            }
            return json!({ "type": "denied", "reason": "update-required" });
        }
        let was_legacy = known(&cfg).is_some_and(|d| d.get("legacyProtocol") == Some(&Value::Bool(true)));
        let mut st = lock(&self.state);
        let verdict =
            hello::verify_hello(&Self::devices_of(&cfg), hello_frame, self.live_grant(&st).as_ref(), (self.clock)());
        if let Verdict::Welcome { device, enrolled } = &verdict {
            let mut device = device.clone();
            if let Some(o) = device.as_object_mut() {
                if legacy {
                    o.insert("legacyProtocol".into(), json!(true));
                } else {
                    o.remove("legacyProtocol");
                }
            }
            let device = &device;
            let id = device.get("id").cloned();
            let mut devices: Vec<Value> =
                Self::devices_of(&cfg).into_iter().filter(|d| d.get("id") != id.as_ref()).collect();
            devices.push(device.clone());
            // A registry that cannot be written turns the device away (the TS
            // host threw here and left the phone with no reply at all).
            if self.save(&cfg.clone().with("devices", Some(Value::Array(devices)))).is_err() {
                return json!({ "type": "denied", "reason": "invalid" });
            }
            if *enrolled {
                st.grant = None; // single use
            }
            if legacy {
                let id = id.as_ref().map(nekko_js::display).unwrap_or_default();
                eprintln!("nekkod: phone {id} connected with an app that predates relay replay protection");
                if !was_legacy {
                    self.record_locked(&id, self.legacy_entry(true));
                }
            }
        }
        verdict.reply()
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
        st.handle = Some(self.link.connect(url, room, key, self.verifier()));
    }

    /// The running agent, out of the lock: its own lock is taken while the
    /// agent calls `verify`, which takes ours, so never hold both.
    fn handle(&self) -> Option<Arc<dyn LinkHandle>> {
        lock(&self.state).handle.clone()
    }

    fn status_of(&self, handle: Option<Arc<dyn LinkHandle>>, cfg: &JsObj) -> Value {
        if nekko_js::truthy(cfg.get("enabled")) {
            let h = handle.as_deref();
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
        let cfg = prev
            .with("enabled", Some(json!(true)))
            // Turned on again at the computer: the banner about a phone's stop goes.
            .with("stoppedBy", None)
            .with("relayUrl", Some(relay_url.clone()))
            .with("room", Some(room))
            .with("secret", Some(secret))
            .with("pairing", Some(json!(PAIRING_VERSION)));
        self.save(&cfg)?;
        self.connect(&mut lock(&self.state), &cfg);
        drop(_io);
        Ok(self.status_of(self.handle(), &cfg))
    }

    /// `attach({ relayUrl, room, secret })`: join a room someone else chose
    /// (relay-agent mode, `NEKKO_RELAY_URL` + `NEKKO_ROOM` + `NEKKO_PAIR_KEY`),
    /// keeping the devices already paired. Internal: not an IPC channel the
    /// UI has, and a phone may not call any `remote:` channel.
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
        let cfg = self
            .load()
            .with("enabled", Some(json!(true)))
            .with("relayUrl", Some(relay_url))
            .with("room", Some(room))
            .with("secret", Some(secret))
            .with("pairing", Some(json!(PAIRING_VERSION)));
        self.save(&cfg)?;
        self.connect(&mut lock(&self.state), &cfg);
        drop(_io);
        Ok(self.status_of(self.handle(), &cfg))
    }

    pub fn disable(&self) -> Result<Value, String> {
        let _io = lock(&self.io);
        let mut st = lock(&self.state);
        if let Some(h) = st.handle.take() {
            h.stop();
        }
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
        json!({ "relayUrl": cfg.get("relayUrl"), "room": cfg.get("room"), "key": cfg.get("secret") })
    }

    pub fn pair(&self) -> Value {
        self.pair_with(&Value::Null)
    }

    /// `remote:pair [code]`: a one-time pairing code, random unless the caller
    /// brings one (a Nekko Cloud machine's, minted by Nekko Cloud and handed to
    /// the phone in its pairing link). A preset code must be 8 to 16 characters
    /// of the pairing alphabet; anything else is ignored and a random one is made.
    pub fn pair_with(&self, preset: &Value) -> Value {
        let preset = preset
            .as_str()
            .filter(|c| (8..=16).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()));
        let code = match preset {
            Some(c) => c.to_string(),
            None => hello::new_pairing_code(&self.random, 8),
        };
        let grant = Grant { code, expires_at: (self.clock)() + PAIRING_TTL_MS };
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
        Ok(Value::Array(devices))
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
            .with("pairing", Some(json!(PAIRING_VERSION)))
            .with("devices", Some(json!([])));
        self.save(&cfg)?;
        // Every device is gone, and so is what they did.
        let _ = std::fs::remove_file(self.activity_file());
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
        if let Some(h) = lock(&self.state).handle.take() {
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
            "remote:pair" => Ok(self.pair_with(arg(0))),
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
    fn device(&self, id: &str) -> Option<crate::phone::PhoneDevice> {
        let _io = lock(&self.io);
        let cfg = self.load();
        let d = Self::devices_of(&cfg)
            .into_iter()
            .find(|d| d.get("id").and_then(Value::as_str) == Some(id) && !nekko_js::truthy(d.get("revoked")))?;
        Some(crate::phone::PhoneDevice {
            access: crate::phone::DeviceAccess::of(&d),
            key: d.get("changeKey").and_then(Value::as_str).map(String::from),
        })
    }

    fn register_key(&self, id: &str, key: &str) -> Result<bool, &'static str> {
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
        let _io = lock(&self.io);
        self.record_locked(id, entry);
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn name(&self, id: &str) -> Option<String> {
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
    "remote:devices",
    "remote:revoke",
    "remote:rename",
    "remote:rotate",
    "remote:setAccess",
    "remote:activity",
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
