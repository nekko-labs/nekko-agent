//! Decision 0116: one computer reachable through Nekko Cloud Relay and
//! directly (Tailscale, the LAN, the owner's relay) at once, and each paired
//! device limited to one route or allowed both.

use base64::Engine;
use nekko_remote::hello::Random;
use nekko_remote::route::CLOUD_RELAY_URL;
use nekko_remote::service::{Link, LinkHandle, RemoteService, Verifier};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const NOW: f64 = 1_760_000_000_000.0;
const TAILNET: &str = "ws://gomi.tail1234.ts.net:4400";

/// One agent per relay; remembers each relay's verifier, and who is connected on it.
#[derive(Default, Clone)]
struct Fake {
    links: Arc<Mutex<Vec<(String, Verifier)>>>,
    said: Arc<Mutex<Vec<String>>>,
    connected: Arc<Mutex<Vec<(String, String)>>>,
}

struct Handle {
    url: String,
    fake: Fake,
}

impl Link for Fake {
    fn connect(&self, url: &str, _: &str, _: &str, _: nekko_remote::client::SigningKey, verify: Verifier) -> Arc<dyn LinkHandle> {
        self.links.lock().unwrap().push((url.to_string(), verify));
        self.said.lock().unwrap().push(format!("connect {url}"));
        Arc::new(Handle { url: url.to_string(), fake: self.clone() })
    }
}

impl LinkHandle for Handle {
    fn stop(&self) {
        self.fake.said.lock().unwrap().push(format!("stop {}", self.url));
    }
    fn kick_device(&self, id: &str) {
        self.fake.said.lock().unwrap().push(format!("kick {id} on {}", self.url));
    }
    fn disconnect_device(&self, id: &str) {
        self.fake.said.lock().unwrap().push(format!("disconnect {id} on {}", self.url));
    }
    fn connected_devices(&self) -> Vec<String> {
        self.fake.connected.lock().unwrap().iter().filter(|(u, _)| *u == self.url).map(|(_, d)| d.clone()).collect()
    }
    fn is_online(&self) -> bool {
        !self.url.contains("down")
    }
    fn last_error(&self) -> Option<String> {
        self.url.contains("down").then(|| "relay disconnected (code 1006)".into())
    }
}

fn hello(id: &str, extra: Value) -> Value {
    let k = SigningKey::from_slice(&[id.len() as u8 + 40; 32]).unwrap();
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let sig: Signature = k.sign(nekko_remote::hello::hello_text(id, "r", "c", "h", "d").as_bytes());
    let mut h = json!({
        "type": "hello", "deviceId": id, "protocol": 6, "challenge": "c", "hostEph": "h", "clientEph": "d",
        "helloKey": b64(k.verifying_key().to_encoded_point(false).as_bytes()), "sig": b64(&sig.to_bytes()),
    });
    for (k, v) in extra.as_object().unwrap() {
        h[k] = v.clone();
    }
    h
}

/// A computer on Tailscale with one phone paired before routes existed (its HELLO key known).
fn computer(also: Value) -> (tempfile::TempDir, Arc<RemoteService>, Fake) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = json!({
        "enabled": true, "relayUrl": TAILNET, "alsoRelays": also, "room": "r", "secret": "s", "pairing": 3,
        "hostKey": nekko_remote::proof::key_text(&nekko_remote::proof::new_key(&(Arc::new(|b: &mut [u8]| b.fill(9)) as Random))),
        "devices": [{ "id": "phone-1", "name": "iPhone", "platform": "ios", "createdAt": 1, "lastSeenAt": 2 }],
    });
    std::fs::write(dir.path().join("remote.json"), cfg.to_string()).unwrap();
    let mut keys = serde_json::Map::new();
    keys.insert("phone-1".into(), hello("phone-1", json!({}))["helloKey"].clone());
    std::fs::write(dir.path().join("remote-hello-keys.json"), Value::Object(keys).to_string()).unwrap();
    let fake = Fake::default();
    let random: Random = Arc::new(|b: &mut [u8]| b.fill(7));
    let svc = RemoteService::new(dir.path(), random, Arc::new(|| NOW), Box::new(fake.clone()));
    svc.start_if_enabled();
    (dir, svc, fake)
}

