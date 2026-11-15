//! Opening a chat on a computer of the same account, found through an
//! organization's fleet (decision 0102). Two sealed values, both under the
//! **account** keyring, never the org keyring, so only the account's own
//! unlocked devices can make or read them:
//!
//! - the **connect block** a sharing computer puts inside its fleet
//!   descriptor: how to reach its relay agent (routes, room, room secret and
//!   the agent's host key). Bound to the account, the account key epoch, the
//!   org, the publishing device and the fleet revision.
//! - the **fleet HELLO proof** a connecting device puts in its HELLO: bound to
//!   the account, epoch and device, and carrying the org, room, the computer's
//!   fresh challenge, both halves of the key exchange and the HELLO key, which
//!   the computer compares with the handshake it is running.
//!
//! The envelope is the record envelope (`record.rs`) with its own associated
//! data, so neither can be opened as the other, as a chat, or as a descriptor.

use crate::record::{SALT_LEN, open_with_aad, seal_with_aad};
use crate::{Error, Keyring, VERSION};

/// A server-issued id (account, org or device uuid) as it may appear in an
/// associated-data string: short, no separators or newlines.
fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `nekko-sync/v1 fleet-connect \n account \n keyId \n org \n device \n revision`
pub fn connect_aad(account_id: &str, key_id: u32, org_id: &str, device_id: &str, revision: u64) -> String {
    format!("{VERSION} fleet-connect\n{account_id}\n{key_id}\n{org_id}\n{device_id}\n{revision}")
}

/// `nekko-sync/v1 fleet-hello \n account \n keyId \n device`
pub fn hello_proof_aad(account_id: &str, key_id: u32, device_id: &str) -> String {
    format!("{VERSION} fleet-hello\n{account_id}\n{key_id}\n{device_id}")
}

fn check_connect(account_id: &str, key_id: u32, org_id: &str, device_id: &str, revision: u64) -> Result<(), Error> {
    if !id_ok(account_id) || !id_ok(org_id) || !id_ok(device_id) || key_id == 0 || revision == 0 {
        return Err(Error::Invalid);
    }
    Ok(())
}

fn check_hello(account_id: &str, key_id: u32, device_id: &str) -> Result<(), Error> {
    if !id_ok(account_id) || !id_ok(device_id) || key_id == 0 {
        return Err(Error::Invalid);
    }
    Ok(())
}

/// Seal a connect block under the account keyring of epoch `key_id`.
pub fn seal_connect(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    org_id: &str,
    device_id: &str,
    revision: u64,
    plaintext: &[u8],
) -> Result<String, Error> {
    seal_connect_with(keyring, account_id, key_id, org_id, device_id, revision, plaintext, crate::random())
}

/// [`seal_connect`] with the salt given (test vectors).
#[allow(clippy::too_many_arguments)]
pub fn seal_connect_with(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    org_id: &str,
    device_id: &str,
    revision: u64,
    plaintext: &[u8],
    salt: [u8; SALT_LEN],
) -> Result<String, Error> {
    check_connect(account_id, key_id, org_id, device_id, revision)?;
    Ok(seal_with_aad(keyring, &connect_aad(account_id, key_id, org_id, device_id, revision), plaintext, salt))
}

/// Open a connect block. Fails unless account, epoch, org, device and
/// revision are the ones it was sealed for.
pub fn open_connect(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    org_id: &str,
    device_id: &str,
    revision: u64,
    blob: &str,
) -> Result<Vec<u8>, Error> {
    check_connect(account_id, key_id, org_id, device_id, revision)?;
    open_with_aad(keyring, &connect_aad(account_id, key_id, org_id, device_id, revision), blob)
}

/// Seal a fleet HELLO proof under the account keyring of epoch `key_id`.
pub fn seal_hello_proof(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    device_id: &str,
    plaintext: &[u8],
) -> Result<String, Error> {
    check_hello(account_id, key_id, device_id)?;
    Ok(seal_with_aad(keyring, &hello_proof_aad(account_id, key_id, device_id), plaintext, crate::random()))
}

