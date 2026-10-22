//! A malicious Nekko Cloud: devices talk to the real API (the local dev stack)
//! through a proxy that rewrites its answers, the way a compromised server
//! could. Each test is one attack from the internal review
//! (`reports/crypto-review-internal-2026-10-22.md`); the device must refuse it.
//! Skipped unless `NEKKO_CLOUD_ITEST_URL` is set (see `tests/live.rs`).

use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::response::Response;
use nekko_cloud::vault::FileVault;
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use nekko_sync::{DeviceKey, Keyring, Recipient, b64_decode, b64_encode, object_id, seal_record, wrap_keyring};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const CODE: &str = "123456";

/// `(method, path, status, body)`: change the answer in place.
type Rewrite = Box<dyn FnMut(&str, &str, &mut u16, &mut Value) + Send>;

#[derive(Clone)]
struct Proxy {
    url: String,
    rewrite: Arc<Mutex<Option<Rewrite>>>,
}

impl Proxy {
    fn set(&self, f: impl FnMut(&str, &str, &mut u16, &mut Value) + Send + 'static) {
        *self.rewrite.lock().unwrap() = Some(Box::new(f));
    }

    fn clear(&self) {
        *self.rewrite.lock().unwrap() = None;
    }
}

async fn proxy(upstream: String) -> Proxy {
    let rewrite: Arc<Mutex<Option<Rewrite>>> = Arc::new(Mutex::new(None));
    let r = rewrite.clone();
    let http = reqwest::Client::new();
    let app = axum::Router::new().fallback(move |req: Request| {
        let (r, http, upstream) = (r.clone(), http.clone(), upstream.clone());
        async move {
            let method = req.method().clone();
            let path = req.uri().path_and_query().map(|p| p.to_string()).unwrap_or_default();
            let auth = req.headers().get("authorization").cloned();
            let body = to_bytes(req.into_body(), 16 << 20).await.unwrap();
            let mut out = http.request(method.clone(), format!("{upstream}{path}")).body(body.to_vec());
            if let Some(a) = auth {
                out = out.header("authorization", a);
            }
            if !body.is_empty() {
                out = out.header("content-type", "application/json");
            }
            let res = out.send().await.unwrap();
            let mut status = res.status().as_u16();
            let text = res.text().await.unwrap();
            let mut v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let bare = path.split('?').next().unwrap_or("").to_string();
            if let Some(f) = r.lock().unwrap().as_mut() {
                f(method.as_str(), &bare, &mut status, &mut v);
            }
            let text = if v.is_null() { text } else { v.to_string() };
            Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(Body::from(text))
                .unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Proxy { url, rewrite }
}

struct Device {
    cloud: Arc<Cloud>,
    store: Arc<SessionStore>,
    dir: tempfile::TempDir,
}

fn device(url: &str, label: &str) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SessionStore::new(dir.path()));
    let cloud = Cloud::new(Options {
        dir: dir.path().join("cloud"),
        api_url: url.into(),
        device_label: label.into(),
        sessions: store.clone(),
        vault: Box::new(FileVault::new(dir.path().join("cloud").join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    Device { cloud, store, dir }
}

impl Device {
    fn secret(&self, name: &str) -> Option<String> {
        let all: Value =
            serde_json::from_str(&std::fs::read_to_string(self.dir.path().join("cloud/secrets.json")).ok()?).ok()?;
        all[name].as_str().map(String::from)
    }

    fn keyring(&self, epoch: u32) -> Keyring {
        Keyring::from_bytes(&b64_decode(&self.secret(&format!("keyring:{epoch}")).unwrap()).unwrap()).unwrap()
    }

    fn epoch(&self) -> u64 {
        self.cloud.status()["sync"]["keyEpoch"].as_u64().unwrap_or(0)
    }
}

async fn call(d: &Device, channel: &str, args: Value) -> Result<Value, String> {
    d.cloud.route(channel, args.as_array().unwrap()).await
}

async fn sign_in(d: &Device, email: &str) {
    call(d, "cloud:sendCode", json!([email])).await.unwrap();
    let s = call(d, "cloud:verifyCode", json!([email, CODE])).await.unwrap();
    // Fixed messages only: the status can hold the join code, so it is never printed.
    assert!(s["signedIn"] == true, "sign-in didn't finish");
}

fn chat(id: &str, text: &str, updated: f64) -> Value {
    json!({ "id": id, "title": "Chat", "messages": [{ "role": "user", "content": text }], "createdAt": 1.0, "updatedAt": updated })
}

fn content(d: &Device, id: &str) -> String {
    d.store.get(id).map(|c| c["messages"][0]["content"].as_str().unwrap_or("").to_string()).unwrap_or_default()
}

/// An account with A syncing (directly) and B restored with the recovery key through the proxy.
async fn account(url: &str, p: &Proxy) -> (Device, Device, String, String) {
    let email = format!("attack-{}-{}@example.com", std::process::id(), b64_encode(&rand_bytes()));
    let a = device(url, "Desk");
    sign_in(&a, &email).await;
    let recovery = call(&a, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    let b = device(&p.url, "Laptop");
    sign_in(&b, &email).await;
    call(&b, "sync:restore", json!([recovery])).await.unwrap();
    (a, b, email, recovery)
}

fn rand_bytes() -> [u8; 6] {
    let mut out = [0u8; 6];
    getrandom::fill(&mut out).unwrap();
    out
}

fn itest_url() -> Option<String> {
    let url = std::env::var("NEKKO_CLOUD_ITEST_URL").ok();
    if url.is_none() {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
    }
    url
}

/// C1: a keyring sealed to a device by anyone else (whoever can sign in, or the server) is refused.
#[tokio::test]
async fn a_keyring_from_an_untrusted_device_is_refused() {
    let Some(url) = itest_url() else { return };
    let p = proxy(url.clone()).await;
    let (a, b, _, _) = account(&url, &p).await;
    a.store.put_synced(&chat("s_1_aaa", "before", 10.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    call(&b, "sync:now", json!([])).await.unwrap();

    // The server announces epoch 2 and hands B a keyring it made, wrapped "from A" with its own key.
    let state = call(&b, "cloud:refresh", json!([])).await.unwrap();
    let me = state["sync"]["devices"].as_array().unwrap().iter().find(|d| d["thisDevice"] == true).unwrap().clone();
    let a_id = state["sync"]["devices"].as_array().unwrap().iter().find(|d| d["label"] == "Desk").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b_id = me["id"].as_str().unwrap().to_string();
    let b_pub = {
        let raw: Value = reqwest::Client::new()
            .get(format!("{url}/v1/sync/state"))
            .bearer_auth(b.secret("token").unwrap())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let acct = raw["account"].as_str().unwrap().to_string();
        let pk = raw["devices"].as_array().unwrap().iter().find(|d| d["id"] == b_id.as_str()).unwrap()["publicKey"]
            .as_str()
            .unwrap()
            .to_string();
        (acct, b64_decode(&pk).unwrap())
    };
    let attacker = DeviceKey::generate();
    let forged =
        wrap_keyring(&Keyring::generate(), &b_pub.0, 2, Recipient { id: &b_id, public: &b_pub.1 }, &a_id, &attacker)
            .unwrap();
    p.set(move |_, path, status, body| {
        if path == "/v1/sync/state" {
            body["currentKeyId"] = json!(2);
        }
        if path == "/v1/sync/keyrings/2" {
            *status = 200;
            *body = json!({ "keyId": 2, "recoveryWrap": "", "wrap": forged });
        }
    });
    let err = call(&b, "sync:now", json!([])).await.unwrap_err();
    assert!(err.contains("doesn't trust"), "{err}");
    assert_eq!(b.epoch(), 1, "B kept its own keyring");
    assert!(b.secret("keyring:2").is_none());
    p.clear();
    // Nothing was pushed under the forged key, and B carries on once the server behaves.
    b.store.put_synced(&chat("s_1_aaa", "after", 20.0)).unwrap();
    call(&b, "sync:now", json!([])).await.unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    assert_eq!(content(&a, "s_1_aaa"), "after");
}

/// C2: the key the approver wraps to is the one the join code was made for, not whatever the server shows at the click.
#[tokio::test]
async fn approval_refuses_a_swapped_key() {
    let Some(url) = itest_url() else { return };
    let p = proxy(url.clone()).await;
    let email = format!("attack-{}-{}@example.com", std::process::id(), b64_encode(&rand_bytes()));
    let a = device(&p.url, "Desk");
    sign_in(&a, &email).await;
    call(&a, "sync:turnOn", json!([])).await.unwrap();
    let c = device(&url, "Studio");
    sign_in(&c, &email).await;
    let code = call(&c, "sync:requestJoin", json!([])).await.unwrap()["joinCode"].as_str().unwrap().to_string();
    let swapped = b64_encode(&DeviceKey::generate().public());
    p.set(move |_, path, _, body| {
        if path == "/v1/sync/state"
            && let Some(list) = body["devices"].as_array_mut()
        {
            for d in list.iter_mut().filter(|d| d["label"] == "Studio") {
                d["publicKey"] = json!(swapped);
            }
        }
    });
    call(&a, "cloud:refresh", json!([])).await.unwrap();
    let c_id = a.cloud.status()["sync"]["devices"].as_array().unwrap().iter().find(|d| d["label"] == "Studio").unwrap()
        ["id"]
        .clone();
    let err = call(&a, "sync:approve", json!([c_id, code])).await.unwrap_err();
    assert!(err.contains("doesn't match"), "{err}");
    call(&c, "sync:now", json!([])).await.unwrap();
    assert_eq!(c.cloud.status()["sync"]["phase"], "awaiting-approval");
    // With the real key, the same code works.
    p.clear();
    call(&a, "sync:approve", json!([c_id, code])).await.unwrap();
    call(&c, "sync:now", json!([])).await.unwrap();
    assert_eq!(c.cloud.status()["sync"]["phase"], "idle");
}

/// C3: the server can't lower the rollback guard, and an older revision is never applied.
#[tokio::test]
async fn the_rollback_guard_holds() {
    let Some(url) = itest_url() else { return };
    let p = proxy(url.clone()).await;
    let (a, b, _, _) = account(&url, &p).await;
    a.store.put_synced(&chat("s_1_aaa", "first", 10.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    // B pulls revision 1 through the proxy, which keeps a copy.
    let captured: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let keep = captured.clone();
    p.set(move |_, path, _, body| {
        if path == "/v1/sync/pull"
            && let Some(objects) = body["objects"].as_array()
        {
            keep.lock().unwrap().extend(objects.iter().filter(|o| o["collection"] == "chat").cloned());
        }
    });
    call(&b, "sync:now", json!([])).await.unwrap();
    let old = captured.lock().unwrap().first().cloned().unwrap();
    a.store.put_synced(&chat("s_1_aaa", "second", 20.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    call(&b, "sync:now", json!([])).await.unwrap();
    assert_eq!(content(&b, "s_1_aaa"), "second");

    // The server answers B's next push with "conflict, you're at revision 0", then replays revision 1.
    b.store.put_synced(&chat("s_1_aaa", "third", 30.0)).unwrap();
    p.set(|method, path, _, body| {
        if method == "POST" && path == "/v1/sync/push" && body["results"][0]["objectId"].is_string() {
            body["results"][0] =
                json!({ "objectId": body["results"][0]["objectId"], "status": "conflict", "revision": 0 });
        }
    });
    let err = call(&b, "sync:now", json!([])).await.unwrap_err();
    assert!(err.contains("older"), "{err}");
    let old2 = old.clone();
    p.set(move |_, path, _, body| {
        if path == "/v1/sync/pull" {
            *body = json!({ "objects": [old2.clone()], "next": 999_999, "more": false });
        }
    });
    let _ = call(&b, "sync:now", json!([])).await;
    assert_eq!(content(&b, "s_1_aaa"), "third", "the replayed revision 1 was ignored");
    p.clear();
}

/// C4: after a revocation, a record the revoked device seals under the old epoch is ignored everywhere.
#[tokio::test]
async fn a_revoked_device_cannot_write_under_the_old_epoch() {
    let Some(url) = itest_url() else { return };
    let p = proxy(url.clone()).await;
    let (a, b, email, recovery) = account(&url, &p).await;
    a.store.put_synced(&chat("s_1_aaa", "real", 10.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    let c = device(&p.url, "Studio");
    sign_in(&c, &email).await;
    call(&c, "sync:restore", json!([recovery])).await.unwrap();
    assert_eq!(content(&c, "s_1_aaa"), "real");

    // A removes B. B still has epoch 1's keyring.
    call(&a, "cloud:refresh", json!([])).await.unwrap();
    let b_id = a.cloud.status()["sync"]["devices"].as_array().unwrap().iter().find(|d| d["label"] == "Laptop").unwrap()
        ["id"]
        .clone();
    call(&a, "sync:revoke", json!([b_id])).await.unwrap();
    call(&c, "sync:now", json!([])).await.unwrap();
    assert_eq!(c.epoch(), 2);
    let old = b.keyring(1);
    let raw: Value = reqwest::Client::new()
        .get(format!("{url}/v1/sync/state"))
        .bearer_auth(a.secret("token").unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let account_id = raw["account"].as_str().unwrap().to_string();
    // B (with the server's help) seals a newer revision of the chat, and an account record that trusts B again.
    let oid = object_id(&old, "chat", "s_1_aaa").unwrap();
    let forged_chat = seal_record(
        &old,
        &account_id,
        1,
        "chat",
        &oid,
        99,
        &serde_json::to_vec(&json!({ "v": 1, "chat": chat("s_1_aaa", "forged by B", 99.0) })).unwrap(),
    )
    .unwrap();
    let acct_oid = object_id(&old, "account", "epoch-1").unwrap();
    let forged_record = seal_record(
        &old,
        &account_id,
        1,
        "account",
        &acct_oid,
        99,
        br#"{"v":2,"epoch":1,"recoveryPublic":"x","devices":[]}"#,
    )
    .unwrap();
    let inject = [
        json!({ "collection": "chat", "objectId": oid, "revision": 99, "keyId": 1, "blob": forged_chat, "seq": 1 }),
        json!({ "collection": "account", "objectId": acct_oid, "revision": 99, "keyId": 1, "blob": forged_record, "seq": 2 }),
    ];
    p.set(move |_, path, _, body| {
        if path == "/v1/sync/pull"
            && let Some(objects) = body["objects"].as_array_mut()
        {
            objects.extend(inject.iter().cloned());
        }
    });
    call(&c, "sync:now", json!([])).await.unwrap();
    assert_eq!(content(&c, "s_1_aaa"), "real", "an old-epoch record was ignored");
    assert_eq!(c.epoch(), 2);
    p.clear();
}

/// C5 (partly) and C12: restore refuses to invent an account record the server withholds.
#[tokio::test]
async fn restore_needs_the_accounts_own_record() {
    let Some(url) = itest_url() else { return };
    let p = proxy(url.clone()).await;
    let email = format!("attack-{}-{}@example.com", std::process::id(), b64_encode(&rand_bytes()));
    let a = device(&url, "Desk");
    sign_in(&a, &email).await;
    let recovery = call(&a, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    let b = device(&p.url, "Laptop");
    sign_in(&b, &email).await;
    p.set(|_, path, status, body| {
        if path.starts_with("/v1/sync/objects/account/") {
            *status = 404;
            *body = json!({ "error": "not-found" });
        }
    });
    let err = call(&b, "sync:restore", json!([recovery])).await.unwrap_err();
    assert!(err.contains("didn't send this account's record"), "{err}");
    assert_eq!(b.epoch(), 0);
    p.clear();
}
