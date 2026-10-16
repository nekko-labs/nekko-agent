//! A stand-in for stable-diffusion.cpp's `sd-server`, for the image-turn
//! tests: it takes the same arguments (`--diffusion-model` or `--model`,
//! `--listen-ip`, `--listen-port`), answers `/v1/models` (the health check
//! the model server uses for image models) and `/v1/images/generations` with
//! one tiny "image" that is the prompt field and size it was sent. A
//! prompt containing `slow` is answered after 30 seconds, so a test can stop
//! the turn while it waits.

use axum::Json;
use axum::routing::{get, post};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag =
        |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    let model = if flag("--diffusion-model").is_empty() { flag("--model") } else { flag("--diffusion-model") };
    let port = flag("--listen-port");
    if port.is_empty() || !std::path::Path::new(&model).is_file() {
        eprintln!("fake_sd_server: bad arguments {args:?}");
        std::process::exit(2);
    }
    let app = axum::Router::new()
        .route("/v1/models", get(|| async { Json(json!({ "object": "list", "data": [{ "id": "sd" }] })) }))
        .route(
            "/v1/images/generations",
            post(|body: Json<Value>| async move {
                let prompt = body.0["prompt"].as_str().unwrap_or_default().to_string();
                if prompt.contains("slow") {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                // The prompt as sent: the text, then `<sd_cpp_extra_args>` with the
                // steps, guidance and seed, and the size as `size`.
                let said = format!("{prompt}|{}", body.0["size"].as_str().unwrap_or(""));
                let b64 = base64(said.as_bytes());
                Json(json!({ "created": 1, "data": [{ "b64_json": b64 }] }))
            }),
        );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port.parse::<u16>().unwrap())).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
