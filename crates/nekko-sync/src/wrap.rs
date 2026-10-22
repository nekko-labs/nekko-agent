//! ECIES over P-256: how a keyring reaches a device, and how a donation
//! reaches Nekko Labs' offline research key.
//!
//! A blob is `0x01 ‖ ephemeral public key (65, X9.63 uncompressed) ‖
//! AES-256-GCM ciphertext and tag`. The key and nonce are
//! `HKDF-SHA256(ikm = ECDH x-coordinate, salt = ephemeral ‖ recipient public
//! keys, info = context)`, and the context is also the associated data.

use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{Error, Keyring, VERSION, b64, hkdf};

const BLOB_VERSION: u8 = 1;
const TAG_LEN: usize = 16;

/// An uncompressed P-256 public key: `0x04 ‖ x ‖ y`.
pub const PUBLIC_KEY_LEN: usize = 65;

/// A device's agreement key. On an iPhone the private half is a Secure
/// Enclave key and never exists as bytes; elsewhere it lives in the OS
/// keystore. Only the public half is sent to Nekko Cloud.
pub struct DeviceKey(SecretKey);

impl std::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DeviceKey(..)")
    }
}

impl DeviceKey {
    pub fn generate() -> DeviceKey {
        loop {
            if let Ok(k) = SecretKey::from_slice(&crate::random::<32>()) {
                return DeviceKey(k);
            }
        }
    }

    /// The 32-byte private scalar, for the OS keystore and the test vectors.
    pub fn from_bytes(bytes: &[u8]) -> Result<DeviceKey, Error> {
        SecretKey::from_slice(bytes).map(DeviceKey).map_err(|_| Error::Invalid)
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.to_bytes().into()
    }

    /// The public key, 65 bytes uncompressed.
    pub fn public(&self) -> Vec<u8> {
        self.0.public_key().to_encoded_point(false).as_bytes().to_vec()
    }
}

fn parse_public(bytes: &[u8]) -> Result<PublicKey, Error> {
    if bytes.len() != PUBLIC_KEY_LEN || bytes[0] != 4 {
        return Err(Error::Invalid);
    }
    PublicKey::from_sec1_bytes(bytes).map_err(|_| Error::Invalid)
}

/// A short code for a public key, to compare on two screens before a device
/// is trusted: the first 10 bytes of its SHA-256 as 16 Crockford base32
/// characters in four groups.
pub fn fingerprint(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    let text = crate::recovery::crockford(&digest[..10]);
    text.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

/// Seal bytes to a public key under a context string.
pub fn seal_to(recipient: &[u8], context: &str, plaintext: &[u8]) -> Result<String, Error> {
    seal_to_with(recipient, context, plaintext, &DeviceKey::generate())
}

/// [`seal_to`] with the ephemeral key given (the shared test vectors).
pub fn seal_to_with(recipient: &[u8], context: &str, plaintext: &[u8], ephemeral: &DeviceKey) -> Result<String, Error> {
    let recipient_key = parse_public(recipient)?;
    let eph_pub = ephemeral.public();
    let shared = diffie_hellman(ephemeral.0.to_nonzero_scalar(), recipient_key.as_affine());
    let salt = [eph_pub.as_slice(), recipient].concat();
    let (mut key, nonce) = hkdf::key_and_nonce(shared.raw_secret_bytes(), &salt, context.as_bytes());
    let ct = hkdf::seal(&key, &nonce, context.as_bytes(), plaintext);
    key.zeroize();
    let mut blob = Vec::with_capacity(1 + PUBLIC_KEY_LEN + ct.len());
    blob.push(BLOB_VERSION);
    blob.extend_from_slice(&eph_pub);
    blob.extend_from_slice(&ct);
    Ok(b64::encode(&blob))
}

/// Open a blob sealed to this key under the same context.
pub fn open_sealed(key: &DeviceKey, context: &str, blob: &str) -> Result<Vec<u8>, Error> {
    let raw = b64::decode(blob)?;
    if raw.len() < 1 + PUBLIC_KEY_LEN + TAG_LEN || raw[0] != BLOB_VERSION {
        return Err(Error::Malformed);
    }
    let eph_pub = &raw[1..1 + PUBLIC_KEY_LEN];
    let eph = parse_public(eph_pub).map_err(|_| Error::Malformed)?;
    let shared = diffie_hellman(key.0.to_nonzero_scalar(), eph.as_affine());
    let salt = [eph_pub, key.public().as_slice()].concat();
    let (mut k, nonce) = hkdf::key_and_nonce(shared.raw_secret_bytes(), &salt, context.as_bytes());
    let out = hkdf::open(&k, &nonce, context.as_bytes(), &raw[1 + PUBLIC_KEY_LEN..]);
    k.zeroize();
    out
}

fn wrap_context(account_id: &str, key_id: u32, device_id: &str) -> String {
    format!("{VERSION} wrap\n{account_id}\n{key_id}\n{device_id}")
}

/// Wrap a keyring to a device. The context names the account, the key epoch
/// and the device, so the server can't hand one device's wrap to another.
pub fn wrap_keyring(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    device_id: &str,
    device_public: &[u8],
) -> Result<String, Error> {
    wrap_keyring_with(keyring, account_id, key_id, device_id, device_public, &DeviceKey::generate())
}

pub fn wrap_keyring_with(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    device_id: &str,
    device_public: &[u8],
    ephemeral: &DeviceKey,
) -> Result<String, Error> {
    let mut bytes = keyring.to_bytes();
    let out = seal_to_with(device_public, &wrap_context(account_id, key_id, device_id), &bytes, ephemeral);
    bytes.zeroize();
    out
}

pub fn unwrap_keyring(
    key: &DeviceKey,
    account_id: &str,
    key_id: u32,
    device_id: &str,
    wrap: &str,
) -> Result<Keyring, Error> {
    let mut bytes = open_sealed(key, &wrap_context(account_id, key_id, device_id), wrap)?;
    let out = Keyring::from_bytes(&bytes);
    bytes.zeroize();
    out
}
