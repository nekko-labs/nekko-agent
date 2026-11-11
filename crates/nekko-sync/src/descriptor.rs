//! Organization fleet descriptors: what a computer publishes so the members of
//! an organization can list it. A descriptor is sealed with the same record
//! envelope as a chat (see `record.rs`) under the organization's keyring, bound
//! to its organization, key epoch, publishing device and fleet revision by the
//! associated data, so Nekko Cloud can't move one to another org, epoch, device
//! or revision. Anyone holding the org keyring can author a descriptor: v1
//! trusts the holders of the key (see `docs/SYNC-ENCRYPTION.md`).

use crate::record::{SALT_LEN, open_with_aad, record_aad, seal_with_aad};
use crate::{Error, Keyring};

/// The collection of an organization fleet descriptor.
pub const FLEET_COLLECTION: &str = "fleet";

/// The "account" an org-sealed record is bound to: `org:<orgId>`.
pub fn org_scope(org_id: &str) -> String {
    format!("org:{org_id}")
}

/// The largest fleet revision (2^53 - 1): what the API accepts and a JSON number holds.
pub const MAX_REVISION: u64 = 9_007_199_254_740_991;

/// A server-issued id (an org or a device uuid) as it may appear in an
/// associated-data string: short, no separators or newlines.
fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn check(org_id: &str, key_id: u32, device_id: &str, revision: u64) -> Result<(), Error> {
    if !id_ok(org_id) || !id_ok(device_id) || key_id == 0 || revision == 0 || revision > MAX_REVISION {
        return Err(Error::Invalid);
    }
    Ok(())
}

/// The associated data of a fleet descriptor: the ordinary record AD with
/// `account = "org:" + orgId`, `keyId` = the org-key epoch, `collection =
/// "fleet"`, `objectId` = the publishing device's id and `revision` = the fleet
/// revision.
pub fn descriptor_aad(org_id: &str, key_id: u32, device_id: &str, revision: u64) -> String {
    record_aad(&org_scope(org_id), key_id, FLEET_COLLECTION, device_id, revision)
}

/// Seal a fleet descriptor under an org keyring.
pub fn seal_descriptor(
    keyring: &Keyring,
    org_id: &str,
    key_id: u32,
    device_id: &str,
    revision: u64,
    plaintext: &[u8],
) -> Result<String, Error> {
    seal_descriptor_with(keyring, org_id, key_id, device_id, revision, plaintext, crate::random())
}

/// [`seal_descriptor`] with the salt given (test vectors).
pub fn seal_descriptor_with(
    keyring: &Keyring,
    org_id: &str,
    key_id: u32,
    device_id: &str,
    revision: u64,
    plaintext: &[u8],
    salt: [u8; SALT_LEN],
) -> Result<String, Error> {
    check(org_id, key_id, device_id, revision)?;
    let aad = descriptor_aad(org_id, key_id, device_id, revision);
    Ok(seal_with_aad(keyring, &aad, plaintext, salt))
}

