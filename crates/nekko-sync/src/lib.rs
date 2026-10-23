//! End-to-end encrypted chat sync with Nekko Cloud (Pro and Team plans).
//!
//! Nekko Cloud stores a user's synced chats, but it can never read them: every
//! record is sealed on the user's own devices with a key the server never
//! holds, and the server keeps only the ciphertext, the opaque ids and the
//! revision numbers it needs to order changes. The design is written up in
//! `docs/SYNC-ENCRYPTION.md`; this crate is its reference implementation, and
//! `apps/ios/Protocol/Sources/NekkoProtocol/SyncCrypto.swift` is held to the
//! same bytes by the shared vectors in `tests/golden/sync-crypto.json`.
//!
//! The key hierarchy:
//!
//! ```text
//! recovery key (shown once, 256 bits) ──wraps──┐
//! device key (P-256, per device) ──────wraps──┤
//!                                              ▼
//!                         keyring (per key epoch): enc key ‖ id key
//!                              │                     │
//!            HKDF(enc key, random salt)      HMAC(id key, collection ‖ local id)
//!                              ▼                     ▼
//!                  one AES-256-GCM key per record    opaque object id
//! ```
//!
//! - [`Keyring`]: the account's secret for one key epoch. A new epoch (after a
//!   device is revoked) gets a new enc key and keeps the id key, so object ids
//!   stay stable while new writes are unreadable to the revoked device.
//! - [`seal_record`] / [`open_record`]: one fresh key and nonce per record,
//!   derived from a random 32-byte salt, so no (key, nonce) pair is ever used
//!   twice and GCM's per-key message limit never comes into play. The account,
//!   key epoch, collection, object id and revision are bound as associated
//!   data, so the server can't move a record to another object, account or
//!   revision. Plaintext is padded (Padmé) so sizes leak little.
//! - [`wrap_keyring`] / [`unwrap_keyring`]: ECIES over P-256 to a device's
//!   public key (the iPhone's lives in the Secure Enclave), authenticated by
//!   the sending device's key, so a device takes a keyring only from a device
//!   it already trusts.
//! - [`JoinCode`], [`wrap_for_join`] / [`unwrap_join`]: approving a new
//!   device with a one-time code the user types, which checks the new
//!   device's key on the approver and the approver on the new device.
//! - [`RecoveryKey`]: 256 random bits printed as Crockford base32 with a
//!   checksum. It is the only way back in if every device is lost; there is no
//!   password, so there is nothing for the server to brute-force.
//! - [`seal_donation`]: the opt-in "help improve Nekko Agent" path. A donated,
//!   locally redacted sample is sealed to Nekko Labs' offline research key, so
//!   even a donation is ciphertext on the server and is never tied to the
//!   account that sent it.

mod b64;
mod donation;
mod hkdf;
mod join;
mod pad;
mod record;
mod recovery;
mod wrap;

pub use b64::{decode as b64_decode, encode as b64_encode};
pub use donation::{DONATION_VERSION, Donation, seal_donation, seal_donation_with};
pub use join::{JoinCode, unwrap_join, wrap_for_join, wrap_for_join_with};
pub use pad::{frame, padme, unframe};
pub use record::{Keyring, OBJECT_ID_LEN, object_id, open_record, record_aad, seal_record, seal_record_with};
pub use recovery::{RecoveryKey, open_recovery, seal_recovery, seal_recovery_with};
pub use wrap::{
    DeviceKey, PUBLIC_KEY_LEN, Recipient, fingerprint, open_sealed, seal_to, seal_to_with, unwrap_keyring,
    wrap_keyring, wrap_keyring_with,
};

/// The first part of every label and associated-data string: bumped only with
/// a new, incompatible format.
pub const VERSION: &str = "nekko-sync/v1";

/// Why a blob could not be opened or a value could not be parsed. Kept coarse
/// on purpose: a caller never learns more than "this did not authenticate".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// The blob is too short, has an unknown version byte, or is not base64url.
    Malformed,
    /// The tag did not verify: wrong key, wrong context, or a tampered blob.
    Unauthentic,
    /// A collection name, id or key outside what the format allows.
    Invalid,
    /// A recovery key whose checksum does not match (a typo).
    Checksum,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Error::Malformed => "malformed",
            Error::Unauthentic => "unauthentic",
            Error::Invalid => "invalid",
            Error::Checksum => "checksum",
        })
    }
}

impl std::error::Error for Error {}

/// Fresh bytes from the OS. Without a random source there is no safe key or
/// salt, so this panics rather than continue.
pub(crate) fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the OS random source is available");
    out
}
