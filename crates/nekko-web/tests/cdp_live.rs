//! The browser tool's existing mode against a real headless Chromium.
//!
//! Runs only when `NEKKO_TEST_CHROMIUM` names a Chromium or headless-shell
//! binary (for example Playwright's `chromium_headless_shell-*`); without it
//! the test passes without doing anything. The browser is started headless
//! with its own temporary profile on a free loopback port, and killed and
//! deleted at the end.

use nekko_tools::{ToolCall, ToolContext, approver_fn};
use nekko_web::browser::{Browsers, browser_tool};
use serde_json::{Value, json};
use std::time::Duration;

const PAGE: &str = r#"<!doctype html><html><head><title>Start</title></head><body>
<h1>Form</h1><input id="name" value="old"><button id="go" onclick="document.title = 'Hello ' + document.getElementById('name').value; document.getElementById('out').textContent = 'clicked';">Go</button>
<p id="out">waiting</p><a class="dup">one</a><a class="dup">two</a></body></html>"#;

struct Chromium {
    child: std::process::Child,
    profile: std::path::PathBuf,
}

impl Drop for Chromium {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::thread::sleep(Duration::from_millis(300));
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

#[tokio::test]
async fn existing_mode_drives_a_real_chromium() {
    let Ok(exe) = std::env::var("NEKKO_TEST_CHROMIUM") else { return };
    let profile = std::env::temp_dir().join(format!("nekko-cdp-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&profile);
    std::fs::create_dir_all(&profile).unwrap();
    let child = std::process::Command::new(exe)
        .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--disable-gpu", "about:blank"])
        .arg(format!("--user-data-dir={}", profile.display()))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let browser = Chromium { child, profile: profile.clone() };
    let port_file = profile.join("DevToolsActivePort");
    let mut port = 0u16;
    for _ in 0..100 {
        if let Ok(s) = std::fs::read_to_string(&port_file)
            && let Some(p) = s.lines().next().and_then(|l| l.trim().parse().ok())
        {
            port = p;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(port > 0, "Chromium never reported its DevTools port");

    let app = axum::Router::new().route("/", axum::routing::get(|| async { axum::response::Html(PAGE) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let page_port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let mut ctx = ToolContext::new(approver_fn(|_c, _r: String, _s| async { true }));
    ctx.session_id = Some("live".into());
    let browsers = Browsers::new();
    let run = |input: Value| {
        let call = ToolCall { id: "c".into(), name: "browser".into(), input };
        let (ctx, browsers) = (&ctx, &browsers);
        async move { browser_tool(&call, ctx, true, None, browsers).await }
    };
    let url = format!("http://127.0.0.1:{page_port}/");
    let r = run(json!({ "mode": "existing", "port": port, "action": "navigate", "url": url })).await;
    assert_eq!(r.get("isError"), None, "{r}");
    assert!(r["output"].as_str().unwrap().starts_with("Start\nForm"), "{r}");
    let r =
        run(json!({ "mode": "existing", "port": port, "action": "fill", "selector": "#name", "value": "Nekko" })).await;
    assert_eq!(r["output"], "Field filled.", "{r}");
    let r = run(json!({ "mode": "existing", "port": port, "action": "click", "selector": "#go" })).await;
    let out = r["output"].as_str().unwrap();
    assert!(out.starts_with("Hello Nekko\n") && out.contains("clicked"), "{r}");
    let r = run(json!({ "mode": "existing", "port": port, "action": "click", "selector": "a.dup" })).await;
    assert!(r["output"].as_str().unwrap().contains("strict mode violation"), "{r}");
    let r = run(json!({ "mode": "existing", "port": port + 1, "action": "inspect" })).await;
    assert_eq!(r["output"], "Close the current browser session before switching modes or ports.");
    let r = run(json!({ "mode": "existing", "port": port, "action": "close" })).await;
    assert_eq!(r["output"], "Browser session disconnected.");
    // Disconnecting left the browser running.
    let version = reqwest::get(format!("http://127.0.0.1:{port}/json/version")).await;
    assert!(version.is_ok(), "the browser must survive a disconnect");
    server.abort();
    drop(browser);
}
