//! Step-up: the second factor a guarded call carries (SK-2), the daemon's
//! copy of `packages/shared/src/step-up.ts`.
//!
//! The computer is the relying party (decision 0018): it issues the
//! challenge, holds each credential's public key and counter in
//! `security.json` and verifies every answer itself:
//!
//! - a FIDO2 assertion (`{ credentialId, authenticatorData, clientDataJSON,
//!   signature }`, unpadded base64url): `clientDataJSON.type` is
//!   `webauthn.get`, its challenge one this computer issued to this caller,
//!   live and unused, its origin one `security.json` allows; the
//!   authenticator data's rpIdHash is SHA-256 of the computer's rpId, user
//!   presence is set (user verification is recorded), the signature counter
//!   rises unless both it and the stored one are zero (otherwise the
//!   credential is flagged *possibly cloned*), and the DER ES256 signature
//!   covers `authenticatorData || sha256(clientDataJSON)`;
//! - a TOTP code (`{ totp }`): RFC 6238, 30 s steps, one step either way,
//!   HMAC-SHA-1, never a step at or before the last accepted one; five wrong
//!   codes lock it for a minute, doubling with each lock;
//! - a recovery code (desktop only, to turn step-up off): single use, kept
//!   as SHA-256 hashes.
//!
//! The constants come from `phone-access.json` (`stepUp`). Both verifiers
//! decide every case of `tests/golden/step-up.json` the same.

use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// `STEP_UP_*` from the TS, as `phone-access.json` holds them. Missing
/// numbers fail closed: a zero TTL makes every challenge stale.
#[derive(Debug, Clone, Default)]
pub struct Limits {
    pub challenge_channel: String,
    pub challenge_bytes: usize,
    pub challenge_ttl_ms: f64,
    pub cover_ms: f64,
    pub client_type: String,
    pub totp_period_s: f64,
    pub totp_digits: u32,
    pub totp_window: i64,
    pub totp_max_wrong: f64,
    pub totp_lock_ms: f64,
    pub guarded_channels: Vec<String>,
    pub never_guarded: Vec<String>,
}

impl Limits {
    pub fn from_policy(v: &Value) -> Self {
        let n = |p: &str| v.pointer(p).and_then(Value::as_f64).unwrap_or(0.0);
        let strings = |p: &str| {
            v.pointer(p)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                .unwrap_or_default()
        };
        Self {
            challenge_channel: v.pointer("/challenge/channel").and_then(Value::as_str).unwrap_or("").to_string(),
            challenge_bytes: n("/challenge/bytes") as usize,
            challenge_ttl_ms: n("/challenge/ttlMs"),
            cover_ms: n("/coverMs"),
            client_type: v.pointer("/clientType").and_then(Value::as_str).unwrap_or("").to_string(),
            totp_period_s: n("/totp/periodS"),
            totp_digits: n("/totp/digits") as u32,
            totp_window: n("/totp/window") as i64,
            totp_max_wrong: n("/totp/maxWrong"),
            totp_lock_ms: n("/totp/lockMs"),
            guarded_channels: strings("/phoneGuarded/channels"),
            never_guarded: strings("/neverGuarded"),
        }
    }
}

fn limits() -> &'static Limits {
    &crate::phone::policy().step_up
}

/// A challenge this computer issued (`StepUpIssued`).
#[derive(Debug, Clone, PartialEq)]
pub struct Issued {
    pub challenge: String,
    pub issued_at: f64,
    pub used: bool,
}

impl Issued {
    pub fn value(&self) -> Value {
        json!({ "challenge": self.challenge, "issuedAt": num(self.issued_at), "used": self.used })
    }

    pub fn of(v: &Value) -> Option<Self> {
        Some(Self {
            challenge: v.get("challenge")?.as_str()?.to_string(),
            issued_at: v.get("issuedAt")?.as_f64()?,
            used: v.get("used")?.as_bool()?,
        })
    }
}

fn num(n: f64) -> Value {
    crate::hello::nekko_num(n)
}

/// What one check decided (`StepUpOutcome`, without the state, which the
/// caller's copy now holds).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Outcome {
    /// `ok`, or the refusal code.
    pub result: &'static str,
    pub method: Option<&'static str>,
    pub uv: Option<bool>,
    pub cloned: Option<String>,
    pub why: Option<&'static str>,
}

impl Outcome {
    fn code(result: &'static str) -> Self {
        Self { result, ..Self::default() }
    }
    fn invalid(why: &'static str) -> Self {
        Self { result: "step-up-invalid", why: Some(why), ..Self::default() }
    }
    pub fn ok(&self) -> bool {
        self.result == "ok"
    }
}

