//! What the agent linked, opened on a paired phone (issue #1095): the
//! daemon's copy of `packages/shared/src/phone-artifacts.ts`. Which arguments
//! a phone may send to `artifact:read` and `preview:fetch` (rebuilt from the
//! checked fields: an absolute path or `file:` URL normalised, a loopback URL
//! rebuilt, GET or HEAD) and what it receives back (capped bodies, a header
//! subset, secret files dropped). nekkod serves the calls
//! (crates/nekkod/src/artifacts.rs) and checks the chat's links there.
//!
//! The limits and field lists come from `phone-access.json` (`artifacts`); the
//! shared cases in `tests/golden/phone-artifacts.json`, written by the TS, hold
//! the two copies equal.

use crate::chat_links::{local_path, loopback_url};
use crate::phone::Denied;
use crate::phone_files::secret_path;
use crate::phone_views::pick_keys;
use serde_json::{Map, Value, json};

/// `PHONE_ARTIFACT_CHANNELS`: both read class.
pub const CHANNELS: [&str; 2] = ["artifact:read", "preview:fetch"];

pub fn is_artifacts(channel: &str) -> bool {
    CHANNELS.contains(&channel)
}

/// `PHONE_ARTIFACTS_VIEW` and the field lists, as the TS wrote them.
#[derive(Debug, Clone, Default)]
pub struct ArtifactsPolicy {
    pub text_bytes: usize,
    pub binary_bytes: usize,
    pub preview_bytes: usize,
    pub path_chars: usize,
    pub url_chars: usize,
    pub id_chars: usize,
    pub redirects: usize,
    pub timeout_ms: u64,
    pub artifact_view: Vec<String>,
    pub preview_view: Vec<String>,
    pub preview_headers: Vec<String>,
    pub preview_methods: Vec<String>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

impl ArtifactsPolicy {
    /// From `artifacts` in `phone-access.json`; a missing value allows and shows nothing.
    pub fn from_policy(v: &Value) -> Self {
        let n = |k: &str| v["view"][k].as_u64().unwrap_or(0);
        ArtifactsPolicy {
            text_bytes: n("textBytes") as usize,
            binary_bytes: n("binaryBytes") as usize,
            preview_bytes: n("previewBytes") as usize,
            path_chars: n("pathChars") as usize,
            url_chars: n("urlChars") as usize,
            id_chars: n("idChars") as usize,
            redirects: n("redirects") as usize,
            timeout_ms: n("timeoutMs"),
            artifact_view: strings(&v["artifactView"]),
            preview_view: strings(&v["previewView"]),
            preview_headers: strings(&v["previewHeaders"]),
            preview_methods: strings(&v["previewMethods"]),
        }
    }
}

fn bad(detail: &str) -> Denied {
    Denied { code: "value-invalid", detail: detail.to_string() }
}

fn denied_key(key: &str) -> Denied {
    Denied { code: "option-denied", detail: key.to_string() }
}

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn chat_id(v: Option<&Value>, p: &ArtifactsPolicy) -> Result<Value, Denied> {
    match v {
        Some(Value::String(s)) if !s.is_empty() && len16(s) <= p.id_chars => Ok(json!(s)),
        _ => Err(bad("chat id")),
    }
}

/// `screenPhoneArtifacts`: the arguments to pass to the computer's call, or why not.
pub fn screen(channel: &str, args: &[Value], p: &ArtifactsPolicy) -> Result<Vec<Value>, Denied> {
    let get = |i: usize| args.get(i);
    match channel {
        "artifact:read" => {
            let id = chat_id(get(0), p)?;
            let path = match get(1) {
                Some(Value::String(s)) if len16(s) <= p.path_chars => local_path(s, None),
                _ => None,
            }
            .ok_or_else(|| bad("path"))?;
            if secret_path(&path) {
                return Err(bad("secret file"));
            }
            if args.len() > 2 {
                return Err(denied_key("extra argument"));
            }
            Ok(vec![id, json!(path)])
        }
        "preview:fetch" => {
            let id = chat_id(get(0), p)?;
            let url =
                get(1).and_then(Value::as_str).and_then(|u| loopback_url(u, p.url_chars)).ok_or_else(|| bad("url"))?;
            let mut method = "GET".to_string();
            match get(2) {
                None | Some(Value::Null) => {}
                Some(Value::Object(o)) => {
                    if let Some(k) = o.keys().find(|k| *k != "method") {
                        return Err(denied_key(k));
                    }
                    if let Some(m) = o.get("method") {
                        match m.as_str() {
                            Some(m) if p.preview_methods.iter().any(|x| x == m) => method = m.to_string(),
                            _ => return Err(bad("method")),
                        }
                    }
                }
                Some(_) => return Err(bad("preview options")),
            }
            if args.len() > 3 {
                return Err(denied_key("extra argument"));
            }
            Ok(vec![id, json!(url.url), json!({ "method": method })])
        }
        _ => Err(bad(channel)),
    }
}

/// UTF-16 units of the base64 of `bytes` bytes.
fn base64_chars(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}

/// `^[A-Za-z0-9+/]*={0,2}$`.
fn is_base64(s: &str) -> bool {
    let body = s.trim_end_matches('=');
    s.len() - body.len() <= 2 && body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
}

fn artifact(r: &Value, p: &ArtifactsPolicy) -> Value {
    let Some(o) = r.as_object() else { return Value::Null };
    match o.get("path").and_then(Value::as_str) {
        Some(path) if !secret_path(path) => {}
        _ => return Value::Null,
    }
    let mut out = pick_keys(r, &p.artifact_view);
    if let Some(Value::String(content)) = o.get("content") {
        if len16(content) > p.text_bytes {
            out.insert("content".into(), json!(crate::hello::cut16(content, p.text_bytes)));
            out.insert("truncated".into(), json!(true));
        } else {
            out.insert("content".into(), json!(content));
        }
    }
    base64_body(o, &mut out, p.binary_bytes);
    Value::Object(out)
}

fn base64_body(o: &Map<String, Value>, out: &mut Map<String, Value>, cap: usize) {
    if let Some(Value::String(b)) = o.get("base64") {
        if b.len() <= base64_chars(cap) && is_base64(b) {
            out.insert("base64".into(), json!(b));
        } else {
            out.insert("truncated".into(), json!(true));
        }
    }
}

fn preview(r: &Value, p: &ArtifactsPolicy) -> Value {
    let Some(o) = r.as_object() else { return Value::Null };
    let mut out = pick_keys(r, &p.preview_view);
    let mut headers = Map::new();
    if let Some(Value::Object(h)) = o.get("headers") {
        for k in &p.preview_headers {
            if let Some(Value::String(v)) = h.get(k) {
                headers.insert(k.clone(), json!(v));
            }
        }
    }
    out.insert("headers".into(), Value::Object(headers));
    base64_body(o, &mut out, p.preview_bytes);
    Value::Object(out)
}

/// `phoneArtifactsView`: what a phone receives for an artifact or preview call.
pub fn view(channel: &str, result: &Value, p: &ArtifactsPolicy) -> Value {
    match channel {
        "artifact:read" => artifact(result, p),
        "preview:fetch" => preview(result, p),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> &'static ArtifactsPolicy {
        &crate::phone::policy().artifacts
    }

    #[test]
    fn the_policy_carries_the_limits() {
        let p = policy();
        assert_eq!((p.text_bytes, p.binary_bytes, p.preview_bytes), (1 << 20, 4 << 20, 4 << 20));
        assert_eq!((p.redirects, p.timeout_ms), (5, 15_000));
        assert_eq!(p.preview_methods, vec!["GET".to_string(), "HEAD".to_string()]);
        // A whole binary body, base64'd, fits a phone frame with room to spare.
        assert!(base64_chars(p.binary_bytes) + 4096 < crate::phone::policy().max_frame_bytes);
    }

    #[test]
    fn long_text_is_cut_and_bad_base64_dropped() {
        let p = policy();
        let content = format!("{}😀tail", "x".repeat(p.text_bytes - 1));
        let v = view("artifact:read", &json!({ "path": "/a.txt", "kind": "text", "content": content }), p);
        assert_eq!(len16(v["content"].as_str().unwrap()), p.text_bytes - 1);
        assert_eq!(v["truncated"], json!(true));
        let v = view("preview:fetch", &json!({ "url": "http://localhost:1/", "base64": "a=b" }), p);
        assert_eq!((v.get("base64"), &v["truncated"]), (None, &json!(true)));
        assert!(is_base64("") && is_base64("QQ==") && !is_base64("QQ===") && !is_base64("Q Q="));
    }
}
