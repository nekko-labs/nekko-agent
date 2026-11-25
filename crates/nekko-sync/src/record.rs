//! Sealed records: the only thing Nekko Cloud stores for a synced chat.
//!
//! A blob is `version ‖ salt (32) ‖ AES-256-GCM ciphertext and tag`. Version 1
//! seals the plaintext as it is. Version 2 (decision 0121) seals the raw
//! deflate (RFC 1951) of the plaintext, and its associated data ends with
//! [`DEFLATE_AAD`], so the version byte can't be flipped by the server: a
//! version 2 blob does not open as version 1 or the other way round. The key and
//! nonce come from `HKDF-SHA256(ikm = enc key, salt, info = "nekko-sync/v1
//! record")`, so every record (and every revision of it) has its own key. The
//! associated data is [`record_aad`].

use hmac::{Hmac, Mac};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{Error, VERSION, b64, hkdf, pad};

const BLOB_VERSION: u8 = 1;
/// The blob version of a record whose plaintext was deflated before sealing.
const BLOB_VERSION_DEFLATE: u8 = 2;
/// Added to the associated data of a version 2 blob.
pub const DEFLATE_AAD: &str = "\ncodec\ndeflate";
/// The most plaintext a record opens to, deflated or not. It is the largest chat
/// (`MAX_CHAT_BYTES` in nekko-cloud) and keeps a corrupted or hostile record from
/// becoming a decompression bomb. A sealed object is at most 16 MiB anyway.
pub const MAX_PLAINTEXT: usize = 16_000_000;
/// Smaller plaintext is sealed as it is: the saving is nothing and the time is not.
pub const MIN_COMPRESS: usize = 1024;
pub(crate) const SALT_LEN: usize = 32;
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
        let enc = bytes[..32].try_into().map_err(|_| Error::Malformed)?;
        let id = bytes[32..].try_into().map_err(|_| Error::Malformed)?;
        Ok(Keyring { enc, id })
    }

    /// `enc ‖ id`, for wrapping and the OS keystore. Zeroize it after use.
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&self.enc);
        out[32..].copy_from_slice(&self.id);
        out
    }
}

/// The info string of [`epoch_proof`]: `nekko-sync-epoch-proof/v1 \n keyId`.
pub const EPOCH_PROOF_LABEL: &str = "nekko-sync-epoch-proof/v1";

/// Proof that a device holds an epoch's keyring, shown to Nekko Cloud before
/// it lets a sign-in change keys, devices or data: `HKDF-SHA256(ikm = the
/// 64-byte keyring, salt = empty, info = "nekko-sync-epoch-proof/v1\n" ‖
/// keyId)`, 32 bytes. The server keeps only its SHA-256. It is one-way, so
/// knowing it opens nothing.
pub fn epoch_proof(keyring: &Keyring, key_id: u32) -> [u8; 32] {
    let mut ikm = keyring.to_bytes();
    let out = hkdf::derive32(&ikm, format!("{EPOCH_PROOF_LABEL}\n{key_id}").as_bytes());
    ikm.zeroize();
    out
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
    Ok(seal_with_aad(keyring, &aad, plaintext, salt))
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
    let aad = record_aad(account_id, key_id, collection, object_id, revision);
    open_with_aad(keyring, &aad, blob)
}

/// The envelope for any associated data: shared by records and fleet descriptors.
pub(crate) fn seal_with_aad(keyring: &Keyring, aad: &str, plaintext: &[u8], salt: [u8; SALT_LEN]) -> String {
    seal_blob(keyring, aad, plaintext, salt, BLOB_VERSION)
}

fn seal_blob(keyring: &Keyring, aad: &str, plaintext: &[u8], salt: [u8; SALT_LEN], version: u8) -> String {
    let (mut key, nonce) = hkdf::key_and_nonce(&keyring.enc, &salt, format!("{VERSION} record").as_bytes());
    let mut framed = pad::frame(plaintext);
    let ct = hkdf::seal(&key, &nonce, aad.as_bytes(), &framed);
    key.zeroize();
    framed.zeroize();
    let mut blob = Vec::with_capacity(1 + SALT_LEN + ct.len());
    blob.push(version);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&ct);
    b64::encode(&blob)
}

