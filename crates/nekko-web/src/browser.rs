//! The `browser` and `capture` tools, ported from `controlBrowser` and
//! `captureApp` in `packages/host/src/tools.ts` and `validateBrowserInput`
//! in `packages/shared/src/browser-tool.ts`.
//!
//! Every action is asked for first (severity high), with the same prompt
//! text. Dedicated mode and window capture go to the desktop app's bridge
//! (the in-app browser and the window capturer live in Electron main, hidden
//! and unfocusable); existing mode drives the user's own Chromium on a
//! loopback DevTools port the user enabled ([`crate::cdp`], where the TS host
//! used Stagehand and Playwright), and disconnecting never closes it.
//! Screenshots travel as image attachments, never as base64 in the text.

use crate::cdp::Cdp;
use nekko_js as js;
use nekko_tools::path::native;
use nekko_tools::{BoxFuture, Cancel, Severity, ToolCall, ToolContext, assert_in_jail, resolve_path};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const BASIC: &[&str] = &["navigate", "inspect", "click", "fill", "close"];
const DEDICATED: &[&str] = &[
    "wait",
    "type",
    "press",
    "scroll",
    "extract",
    "evaluate",
    "screenshot",
    "tabs",
    "tab_new",
    "tab_switch",
    "tab_close",
    "logs",
];
const WAIT_STATES: &[&str] = &["visible", "attached", "hidden", "detached"];
const SCROLL_DIRECTIONS: &[&str] = &["up", "down", "left", "right"];
const EXTRACT_KINDS: &[&str] = &["text", "links"];
const MAX_WAIT_MS: f64 = 20_000.0;
/// The bridge request's time limit.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn is_http_url(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| {
        s.len() >= 7 && {
            let lower = s.get(..8).unwrap_or(s).to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://")
        }
    })
}

fn optional_string<'a>(input: &'a Value, key: &str, max: usize) -> Result<Option<&'a str>, String> {
    match input.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if js::len16(s) <= max => Ok(Some(s)),
        Some(_) => Err(format!("{key} must be a string of at most {max} characters.")),
    }
}

fn finite_in(v: Option<&Value>, lo: f64, hi: f64) -> bool {
    v.and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n >= lo && n <= hi)
}

fn one_of(v: Option<&Value>, set: &[&str]) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| set.contains(&s))
}

/// `validateBrowserInput(input)`: the action, or why the input cannot run.
pub fn validate_browser_input(input: &Value) -> Result<String, String> {
    let action = match input.get("action").and_then(Value::as_str) {
        Some(a) if BASIC.contains(&a) || DEDICATED.contains(&a) => a.to_string(),
        _ => return Err("Unsupported browser action.".into()),
    };
    let a = action.as_str();
    let selector = optional_string(input, "selector", 500)?;
    let has_selector = selector.is_some_and(|s| !s.is_empty());
    if a == "navigate" && !is_http_url(input.get("url")) {
        return Err("Only HTTP(S) pages can be opened.".into());
    }
    if a == "tab_new" && input.get("url").is_some() && !is_http_url(input.get("url")) {
        return Err("Only HTTP(S) pages can be opened.".into());
    }
    if (a == "click" || a == "fill") && !has_selector {
        return Err("A CSS selector is required.".into());
    }
    if a == "fill"
        && let Some(v) = input.get("value")
        && !matches!(v, Value::String(s) if js::len16(s) <= 10_000)
    {
        return Err("value must be a string of at most 10000 characters.".into());
    }
    if a == "type" && !matches!(input.get("text"), Some(Value::String(s)) if !s.is_empty() && js::len16(s) <= 10_000) {
        return Err("type needs text of at most 10000 characters.".into());
    }
    if a == "press"
        && !matches!(input.get("key"), Some(Value::String(k)) if (1..=50).contains(&k.len()) && k.bytes().all(|b| (0x21..=0x7e).contains(&b)))
    {
        return Err("press needs a key such as Enter, Tab, ArrowDown or Control+A.".into());
    }
    if a == "wait" {
        let text = optional_string(input, "text", 500)?;
        if !has_selector && text.is_none_or(|t| t.is_empty()) {
            return Err("wait needs a selector or text.".into());
        }
        if input.get("state").is_some() && !one_of(input.get("state"), WAIT_STATES) {
            return Err(format!("state must be one of {}.", WAIT_STATES.join(", ")));
        }
    }
    if input.get("timeout_ms").is_some() && !finite_in(input.get("timeout_ms"), 0.0, MAX_WAIT_MS) {
        return Err(format!("timeout_ms must be between 0 and {MAX_WAIT_MS}."));
    }
    if a == "scroll" {
        if input.get("direction").is_some() && !one_of(input.get("direction"), SCROLL_DIRECTIONS) {
            return Err(format!("direction must be one of {}.", SCROLL_DIRECTIONS.join(", ")));
        }
        if input.get("amount").is_some() && !finite_in(input.get("amount"), 1.0, 20_000.0) {
            return Err("amount must be between 1 and 20000 pixels.".into());
        }
    }
    if a == "extract" && input.get("what").is_some() && !one_of(input.get("what"), EXTRACT_KINDS) {
        return Err(format!("what must be one of {}.", EXTRACT_KINDS.join(", ")));
    }
    if a == "evaluate"
        && !matches!(input.get("expression"), Some(Value::String(e)) if !js::trim(e).is_empty() && js::len16(e) <= 5_000)
    {
        return Err("evaluate needs an expression of at most 5000 characters.".into());
    }
    if (a == "tab_switch" || (a == "tab_close" && input.get("tab").is_some()))
        && !input.get("tab").and_then(Value::as_f64).is_some_and(|t| t.fract() == 0.0 && (0.0..=50.0).contains(&t))
    {
        return Err("tab must be a tab index from the tabs action.".into());
    }
    if input.get("visible").is_some() && !input.get("visible").is_some_and(Value::is_boolean) {
        return Err("visible must be a boolean.".into());
    }
    Ok(action)
}