/// Base64 or base64url, padded or not (as the TS `fromB64url`).
pub fn from_b64url(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    let body = text.trim_end_matches('=');
    if text.len() - body.len() > 2 || !body.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/_-".contains(&b)) {
        return None;
    }
    let std: String = body
        .chars()
        .map(|c| {
            if c == '-' {
                '+'
            } else if c == '_' {
                '/'
            } else {
                c
            }
        })
        .collect();
    if std.len() % 4 == 1 {
        return None;
    }
    let cfg = GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone);
    GeneralPurpose::new(&base64::alphabet::STANDARD, cfg).decode(std).ok()
}

pub fn to_b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A DER ECDSA signature as raw r||s (`derToRaw`).
pub fn der_to_raw(der: &[u8]) -> Option<[u8; 64]> {
    let mut i = 0usize;
    let mut byte = || {
        let b = der.get(i).copied();
        i += 1;
        b
    };
    if byte()? != 0x30 {
        return None;
    }
    let total = byte()? as usize;
    if total & 0x80 != 0 || total != der.len().checked_sub(2)? {
        return None;
    }
    let mut out = [0u8; 64];
    let mut at = 2usize;
    for part in 0..2 {
        if der.get(at) != Some(&0x02) {
            return None;
        }
        let len = *der.get(at + 1)? as usize;
        at += 2;
        if !(1..=33).contains(&len) || at + len > der.len() {
            return None;
        }
        let mut int = &der[at..at + len];
        at += len;
        if int.len() == 33 {
            if int[0] != 0 {
                return None;
            }
            int = &int[1..];
        }
        out[part * 32 + (32 - int.len())..part * 32 + 32].copy_from_slice(int);
    }
    (at == der.len()).then_some(out)
}

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let (mut bits, mut value, mut out) = (0u32, 0u32, Vec::new());
    for c in text.chars().filter(|c| !c.is_whitespace() && *c != '=') {
        let i = BASE32.iter().position(|&b| b as char == c.to_ascii_uppercase())? as u32;
        value = ((value << 5) | i) & 0xffff;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

/// The code for one time step (HOTP over the step, HMAC-SHA-1).
pub fn totp_at(secret: &[u8], step: i64, digits: u32) -> String {
    use hmac::{Hmac, Mac};
    let Ok(mut mac) = Hmac::<sha1::Sha1>::new_from_slice(secret) else { return String::new() };
    mac.update(&(step as u64).to_be_bytes());
    let h = mac.finalize().into_bytes();
    let off = (h[h.len() - 1] & 0x0f) as usize;
    let bin = (u32::from(h[off] & 0x7f) << 24)
        | (u32::from(h[off + 1]) << 16)
        | (u32::from(h[off + 2]) << 8)
        | u32::from(h[off + 3]);
    format!("{:0width$}", bin % 10u32.pow(digits), width = digits as usize)
}

pub fn totp_step(now_ms: f64, period_s: f64) -> i64 {
    (now_ms / 1000.0 / period_s).floor() as i64
}

/// Hex SHA-256 of a recovery code, ignoring case, spaces and dashes.
pub fn hash_recovery_code(code: &str) -> String {
    let clean: String = code.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
    Sha256::digest(clean.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Spend a recovery code: `true` (and its hash gone from `state`) when it was one.
pub fn use_recovery_code(state: &mut Value, code: &str) -> bool {
    let h = hash_recovery_code(code);
    let Some(list) = state.get_mut("recoveryHashes").and_then(Value::as_array_mut) else { return false };
    let before = list.len();
    list.retain(|x| x.as_str() != Some(h.as_str()));
    list.len() != before
}

/// Whether `security.json` says a guarded action needs a step-up.
pub fn enabled(state: &Value) -> bool {
    state.get("enabled") == Some(&Value::Bool(true))
}

/// The kinds of method registered, sorted (`stepUpMethodKinds`): all a phone learns.
pub fn method_kinds(state: &Value) -> Vec<String> {
    let mut kinds: Vec<String> = state
        .get("credentials")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|c| c.get("kind").and_then(Value::as_str)).map(String::from).collect())
        .unwrap_or_default();
    if state.get("totp").is_some_and(Value::is_object) {
        kinds.push("totp".into());
    }
    kinds.sort();
    kinds.dedup();
    kinds
}

/// Check one step-up (`checkStepUp`). `state` (security.json) and `issued`
/// (the challenges issued to this caller) are updated in place, whatever
/// the outcome, and should be saved.
pub fn check(state: &mut Value, issued: &mut [Issued], now: f64, step_up: Option<&Value>) -> Outcome {
    let Some(step_up) = step_up.filter(|v| !v.is_null()) else { return Outcome::code("step-up-required") };
    let Some(obj) = step_up.as_object() else { return Outcome::invalid("shape") };
    if obj.contains_key("totp") {
        return check_totp(state, now, obj.get("totp"));
    }
    let field = |k: &str| obj.get(k).and_then(Value::as_str);
    let (Some(id), Some(auth), Some(cdj), Some(sig)) =
        (field("credentialId"), field("authenticatorData"), field("clientDataJSON"), field("signature"))
    else {
        return Outcome::invalid("shape");
    };
    let (Some(id), Some(auth), Some(cdj), Some(sig)) =
        (from_b64url(id), from_b64url(auth), from_b64url(cdj), from_b64url(sig))
    else {
        return Outcome::invalid("encoding");
    };
    let rp_id = state.get("rpId").and_then(Value::as_str).unwrap_or_default().to_string();
    let origins: Vec<String> = state
        .get("origins")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();
    let Some(cred) = state.get_mut("credentials").and_then(Value::as_array_mut).and_then(|list| {
        list.iter_mut().find(|c| c.get("id").and_then(Value::as_str).and_then(from_b64url).as_deref() == Some(&id[..]))
    }) else {
        return Outcome::invalid("credential");
    };
    let Some(client) = std::str::from_utf8(&cdj).ok().and_then(|s| serde_json::from_str::<Value>(s).ok()) else {
        return Outcome::invalid("clientData");
    };
    let challenge = client.get("challenge").and_then(Value::as_str);
    if !client.is_object()
        || client.get("type").and_then(Value::as_str) != Some(limits().client_type.as_str())
        || challenge.is_none()
    {
        return Outcome::invalid("clientData");
    }
    let said = challenge.and_then(from_b64url);
    let Some(entry) =
        said.and_then(|said| issued.iter_mut().find(|x| from_b64url(&x.challenge).as_deref() == Some(&said[..])))
    else {
        return Outcome::invalid("challenge");
    };
    if entry.used {
        return Outcome::code("step-up-replayed");
    }
    // Single use: any answer to a live challenge spends it, good or bad.
    entry.used = true;
    if now - entry.issued_at > limits().challenge_ttl_ms {
        return Outcome::code("step-up-stale");
    }
    if !client.get("origin").and_then(Value::as_str).is_some_and(|o| origins.iter().any(|x| x == o)) {
        return Outcome::invalid("origin");
    }
    if auth.len() < 37 {
        return Outcome::invalid("authenticatorData");
    }
    if auth[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Outcome::invalid("rpId");
    }
    let flags = auth[32];
    if flags & 0x01 == 0 {
        return Outcome::invalid("user presence");
    }
    let key = cred.get("publicKey").and_then(Value::as_str).and_then(from_b64url);
    let key = key.filter(|k| k.len() == 65 && k[0] == 4).and_then(|k| VerifyingKey::from_sec1_bytes(&k).ok());
    let sig = der_to_raw(&sig).and_then(|raw| Signature::from_slice(&raw).ok());
    let (Some(key), Some(sig)) = (key, sig) else { return Outcome::invalid("signature") };
    let mut signed = auth.clone();
    signed.extend_from_slice(&Sha256::digest(&cdj));
    if key.verify(&signed, &sig).is_err() {
        return Outcome::invalid("signature");
    }
    let counter = f64::from(u32::from_be_bytes([auth[33], auth[34], auth[35], auth[36]]));
    let stored = cred.get("counter").and_then(Value::as_f64).unwrap_or(f64::INFINITY);
    let Some(c) = cred.as_object_mut() else { return Outcome::invalid("credential") };
    if !(counter == 0.0 && stored == 0.0) && counter <= stored {
        c.insert("cloned".into(), json!(true));
        let id = c.get("id").and_then(Value::as_str).map(String::from);
        return Outcome { cloned: id, ..Outcome::invalid("counter") };
    }
    c.insert("counter".into(), num(counter));
    c.insert("lastUsedAt".into(), num(now));
    Outcome { result: "ok", method: Some("fido2"), uv: Some(flags & 0x04 != 0), ..Outcome::default() }
}

fn check_totp(state: &mut Value, now: f64, code: Option<&Value>) -> Outcome {
    let l = limits();
    let Some(t) = state.get_mut("totp").and_then(Value::as_object_mut) else { return Outcome::invalid("no totp") };
    if t.get("lockedUntil").and_then(Value::as_f64).is_some_and(|until| now < until) {
        return Outcome::invalid("locked");
    }
    let Some(secret) = t.get("secret").and_then(Value::as_str).and_then(base32_decode).filter(|s| !s.is_empty()) else {
        return Outcome::invalid("secret");
    };
    let step = totp_step(now, l.totp_period_s);
    let code = code.and_then(Value::as_str).filter(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()));
    let matched = code.and_then(|code| {
        (-l.totp_window..=l.totp_window).map(|d| step + d).find(|s| totp_at(&secret, *s, l.totp_digits) == code)
    });
    if let Some(m) = matched {
        if t.get("lastStep").and_then(Value::as_f64).is_some_and(|last| m as f64 <= last) {
            return Outcome::code("step-up-replayed");
        }
        t.insert("lastStep".into(), num(m as f64));
        t.insert("lastUsedAt".into(), num(now));
        for k in ["wrong", "lockedUntil", "locks"] {
            t.remove(k);
        }
        return Outcome { result: "ok", method: Some("totp"), ..Outcome::default() };
    }
    let n = |t: &Map<String, Value>, k: &str| t.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let wrong = n(t, "wrong") + 1.0;
    t.insert("wrong".into(), num(wrong));
    if wrong >= l.totp_max_wrong {
        let locks = n(t, "locks");
        t.insert("lockedUntil".into(), num(now + l.totp_lock_ms * 2f64.powf(locks)));
        t.insert("locks".into(), num(locks + 1.0));
        t.insert("wrong".into(), num(0.0));
    }
    Outcome::invalid("code")
}

