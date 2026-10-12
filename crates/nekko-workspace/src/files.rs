//! The in-app file explorer, viewer and editor, ported from
//! `packages/host/src/files.ts`: `file:read`, `file:write`, `dir:list`.
//!
//! These are driven by the user's own clicks, so like the TS functions they
//! are not jailed to a workspace: the user browses and edits their own files.
//! Sandbox chats never reach them (the agent's file tools are separate).

use nekko_js as js;
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use serde_json::{Value, json};

/// Editor read cap (1 MB): larger files load partially.
const MAX_READ: usize = 1_000_000;
/// Images above this are not inlined.
const MAX_IMAGE: u64 = 8_000_000;

fn image_mime(p: &str) -> Option<&'static str> {
    match path::extname(p).to_lowercase().as_str() {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        _ => None,
    }
}

/// Does the content start the way its extension says it should?
fn has_signature(mime: &str, buf: &[u8]) -> bool {
    match mime {
        "image/png" => buf.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => buf.len() >= 3 && buf[0] == 255 && buf[1] == 216 && buf[2] == 255,
        "image/gif" => buf.starts_with(b"GIF87a") || buf.starts_with(b"GIF89a"),
        "image/webp" => buf.len() >= 12 && &buf[..4] == b"RIFF" && &buf[8..12] == b"WEBP",
        _ => false,
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn empty(truncated: bool, binary: bool) -> Value {
    json!({ "content": "", "truncated": truncated, "binary": binary })
}

/// `readFile(path)`: text up to 1 MB, flagged binary when it holds a NUL
/// byte; a real PNG, JPEG, GIF or WebP up to 8 MB comes back as a data URL.
/// A missing path or a directory reads as empty.
pub fn read_file(p: &str) -> Result<Value, String> {
    let Ok(meta) = std::fs::metadata(p) else { return Ok(empty(false, false)) };
    if meta.is_dir() {
        return Ok(empty(false, false));
    }
    let mime = image_mime(p);
    if mime.is_some() && meta.len() > MAX_IMAGE {
        return Ok(empty(true, true));
    }
    let buf = std::fs::read(p).map_err(|e| format!("{}: {}, open '{p}'", nodefs::code_name(&e), describe(&e)))?;
    if let Some(mime) = mime.filter(|m| has_signature(m, &buf)) {
        return Ok(json!({
            "content": "",
            "binary": true,
            "truncated": false,
            "imageDataUrl": format!("data:{mime};base64,{}", base64(&buf)),
        }));
    }
    let slice = &buf[..buf.len().min(MAX_READ)];
    if slice.contains(&0) {
        return Ok(empty(false, true));
    }
    Ok(json!({
        "content": String::from_utf8_lossy(slice),
        "truncated": buf.len() > MAX_READ,
        "binary": false,
    }))
}

/// libuv's description of an error, for Node's message shape.
fn describe(e: &std::io::Error) -> &'static str {
    match nodefs::code_name(e) {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "EPERM" => "operation not permitted",
        "EISDIR" => "illegal operation on a directory",
        "EBUSY" => "resource busy or locked",
        _ => "i/o error",
    }
}

/// `writeFile(path, content)`: creates the parent folders first.
pub fn write_file(p: &str, content: &Value) -> Result<(), String> {
    nodefs::mkdir_p(&path::dirname(p))?;
    let Value::String(content) = content else {
        return Err(format!(
            "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received {}",
            received(content)
        ));
    };
    nodefs::write_utf8(p, content)
}

/// How Node's ERR_INVALID_ARG_TYPE names a value it got.
fn received(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => format!("type boolean ({b})"),
        Value::Number(n) => format!("type number ({})", js::number_to_string(n.as_f64().unwrap_or(0.0))),
        Value::Array(_) => "an instance of Array".into(),
        Value::Object(_) => "an instance of Object".into(),
        Value::String(_) => "type string".into(),
    }
}

/// `listDir(path)`: folders first, then files, each by `localeCompare`. A
/// missing path lists nothing.
pub fn list_dir(p: &str) -> Result<Value, String> {
    if !nodefs::exists(p) {
        return Ok(json!([]));
    }
    let mut entries: Vec<(String, bool)> = nodefs::read_dir(p)?.into_iter().map(|e| (e.name, e.is_dir)).collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| js::locale_compare(&a.0, &b.0)));
    Ok(Value::Array(
        entries
            .into_iter()
            .map(|(name, dir)| json!({ "name": name, "path": path::join(&[p, &name]), "dir": dir }))
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64_with_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn picks_image_types_by_extension_as_node_extname_does() {
        assert_eq!(image_mime("a/b.PNG"), Some("image/png"));
        assert_eq!(image_mime("a/.png"), None);
        assert_eq!(image_mime("a/..png"), Some("image/png"));
        assert_eq!(image_mime("a/b.png.txt"), None);
    }

    #[test]
    fn rejects_content_that_is_not_text() {
        assert!(
            write_file(&std::env::temp_dir().join("nekko-unused").to_string_lossy(), &Value::Null)
                .unwrap_err()
                .ends_with("Received null")
        );
    }
}
