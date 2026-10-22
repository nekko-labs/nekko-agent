//! The shared vectors in `golden/sync-crypto.json`, also read by the iPhone's
//! NekkoProtocol tests (`Fixtures/sync-crypto.json`, a copy). Every random
//! input is fixed (the SHA-256 of a seed name), so the file is reproducible:
//! `UPDATE_GOLDEN=1 cargo test -p nekko-sync --test golden` rewrites it, which
//! only a deliberate format change should ever need.

use nekko_sync::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn seed<const N: usize>(name: &str) -> [u8; N] {
    let d = Sha256::digest(name.as_bytes());
    let mut out = [0u8; N];
    out.copy_from_slice(&d[..N]);
    out
}

const ACCOUNT: &str = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

fn vectors() -> Value {
    let keyring = Keyring::from_bytes(&[seed::<32>("enc"), seed::<32>("id")].concat()).unwrap();
    let device = DeviceKey::from_bytes(&seed::<32>("device")).unwrap();
    let eph = DeviceKey::from_bytes(&seed::<32>("ephemeral")).unwrap();
    let research = DeviceKey::from_bytes(&seed::<32>("research")).unwrap();
    let recovery = RecoveryKey::from_bytes(seed("recovery"));

    let ids: Vec<Value> =
        [("chat", "s_1729000000000_abc"), ("chat-part", "s_1729000000000_abc:0"), ("prompt", "日本語のプロンプト")]
            .iter()
            .map(|(c, l)| json!({ "collection": c, "localId": l, "objectId": object_id(&keyring, c, l).unwrap() }))
            .collect();

    let oid = object_id(&keyring, "chat", "s_1729000000000_abc").unwrap();
    let records: Vec<Value> = [
        ("", 1u64, "salt-empty"),
        (r#"{"title":"Plan the trip","messages":[{"role":"user","text":"Kyoto in November?"}]}"#, 1, "salt-a"),
        (r#"{"title":"Plan the trip","deleted":true}"#, 2, "salt-b"),
    ]
    .iter()
    .map(|(text, rev, s)| {
        let salt: [u8; 32] = seed(s);
        let blob = seal_record_with(&keyring, ACCOUNT, 1, "chat", &oid, *rev, text.as_bytes(), salt).unwrap();
        json!({ "collection": "chat", "objectId": oid, "revision": rev, "keyId": 1, "plaintext": text, "salt": b64_encode(&salt), "aad": record_aad(ACCOUNT, 1, "chat", &oid, *rev), "blob": blob })
    })
    .collect();
    // A long one crosses several pad sizes.
    let long = "猫".repeat(700);
    let long_blob =
        seal_record_with(&keyring, ACCOUNT, 2, "chat-part", &oid, 7, long.as_bytes(), seed("salt-long")).unwrap();

    let device_id = "dev_7f3a";
    let wrap = wrap_keyring_with(&keyring, ACCOUNT, 1, device_id, &device.public(), &eph).unwrap();
    let recovery_blob = seal_recovery_with(&recovery, &keyring, ACCOUNT, 1, seed("salt-recovery"));
    let donation = seal_donation_with(
        &research.public(),
        br#"{"kind":"chat","messages":[{"role":"user","text":"[redacted email] asked about Kyoto"}]}"#,
        seed("donation-id"),
        seed("delete-token"),
        &eph,
    )
    .unwrap();

    let pads: Vec<Value> = [0usize, 1, 2, 3, 255, 256, 257, 1000, 1025, 4097, 65537, 1_000_000]
        .iter()
        .map(|n| json!([n, padme(*n)]))
        .collect();
    json!({
        "account": ACCOUNT,
        "keyring": b64_encode(&keyring.to_bytes()),
        "objectIds": ids,
        "records": records,
        "longRecord": { "collection": "chat-part", "objectId": oid, "revision": 7, "keyId": 2, "plaintext": long, "salt": b64_encode(&seed::<32>("salt-long")), "blob": long_blob },
        "padme": pads,
        "device": { "id": device_id, "private": b64_encode(&device.to_bytes()), "public": b64_encode(&device.public()), "fingerprint": fingerprint(&device.public()) },
        "ephemeral": { "private": b64_encode(&eph.to_bytes()), "public": b64_encode(&eph.public()) },
        "wrap": { "keyId": 1, "blob": wrap },
        "recovery": { "key": b64_encode(&seed::<32>("recovery")), "text": recovery.to_text(), "keyId": 1, "salt": b64_encode(&seed::<32>("salt-recovery")), "blob": recovery_blob },
        "donation": {
            "researchPrivate": b64_encode(&research.to_bytes()),
            "researchPublic": b64_encode(&research.public()),
            "payload": r#"{"kind":"chat","messages":[{"role":"user","text":"[redacted email] asked about Kyoto"}]}"#,
            "id": donation.id, "deleteToken": donation.delete_token, "deleteHash": donation.delete_hash, "blob": donation.blob,
        },
    })
}

#[test]
fn vectors_match_the_shared_file() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/sync-crypto.json");
    let got = vectors();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(got, want, "the sync format changed; see the doc comment");
    let ios = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/ios/Protocol/Tests/NekkoProtocolTests/Fixtures/sync-crypto.json"
    );
    let ios: Value = serde_json::from_str(&std::fs::read_to_string(ios).unwrap()).unwrap();
    assert_eq!(ios, want, "the iPhone's copy of the vectors is stale");
}

#[test]
fn every_vector_opens() {
    let v = vectors();
    let keyring = Keyring::from_bytes(&b64_decode(v["keyring"].as_str().unwrap()).unwrap()).unwrap();
    for r in v["records"].as_array().unwrap().iter().chain([&v["longRecord"]]) {
        let (c, o, rev, kid) = (
            r["collection"].as_str().unwrap(),
            r["objectId"].as_str().unwrap(),
            r["revision"].as_u64().unwrap(),
            r["keyId"].as_u64().unwrap() as u32,
        );
        let opened = open_record(&keyring, ACCOUNT, kid, c, o, rev, r["blob"].as_str().unwrap()).unwrap();
        assert_eq!(String::from_utf8(opened).unwrap(), r["plaintext"].as_str().unwrap());
    }
    let device = DeviceKey::from_bytes(&b64_decode(v["device"]["private"].as_str().unwrap()).unwrap()).unwrap();
    let k = unwrap_keyring(&device, ACCOUNT, 1, "dev_7f3a", v["wrap"]["blob"].as_str().unwrap()).unwrap();
    assert_eq!(k.to_bytes(), keyring.to_bytes());
    let rk = RecoveryKey::parse(v["recovery"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        open_recovery(&rk, ACCOUNT, 1, v["recovery"]["blob"].as_str().unwrap()).unwrap().to_bytes(),
        keyring.to_bytes()
    );
    let research =
        DeviceKey::from_bytes(&b64_decode(v["donation"]["researchPrivate"].as_str().unwrap()).unwrap()).unwrap();
    let ctx = format!("nekko-donation/v1\n{}", v["donation"]["id"].as_str().unwrap());
    let framed = open_sealed(&research, &ctx, v["donation"]["blob"].as_str().unwrap()).unwrap();
    assert_eq!(unframe(&framed).unwrap(), v["donation"]["payload"].as_str().unwrap().as_bytes());
}
