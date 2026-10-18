// Dedicated Nekko inherited-stdio entrypoint. Upstream CLI main is not compiled.
// Any upstream diagnostic macro must never corrupt protocol stdout.
macro_rules! println { ($($arg:tt)*) => { eprintln!($($arg)*) }; }
macro_rules! print { ($($arg:tt)*) => { eprint!($($arg)*) }; }
mod ca_bundle;
mod color;
mod commands;
mod connection;
mod flags;
mod install;
mod native;
mod output;
mod plugins;
mod read;
mod tls;
mod validation;

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use native::actions::{execute_command, DaemonState};
const MAX: usize = 1_048_576;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello { r#type: String, protocol: u32, capability: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { r#type: String, capability: String, command: Value }
fn frame(input: &mut impl BufRead) -> Result<Option<Vec<u8>>, ()> {
    let mut out = Vec::new();
    loop {
        let buf = input.fill_buf().map_err(|_| ())?;
        if buf.is_empty() { return if out.is_empty() { Ok(None) } else { Err(()) }; }
        let end = buf.iter().position(|b| *b == b'\n').map(|p| p + 1);
        let n = end.unwrap_or(buf.len());
        if out.len() + n > MAX { return Err(()); }
        out.extend_from_slice(&buf[..n]);
        input.consume(n);
        if end.is_some() { return Ok(Some(out)); }
    }
}
fn send(value: Value) -> Result<(), ()> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| ())?;
    if bytes.len() + 1 > MAX {
        bytes = serde_json::to_vec(&json!({"id":value["id"],"success":false,"error":"response_too_large"})).map_err(|_| ())?;
    }
    bytes.push(b'\n');
    let mut out = io::stdout().lock();
    out.write_all(&bytes).and_then(|_| out.flush()).map_err(|_| ())
}
fn permitted(cmd: &Value) -> Result<(), &'static str> {
    let obj = cmd.as_object().ok_or("command_must_be_object")?;
    let id = cmd["id"].as_str().ok_or("id_required")?;
    if id.is_empty() || id.len() > 256 { return Err("invalid_id"); }
    let action = cmd["action"].as_str().ok_or("action_required")?;
    let fields: &[&str] = match action {
        "launch" => &["cdpUrl"],
        "session_info" | "close" | "url" | "title" | "content" | "back" | "forward" | "reload" => &[],
        "navigate" => &["url", "waitUntil"],
        "snapshot" => &["interactive", "compact", "depth", "selector"],
        "evaluate" => &["script"],
        "click" | "dblclick" | "hover" | "check" | "uncheck" => &["selector"],
        "fill" => &["selector", "value"],
        "type" => &["selector", "text"],
        "press" => &["key", "selector"],
        "scroll" => &["direction", "amount", "selector"],
        "select" => &["selector", "values"],
        "gettext" | "isvisible" | "isenabled" | "ischecked" => &["selector"],
        "getattribute" => &["selector", "attribute"],
        _ => return Err("unsupported_action"),
    };
    if obj.keys().any(|k| k != "id" && k != "action" && !fields.contains(&k.as_str())) { return Err("unsupported_field"); }
    if action == "launch" {
        let endpoint = cmd["cdpUrl"].as_str().ok_or("external_cdp_required")?;
        let url = url::Url::parse(endpoint).map_err(|_| "invalid_cdp_url")?;
        if !matches!(url.scheme(), "ws" | "wss" | "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return Err("invalid_cdp_url"); }
    }
    Ok(())
}
fn run() -> Result<(), ()> {
    if std::env::args_os().len() != 1 { return Err(()); }
    // Do not consume upstream configuration, provider secrets, proxy or daemon toggles.
    let allowed = ["SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
    for (key, _) in std::env::vars_os() {
        if !allowed.contains(&key.to_string_lossy().to_uppercase().as_str()) { std::env::remove_var(key); }
    }
    let mut input = io::BufReader::new(io::stdin());
    let hello: Hello = serde_json::from_slice(&frame(&mut input)?.ok_or(())?).map_err(|_| ())?;
    if hello.r#type != "hello" || hello.protocol != 1 || hello.capability.len() != 64 || !hello.capability.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(()); }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|_| ())?;
    let _guard = runtime.enter();
    let mut state = DaemonState::new();
    send(json!({"type":"ready","protocol":1}))?;
    while let Some(bytes) = frame(&mut input)? {
        let req: Request = serde_json::from_slice(&bytes).map_err(|_| ())?;
        // Fixed-size comparison, no early exit based on differing secret byte.
        if req.r#type != "request" || req.capability.len() != hello.capability.len() || req.capability.bytes().zip(hello.capability.bytes()).fold(0u8, |a,(b,c)| a | (b ^ c)) != 0 { return Err(()); }
        let response = match permitted(&req.command) {
            Err(error) => json!({"id": req.command.get("id"), "success":false,"error":error}),
            Ok(()) => runtime.block_on(execute_command(&req.command, &mut state)),
        };
        send(response)?;
    }
    Ok(())
}
fn main() { if run().is_err() { eprintln!("native stdio protocol rejected"); std::process::exit(2); } }
