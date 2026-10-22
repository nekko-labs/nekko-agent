//! The recovery key: 256 random bits that wrap the keyring for when every
//! device is gone. It is shown once, as 55 Crockford base32 characters in
//! groups of five (the key and a 2-byte checksum that catches typos), and
//! Nekko Cloud never sees it. There is deliberately no password option: a
//! password-derived key could be brute-forced by whoever holds the wrapped
//! keyring, and that is the server.
//!
//! A recovery wrap is `0x01 ‖ salt (32) ‖ AES-256-GCM ciphertext and tag`,
//! keyed by `HKDF-SHA256(ikm = recovery key, salt, info = context)` with
//! context `nekko-sync/v1 recovery \n accountId \n keyId`, also the
//! associated data.

use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{Error, Keyring, VERSION, b64, hkdf};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BLOB_VERSION: u8 = 1;
const SALT_LEN: usize = 32;
const TAG_LEN: usize = 16;
const TEXT_LEN: usize = 55;

/// Bytes as Crockford base32, most significant bit first, the last
/// character zero-padded.
pub(crate) fn crockford(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct RecoveryKey([u8; 32]);

impl std::fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryKey(..)")
    }
}

impl RecoveryKey {
    pub fn generate() -> RecoveryKey {
        RecoveryKey(crate::random())
    }

    pub fn from_bytes(bytes: [u8; 32]) -> RecoveryKey {
        RecoveryKey(bytes)
    }

    /// `XXXXX-XXXXX-…`, eleven groups.
    pub fn to_text(&self) -> String {
        let mut raw = [0u8; 34];
        raw[..32].copy_from_slice(&self.0);
        raw[32..].copy_from_slice(&Sha256::digest(self.0)[..2]);
        let text = crockford(&raw);
        raw.zeroize();
        text.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
    }

    /// Parse what the user typed: any case, dashes and spaces ignored, `O`
    /// read as `0` and `I`/`L` as `1`.
    pub fn parse(text: &str) -> Result<RecoveryKey, Error> {
        let mut raw = [0u8; 35];
        let (mut acc, mut bits, mut n, mut chars) = (0u32, 0u32, 0usize, 0usize);
        for c in text.chars() {
            if c == '-' || c.is_whitespace() {
                continue;
            }
            let c = match c.to_ascii_uppercase() {
                'O' => '0',
                'I' | 'L' => '1',
                c => c,
            };
            let v = ALPHABET.iter().position(|&a| a as char == c).ok_or(Error::Malformed)? as u32;
            chars += 1;
            if chars > TEXT_LEN {
                return Err(Error::Malformed);
            }
            acc = (acc << 5) | v;
            bits += 5;
            if bits >= 8 {
                bits -= 8;
                raw[n] = (acc >> bits) as u8;
                n += 1;
            }
        }
        // 55 characters are 275 bits: 34 bytes and 3 zero bits.
        if chars != TEXT_LEN || n != 34 || acc & ((1 << bits) - 1) != 0 {
            return Err(Error::Malformed);
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&raw[..32]);
        let ok = Sha256::digest(key)[..2] == raw[32..34];
        raw.zeroize();
        if !ok {
            key.zeroize();
            return Err(Error::Checksum);
        }
        Ok(RecoveryKey(key))
    }
}

fn context(account_id: &str, key_id: u32) -> String {
    format!("{VERSION} recovery\n{account_id}\n{key_id}")
}

pub fn seal_recovery(recovery: &RecoveryKey, keyring: &Keyring, account_id: &str, key_id: u32) -> String {
    seal_recovery_with(recovery, keyring, account_id, key_id, crate::random())
}

pub fn seal_recovery_with(
    recovery: &RecoveryKey,
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    salt: [u8; SALT_LEN],
) -> String {
    let ctx = context(account_id, key_id);
    let (mut key, nonce) = hkdf::key_and_nonce(&recovery.0, &salt, ctx.as_bytes());
    let mut bytes = keyring.to_bytes();
    let ct = hkdf::seal(&key, &nonce, ctx.as_bytes(), &bytes);
    key.zeroize();
    bytes.zeroize();
    let mut blob = Vec::with_capacity(1 + SALT_LEN + ct.len());
    blob.push(BLOB_VERSION);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&ct);
    b64::encode(&blob)
}

pub fn open_recovery(recovery: &RecoveryKey, account_id: &str, key_id: u32, blob: &str) -> Result<Keyring, Error> {
    let raw = b64::decode(blob)?;
    if raw.len() < 1 + SALT_LEN + TAG_LEN || raw[0] != BLOB_VERSION {
        return Err(Error::Malformed);
    }
    let ctx = context(account_id, key_id);
    let (mut key, nonce) = hkdf::key_and_nonce(&recovery.0, &raw[1..1 + SALT_LEN], ctx.as_bytes());
    let opened = hkdf::open(&key, &nonce, ctx.as_bytes(), &raw[1 + SALT_LEN..]);
    key.zeroize();
    let mut bytes = opened?;
    let out = Keyring::from_bytes(&bytes);
    bytes.zeroize();
    out
}
