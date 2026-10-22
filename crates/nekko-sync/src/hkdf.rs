//! HKDF-SHA256 (RFC 5869) and the AES-256-GCM calls built on it.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use zeroize::Zeroize;

/// A 32-byte key and 12-byte nonce from one HKDF expansion. Every caller
/// derives with a fresh salt or a fresh ephemeral key, so each pair is used
/// for exactly one encryption.
pub fn key_and_nonce(ikm: &[u8], salt: &[u8], info: &[u8]) -> ([u8; 32], [u8; 12]) {
    let mut okm = [0u8; 44];
    hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), ikm).expand(info, &mut okm).expect("44 bytes is within HKDF's limit");
    let mut key = [0u8; 32];
    let mut nonce = [0u8; 12];
    key.copy_from_slice(&okm[..32]);
    nonce.copy_from_slice(&okm[32..]);
    okm.zeroize();
    (key, nonce)
}

pub fn seal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    Aes256Gcm::new(key.into())
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .expect("AES-GCM encrypts any input under 64 GiB")
}

pub fn open(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, crate::Error> {
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| crate::Error::Unauthentic)
}
