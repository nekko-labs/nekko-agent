//! The approved local image boundary (#2162), shared with the host checks.
//! Limits come from the TS policy golden, never from a phone's request.
use serde_json::{Value, json};
use std::sync::OnceLock;

fn limits() -> &'static Value {
    static LIMITS: OnceLock<Value> = OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str::<Value>(include_str!("phone-access.json")).unwrap_or(Value::Null)["image"].clone()
    })
}

pub fn model_id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.encode_utf16().count() <= limits()["idChars"].as_u64().unwrap_or(0) as usize
            && nekko_js::trim(s) == s
            && !s.starts_with('/')
            && !s.starts_with('-')
            && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || c == ':' || c == '\\')
            && s.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
    })
}

/// A local GGUF image row the existing diffusion runtime can actually use.
/// MLX image rows are not supported by the diffusion loader.
pub fn eligible(row: &Value) -> bool {
    row.get("modality").and_then(Value::as_str) == Some("image")
        && row.get("format").is_none_or(|f| f.as_str() == Some("gguf"))
        && row.get("id").is_some_and(model_id)
}

pub fn models(result: &Value) -> Value {
    Value::Array(result.as_array().into_iter().flatten().filter(|r| eligible(r)).map(|r| json!({
        "id": r["id"],
        "name": if model_id(&r["name"]) && r["name"].as_str().is_some_and(|s| !s.contains('/')) { &r["name"] } else { &r["id"] },
        "kind": "image",
        "format": "gguf",
        "state": if r["loaded"] == true { "loaded" } else if nekko_js::truthy(r.get("lastLoadError")) { "error" } else { "available" },
    })).collect())
}

pub fn params_problem(value: &Value, require_model: bool) -> Option<String> {
    params_problem_with(value, require_model, true)
}

fn params_problem_with(value: &Value, require_model: bool, integer_cfg: bool) -> Option<String> {
    let Some(o) = value.as_object() else { return Some("imageParams".into()) };
    let p = limits();
    for key in o.keys() {
        if !p["paramKeys"].as_array().is_some_and(|keys| keys.iter().any(|v| v.as_str() == Some(key))) {
            return Some(key.clone());
        }
    }
    if (require_model || o.contains_key("modelId")) && !model_id(&value["modelId"]) {
        return Some("modelId".into());
    }
    for key in ["width", "height", "steps", "cfgScale", "seed"] {
        let Some(v) = o.get(key) else {
            if require_model {
                return Some(key.into());
            }
            continue;
        };
        let ok = v.as_f64().is_some_and(|n| {
            n.is_finite()
                && (n.fract() == 0.0 || (key == "cfgScale" && !integer_cfg))
                && n >= p[key][0].as_f64().unwrap_or(f64::INFINITY)
                && n <= p[key][1].as_f64().unwrap_or(f64::NEG_INFINITY)
                && (!matches!(key, "width" | "height") || n % p["sizeMultiple"].as_f64().unwrap_or(0.0) == 0.0)
        });
        if !ok {
            return Some(key.into());
        }
    }
    None
}

pub fn request_problem(value: &Value) -> Option<String> {
    request_problem_with(value, true)
}

/// The trusted local host API retains its existing bounded fractional CFG
/// contract (desktop defaults to 4.5). Phones must pass the strict validator
/// above before dispatch: Change v1 cannot sign fractional numbers. Photos to
/// edit follow the same shape rules, without the phone's relay-frame cap (the
/// desktop may send four 1536 px PNGs).
pub fn host_request_problem(value: &Value) -> Option<String> {
    request_problem_with(value, false)
}

fn request_problem_with(value: &Value, phone: bool) -> Option<String> {
    let Some(o) = value.as_object() else { return Some("image request".into()) };
    for key in o.keys() {
        if !limits()["requestKeys"].as_array().is_some_and(|keys| keys.iter().any(|v| v.as_str() == Some(key))) {
            return Some(key.clone());
        }
    }
    if !value["sessionId"].as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= limits()["sessionIdChars"].as_u64().unwrap_or(0) as usize
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }) {
        return Some("sessionId".into());
    }
    if !value["prompt"].as_str().is_some_and(|s| {
        !nekko_js::trim(s).is_empty()
            && s.encode_utf16().count() <= limits()["promptChars"].as_u64().unwrap_or(0) as usize
    }) {
        return Some("prompt".into());
    }
    params_problem_with(&value["params"], true, phone).or_else(|| edit_problem(o, phone))
}

