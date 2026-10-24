//! "Send feedback" (#1004): the facts the sheet may share and the quick note
//! itself, posted to Nekko Cloud's `POST /v1/feedback`
//! (`apps/nekko-agent-api/src/feedback.ts`, `spec/platform/send-feedback.md`).
//!
//! `feedback:info` is what the sheet shows and copies: app, version, OS, OS
//! version and CPU type, nothing that identifies the person or the machine.
//! `feedback:send` takes the note and whether to include those facts; the
//! daemon builds them itself, so the renderer can't add a field. The request
//! carries no token, even when someone is signed in to Nekko Cloud.

use crate::routes::Ctx;
use serde_json::{Map, Value, json};

/// The channels served here, with or without a data directory.
pub const CHANNELS: &[&str] = &["feedback:info", "feedback:send"];

/// The server's limit, in characters.
const MAX_CHARS: usize = 4000;

/// Nekko Cloud's API: `NEKKO_CLOUD_URL`, or the hosted one.
pub fn cloud_url() -> String {
    std::env::var("NEKKO_CLOUD_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "https://nekko-agent-api.fly.dev".into())
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let facts = info(&crate::small_services::app_info(&ctx.app.facts));
    match channel {
        "feedback:info" => Ok(facts),
        "feedback:send" => {
            let message = args.first().and_then(Value::as_str).unwrap_or_default();
            let include = args.get(1).and_then(Value::as_bool).unwrap_or(false);
            send(&cloud_url(), &body(message, include.then_some(&facts))?).await
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// The sheet's app facts from `app:info` and the OS, each cut to what the server accepts.
fn info(app: &Value) -> Value {
    let edition = if app["edition"] == "desktop" { "desktop" } else { "web" };
    let mut out = Map::new();
    out.insert("app".into(), json!(edition));
    out.insert(
        "version".into(),
        json!(clean(app["version"].as_str().unwrap_or(""), 32).unwrap_or_else(|| "0.0.0".into())),
    );
    out.insert("os".into(), json!(clean(&os_name(), 32).unwrap_or_else(|| "unknown".into())));
    if let Some(v) = sysinfo::System::os_version().and_then(|v| clean(&v, 32)) {
        out.insert("osVersion".into(), json!(v));
    }
    if let Some(a) = clean(std::env::consts::ARCH, 16) {
        out.insert("arch".into(), json!(a));
    }
    Value::Object(out)
}

fn os_name() -> String {
    if cfg!(target_os = "macos") {
        "macOS".into()
    } else if cfg!(windows) {
        "Windows".into()
    } else {
        // The distribution ("Ubuntu"), so its version means something.
        sysinfo::System::name().unwrap_or_else(|| "Linux".into())
    }
}

/// Letters, digits, space and `._+-` only, at most `max` characters; `None` when nothing is left.
fn clean(s: &str, max: usize) -> Option<String> {
    let kept: String =
        s.chars().filter(|c| c.is_ascii_alphanumeric() || " ._+-".contains(*c)).take(max).collect::<String>();
    let kept = kept.trim();
    (!kept.is_empty()).then(|| kept.to_string())
}

fn body(message: &str, facts: Option<&Value>) -> Result<Value, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a note first.".into());
    }
    if message.chars().count() > MAX_CHARS {
        return Err(format!("Keep it under {MAX_CHARS} characters."));
    }
    let mut out = json!({ "message": message });
    if let Some(f) = facts {
        out["app"] = f.clone();
    }
    Ok(out)
}

async fn send(base: &str, body: &Value) -> Result<Value, String> {
    let url = format!("{}/v1/feedback", base.trim_end_matches('/'));
    let res = nekko_cloud::client()
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|_| "Couldn't reach Nekko Cloud. Check your connection and try again.".to_string())?;
    match res.status().as_u16() {
        200..=299 => Ok(json!({ "ok": true })),
        429 => Err("Too many notes. Try again later.".into()),
        status => Err(format!("Nekko Cloud couldn't take the note ({status}). Try again, or open a GitHub issue.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_names_only_the_allowed_fields() {
        let facts =
            info(&json!({ "version": "1.4.0", "platform": "darwin", "edition": "desktop", "quitFromPhone": true }));
        let keys: Vec<&str> = facts.as_object().unwrap().keys().map(String::as_str).collect();
        assert!(keys.iter().all(|k| ["app", "version", "os", "osVersion", "arch"].contains(k)), "{keys:?}");
        assert_eq!(facts["app"], "desktop");
        assert_eq!(facts["version"], "1.4.0");
        assert_eq!(facts["arch"], std::env::consts::ARCH);
        assert_eq!(info(&json!({ "version": "1.4.0", "edition": "web" }))["app"], "web");
    }

    #[test]
    fn clean_keeps_what_the_server_accepts() {
        assert_eq!(clean(" 15.1 (24B83) ", 32).as_deref(), Some("15.1 24B83"));
        assert_eq!(clean("<script>", 32).as_deref(), Some("script"));
        assert_eq!(clean("x".repeat(40).as_str(), 32).map(|s| s.len()), Some(32));
        assert_eq!(clean("()", 32), None);
    }

    #[test]
    fn the_body_has_app_info_only_when_asked() {
        let facts = json!({ "app": "web", "version": "1.0.0", "os": "Linux" });
        assert_eq!(body("  slow  ", None).unwrap(), json!({ "message": "slow" }));
        assert_eq!(body("slow", Some(&facts)).unwrap(), json!({ "message": "slow", "app": facts }));
        assert!(body("   ", None).is_err());
        assert!(body(&"🐈".repeat(MAX_CHARS), None).is_ok());
        assert!(body(&"a".repeat(MAX_CHARS + 1), None).is_err());
    }

    #[tokio::test]
    async fn send_explains_a_rate_limit() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = r#"{"error":"rate-limited"}"#;
            let res = format!(
                "HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            s.write_all(res.as_bytes()).await.unwrap();
            req
        });
        let err = send(&base, &json!({ "message": "hi" })).await.unwrap_err();
        assert_eq!(err, "Too many notes. Try again later.");
        let req = server.await.unwrap();
        assert!(req.starts_with("POST /v1/feedback "), "{req}");
        assert!(!req.to_ascii_lowercase().contains("authorization"), "{req}");
    }
}