/// The desktop app's bridge to its in-app browser and window capturer.
pub trait Bridge: Send + Sync {
    /// POST a request; `(ok, body)` where `ok` is the HTTP status's.
    fn post<'a>(&'a self, body: &'a Value, cancel: &'a Cancel) -> BoxFuture<'a, Result<(bool, Value), String>>;
}

/// The real bridge: `POST <url>` with the bearer token.
pub struct HttpBridge {
    url: String,
    token: String,
    client: reqwest::Client,
}

impl HttpBridge {
    pub fn new(url: String, token: String) -> Self {
        let client = reqwest::Client::builder().no_proxy().build().unwrap_or_default();
        Self { url, token, client }
    }
}

impl Bridge for HttpBridge {
    fn post<'a>(&'a self, body: &'a Value, cancel: &'a Cancel) -> BoxFuture<'a, Result<(bool, Value), String>> {
        Box::pin(async move {
            let req = self
                .client
                .post(&self.url)
                .header("Authorization", format!("Bearer {}", self.token))
                .header("Content-Type", "application/json")
                .body(js::stringify(body));
            let work = async {
                let res = req.send().await.map_err(|_| "fetch failed".to_string())?;
                let ok = res.status().is_success();
                let text = res.text().await.map_err(|_| "terminated".to_string())?;
                let v = serde_json::from_str::<Value>(&text)
                    .map_err(|e| format!("Unexpected JSON from the bridge: {e}"))?;
                Ok((ok, v))
            };
            tokio::select! {
                r = work => r,
                _ = tokio::time::sleep(BRIDGE_TIMEOUT) => Err("The operation was aborted due to timeout".into()),
                _ = cancel.cancelled() => Err("This operation was aborted".into()),
            }
        })
    }
}

/// Which chats have a browser session open, and the existing-mode
/// connections (`dedicatedBrowsers` and `browsers` in tools.ts).
#[derive(Default)]
pub struct Browsers {
    dedicated: Mutex<HashSet<String>>,
    existing: Mutex<HashMap<String, Arc<Cdp>>>,
}

impl Browsers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Disconnect a chat's existing-mode browser (the browser stays open).
    pub fn forget(&self, session_id: &str) {
        lock(&self.existing).remove(session_id);
        lock(&self.dedicated).remove(session_id);
    }
}

/// What a tool returns: `{ toolCallId, output, isError?, images? }`.
fn ok(call: &ToolCall, output: impl Into<String>) -> Value {
    json!({ "toolCallId": call.id, "output": output.into() })
}

