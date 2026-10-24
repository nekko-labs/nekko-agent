//! Provider setup from a phone (decision 0016, 2026-10-24): a phone may *carry*
//! a provider key sealed to the computer's own sealing key; it never holds or
//! reads one, and the computer never returns one.
//!
//! The computer keeps a P-256 sealing key beside its data (`provider-seal.key`,
//! owner-only) and answers its public half on `providers:sealKey`. The phone
//! seals the key the user typed to it (ECIES, the same sealed box
//! `nekko-sync` uses for keyrings, under [`CONTEXT`]) and sends the provider
//! without a key plus the blob on `providers:saveSealed`, a change-class call
//! (a signed Secure Enclave proof, so Face ID or the passcode). The computer
//! opens it, tests the provider, saves it as `providers:save` does, and answers
//! `{ ok, models }` or `{ ok: false, message }`, never the key or the list.
//! `providers:setEnabled` flips one provider's switch and nothing else.
//!
//! The same checks run in `packages/shared/src/phone-access.ts`
//! (`screenPhoneProviderSave`); `phone-access.json` carries the lists.

pub use nekko_sync::DeviceKey;
use nekko_sync::open_sealed;
use serde_json::{Map, Value, json};
use std::path::Path;

/// The sealed box's context: what a blob is for, and the associated data.
pub const CONTEXT: &str = "nekko-provider-key-v1";

/// The provider kinds a phone may add: the API-key clouds and the local
/// servers a computer reaches itself. Subscriptions (ChatGPT) sign in on the
/// computer; the engine's own provider, Bedrock, Vertex, Foundry and Claude
/// Agent need the computer's credentials or files.
pub const KINDS: &[&str] = &["anthropic", "openai", "openrouter", "openai-compat", "ollama", "lmstudio", "vllm"];
/// Kinds that need a key and whose base URL must be https.
pub const CLOUD_KINDS: &[&str] = &["anthropic", "openai", "openrouter"];
/// The fields of a `providers:saveSealed` request; anything else is refused.
pub const SAVE_KEYS: &[&str] = &["id", "kind", "label", "baseUrl", "sealedKey"];
pub const ID_MAX: usize = 64;
pub const LABEL_MAX: usize = 80;
pub const URL_MAX: usize = 512;
pub const BLOB_MAX: usize = 8192;
pub const KEY_MAX: usize = 4096;

/// The computer's sealing key: read from `provider-seal.key` in `dir`, made on
/// first use (owner-only on Unix). Never sent anywhere; only its public half is.
pub fn seal_key(dir: &Path) -> Result<DeviceKey, String> {
    let path = dir.join("provider-seal.key");
    if let Ok(bytes) = std::fs::read(&path)
        && let Ok(key) = DeviceKey::from_bytes(&bytes)
    {
        return Ok(key);
    }
    let key = DeviceKey::generate();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    write_private(&path, &key.to_bytes()).map_err(|e| e.to_string())?;
    Ok(key)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// `providers:sealKey`: the public half and the context to seal under.
pub fn seal_key_view(key: &DeviceKey) -> Value {
    use base64::Engine;
    json!({ "publicKey": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.public()), "context": CONTEXT })
}

/// What a refused request says: a code the phone turns into words, and the field.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
}

fn refused(code: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal { code, detail: detail.into() }
}

fn text<'a>(o: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

/// The default base URL of a kind a phone may add.
pub fn default_base_url(kind: &str) -> &'static str {
    match kind {
        "anthropic" => "https://api.anthropic.com",
        "openai" => "https://api.openai.com/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "ollama" => "http://localhost:11434",
        "lmstudio" => "http://localhost:1234/v1",
        "vllm" => "http://localhost:8000/v1",
        _ => "http://localhost:8080/v1",
    }
}

/// A base URL a phone may set: http(s), no spaces, no credentials in the
/// authority, https for a cloud kind. The computer reaches `localhost` itself,
/// so a local kind may name it.
fn url_ok(url: &str, kind: &str) -> bool {
    if url.len() > URL_MAX || url.chars().any(char::is_whitespace) || url.chars().any(char::is_control) {
        return false;
    }
    let rest = if let Some(r) = url.strip_prefix("https://") {
        r
    } else if let Some(r) = url.strip_prefix("http://") {
        if CLOUD_KINDS.contains(&kind) {
            return false;
        }
        r
    } else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    !authority.is_empty() && !authority.contains('@')
}

