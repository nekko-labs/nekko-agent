use nekko_turn::variants::{image_reply, start_image_turn};
use serde_json::json;

#[test]
fn starting_photo_is_saved_on_message_not_in_settings() {
    let source = "data:image/png;base64,fixture";
    let params = json!({"modelId":"photo", "width":1024,"height":768,"steps":4,"cfgScale":1,"seed":-1,"strength":0.35});
    let mut session = json!({"title":"New chat","messages":[]});
    let start = start_image_turn(&mut session, &json!({"prompt":"a snowy hillside", "params":params, "sourceImage":source}), 100, 123).unwrap();
    assert_eq!(start.request["sourceImage"], source);
    assert_eq!(start.request["strength"], 0.35);
    let reply = image_reply(&json!({ "images": ["new-image"] }), &start.request, &start.seed, 50, 100);
    assert_eq!(reply["generated"]["fromPhoto"], true);
    assert_eq!(reply["generated"]["strength"], 0.35);
    assert!(reply["generated"].get("sourceImage").is_none());
    assert_eq!(session["messages"][0]["images"], json!([source]));
    assert_eq!(session["imageParams"], params);
    assert!(session["imageParams"].get("sourceImage").is_none());
    // A new text-only turn must not silently reuse the previous source.
    let next = start_image_turn(&mut session, &json!({"prompt":"a blue sky","params":params}), 101, 124).unwrap();
    assert!(next.request.get("sourceImage").is_none());
    assert!(session["messages"][1].get("images").is_none());
}
