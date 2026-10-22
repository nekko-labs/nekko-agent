//! The recovery key: 256 random bits that wrap the keyring for when every
//! device is gone. It is shown once, as 55 Crockford base32 characters in
//! groups of five (the key and a 2-byte checksum that catches typos), and
//! Nekko Cloud never sees it. There is deliberately no password option: a
//! password-derived key could be brute-forced by whoever holds the wrapped
//! keyring, and that is the server.
//!
//! The recovery key stands for a P-256 key pair
//! ([`RecoveryKey::agreement_key`]); a recovery wrap is the keyring sealed to
//! its public half exactly like a device wrap (see `wrap.rs`), under the
//! context `nekko-sync/v1 recovery \n accountId \n keyId`. Devices pin only
//! the public half, so rotating to a new key epoch after a revocation can
//! still be sealed for recovery.

use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::wrap::{open_sealed, seal_to_with};
use crate::{DeviceKey, Error, Keyring, VERSION, hkdf};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
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

/// Exactly `chars` Crockford base32 characters back to bytes, leniently
/// (any case, dashes and spaces ignored, `O` as `0`, `I` and `L` as `1`; ASCII
/// only, so every platform reads the same text the same way). The padding bits
/// after the last whole byte must be zero.
pub(crate) fn decode_crockford(text: &str, chars: usize) -> Result<Vec<u8>, Error> {
    let mut raw = Vec::with_capacity(chars * 5 / 8);
    let (mut acc, mut bits, mut n) = (0u32, 0u32, 0usize);
    for c in text.chars() {
        if c == '-' || c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            continue;
        }
        if !c.is_ascii() {
            raw.zeroize();
            return Err(Error::Malformed);
        }
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        let Some(v) = ALPHABET.iter().position(|&a| a as char == c) else {
            raw.zeroize();
            return Err(Error::Malformed);
        };
        n += 1;
        if n > chars {
            raw.zeroize();
            return Err(Error::Malformed);
        }
        acc = ((acc << 5) | v as u32) & 0xFFFF;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            raw.push((acc >> bits) as u8);
        }
    }
    if n != chars || acc & ((1 << bits) - 1) != 0 {
        raw.zeroize();
        return Err(Error::Malformed);
    }
    acc.zeroize();
    Ok(raw)
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
        let mut raw = decode_crockford(text, TEXT_LEN)?;
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

impl RecoveryKey {
    /// The P-256 key pair this recovery key stands for: the first valid
    /// scalar among `HKDF-SHA256(recovery key, info = "nekko-sync/v1
    /// recovery-key" ‖ counter)`, counter from 0 (a retry is needed with
    /// probability about 2^-32). Devices keep only its public half, so every
    /// new key epoch can be sealed to the recovery key without a device ever
    /// holding the recovery secret.
    pub fn agreement_key(&self) -> DeviceKey {
        for counter in 0u8..=u8::MAX {
            let info = [format!("{VERSION} recovery-key").as_bytes(), &[counter]].concat();
            let mut d = hkdf::derive32(&self.0, &info);
            let key = DeviceKey::from_bytes(&d);
            d.zeroize();
            if let Ok(key) = key {
                return key;
            }
        }
        unreachable!("256 HKDF outputs are all outside the P-256 scalar range")
    }

    /// The public half devices pin (65 bytes, uncompressed).
    pub fn public_key(&self) -> Vec<u8> {
        self.agreement_key().public()
    }
}

/// Seal a key epoch's keyring to the recovery key's public half (ECIES, as a
/// device wrap), under the context `nekko-sync/v1 recovery \n account \n keyId`.
pub fn seal_recovery(
    recovery_public: &[u8],
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
) -> Result<String, Error> {
    seal_recovery_with(recovery_public, keyring, account_id, key_id, &DeviceKey::generate())
}

pub fn seal_recovery_with(
    recovery_public: &[u8],
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    ephemeral: &DeviceKey,
) -> Result<String, Error> {
    let mut bytes = keyring.to_bytes();
    let out = seal_to_with(recovery_public, &context(account_id, key_id), &bytes, ephemeral);
    bytes.zeroize();
    out
}

pub fn open_recovery(recovery: &RecoveryKey, account_id: &str, key_id: u32, blob: &str) -> Result<Keyring, Error> {
    let mut bytes = open_sealed(&recovery.agreement_key(), &context(account_id, key_id), blob)?;
    let out = Keyring::from_bytes(&bytes);
    bytes.zeroize();
    out
}
