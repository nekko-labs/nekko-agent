//! "Send feedback" (#1004): the facts the sheet may share and the quick note
//! itself, posted to Nekko Cloud's `POST /v1/feedback`
//! (`apps/nekko-agent-api/src/feedback.ts`, `spec/platform/send-feedback.md`).
//!
//! `feedback:info` is what the sheet shows and copies: app, version, OS, OS
//! version and CPU type, nothing that identifies the person or the machine.
//! `feedback:send` takes the note and whether to include those facts; the
//! daemon builds them itself, so the renderer can't add a field. An optional
//! third argument carries the sheet's screenshots, which go to
//! `POST /v1/feedback/screenshots` instead: a Nekko Cloud from before
//! screenshots answers 404 there, so the note fails loudly rather than
//! arriving without its images. The request carries no token, even when
//! someone is signed in to Nekko Cloud.

use crate::routes::Ctx;
use serde_json::{Map, Value, json};

/// The channels served here, with or without a data directory.
pub const CHANNELS: &[&str] = &["feedback:info", "feedback:send"];

/// The server's limit, in characters.
const MAX_CHARS: usize = 4000;

/// Screenshots a note may carry, and the base64 length of the largest one (5 MB).
const MAX_SCREENSHOTS: usize = 3;
const MAX_SCREENSHOT_BASE64: usize = (5 * 1024 * 1024usize).div_ceil(3) * 4;

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
            let mut body = body(message, include.then_some(&facts))?;
            let shots = screenshots(args.get(2))?;
            if !shots.is_empty() {
                body["screenshots"] = Value::Array(shots);
            }
            send(&cloud_url(), &body).await
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// The sheet's app facts from `app:info` and the OS, each cut to what the server accepts.
pub(crate) fn info(app: &Value) -> Value {
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

/// The sheet's screenshots as `{ type, data }`: the file name stays on this
/// machine. Nekko Cloud checks the bytes are a real image; this refuses only
/// what it would refuse anyway, before uploading up to 20 MB.
fn screenshots(v: Option<&Value>) -> Result<Vec<Value>, String> {
    let list = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err("Couldn't read the screenshots.".into()),
    };
    if list.len() > MAX_SCREENSHOTS {
        return Err(format!("Add up to {MAX_SCREENSHOTS} screenshots."));
    }
    list.iter()
        .map(|s| {
            let kind = s["type"].as_str().filter(|t| matches!(*t, "image/png" | "image/jpeg"));
            let data = s["data"].as_str().filter(|d| {
                !d.is_empty()
                    && d.len() <= MAX_SCREENSHOT_BASE64
                    && d.len().is_multiple_of(4)
                    && d.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
            });
            match (kind, data) {
                (Some(kind), Some(data)) => Ok(json!({ "type": kind, "data": data })),
                _ => Err("Each screenshot must be a PNG or JPG of up to 5 MB.".into()),
            }
        })
        .collect()
}

async fn send(base: &str, body: &Value) -> Result<Value, String> {
    let with_shots = body.get("screenshots").is_some();
    let path = if with_shots { "/v1/feedback/screenshots" } else { "/v1/feedback" };
    let url = format!("{}{path}", base.trim_end_matches('/'));
    let mut req = nekko_cloud::client().post(url).json(body);
    if with_shots {
        // Up to 20 MB: give a slow connection longer than the client's 60 seconds.
        req = req.timeout(std::time::Duration::from_secs(300));
    }
    let res = nekko_net::send("feedback", req).await.map_err(|e| {
        if e.is_blocked() {
            e.to_string()
        } else {
            "Couldn't reach Nekko Cloud. Check your connection and try again.".to_string()
        }
    })?;
    let status = res.status().as_u16();
    if with_shots && status == 400 {
        let answer: Value = res.json().await.unwrap_or_default();
        if answer["error"] == "bad-screenshot" {
            let n = answer["index"].as_u64().map_or(String::new(), |i| format!(" {}", i + 1));
            return Err(format!("Screenshot{n} isn't a PNG or JPG Nekko Cloud can read. Remove it and try again."));
        }
    }
    match status {
        200..=299 => Ok(json!({ "ok": true })),
        429 => Err("Too many notes. Try again later.".into()),
        // A Nekko Cloud from before screenshots: it stored nothing.
        404 if with_shots => {
            Err("Nekko Cloud can't take screenshots yet. Remove them and send again, or open a GitHub issue.".into())
        }
        413 => Err("The screenshots are too big to send. Remove one and try again.".into()),
        503 if with_shots => Err("Nekko Cloud is busy with other screenshots. Try again in a minute.".into()),
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

    #[test]
    fn screenshots_keep_type_and_data_only() {
        let png = json!({ "name": "Ada's desktop.png", "type": "image/png", "data": "iVBORw0KGgo=" });
        assert_eq!(screenshots(None).unwrap(), Vec::<Value>::new());
        assert_eq!(screenshots(Some(&json!([]))).unwrap(), Vec::<Value>::new());
        assert_eq!(
            screenshots(Some(&json!([png.clone()]))).unwrap(),
            vec![json!({ "type": "image/png", "data": "iVBORw0KGgo=" })]
        );
        assert!(screenshots(Some(&json!([png.clone(), png.clone(), png.clone(), png]))).is_err());
        assert!(screenshots(Some(&json!([{ "type": "image/gif", "data": "R0lGOA==" }]))).is_err());
        assert!(screenshots(Some(&json!([{ "type": "image/png", "data": "not base64!" }]))).is_err());
        assert!(
            screenshots(Some(&json!([{ "type": "image/png", "data": "A".repeat(MAX_SCREENSHOT_BASE64 + 4) }])))
                .is_err()
        );
        assert!(screenshots(Some(&json!("x"))).is_err());
    }

    /// Answers one HTTP request on a local socket; gives the base URL and, later, the request it saw.
    async fn answer_once(status: &'static str, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let res = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            s.write_all(res.as_bytes()).await.unwrap();
            req
        });
        (base, server)
    }

    #[tokio::test]
    async fn screenshots_fail_loudly_on_a_cloud_without_them() {
        let (base, server) = answer_once("404 Not Found", r#"{"error":"not-found"}"#).await;
        let body = json!({ "message": "hi", "screenshots": [{ "type": "image/png", "data": "iVBORw0KGgo=" }] });
        let err = send(&base, &body).await.unwrap_err();
        assert!(err.starts_with("Nekko Cloud can't take screenshots yet."), "{err}");
        let req = server.await.unwrap();
        assert!(req.starts_with("POST /v1/feedback/screenshots "), "{req}");
    }

    #[tokio::test]
    async fn send_names_the_screenshot_nekko_cloud_refused() {
        let (base, _server) = answer_once("400 Bad Request", r#"{"error":"bad-screenshot","index":1}"#).await;
        let body = json!({ "message": "hi", "screenshots": [{ "type": "image/png", "data": "iVBORw0KGgo=" }] });
        let err = send(&base, &body).await.unwrap_err();
        assert_eq!(err, "Screenshot 2 isn't a PNG or JPG Nekko Cloud can read. Remove it and try again.");
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
