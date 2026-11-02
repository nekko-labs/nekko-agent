//! IO-33 on the real registry: a paired phone's switches and Change key in
//! `remote.json`, its activity in `remote-activity.json`, and the phone gate
//! reading them through `RemoteService`.

use base64::Engine;
use nekko_remote::hello::Random;
use nekko_remote::phone::{Classes, DeviceAccess};
use nekko_remote::service::{Link, LinkHandle, RemoteService, Verifier};
use nekko_remote::{Activity, Devices, Dispatcher, PhoneCall};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

struct NoLink;
struct NoHandle;

impl Link for NoLink {
    fn connect(&self, _: &str, _: &str, _: &str, _: Verifier) -> Arc<dyn LinkHandle> {
        Arc::new(NoHandle)
    }
}

impl LinkHandle for NoHandle {
    fn stop(&self) {}
    fn kick_device(&self, _: &str) {}
    fn connected_devices(&self) -> Vec<String> {
        Vec::new()
    }
    fn is_online(&self) -> bool {
        false
    }
    fn last_error(&self) -> Option<String> {
        None
    }
}

const NOW: f64 = 1_760_000_000_000.0;

/// A registry with one phone paired before IO-33 (no `access`, no key).
fn registry() -> (tempfile::TempDir, Arc<RemoteService>) {
    let dir = tempfile::tempdir().unwrap();
    let old = json!({
        "enabled": true, "relayUrl": "ws://127.0.0.1:4400", "room": "r", "secret": "s",
        "devices": [{ "id": "phone-1", "name": "iPhone", "platform": "ios", "createdAt": 1, "lastSeenAt": 2 }],
    });
    std::fs::write(dir.path().join("remote.json"), old.to_string()).unwrap();
    let random: Random = Arc::new(|b: &mut [u8]| b.fill(7));
    let svc = RemoteService::new(dir.path(), random, Arc::new(|| NOW), Box::new(NoLink));
    (dir, svc)
}

/// A HELLO from a current phone app, signed with that device's test key for room "r".
fn hello(id: &str, extra: Value) -> Value {
    let k = SigningKey::from_slice(&[id.len() as u8 + 40; 32]).unwrap();
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let sig: Signature = k.sign(nekko_remote::hello::hello_text(id, "r", "c").as_bytes());
    let mut h = json!({
        "type": "hello", "deviceId": id, "protocol": 5, "challenge": "c",
        "helloKey": b64(k.verifying_key().to_encoded_point(false).as_bytes()), "sig": b64(&sig.to_bytes()),
    });
    for (k, v) in extra.as_object().unwrap() {
        h[k] = v.clone();
    }
    h
}

/// The device's HELLO key as if it had enrolled with one.
fn enroll_key(dir: &tempfile::TempDir, id: &str) {
    let key = hello(id, json!({}))["helloKey"].clone();
    let mut keys = serde_json::Map::new();
    keys.insert(id.to_string(), key);
    std::fs::write(dir.path().join("remote-hello-keys.json"), Value::Object(keys).to_string()).unwrap();
}

fn saved(dir: &tempfile::TempDir) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.path().join("remote.json")).unwrap()).unwrap()
}

#[test]
fn a_phone_paired_before_io33_may_read_and_change() {
    let (dir, svc) = registry();
    let d = svc.device("phone-1").unwrap();
    assert_eq!(d.access, DeviceAccess { read: true, change: true });
    assert_eq!(d.key, None);
    // Reading the registry writes nothing new into it.
    assert!(saved(&dir)["devices"][0].get("access").is_none());
    assert!(svc.device("phone-2").is_none());
}

#[test]
fn set_access_saves_both_switches_and_keeps_the_other() {
    let (dir, svc) = registry();
    let devices = svc.route("remote:setAccess", &[json!("phone-1"), json!({ "change": false })]).unwrap();
    assert_eq!(devices[0]["access"], json!({ "read": true, "change": false }));
    assert_eq!(saved(&dir)["devices"][0]["access"], json!({ "read": true, "change": false }));
    svc.route("remote:setAccess", &[json!("phone-1"), json!({ "read": false })]).unwrap();
    assert_eq!(svc.device("phone-1").unwrap().access, DeviceAccess { read: false, change: false });
    // The rest of the record is untouched.
    assert_eq!(saved(&dir)["devices"][0]["name"], "iPhone");
    for bad in [json!({ "change": "no" }), json!({ "files": true }), json!(null)] {
        assert!(svc.route("remote:setAccess", &[json!("phone-1"), bad.clone()]).is_err(), "{bad}");
    }
    assert!(svc.route("remote:setAccess", &[json!("phone-9"), json!({ "read": true })]).is_err());
}