fn verify_on(fake: &Fake, url: &str, h: &Value) -> Value {
    let v = fake.links.lock().unwrap().iter().find(|(u, _)| u == url).map(|(_, v)| v.clone()).expect("a link to that relay");
    v(h)
}

fn saved(dir: &tempfile::TempDir) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.path().join("remote.json")).unwrap()).unwrap()
}

#[test]
fn one_relay_is_one_agent_as_before() {
    let (_dir, svc, fake) = computer(Value::Null);
    assert_eq!(*fake.said.lock().unwrap(), [format!("connect {TAILNET}")]);
    let status = svc.route("remote:status", &[]).unwrap();
    assert!(status.get("relays").is_none(), "the status keeps its old shape");
    assert!(status.get("alsoRelays").is_none());
}

#[test]
fn a_computer_is_reachable_through_every_relay_at_once() {
    let (dir, svc, fake) = computer(json!([CLOUD_RELAY_URL]));
    assert_eq!(*fake.said.lock().unwrap(), [format!("connect {TAILNET}"), format!("connect {CLOUD_RELAY_URL}")]);
    let status = svc.route("remote:status", &[]).unwrap();
    assert_eq!(status["online"], json!(true));
    assert_eq!(status["relays"], json!([
        { "url": TAILNET, "via": "direct", "online": true, "error": null },
        { "url": CLOUD_RELAY_URL, "via": "cloud", "online": true, "error": null },
    ]));
    // An old phone comes in either way.
    for url in [TAILNET, CLOUD_RELAY_URL] {
        assert_eq!(verify_on(&fake, url, &hello("phone-1", json!({})))["type"], "welcome", "{url}");
    }
    // Turning the extra route off reconnects through the main one only.
    fake.said.lock().unwrap().clear();
    svc.route("remote:setRelays", &[json!([])]).unwrap();
    assert_eq!(*fake.said.lock().unwrap(), [format!("stop {TAILNET}"), format!("stop {CLOUD_RELAY_URL}"), format!("connect {TAILNET}")]);
    assert!(saved(&dir).get("alsoRelays").is_none());
}

#[test]
fn set_relays_holds_each_relay_to_the_transport_rule() {
    let (dir, svc, _) = computer(Value::Null);
    assert!(svc.route("remote:setRelays", &[json!(["ws://relay.example.com"])]).unwrap_err().contains("not encrypted"));
    assert!(svc.route("remote:setRelays", &[json!("wss://a")]).is_err());
    let four = json!(["wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example"]);
    assert!(svc.route("remote:setRelays", &[four]).is_err());
    let status = svc.route("remote:setRelays", &[json!([format!("{CLOUD_RELAY_URL}/"), CLOUD_RELAY_URL])]).unwrap();
    assert_eq!(saved(&dir)["alsoRelays"], json!([CLOUD_RELAY_URL]), "trimmed and kept once");
    assert_eq!(status["alsoRelays"], json!([CLOUD_RELAY_URL]));
}

#[test]
fn a_route_that_is_down_does_not_take_the_computer_offline() {
    let (_dir, svc, _) = computer(json!(["wss://down.example"]));
    let status = svc.route("remote:status", &[]).unwrap();
    assert_eq!(status["online"], json!(true));
    assert_eq!(status["relays"][1]["error"], "relay disconnected (code 1006)");
}

