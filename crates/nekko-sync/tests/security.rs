//! What the server (or anyone holding the database) can and can't do.

use nekko_sync::*;

const A: &str = "acct-a";

fn sealed() -> (Keyring, String, String) {
    let k = Keyring::generate();
    let oid = object_id(&k, "chat", "s_1").unwrap();
    let blob = seal_record(&k, A, 1, "chat", &oid, 3, b"{\"title\":\"secret\"}").unwrap();
    (k, oid, blob)
}

#[test]
fn a_record_opens_only_under_the_fields_it_was_sealed_with() {
    let (k, oid, blob) = sealed();
    assert_eq!(open_record(&k, A, 1, "chat", &oid, 3, &blob).unwrap(), b"{\"title\":\"secret\"}");
    let other = object_id(&k, "chat", "s_2").unwrap();
    // Relabelled by the server: another revision (rollback), object, collection, epoch or account.
    assert_eq!(open_record(&k, A, 1, "chat", &oid, 2, &blob), Err(Error::Unauthentic));
    assert_eq!(open_record(&k, A, 1, "chat", &other, 3, &blob), Err(Error::Unauthentic));
    assert_eq!(open_record(&k, A, 1, "prompt", &oid, 3, &blob), Err(Error::Unauthentic));
    assert_eq!(open_record(&k, A, 2, "chat", &oid, 3, &blob), Err(Error::Unauthentic));
    assert_eq!(open_record(&k, "acct-b", 1, "chat", &oid, 3, &blob), Err(Error::Unauthentic));
    // Another account's key.
    assert_eq!(open_record(&Keyring::generate(), A, 1, "chat", &oid, 3, &blob), Err(Error::Unauthentic));
}

#[test]
fn any_flipped_bit_is_caught() {
    let (k, oid, blob) = sealed();
    let raw = b64_decode(&blob).unwrap();
    for i in 0..raw.len() {
        let mut bad = raw.clone();
        bad[i] ^= 0x01;
        let r = open_record(&k, A, 1, "chat", &oid, 3, &b64_encode(&bad));
        assert!(r.is_err(), "byte {i}");
    }
    assert_eq!(
        open_record(&k, A, 1, "chat", &oid, 3, &b64_encode(&raw[..raw.len() - 1])).unwrap_err(),
        Error::Unauthentic
    );
    assert_eq!(open_record(&k, A, 1, "chat", &oid, 3, "AQ"), Err(Error::Malformed));
}

#[test]
fn sealing_twice_never_repeats_ciphertext_and_sizes_are_padded() {
    let k = Keyring::generate();
    let oid = object_id(&k, "chat", "s_1").unwrap();
    let a = seal_record(&k, A, 1, "chat", &oid, 1, b"same").unwrap();
    let b = seal_record(&k, A, 1, "chat", &oid, 1, b"same").unwrap();
    assert_ne!(a, b);
    let short = seal_record(&k, A, 1, "chat", &oid, 1, b"x").unwrap();
    let longer = seal_record(&k, A, 1, "chat", &oid, 1, &[b'x'; 200]).unwrap();
    assert_eq!(short.len(), longer.len(), "short records all look alike");
}

#[test]
fn object_ids_are_stable_per_account_and_opaque() {
    let k = Keyring::generate();
    let a = object_id(&k, "chat", "s_1").unwrap();
    assert_eq!(a, object_id(&k.clone(), "chat", "s_1").unwrap());
    assert_eq!(a, object_id(&k.rotate(), "chat", "s_1").unwrap(), "rotation keeps ids");
    assert_ne!(a, object_id(&Keyring::generate(), "chat", "s_1").unwrap());
    assert_ne!(a, object_id(&k, "prompt", "s_1").unwrap());
    assert!(!a.contains("s_1"));
    assert_eq!(object_id(&k, "Chat", "s_1"), Err(Error::Invalid));
    assert_eq!(object_id(&k, "chat", ""), Err(Error::Invalid));
}

