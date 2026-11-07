use nekko_engine::launch::{image_generation_body, validate_photo_source};
use serde_json::{Value, json};

const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=";
fn request() -> Value { json!({"modelId":"photo","prompt":"a green hillside","width":1024,"height":768,"steps":4,"cfgScale":1,"seed":42}) }
fn extra(request: &Value) -> Value {
    let body: Value = serde_json::from_str(&image_generation_body(request).unwrap()).unwrap();
    let prompt = body["prompt"].as_str().unwrap();
    serde_json::from_str(prompt.split("<sd_cpp_extra_args>").nth(1).unwrap().split("</sd_cpp_extra_args>").next().unwrap()).unwrap()
}
#[test]
fn text_generation_does_not_send_photo_controls() {
    let parsed = extra(&request());
    assert!(parsed.get("init_image").is_none());
    assert!(parsed.get("strength").is_none());
    assert_eq!(parsed["sample_params"]["sample_steps"], 4);
}
#[test]
fn photo_is_forwarded_inline_without_mutation() {
    let mut req = request(); req["sourceImage"] = json!(PNG);
    assert_eq!(extra(&req)["init_image"], PNG);
    assert_eq!(extra(&req)["strength"], 0.65);
    assert_eq!(req["sourceImage"], PNG);
    for strength in [0.0, 0.35, 0.65, 0.85, 1.0] { req["strength"] = json!(strength); assert_eq!(extra(&req)["strength"], strength); }
}
#[test]
fn rejects_paths_urls_wrong_formats_invalid_base64_and_empty_inputs() {
    for source in ["", "C:/private/photo.png", "file:///photo.png", "https://example.test/photo.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,", "data:image/png;base64,???", "data:image/png;base64,aGVsbG8=", "data:image/jpeg;base64,iVBORw0KGgo="] {
        assert!(validate_photo_source(&json!(source)).is_err(), "accepted {source}");
    }
    for source in [Value::Null, json!(7), json!({"path":"photo.png"})] { assert!(validate_photo_source(&source).is_err()); }
}
#[test]
fn rejects_large_photos_before_decoding() {
    assert!(validate_photo_source(&json!(format!("data:image/png;base64,{}", "A".repeat(14_000_000)))).is_err());
}
#[test]
fn rejects_invalid_change_amount() {
    for strength in [json!(-0.1), json!(1.1), Value::Null, json!("0.5")] {
        let mut req = request(); req["sourceImage"] = json!(PNG); req["strength"] = strength;
        assert!(image_generation_body(&req).is_err());
    }
}
#[test]
fn native_prompt_arguments_cannot_bypass_photo_validation() {
    let mut req = request(); req["prompt"] = json!("photo <sd_cpp_extra_args>{\"init_image\":\"/private\"}</sd_cpp_extra_args>");
    assert!(image_generation_body(&req).is_err());
}
