//! Fleet connections (decision 0102): a desktop of the same account opens a
//! link to this computer because both hold the account's current keys, not
//! because it was paired. The handshake is the ordinary protocol-6 one (the
//! computer's signed challenge, both halves of a one-use key exchange, a HELLO
//! signed with the HELLO key); the HELLO also carries a `fleet` object whose
//! proof is sealed under the account keyring and binds this exchange.
//!
//! Nothing here touches the paired-device registry: a fleet device is kept in
//! memory while it is admitted, under an id of its own (`fleet:<device>`) that
//! no pairing can take, and it is checked again ([`FleetGate::still`]) whenever
//! the account changes, so a sign-out, a lock, a new key epoch, a revoked
//! device or sharing turned off ends a live link, not only the listing.

use serde_json::Value;
use std::sync::Arc;

/// The prefix of a fleet device's id on the computer it connects to.
pub const PREFIX: &str = "fleet:";

/// The id a fleet device's link uses: `fleet:<its account device id>`.
pub fn link_device_id(account_device_id: &str) -> String {
    format!("{PREFIX}{account_device_id}")
}

/// Whether a HELLO's device id is a fleet id (a pairing may never use one).
pub fn is_fleet_id(id: &str) -> bool {
    id.starts_with(PREFIX)
}

/// What a fleet HELLO proof binds: this one handshake, as both ends hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub room: String,
    pub challenge: String,
    pub host_eph: String,
    pub client_eph: String,
    /// The HELLO key (base64 X9.63 P-256) the HELLO is signed with; it also signs Change proofs.
    pub hello_key: String,
}

/// The connecting side: the HELLO's `fleet` object for this handshake, or
/// `None` when it can't make one (signed out, locked, no keys).
pub type FleetSigner = Arc<dyn Fn(&Binding) -> Option<Value> + Send + Sync>;

/// A fleet device the computer let in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    /// The device's id in the account (a sync device id), without the prefix.
    pub device_id: String,
    /// The org whose list it was found in, and whose sharing switch must stay on.
    pub org_id: String,
    /// The account key epoch the proof was sealed under.
    pub key_id: u32,
    /// Its label in the account record.
    pub name: String,
}

/// The computer's side: who may connect through the fleet. Answers from local
/// state only (no network), since it runs inside the handshake.
pub trait FleetGate: Send + Sync {
    /// Check a HELLO's `fleet` object against this handshake. The reason is a
    /// short code the connecting device shows (`fleet-locked`, `fleet-epoch`,
    /// `fleet-off`, `fleet-account`, `fleet-device`, `invalid`).
    fn admit(&self, fleet: &Value, binding: &Binding) -> Result<Admitted, &'static str>;
    /// Whether an admitted device may stay: same account, signed in, unlocked,
    /// the same key epoch, still in the account record, sharing still on.
    fn still(&self, admitted: &Admitted) -> bool;
}
