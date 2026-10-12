//! A stand-in for whisper.cpp's `whisper-server`, for the voice tests: it
//! takes the same arguments, answers `/health`, and "transcribes" a recording
//! by describing what it was sent.

use axum::body::Bytes;
use axum::http::HeaderMap;
use axum::routing::{get, post};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag =
        |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    let (port, model, threads) = (flag("--port"), flag("-m"), flag("-t"));
    if !std::path::Path::new(&model).is_file() || !args.iter().any(|a| a == "-ng") {
        eprintln!("fake_whisper: bad arguments {args:?}");
        std::process::exit(2);
    }
    let app = axum::Router::new().route("/health", get(|| async { "{\"status\":\"ok\"}" })).route(
        "/inference",
        post(move |headers: HeaderMap, body: Bytes| {
            let threads = threads.clone();
            async move {
                let text = String::from_utf8_lossy(&body);
                let ct = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
                let field = |name: &str| {
                    text.split(&format!("name=\"{name}\"\r\n\r\n"))
                        .nth(1)
                        .and_then(|r| r.split("\r\n").next())
                        .unwrap_or("")
                        .to_string()
                };
                let has_wav = text.contains("filename=\"voice.wav\"")
                    && text.contains("Content-Type: audio/wav")
                    && text.contains("RIFF");
                let said = format!(
                    "  heard wav={has_wav} language={} format={} temperature={} threads={threads} multipart={}  ",
                    field("language"),
                    field("response_format"),
                    field("temperature"),
                    ct.starts_with("multipart/form-data; boundary=")
                );
                axum::Json(serde_json::json!({ "text": said }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.expect("port");
    axum::serve(listener, app).await.expect("serve");
}
