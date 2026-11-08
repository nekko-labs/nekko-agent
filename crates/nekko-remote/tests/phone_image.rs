//! Phone image payload and redaction parity with the shared TS implementation.
use nekko_remote::{phone, phone_image};
use serde_json::{Value, json};

#[test]
fn phone_image_matches_ts_golden() {
    let cases: Value = serde_json::from_str(include_str!("golden/phone-image.json")).unwrap();
    for case in cases["requests"].as_array().unwrap() {
        assert_eq!(json!(phone_image::request_problem(&case["input"])), case["problem"], "{case}");
        let screened = phone::screen("chat:generateImage", &[case["input"].clone()]);
        assert_eq!(screened.is_ok(), case["problem"].is_null(), "{case}");
        if let Err(e) = screened {
            assert_eq!(e.detail, case["problem"].as_str().unwrap());
        }
    }
    for case in cases["params"].as_array().unwrap() {
        assert_eq!(json!(phone_image::params_problem(&case["input"], false)), case["problem"], "{case}");
        assert_eq!(
            phone::screen("session:setOptions", &[json!("s_img"), json!({ "imageParams": case["input"] })]).is_ok(),
            case["problem"].is_null(),
            "{case}"
        );
    }
    assert_eq!(phone::redact("engine:models", cases["models"]["input"].clone()), cases["models"]["output"]);
    assert_eq!(phone::redact("chat:generateImage", json!({ "path": "/private", "images": ["huge"] })), Value::Null);
}

#[test]
fn phone_image_fractional_cfg_cannot_cross_the_phone_boundary_but_local_desktop_still_works() {
    let opts = json!({ "sessionId": "s_img", "prompt": "cat", "params": {
        "modelId": "image/sd", "width": 512, "height": 512, "steps": 28, "cfgScale": 4.5, "seed": -1
    }});
    assert_eq!(phone_image::request_problem(&opts), Some("cfgScale".into()));
    assert!(phone::screen("chat:generateImage", &[opts.clone()]).is_err());
    assert_eq!(phone_image::host_request_problem(&opts), None);
    assert_eq!(opts["params"]["cfgScale"], 4.5, "never round or mutate a request");
}

#[test]
fn phone_image_edit_photos_fit_one_relay_frame_but_the_desktop_has_no_frame_cap() {
    // Exactly what the desktop's photo edit sends (ChatPane sendImage): the chat's saved
    // params, fractional CFG included, four photos and the edit's size.
    let photo = format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024));
    let desktop = json!({ "sessionId": "s_img", "prompt": "make it blue", "params": {
        "modelId": "image/flux2-klein", "width": 1024, "height": 1024, "steps": 4, "cfgScale": 4.5, "seed": -1
    }, "images": [photo, photo, photo, photo], "size": { "width": 832, "height": 1216 } });
    assert_eq!(phone_image::host_request_problem(&desktop), None);
    let mut phone = desktop.clone();
    phone["params"]["cfgScale"] = json!(4);
    assert_eq!(phone_image::request_problem(&phone), Some("images".into()), "over the phone's frame budget");
    phone["images"] = json!([photo, photo]);
    assert_eq!(phone_image::request_problem(&phone), None);
    assert!(phone::screen("chat:generateImage", &[phone]).is_ok());
    // The host keeps every other photo and size rule.
    for (key, value) in [
        ("images", json!(["data:image/svg+xml;base64,PHN2Zz4="])),
        ("images", json!(["/Users/me/photo.png"])),
        ("images", json!(vec![json!("data:image/png;base64,AAAA"); 5])),
        ("size", json!({ "width": 832, "height": 1216, "depth": 1 })),
        ("size", json!({ "width": 830, "height": 1216 })),
    ] {
        let mut bad = desktop.clone();
        bad[key] = value;
        assert_eq!(phone_image::host_request_problem(&bad), Some(key.into()), "{key}: {}", bad[key]);
    }
}

#[test]
fn phone_image_has_no_install_fetch_or_upload_authority() {
    for c in [
        "engine:install",
        "engine:removeModel",
        "engine:downloadModel",
        "engine:generateImage",
        "file:read",
        "image:fetch",
    ] {
        assert!(!phone::channel_allowed(c), "{c}");
    }
    assert!(phone::screen("engine:models", &[]).is_ok());
    assert!(phone::screen("engine:models", &[json!({"path": "/private"})]).is_err());
    assert!(
        phone::screen(
            "session:setOptions",
            &[json!("s_img"), json!({"chatType": "image", "imageParams": {"cfgScale": 4}})]
        )
        .is_ok()
    );
    assert!(phone::screen("session:setOptions", &[json!("s_img"), json!({"chatType": "video"})]).is_err());
    assert!(phone::screen("session:setOptions", &[json!("s_img"), json!({"arbitrary": true})]).is_err());
}

#[tokio::test]
async fn phone_image_photos_are_scoped_raster_data_only_and_decoder_checked() {
    // Real persisted generated attachment shape: assistant.images plus generated metadata.
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=";
    let s = json!({ "id": "s_img", "messages": [
        { "id": "u", "role": "user", "images": [png] },
        { "id": "a", "role": "assistant", "images": [png], "generated": {"modelId": "image/sd"} },
        { "id": "t", "role": "tool", "images": [png] },
        { "id": "paths", "role": "assistant", "images": ["/private/image.png", "https://example.com/photo.png", "data:image/svg+xml;base64,PHN2Zz4=", {"path": "/private"}], "attachedPaths": ["/private/image.png"] }
    ] });
    assert_eq!(phone_image::photo(&s, "a", 0), png);
    assert_eq!(phone_image::photo(&s, "u", 0), png);
    assert_eq!(phone_image::photo(&s, "t", 0), Value::Null);
    for i in 0..5 {
        assert_eq!(phone_image::photo(&s, "paths", i), Value::Null);
    }
    assert_eq!(phone_image::photo(&s, "missing", 0), Value::Null);
    assert_eq!(phone_image::photo(&s, "a", 1), Value::Null);
    assert_eq!(phone_image::photo(&json!({"messages": []}), "a", 0), Value::Null);
    assert_eq!(nekko_remote::phone_thumbs::full_photo(phone_image::photo(&s, "a", 0)).await, png);
    assert_eq!(nekko_remote::phone_thumbs::full_photo(json!("data:image/png;base64,not-image")).await, Value::Null);
}