/// Where the gate reads and writes `security.json`, so tests use memory.
pub trait SecurityStore: Send + Sync {
    /// The state, or `None` when there is none (step-up never set up: off).
    fn load(&self) -> Option<Value>;
    fn save(&self, state: &Value) -> Result<(), String>;
}

/// `security.json` beside `remote.json`, owner-only.
pub struct SecurityFile {
    pub path: PathBuf,
}

impl SecurityFile {
    pub fn in_dir(dir: &std::path::Path) -> Self {
        Self { path: dir.join("security.json") }
    }
}

impl SecurityStore for SecurityFile {
    fn load(&self) -> Option<Value> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            // Present but unreadable: fail closed, as if step-up were on with no method.
            Err(_) => return Some(json!({ "enabled": true })),
        };
        Some(serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({ "enabled": true })))
    }

    fn save(&self, state: &Value) -> Result<(), String> {
        crate::service::write_json_atomic(&self.path, state).map_err(|e| e.to_string())
    }
}

/// A fresh challenge's text: `bytes` random bytes, unpadded base64url.
pub fn new_challenge(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes.max(16)];
    getrandom::fill(&mut buf).expect("the OS random source is available");
    to_b64url(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_6238_sha1_vectors() {
        let secret = b"12345678901234567890";
        let codes: Vec<String> = [59.0, 1111111109.0, 1111111111.0, 1234567890.0, 2000000000.0, 20000000000.0]
            .iter()
            .map(|t| totp_at(secret, totp_step(t * 1000.0, 30.0), 6))
            .collect();
        assert_eq!(codes, ["287082", "081804", "050471", "005924", "279037", "353130"]);
    }

    #[test]
    fn der_and_b64url() {
        assert!(der_to_raw(&[0x30, 0x02, 0x02, 0x00]).is_none());
        assert_eq!(from_b64url("AQID"), Some(vec![1, 2, 3]));
        assert_eq!(from_b64url("-_8"), Some(vec![0xfb, 0xff]));
        assert_eq!(from_b64url("a"), None);
        assert_eq!(from_b64url("a b"), None);
    }

    #[test]
    fn recovery_codes_work_once() {
        let mut s = json!({ "recoveryHashes": [hash_recovery_code("abcde-fghij")] });
        assert!(use_recovery_code(&mut s, "ABCDE FGHIJ"));
        assert!(!use_recovery_code(&mut s, "abcde-fghij"));
    }

    #[test]
    fn an_unreadable_security_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let f = SecurityFile::in_dir(dir.path());
        assert_eq!(f.load(), None);
        std::fs::write(&f.path, "{not json").unwrap();
        let s = f.load().unwrap();
        assert!(enabled(&s));
        assert_eq!(check(&mut s.clone(), &mut [], 0.0, Some(&json!({ "totp": "123456" }))).result, "step-up-invalid");
    }
}
