//! The release signing key: one Ed25519 key that signs what a release says
//! about itself, checked by everything that reads it. Today that is the
//! update feed (`latest*.yml`, signed into `latest*.yml.sig`, see
//! `update::verify_feed`) and the Claude policy override
//! (`claude-policy.json`, nekkod's `claude_policy.rs`).
//!
//! The private half lives only in the `NEKKO_RELEASE_SIGNING_KEY` GitHub
//! Actions secret and the owner's offline backup. `node scripts/release-key.mjs`
//! makes a new pair and prints the line to paste here. Key generation,
//! custody and rotation: docs/signing.md, "The release signing key".

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};

/// The release signing key's public half.
///
/// TODO(Philip): still the all-zero placeholder: no release signing key has
/// been generated yet. While it is all zeros the updater reads unsigned feeds
/// as before and every Claude policy override is refused. Replace it with the
/// output of `node scripts/release-key.mjs` once the private half is set as
/// the `NEKKO_RELEASE_SIGNING_KEY` secret (docs/signing.md); from that release
/// on, the release workflow fails without the secret and the updater refuses
/// an unsigned or wrongly signed feed.
pub const RELEASE_SIGNING_KEY: [u8; 32] = [0; 32];

/// The all-zero placeholder, standing for "no release key yet".
pub fn is_placeholder(key: &[u8; 32]) -> bool {
    key.iter().all(|b| *b == 0)
}

/// Check a detached Ed25519 signature over `message` (the exact bytes that
/// were signed). `signature` is the signature's base64, as written to a
/// `.sig` file (surrounding whitespace ignored).
pub fn verify_detached(key: &[u8; 32], message: &[u8], signature: &[u8]) -> Result<(), String> {
    if is_placeholder(key) {
        return Err("no release signing key is configured".into());
    }
    let text = std::str::from_utf8(signature).map_err(|_| "the signature is not text")?.trim();
    let raw: [u8; 64] = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| "the signature is not base64")?
        .try_into()
        .map_err(|_| "the signature is not 64 bytes")?;
    let key = VerifyingKey::from_bytes(key).map_err(|_| "the release signing key is invalid")?;
    key.verify_strict(message, &Signature::from_bytes(&raw)).map_err(|_| "bad signature".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn the_embedded_key_is_the_placeholder_or_a_valid_point() {
        if !is_placeholder(&RELEASE_SIGNING_KEY) {
            assert!(VerifyingKey::from_bytes(&RELEASE_SIGNING_KEY).is_ok());
        }
    }

    #[test]
    fn detached_signatures_verify_and_tampering_fails() {
        let sk = SigningKey::from_bytes(&[3; 32]);
        let pk = sk.verifying_key().to_bytes();
        let sig = base64::engine::general_purpose::STANDARD.encode(sk.sign(b"hello").to_bytes());
        assert!(verify_detached(&pk, b"hello", format!("{sig}\n").as_bytes()).is_ok());
        assert_eq!(verify_detached(&pk, b"hellO", sig.as_bytes()), Err("bad signature".into()));
        assert!(verify_detached(&pk, b"hello", b"not base64!").is_err());
        assert!(verify_detached(&[0; 32], b"hello", sig.as_bytes()).is_err());
    }
}
