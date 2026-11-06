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

/// JPEG quality of a photo opened full size on a phone.
const PHOTO_QUALITY: u8 = 85;

/// `session:photo`: one photo a phone opened, sharp on its screen. The stored
/// data URL when its long side and length are within `photoSide` and
/// `photoChars`; else a JPEG copy with its long side at most `photoSide` px;
/// `Null` when it is not an image this can read or the copy is still too large.
/// Decoding runs off the async runtime.
pub async fn full_photo(stored: Value) -> Value {
    let Value::String(url) = stored else { return Value::Null };
    tokio::task::spawn_blocking(move || full_size(&url).map_or(Value::Null, Value::String)).await.unwrap_or(Value::Null)
}

fn full_size(data_url: &str) -> Option<String> {
    let rest = data_url.strip_prefix("data:")?;
    let (media, data) = rest.split_once(";base64,")?;
    if !matches!(media, "image/png" | "image/jpeg" | "image/gif" | "image/webp") || data.is_empty() {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    let reader = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format().ok()?;
    let side = policy().photo_side;
    let (w, h) = reader.into_dimensions().ok()?;
    if w.max(h) <= side && data_url.len() <= policy().photo_chars {
        return Some(data_url.to_string());
    }
    // ImageReader applies its default allocation limits to untrusted input.
    let image = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format().ok()?.decode().ok()?;
    let image = if image.width().max(image.height()) > side {
        image.resize(side, side, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, PHOTO_QUALITY).encode_image(&image.to_rgb8()).ok()?;
    let url = format!("data:image/jpeg;base64,{}", STANDARD.encode(out.into_inner()));
    (url.len() <= policy().photo_chars).then_some(url)
}

/// `thumbnailPhoneImages`: the newest photos among the messages a phone will
/// receive, as thumbnails; every other photo `""`. Decoding runs off the
/// async runtime.
pub async fn thumbnail_images(session: Value) -> Value {
    let Value::Object(mut s) = session else { return session };
    // Taken in place, so the chat keeps its key order (the TS spreads it).
    let Some(Value::Array(slot)) = s.get_mut("messages") else { return Value::Object(s) };
    let mut messages = std::mem::take(slot);
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
    if let Some(Value::Array(slot)) = s.get_mut("messages") {
        *slot = messages;
    }
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

    #[tokio::test]
    async fn a_full_photo_is_the_original_when_it_fits_else_a_large_jpeg() {
        let small = photo(1200, 800);
        assert_eq!(full_photo(json!(small.clone())).await, json!(small), "kept as stored, PNG and all");
        let big = full_photo(json!(photo(4000, 3000))).await;
        let big = big.as_str().unwrap();
        assert!(big.starts_with("data:image/jpeg;base64,"));
        assert_eq!(size(big), (policy().photo_side, 1536));
        assert_eq!(full_photo(json!("data:image/png;base64,bm90IGFuIGltYWdl")).await, Value::Null);
        assert_eq!(full_photo(json!("data:text/plain;base64,aGk=")).await, Value::Null);
        assert_eq!(full_photo(Value::Null).await, Value::Null);
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