/// The shape of a `providers:saveSealed` request, without opening the blob:
/// what the phone gate checks before the computer is asked.
pub fn screen_save(request: &Value) -> Result<(), Refusal> {
    let Some(o) = request.as_object() else { return Err(refused("value-invalid", "provider")) };
    if let Some(k) = o.keys().find(|k| !SAVE_KEYS.contains(&k.as_str())) {
        return Err(refused("option-denied", k.clone()));
    }
    let id = text(o, "id").unwrap_or("");
    if id.is_empty() || id.len() > ID_MAX || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        return Err(refused("value-invalid", "id"));
    }
    let kind = text(o, "kind").unwrap_or("");
    if !KINDS.contains(&kind) {
        return Err(refused("value-invalid", "kind"));
    }
    let label = text(o, "label").map(str::trim).unwrap_or("");
    if label.is_empty() || label.encode_utf16().count() > LABEL_MAX || label.chars().any(char::is_control) {
        return Err(refused("value-invalid", "label"));
    }
    if let Some(url) = o.get("baseUrl") {
        if !url.as_str().is_some_and(|u| url_ok(u, kind)) {
            return Err(refused("value-invalid", "baseUrl"));
        }
    }
    match o.get("sealedKey") {
        Some(Value::String(b)) if !b.is_empty() && b.len() <= BLOB_MAX && b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'=') => {}
        Some(_) => return Err(refused("value-invalid", "sealedKey")),
        None if CLOUD_KINDS.contains(&kind) => return Err(refused("value-invalid", "sealedKey")),
        None => {}
    }
    Ok(())
}

/// The provider record to save: the request checked, its blob opened with
/// the computer's key, the key itself never logged. `Err` is for the user.
pub fn sealed_provider(request: &Value, key: &DeviceKey) -> Result<Value, String> {
    screen_save(request).map_err(|r| match r.code {
        "option-denied" => format!("The phone sent a field the computer doesn’t take ({}).", r.detail),
        _ => format!("The provider’s {} isn’t valid.", r.detail),
    })?;
    let o = request.as_object().expect("screened");
    let kind = text(o, "kind").expect("screened");
    let mut out = Map::new();
    out.insert("id".into(), json!(text(o, "id").expect("screened")));
    out.insert("kind".into(), json!(kind));
    out.insert("label".into(), json!(text(o, "label").expect("screened").trim()));
    out.insert("baseUrl".into(), json!(text(o, "baseUrl").unwrap_or(default_base_url(kind))));
    if let Some(blob) = text(o, "sealedKey") {
        let bytes = open_sealed(key, CONTEXT, blob).map_err(|_| "The key was sealed for another computer, or arrived damaged. Try again.".to_string())?;
        let api_key = String::from_utf8(bytes).map_err(|_| "The key isn’t text.".to_string())?;
        let api_key = api_key.trim();
        if api_key.is_empty() || api_key.len() > KEY_MAX || api_key.chars().any(char::is_control) {
            return Err("The key is empty, too long, or has line breaks in it.".into());
        }
        out.insert("apiKey".into(), json!(api_key));
    }
    out.insert("enabled".into(), json!(true));
    Ok(Value::Object(out))
}

/// `{ ok: true, models: [{ id, name }] }`: the answer after a save, from the
/// provider's model list. Never the provider itself.
pub fn save_result(models: &Value) -> Value {
    let models: Vec<Value> = models
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("id")?.as_str()?;
                    let name = m.get("name").and_then(Value::as_str).unwrap_or(id);
                    Some(json!({ "id": id, "name": name }))
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "ok": true, "models": models })
}

/// What reaches the phone from `providers:saveSealed` and `providers:setEnabled`:
/// `ok`, a `message` when there is one, and the models of a save. Never a key,
/// a token key, a base URL or the provider list.
pub fn result_view(result: &Value) -> Value {
    let Some(o) = result.as_object() else { return json!({ "ok": false }) };
    let mut out = Map::new();
    out.insert("ok".into(), json!(o.get("ok").and_then(Value::as_bool).unwrap_or(false)));
    if let Some(m) = o.get("message").and_then(Value::as_str) {
        out.insert("message".into(), json!(crate::hello::cut16(m, 600)));
    }
    if let Some(models) = o.get("models") {
        out.insert("models".into(), save_result(models)["models"].clone());
    }
    Value::Object(out)
}

