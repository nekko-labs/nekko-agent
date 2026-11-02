//! The signed proof a phone attaches to a Change action (IO-33).
//!
//! A phone that may change things on this computer (*Change* on in
//! *What phones can do*) signs every change-class call with a P-256 key it
//! registered over `device:registerKey`. On an iPhone that key lives in the
//! Secure Enclave behind Face ID or the passcode, so a signature means the
//! owner unlocked it recently: the computer, not the phone's own lock, holds
//! the line.
//!
//! The signed text is
//!
//! ```text
//! nekko-change-v1 \n <deviceId> \n <channel> \n hex(sha256(canonical JSON of args)) \n <ts>
//! ```
//!
//! (no spaces), signed with ECDSA P-256 SHA-256; the request carries
//! `proof: { ts, sig }` beside `args`, `sig` the raw 64-byte r||s in base64.
//! The canonical JSON is defined in [`canonical_json`]. The shared test
//! vector is `tests/golden/change-proof.json`, also read by the iPhone's
//! NekkoProtocol tests.

use base64::Engine;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The first line of the signed text: bumped if its shape ever changes.
pub const VERSION: &str = "nekko-change-v1";

/// The largest integer a phone may put in signed arguments (2^53, as JavaScript holds exactly).
const MAX_SAFE: f64 = 9_007_199_254_740_992.0;

/// The canonical JSON of a change call's arguments, or `None` when they hold
/// a number that is not an integer within ±2^53 (such arguments can't be
/// signed: change-class channels take strings, booleans, integers, null,
/// arrays and objects only).
///
/// - no whitespace;
/// - object keys sorted by their UTF-8 bytes;
/// - integers in plain decimal (`-0` is `0`);
/// - strings in double quotes, escaping only `"` (`\"`), `\` (`\\`) and
///   U+0000 to U+001F (`\u00XX`, lowercase hex); everything else is the
///   character itself, in UTF-8.
pub fn canonical_json(v: &Value) -> Option<String> {
    let mut out = String::new();
    write(v, &mut out)?;
    Some(out)
}

fn write(v: &Value, out: &mut String) -> Option<()> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i.unsigned_abs() > 1 << 53 {
                    return None;
                }
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                if u > 1 << 53 {
                    return None;
                }
                out.push_str(&u.to_string());
            } else {
                let f = n.as_f64()?;
                if f.fract() != 0.0 || !f.is_finite() || f.abs() > MAX_SAFE {
                    return None;
                }
                out.push_str(&(f as i64).to_string());
            }
        }
        Value::String(s) => quote(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out)?;
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(k, out);
                out.push(':');
                write(&o[*k], out)?;
            }
            out.push('}');
        }
    }
    Some(())
}

fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The text a phone signs for one call, or `None` when the arguments can't be signed.
pub fn payload(device_id: &str, channel: &str, args: &Value, ts: i64) -> Option<String> {
    let canonical = canonical_json(args)?;
    let digest = Sha256::digest(canonical.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("{VERSION}\n{device_id}\n{channel}\n{hex}\n{ts}"))
}

pub(crate) fn b64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()
}

/// A phone's public key as it registers it: base64 of the 65-byte X9.63
/// uncompressed point. `None` unless it is a valid P-256 point.
pub fn parse_key(b64_key: &str) -> Option<VerifyingKey> {
    let bytes = b64(b64_key)?;
    if bytes.len() != 65 || bytes[0] != 0x04 {
        return None;
    }
    VerifyingKey::from_sec1_bytes(&bytes).ok()
}

/// `proof: { ts, sig }` from a request: the timestamp (integer milliseconds
/// since the epoch) and the signature bytes, or `None` when malformed.
pub fn parse(proof: &Value) -> Option<(i64, Vec<u8>)> {
    let ts = proof.get("ts")?.as_f64().filter(|t| t.fract() == 0.0 && t.is_finite() && t.abs() <= MAX_SAFE)? as i64;
    let sig = b64(proof.get("sig")?.as_str()?)?;
    (sig.len() == 64).then_some((ts, sig))
}

/// Whether `sig` (raw r||s) is `key`'s ECDSA P-256 SHA-256 signature of `payload`.
pub fn verify(key: &VerifyingKey, payload: &str, sig: &[u8]) -> bool {
    match Signature::from_slice(sig) {
        Ok(sig) => key.verify(payload.as_bytes(), &sig).is_ok(),
        Err(_) => false,
    }
}

/// A signature as a proof carries it: the raw 64-byte r||s in base64.
pub fn sign(key: &SigningKey, payload: &str) -> String {
    let sig: Signature = key.sign(payload.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
}

/// A device key's public half as [`parse_key`] reads it: X9.63 P-256 in base64.
pub fn public_key(key: &SigningKey) -> String {
    base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_encoded_point(false).as_bytes())
}

