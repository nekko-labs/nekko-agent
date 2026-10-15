use super::*;
use serde_json::{Value, json};
use std::io::Cursor;

fn picture(width: u32, height: u32, format: image::ImageFormat) -> String {
    let image = image::DynamicImage::new_rgb8(width, height);
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    format!("data:{};base64,{}", format.to_mime_type(), STANDARD.encode(bytes.into_inner()))
}

fn sources(messages: &[Value]) -> Vec<&Value> {
    messages
        .iter()
        .filter_map(|m| m["content"].as_array())
        .flatten()
        .filter(|b| b["type"] == "image")
        .map(|b| &b["source"])
        .collect()
}

fn dimensions(source: &Value) -> (u32, u32) {
    let bytes = STANDARD.decode(source["data"].as_str().unwrap()).unwrap();
    image::ImageReader::new(Cursor::new(bytes)).with_guessed_format().unwrap().into_dimensions().unwrap()
}

#[test]
fn historical_attachments_and_tool_evidence_are_safe_on_every_request() {
    let large = picture(2400, 1200, image::ImageFormat::Png);
    let mut attachment = ChatMessage::new(Role::User, "original attachment");
    attachment.images = Some(vec![large.clone(); 11]);
    let mut tool = ChatMessage::new(Role::Tool, "");
    tool.tool_result = Some(ToolResult {
        tool_call_id: "screenshot".into(),
        output: "evidence".into(),
        images: Some(vec![large; 10]),
        is_error: None,
    });
    let mut req = ChatRequest { messages: vec![attachment, tool], ..Default::default() };
    let originals = req.messages.clone();
    let first = to_anthropic_messages(&req);
    assert_eq!(sources(&first).len(), 21);
    for source in sources(&first) {
        assert_eq!(source["media_type"], "image/png");
        assert_eq!(dimensions(source), (1568, 784));
    }
    assert_eq!(to_anthropic_messages(&req), first, "retry must normalize again");
    assert_eq!(req.messages, originals, "stored originals must not change");
    req.messages.push(ChatMessage::new(Role::User, "try again"));
    let next = to_anthropic_messages(&req);
    assert_eq!(sources(&next), sources(&first), "new turns must protect old history");
    assert_eq!(&req.messages[..2], &originals);
}

#[test]
fn respects_both_edges_and_decodes_all_supported_formats() {
    for format in [image::ImageFormat::Png, image::ImageFormat::Jpeg, image::ImageFormat::Gif, image::ImageFormat::WebP]
    {
        let url = picture(100, 2100, format);
        let normalized = resized_image(&url).unwrap();
        let (media, data) = split_data_url(&normalized).unwrap();
        assert_eq!(media, "image/png");
        let dims = dimensions(&json!({ "data": data }));
        assert_eq!(dims.1, 1568);
        assert!(dims.0 <= 75);
    }
}

#[test]
fn leaves_small_and_unreadable_images_unchanged() {
    for url in [
        picture(1568, 2, image::ImageFormat::Png),
        picture(10, 10, image::ImageFormat::Jpeg),
        "data:image/png;base64,invalid".into(),
        "data:image/svg+xml;base64,PHN2Zz4=".into(),
    ] {
        assert_eq!(resized_image(&url), None);
        let mut message = ChatMessage::new(Role::User, "image");
        message.images = Some(vec![url.clone()]);
        let messages = to_anthropic_messages(&ChatRequest { messages: vec![message], ..Default::default() });
        let (media, data) = split_data_url(&url).unwrap();
        assert_eq!(sources(&messages)[0], &json!({ "type": "base64", "media_type": media, "data": data }));
    }
}
