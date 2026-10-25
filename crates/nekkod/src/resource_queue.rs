//! `resource:queue`: the experimental outbound coordinator client, a port of
//! `packages/host/src/resource-queue.ts`. The daemon is the only writer of
//! `<data>/resource-queue.json` (coordinator origin and client credential);
//! the credential never goes back to the renderer.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_UNITS: usize = 2_000_000;

pub struct ResourceQueue {
    dir: PathBuf,
    /// The daemon's settings (`experimental.resourceQueue` gates the client).
    settings: Box<dyn Fn() -> Value + Send + Sync>,
    http: reqwest::Client,
}

impl ResourceQueue {
    pub fn new(dir: PathBuf, settings: Box<dyn Fn() -> Value + Send + Sync>) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Self { dir, settings, http }
    }

    fn enabled(&self) -> bool {
        nekko_js::truthy((self.settings)().get("experimental").and_then(|e| e.get("resourceQueue")))
    }

    pub async fn route(&self, args: &[Value]) -> Result<Value, String> {
        let action = args.first().map(nekko_js::display).unwrap_or_else(|| "undefined".into());
        let input = match args.get(1) {
            Some(v @ Value::Object(_)) => v.clone(),
            _ => json!({}),
        };
        self.call(&action, &input).await
    }

    async fn call(&self, action: &str, input: &Value) -> Result<Value, String> {
        if !self.enabled() {
            return Err("Resource queue experiment is disabled".into());
        }
        let path = self.dir.join("resource-queue.json");
        if action == "configure" {
            let raw = input.get("url").map_or_else(|| "undefined".to_string(), nekko_js::display);
            let url = reqwest::Url::parse(&raw).map_err(|_| "Invalid URL".to_string())?;
            let local = url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
            if !url.username().is_empty()
                || url.password().is_some_and(|p| !p.is_empty())
                || url.query().is_some_and(|q| !q.is_empty())
                || url.fragment().is_some_and(|f| !f.is_empty())
                || (url.scheme() != "https" && !local)
            {
                return Err("Use HTTPS, or localhost for development".into());
            }
            let token = match input.get("token") {
                Some(Value::String(t)) if nekko_js::len16(t) >= 32 => t.clone(),
                _ => return Err("Client credential must have at least 32 characters".into()),
            };
            let body = nekko_js::stringify(&json!({ "url": url.origin().ascii_serialization(), "token": token }));
            write_private(&path, &body).map_err(|e| e.to_string())?;
            return Ok(json!({ "configured": true }));
        }
        let config = read_json(&path).ok_or("Configure the coordinator first")?;
        let base = config.get("url").map(nekko_js::display).unwrap_or_else(|| "undefined".into());
        let token = config.get("token").map(nekko_js::display).unwrap_or_else(|| "undefined".into());
        let id = match input.get("id") {
            Some(Value::String(s)) if !s.is_empty() && s.chars().all(|c| matches!(c, 'a'..='f' | '0'..='9' | '-')) => {
                s.as_str()
            }
            _ => "",
        };
        let route = match action {
            "register" => "/v1/resources/register".to_string(),
            "list" => "/v1/jobs".to_string(),
            "claim" => format!("/v1/jobs/{id}/claim"),
            "heartbeat" => format!("/v1/jobs/{id}/heartbeat"),
            "result" => format!("/v1/jobs/{id}/result"),
            _ => return Err("Invalid queue action".into()),
        };
        if matches!(action, "claim" | "heartbeat" | "result") && id.is_empty() {
            return Err("Invalid queue action".into());
        }
        let url = format!("{base}{route}");
        let mut req = if action == "list" { self.http.get(&url) } else { self.http.post(&url) }
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json");
        if action != "list" {
            req = req.body(nekko_js::stringify(input));
        }
        let response = nekko_net::send("resource-queue", req)
            .await
            .map_err(|e| if e.is_blocked() { e.to_string() } else { "fetch failed".to_string() })?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Coordinator request failed ({})", status.as_u16()));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        if nekko_js::len16(&text) > MAX_RESPONSE_UNITS {
            return Err("Coordinator response too large".into());
        }
        serde_json::from_str(&text).map_err(|e| format!("Coordinator response is not JSON: {e}"))
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// `writeFileSync(path, body, { mode: 0o600 })`.
fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(name: &str, enabled: bool) -> (ResourceQueue, PathBuf) {
        let dir = std::env::temp_dir().join(format!("nekkod-rq-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let settings = json!({ "experimental": { "resourceQueue": enabled } });
        (ResourceQueue::new(dir.clone(), Box::new(move || settings.clone())), dir)
    }

    #[tokio::test]
    async fn gates_and_validation_match_the_host() {
        let (off, dir) = queue("off", false);
        assert_eq!(off.call("list", &json!({})).await.unwrap_err(), "Resource queue experiment is disabled");
        let _ = std::fs::remove_dir_all(dir);

        let (q, dir) = queue("gates", true);
        assert_eq!(q.call("list", &json!({})).await.unwrap_err(), "Configure the coordinator first");
        let long = "x".repeat(32);
        for bad in
            ["http://example.com", "https://u:p@example.com", "https://example.com/?a=1", "https://example.com/#x"]
        {
            assert_eq!(
                q.call("configure", &json!({ "url": bad, "token": long })).await.unwrap_err(),
                "Use HTTPS, or localhost for development",
                "{bad}"
            );
        }
        assert_eq!(q.call("configure", &json!({ "url": "nope", "token": long })).await.unwrap_err(), "Invalid URL");
        assert_eq!(
            q.call("configure", &json!({ "url": "https://example.com", "token": "short" })).await.unwrap_err(),
            "Client credential must have at least 32 characters"
        );
        assert_eq!(
            q.call("configure", &json!({ "url": "http://localhost:8080/path", "token": long })).await.unwrap(),
            json!({ "configured": true })
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("resource-queue.json")).unwrap(),
            format!("{{\"url\":\"http://localhost:8080\",\"token\":\"{long}\"}}")
        );
        assert_eq!(q.call("claim", &json!({ "id": "NOT-HEX" })).await.unwrap_err(), "Invalid queue action");
        assert_eq!(q.call("drop", &json!({})).await.unwrap_err(), "Invalid queue action");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn calls_the_coordinator_with_the_credential() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let mut req = String::new();
            while !req.contains("\r\n\r\n") || !req.ends_with('}') {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                req.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
            let body = r#"{"ok":true}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(reply.as_bytes()).await.unwrap();
            req
        });
        let (q, dir) = queue("calls", true);
        let token = "t".repeat(40);
        q.call("configure", &json!({ "url": format!("http://127.0.0.1:{port}"), "token": token })).await.unwrap();
        let out = q.call("heartbeat", &json!({ "id": "ab-12", "progress": 0.5 })).await.unwrap();
        assert_eq!(out, json!({ "ok": true }));
        let req = server.await.unwrap();
        assert!(req.starts_with("POST /v1/jobs/ab-12/heartbeat HTTP/1.1"), "{req}");
        assert!(req.to_ascii_lowercase().contains(&format!("authorization: bearer {token}")), "{req}");
        assert!(req.ends_with(r#"{"id":"ab-12","progress":0.5}"#), "{req}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
