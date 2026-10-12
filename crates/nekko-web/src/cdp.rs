//! A small Chrome DevTools Protocol client for the browser tool's existing
//! mode: the user's own Chromium, started with `--remote-debugging-port` on
//! loopback, driven for the four deterministic actions the TS host ran
//! through Stagehand and Playwright (navigate, inspect, click, fill).
//!
//! It attaches to the most recently active page (the order `/json/list`
//! reports), never opens, focuses or closes a window, and disconnecting
//! leaves the browser running. Selectors are CSS (`querySelectorAll`), as the
//! tool asks for; a selector matching more than one element is refused, as
//! Playwright's strict locators refuse it.

use futures_util::{SinkExt, StreamExt};
use nekko_js as js;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// Playwright's default action and navigation timeout.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(30);

type Waiters = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One browser-level DevTools connection.
pub struct Cdp {
    out: mpsc::UnboundedSender<Message>,
    waiters: Waiters,
    events: broadcast::Sender<Value>,
    next: AtomicU64,
    reader: tokio::task::JoinHandle<()>,
    port: u16,
}

impl Drop for Cdp {
    fn drop(&mut self) {
        // Only the socket closes; the browser is the user's.
        self.reader.abort();
    }
}

async fn get_json(port: u16, path: &str) -> Result<Value, String> {
    let client =
        reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().map_err(|e| e.to_string())?;
    let res = client
        .get(format!("http://127.0.0.1:{port}{path}"))
        .send()
        .await
        .map_err(|_| format!("Could not reach a browser's DevTools endpoint on 127.0.0.1:{port}. Start Chromium with --remote-debugging-port={port} and try again."))?;
    res.json::<Value>().await.map_err(|e| format!("DevTools endpoint on port {port} answered oddly: {e}"))
}

impl Cdp {
    /// Connect to the browser on a loopback DevTools port.
    pub async fn connect(port: u16) -> Result<Self, String> {
        let version = get_json(port, "/json/version").await?;
        let ws = version
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("The DevTools endpoint on port {port} has no browser socket."))?;
        // Only loopback: the URL comes from the endpoint, so check it.
        let parsed = url::Url::parse(ws).map_err(|e| e.to_string())?;
        if !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) {
            return Err("The DevTools endpoint pointed outside this machine; refused.".into());
        }
        let (socket, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(ws))
            .await
            .map_err(|_| "Timed out connecting to the browser.".to_string())?
            .map_err(|e| format!("Could not connect to the browser: {e}"))?;
        let (mut sink, mut stream) = socket.split();
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let waiters: Waiters = Arc::default();
        let (events, _) = broadcast::channel(256);
        tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
        });
        let (w, ev) = (waiters.clone(), events.clone());
        let reader = tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                let Message::Text(text) = msg else { continue };
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = lock(&w).remove(&id) {
                        let r = match v.get("error") {
                            Some(e) => Err(e.get("message").map(js::display).unwrap_or_else(|| e.to_string())),
                            None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(r);
                    }
                } else {
                    let _ = ev.send(v);
                }
            }
            // The browser went away: fail everything still waiting.
            for (_, tx) in lock(&w).drain() {
                let _ = tx.send(Err("The browser connection closed.".into()));
            }
        });
        Ok(Self { out, waiters, events, next: AtomicU64::new(1), reader, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether the socket is still up.
    pub fn alive(&self) -> bool {
        !self.reader.is_finished()
    }

    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let (tx, rx) = oneshot::channel();
        lock(&self.waiters).insert(id, tx);
        if self.out.send(Message::Text(msg.to_string().into())).is_err() {
            lock(&self.waiters).remove(&id);
            return Err("The browser connection closed.".into());
        }
        match tokio::time::timeout(ACTION_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("The browser connection closed.".into()),
            Err(_) => {
                lock(&self.waiters).remove(&id);
                Err(format!("{method}: Timeout {}ms exceeded.", ACTION_TIMEOUT.as_millis()))
            }
        }
    }

    /// The most recently active page, attached for this call; `None` when
    /// the browser has no page open.
    pub async fn active_page(&self) -> Result<Option<Page<'_>>, String> {
        let list = get_json(self.port, "/json/list").await?;
        let target = list.as_array().and_then(|a| {
            a.iter()
                .find(|t| {
                    t.get("type").and_then(Value::as_str) == Some("page")
                        && !t.get("url").and_then(Value::as_str).unwrap_or_default().starts_with("devtools://")
                })
                .and_then(|t| t.get("id").and_then(Value::as_str))
                .map(str::to_string)
        });
        let Some(target) = target else { return Ok(None) };
        let attached = self.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
        let session =
            attached.get("sessionId").and_then(Value::as_str).ok_or("The page could not be attached.")?.to_string();
        Ok(Some(Page { cdp: self, session, target }))
    }
}

/// One attached page; detached again when dropped.
pub struct Page<'a> {
    cdp: &'a Cdp,
    session: String,
    target: String,
}

impl Drop for Page<'_> {
    fn drop(&mut self) {
        let id = self.cdp.next.fetch_add(1, Ordering::Relaxed);
        let msg = json!({ "id": id, "method": "Target.detachFromTarget", "params": { "sessionId": self.session } });
        let _ = self.cdp.out.send(Message::Text(msg.to_string().into()));
    }
}