pub(crate) fn open_with_aad(keyring: &Keyring, aad: &str, blob: &str) -> Result<Vec<u8>, Error> {
    let raw = b64::decode(blob)?;
    if raw.len() < 1 + SALT_LEN + TAG_LEN || !matches!(raw[0], BLOB_VERSION | BLOB_VERSION_DEFLATE) {
        return Err(Error::Malformed);
    }
    let deflated = raw[0] == BLOB_VERSION_DEFLATE;
    let aad = if deflated { format!("{aad}{DEFLATE_AAD}") } else { aad.to_string() };
    let (mut key, nonce) =
        hkdf::key_and_nonce(&keyring.enc, &raw[1..1 + SALT_LEN], format!("{VERSION} record").as_bytes());
    let opened = hkdf::open(&key, &nonce, aad.as_bytes(), &raw[1 + SALT_LEN..]);
    key.zeroize();
    let mut framed = opened?;
    let out = pad::unframe(&framed);
    framed.zeroize();
    if deflated { inflate(&out?) } else { out }
}

/// Raw deflate, level 6. The output is not smaller for every input; the caller checks.
pub(crate) fn deflate(plaintext: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc =
        flate2::write::DeflateEncoder::new(Vec::with_capacity(plaintext.len() / 4), flate2::Compression::new(6));
    // Writing to a Vec cannot fail.
    enc.write_all(plaintext).expect("writing to memory");
    enc.finish().expect("writing to memory")
}

/// Inflate, refusing more than [`MAX_PLAINTEXT`] bytes of output (a decompression bomb) and a
/// stream that is cut short.
pub(crate) fn inflate(deflated: &[u8]) -> Result<Vec<u8>, Error> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(deflated)
        .take(MAX_PLAINTEXT as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| Error::Malformed)?;
    if out.len() > MAX_PLAINTEXT {
        return Err(Error::Malformed);
    }
    Ok(out)
}

/// [`seal_record`] that deflates the plaintext first when that makes the sealed record smaller
/// (a version 2 blob), and seals it as it is otherwise (version 1). Only for a record every
/// device of the account can read (decision 0121): an older build does not open a version 2 blob.
pub fn seal_record_compressed(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    collection: &str,
    object_id: &str,
    revision: u64,
    plaintext: &[u8],
) -> Result<String, Error> {
    seal_record_compressed_with(
        keyring,
        account_id,
        key_id,
        collection,
        object_id,
        revision,
        plaintext,
        crate::random(),
    )
}

