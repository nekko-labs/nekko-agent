//! Library files synced between two computers of one account (#2748), against
//! the local Nekko Cloud dev stack. A team account switches `library-cloud` on.
//! Skipped unless `NEKKO_CLOUD_ITEST_URL` is set:
//!
//!   cd apps/nekko-agent-api && DEV_CODE=123456 NEKKO_STAFF_EMAILS=library-itest@example.com npm run dev:local
//!   NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test library_live -- --nocapture

use nekko_cloud::vault::FileVault;
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::Arc;

const CODE: &str = "123456";
const EMAIL: &str = "library-itest@example.com";

struct Device {
    cloud: Arc<Cloud>,
    dir: tempfile::TempDir,
}

fn device(url: &str, label: &str) -> Device {
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
    Device { cloud, dir }
}

async fn call(d: &Device, channel: &str, args: Value) -> Result<Value, String> {
    d.cloud.route(channel, args.as_array().unwrap()).await
}

async fn sign_in(d: &Device) {
    call(d, "cloud:sendCode", json!([EMAIL])).await.unwrap();
    let s = call(d, "cloud:verifyCode", json!([EMAIL, CODE])).await.unwrap();
    assert!(s["signedIn"] == true, "sign-in didn't finish");
}

fn token(d: &Device) -> String {
    let secrets: Value =
        serde_json::from_str(&std::fs::read_to_string(d.dir.path().join("cloud/secrets.json")).unwrap()).unwrap();
    secrets["token"].as_str().unwrap().to_string()
}

fn remote(d: &Device) -> Vec<Value> {
    d.cloud.status()["library"]["remote"].as_array().cloned().unwrap_or_default()
}

fn file_state(d: &Device, path: &std::path::Path) -> String {
    d.cloud.status()["library"]["files"][path.to_string_lossy().as_ref()].as_str().unwrap_or("").to_string()
}

