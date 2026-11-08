//! #2162: host support is distinct from readiness, and bad input never starts a turn.
use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn image_boundary_host_api_refuses_invalid_requests_without_saving_or_loading() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path();
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    // Avoid discovery of the user's model folders; this sandbox has no runtime/models.
    std::fs::write(data.join("settings.json"), json!({"engine": {"modelFolders": []}}).to_string()).unwrap();
    let image = json!({"id": "s_img", "chatType": "image", "title": "New chat", "messages": []});
    let text = json!({"id": "s_text", "chatType": "multimodal", "title": "New chat", "messages": []});
    std::fs::write(data.join("sessions/s_img.json"), image.to_string()).unwrap();
    std::fs::write(data.join("sessions/s_text.json"), text.to_string()).unwrap();
    let d = start_with(data);
    let (_, info) = post(d.port, "app:info", json!([]), Some(TOKEN)).await;
    assert_eq!(info["capabilities"]["imageGeneration"], true, "support even with no installed runtime/model");
    let params =
        json!({"modelId": "image/missing", "width": 512, "height": 512, "steps": 28, "cfgScale": 4, "seed": -1});
    let valid = json!({"sessionId": "s_img", "prompt": "cat", "params": params});
    for args in [
        json!([]),
        json!([valid, {}]),
        json!([null]),
        json!([{ "sessionId": "s_img", "prompt": "cat", "params": params, "providerId": "cloud" }]),
        json!([{ "sessionId": "../private", "prompt": "cat", "params": params }]),
        json!([{ "sessionId": "s_img", "prompt": " ", "params": params }]),
    ] {
        let (_, body) = post(d.port, "chat:generateImage", args.clone(), Some(TOKEN)).await;
        assert!(body["error"].as_str().is_some_and(|s| s.starts_with("Invalid image request:")), "{args}: {body}");
    }
    for (key, value) in [
        ("cfgScale", json!(30.5)),
        ("width", json!(257)),
        ("steps", json!(101)),
        ("seed", json!(2147483648u64)),
        ("outputPath", json!("/private")),
        ("modelId", json!("https://cloud/model")),
    ] {
        let mut opts = valid.clone();
        opts["params"][key] = value;
        let (_, body) = post(d.port, "chat:generateImage", json!([opts]), Some(TOKEN)).await;
        assert!(body["error"].as_str().is_some_and(|s| s.starts_with("Invalid image request:")), "{key}: {body}");
    }
    let (_, missing_model) = post(d.port, "chat:generateImage", json!([valid]), Some(TOKEN)).await;
    assert_eq!(missing_model["error"], "Choose an installed local image-generation model.");
    let mut wrong_chat = valid.clone();
    wrong_chat["sessionId"] = json!("s_text");
    let (_, wrong_chat) = post(d.port, "chat:generateImage", json!([wrong_chat]), Some(TOKEN)).await;
    assert_eq!(wrong_chat["error"], "Choose an image chat before generating an image.");
    for (id, expected) in [("s_img", image), ("s_text", text)] {
        let (_, saved) = post(d.port, "session:get", json!([id]), Some(TOKEN)).await;
        assert_eq!(saved, expected, "no transcript/title/model mutation before preflight");
    }
    let (_, running) = post(d.port, "chat:running", json!([]), Some(TOKEN)).await;
    assert_eq!(running, json!([]));
    drop(d);
}

#[tokio::test(flavor = "multi_thread")]
async fn image_boundary_host_photo_returns_only_this_messages_inline_raster_attachment() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("sessions")).unwrap();
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=";
    let chat = json!({"id": "s_img", "chatType": "image", "messages": [
        {"id": "assistant", "role": "assistant", "images": [png], "generated": {"modelId": "image/sd"}},
        {"id": "user", "role": "user", "images": [png]},
        {"id": "tool", "role": "tool", "images": [png]},
        {"id": "unsafe", "role": "assistant", "images": ["/private/photo.png", "https://example.com/photo.png", "data:image/svg+xml;base64,PHN2Zz4=", {"path": "/private/photo.png"}], "attachedPaths": ["/private/photo.png"]}
    ]});
    std::fs::write(root.path().join("sessions/s_img.json"), chat.to_string()).unwrap();
    let d = start_with(root.path());
    for message in ["assistant", "user"] {
        let (_, photo) = post(d.port, "session:photo", json!(["s_img", message, 0]), Some(TOKEN)).await;
        assert_eq!(photo, png);
    }
    for args in [
        json!(["s_other", "assistant", 0]),
        json!(["s_img", "missing", 0]),
        json!(["s_img", "assistant", 1]),
        json!(["s_img", "tool", 0]),
        json!(["s_img", "unsafe", 0]),
        json!(["s_img", "unsafe", 1]),
        json!(["s_img", "unsafe", 2]),
        json!(["s_img", "unsafe", 3]),
    ] {
        let (_, photo) = post(d.port, "session:photo", args, Some(TOKEN)).await;
        assert_eq!(photo, Value::Null);
    }
    drop(d);
}