#[test]
fn a_device_limited_to_one_route_is_turned_away_on_the_other() {
    let (dir, svc, fake) = computer(json!([CLOUD_RELAY_URL]));
    svc.route("remote:setRoute", &[json!("phone-1"), json!("cloud")]).unwrap();
    assert_eq!(saved(&dir)["devices"][0]["route"], "cloud");
    assert_eq!(verify_on(&fake, TAILNET, &hello("phone-1", json!({}))), json!({ "type": "denied", "reason": "route" }));
    assert_eq!(verify_on(&fake, CLOUD_RELAY_URL, &hello("phone-1", json!({})))["type"], "welcome");

    svc.route("remote:setRoute", &[json!("phone-1"), json!("direct")]).unwrap();
    assert_eq!(verify_on(&fake, CLOUD_RELAY_URL, &hello("phone-1", json!({}))), json!({ "type": "denied", "reason": "route" }));
    assert_eq!(verify_on(&fake, TAILNET, &hello("phone-1", json!({})))["type"], "welcome");

    svc.route("remote:setRoute", &[json!("phone-1"), json!("auto")]).unwrap();
    assert!(saved(&dir)["devices"][0].get("route").is_none(), "auto is the absence of a choice");
    assert!(svc.route("remote:setRoute", &[json!("phone-1"), json!("satellite")]).is_err());
    assert!(svc.route("remote:setRoute", &[json!("phone-9"), json!("cloud")]).is_err());
}

#[test]
fn a_device_cannot_claim_its_own_route() {
    let (_dir, svc, fake) = computer(json!([CLOUD_RELAY_URL]));
    svc.route("remote:setRoute", &[json!("phone-1"), json!("cloud")]).unwrap();
    // The relay says how it came in, over what the HELLO says.
    let forged = hello("phone-1", json!({ "via": "cloud" }));
    assert_eq!(verify_on(&fake, TAILNET, &forged)["reason"], "route");
}

#[test]
fn changing_a_route_closes_a_live_connection_on_the_old_one() {
    let (_dir, svc, fake) = computer(json!([CLOUD_RELAY_URL]));
    fake.connected.lock().unwrap().push((TAILNET.to_string(), "phone-1".into()));
    fake.said.lock().unwrap().clear();
    svc.route("remote:setRoute", &[json!("phone-1"), json!("direct")]).unwrap();
    assert!(fake.said.lock().unwrap().is_empty(), "already on an allowed route");
    svc.route("remote:setRoute", &[json!("phone-1"), json!("cloud")]).unwrap();
    // Every route's agent is told; the device's other sockets were none.
    assert_eq!(*fake.said.lock().unwrap(), [format!("disconnect phone-1 on {TAILNET}"), format!("disconnect phone-1 on {CLOUD_RELAY_URL}")]);
}

#[test]
fn a_code_minted_for_one_route_pairs_a_device_to_that_route() {
    let (dir, svc, fake) = computer(json!([CLOUD_RELAY_URL]));
    let grant = svc.route("remote:pair", &[Value::Null, json!({ "route": "cloud" })]).unwrap();
    let code = grant["code"].as_str().unwrap().to_string();
    let new = hello("phone-22", json!({ "pair": code, "platform": "android", "name": "Pixel" }));
    // Its code is no good on the other route...
    assert_eq!(verify_on(&fake, TAILNET, &new)["reason"], "route");
    // ...and on the one it was made for, the device keeps that route.
    assert_eq!(verify_on(&fake, CLOUD_RELAY_URL, &new)["type"], "welcome");
    let d = saved(&dir)["devices"].as_array().unwrap().iter().find(|d| d["id"] == "phone-22").cloned().unwrap();
    assert_eq!(d["route"], "cloud");
    assert!(svc.route("remote:pair", &[Value::Null, json!({ "route": "moon" })]).is_err());
    // A code with no route is the old code: either way.
    assert!(svc.route("remote:pair", &[Value::Null, json!({ "route": "auto" })]).unwrap()["code"].is_string());
    assert!(svc.route("remote:pair", &[]).unwrap()["code"].is_string());
}
