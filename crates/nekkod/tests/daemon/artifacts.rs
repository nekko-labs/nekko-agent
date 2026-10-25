//! Agent-linked files and previews through the real daemon, with isolated data and loopback only.
use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn artifact_channels_check_the_persisted_chats_assistant_links() {
    let data = tempfile::tempdir().unwrap();
    let root = data.path().to_string_lossy().replace('\\', "/");
    std::fs::create_dir(data.path().join("sessions")).unwrap();
    std::fs::create_dir(data.path().join("site")).unwrap();
    std::fs::write(data.path().join("site/index.html"), "<h1>report</h1>").unwrap();
    std::fs::write(data.path().join("site/app.css"), "body{}").unwrap();
    std::fs::write(data.path().join("unlinked.md"), "private").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, axum::Router::new().route("/", axum::routing::get(|| async { "preview" })))
            .await
            .unwrap();
    });
    let chat = json!({ "id": "s_links", "title": "Artifacts", "messages": [
        { "role": "user", "content": format!("[not shared]({root}/unlinked.md) http://localhost:1") },
        { "role": "assistant", "content": format!("[report]({root}/site/index.html) http://localhost:{port}/") }
    ] });
    std::fs::write(data.path().join("sessions/s_links.json"), serde_json::to_vec(&chat).unwrap()).unwrap();
    let d = start_with(Some(data.path()));
    for (name, content) in [("index.html", "<h1>report</h1>"), ("app.css", "body{}")] {
        let (status, got) =
            post(d.port, "artifact:read", json!(["s_links", format!("{root}/site/{name}")]), Some(TOKEN)).await;
        assert_eq!(status, 200, "{got}");
        assert_eq!(got["content"], content);
    }
    for (channel, args, error) in [
        ("artifact:read", json!(["s_links", format!("{root}/unlinked.md")]), "not-linked:"),
        ("artifact:read", json!(["missing", format!("{root}/site/index.html")]), "not-found:"),
        ("preview:fetch", json!(["s_links", "http://localhost:1/"]), "not-linked:"),
    ] {
        let (status, got) = post(d.port, channel, args, Some(TOKEN)).await;
        assert_eq!(status, 400, "{got}");
        assert!(got["error"].as_str().unwrap().starts_with(error), "{got}");
    }
    let (status, got) =
        post(d.port, "preview:fetch", json!(["s_links", format!("http://localhost:{port}/")]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["status"], 200);
    assert_eq!(got["base64"], "cHJldmlldw==");
    drop(d);
    server.abort();
}
