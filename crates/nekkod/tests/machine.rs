//! The real daemon serves the machine channels itself: with no TS backend at
//! all, `gpu:stats`, `system:stats` and `machine:readiness` still answer, and
//! `resource:queue` reads its gate from the data directory.

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
        .env("NEKKOD_CONFIG", config.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("nekkod starts");
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

    let (_, info) = post(d.port, "daemon:info", json!([])).await;
    let owned = info["owned"].as_array().unwrap();
    for c in ["gpu:stats", "system:stats", "machine:readiness", "resource:queue"] {
        assert!(owned.iter().any(|o| o == c), "{c} in {info}");
    }

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

    let (status, body) = post(d.port, "resource:queue", json!(["list", {}])).await;
    assert_eq!((status, body["error"].clone()), (400, json!("Resource queue experiment is disabled")));

    drop(d);
    let _ = std::fs::remove_dir_all(&dir);
}