#[test]
fn a_rotated_keyring_locks_out_the_old_one() {
    let k1 = Keyring::generate();
    let k2 = k1.rotate();
    let oid = object_id(&k2, "chat", "s_1").unwrap();
    let blob = seal_record(&k2, A, 2, "chat", &oid, 9, b"after revocation").unwrap();
    assert_eq!(open_record(&k1, A, 2, "chat", &oid, 9, &blob), Err(Error::Unauthentic));
}

#[test]
fn a_wrap_opens_only_for_its_device_account_epoch_and_sender() {
    let k = Keyring::generate();
    let phone = DeviceKey::generate();
    let laptop = DeviceKey::generate();
    let mac = DeviceKey::generate();
    let (pp, lp, mp) = (phone.public(), laptop.public(), mac.public());
    let to_phone = || Recipient { id: "dev-phone", public: &pp };
    let w = wrap_keyring(&k, A, 1, to_phone(), "dev-mac", &mac).unwrap();
    assert_eq!(unwrap_keyring(&phone, A, 1, "dev-phone", "dev-mac", &mp, &w).unwrap().to_bytes(), k.to_bytes());
    // The server hands the phone's wrap to a device of its own choosing, or relabels it.
    assert!(unwrap_keyring(&laptop, A, 1, "dev-phone", "dev-mac", &mp, &w).is_err());
    assert!(unwrap_keyring(&phone, A, 1, "dev-laptop", "dev-mac", &mp, &w).is_err());
    assert!(unwrap_keyring(&phone, A, 2, "dev-phone", "dev-mac", &mp, &w).is_err());
    assert!(unwrap_keyring(&phone, "acct-b", 1, "dev-phone", "dev-mac", &mp, &w).is_err());
    // It opens only as coming from the device that made it.
    assert!(unwrap_keyring(&phone, A, 1, "dev-phone", "dev-laptop", &lp, &w).is_err());
    assert!(unwrap_keyring(&phone, A, 1, "dev-phone", "dev-laptop", &mp, &w).is_err());
    // Anyone who knows the phone's public key (the server) can't make a wrap that opens as the Mac's.
    let attacker = DeviceKey::generate();
    let forged = wrap_keyring(&Keyring::generate(), A, 1, to_phone(), "dev-mac", &attacker).unwrap();
    assert!(unwrap_keyring(&phone, A, 1, "dev-phone", "dev-mac", &mp, &forged).is_err());
    // Bad public keys are refused rather than wrapped to.
    let bad = [4u8; 65];
    assert_eq!(wrap_keyring(&k, A, 1, Recipient { id: "d", public: &bad }, "s", &mac).unwrap_err(), Error::Invalid);
    assert_eq!(
        wrap_keyring(&k, A, 1, Recipient { id: "d", public: &pp[..64] }, "s", &mac).unwrap_err(),
        Error::Invalid
    );
    assert_eq!(unwrap_keyring(&phone, A, 1, "dev-phone", "s", &bad, &w).unwrap_err(), Error::Invalid);
}

