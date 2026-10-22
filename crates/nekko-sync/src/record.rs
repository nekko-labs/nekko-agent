//! Sealed records: the only thing Nekko Cloud stores for a synced chat.
//!
//! A blob is `0x01 ‖ salt (32) ‖ AES-256-GCM ciphertext and tag`. The key and
//! nonce come from `HKDF-SHA256(ikm = enc key, salt, info = "nekko-sync/v1
//! record")`, so every record (and every revision of it) has its own key. The
//! associated data is [`record_aad`].

use hmac::{Hmac, Mac};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{Error, VERSION, b64, hkdf, pad};

const BLOB_VERSION: u8 = 1;
const SALT_LEN: usize = 32;
const TAG_LEN: usize = 16;

/// The length of an object id: base64url of an HMAC-SHA256.
pub const OBJECT_ID_LEN: usize = 43;

/// The account's secret for one key epoch: the record key and the object id
/// key, 64 bytes in all. It exists in plaintext only in a device's memory and
/// its OS keystore; Nekko Cloud holds it only wrapped (to a device key or the
/// recovery key).
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Keyring {
    enc: [u8; 32],
    id: [u8; 32],
}

impl std::fmt::Debug for Keyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Keyring(..)")
    }
}

impl Keyring {
    /// The first keyring of an account.
    pub fn generate() -> Keyring {
        Keyring { enc: crate::random(), id: crate::random() }
    }

    /// The keyring of the next epoch (after a device is revoked): a new
    /// record key, the same id key so object ids don't change.
    pub fn rotate(&self) -> Keyring {
        Keyring { enc: crate::random(), id: self.id }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Keyring, Error> {
        if bytes.len() != 64 {
            return Err(Error::Malformed);
        }
        let mut k = Keyring { enc: [0; 32], id: [0; 32] };
        k.enc.copy_from_slice(&bytes[..32]);
        k.id.copy_from_slice(&bytes[32..]);
        Ok(k)
    }

    /// `enc ‖ id`, for wrapping and the OS keystore. Zeroize it after use.
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&self.enc);
        out[32..].copy_from_slice(&self.id);
        out
    }
}

/// Collections are short lowercase names (`chat`, `chat-part`, `prompt`).
pub(crate) fn valid_collection(c: &str) -> bool {
    let b = c.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter().all(|&x| x.is_ascii_lowercase() || x.is_ascii_digit() || x == b'-')
}

/// The id the server files a record under: `base64url(HMAC-SHA256(id key,
/// "nekko-sync/v1 object\n" ‖ collection ‖ "\n" ‖ local id))`. The server
/// can't tell which chat an id is, or link it to the chat's id on the
/// computer, but every device of the account gets the same id.
pub fn object_id(keyring: &Keyring, collection: &str, local_id: &str) -> Result<String, Error> {
    if !valid_collection(collection) || local_id.is_empty() {
        return Err(Error::Invalid);
    }
    let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(&keyring.id).expect("HMAC takes any key length");
    mac.update(format!("{VERSION} object\n{collection}\n{local_id}").as_bytes());
    Ok(b64::encode(&mac.finalize().into_bytes()))
}

/// The associated data of a record: every field the server stores beside the
/// blob, so it can't relabel one.
///
/// `nekko-sync/v1 record \n accountId \n keyId \n collection \n objectId \n revision`
pub fn record_aad(account_id: &str, key_id: u32, collection: &str, object_id: &str, revision: u64) -> String {
    format!("{VERSION} record\n{account_id}\n{key_id}\n{collection}\n{object_id}\n{revision}")
}

fn check(collection: &str, object_id: &str, revision: u64) -> Result<(), Error> {
    let id_ok = object_id.len() == OBJECT_ID_LEN
        && object_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid_collection(collection) || !id_ok || revision == 0 {
        return Err(Error::Invalid);
    }
    Ok(())
}

/// Seal a record's plaintext (the caller's JSON, typically) for one revision.
pub fn seal_record(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    collection: &str,
    object_id: &str,
    revision: u64,
    plaintext: &[u8],
) -> Result<String, Error> {
    seal_record_with(keyring, account_id, key_id, collection, object_id, revision, plaintext, crate::random())
}

/// [`seal_record`] with the salt given (the shared test vectors).
#[allow(clippy::too_many_arguments)]
pub fn seal_record_with(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    collection: &str,
    object_id: &str,
    revision: u64,
    plaintext: &[u8],
    salt: [u8; SALT_LEN],
) -> Result<String, Error> {
    check(collection, object_id, revision)?;
    let aad = record_aad(account_id, key_id, collection, object_id, revision);
    let (mut key, nonce) = hkdf::key_and_nonce(&keyring.enc, &salt, format!("{VERSION} record").as_bytes());
    let mut framed = pad::frame(plaintext);
    let ct = hkdf::seal(&key, &nonce, aad.as_bytes(), &framed);
    key.zeroize();
    framed.zeroize();
    let mut blob = Vec::with_capacity(1 + SALT_LEN + ct.len());
    blob.push(BLOB_VERSION);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&ct);
    Ok(b64::encode(&blob))
}

/// Open a record. Fails unless every field matches what it was sealed with.
pub fn open_record(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    collection: &str,
    object_id: &str,
    revision: u64,
    blob: &str,
) -> Result<Vec<u8>, Error> {
    check(collection, object_id, revision)?;
    let raw = b64::decode(blob)?;
    if raw.len() < 1 + SALT_LEN + TAG_LEN || raw[0] != BLOB_VERSION {
        return Err(Error::Malformed);
    }
    let aad = record_aad(account_id, key_id, collection, object_id, revision);
    let (mut key, nonce) =
        hkdf::key_and_nonce(&keyring.enc, &raw[1..1 + SALT_LEN], format!("{VERSION} record").as_bytes());
    let opened = hkdf::open(&key, &nonce, aad.as_bytes(), &raw[1 + SALT_LEN..]);
    key.zeroize();
    let mut framed = opened?;
    let out = pad::unframe(&framed);
    framed.zeroize();
    out
}