#[test]
fn the_change_key_is_trusted_on_first_use_until_the_phone_pairs_again() {
    let (dir, svc) = registry();
    assert_eq!(svc.register_key("phone-1", "KEY-A"), Ok(true));
    assert_eq!(saved(&dir)["devices"][0]["changeKey"], "KEY-A");
    assert_eq!(saved(&dir)["devices"][0]["changeKeyAt"], json!(NOW as i64));
    assert_eq!(svc.register_key("phone-1", "KEY-A"), Ok(false));
    assert_eq!(svc.register_key("phone-1", "KEY-B"), Err("key-mismatch"));
    assert_eq!(svc.device("phone-1").unwrap().key.as_deref(), Some("KEY-A"));
    // A known phone saying hello again keeps its key and switches.
    svc.route("remote:setAccess", &[json!("phone-1"), json!({ "change": false })]).unwrap();
    enroll_key(&dir, "phone-1");
    let welcome = svc.verify(&hello("phone-1", json!({})));
    assert_eq!(welcome["device"]["changeKey"], "KEY-A");
    assert_eq!(welcome["device"]["access"]["change"], false);
    // Revoked: nothing.
    svc.route("remote:revoke", &[json!("phone-1")]).unwrap();
    assert!(svc.device("phone-1").is_none());
    assert_eq!(svc.register_key("phone-1", "KEY-B"), Err("device-unknown"));
    // Paired again with the owner's fresh code: a new record, no key, everything on.
    let code = svc.pair()["code"].as_str().unwrap().to_string();
    let welcome = svc.verify(&hello("phone-1", json!({ "pair": code, "platform": "ios" })));
    assert_eq!(welcome["type"], "welcome");
    let d = svc.device("phone-1").unwrap();
    assert_eq!((d.access, d.key), (DeviceAccess { read: true, change: true }, None));
    assert_eq!(svc.register_key("phone-1", "KEY-B"), Ok(true));
}

#[test]
fn activity_is_kept_per_device_newest_200_and_rotation_clears_it() {
    // Bound (not `_`) so the folder lives to the end; only Unix reads it back.
    let (_dir, svc) = registry();
    for i in 0..205 {
        let reason = (i % 2 == 1).then(|| "change-off".to_string());
        svc.record("phone-1", Activity { at: i as f64, channel: "file:write".into(), ok: reason.is_none(), reason });
    }
    svc.record("phone-2", Activity { at: 1.0, channel: "git:push".into(), ok: true, reason: None });
    let list = svc.route("remote:activity", &[json!("phone-1")]).unwrap();
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 200);
    assert_eq!(list[0], json!({ "at": 5, "channel": "file:write", "ok": false, "reason": "change-off" }));
    assert_eq!(list[199], json!({ "at": 204, "channel": "file:write", "ok": true }));
    assert_eq!(svc.route("remote:activity", &[json!("phone-2")]).unwrap().as_array().unwrap().len(), 1);
    assert_eq!(svc.route("remote:activity", &[json!("phone-9")]).unwrap(), json!([]));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(_dir.path().join("remote-activity.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "owner only, like remote.json");
    }
    svc.route("remote:rotate", &[]).unwrap();
    assert_eq!(svc.route("remote:activity", &[json!("phone-1")]).unwrap(), json!([]));
}

/// The gate over the real registry: `task:runNow` stands in for a
/// change-class channel until the feature PRs class their own.
#[test]
fn the_gate_reads_the_registry_and_writes_the_activity() {
    let (_dir, svc) = registry();
    let calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = calls.clone();
    let host: Dispatcher = Arc::new(move |channel: String, _args: Value| {
        seen.lock().unwrap().push(channel);
        Box::pin(std::future::ready(Ok(Value::Null)))
    });
    let classes = Classes { change: vec!["task:runNow".into()], ..Classes::default() };
    let gated = nekko_remote::phone::gate_with(host, svc.clone(), classes);
    let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let k = SigningKey::from_slice(&[3u8; 32]).unwrap();
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let sign = |channel: &str, args: &Value, ts: i64| {
        let text = nekko_remote::proof::payload("phone-1", channel, args, ts).unwrap();
        let sig: Signature = k.sign(text.as_bytes());
        json!({ "ts": ts, "sig": b64(&sig.to_bytes()) })
    };
    let ask = |channel: &str, args: Value, proof: Value| {
        rt.block_on(gated(
            PhoneCall { device_id: "phone-1".into(), proof: Some(proof), step_up: None },
            channel.into(),
            args,
        ))
    };
    // First Change: register the key (signed by it), then run.
    let key = json!([b64(k.verifying_key().to_encoded_point(false).as_bytes())]);
    assert_eq!(
        ask("device:registerKey", key.clone(), sign("device:registerKey", &key, NOW as i64)),
        Ok(json!({ "registered": true }))
    );
    let args = json!(["t1"]);
    assert!(ask("task:runNow", args.clone(), sign("task:runNow", &args, NOW as i64)).is_ok());
    // The owner turns Change off on the desktop.
    svc.route("remote:setAccess", &[json!("phone-1"), json!({ "change": false })]).unwrap();
    let err = ask("task:runNow", args.clone(), sign("task:runNow", &args, NOW as i64 + 1)).unwrap_err();
    assert_eq!(err, "Not allowed from a paired phone (change-off): task:runNow");
    assert_eq!(*calls.lock().unwrap(), vec!["task:runNow"]);
    let log = svc.route("remote:activity", &[json!("phone-1")]).unwrap();
    let rows: Vec<(String, bool, Option<String>)> = log
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["channel"].as_str().unwrap().into(), e["ok"] == true, e["reason"].as_str().map(String::from)))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("device:registerKey".into(), true, None),
            ("task:runNow".into(), true, None),
            ("task:runNow".into(), false, Some("change-off".into())),
        ]
    );
    // Revoking stops everything.
    svc.route("remote:revoke", &[json!("phone-1")]).unwrap();
    let err = ask("task:runNow", args.clone(), sign("task:runNow", &args, NOW as i64 + 2)).unwrap_err();
    assert_eq!(err, "Not allowed from a paired phone (device-unknown): task:runNow");
}