#[test]
fn a_join_code_checks_both_sides() {
    let k = Keyring::generate();
    let new = DeviceKey::generate();
    let np = new.public();
    let code = JoinCode::generate();
    let text = code.to_text();
    assert_eq!(text.len(), 16 + 3);
    let typed = JoinCode::parse(&text.to_lowercase().replace('-', " ").replace('0', "o")).unwrap();
    // The approver checks the key the server shows against the tag the new device published.
    let tag = code.tag(A, &np);
    assert!(typed.verifies(A, &np, &tag));
    let swapped = DeviceKey::generate().public();
    assert!(!typed.verifies(A, &swapped, &tag), "a key the server swapped in fails");
    assert!(!typed.verifies("acct-b", &np, &tag));
    assert!(!JoinCode::generate().verifies(A, &np, &tag), "a wrong code fails");
    assert!(!typed.verifies(A, &np, &tag[..31]));
    // The new device opens only a wrap made with its code.
    let w = wrap_for_join(&k, A, 4, Recipient { id: "dev-new", public: &np }, &typed).unwrap();
    assert_eq!(unwrap_join(&new, A, 4, "dev-new", &code, &w).unwrap().to_bytes(), k.to_bytes());
    assert!(unwrap_join(&new, A, 4, "dev-new", &JoinCode::generate(), &w).is_err());
    assert!(unwrap_join(&new, A, 3, "dev-new", &code, &w).is_err());
    assert!(unwrap_join(&new, A, 4, "dev-other", &code, &w).is_err());
    // A keyring from anyone without the code doesn't open, even sealed to the right key.
    let forged =
        seal_to(&np, &format!("{VERSION} join-wrap\n{A}\n4\ndev-new"), &Keyring::generate().to_bytes()).unwrap();
    assert!(unwrap_join(&new, A, 4, "dev-new", &code, &forged).is_err());
    // Parsing: the wrong length or a non-ASCII character is refused.
    assert_eq!(JoinCode::parse(&text[..15]).unwrap_err(), Error::Malformed);
    assert_eq!(JoinCode::parse(&format!("{text}0")).unwrap_err(), Error::Malformed);
    assert_eq!(
        JoinCode::parse(&text.replacen(|c: char| c.is_ascii_alphanumeric(), "ß", 1)).unwrap_err(),
        Error::Malformed
    );
}

#[test]
fn recovery_keys_round_trip_and_catch_typos() {
    let k = Keyring::generate();
    let rk = RecoveryKey::generate();
    let text = rk.to_text();
    assert_eq!(text.len(), 55 + 10);
    assert_eq!(text.split('-').count(), 11);
    let blob = seal_recovery(&rk.public_key(), &k, A, 1).unwrap();
    let typed = text.to_lowercase().replace('-', " ").replace('0', "o").replace('1', "l");
    assert_eq!(open_recovery(&RecoveryKey::parse(&typed).unwrap(), A, 1, &blob).unwrap().to_bytes(), k.to_bytes());
    // One wrong character.
    let mut chars: Vec<char> = text.chars().collect();
    chars[3] = if chars[3] == 'A' { 'B' } else { 'A' };
    let typo: String = chars.into_iter().collect();
    assert!(matches!(RecoveryKey::parse(&typo), Err(Error::Checksum | Error::Malformed)));
    assert_eq!(RecoveryKey::parse(&text[..60]).unwrap_err(), Error::Malformed);
    assert_eq!(RecoveryKey::parse(&format!("{text}0")).unwrap_err(), Error::Malformed);
    assert!(open_recovery(&RecoveryKey::generate(), A, 1, &blob).is_err());
    assert!(open_recovery(&rk, A, 2, &blob).is_err());
    // The public half is stable and opens nothing by itself; a rotated epoch seals to it too.
    assert_eq!(rk.public_key(), RecoveryKey::parse(&text).unwrap().public_key());
    let k2 = k.rotate();
    let blob2 = seal_recovery(&rk.public_key(), &k2, A, 2).unwrap();
    assert_eq!(open_recovery(&rk, A, 2, &blob2).unwrap().to_bytes(), k2.to_bytes());
}

#[test]
fn donations_open_only_with_the_research_key() {
    let research = DeviceKey::generate();
    let d = seal_donation(&research.public(), b"{\"kind\":\"chat\"}").unwrap();
    let ctx = format!("{DONATION_VERSION}\n{}", d.id);
    assert_eq!(unframe(&open_sealed(&research, &ctx, &d.blob).unwrap()).unwrap(), b"{\"kind\":\"chat\"}");
    assert!(open_sealed(&DeviceKey::generate(), &ctx, &d.blob).is_err());
    assert!(open_sealed(&research, &format!("{DONATION_VERSION}\nother"), &d.blob).is_err());
    assert_ne!(d.delete_hash, d.delete_token);
}

#[test]
fn fingerprints_are_short_and_distinct() {
    let a = fingerprint(&DeviceKey::generate().public());
    assert_eq!(a.len(), 19);
    assert_ne!(a, fingerprint(&DeviceKey::generate().public()));
}