/// A PNG, JPEG or WebP base64 data URL (`phoneImagePhoto`): the only photo a
/// request may carry. No SVG, GIF, paths, file or web URLs.
pub fn edit_photo(v: &Value) -> bool {
    let Some(s) = v.as_str() else { return false };
    let mut types = limits()["editImageTypes"].as_array().into_iter().flatten().filter_map(Value::as_str);
    let Some(body) = types.find_map(|t| s.strip_prefix(&format!("data:image/{t};base64,"))) else {
        return false;
    };
    let data = body.trim_end_matches('=');
    !data.is_empty()
        && body.len() - data.len() <= 2
        && data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// Photos to edit (1 to `editImages`) and the edit's `size`, which is refused
/// without photos since it only ever shapes an edit (`phoneImageEditProblem`).
fn edit_problem(o: &serde_json::Map<String, Value>, phone: bool) -> Option<String> {
    let p = limits();
    if let Some(images) = o.get("images") {
        let ok = images.as_array().is_some_and(|a| {
            !a.is_empty()
                && a.len() <= p["editImages"].as_u64().unwrap_or(0) as usize
                && a.iter().all(edit_photo)
                && (!phone
                    || a.iter().map(|i| i.as_str().map_or(0, str::len)).sum::<usize>()
                        <= p["editImageChars"].as_u64().unwrap_or(0) as usize)
        });
        if !ok {
            return Some("images".into());
        }
    }
    if let Some(size) = o.get("size") {
        let keys: Vec<&str> = p["sizeKeys"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let ok = o.contains_key("images")
            && size.as_object().is_some_and(|s| {
                !keys.is_empty()
                    && s.len() == keys.len()
                    && keys.iter().all(|&k| {
                        s.get(k).and_then(Value::as_f64).is_some_and(|n| {
                            n.fract() == 0.0
                                && n >= p[k][0].as_f64().unwrap_or(f64::INFINITY)
                                && n <= p[k][1].as_f64().unwrap_or(f64::NEG_INFINITY)
                                && n % p["sizeMultiple"].as_f64().unwrap_or(0.0) == 0.0
                        })
                    })
            });
        if !ok {
            return Some("size".into());
        }
    }
    None
}

/// The tools whose pictures a phone may open from a tool result: the ones
/// that make a picture (`generate_image`, `edit_image`). Any other tool's
/// images (a screenshot of the computer, say) stay on the computer.
const PICTURE_TOOLS: [&str; 2] = ["generate_image", "edit_image"];

/// The pictures of a tool result, only when the call that asked for them is a
/// picture tool of this same chat.
fn tool_pictures<'a>(messages: &'a [Value], m: &'a Value) -> Option<&'a Vec<Value>> {
    let result = m.get("toolResult")?;
    let call_id = result.get("toolCallId")?.as_str()?;
    let made_by_picture_tool = messages.iter().any(|a| {
        a.get("role").and_then(Value::as_str) == Some("assistant")
            && a.get("toolCalls").and_then(Value::as_array).is_some_and(|calls| {
                calls.iter().any(|c| {
                    c.get("id").and_then(Value::as_str) == Some(call_id)
                        && c.get("name").and_then(Value::as_str).is_some_and(|n| PICTURE_TOOLS.contains(&n))
                })
            })
    });
    if made_by_picture_tool { result.get("images")?.as_array() } else { None }
}

/// Retrieve only raster data attached to this exact transcript message. No I/O,
/// URL fetching or path resolution. Generated replies use `images`
/// (variants::image_reply), not `attachedPaths` or a file attachment. A tool
/// result's `images` are served only for a picture tool's result (#2973).
pub fn photo(session: &Value, message_id: &str, index: usize) -> Value {
    let Some(messages) = session.get("messages").and_then(Value::as_array) else {
        return Value::Null;
    };
    let Some(m) = messages.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(message_id)) else {
        return Value::Null;
    };
    let images = match m.get("role").and_then(Value::as_str) {
        Some("user" | "assistant") => m.get("images").and_then(Value::as_array),
        Some("tool") => tool_pictures(messages, m),
        _ => None,
    };
    let Some(s) = images.and_then(|a| a.get(index)).and_then(Value::as_str) else {
        return Value::Null;
    };
    if ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "data:image/webp;base64,"]
        .iter()
        .any(|p| s.starts_with(p))
    {
        json!(s)
    } else {
        Value::Null
    }
}