/// [`seal_record_compressed`] with the salt given (the shared test vectors).
#[allow(clippy::too_many_arguments)]
pub fn seal_record_compressed_with(
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
    if plaintext.len() >= MIN_COMPRESS && plaintext.len() <= MAX_PLAINTEXT {
        let small = deflate(plaintext);
        // The padded size is what is sealed, so compare that.
        if pad::padme((small.len() + 4).max(pad::MIN_PADDED)) < pad::padme((plaintext.len() + 4).max(pad::MIN_PADDED)) {
            return Ok(seal_blob(keyring, &format!("{aad}{DEFLATE_AAD}"), &small, salt, BLOB_VERSION_DEFLATE));
        }
    }
    Ok(seal_with_aad(keyring, &aad, plaintext, salt))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    fn keyring() -> Keyring {
        Keyring::from_bytes(&[3u8; 64]).unwrap()
    }

    const OID: &str = "pyzooEigcFKdbQmZUiNdKBruOHQo_z4mLG9HTzS6SR4";

    fn chat_like(n: usize) -> Vec<u8> {
        let mut s = String::from(r#"{"v":1,"chat":{"id":"s_1","messages":["#);
        let mut i = 0;
        while s.len() < n {
            s.push_str(&format!(
                r#"{{"role":"tool","name":"bash","content":"line {i}: error[E0308]: mismatched types in src/lib.rs"}},"#
            ));
            i += 1;
        }
        s.push_str("{}]}}");
        s.into_bytes()
    }

    fn version_of(blob: &str) -> u8 {
        b64::decode(blob).unwrap()[0]
    }

    #[test]
    fn a_compressed_record_is_version_two_smaller_and_opens() {
        let plain = chat_like(200_000);
        let v1 = seal_record(&keyring(), "acct", 1, "chat", OID, 1, &plain).unwrap();
        let v2 = seal_record_compressed(&keyring(), "acct", 1, "chat", OID, 1, &plain).unwrap();
        assert_eq!((version_of(&v1), version_of(&v2)), (1, 2));
        assert!(v2.len() * 5 < v1.len(), "{} vs {}", v2.len(), v1.len());
        assert_eq!(open_record(&keyring(), "acct", 1, "chat", OID, 1, &v2).unwrap(), plain);
        assert_eq!(open_record(&keyring(), "acct", 1, "chat", OID, 1, &v1).unwrap(), plain);
    }

    #[test]
    fn small_and_incompressible_records_stay_version_one() {
        let small = seal_record_compressed(&keyring(), "acct", 1, "chat", OID, 1, b"{\"v\":1}").unwrap();
        assert_eq!(version_of(&small), 1);
        // Hash output does not deflate.
        let mut noise = Vec::new();
        let mut h = sha2::Sha256::digest(b"seed");
        while noise.len() < 20_000 {
            noise.extend_from_slice(&h);
            h = sha2::Sha256::digest(h);
        }
        let blob = seal_record_compressed(&keyring(), "acct", 1, "chat", OID, 1, &noise).unwrap();
        assert_eq!(version_of(&blob), 1);
        assert_eq!(open_record(&keyring(), "acct", 1, "chat", OID, 1, &blob).unwrap(), noise);
    }

    #[test]
    fn the_version_byte_cannot_be_flipped() {
        use base64::Engine;
        let plain = chat_like(20_000);
        let v2 = seal_record_compressed(&keyring(), "acct", 1, "chat", OID, 1, &plain).unwrap();
        let v1 = seal_record(&keyring(), "acct", 1, "chat", OID, 1, &plain).unwrap();
        let flip = |blob: &str, to: u8| {
            let mut raw = b64::decode(blob).unwrap();
            raw[0] = to;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
        };
        assert_eq!(open_record(&keyring(), "acct", 1, "chat", OID, 1, &flip(&v2, 1)), Err(Error::Unauthentic));
        assert_eq!(open_record(&keyring(), "acct", 1, "chat", OID, 1, &flip(&v1, 2)), Err(Error::Unauthentic));
        assert_eq!(open_record(&keyring(), "acct", 1, "chat", OID, 1, &flip(&v2, 3)), Err(Error::Malformed));
        assert!(open_record(&keyring(), "acct", 1, "chat", OID, 2, &v2).is_err());
    }

    #[test]
    fn a_decompression_bomb_is_refused_at_the_cap_and_the_cap_is_allowed() {
        let kr = keyring();
        let aad = format!("{}{DEFLATE_AAD}", record_aad("acct", 1, "chat", OID, 1));
        let seal = |n: usize| {
            let small = deflate(&vec![b'a'; n]);
            assert!(small.len() < 100_000);
            seal_blob(&kr, &aad, &small, [9; SALT_LEN], BLOB_VERSION_DEFLATE)
        };
        let ok = open_record(&kr, "acct", 1, "chat", OID, 1, &seal(MAX_PLAINTEXT)).unwrap();
        assert_eq!(ok.len(), MAX_PLAINTEXT);
        assert_eq!(open_record(&kr, "acct", 1, "chat", OID, 1, &seal(MAX_PLAINTEXT + 1)), Err(Error::Malformed));
        assert_eq!(open_record(&kr, "acct", 1, "chat", OID, 1, &seal(40_000_000)), Err(Error::Malformed));
    }

    #[test]
    fn a_truncated_or_garbage_stream_is_refused() {
        let kr = keyring();
        let aad = format!("{}{DEFLATE_AAD}", record_aad("acct", 1, "chat", OID, 1));
        let full = deflate(&chat_like(50_000));
        for body in [&full[..full.len() / 2], &[0xffu8; 300][..], &[][..]] {
            let blob = seal_blob(&kr, &aad, body, [9; SALT_LEN], BLOB_VERSION_DEFLATE);
            assert!(open_record(&kr, "acct", 1, "chat", OID, 1, &blob).is_err());
        }
    }
}
