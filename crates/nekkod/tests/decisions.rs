//! The real daemon serves `decisions:*` itself when it knows the data
//! directory: with no TS backend at all, the catalog, the status and an export
//! folder (saved through the daemon's settings store) all answer.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

const TOKEN: &str = "decisions-test-token-0123456789";

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
async fn decisions_are_served_by_the_daemon() {
    let dir = std::env::temp_dir().join(format!("nekkod-decisions-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let export = dir.join("export");
    std::fs::create_dir_all(&export).unwrap();
    for (f, text) in [("model_int8.onnx", "graph"), ("tokenizer.json", "{}"), ("rl_agent_config.json", "{}")] {
        std::fs::write(export.join(f), text).unwrap();
    }
    let d = start(&dir);

    let (status, catalog) = post(d.port, "decisions:catalog", json!([])).await;
    assert_eq!((status, catalog[0]["id"].clone()), (200, json!("laya-en")));

    let (_, s) = post(d.port, "decisions:status", json!([])).await;
    assert_eq!(s, json!({ "local": { "available": true, "loaded": false }, "typesafe": { "configured": false } }));

    let (_, added) = post(d.port, "decisions:addFolder", json!([export])).await;
    assert_eq!(added["ok"], json!(true), "{added}");
    // Saved through the daemon's settings store.
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["decisionModelDirs"].as_array().unwrap().len(), 1, "{saved}");
    let (_, models) = post(d.port, "decisions:models", json!([])).await;
    assert_eq!(models[0]["precisions"], json!(["int8"]), "{models}");

    // Loading the stand-in graph fails in ONNX Runtime, and says so.
    let (_, load) = post(d.port, "decisions:load", json!([models[0]["id"]])).await;
    assert_eq!(load["ok"], json!(false), "{load}");

    let (status, body) = post(d.port, "decisions:run", json!(["local", { "state": "", "questions": {} }])).await;
    assert_eq!((status, body["error"].clone()), (400, json!("The state is empty.")));

    drop(d);
    let _ = std::fs::remove_dir_all(&dir);
}