/// A link that remembers what the registry asked of it (SK-3).
#[derive(Default)]
struct Recorder {
    said: Arc<Mutex<Vec<String>>>,
}

impl Link for Recorder {
    fn connect(&self, _: &str, _: &str, _: &str, _: Verifier) -> Arc<dyn LinkHandle> {
        self.said.lock().unwrap().push("connect".into());
        Arc::new(Recorder { said: self.said.clone() })
    }
}

impl LinkHandle for Recorder {
    fn stop(&self) {
        self.said.lock().unwrap().push("stop".into());
    }
    fn kick_device(&self, id: &str) {
        self.said.lock().unwrap().push(format!("kick {id}"));
    }
    fn connected_devices(&self) -> Vec<String> {
        vec!["phone-1".into(), "phone-2".into()]
    }
    fn is_online(&self) -> bool {
        true
    }
    fn last_error(&self) -> Option<String> {
        None
    }
}

fn recorded() -> (tempfile::TempDir, Arc<RemoteService>, Arc<Mutex<Vec<String>>>) {
    let (dir, _) = registry();
    let link = Recorder::default();
    let said = link.said.clone();
    let random: Random = Arc::new(|b: &mut [u8]| b.fill(7));
    let svc = RemoteService::new(dir.path(), random, Arc::new(|| NOW), Box::new(link));
    svc.start_if_enabled();
    (dir, svc, said)
}

#[test]
fn signing_out_from_the_phone_revokes_and_kicks_it() {
    let (dir, svc, said) = recorded();
    svc.sign_out("phone-1").unwrap();
    let d = &saved(&dir)["devices"][0];
    assert_eq!(d["revoked"], json!(true));
    assert_eq!(d["signedOutAt"].as_f64(), Some(NOW));
    assert_eq!(*said.lock().unwrap(), ["connect", "kick phone-1"]);
    assert!(svc.device("phone-1").is_none(), "denied as revoked from now on");
}

#[test]
fn stopping_from_the_phone_turns_remote_off_and_says_who() {
    let (dir, svc, said) = recorded();
    svc.stop_remote("phone-1").unwrap();
    assert_eq!(*said.lock().unwrap(), ["connect", "kick phone-1", "kick phone-2", "stop"]);
    let cfg = saved(&dir);
    assert_eq!(cfg["enabled"], json!(false));
    assert_eq!(cfg["stoppedBy"]["deviceId"], "phone-1");
    assert_eq!(cfg["stoppedBy"]["name"], "iPhone");
    assert_eq!(cfg["stoppedBy"]["at"].as_f64(), Some(NOW));
    let status = svc.route("remote:status", &[]).unwrap();
    assert_eq!(status["enabled"], json!(false));
    assert_eq!(status["stoppedBy"]["name"], "iPhone", "the desktop's banner reads it here");
    // The desktop's switch turns it on again, and the banner goes.
    svc.route("remote:enable", &[json!("wss://relay.example")]).unwrap();
    assert!(saved(&dir).get("stoppedBy").is_none());
    assert!(svc.route("remote:status", &[]).unwrap().get("stoppedBy").is_none());
}

#[test]
fn a_pairing_from_before_derived_relay_credentials_is_replaced_at_start() {
    let (dir, svc, said) = recorded();
    let cfg = saved(&dir);
    assert_ne!(cfg["secret"], json!("s"), "a fresh secret");
    assert_ne!(cfg["room"], json!("r"), "a fresh room");
    assert_eq!(cfg["pairing"], json!(2));
    assert_eq!(cfg["devices"][0]["id"], "phone-1", "paired devices are kept");
    assert_eq!(*said.lock().unwrap(), ["connect"]);
    // Once current, a restart keeps it.
    drop(svc);
    let random: Random = Arc::new(|b: &mut [u8]| b.fill(9));
    let again = RemoteService::new(dir.path(), random, Arc::new(|| NOW), Box::new(NoLink));
    again.start_if_enabled();
    assert_eq!(saved(&dir)["secret"], cfg["secret"]);
    assert_eq!(saved(&dir)["room"], cfg["room"]);
}
