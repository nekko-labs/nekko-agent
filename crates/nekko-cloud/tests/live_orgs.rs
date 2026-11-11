//! Organizations and the org computer fleet against a real Nekko Cloud API:
//! the local dev stack (`apps/nekko-agent-api`: `DEV_CODE=123456 npm run
//! dev:local`; organizations are on there). Skipped unless
//! `NEKKO_CLOUD_ITEST_URL` is set:
//!
//!   NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test live_orgs -- --nocapture

use nekko_cloud::vault::FileVault;
use nekko_cloud::{Cloud, HostInfo, LocalModel, Options};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const CODE: &str = "123456";

struct Device {
    cloud: Arc<Cloud>,
    models: Arc<Mutex<Vec<LocalModel>>>,
    name: Arc<Mutex<String>>,
    dir: tempfile::TempDir,
}

fn model(id: &str, label: &str) -> LocalModel {
    LocalModel { id: id.into(), label: label.into(), runtime: "llamacpp".into(), size_bytes: Some(4_000_000_000) }
}

fn device(url: &str, label: &str, models: Vec<LocalModel>) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SessionStore::new(dir.path()));
    let cloud = Cloud::new(Options {
        dir: dir.path().join("cloud"),
        api_url: url.into(),
        device_label: label.into(),
        sessions: store,
        vault: Box::new(FileVault::new(dir.path().join("cloud").join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    let models = Arc::new(Mutex::new(models));
    let name = Arc::new(Mutex::new(label.to_string()));
    let (m, n) = (models.clone(), name.clone());
    cloud.set_host(HostInfo {
        app_version: "9.9.9-test".into(),
        name: Arc::new(move || n.lock().unwrap().clone()),
        models: Arc::new(move || {
            let list = m.lock().unwrap().clone();
            Box::pin(async move { list })
        }),
    });
    Device { cloud, models, name, dir }
}

async fn call(d: &Device, channel: &str, args: Value) -> Result<Value, String> {
    d.cloud.route(channel, args.as_array().unwrap()).await
}

async fn sign_in(d: &Device, email: &str) {
    call(d, "cloud:sendCode", json!([email])).await.unwrap();
    let s = call(d, "cloud:verifyCode", json!([email, CODE])).await.unwrap();
    assert!(s["signedIn"] == true, "sign-in didn't finish");
}

fn token(d: &Device) -> String {
    let secrets: Value =
        serde_json::from_str(&std::fs::read_to_string(d.dir.path().join("cloud/secrets.json")).unwrap()).unwrap();
    secrets["token"].as_str().unwrap().to_string()
}

async fn raw(url: &str, d: &Device, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, String) {
    let mut req = reqwest::Client::new().request(method, format!("{url}{path}")).bearer_auth(token(d));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.unwrap();
    (res.status().as_u16(), res.text().await.unwrap())
}

fn names(list: &Value) -> Vec<String> {
    list["computers"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn an_org_lists_a_shared_computer_for_an_unlocked_device_without_chat_sync() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let tag = format!("{}-{}", std::process::id(), nekko_js::now_ms());
    let email = format!("org-itest-{tag}@example.com");
    let a = device(&url, "Desk-PC", vec![model("qwen3-8b", "Qwen3 8B")]);
    let b = device(&url, "Laptop", vec![]);

    // A unlocks the account, then turns chat sync OFF: organizations must not need it.
    sign_in(&a, &email).await;
    let on = call(&a, "sync:turnOn", json!([])).await.unwrap();
    let recovery = on["recoveryKey"].as_str().unwrap().to_string();
    let off = call(&a, "sync:setEnabled", json!([false])).await.unwrap();
    assert_eq!(off["sync"]["enabled"], false);

    // A creates the org; the key is made and stored.
    let org = call(&a, "org:create", json!(["Nekko Labs"])).await.unwrap();
    let org_id = org["id"].as_str().unwrap().to_string();
    assert_eq!(
        (org["name"].as_str(), org["role"].as_str(), org["keyId"].as_u64()),
        (Some("Nekko Labs"), Some("owner"), Some(1))
    );
    assert_eq!((org["hasKey"].as_bool(), org["sharing"].as_bool()), (Some(true), Some(false)));
    call(&a, "org:list", json!([])).await.unwrap();
    let summary = a.cloud.status()["orgs"].clone();
    assert_eq!(
        (summary[0]["name"].as_str(), summary[0]["hasKey"].as_bool(), summary[0]["state"].as_str()),
        (Some("Nekko Labs"), Some(true), Some("off"))
    );

    // Off by default: nothing is listed until sharing is switched on.
    let list = call(&a, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(list["computers"].as_array().unwrap().len(), 0, "fleet list should start empty");
    assert_eq!(call(&a, "fleet:status", json!([])).await.unwrap()["sharing"][0]["state"], "off");

    // B (the same account) unlocks with the recovery key, and turns chat sync off too.
    sign_in(&b, &email).await;
    call(&b, "sync:restore", json!([recovery])).await.unwrap();
    call(&b, "sync:setEnabled", json!([false])).await.unwrap();
    // B has no org key yet; listing fetches it from the account's store, no chat sync involved.
    let seen = call(&b, "org:list", json!([])).await.unwrap();
    assert_eq!(seen["orgs"][0]["id"], org_id.as_str());
    assert_eq!(seen["orgs"][0]["hasKey"], true, "B pulls the org key through the account record");

    // A shares this computer: it is listed for B with its name, OS and models.
    let shared = call(&a, "fleet:setSharing", json!([org_id, true])).await.unwrap();
    assert_eq!(
        (shared["sharing"].as_bool(), shared["state"].as_str()),
        (Some(true), Some("online")),
        "fleet sharing state"
    );
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(list["orgKeyId"], 1);
    assert_eq!(list["rejected"], 0);
    assert_eq!(names(&list), ["Desk-PC"], "fleet list names after sharing on");
    let c = &list["computers"][0];
    assert_eq!(
        (c["online"].as_bool(), c["you"].as_bool(), c["verified"].as_bool()),
        (Some(true), Some(false), Some(true))
    );
    assert_eq!(
        c["os"],
        if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
    );
    assert_eq!(c["appVersion"], "9.9.9-test");
    assert_eq!(c["models"][0]["id"], "qwen3-8b");
    assert_eq!(c["models"][0]["label"], "Qwen3 8B");
    assert!(c.get("ownerEmail").is_none(), "your own computers carry no owner");
    // A's own view marks it as this computer.
    let mine = call(&a, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(mine["computers"][0]["you"], true);

    // The server only ever holds ciphertext.
    let (status, text) = raw(&url, &b, reqwest::Method::GET, &format!("/v1/orgs/{org_id}/fleet"), None).await;
    assert_eq!(status, 200);
    for leak in ["Desk-PC", "qwen3", "Qwen3", "windows", "9.9.9-test"] {
        assert!(!text.contains(leak), "the server saw {leak}");
    }
    let revision = |v: &Value| v["computers"][0]["revision"].as_u64().unwrap();
    let before: Value = serde_json::from_str(&text).unwrap();

    // A beat with nothing new only renews the lease: same revision.
    a.cloud.share_tick().await;
    let (_, text) = raw(&url, &b, reqwest::Method::GET, &format!("/v1/orgs/{org_id}/fleet"), None).await;
    assert_eq!(revision(&serde_json::from_str(&text).unwrap()), revision(&before));
    assert_eq!(call(&a, "fleet:status", json!([])).await.unwrap()["sharing"][0]["state"], "online");

    // A new model and a new name are republished on the next beat.
    a.models.lock().unwrap().push(model("llama-3.2-3b", "Llama 3.2 3B"));
    *a.name.lock().unwrap() = "Desk-PC (office)".into();
    a.cloud.share_tick().await;
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(names(&list), ["Desk-PC (office)"]);
    assert_eq!(list["computers"][0]["models"].as_array().unwrap().len(), 2);
    let (_, text) = raw(&url, &b, reqwest::Method::GET, &format!("/v1/orgs/{org_id}/fleet"), None).await;
    assert!(revision(&serde_json::from_str(&text).unwrap()) > revision(&before));

    // A descriptor nobody can open (sealed under no org key) is dropped and counted, not shown.
    let mut junk = vec![1u8];
    junk.extend((0..400u32).map(|i| (i * 31 % 251) as u8));
    use base64::Engine;
    let junk = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(junk);
    let (status, body) = raw(
        &url,
        &b,
        reqwest::Method::PUT,
        &format!("/v1/orgs/{org_id}/fleet/self"),
        Some(json!({ "orgKeyId": 1, "revision": 1, "descriptor": junk })),
    )
    .await;
    assert!(status == 200 || status == 201, "{status} {body}");
    let list = call(&a, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(list["rejected"], 1, "fleet list rejected count");
    assert_eq!(names(&list), ["Desk-PC (office)"]);

    // A member of another account sees the org but has no key: it lists nothing and cannot share.
    let c_email = format!("org-itest-member-{tag}@example.com");
    let invited = call(&a, "org:invite", json!([org_id, c_email, "member"])).await.unwrap();
    assert_eq!(invited["invites"][0]["email"], c_email.to_lowercase());
    let cdev = device(&url, "Other PC", vec![]);
    sign_in(&cdev, &c_email).await;
    let pending = call(&cdev, "org:list", json!([])).await.unwrap();
    let invite_id = pending["invites"][0]["id"].as_str().unwrap().to_string();
    let joined = call(&cdev, "org:acceptInvite", json!([invite_id])).await.unwrap();
    assert_eq!(joined["orgs"][0]["role"], "member");
    assert_eq!(joined["orgs"][0]["hasKey"], false);
    call(&cdev, "sync:turnOn", json!([])).await.unwrap();
    let theirs = call(&cdev, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(theirs["hasKey"], false, "member without an org key");
    assert!(theirs["error"].as_str().unwrap().contains("org key"));
    assert_eq!(theirs["computers"].as_array().unwrap().len(), 0);
    let err = call(&cdev, "fleet:setSharing", json!([org_id, true])).await.unwrap_err();
    assert!(err.contains("org key"), "{err}");

    // A turns sharing off: B stops seeing it.
    let off = call(&a, "fleet:setSharing", json!([org_id, false])).await.unwrap();
    assert_eq!((off["sharing"].as_bool(), off["state"].as_str()), (Some(false), Some("off")));
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert!(!names(&list).contains(&"Desk-PC (office)".to_string()), "fleet list after sharing off");
    let (status, _) =
        raw(&url, &a, reqwest::Method::POST, &format!("/v1/orgs/{org_id}/fleet/self/heartbeat"), None).await;
    assert_eq!(status, 409, "a withdrawn computer cannot keep its lease");

    // Sharing again recovers from the bumped revision, with no manual step.
    call(&a, "fleet:setSharing", json!([org_id, true])).await.unwrap();
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert!(names(&list).contains(&"Desk-PC (office)".to_string()), "fleet list after sharing restored");

    // The owner removes the member: the org gets a new key, and the member's view is empty.
    let members = call(&b, "org:get", json!([org_id])).await.unwrap();
    let their_id =
        members["members"].as_array().unwrap().iter().find(|m| m["email"] == c_email.to_lowercase()).unwrap()["userId"]
            .clone();
    let after = call(&b, "org:removeMember", json!([org_id, their_id])).await.unwrap();
    assert!(after.get("keyError").is_none(), "org state after member removal");
    assert_eq!(
        (after["keyId"].as_u64(), after["hasKey"].as_bool()),
        (Some(2), Some(true)),
        "org key after member removal"
    );
    assert_eq!(after["members"].as_array().unwrap().len(), 1);
    assert_eq!(call(&cdev, "org:list", json!([])).await.unwrap()["orgs"].as_array().unwrap().len(), 0);

    // A shares from the old key: its next beat finds the org moved on, takes the new key from the
    // account's store (chat sync is off there too) and publishes again.
    a.cloud.share_tick().await;
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(list["orgKeyId"], 2);
    assert!(names(&list).contains(&"Desk-PC (office)".to_string()), "fleet list after key rotation");
    assert_eq!(call(&a, "fleet:status", json!([])).await.unwrap()["sharing"][0]["state"], "online");

    // B removes A from the account: A disappears from the org list, and the org key moves on.
    call(&b, "cloud:refresh", json!([])).await.unwrap();
    let a_id =
        b.cloud.status()["sync"]["devices"].as_array().unwrap().iter().find(|d| d["label"] == "Desk-PC").unwrap()["id"]
            .clone();
    call(&b, "sync:revoke", json!([a_id])).await.unwrap();
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert!(!names(&list).contains(&"Desk-PC (office)".to_string()), "fleet list after device revocation");
    assert_eq!(list["orgKeyId"], 3, "revoking a device rotates the org key");
    let org_now = call(&b, "org:get", json!([org_id])).await.unwrap();
    assert_eq!((org_now["keyId"].as_u64(), org_now["hasKey"].as_bool()), (Some(3), Some(true)));
    assert_eq!(org_now["members"].as_array().unwrap().len(), 1);

    // A is signed out of sync now; its sharing can no longer publish.
    a.cloud.share_tick().await;
    let st = call(&a, "fleet:status", json!([])).await.unwrap();
    assert_eq!(st["sharing"][0]["state"], "error", "fleet status after revocation");

    // B shares too, then signs out: sign-out withdraws and stops sharing.
    call(&b, "fleet:setSharing", json!([org_id, true])).await.unwrap();
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert_eq!(names(&list), ["Laptop"], "fleet list names before sign-out");
    assert_eq!(list["orgKeyId"], 3);
    call(&b, "cloud:signOut", json!([])).await.unwrap();
    assert_eq!(b.cloud.status()["orgs"].as_array().unwrap().len(), 0);
    sign_in(&b, &email).await;
    let st = call(&b, "fleet:status", json!([])).await.unwrap();
    assert!(st["sharing"].as_array().unwrap().iter().all(|s| s["state"] == "off"), "fleet status after sign-out");
    let list = call(&b, "fleet:list", json!([org_id])).await.unwrap();
    assert!(names(&list).is_empty(), "the sign-out withdrew this computer");

    // Clean up the org.
    call(&b, "org:delete", json!([org_id])).await.unwrap();
    assert_eq!(call(&b, "org:list", json!([])).await.unwrap()["orgs"].as_array().unwrap().len(), 0);
}
