//! A stand-in for llama.cpp's `llama-server`, for the model-server tests: it
//! prints a `--help` with the newer flags and a `--version`, takes the same
//! arguments, says it is loading for a moment on `/health`, and answers chat
//! completions by naming the model it was started with and the flags it got.

use axum::Json;
use axum::routing::{get, post};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        println!(
            "usage: llama-server [options]\n  --model FNAME\n  --alias NAME\n  --port N\n  --ctx-size N\n  --cache-reuse N\n  --no-cache-idle-slots\n  --spec-default\n  --jinja"
        );
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("version: 4242 (b4242)\nbuilt with a test harness");
        return;
    }
    let flag =
        |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    let (port, alias, model) = (flag("--port"), flag("--alias"), flag("--model"));
    if port.is_empty() || !std::path::Path::new(&model).is_file() {
        eprintln!("fake_llama_server: bad arguments {args:?}");
        std::process::exit(2);
    }
    let started = Instant::now();
    let seen = args.clone();
    let app = axum::Router::new()
        .route(
            "/health",
            get(move || async move {
                if started.elapsed() < Duration::from_millis(300) {
                    Json(json!({ "status": "loading model" }))
                } else {
                    Json(json!({ "status": "ok" }))
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move |body: Json<Value>| {
                let (alias, seen) = (alias.clone(), seen.clone());
                async move {
                    Json(json!({
                        "object": "chat.completion",
                        "model": alias,
                        "choices": [{ "index": 0, "message": { "role": "assistant", "content": format!("asked for {} with {}", body.0["model"], seen.join(" ")) } }],
                    }))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port.parse::<u16>().unwrap())).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