/// What a replay check remembers of a proof: sha256 of the signed text. Not
/// the signature, which ECDSA lets anyone re-encode (s and n - s both verify).
pub fn fingerprint(payload: &str) -> [u8; 32] {
    Sha256::digest(payload.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::SigningKey;
    use p256::ecdsa::signature::Signer;
    use serde_json::json;

    fn vector() -> Value {
        serde_json::from_str(include_str!("../tests/golden/change-proof.json")).unwrap()
    }

    #[test]
    fn the_canonical_json_matches_the_shared_vector() {
        let v = vector();
        assert_eq!(canonical_json(&v["args"]).unwrap(), v["canonical"].as_str().unwrap());
        for case in v["canonicalCases"].as_array().unwrap() {
            assert_eq!(canonical_json(&case["value"]).as_deref(), case["canonical"].as_str(), "{case}");
        }
        for bad in v["unsignable"].as_array().unwrap() {
            assert_eq!(canonical_json(bad), None, "{bad}");
        }
        // A whole-number double reads as the integer it is.
        assert_eq!(canonical_json(&json!([3.0, -0.0])).unwrap(), "[3,0]");
    }

    #[test]
    fn the_payload_and_signature_match_the_shared_vector() {
        let v = vector();
        let ts = v["ts"].as_i64().unwrap();
        let text = payload(v["deviceId"].as_str().unwrap(), v["channel"].as_str().unwrap(), &v["args"], ts).unwrap();
        assert_eq!(text, v["payload"].as_str().unwrap());
        assert!(text.contains(v["argsSha256"].as_str().unwrap()));
        let key = parse_key(v["publicKey"].as_str().unwrap()).expect("the vector's key");
        let (pts, sig) = parse(&json!({ "ts": ts, "sig": v["sig"] })).unwrap();
        assert_eq!(pts, ts);
        assert!(verify(&key, &text, &sig));
        // Any other call, time, device or argument fails.
        for other in [
            payload("phone-2", "file:write", &v["args"], ts),
            payload("phone-1", "file:read", &v["args"], ts),
            payload("phone-1", "file:write", &v["args"], ts + 1),
            payload("phone-1", "file:write", &json!(["s1"]), ts),
        ] {
            assert!(!verify(&key, &other.unwrap(), &sig));
        }
    }

    #[test]
    fn signs_with_the_vector_private_key_as_a_phone_would() {
        use base64::Engine;
        let v = vector();
        let secret = base64::engine::general_purpose::STANDARD.decode(v["privateKey"].as_str().unwrap()).unwrap();
        let signer = SigningKey::from_slice(&secret).unwrap();
        let public = signer.verifying_key().to_encoded_point(false);
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(public.as_bytes()),
            v["publicKey"].as_str().unwrap()
        );
        let text = v["payload"].as_str().unwrap();
        let sig: Signature = signer.sign(text.as_bytes());
        assert!(verify(&parse_key(v["publicKey"].as_str().unwrap()).unwrap(), text, &sig.to_bytes()));
    }

    #[test]
    fn refuses_malformed_keys_and_proofs() {
        assert!(parse_key("").is_none());
        assert!(parse_key("not base64!").is_none());
        // 65 bytes, but not a point on the curve.
        use base64::Engine;
        let mut bad = vec![4u8];
        bad.extend([7u8; 64]);
        assert!(parse_key(&base64::engine::general_purpose::STANDARD.encode(&bad)).is_none());
        assert!(parse(&json!({ "ts": 1, "sig": "AAAA" })).is_none(), "short signature");
        assert!(
            parse(&json!({ "ts": 1.5, "sig": base64::engine::general_purpose::STANDARD.encode([1u8; 64]) })).is_none()
        );
        assert!(parse(&json!({ "sig": base64::engine::general_purpose::STANDARD.encode([1u8; 64]) })).is_none());
        assert!(parse(&json!("proof")).is_none());
        let key = parse_key(vector()["publicKey"].as_str().unwrap()).unwrap();
        assert!(!verify(&key, "x", &[0u8; 64]));
    }

    #[test]
    fn the_shared_vector_is_the_same_file_the_iphone_reads() {
        let ios = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/ios/Protocol/Tests/NekkoProtocolTests/Fixtures/change-proof.json"
        );
        let ios = std::fs::read_to_string(ios).expect("the iPhone copy of the vector");
        assert_eq!(ios, include_str!("../tests/golden/change-proof.json"), "copy the vector to apps/ios as is");
    }
}
