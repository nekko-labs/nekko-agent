//! The HELLO handshake and the random material (`packages/shared/src/remote.ts`).

use serde_json::{Map, Value, json};

/// How long a pairing code stays valid (`PAIRING_TTL_MS`).
pub const PAIRING_TTL_MS: f64 = 10.0 * 60.0 * 1000.0;

/// No 0/O/1/I/L, so a code survives being read aloud.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// `crypto.getRandomValues`: fill a buffer. Tests pass a deterministic one.
pub type Random = std::sync::Arc<dyn Fn(&mut [u8]) + Send + Sync>;

/// The OS random source.
pub fn os_random() -> Random {
    std::sync::Arc::new(|buf: &mut [u8]| {
        // A failing OS random source leaves no safe fallback for a secret.
        getrandom::fill(buf).expect("the OS random source is available");
    })
}

/// `PairingGrant`.
#[derive(Clone, Debug, PartialEq)]
pub struct Grant {
    pub code: String,
    pub expires_at: f64,
}

impl Grant {
    pub fn value(&self) -> Value {
        json!({ "code": self.code, "expiresAt": nekko_num(self.expires_at) })
    }
}

/// A number as JSON holds it, integral values without a fraction (as
/// `JSON.stringify` prints them).
pub fn nekko_num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// `newPairingCode(len)`.
pub fn new_pairing_code(random: &Random, len: usize) -> String {
    let mut bytes = vec![0u8; len];
    random(&mut bytes);
    bytes.iter().map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char).collect()
}

/// `newRoomCode()`: 8 random bytes as hex.
pub fn new_room_code(random: &Random) -> String {
    hex_bytes(random, 8)
}

/// `newRoomSecret()`: 16 random bytes as hex.
pub fn new_room_secret(random: &Random) -> String {
    hex_bytes(random, 16)
}

fn hex_bytes(random: &Random, n: usize) -> String {
    let mut bytes = vec![0u8; n];
    random(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `normalizePlatform`.
pub fn normalize_platform(p: Option<&str>) -> &'static str {
    match p.unwrap_or("").to_lowercase().as_str() {
        "ios" => "ios",
        "android" => "android",
        "web" => "web",
        _ => "unknown",
    }
}

/// `defaultDeviceName`.
pub fn default_device_name(p: Option<&str>) -> &'static str {
    match normalize_platform(p) {
        "ios" => "iPhone",
        "android" => "Android phone",
        "web" => "Browser",
        _ => "Device",
    }
}

/// `HelloVerdict`.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Welcome { device: Value, enrolled: bool },
    Deny { reason: &'static str },
}

impl Verdict {
    /// As the TS object prints.
    pub fn value(&self) -> Value {
        match self {
            Verdict::Welcome { device, enrolled } => {
                json!({ "action": "welcome", "device": device, "enrolled": enrolled })
            }
            Verdict::Deny { reason } => json!({ "action": "deny", "reason": reason }),
        }
    }

    /// The sealed reply to the device (`RemoteHelloReply`).
    pub fn reply(&self) -> Value {
        match self {
            Verdict::Welcome { device, .. } => json!({ "type": "welcome", "device": device }),
            Verdict::Deny { reason } => json!({ "type": "denied", "reason": reason }),
        }
    }
}

fn truthy(v: Option<&Value>) -> bool {
    nekko_js::truthy(v)
}

/// `verifyHello(devices, hello, pairing, now)`.
pub fn verify_hello(devices: &[Value], hello: &Value, pairing: Option<&Grant>, now: f64) -> Verdict {
    let Some(h) = hello.as_object() else { return Verdict::Deny { reason: "invalid" } };
    let device_id = match (h.get("type").and_then(Value::as_str), h.get("deviceId").and_then(Value::as_str)) {
        (Some("hello"), Some(id)) if !nekko_js::trim(id).is_empty() => id,
        _ => return Verdict::Deny { reason: "invalid" },
    };
    let known = devices.iter().find(|d| d.get("id").and_then(Value::as_str) == Some(device_id));
    if let Some(known) = known
        && !truthy(known.get("revoked"))
    {
        // `{ ...known, lastSeenAt: now }`.
        let mut device = known.as_object().cloned().unwrap_or_default();
        device.insert("lastSeenAt".into(), nekko_num(now));
        return Verdict::Welcome { device: Value::Object(device), enrolled: false };
    }
    // A revoked device with no code is told it was removed; one that brings a
    // code is pairing again and is checked exactly like a new device.
    if !truthy(h.get("pair")) {
        return Verdict::Deny { reason: if known.is_some() { "revoked" } else { "unknown-device" } };
    }
    let code_ok = pairing.is_some_and(|g| h.get("pair").and_then(Value::as_str) == Some(&g.code) && g.expires_at > now);
    if !code_ok {
        return Verdict::Deny { reason: "bad-code" };
    }
    let platform = h.get("platform").and_then(Value::as_str);
    let name = h.get("name").and_then(Value::as_str).unwrap_or("");
    let name = cut16(nekko_js::trim(name), 60);
    let mut device = Map::new();
    device.insert("id".into(), json!(device_id));
    device.insert("name".into(), json!(if name.is_empty() { default_device_name(platform) } else { name }));
    device.insert("platform".into(), json!(normalize_platform(platform)));
    device.insert("createdAt".into(), nekko_num(now));
    device.insert("lastSeenAt".into(), nekko_num(now));
    Verdict::Welcome { device: Value::Object(device), enrolled: true }
}

/// `s.slice(0, n)` in UTF-16 units, except that a surrogate pair cut in half
/// is dropped whole (a Rust string cannot hold the lone half JavaScript keeps).
pub fn cut16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}