/// Open a fleet descriptor. Fails unless the org, epoch, device and revision
/// are the ones it was sealed for.
pub fn open_descriptor(
    keyring: &Keyring,
    org_id: &str,
    key_id: u32,
    device_id: &str,
    revision: u64,
    blob: &str,
) -> Result<Vec<u8>, Error> {
    check(org_id, key_id, device_id, revision)?;
    open_with_aad(keyring, &descriptor_aad(org_id, key_id, device_id, revision), blob)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{b64_decode, b64_encode, object_id, seal_record};

    fn ring() -> Keyring {
        Keyring::from_bytes(&(0u8..64).collect::<Vec<_>>()).unwrap()
    }

    const ORG: &str = "0b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b";
    const DEV: &str = "7e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b";
    const GOLDEN: &str = "AQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fpm2vMgZi4SQmrdeX2Bpn5LXtOhpakJP1CNPTjKEkFlTjZwJJ3APydophOoqT8-lx1XES9XMM8R_JhJHDmbcF2eNddFGmeCjM4g9dGzShBxEoJ3UaLF0EU-HUAEUjDnjqmpVi6KGqK-k2ReLy2XNrZIb07AUKRnFbxlRk9kJOvRMbJEDtz8AnYOyT2INCCReovHbmKiKzlFcQjIiF0WguR8DWE0XflIw2Rl-sHdPzR4DKC3J1nWTwn16P4SwPH2z4rChEnHYEHfz0TFv_ZftrTBCyky__2xuQMZA0KpYTmJak9jNsR18tX3n1ApYKHJqq3qEpmajvWYiTFzUWuUAMWuk6Wa_J44PBRwEVxQ2mA7w";

    #[test]
    fn a_descriptor_round_trips_and_is_at_least_305_bytes() {
        let blob = seal_descriptor(&ring(), ORG, 1, DEV, 1, b"{\"v\":1}").unwrap();
        // 1 version + 32 salt + 256 padded frame + 16 tag: the API's lower bound.
        assert_eq!(b64_decode(&blob).unwrap().len(), 305);
        assert_eq!(open_descriptor(&ring(), ORG, 1, DEV, 1, &blob).unwrap(), b"{\"v\":1}");
    }

    #[test]
    fn a_descriptor_matches_its_pinned_bytes() {
        // Pinned so a port (or a refactor) can't drift: salt 0x00..0x1f, key 0x00..0x3f. An independent
        // Node (crypto.hkdfSync + aes-256-gcm) implementation of the format produced the same bytes.
        let salt: [u8; 32] = std::array::from_fn(|i| i as u8);
        let blob = seal_descriptor_with(&ring(), ORG, 3, DEV, 7, b"hello fleet", salt).unwrap();
        assert_eq!(blob, GOLDEN, "update GOLDEN only for an intended format change");
        assert_eq!(open_descriptor(&ring(), ORG, 3, DEV, 7, GOLDEN).unwrap(), b"hello fleet");
        assert_eq!(descriptor_aad(ORG, 3, DEV, 7), format!("nekko-sync/v1 record\norg:{ORG}\n3\nfleet\n{DEV}\n7"));
    }

    #[test]
    fn a_descriptor_opens_only_for_its_org_epoch_device_revision_and_key() {
        let blob = seal_descriptor(&ring(), ORG, 2, DEV, 5, b"x").unwrap();
        let other_org = "1b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b";
        let other_dev = "8e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b";
        assert!(open_descriptor(&ring(), ORG, 2, DEV, 5, &blob).is_ok());
        assert_eq!(open_descriptor(&ring(), other_org, 2, DEV, 5, &blob), Err(Error::Unauthentic));
        assert_eq!(open_descriptor(&ring(), ORG, 3, DEV, 5, &blob), Err(Error::Unauthentic));
        assert_eq!(open_descriptor(&ring(), ORG, 2, other_dev, 5, &blob), Err(Error::Unauthentic));
        assert_eq!(open_descriptor(&ring(), ORG, 2, DEV, 4, &blob), Err(Error::Unauthentic));
        assert_eq!(open_descriptor(&Keyring::generate(), ORG, 2, DEV, 5, &blob), Err(Error::Unauthentic));
        // A record sealed for an account never opens as a descriptor.
        let oid = object_id(&ring(), "chat", "c").unwrap();
        let chat = seal_record(&ring(), ORG, 2, "chat", &oid, 5, b"x").unwrap();
        assert!(open_descriptor(&ring(), ORG, 2, &oid, 5, &chat).is_err());
    }

    #[test]
    fn a_tampered_descriptor_does_not_open() {
        let blob = seal_descriptor(&ring(), ORG, 1, DEV, 1, b"x").unwrap();
        let mut raw = b64_decode(&blob).unwrap();
        for at in [0, 1, 40, raw.len() - 1] {
            raw[at] ^= 1;
            let bad = b64_encode(&raw);
            assert!(open_descriptor(&ring(), ORG, 1, DEV, 1, &bad).is_err(), "byte {at}");
            raw[at] ^= 1;
        }
        assert!(open_descriptor(&ring(), ORG, 1, DEV, 1, "not base64!").is_err());
        assert_eq!(open_descriptor(&ring(), ORG, 1, DEV, 1, &blob[..40]), Err(Error::Malformed));
    }

    #[test]
    fn descriptor_ids_cannot_smuggle_ad_separators() {
        for (org, dev, key, rev) in [
            ("a\nb", DEV, 1, 1),
            (ORG, "x\n1", 1, 1),
            ("", DEV, 1, 1),
            (ORG, "", 1, 1),
            (ORG, DEV, 0, 1),
            (ORG, DEV, 1, 0),
            (ORG, DEV, 1, MAX_REVISION + 1),
        ] {
            assert_eq!(seal_descriptor(&ring(), org, key, dev, rev, b"x"), Err(Error::Invalid));
        }
    }
}