/// A selector as a JavaScript string literal.
fn lit(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

impl Page<'_> {
    pub fn target(&self) -> &str {
        &self.target
    }

    async fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.send(method, params, Some(&self.session)).await
    }

    /// `Runtime.evaluate` returning the value; a page exception is an error.
    pub async fn eval(&self, expression: &str) -> Result<Value, String> {
        let r = self
            .send("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }))
            .await?;
        if let Some(e) = r.get("exceptionDetails") {
            let text = e
                .pointer("/exception/description")
                .or_else(|| e.get("text"))
                .map(js::display)
                .unwrap_or_else(|| "The page threw an error.".into());
            return Err(text);
        }
        Ok(r.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    /// `page.goto(url)`: navigate and wait for the load event.
    pub async fn goto(&self, url: &str) -> Result<(), String> {
        let mut events = self.cdp.events.subscribe();
        self.send("Page.enable", json!({})).await?;
        let r = self.send("Page.navigate", json!({ "url": url })).await?;
        if let Some(e) = r.get("errorText").and_then(Value::as_str).filter(|e| !e.is_empty()) {
            return Err(format!("page.goto: {e} at {url}"));
        }
        // A same-document navigation has no new loader and no load event.
        if r.get("loaderId").is_none() {
            return Ok(());
        }
        let session = self.session.clone();
        let wait = async {
            loop {
                match events.recv().await {
                    Ok(ev)
                        if ev.get("method").and_then(Value::as_str) == Some("Page.loadEventFired")
                            && ev.get("sessionId").and_then(Value::as_str) == Some(session.as_str()) =>
                    {
                        return Ok(());
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("The browser connection closed.".to_string());
                    }
                }
            }
        };
        tokio::time::timeout(ACTION_TIMEOUT, wait)
            .await
            .map_err(|_| format!("page.goto: Timeout {}ms exceeded.", ACTION_TIMEOUT.as_millis()))?
    }

    /// Wait for exactly one element and run `body` on it (as `el`), retrying
    /// while it is missing or hidden, like a Playwright locator action.
    async fn on_element(&self, what: &str, selector: &str, body: &str) -> Result<Value, String> {
        let expr = format!(
            "(() => {{ const all = document.querySelectorAll({sel}); if (all.length !== 1) return {{ count: all.length }}; const el = all[0]; el.scrollIntoView({{ block: 'center', inline: 'center' }}); const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return {{ count: 1, hidden: true }}; {body} }})()",
            sel = lit(selector)
        );
        let deadline = tokio::time::Instant::now() + ACTION_TIMEOUT;
        loop {
            let v = self.eval(&expr).await.map_err(|e| format!("locator.{what}: {e}"))?;
            let count = v.get("count").and_then(Value::as_u64);
            match count {
                Some(n) if n > 1 => {
                    return Err(format!(
                        "locator.{what}: Error: strict mode violation: locator('{selector}') resolved to {n} elements"
                    ));
                }
                Some(_) if v.get("hidden").is_none() && v.get("ok").is_some() => return Ok(v),
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "locator.{what}: Timeout {}ms exceeded.\nCall log:\n  - waiting for locator('{selector}')",
                    ACTION_TIMEOUT.as_millis()
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// `page.locator(selector).click()`: a left click at the element's centre.
    pub async fn click(&self, selector: &str) -> Result<(), String> {
        let v = self
            .on_element(
                "click",
                selector,
                "return { count: 1, ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };",
            )
            .await?;
        let (x, y) = (v["x"].as_f64().unwrap_or(0.0), v["y"].as_f64().unwrap_or(0.0));
        let mouse = |kind: &str, buttons: u8| json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": buttons, "clickCount": 1 });
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y })).await?;
        self.send("Input.dispatchMouseEvent", mouse("mousePressed", 1)).await?;
        self.send("Input.dispatchMouseEvent", mouse("mouseReleased", 0)).await?;
        Ok(())
    }

    /// `page.locator(selector).fill(value)`: clear the field and type the
    /// value in as one insertion, firing `input` like a user's edit.
    pub async fn fill(&self, selector: &str, value: &str) -> Result<(), String> {
        let body = "const editable = el.isContentEditable; const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement; if (!editable && !field) throw new Error('Element is not an <input>, <textarea>, <select> or [contenteditable] element'); el.focus(); if (field) { el.value = ''; } else { el.textContent = ''; } el.dispatchEvent(new Event('input', { bubbles: true })); return { count: 1, ok: true };";
        self.on_element("fill", selector, body).await?;
        if !value.is_empty() {
            self.send("Input.insertText", json!({ "text": value })).await?;
        }
        self.eval(&format!(
            "(() => {{ const el = document.querySelector({}); if (el) el.dispatchEvent(new Event('change', {{ bubbles: true }})); }})()",
            lit(selector)
        ))
        .await?;
        Ok(())
    }

    /// The page's title and the first 6,000 UTF-16 units of its text.
    pub async fn read(&self) -> Result<String, String> {
        let v = self.eval("[document.title, document.body ? document.body.innerText : '']").await?;
        let title = v.get(0).map(js::display).unwrap_or_default();
        let body = v.get(1).map(js::display).unwrap_or_default();
        Ok(format!("{title}\n{}", js::slice16(&body, 6000)))
    }
}
