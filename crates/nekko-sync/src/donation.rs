//! "Help improve Nekko Agent": opt-in, off by default, and still encrypted.
//!
//! A donation is a sample the user chose to share, redacted on the device
//! first (secrets, emails, paths; see `docs/SYNC-ENCRYPTION.md`). It is
//! framed and padded like a record and sealed with [`crate::seal_to`] to
//! Nekko Labs' research public key under the context `nekko-donation/v1 \n
//! donationId`. The research private key is kept offline, never on a server,
//! so the database holds ciphertext for donations too. A donation carries no
//! account, device or IP: the upload is unauthenticated, and only the device
//! that sent it holds the delete token that can withdraw it.

use sha2::{Digest, Sha256};

use crate::{DeviceKey, Error, b64, pad, wrap};

pub const DONATION_VERSION: &str = "nekko-donation/v1";

/// What a device uploads (`id`, `blob`, `delete_hash`) and keeps (`id`,
/// `delete_token`) for one donation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Donation {
    pub id: String,
    pub blob: String,
    pub delete_token: String,
    pub delete_hash: String,
}

pub fn seal_donation(research_public: &[u8], payload: &[u8]) -> Result<Donation, Error> {
    seal_donation_with(research_public, payload, crate::random(), crate::random(), &DeviceKey::generate())
}

pub fn seal_donation_with(
    research_public: &[u8],
    payload: &[u8],
    id: [u8; 16],
    delete_token: [u8; 32],
    ephemeral: &DeviceKey,
) -> Result<Donation, Error> {
    let id = b64::encode(&id);
    let blob =
        wrap::seal_to_with(research_public, &format!("{DONATION_VERSION}\n{id}"), &pad::frame(payload), ephemeral)?;
    Ok(Donation {
        id,
        blob,
        delete_token: b64::encode(&delete_token),
        delete_hash: b64::encode(&Sha256::digest(delete_token)),
    })
}
