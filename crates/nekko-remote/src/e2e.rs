//! The E2E layer (`packages/shared/src/e2e.ts`): a key derived from the
//! pairing secret with the room as salt, and AES-256-GCM frames as base64 of
//! `iv || ciphertext || tag`. The relay only ever sees these blobs, and a
//! room credential derived from the secret under its own label
//! ([`relay_auth`], decision 0036), never the secret itself.
//!
//! Every paired device ever held that secret, so the room key carries nothing
//! worth having (decision 0041): one signed challenge per connection, and the
//! refusal an older app gets. Everything else is sealed under [`session_key`],
//! which only that connection's two ends can derive.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

/// PROTOCOL CONSTANTS: every paired device derived its key this way.
/// Changing either breaks decryption for every existing pairing.
const SALT_PREFIX: &str = "nekko-relay:";
const ITERATIONS: u32 = 100_000;

/// PROTOCOL CONSTANT: the label of the room credential the relay checks.
const RELAY_AUTH_LABEL: &str = "nekko-relay-auth:";

/// `relayAuth(secret, room)`: the `key=` a computer and its phones present
/// to the relay, hex of HMAC-SHA256 keyed with the pairing secret over
/// `"nekko-relay-auth:" + room`. It is one-way, so the relay can check that
/// both ends hold the same pairing without learning the secret the E2E key
/// derives from.
pub fn relay_auth(secret: &str, room: &str) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(RELAY_AUTH_LABEL.as_bytes());
    mac.update(room.as_bytes());
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// The AES-256 key for a room.
#[derive(Clone)]
pub struct Key(Aes256Gcm, [u8; 32]);

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key(..)")
    }
}

impl Key {
    /// The raw key bytes (for tests against WebCrypto's export).
    pub fn raw(&self) -> &[u8; 32] {
        &self.1
    }
}

/// `deriveKey(secret, room)`: PBKDF2-HMAC-SHA256, 100,000 rounds.
pub fn derive_key(secret: &str, room: &str) -> Key {
    let salt = format!("{SALT_PREFIX}{room}");
    let raw = pbkdf2::pbkdf2_hmac_array::<sha2::Sha256, 32>(secret.as_bytes(), salt.as_bytes(), ITERATIONS);
    Key(Aes256Gcm::new_from_slice(&raw).expect("a 32-byte key"), raw)
}

/// One side of a connection's key exchange: a P-256 key used once.
pub struct Ephemeral {
    secret: p256::SecretKey,
    /// The public half as frames carry it: X9.63 uncompressed, base64.
    pub public: String,
}

impl std::fmt::Debug for Ephemeral {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ephemeral(..)")
    }
}

impl Ephemeral {
    pub fn new(random: &crate::hello::Random) -> Self {
        let secret = loop {
            let mut bytes = [0u8; 32];
            random(&mut bytes);
            // Zero or past the curve's order: about one draw in 2^32.
            if let Ok(secret) = p256::SecretKey::from_slice(&bytes) {
                break secret;
            }
        };
        let public = STANDARD.encode(
            p256::elliptic_curve::sec1::ToEncodedPoint::to_encoded_point(&secret.public_key(), false).as_bytes(),
        );
        Self { secret, public }
    }

    /// `HKDF-SHA256(ECDH(ours, theirs), zero salt, info)`, or `None` when
    /// `theirs` is not a point on the curve.
    pub fn session_key(&self, theirs: &str, info: &str) -> Option<Key> {
        let bytes = STANDARD.decode(theirs).ok().filter(|b| b.len() == 65)?;
        let peer = p256::PublicKey::from_sec1_bytes(&bytes).ok()?;
        let shared = p256::ecdh::diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
        let mut raw = [0u8; 32];
        shared.extract::<sha2::Sha256>(None).expand(info.as_bytes(), &mut raw).ok()?;
        Some(Key(Aes256Gcm::new_from_slice(&raw).expect("a 32-byte key"), raw))
    }
}

/// A fresh random IV. A repeated GCM nonce leaks plaintext, so without the OS
/// random source there is no safe IV and this panics rather than repeat one.
pub fn random_iv() -> [u8; 12] {
    let mut iv = [0u8; 12];
    getrandom::fill(&mut iv).expect("the OS random source is available");
    iv
}

/// `seal(key, value)` with the IV given: base64 of `iv || ciphertext`, the
/// plaintext being `JSON.stringify(value)`.
pub fn seal_with_iv(key: &Key, value: &Value, iv: [u8; 12]) -> String {
    seal_text(key, &nekko_js::stringify(value), iv)
}

/// Seal text that already is `JSON.stringify` output.
pub fn seal_text(key: &Key, text: &str, iv: [u8; 12]) -> String {
    let ct = key.0.encrypt(&Nonce::from(iv), text.as_bytes()).unwrap_or_default();
    let mut packed = Vec::with_capacity(12 + ct.len());
    packed.extend_from_slice(&iv);
    packed.extend_from_slice(&ct);
    STANDARD.encode(packed)
}

/// `open(key, blob)`: `None` for a wrong key, a tampered or truncated frame,
/// or a plaintext that is not JSON (WebCrypto and `JSON.parse` would throw).
pub fn open(key: &Key, blob: &str) -> Option<Value> {
    let packed = atob(blob)?;
    if packed.len() < 12 {
        return None;
    }
    let (iv, ct) = packed.split_at(12);
    let pt = key.0.decrypt(&Nonce::from(<[u8; 12]>::try_from(iv).ok()?), ct).ok()?;
    serde_json::from_slice(&pt).ok()
}

/// `atob`'s forgiving base64: ASCII whitespace anywhere is dropped and the
/// trailing `=` padding is optional.
fn atob(s: &str) -> Option<Vec<u8>> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    const FORGIVING: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let clean: String = s.chars().filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r')).collect();
    FORGIVING.decode(clean).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_and_rejects_tampering() {
        let key = derive_key("secret-secret-secret", "room");
        let blob = seal_with_iv(&key, &json!({ "a": 1 }), random_iv());
        assert_eq!(open(&key, &blob), Some(json!({ "a": 1 })));
        let other = derive_key("secret-secret-secreu", "room");
        assert_eq!(open(&other, &blob), None);
        let mut bytes = STANDARD.decode(&blob).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert_eq!(open(&key, &STANDARD.encode(bytes)), None);
        assert_eq!(open(&key, "AAAA"), None);
        assert_eq!(open(&key, "not base64!"), None);
    }

    #[test]
    fn both_ends_of_an_exchange_derive_one_key_and_nobody_else_does() {
        let random = crate::hello::os_random();
        let (a, b, c) = (Ephemeral::new(&random), Ephemeral::new(&random), Ephemeral::new(&random));
        let (ab, ba) = (a.session_key(&b.public, "x").unwrap(), b.session_key(&a.public, "x").unwrap());
        assert_eq!(ab.raw(), ba.raw());
        assert_ne!(ab.raw(), a.session_key(&c.public, "x").unwrap().raw());
        assert_ne!(ab.raw(), a.session_key(&b.public, "y").unwrap().raw(), "bound to the transcript");
        assert!(a.session_key("not a point", "x").is_none());
        assert!(a.session_key(&STANDARD.encode([4u8; 65]), "x").is_none());
    }
}
