//! A chat's photos as a phone sees them: `thumbnailPhoneImages` and
//! `phoneThumbnail` (packages/shared/src/phone-access.ts,
//! packages/core/src/phone-thumbnails.ts). Small JPEGs, the long side at most
//! `PHONE_SESSION_VIEW.thumbSide` px, made only for the copy sent to a phone.
//! The pixels need not match the TS edition byte for byte; the shape does:
//! the same count per message, `""` for any photo not sent.

use crate::phone::policy;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};

const QUALITY: u8 = 70;
const CACHE_MAX: usize = 200;

/// Thumbnails by the photo's hash, and the order they were made in.
type Cache = (HashMap<[u8; 32], String>, VecDeque<[u8; 32]>);

/// Thumbnails already made: a phone re-reads a chat often.
fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// One photo as a phone thumbnail, or `""` when it is not an image this can
/// read or the result is still too large.
pub fn thumbnail(data_url: &str) -> String {
    let key: [u8; 32] = Sha256::digest(data_url.as_bytes()).into();
    if let Some(hit) = cache().lock().unwrap().0.get(&key) {
        return hit.clone();
    }
    let out = make(data_url).unwrap_or_default();
    let mut c = cache().lock().unwrap();
    if c.0.insert(key, out.clone()).is_none() {
        c.1.push_back(key);
        if c.1.len() > CACHE_MAX
            && let Some(old) = c.1.pop_front()
        {
            c.0.remove(&old);
        }
    }
    out
}

fn make(data_url: &str) -> Option<String> {
    let rest = data_url.strip_prefix("data:")?;
    let (media, data) = rest.split_once(";base64,")?;
    if !matches!(media, "image/png" | "image/jpeg" | "image/gif" | "image/webp") || data.is_empty() {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    // ImageReader applies its default allocation limits to untrusted input.
    let image = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format().ok()?.decode().ok()?;
    let side = policy().thumb_side;
    let image = if image.width().max(image.height()) > side {
        image.resize(side, side, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, QUALITY).encode_image(&image.to_rgb8()).ok()?;
    let url = format!("data:image/jpeg;base64,{}", STANDARD.encode(out.into_inner()));
    (url.len() <= policy().thumb_chars).then_some(url)
}

/// `thumbnailPhoneImages`: the newest photos among the messages a phone will
/// receive, as thumbnails; every other photo `""`. Decoding runs off the
/// async runtime.
pub async fn thumbnail_images(session: Value) -> Value {
    let Value::Object(mut s) = session else { return session };
    let Some(Value::Array(mut messages)) = s.remove("messages") else { return Value::Object(s) };
    let from = messages.len().saturating_sub(policy().session_messages);
    let mut room = policy().session_images;
    for m in messages[from..].iter_mut().rev() {
        let Some(Value::Array(imgs)) = m.get("images") else { continue };
        if imgs.is_empty() {
            continue;
        }
        let mut out = vec![Value::Null; imgs.len()];
        let mut todo = Vec::new();
        for (j, v) in imgs.iter().enumerate().rev() {
            match v.as_str() {
                Some(u) if room > 0 && !u.is_empty() => {
                    room -= 1;
                    todo.push((j, u.to_string()));
                }
                _ => out[j] = json!(""),
            }
        }
        let made =
            tokio::task::spawn_blocking(move || todo.into_iter().map(|(j, u)| (j, thumbnail(&u))).collect::<Vec<_>>())
                .await
                .unwrap_or_default();
        for (j, t) in made {
            out[j] = json!(t);
        }
        for v in out.iter_mut() {
            if v.is_null() {
                *v = json!("");
            }
        }
        if let Value::Object(o) = m {
            o.insert("images".into(), Value::Array(out));
        }
    }
    s.insert("messages".into(), Value::Array(messages));
    Value::Object(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(w: u32, h: u32) -> String {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([109, 94, 252]));
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img).write_to(&mut out, image::ImageFormat::Png).unwrap();
        format!("data:image/png;base64,{}", STANDARD.encode(out.into_inner()))
    }

    fn size(url: &str) -> (u32, u32) {
        let bytes = STANDARD.decode(url.split_once(',').unwrap().1).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn shrinks_to_a_small_jpeg_and_never_enlarges() {
        let t = thumbnail(&photo(1600, 900));
        assert!(t.starts_with("data:image/jpeg;base64,"));
        assert_eq!(size(&t), (policy().thumb_side, 216));
        assert_eq!(size(&thumbnail(&photo(40, 30))), (40, 30));
    }

    #[test]
    fn unreadable_is_empty() {
        assert_eq!(thumbnail("data:image/png;base64,bm90IGFuIGltYWdl"), "");
        assert_eq!(thumbnail("data:text/plain;base64,aGk="), "");
        assert_eq!(thumbnail("https://example.com/a.png"), "");
    }

    #[tokio::test]
    async fn only_the_photos_a_phone_gets_keep_their_count() {
        let p = photo(10, 10);
        let s = json!({ "id": "s", "messages": [
            { "id": "a", "role": "user", "content": "", "images": [p, "data:image/png;base64,eA==", 3] },
            { "id": "b", "role": "assistant", "content": "ok" },
        ] });
        let out = thumbnail_images(s).await;
        let imgs = out["messages"][0]["images"].as_array().unwrap();
        assert_eq!(imgs.len(), 3);
        assert!(imgs[0].as_str().unwrap().starts_with("data:image/jpeg;base64,"));
        assert_eq!(imgs[1], "");
        assert_eq!(imgs[2], "");
        assert!(out["messages"][1].get("images").is_none());
    }
}