fn err(call: &ToolCall, output: impl Into<String>) -> Value {
    json!({ "toolCallId": call.id, "output": output.into(), "isError": true })
}

fn with_image(mut v: Value, data_url: String) -> Value {
    v["images"] = json!([data_url]);
    v
}

async fn approve(call: &ToolCall, ctx: &ToolContext, reason: &str) -> bool {
    tokio::select! {
        ok = ctx.approver.approve(call, reason, Severity::High) => ok,
        _ = ctx.cancel.cancelled() => false,
    }
}

/// `String(v)`, for values a template literal shows.
fn show(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => js::display(v),
    }
}

/// The approval prompt for a browser action, after its checks pass.
pub fn browser_reason(input: &Value, mode: &str, action: &str) -> String {
    let url = if action == "navigate" || action == "tab_new" {
        input.get("url").filter(|v| !v.is_null()).map(js::display).unwrap_or_default()
    } else {
        String::new()
    };
    let selector = input.get("selector").filter(|v| !v.is_null()).map(js::display).unwrap_or_default();
    let detail = match action {
        "evaluate" => format!(" {}", js::slice16(&show(input.get("expression")), 300)),
        "type" => format!(" {}", js::stringify(&json!(js::slice16(&show(input.get("text")), 120)))),
        "press" => format!(" {}", show(input.get("key"))),
        "wait" if selector.is_empty() => {
            let text = input.get("text").filter(|v| !v.is_null()).map(js::display).unwrap_or_default();
            format!(" text {}", js::stringify(&json!(text)))
        }
        "tab_switch" | "tab_close" => {
            format!(
                " {}",
                input.get("tab").filter(|v| !v.is_null()).map(js::display).unwrap_or_else(|| "current".into())
            )
        }
        _ => String::new(),
    };
    let disclosure = match action {
        "screenshot" => " Page pixels will be sent to the selected chat model for inspection.",
        "evaluate" => " The expression runs as script inside the page.",
        _ => "",
    };
    let url = if url.is_empty() { url } else { format!(" {url}") };
    let selector = if selector.is_empty() { selector } else { format!(" {selector}") };
    format!("Browser {mode}: {action}{url}{selector}{detail}.{disclosure}")
}

/// The checks `controlBrowser` makes before asking: the mode, the action and
/// the port, or the error the tool returns.
pub fn browser_preflight(input: &Value) -> Result<(String, String, Option<u16>), String> {
    let mode = input.get("mode").and_then(Value::as_str);
    if input.get("visible").is_some()
        && (!input.get("visible").is_some_and(Value::is_boolean) || mode != Some("dedicated"))
    {
        return Err("visible is a boolean for dedicated mode only.".into());
    }
    let mode = match mode {
        Some(m @ ("dedicated" | "existing")) => m.to_string(),
        _ => return Err("Choose dedicated or existing browser mode.".into()),
    };
    let action = validate_browser_input(input)?;
    if mode == "existing" && DEDICATED.contains(&action.as_str()) {
        return Err(format!(
            "The {action} action needs dedicated mode (the in-app browser). Existing mode supports navigate, inspect, click, fill and close."
        ));
    }
    let port = if mode == "existing" {
        let n = match input.get("port") {
            None | Some(Value::Null) => 9222.0,
            Some(v) => js::to_number(Some(v)),
        };
        if !(n.fract() == 0.0 && (1.0..=65535.0).contains(&n)) {
            return Err("CDP port must be a local TCP port.".into());
        }
        Some(n as u16)
    } else {
        None
    };
    Ok((mode, action, port))
}