#[tokio::test]
async fn a_library_file_made_on_one_computer_appears_on_the_other() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let (a, b) = (device(&url, "Desk"), device(&url, "Laptop"));
    sign_in(&a).await;
    // Off until the team switches it on: no trace in the status, and the app's list is not kept.
    call(&a, "cloud:setTeamFeature", json!(["library-cloud", "off"])).await.unwrap();
    assert!(a.cloud.status()["library"].is_null());
    let recovery = call(&a, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    call(&a, "cloud:setTeamFeature", json!(["library-cloud", "team"])).await.unwrap();
    let s = a.cloud.status();
    assert_eq!(s["account"]["features"]["libraryCloud"], true);
    assert_eq!(s["library"]["on"], true);

    // A design and a report on A, one too large, and a path the app may not send.
    let work = a.dir.path().join("proj");
    std::fs::create_dir_all(work.join("nekko-designs")).unwrap();
    let design = work.join("nekko-designs").join("checkout-design.html");
    let design2 = work.join("nekko-designs").join("checkout-design-v2.html");
    let report = work.join("q3-report.md");
    let huge = work.join("dump.csv");
    std::fs::write(&design, "<h1>Checkout for Kestrel Books</h1>").unwrap();
    std::fs::write(&design2, "<h1>Checkout v2</h1>").unwrap();
    std::fs::write(&report, "# Q3\nRevenue was 4471.").unwrap();
    std::fs::write(&huge, vec![b'x'; 8_000_001]).unwrap();
    let files = json!([
        { "path": design.to_string_lossy(), "kind": "design", "title": "Checkout design", "chat": "Shop redesign" },
        { "path": design2.to_string_lossy(), "kind": "design", "title": "Checkout design", "chat": "Shop redesign" },
        { "path": report.to_string_lossy(), "kind": "doc", "title": "Q3 report", "chat": "Quarterly numbers" },
        { "path": huge.to_string_lossy(), "kind": "data", "title": "Dump", "chat": "Export" },
        { "path": "relative.md", "kind": "doc" },
    ]);
    let listed = call(&a, "library:sync", json!([files])).await.unwrap();
    assert_eq!(listed["library"]["files"].as_object().unwrap().len(), 4, "the relative path is refused");
    call(&a, "sync:now", json!([])).await.unwrap();
    assert_eq!(file_state(&a, &design), "synced");
    assert_eq!(file_state(&a, &report), "synced");
    assert_eq!(file_state(&a, &huge), "tooLarge");

    // Nekko Cloud holds ciphertext only: no names, paths, chats or contents.
    let raw = reqwest::Client::new()
        .get(format!("{url}/v1/sync/pull?limit=500"))
        .bearer_auth(token(&a))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    for leak in
        ["Kestrel", "4471", "checkout-design", "q3-report", "Shop redesign", "Quarterly", "Desk", "nekko-designs"]
    {
        assert!(!raw.contains(leak), "the server saw {leak}");
    }

    // B joins with the recovery key and gets read-only copies, named after A.
    sign_in(&b).await;
    call(&b, "sync:restore", json!([recovery])).await.unwrap();
    let got = remote(&b);
    assert_eq!(got.len(), 3, "the small files arrive, the large one doesn't");
    let copy = got.iter().find(|f| f["originalPath"] == design.to_string_lossy().as_ref()).unwrap();
    let copy2 = got.iter().find(|f| f["originalPath"] == design2.to_string_lossy().as_ref()).unwrap();
    let parent = |v: &Value| std::path::PathBuf::from(v["path"].as_str().unwrap()).parent().unwrap().to_path_buf();
    assert_eq!(parent(copy), parent(copy2), "a design's versions share a folder, so they read as one design");
    assert_eq!(copy["device"], "Desk");
    assert_eq!(copy["kind"], "design");
    assert_eq!(copy["chat"], "Shop redesign");
    let copy_path = copy["path"].as_str().unwrap().to_string();
    assert!(copy_path.ends_with("checkout-design.html"));
    assert!(copy_path.starts_with(&*b.dir.path().join("cloud").join("library").to_string_lossy()));
    assert_eq!(std::fs::read_to_string(&copy_path).unwrap(), "<h1>Checkout for Kestrel Books</h1>");
    // A doesn't list its own files as another computer's.
    call(&a, "sync:now", json!([])).await.unwrap();
    assert!(remote(&a).is_empty());

    // A changes the design: B's copy follows. Saving the report again unchanged uploads nothing.
    std::fs::write(&design, "<h1>Checkout, second pass</h1>").unwrap();
    let before = std::fs::read(&report).unwrap();
    std::fs::write(&report, &before).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    assert_eq!(a.cloud.status()["sync"]["pushed"], 1, "only the changed design is uploaded");
    call(&b, "sync:now", json!([])).await.unwrap();
    let copy = remote(&b).into_iter().find(|f| f["originalPath"] == design.to_string_lossy().as_ref()).unwrap();
    assert_eq!(std::fs::read_to_string(copy["path"].as_str().unwrap()).unwrap(), "<h1>Checkout, second pass</h1>");
    assert_eq!(remote(&b).len(), 3);

    // A deletes the report: it leaves B too, copy and all.
    std::fs::remove_file(&report).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    call(&b, "sync:now", json!([])).await.unwrap();
    let left = remote(&b);
    assert_eq!(left.len(), 2);
    assert!(left.iter().all(|f| f["title"] == "Checkout design"));
    let report_copy = got.iter().find(|f| f["title"] == "Q3 report").unwrap();
    assert!(!std::path::Path::new(report_copy["path"].as_str().unwrap()).exists(), "the copy is removed");
    assert!(!a.cloud.status()["library"]["files"].as_object().unwrap().contains_key(report.to_string_lossy().as_ref()));

    // Switched off again: no trace on either computer.
    call(&a, "cloud:setTeamFeature", json!(["library-cloud", "off"])).await.unwrap();
    call(&b, "cloud:refresh", json!([])).await.unwrap();
    assert!(a.cloud.status()["library"].is_null() && b.cloud.status()["library"].is_null());

    // Delete everything synced: B's copies go with the keys.
    call(&a, "sync:deleteAll", json!([])).await.unwrap();
    let _ = call(&b, "sync:now", json!([])).await;
    assert!(!b.dir.path().join("cloud").join("library").exists(), "copies are removed with the sync keys");
}
