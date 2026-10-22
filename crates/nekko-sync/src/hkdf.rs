//! HKDF-SHA256 (RFC 5869) and the AES-256-GCM calls built on it.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroize;

/// A 32-byte key and 12-byte nonce from one HKDF expansion. Every caller
/// derives with a fresh salt or a fresh ephemeral key, so each pair is used
/// for exactly one encryption.
///
/// HKDF-Expand for 44 bytes is two HMAC blocks, `T1 = HMAC(PRK, info ‖ 01)`
/// and `T2 = HMAC(PRK, T1 ‖ info ‖ 02)`; the key is `T1` and the nonce the
/// first 12 bytes of `T2`. Written out so the output is built from the HMACs
/// rather than copied into zeroed buffers.
pub fn key_and_nonce(ikm: &[u8], salt: &[u8], info: &[u8]) -> ([u8; 32], [u8; 12]) {
    let (mut prk, _) = hkdf::Hkdf::<Sha256>::extract(Some(salt), ikm);
    let block = |previous: &[u8], counter: u8| {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&prk).expect("HMAC takes any key length");
        mac.update(previous);
        mac.update(info);
        mac.update(&[counter]);
        mac.finalize().into_bytes()
    };
    let t1 = block(&[], 1);
    let mut t2 = block(&t1, 2);
    let key: [u8; 32] = t1.into();
    let nonce: [u8; 12] = t2[..12].try_into().expect("an HMAC-SHA256 is 32 bytes");
    t2.zeroize();
    prk.zeroize();
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

#[cfg(test)]
mod tests {
    #[test]
    fn matches_the_hkdf_crate() {
        // Inputs from the OS, as in real use, plus an empty salt (the ECIES callers never pass one, but HKDF allows it).
        for salt_len in [0, 32] {
            let (ikm, salt) = (crate::random::<32>(), crate::random::<32>());
            let (salt, info) = (&salt[..salt_len], b"nekko-sync/v1 record");
            let mut okm = [0u8; 44];
            hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), &ikm).expand(info, &mut okm).unwrap();
            let (key, nonce) = super::key_and_nonce(&ikm, salt, info);
            assert_eq!(&okm[..32], &key);
            assert_eq!(&okm[32..], &nonce);
        }
    }
}
