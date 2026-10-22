//! The real `nekkod` binary end to end: the channels Electron main used to answer: the folder picker, dialogs and quitting, and updates from a release feed.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn adds_a_folder_from_the_desktop_picker_through_the_bridge() {
    let data = std::env::temp_dir().join(format!("nekkod-picker-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let picked = data.join("picked");
    std::fs::create_dir_all(&picked).unwrap();
    let answer = std::sync::Arc::new(std::sync::Mutex::new(json!({ "path": picked })));
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(Option<String>, Value)>::new()));
    let (a, s) = (answer.clone(), seen.clone());
    let app = axum::Router::new().route(
        "/",
        axum::routing::post(move |headers: axum::http::HeaderMap, body: axum::Json<Value>| {
            let (a, s) = (a.clone(), s.clone());
            async move {
                let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_string);
                s.lock().unwrap().push((auth, body.0));
                axum::Json(a.lock().unwrap().clone())
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge = format!("http://127.0.0.1:{}/", l.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let d = start_with_config(Some(&data), json!({ "browserBridge": { "url": bridge, "token": "bridge-token" } }));

    let (status, added) = post(d.port, "workspace:add", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{added}");
    assert_eq!(added[0]["path"], json!(picked));
    assert_eq!(added[0]["name"], "picked");
    assert_eq!(seen.lock().unwrap()[0], (Some("Bearer bridge-token".into()), json!({ "tool": "pickFolder" })));
    // Cancelled: the saved folders, unchanged.
    *answer.lock().unwrap() = json!({ "path": null });
    let (_, again) = post(d.port, "workspace:add", json!([]), Some(TOKEN)).await;
    assert_eq!(again, added);
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// Electron main's side of the bridge for the native channels: the app
/// window's handle (none here), dialogs it draws when asked (recorded, with
/// scripted answers), and quitting for an update.
async fn fake_shell_bridge(answers: Value) -> (String, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let s = seen.clone();
    let app = axum::Router::new().route(
        "/",
        axum::routing::post(move |headers: axum::http::HeaderMap, body: axum::Json<Value>| {
            let (s, answers) = (s.clone(), answers.clone());
            async move {
                assert_eq!(headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer bridge-token"));
                s.lock().unwrap().push(body.0.clone());
                let reply = match body.0["tool"].as_str() {
                    Some("nativeWindow") => json!({ "handle": null }),
                    Some("dialog") => json!({ "result": answers[body.0["kind"].as_str().unwrap_or("")].clone() }),
                    Some("quitForUpdate") => json!({ "ok": true }),
                    _ => json!({ "error": "unknown" }),
                };
                axum::Json(reply)
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}/", l.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, seen)
}

fn native_daemon(data: &std::path::Path, bridge: &str, native: Value) -> Daemon {
    start_with_config(
        Some(data),
        json!({ "appVersion": "0.8.1", "edition": "desktop", "browserBridge": { "url": bridge, "token": "bridge-token" }, "native": native }),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_the_channels_electron_main_used_to() {
    let data = std::env::temp_dir().join(format!("nekkod-native-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let picked = data.join("picked");
    std::fs::create_dir_all(&picked).unwrap();
    let answers = json!({
        "pickFolder": picked,
        "openFiles": [data.join("a.txt"), data.join("b.txt")],
        "saveFile": null,
        "message": { "response": 1 },
    });
    let (bridge, seen) = fake_shell_bridge(answers).await;
    // `dialogs: "bridge"`: main draws them, so no real dialog opens in a test.
    let d = native_daemon(&data, &bridge, json!({ "isPackaged": false, "exePath": "x", "dialogs": "bridge" }));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in [
        "dialog:openFiles",
        "dialog:pickFolder",
        "shell:openPath",
        "voice:permission",
        "update:check",
        "update:install",
    ] {
        assert!(info["owned"].as_array().unwrap().iter().any(|o| o == c), "{c} is the daemon's: {info}");
    }
    let (status, files) = post(d.port, "dialog:openFiles", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{files}");
    assert_eq!(files.as_array().unwrap().len(), 2);
    let (_, folder) = post(d.port, "dialog:pickFolder", json!([{ "title": "Pick" }]), Some(TOKEN)).await;
    assert_eq!(folder, json!(picked));
    let (_, saved) = post(d.port, "dialog:saveFile", json!([{ "defaultPath": "x.md" }]), Some(TOKEN)).await;
    assert_eq!(saved, Value::Null);
    let (_, answer) =
        post(d.port, "dialog:message", json!([{ "message": "Sure?", "buttons": ["No", "Yes"] }]), Some(TOKEN)).await;
    assert_eq!(answer, json!({ "response": 1 }));
    let (status, _) = post(d.port, "dialog:message", json!([{ "buttons": ["a", "b", "c", "d"] }]), Some(TOKEN)).await;
    assert_eq!(status, 400, "four buttons are refused before any dialog");

    // workspace:add now goes through the daemon's own picker (small_services::pick_folder).
    let (status, added) = post(d.port, "workspace:add", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{added}");
    assert_eq!(added[0]["path"], json!(picked));
    let kinds: Vec<String> =
        seen.lock().unwrap().iter().filter_map(|v| v["kind"].as_str().map(str::to_string)).collect();
    assert_eq!(kinds, ["openFiles", "pickFolder", "saveFile", "message", "pickFolder"]);
    assert!(seen.lock().unwrap().iter().all(|v| v["tool"] != "pickFolder"), "the old bridge picker is not used");

    // The microphone: Electron's answer shape, one of its statuses.
    let (_, mic) = post(d.port, "voice:permission", json!(["status"]), Some(TOKEN)).await;
    assert!(
        ["granted", "denied", "restricted", "not-determined", "unknown"].contains(&mic["status"].as_str().unwrap()),
        "{mic}"
    );
    let (status, _) = post(d.port, "voice:permission", json!(["grant"]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    // Opening an empty path does nothing and does not fail, as shell.openPath did.
    let (status, _) = post(d.port, "shell:openPath", json!([""]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    // An unpackaged app without a feed does not update, with main's message.
    let (_, state) = post(d.port, "update:check", json!([]), Some(TOKEN)).await;
    assert_eq!(state["state"], "none");
    assert_eq!(state["message"], "Updates are available in the installed app.");
    let (status, _) = post(d.port, "update:install", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 400, "nothing downloaded");
    drop(d);

    // Without `native` (the Local Web UI), nothing here is the daemon's.
    let web = start_with(Some(&data));
    let (_, info) = post(web.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(!info["owned"].as_array().unwrap().iter().any(|o| o == "update:check"));
    drop(web);
    let _ = std::fs::remove_dir_all(&data);
}

fn fake_installer() -> std::path::PathBuf {
    let exe = format!("fake_installer{}", std::env::consts::EXE_SUFFIX);
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let path = deps.parent().unwrap().join("examples").join(exe);
    if !path.is_file() {
        let target = deps.parent().unwrap().parent().unwrap();
        let ok = Command::new(env!("CARGO"))
            .args(["build", "-p", "nekkod", "--example", "fake_installer"])
            .env("CARGO_TARGET_DIR", target)
            .status()
            .unwrap()
            .success();
        assert!(ok, "the stand-in installer builds");
    }
    path
}

/// A loopback release feed in electron-builder's layout: `latest*.yml` naming
/// one file with its base64 SHA-512, the file itself, request log.
async fn fake_feed(
    version: &str,
    file_name: &str,
    bytes: Vec<u8>,
    sha512: String,
) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let channel = if cfg!(windows) {
        "latest.yml"
    } else if cfg!(target_os = "macos") {
        "latest-mac.yml"
    } else {
        "latest-linux.yml"
    };
    let yml = format!(
        "version: {version}\nfiles:\n  - url: {file_name}\n    sha512: {sha512}\n    size: {}\npath: {file_name}\nsha512: {sha512}\nreleaseDate: '2026-10-17T00:00:00.000Z'\n",
        bytes.len()
    );
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (l2, name) = (log.clone(), file_name.to_string());
    let bytes = std::sync::Arc::new(bytes);
    let app = axum::Router::new().route(
        "/feed/{file}",
        axum::routing::get(move |axum::extract::Path(file): axum::extract::Path<String>| {
            let (log, yml, name, bytes) = (l2.clone(), yml.clone(), name.clone(), bytes.clone());
            async move {
                log.lock().unwrap().push(file.clone());
                if file == channel {
                    (axum::http::StatusCode::OK, yml.into_bytes())
                } else if file == name {
                    (axum::http::StatusCode::OK, bytes.to_vec())
                } else {
                    (axum::http::StatusCode::NOT_FOUND, Vec::new())
                }
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}/feed/", l.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (url, log)
}

#[tokio::test(flavor = "multi_thread")]
async fn updates_from_a_release_feed_with_checksums_and_events() {
    let data = std::env::temp_dir().join(format!("nekkod-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let installer = std::fs::read(fake_installer()).unwrap();
    let sha = nekko_native::update::sha512_base64(&installer);
    let ext = if cfg!(windows) {
        "exe"
    } else if cfg!(target_os = "macos") {
        "zip"
    } else {
        "AppImage"
    };
    let name = format!("NekkoAgent-0.9.0-x64.{ext}");
    let (feed, log) = fake_feed("0.9.0", &name, installer.clone(), sha.clone()).await;
    let (bridge, seen) = fake_shell_bridge(json!({})).await;
    let cache = data.join("cache");
    let d = native_daemon(
        &data,
        &bridge,
        json!({ "isPackaged": false, "exePath": "x", "updateFeedUrl": feed, "updateCacheDir": cache, "dialogs": "bridge" }),
    );
    // Only the updater's events.
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}&only=update:event"), Some("null")).await.unwrap();

    let (_, state) = post(d.port, "update:check", json!([]), Some(TOKEN)).await;
    assert_eq!(state["state"], "available", "{state}");
    assert_eq!(state["version"], "0.9.0");
    assert_eq!(state["currentVersion"], "0.8.1");
    assert_eq!(state["edition"], "desktop");
    let (_, state) = post(d.port, "update:download", json!([]), Some(TOKEN)).await;
    assert_eq!(
        state,
        json!({ "state": "downloaded", "currentVersion": "0.8.1", "notesUrl": "https://github.com/nekko-labs/nekko-agent/releases/latest", "edition": "desktop", "version": "0.9.0", "percent": 100 })
    );
    let kept = cache.join("pending").join(&name);
    assert_eq!(nekko_native::update::sha512_file(&kept).unwrap(), sha, "the download is kept, verified");

    // The UI heard every step on `update:event`, the renderer's channel.
    let mut states = Vec::new();
    while let Some(ev) = next_json(&mut events, Duration::from_millis(500)).await {
        if ev["channel"] == "update:event" {
            states.push(ev["payload"]["state"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(states.first().map(String::as_str), Some("checking"));
    assert!(states.iter().any(|s| s == "available") && states.iter().any(|s| s == "downloading"), "{states:?}");
    assert_eq!(states.last().map(String::as_str), Some("downloaded"));

    // A second download of the same file is not fetched again.
    let fetched = log.lock().unwrap().iter().filter(|f| **f == name).count();
    post(d.port, "update:check", json!([]), Some(TOKEN)).await;
    post(d.port, "update:download", json!([]), Some(TOKEN)).await;
    assert_eq!(log.lock().unwrap().iter().filter(|f| **f == name).count(), fetched);

    // Windows: run the downloaded installer with electron-updater's silent
    // update arguments, detached, then ask main to quit. Never a real installer.
    if cfg!(windows) {
        let (status, done) = post(d.port, "update:install", json!([]), Some(TOKEN)).await;
        assert_eq!(status, 200, "{done}");
        assert_eq!(done["plan"]["kind"], "run");
        assert_eq!(done["plan"]["args"], json!(["--updated", "/S", "--force-run"]));
        assert!(seen.lock().unwrap().iter().any(|v| v["tool"] == "quitForUpdate"), "main was asked to quit");
        // The stand-in writes what it was started with beside itself.
        let ran = kept.with_extension("ran.json");
        wait_for("the stand-in installer to run", || ran.is_file()).await;
        let got: Value = serde_json::from_str(&std::fs::read_to_string(&ran).unwrap()).unwrap();
        assert_eq!(got["args"], json!(["--updated", "/S", "--force-run"]));
    }
    drop(d);

    // A corrupted download is refused and not kept. It gets a cache of its
    // own: on Windows the stand-in (or a virus scan of it) can hold the good
    // copy's image past any wait, and a good copy left in the shared cache is
    // reused as a verified download, so no delete is relied on here.
    let cache = data.join("cache-corrupted");
    let (bad_feed, _) = fake_feed("0.9.0", &name, b"not the installer".to_vec(), sha.clone()).await;
    let d = native_daemon(
        &data,
        &bridge,
        json!({ "isPackaged": false, "exePath": "x", "updateFeedUrl": bad_feed, "updateCacheDir": cache, "dialogs": "bridge" }),
    );
    post(d.port, "update:check", json!([]), Some(TOKEN)).await;
    let (_, state) = post(d.port, "update:download", json!([]), Some(TOKEN)).await;
    assert_eq!(state["state"], "error");
    assert!(state["message"].as_str().unwrap().starts_with("sha512 checksum mismatch, expected "), "{state}");
    assert!(!cache.join("pending").join(&name).exists(), "a bad download is not kept");
    let (status, _) = post(d.port, "update:install", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    drop(d);

    // Not newer: nothing offered.
    let (same, _) = fake_feed("0.8.1", &name, installer, sha).await;
    let d = native_daemon(
        &data,
        &bridge,
        json!({ "isPackaged": false, "exePath": "x", "updateFeedUrl": same, "dialogs": "bridge" }),
    );
    let (_, state) = post(d.port, "update:check", json!([]), Some(TOKEN)).await;
    assert_eq!(state["state"], "none", "{state}");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}
