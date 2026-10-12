//! The real daemon runs the runtime control plane itself: with no TS backend,
//! a loopback stand-in for Ollama is read, planned against, loaded into and
//! (politely) not stopped.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const TOKEN: &str = "runtimes-test-token-0123456789";

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
    let config = json!({ "token": TOKEN, "backend": null, "allowedOrigins": ["null"], "dataDir": data_dir });
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

/// A loopback Ollama: one model on disk, resident, with its geometry.
async fn fake_ollama(seen: Arc<Mutex<Vec<String>>>) -> u16 {
    use axum::routing::{get, post};
    let s1 = seen.clone();
    let app = axum::Router::new()
        .route("/api/version", get(|| async { axum::Json(json!({ "version": "0.12.3" })) }))
        .route("/api/tags", get(|| async { axum::Json(json!({ "models": [{ "name": "tiny:1b", "size": 800_000_000 }] })) }))
        .route(
            "/api/ps",
            get(|| async { axum::Json(json!({ "models": [{ "name": "tiny:1b", "size": 900_000_000, "size_vram": 900_000_000, "context_length": 4096 }] })) }),
        )
        .route(
            "/api/show",
            post(|| async {
                axum::Json(json!({ "details": { "parameter_size": "1B", "quantization_level": "Q4_K_M" }, "model_info": { "llama.block_count": 16, "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8, "llama.embedding_length": 2048, "llama.context_length": 131072 } }))
            }),
        )
        .route(
            "/api/generate",
            post(move |body: String| {
                s1.lock().unwrap().push(body);
                async { axum::Json(json!({})) }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn the_control_plane_runs_in_the_daemon() {
    let dir = std::env::temp_dir().join(format!("nekkod-runtimes-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let ollama = fake_ollama(seen.clone()).await;
    let settings = json!({ "providers": [
        { "id": "ollama", "kind": "ollama", "name": "Ollama", "baseUrl": format!("http://127.0.0.1:{ollama}") },
        { "id": "cloud", "kind": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1" }
    ] });
    std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
    let d = start(&dir);

    let (_, info) = post(d.port, "daemon:info", json!([])).await;
    for c in ["runtime:status", "runtime:plan", "model:load", "server:stop", "lms:probe"] {
        assert!(info["owned"].as_array().unwrap().iter().any(|o| o == c), "{c} in {info}");
    }

    let (status, s) = post(d.port, "runtime:status", json!(["ollama"])).await;
    assert_eq!(status, 200);
    assert_eq!(
        (s["running"].clone(), s["version"].clone(), s["owned"].clone()),
        (json!(true), json!("0.12.3"), json!(false)),
        "{s}"
    );
    assert_eq!(s["resident"][0]["id"], "tiny:1b");

    let (_, facts) = post(d.port, "runtime:facts", json!(["ollama"])).await;
    assert_eq!((facts[0]["layers"].clone(), facts[0]["headDim"].clone()), (json!(16), json!(64)), "{facts}");

    let (_, plan) = post(d.port, "runtime:plan", json!(["ollama", "tiny:1b", null])).await;
    assert!(plan["verdict"].is_string(), "{plan}");
    let (_, fit) = post(d.port, "runtime:autoFit", json!(["ollama", "tiny:1b", 0.5, 1])).await;
    assert!(fit["headline"].is_string(), "{fit}");

    let (_, loaded) = post(d.port, "runtime:load", json!(["ollama", "tiny:1b", { "contextTokens": 4096 }])).await;
    assert_eq!(loaded, json!({ "ok": true, "message": "Loaded tiny:1b" }));
    let (_, page) = post(d.port, "model:load", json!(["ollama", "tiny:1b"])).await;
    assert_eq!(page, json!({ "ok": true }));
    let bodies = seen.lock().unwrap().clone();
    assert!(bodies.iter().any(|b| b.contains("\"num_ctx\":4096")), "{bodies:?}");
    assert!(bodies.iter().any(|b| b.contains("\"keep_alive\":\"30m\"")), "{bodies:?}");

    // Not ours: stopping it needs a yes.
    let (_, stop) = post(d.port, "runtime:stop", json!(["ollama"])).await;
    assert_eq!(stop["needsConfirmation"], json!(true), "{stop}");
    let (_, probe) = post(d.port, "lms:probe", json!(["ollama"])).await;
    assert_eq!(probe, json!({ "available": false }));
    let (_, cloud) = post(d.port, "server:stop", json!(["cloud"])).await;
    assert_eq!(cloud["ok"], json!(false));
    let (_, none) = post(d.port, "runtime:status", json!(["cloud"])).await;
    assert_eq!(none, Value::Null);

    drop(d);
    let _ = std::fs::remove_dir_all(&dir);
}