/// `controlBrowser(call, opts)`.
pub async fn browser_tool(
    call: &ToolCall,
    ctx: &ToolContext,
    allow: bool,
    bridge: Option<&dyn Bridge>,
    browsers: &Browsers,
) -> Value {
    let Some(sid) = ctx.session_id.clone().filter(|s| !s.is_empty() && allow) else {
        return err(call, "Browser control is available only in a local desktop chat.");
    };
    let input = &call.input;
    let (mode, action, port) = match browser_preflight(input) {
        Ok(p) => p,
        Err(e) => return err(call, e),
    };
    let existing = lock(&browsers.existing).get(&sid).cloned();
    if (mode == "existing" && lock(&browsers.dedicated).contains(&sid))
        || existing.as_ref().is_some_and(|e| mode != "existing" || Some(e.port()) != port)
    {
        return err(call, "Close the current browser session before switching modes or ports.");
    }
    if !approve(call, ctx, &browser_reason(input, &mode, &action)).await {
        return err(call, "Browser action not approved.");
    }
    if mode == "dedicated" {
        let Some(bridge) = bridge else {
            return err(call, "In-app browser is unavailable. Restart the desktop app to enable it.");
        };
        let mut body = input.as_object().cloned().unwrap_or_default();
        body.insert("sessionId".into(), json!(sid));
        let (status_ok, result) = match bridge.post(&Value::Object(body), &ctx.cancel).await {
            Ok(r) => r,
            Err(e) => return err(call, e),
        };
        if status_ok {
            if action == "close" {
                lock(&browsers.dedicated).remove(&sid);
            } else {
                lock(&browsers.dedicated).insert(sid.clone());
            }
        }
        if !status_ok {
            return err(
                call,
                result
                    .get("error")
                    .filter(|e| !e.is_null())
                    .map(js::display)
                    .unwrap_or_else(|| "In-app browser action failed.".into()),
            );
        }
        let output = result.get("output").filter(|o| !o.is_null()).map(js::display);
        if action == "screenshot" {
            let image = result.get("image");
            let data = image.and_then(|i| i.get("data")).and_then(Value::as_str).filter(|d| !d.is_empty());
            let mime_ok = image.and_then(|i| i.get("mime")) == Some(&json!("image/png"));
            let Some(data) = data.filter(|d| mime_ok && d.len() <= 7 * 1024 * 1024) else {
                return err(call, "In-app browser returned an invalid screenshot.");
            };
            let text = format!(
                "{}\nPixels attached to the selected model; vision support is required.",
                output.unwrap_or_else(|| "Screenshot taken.".into())
            );
            return with_image(ok(call, text), format!("data:image/png;base64,{data}"));
        }
        return ok(call, output.unwrap_or_default());
    }
    let port = port.unwrap_or(9222);
    if action == "close" {
        // Only the connection closes; the browser is the user's.
        lock(&browsers.existing).remove(&sid);
        return ok(call, "Browser session disconnected.");
    }
    let cdp = match existing.filter(|c| c.alive()) {
        Some(c) => c,
        None => match Cdp::connect(port).await {
            Ok(c) => {
                let c = Arc::new(c);
                lock(&browsers.existing).insert(sid.clone(), c.clone());
                c
            }
            Err(e) => return err(call, e),
        },
    };
    let run = async {
        let Some(page) = cdp.active_page().await? else {
            return Ok::<Value, String>(err(call, "No active browser tab. Open a page and try again."));
        };
        let selector = input.get("selector").and_then(Value::as_str).unwrap_or_default();
        match action.as_str() {
            "navigate" => page.goto(input.get("url").and_then(Value::as_str).unwrap_or_default()).await?,
            "click" => page.click(selector).await?,
            "fill" => {
                page.fill(selector, input.get("value").and_then(Value::as_str).unwrap_or_default()).await?;
                return Ok(ok(call, "Field filled."));
            }
            _ => {}
        }
        Ok(ok(call, page.read().await?))
    };
    tokio::select! {
        r = run => r.unwrap_or_else(|e| err(call, e)),
        _ = ctx.cancel.cancelled() => err(call, "Browser action cancelled."),
    }
}

/// `fs.realpathSync(p)` as a plain path (no `\\?\` prefix on Windows).
fn realpath(p: &str) -> Result<String, String> {
    let real =
        std::fs::canonicalize(p).map_err(|e| format!("{}: {e}, realpath '{p}'", nekko_tools::node_error_code(&e)))?;
    let s = real.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return Ok(rest.to_string());
        }
    }
    Ok(s)
}

fn dirname(p: &str) -> String {
    native::resolve(&[p, ".."])
}

fn outside(rel: &str) -> bool {
    rel.starts_with("..") || native::is_absolute(rel)
}