/// Open a fleet HELLO proof.
pub fn open_hello_proof(
    keyring: &Keyring,
    account_id: &str,
    key_id: u32,
    device_id: &str,
    blob: &str,
) -> Result<Vec<u8>, Error> {
    check_hello(account_id, key_id, device_id)?;
    open_with_aad(keyring, &hello_proof_aad(account_id, key_id, device_id), blob)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{open_descriptor, open_record, seal_descriptor};

    const ACCT: &str = "a1111111-2b3d-4e5f-8a6b-9c0d1e2f3a4b";
    const ORG: &str = "0b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b";
    const DEV: &str = "7e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b";
    const OTHER: &str = "8e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b";

    fn ring() -> Keyring {
        Keyring::from_bytes(&(0u8..64).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn a_connect_block_opens_only_for_its_account_epoch_org_device_revision_and_key() {
        let blob = seal_connect(&ring(), ACCT, 2, ORG, DEV, 5, b"route").unwrap();
        assert_eq!(open_connect(&ring(), ACCT, 2, ORG, DEV, 5, &blob).unwrap(), b"route");
        assert_eq!(open_connect(&ring(), OTHER, 2, ORG, DEV, 5, &blob), Err(Error::Unauthentic));
        assert_eq!(open_connect(&ring(), ACCT, 3, ORG, DEV, 5, &blob), Err(Error::Unauthentic));
        assert_eq!(open_connect(&ring(), ACCT, 2, OTHER, DEV, 5, &blob), Err(Error::Unauthentic));
        assert_eq!(open_connect(&ring(), ACCT, 2, ORG, OTHER, 5, &blob), Err(Error::Unauthentic));
        assert_eq!(open_connect(&ring(), ACCT, 2, ORG, DEV, 4, &blob), Err(Error::Unauthentic));
        assert_eq!(open_connect(&Keyring::generate(), ACCT, 2, ORG, DEV, 5, &blob), Err(Error::Unauthentic));
    }

    #[test]
    fn a_hello_proof_opens_only_for_its_account_epoch_device_and_key() {
        let blob = seal_hello_proof(&ring(), ACCT, 4, DEV, b"proof").unwrap();
        assert_eq!(open_hello_proof(&ring(), ACCT, 4, DEV, &blob).unwrap(), b"proof");
        assert_eq!(open_hello_proof(&ring(), OTHER, 4, DEV, &blob), Err(Error::Unauthentic));
        assert_eq!(open_hello_proof(&ring(), ACCT, 5, DEV, &blob), Err(Error::Unauthentic));
        assert_eq!(open_hello_proof(&ring(), ACCT, 4, OTHER, &blob), Err(Error::Unauthentic));
        assert_eq!(open_hello_proof(&Keyring::generate(), ACCT, 4, DEV, &blob), Err(Error::Unauthentic));
    }

    #[test]
    fn neither_opens_as_the_other_or_as_a_descriptor_or_record() {
        let connect = seal_connect(&ring(), ACCT, 1, ORG, DEV, 1, b"x").unwrap();
        let hello = seal_hello_proof(&ring(), ACCT, 1, DEV, b"x").unwrap();
        assert!(open_hello_proof(&ring(), ACCT, 1, DEV, &connect).is_err());
        assert!(open_connect(&ring(), ACCT, 1, ORG, DEV, 1, &hello).is_err());
        assert!(open_descriptor(&ring(), ORG, 1, DEV, 1, &connect).is_err());
        let desc = seal_descriptor(&ring(), ORG, 1, DEV, 1, b"x").unwrap();
        assert!(open_connect(&ring(), ACCT, 1, ORG, DEV, 1, &desc).is_err());
        let oid = crate::object_id(&ring(), "chat", "c").unwrap();
        assert!(open_record(&ring(), ACCT, 1, "chat", &oid, 1, &hello).is_err());
    }

    /// The same bytes an independent Node implementation makes (the phones' tests hold the same constants).
    #[test]
    fn matches_the_vectors_the_phones_check() {
        let salt: [u8; SALT_LEN] = core::array::from_fn(|i| 255 - i as u8);
        let (acct, org, dev) = ("a1111111-2b3d-4e5f-8a6b-9c0d1e2f3a4b", ORG, DEV);
        assert_eq!(seal_connect_with(&ring(), acct, 2, org, dev, 5, b"route", salt).unwrap(), "Af_-_fz7-vn49_b19PPy8fDv7u3s6-rp6Ofm5eTj4uHgEQi7QXKQ1mE_WqWTbDmKTSL088myJiCOC9GdT_48iwYlsZwvrE0JHmhXPjm1s5YoaPbVg8lUFTep_Nn23n7Zk9ZOavmjJae9_9n43-TQgSzkkt5sfX71i2kp1ZHhEuY7HSscUosbPTFBLkW1ENmOeLUW5CbPRxXaxvJUWgjHajok5oiMWDqzlZMUWROzWD0PxczVIq3I35jWFPc-QW8UMh7dFzfvhwHm2p3m92SQA1XZC8hZD99CcDloPoiVJufH_sqqj8AJIFZxq0XMr0fiZRKmPoaKFCuQ6AY4KFiNInHRuPQYHM4PBetgNDnZoPYe7MEgTLiBW-8C4JGlYNw-4qkHiTZuGTlxmoRACp28QZg");
        let aad = hello_proof_aad(acct, 4, dev);
        assert_eq!(crate::record::seal_with_aad(&ring(), &aad, b"proof", salt), "Af_-_fz7-vn49_b19PPy8fDv7u3s6-rp6Ofm5eTj4uHgEQi7QXCNzHo8WqWTbDmKTSL088myJiCOC9GdT_48iwYlsZwvrE0JHmhXPjm1s5YoaPbVg8lUFTep_Nn23n7Zk9ZOavmjJae9_9n43-TQgSzkkt5sfX71i2kp1ZHhEuY7HSscUosbPTFBLkW1ENmOeLUW5CbPRxXaxvJUWgjHajok5oiMWDqzlZMUWROzWD0PxczVIq3I35jWFPc-QW8UMh7dFzfvhwHm2p3m92SQA1XZC8hZD99CcDloPoiVJufH_sqqj8AJIFZxq0XMr0fiZRKmPoaKFCuQ6AY4KFiNInHRuPQYHM4PBetgNDnZoPYe7MEgTLiBW-8C4JGlYNw-4khm8NKkH7zTvzv1uQekTHQ");
    }

    #[test]
    fn ids_cannot_smuggle_ad_separators() {
        assert_eq!(seal_connect(&ring(), "a\nb", 1, ORG, DEV, 1, b"x"), Err(Error::Invalid));
        assert_eq!(seal_connect(&ring(), ACCT, 0, ORG, DEV, 1, b"x"), Err(Error::Invalid));
        assert_eq!(seal_connect(&ring(), ACCT, 1, ORG, DEV, 0, b"x"), Err(Error::Invalid));
        assert_eq!(seal_hello_proof(&ring(), ACCT, 1, "x\n1", b"x"), Err(Error::Invalid));
        assert_eq!(seal_hello_proof(&ring(), "", 1, DEV, b"x"), Err(Error::Invalid));
        assert_eq!(
            connect_aad(ACCT, 2, ORG, DEV, 3),
            format!("nekko-sync/v1 fleet-connect\n{ACCT}\n2\n{ORG}\n{DEV}\n3")
        );
        assert_eq!(hello_proof_aad(ACCT, 2, DEV), format!("nekko-sync/v1 fleet-hello\n{ACCT}\n2\n{DEV}"));
    }
}
