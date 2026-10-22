//! Joining by approval. A new device can't prove anything with its public key
//! alone (the server could show another), so it makes a one-time **join
//! code**: 80 random bits shown as 16 Crockford base32 characters, which the
//! user types into a device that already syncs. The code does two jobs:
//!
//! - **The approver checks the new device's key.** On registering, the new
//!   device publishes a tag, `HMAC(HKDF(code, "join-tag"), account ‖ public
//!   key)`. The approver recomputes it from the typed code; a key the server
//!   swapped in doesn't match, and nothing is wrapped to it.
//! - **The new device checks the approver.** The keyring is wrapped with a
//!   pre-shared key from the code mixed into the derivation (HPKE's PSK mode in
//!   shape), so only someone who was shown the code could have made the wrap.
//!   A keyring from the server or any other party fails to open.
//!
//! The code never leaves the two screens; the server sees only the tag. 80 bits
//! are far out of reach of offline guessing against the tag or a wrap.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::recovery::{crockford, decode_crockford};
use crate::wrap::{Recipient, open, seal};
use crate::{DeviceKey, Error, Keyring, VERSION, hkdf};

const CODE_BYTES: usize = 10;
const CODE_CHARS: usize = 16;

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct JoinCode([u8; CODE_BYTES]);

impl std::fmt::Debug for JoinCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JoinCode(..)")
    }
}

impl JoinCode {
    pub fn generate() -> JoinCode {
        JoinCode(crate::random())
    }

    pub fn from_bytes(bytes: [u8; CODE_BYTES]) -> JoinCode {
        JoinCode(bytes)
    }

    /// `XXXX-XXXX-XXXX-XXXX`.
    pub fn to_text(&self) -> String {
        let text = crockford(&self.0);
        text.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
    }

    /// What the user typed: any case, dashes and spaces ignored, `O` read as
    /// `0` and `I`/`L` as `1`. There is no checksum: a typo simply fails the tag.
    pub fn parse(text: &str) -> Result<JoinCode, Error> {
        let mut raw = decode_crockford(text, CODE_CHARS)?;
        let mut out = [0u8; CODE_BYTES];
        out.copy_from_slice(&raw[..CODE_BYTES]);
        raw.zeroize();
        Ok(JoinCode(out))
    }

    /// The tag the new device publishes with its key (32 bytes).
    pub fn tag(&self, account_id: &str, public_key: &[u8]) -> [u8; 32] {
        let mut k = hkdf::derive32(&self.0, format!("{VERSION} join-tag").as_bytes());
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&k).expect("HMAC takes any key length");
        k.zeroize();
        mac.update(account_id.as_bytes());
        mac.update(b"\n");
        mac.update(public_key);
        mac.finalize().into_bytes().into()
    }

    /// Does `tag` bind this code to that key? Constant time.
    pub fn verifies(&self, account_id: &str, public_key: &[u8], tag: &[u8]) -> bool {
        let want = self.tag(account_id, public_key);
        tag.len() == want.len() && want.iter().zip(tag).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
    }

    fn psk(&self, account_id: &str, device_id: &str) -> [u8; 32] {
        hkdf::derive32(&self.0, format!("{VERSION} join-psk\n{account_id}\n{device_id}").as_bytes())
    }
}

fn context(account_id: &str, key_id: u32, device_id: &str) -> String {
    format!("{VERSION} join-wrap\n{account_id}\n{key_id}\n{device_id}")
}

/// On the approving device: wrap the current keyring to the new device, keyed
/// by the code the user typed.
pub fn wrap_for_join(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    to: Recipient<'_>,
    code: &JoinCode,
) -> Result<String, Error> {
    wrap_for_join_with(keyring, account_id, key_id, to, code, &DeviceKey::generate())
}

pub fn wrap_for_join_with(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    to: Recipient<'_>,
    code: &JoinCode,
    ephemeral: &DeviceKey,
) -> Result<String, Error> {
    let mut psk = code.psk(account_id, to.id);
    let mut bytes = keyring.to_bytes();
    let out = seal(to.public, &context(account_id, key_id, to.id), &bytes, ephemeral, &psk, &[]);
    bytes.zeroize();
    psk.zeroize();
    out
}

/// On the new device: open the wrap made with its own code.
pub fn unwrap_join(
    key: &DeviceKey,
    account_id: &str,
    key_id: u32,
    device_id: &str,
    code: &JoinCode,
    wrap: &str,
) -> Result<Keyring, Error> {
    let mut psk = code.psk(account_id, device_id);
    let opened = open(key, &context(account_id, key_id, device_id), wrap, &psk, &[]);
    psk.zeroize();
    let mut bytes = opened?;
    let out = Keyring::from_bytes(&bytes);
    bytes.zeroize();
    out
}