/// `Buffer.from(s, 'base64')`: lenient, as Node is (url-safe letters
/// accepted, anything else skipped, decoding stops at padding).
pub fn decode_base64(s: &str) -> Vec<u8> {
    let value = |c: u8| -> Option<u8> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = value(c) else { continue };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn encode_base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// The checks on a capture's input before any file system work.
pub fn capture_input_error(input: &Value) -> Option<&'static str> {
    if !one_of(input.get("action"), &["list", "screenshot", "record"]) {
        return Some("Choose list, screenshot, or record.");
    }
    if input.get("inspect").is_some_and(|v| !v.is_boolean()) {
        return Some("inspect must be a boolean.");
    }
    None
}

/// `captureApp(call, opts)`.
pub async fn capture_tool(call: &ToolCall, ctx: &ToolContext, allow: bool, bridge: Option<&dyn Bridge>) -> Value {
    match capture(call, ctx, allow, bridge).await {
        Ok(v) => v,
        Err(e) => err(call, e),
    }
}

async fn capture(
    call: &ToolCall,
    ctx: &ToolContext,
    allow: bool,
    bridge: Option<&dyn Bridge>,
) -> Result<Value, String> {
    let Some(sid) = ctx.session_id.clone().filter(|s| !s.is_empty() && allow) else {
        return Ok(err(call, "Window capture is available only in a local desktop chat."));
    };
    let input = &call.input;
    if let Some(e) = capture_input_error(input) {
        return Ok(err(call, e));
    }
    let action = input.get("action").and_then(Value::as_str).unwrap_or_default();
    let base = ctx
        .default_cwd
        .clone()
        .or_else(|| ctx.workspaces.first().map(|w| w.path.clone()))
        .unwrap_or_else(nekko_tools::path::process_cwd);
    let root = realpath(&base)?;
    let mut output_path: Option<String> = None;
    if action != "list" {
        if !matches!(input.get("window_id"), Some(Value::String(w)) if !w.is_empty()) {
            return Ok(err(call, "List windows and choose a window_id first."));
        }
        if !matches!(input.get("path"), Some(Value::String(p)) if !p.is_empty()) {
            return Ok(err(call, "An output path is required."));
        }
        let out = resolve_path(input.get("path"), ctx)?;
        assert_in_jail(&out, ctx)?;
        let mut parent = dirname(&out);
        while !std::path::Path::new(&parent).exists() {
            let up = dirname(&parent);
            if up == parent {
                break;
            }
            parent = up;
        }
        let actual = native::resolve(&[&realpath(&parent)?, &native::relative(&parent, &out)]);
        let rel = native::relative(&root, &actual);
        if rel.is_empty() || outside(&rel) {
            return Ok(err(call, "Capture output must be inside the chat project, without escaping through links."));
        }
        let ext = if action == "record" { ".webm" } else { ".png" };
        if !out.to_lowercase().ends_with(ext) {
            return Ok(err(call, "Use .png for screenshots or .webm for recordings."));
        }
        if std::path::Path::new(&out).exists() {
            return Ok(err(call, "Capture output already exists; choose a new path."));
        }
        if action == "record" {
            let secs = match input.get("seconds") {
                None | Some(Value::Null) => 5.0,
                Some(v) => js::to_number(Some(v)),
            };
            if !secs.is_finite() || !(1.0..=15.0).contains(&secs) {
                return Ok(err(call, "Recording duration must be 1\u{2013}15 seconds."));
            }
        }
        output_path = Some(out);
    }
    let inspect = action == "screenshot" && input.get("inspect") != Some(&Value::Bool(false));
    let window = input
        .get("window_id")
        .filter(|w| js::truthy(Some(w)))
        .map(|w| format!(" {}", js::display(w)))
        .unwrap_or_default();
    let target = output_path.as_ref().map(|p| format!(" \u{2192} {p}")).unwrap_or_default();
    let reason = format!(
        "Window capture: {action}{window}{target}. Window content may contain private information.{}",
        if inspect { " Screenshot pixels will also be sent to the selected chat model for inspection." } else { "" }
    );
    if !approve(call, ctx, &reason).await {
        return Ok(err(call, "Window capture not approved."));
    }
    if ctx.cancel.is_cancelled() {
        return Ok(err(call, "Capture cancelled."));
    }
    let Some(bridge) = bridge else {
        return Ok(err(
            call,
            "Desktop capture bridge is unavailable. Restart the desktop app; no browser fallback was used.",
        ));
    };
    let mut body = Map::new();
    body.insert("tool".into(), json!("capture"));
    body.insert("sessionId".into(), json!(sid));
    for key in ["action", "window_id", "seconds"] {
        if let Some(v) = input.get(key) {
            body.insert(key.into(), v.clone());
        }
    }
    let (status_ok, result) = bridge.post(&Value::Object(body), &ctx.cancel).await?;
    let failure = result.get("error").filter(|e| js::truthy(Some(e)));
    if !status_ok || failure.is_some() {
        return Ok(err(call, failure.map(js::display).unwrap_or_else(|| "Window capture failed.".into())));
    }
    let Some(out) = output_path else { return Ok(ok(call, js::stringify_pretty(&result, "  "))) };
    let mime = if action == "record" { "video/webm" } else { "image/png" };
    let data = result.get("data").and_then(Value::as_str).filter(|d| js::len16(d) <= 30 * 1024 * 1024);
    let Some(data) = data.filter(|_| result.get("mime") == Some(&json!(mime))) else {
        return Ok(err(call, "Desktop bridge returned invalid capture media."));
    };
    let media = decode_base64(data);
    if media.is_empty() {
        return Ok(err(call, "Desktop bridge returned empty capture media."));
    }
    if ctx.cancel.is_cancelled() {
        return Ok(err(call, "Capture cancelled."));
    }
    let dir = dirname(&out);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Revalidate after approval and capture: a link may have changed meanwhile.
    let final_rel = native::relative(&root, &realpath(&dir)?);
    if outside(&final_rel) {
        return Ok(err(call, "Capture output directory escaped the chat project."));
    }
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&out)
            .map_err(|e| format!("{}: {e}, open '{out}'", nekko_tools::node_error_code(&e)))?;
        f.write_all(&media).map_err(|e| e.to_string())?;
    }
    let attached = inspect && media.len() <= 5 * 1024 * 1024;
    let mut meta = result.as_object().cloned().unwrap_or_default();
    meta.shift_remove("data");
    meta.insert("path".into(), json!(out));
    meta.insert("bytes".into(), json!(media.len()));
    let inspection = if attached {
        "Pixels attached to the selected model; vision support is required. Capture alone does not prove verification."
    } else if inspect {
        "Saved, but too large for model inspection (5 MB limit). No pixels attached."
    } else {
        "Saved without model inspection."
    };
    meta.insert("inspection".into(), json!(inspection));
    let text = js::stringify_pretty(&Value::Object(meta), "  ");
    Ok(if attached {
        with_image(ok(call, text), format!("data:image/png;base64,{}", encode_base64(&media)))
    } else {
        ok(call, text)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_as_lenient_as_node() {
        assert_eq!(decode_base64("cG5nLWJ5dGVz"), b"png-bytes");
        assert_eq!(decode_base64("cG5n LWJ5\ndGVz"), b"png-bytes");
        assert_eq!(decode_base64("aGk="), b"hi");
        assert_eq!(decode_base64("aGk=aGk="), b"hi");
        assert_eq!(decode_base64("-_8"), vec![0xfb, 0xff]);
        assert_eq!(encode_base64(b"png-bytes"), "cG5nLWJ5dGVz");
        assert_eq!(encode_base64(b"hi"), "aGk=");
    }

    #[test]
    fn checks_browser_input_like_the_shared_validator() {
        let bad = |input: Value, msg: &str| {
            let e = browser_preflight(&input).unwrap_err();
            assert!(e.contains(msg), "{input}: {e}");
        };
        bad(json!({ "mode": "dedicated", "action": "teleport" }), "Unsupported browser action");
        bad(json!({ "mode": "dedicated", "action": "wait" }), "selector or text");
        bad(json!({ "mode": "dedicated", "action": "wait", "text": "Done", "timeout_ms": 60_000 }), "timeout_ms");
        bad(json!({ "mode": "dedicated", "action": "press", "key": "Enter Enter" }), "press needs a key");
        bad(json!({ "mode": "existing", "action": "screenshot" }), "needs dedicated mode");
        bad(json!({ "mode": "existing", "action": "inspect", "port": 70000 }), "CDP port");
        bad(json!({ "mode": "existing", "action": "inspect", "visible": true }), "visible is a boolean");
        assert_eq!(
            browser_preflight(&json!({ "mode": "existing", "action": "inspect" })).unwrap(),
            ("existing".into(), "inspect".into(), Some(9222))
        );
    }
}