/// `providers:sealKey` as a phone sees it.
pub fn seal_key_result_view(result: &Value) -> Value {
    match (result.get("publicKey").and_then(Value::as_str), result.get("context").and_then(Value::as_str)) {
        (Some(k), Some(c)) => json!({ "publicKey": k, "context": c }),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nekko_sync::seal_to;

    fn request(kind: &str, blob: Option<&str>) -> Value {
        let mut r = json!({ "id": "claude-phone", "kind": kind, "label": " Anthropic " });
        if let Some(b) = blob {
            r["sealedKey"] = json!(b);
        }
        r
    }

    #[test]
    fn a_sealed_key_opens_into_a_provider_record_and_never_echoes() {
        let key = DeviceKey::generate();
        let blob = seal_to(&key.public(), CONTEXT, b" sk-ant-secret-123 ").unwrap();
        let saved = sealed_provider(&request("anthropic", Some(&blob)), &key).unwrap();
        assert_eq!(saved, json!({ "id": "claude-phone", "kind": "anthropic", "label": "Anthropic", "baseUrl": "https://api.anthropic.com", "apiKey": "sk-ant-secret-123", "enabled": true }));
        // The view of a save answer carries models and ok, nothing of the provider.
        let view = result_view(&json!({ "ok": true, "models": [{ "id": "m1", "name": "Model 1", "contextLength": 8 }, { "name": "no id" }], "provider": saved }));
        assert_eq!(view, json!({ "ok": true, "models": [{ "id": "m1", "name": "Model 1" }] }));
        assert_eq!(result_view(&json!({ "ok": false, "message": "401 from the provider" })), json!({ "ok": false, "message": "401 from the provider" }));
        assert_eq!(result_view(&Value::Null), json!({ "ok": false }));
    }

    #[test]
    fn another_computers_key_or_a_damaged_blob_is_refused_in_words() {
        let mine = DeviceKey::generate();
        let theirs = DeviceKey::generate();
        let blob = seal_to(&theirs.public(), CONTEXT, b"sk-x").unwrap();
        let err = sealed_provider(&request("openai", Some(&blob)), &mine).unwrap_err();
        assert!(err.contains("another computer"), "{err}");
        let wrong_context = seal_to(&mine.public(), "something-else", b"sk-x").unwrap();
        assert!(sealed_provider(&request("openai", Some(&wrong_context)), &mine).is_err());
        let newline = seal_to(&mine.public(), CONTEXT, b"sk-x\nmore").unwrap();
        assert!(sealed_provider(&request("openai", Some(&newline)), &mine).unwrap_err().contains("line breaks"));
    }

    #[test]
    fn the_screen_refuses_bad_shapes_before_the_computer_is_asked() {
        let ok = |r: &Value| screen_save(r).is_ok();
        assert!(ok(&request("ollama", None)), "a local kind needs no key");
        assert!(ok(&json!({ "id": "o", "kind": "ollama", "label": "x", "baseUrl": "http://localhost:11434" })));
        assert_eq!(screen_save(&request("anthropic", None)).unwrap_err().detail, "sealedKey");
        assert_eq!(screen_save(&json!({ "id": "Bad Id", "kind": "openai", "label": "x", "sealedKey": "AQ" })).unwrap_err().detail, "id");
        assert_eq!(screen_save(&json!({ "id": "x", "kind": "chatgpt", "label": "x" })).unwrap_err().detail, "kind");
        assert_eq!(screen_save(&json!({ "id": "x", "kind": "openai", "label": "  ", "sealedKey": "AQ" })).unwrap_err().detail, "label");
        assert_eq!(screen_save(&json!({ "id": "x", "kind": "openai", "label": "x", "sealedKey": "AQ", "apiKey": "sk" })).unwrap_err().code, "option-denied");
        for url in ["http://api.openai.com/v1", "https://user:pw@host/v1", "ftp://x", "https://x y", "https://"] {
            assert_eq!(screen_save(&json!({ "id": "x", "kind": "openai", "label": "x", "sealedKey": "AQ", "baseUrl": url })).unwrap_err().detail, "baseUrl", "{url}");
        }
        assert!(ok(&json!({ "id": "x", "kind": "openai-compat", "label": "x", "baseUrl": "http://192.168.1.5:8080/v1" })));
        assert_eq!(screen_save(&json!({ "id": "x", "kind": "openai", "label": "x", "sealedKey": "not base64url!" })).unwrap_err().detail, "sealedKey");
        assert_eq!(screen_save(&json!("nope")).unwrap_err().detail, "provider");
    }

    #[test]
    fn the_seal_key_is_kept_and_reused() {
        let dir = std::env::temp_dir().join(format!("nekko-seal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = seal_key(&dir).unwrap();
        let b = seal_key(&dir).unwrap();
        assert_eq!(a.public(), b.public());
        let view = seal_key_view(&a);
        assert_eq!(view["context"], CONTEXT);
        assert_eq!(seal_key_result_view(&view), view);
        assert_eq!(seal_key_result_view(&json!({ "publicKey": "x" })), Value::Null);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
