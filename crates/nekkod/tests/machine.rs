//! The real daemon serves the machine channels itself: with no TS backend at
//! all, `gpu:stats`, `system:stats`, `machine:readiness`, `machine:profile` and
//! `machine:recommendations` still answer, and `resource:queue` reads its gate
//! from the data directory.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

const TOKEN: &str = "machine-test-token-0123456789";

struct Daemon {
    child: Child,
    port: u16,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start(data_dir: &std::path::Path) -> Daemon {
    let config = json!({ "token": TOKEN, "allowedOrigins": ["null"], "dataDir": data_dir });
    let mut child = Command::new(env!("CARGO_BIN_EXE_nekkod"))
        .arg("--config-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("nekkod starts");
    // The config is the first line of stdin; stdin stays open (its end stops the daemon).
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), format!("{config}\n").as_bytes()).unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = lines.next().expect("a ready line").unwrap();
    let ready: Value = serde_json::from_str(line.strip_prefix("NEKKOD_READY ").expect("ready prefix")).unwrap();
    std::thread::spawn(move || for _ in lines {});
    Daemon { child, port: ready["port"].as_u64().unwrap() as u16 }
}

async fn post(port: u16, channel: &str, args: Value) -> (u16, Value) {
    let res = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/api/{channel}"))
        .bearer_auth(TOKEN)
        .json(&json!({ "args": args }))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn machine_channels_are_served_without_a_backend() {
    let dir = std::env::temp_dir().join(format!("nekkod-machine-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let d = start(&dir);

    let (status, sys) = post(d.port, "system:stats", json!([])).await;
    assert_eq!(status, 200, "{sys}");
    if !cfg!(target_os = "macos") {
        // macOS answers null when vm_stat is unavailable; elsewhere RAM always reads.
        assert!(sys["cpuCores"].as_u64().unwrap() > 0, "{sys}");
        assert!(sys["memTotalMB"].as_f64().unwrap() > 0.0, "{sys}");
        let pct = sys["cpuPct"].as_f64().unwrap();
        assert!((0.0..=100.0).contains(&pct), "{sys}");
    }

    // A machine may have no GPU at all; the answer is still the daemon's.
    let (status, gpu) = post(d.port, "gpu:stats", json!([])).await;
    assert_eq!(status, 200, "{gpu}");
    assert!(gpu.is_null() || gpu["devices"].is_array(), "{gpu}");

    let (status, report) = post(d.port, "machine:readiness", json!(["ja"])).await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["roles"].as_array().unwrap().len(), 4, "{report}");
    assert!(report["catalogVersion"].is_string(), "{report}");
    // The data dir's volume was measured.
    assert!(report["combined"]["diskFreeBytes"].as_f64().unwrap() > 0.0, "{report}");

    // The profile is probed once and saved; the next answer is the saved one.
    let (status, profile) = post(d.port, "machine:profile", json!([])).await;
    assert_eq!(status, 200, "{profile}");
    assert_eq!(profile["format"], json!(1), "{profile}");
    assert!(profile["ramBytes"].as_f64().unwrap() > 0.0, "{profile}");
    assert!(profile["diskFreeBytes"].as_f64().unwrap() > 0.0, "{profile}");
    assert!(dir.join("machine-profile.json").is_file());
    let (_, again) = post(d.port, "machine:profile", json!([])).await;
    assert_eq!(again["probedAt"], profile["probedAt"], "answered from the saved profile");
    let (_, fresh) = post(d.port, "machine:profile", json!([{ "refresh": true }])).await;
    assert!(fresh["probedAt"].as_u64() >= profile["probedAt"].as_u64(), "{fresh}");

    // Whatever this machine is, every task gets a pick from the bundled feed.
    let (status, recs) = post(d.port, "machine:recommendations", json!([])).await;
    assert_eq!(status, 200, "{recs}");
    assert!(recs["feedVersion"].is_string(), "{recs}");
    let tasks = recs["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 5, "{recs}");
    for t in tasks {
        assert!(t["pick"]["modelId"].is_string(), "{t}");
    }
    // The first answer has nothing to compare with: no nudges, and the picks are remembered.
    assert_eq!(recs["nudges"], json!([]), "{recs}");
    assert!(dir.join("recommendations-seen.json").is_file());
    let (status, ok) = post(d.port, "machine:dismissNudge", json!(["code"])).await;
    assert_eq!((status, ok), (200, json!({ "ok": true })));

    // Whether someone is using this machine: input, power and heat, judged.
    let (status, act) = post(d.port, "activity:state", json!([])).await;
    assert_eq!(status, 200, "{act}");
    assert!(act["idleAfterSeconds"].as_f64().unwrap() > 0.0, "{act}");
    assert!(act["present"].is_array() && act["strain"].is_array(), "{act}");
    let (_, strict) = post(d.port, "activity:state", json!([{ "idleAfterSeconds": 1e9 }])).await;
    assert_eq!(strict["idleAfterSeconds"], json!(1e9), "the threshold asked for: {strict}");
    // A Mac always has input to read; a Windows runner's service session may not.
    if cfg!(target_os = "macos") {
        assert!(act["idleSeconds"].as_f64().unwrap() >= 0.0, "{act}");
        assert_eq!(act["headless"], json!(false), "{act}");
    }

    // Whether a full-screen app (a game) is in front: a state, never which app.
    let (status, fs) = post(d.port, "activity:fullscreen", json!([])).await;
    assert_eq!(status, 200, "{fs}");
    let state = fs["state"].as_str().unwrap_or_default();
    assert!(["free", "d3dFullscreen", "busy", "presentation"].contains(&state), "{fs}");
    assert_eq!(fs["quiet"], json!(state == "d3dFullscreen"), "{fs}");
    assert_eq!(fs.as_object().map(|o| o.len()), Some(2), "{fs}");
    if !cfg!(windows) {
        assert_eq!(fs, json!({ "quiet": false, "state": "free" }));
    }

    let (status, body) = post(d.port, "resource:queue", json!(["list", {}])).await;
    assert_eq!((status, body["error"].clone()), (400, json!("Resource queue experiment is disabled")));

    drop(d);
    let _ = std::fs::remove_dir_all(&dir);
}
