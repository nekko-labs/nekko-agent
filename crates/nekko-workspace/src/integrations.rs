//! Installing Nekko Agent as an MCP server inside other agent CLIs (Claude
//! Code, Codex, Cursor, Windsurf). Ported from
//! `packages/host/src/integrations.ts`, with `mcpServerEntry` from
//! `@nekko-agent/shared`: `integrations:detect`, `integrations:install`,
//! `integrations:snippet`, and the refresh the desktop app runs when its
//! server's address or token changes (`integrations:refresh`).
//!
//! Each tool is detected by its user-level config directory; install merges a
//! `nekko-agent` entry into the tool's MCP config file, copying the file to
//! `<file>.bak` first and writing through a private temp file and a rename.
//! Codex's TOML is never parsed, only scanned lexically (strings and comments
//! blanked out) the way the TS host scans it, and a file that does not look
//! like TOML is refused rather than edited.
//!
//! The scan blanks one space per byte where the TS host blanks one per UTF-16
//! unit, so the blanked text lines up byte for byte with the original. Only
//! the structure of the blanked text is ever read, never its widths, so the
//! results are the same.

use nekko_js as js;
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// The server key written into every tool's MCP config.
const SERVER_NAME: &str = "nekko-agent";

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Json,
    Toml,
}

struct Tool {
    id: &'static str,
    label: &'static str,
    /// User-level config dirs, relative to home; any of them existing means the tool is present.
    detect_dirs: &'static [&'static [&'static str]],
    /// The MCP config file, relative to home.
    config_file: &'static [&'static str],
    format: Format,
    /// Where the manual snippet goes.
    snippet_target: &'static str,
}

const TOOLS: &[Tool] = &[
    Tool {
        id: "claude",
        label: "Claude Code",
        detect_dirs: &[&[".claude"]],
        config_file: &[".claude.json"],
        format: Format::Json,
        snippet_target: "~/.claude.json → \"mcpServers\"",
    },
    Tool {
        id: "codex",
        label: "Codex",
        detect_dirs: &[&[".codex"]],
        config_file: &[".codex", "config.toml"],
        format: Format::Toml,
        snippet_target: "~/.codex/config.toml",
    },
    Tool {
        id: "cursor",
        label: "Cursor",
        detect_dirs: &[&[".cursor"]],
        config_file: &[".cursor", "mcp.json"],
        format: Format::Json,
        snippet_target: "~/.cursor/mcp.json → \"mcpServers\"",
    },
    Tool {
        id: "windsurf",
        label: "Windsurf",
        detect_dirs: &[&[".windsurf"], &[".codeium", "windsurf"]],
        config_file: &[".codeium", "windsurf", "mcp_config.json"],
        format: Format::Json,
        snippet_target: "~/.codeium/windsurf/mcp_config.json → \"mcpServers\"",
    },
];

/// The channels served here.
pub const CHANNELS: &[&str] = &["integrations:detect", "integrations:install", "integrations:snippet"];

fn re(cell: &'static OnceLock<Regex>, src: &str, flags: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::with_flags(src, flags).expect("integration pattern compiles"))
}

/// `[mcp_servers.nekko-agent]`, bare or quoted, on a line of its own.
fn entry_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r#"^\s*\[\s*mcp_servers\s*\.\s*"?nekko-agent"?\s*\]\s*$"#, "m")
}

/// The start of the next table header.
fn next_header_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^\s*\[", "m")
}

fn spec_for(tool: &Value) -> Option<&'static Tool> {
    let id = tool.as_str()?;
    TOOLS.iter().find(|t| t.id == id)
}

fn under(home: &str, rel: &[&str]) -> String {
    let mut parts = vec![home];
    parts.extend_from_slice(rel);
    path::join(&parts)
}

/// The config file relative to home, as the TS host names it in messages.
fn config_file(spec: &Tool) -> String {
    path::join(spec.config_file)
}

fn detected(spec: &Tool, home: &str) -> bool {
    spec.detect_dirs.iter().any(|d| nodefs::exists(&under(home, d)))
}

/// `trimEnd()`, i.e. `replace(/\s+$/, '')`.
fn trim_end(s: &str) -> &str {
    s.trim_end_matches(js::is_js_space)
}

// ---- the entry ----

/// `mcpServerEntry(url, token, command)`: `npx -y nekko-agent mcp` with no
/// environment, or the app's launcher, with the server's address and token
/// when there are any.
pub fn mcp_server_entry(target: &Value) -> Value {
    let field = |k: &str| match target.get(k) {
        None | Some(Value::Null) => json!(""),
        Some(v) => v.clone(),
    };
    let (url, token, command) = (field("url"), field("token"), target.get("command").cloned().unwrap_or(Value::Null));
    let mut env = Map::new();
    if js::truthy(Some(&url)) {
        env.insert("NEKKO_URL".into(), url);
    }
    if js::truthy(Some(&token)) {
        env.insert("NEKKO_TOKEN".into(), token);
    }
    let mut entry = Map::new();
    if js::truthy(Some(&command)) {
        entry.insert("command".into(), command);
        entry.insert("args".into(), json!(["mcp"]));
    } else {
        entry.insert("command".into(), json!("npx"));
        entry.insert("args".into(), json!(["-y", "nekko-agent", "mcp"]));
    }
    if !env.is_empty() {
        entry.insert("env".into(), Value::Object(env));
    }
    Value::Object(entry)
}

/// A TOML basic string literal.
fn toml_string(v: &Value) -> String {
    format!("\"{}\"", js::display(v).replace('\\', "\\\\").replace('"', "\\\""))
}

/// The block appended to Codex's config.toml. `env` is an inline table so
/// the whole entry stays one appendable block.
fn toml_section(target: &Value) -> String {
    let entry = mcp_server_entry(target);
    let args: Vec<String> = entry["args"].as_array().map(|a| a.iter().map(toml_string).collect()).unwrap_or_default();
    let mut lines = vec![
        format!("[mcp_servers.{SERVER_NAME}]"),
        format!("command = {}", toml_string(&entry["command"])),
        format!("args = [{}]", args.join(", ")),
    ];
    if let Some(env) = entry.get("env").and_then(Value::as_object).filter(|e| !e.is_empty()) {
        let pairs: Vec<String> = env.iter().map(|(k, v)| format!("{k} = {}", toml_string(v))).collect();
        lines.push(format!("env = {{ {} }}", pairs.join(", ")));
    }
    format!("{}\n", lines.join("\n"))
}

// ---- the TOML scan ----

/// `scanToml`: the text with string contents and comments blanked to spaces
/// (newlines kept), and whether it could be read confidently (an
/// unterminated string makes everything after it untrustworthy).
fn scan_toml(text: &str) -> (String, bool) {
    let b = text.as_bytes();
    let n = b.len();
    let mut c = b.to_vec();
    let blank = |c: &mut Vec<u8>, i: usize| {
        if c[i] != b'\n' && c[i] != b'\r' {
            c[i] = b' ';
        }
    };
    let done = |c: Vec<u8>| String::from_utf8(c).unwrap_or_default();
    let mut i = 0;
    while i < n {
        let ch = b[i];
        if ch == b'#' {
            while i < n && b[i] != b'\n' {
                blank(&mut c, i);
                i += 1;
            }
            continue;
        }
        if ch == b'"' || ch == b'\'' {
            let triple = b[i..].starts_with(&[ch, ch, ch]);
            let len = if triple { 3 } else { 1 };
            for k in 0..len {
                blank(&mut c, i + k);
            }
            i += len;
            let mut closed = false;
            while i < n {
                if b[i] == ch && (!triple || b[i..].starts_with(&[ch, ch, ch])) {
                    for k in 0..len {
                        blank(&mut c, i + k);
                    }
                    i += len;
                    closed = true;
                    break;
                }
                if !triple && b[i] == b'\n' {
                    break; // a bare newline: unterminated
                }
                if ch == b'"' && b[i] == b'\\' {
                    // A backslash escapes the next character in basic strings.
                    blank(&mut c, i);
                    if i + 1 < n {
                        blank(&mut c, i + 1);
                    }
                    i += 2;
                    continue;
                }
                blank(&mut c, i);
                i += 1;
            }
            if !closed {
                while i < n {
                    blank(&mut c, i);
                    i += 1;
                }
                return (done(c), false);
            }
            continue;
        }
        i += 1;
    }
    (done(c), true)
}

/// `tomlLooksParseable`: every line of the blanked text is a table header, a
/// `key = value` pair, or part of a multiline array or inline table.
fn toml_looks_parseable(clean: &str) -> bool {
    static HEADER: OnceLock<Regex> = OnceLock::new();
    static KEY: OnceLock<Regex> = OnceLock::new();
    let header = re(&HEADER, r"^\[\[?[^\[\]]+\]?\]$", "");
    let bare_key = re(&KEY, r"^[A-Za-z0-9_-]+(\s*\.\s*[A-Za-z0-9_-]+)*$", "");
    let mut depth: i64 = 0;
    let count = |s: &str, depth: &mut i64| -> bool {
        for ch in s.chars() {
            match ch {
                '[' | '{' => *depth += 1,
                ']' | '}' => *depth -= 1,
                _ => {}
            }
            if *depth < 0 {
                return false;
            }
        }
        true
    };
    for raw in clean.split('\n') {
        let line = js::trim(raw);
        if depth > 0 {
            if !count(line, &mut depth) {
                return false;
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            if header.find(line).is_none() {
                return false;
            }
            continue;
        }
        let Some(eq) = line.find('=') else { return false };
        let key = js::trim(&line[..eq]);
        // An empty key is a blanked-out quoted key; that's fine.
        if !key.is_empty() && bare_key.find(key).is_none() {
            return false;
        }
        if !count(&line[eq + 1..], &mut depth) {
            return false;
        }
    }
    depth == 0
}

/// `checkTomlConfig`: (installed, confident).
fn check_toml(text: &str) -> (bool, bool) {
    let (clean, confident) = scan_toml(text);
    if !confident || !toml_looks_parseable(&clean) {
        return (false, false);
    }
    (entry_re().find(&clean).is_some(), true)
}

/// The byte range of the existing `[mcp_servers.nekko-agent]` block: from its
/// header to the next header at the start of a line (`start`, `after_header`,
/// `end`), with `end` `None` when it runs to the end of the file.
fn toml_block(clean: &str) -> Option<(usize, usize, Option<usize>)> {
    let header = entry_re().find(clean)?;
    let after = header.end();
    let next = next_header_re().find(&clean[after..]).map(|m| after + m.start());
    Some((header.start(), after, next))
}

/// `replaceTomlSection`: the text with an existing block replaced by `section`,
/// or `None` if there isn't one.
fn replace_toml_section(text: &str, section: &str) -> Option<String> {
    let (clean, confident) = scan_toml(text);
    if !confident {
        return None;
    }
    let (start, _, next) = toml_block(&clean)?;
    let before = trim_end(&text[..start]);
    let mut out = if before.is_empty() { String::new() } else { format!("{before}\n\n") };
    out.push_str(section);
    if let Some(end) = next {
        out.push('\n');
        out.push_str(text[end..].trim_start_matches(js::is_js_space));
    }
    Some(out)
}

// ---- reading configs ----

/// The tool's config file, or `None` when it can't be read.
fn read_config(spec: &Tool, home: &str) -> Option<String> {
    nodefs::read_utf8(&under(home, spec.config_file)).ok()
}

/// `JSON.parse` with JavaScript's property order.
fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().map(js::js_order)
}

fn is_installed(spec: &Tool, home: &str) -> bool {
    let Some(text) = read_config(spec, home).filter(|t| !t.is_empty()) else { return false };
    if spec.format == Format::Toml {
        return check_toml(&text).0;
    }
    match parse_json(&text) {
        Some(cfg) => js::truthy(cfg.get("mcpServers").and_then(|s| s.as_object()).and_then(|s| s.get(SERVER_NAME))),
        None => false,
    }
}

/// `detectAgentTools(home)`: which agent CLIs have a config dir, and whether
/// Nekko is already wired in.
pub fn detect(home: &str) -> Value {
    Value::Array(
        TOOLS
            .iter()
            .map(|spec| {
                json!({
                    "id": spec.id,
                    "label": spec.label,
                    "configPath": under(home, spec.config_file),
                    "detected": detected(spec, home),
                    "installed": is_installed(spec, home),
                })
            })
            .collect(),
    )
}

/// `isOwnEntry`: the portable `npx … nekko-agent mcp` form, or the launcher
/// the desktop app installs. Anything else was written by hand. A command
/// that is not a string fails as `command.split` does in the TS host.
pub fn is_own_entry(command: &Value, args: &[Value]) -> Result<bool, String> {
    if !js::truthy(Some(command)) {
        return Ok(false);
    }
    let Some(command) = command.as_str() else { return Err("command.split is not a function".into()) };
    if command == "npx" {
        return Ok(args.iter().any(|a| a.as_str() == Some(SERVER_NAME)));
    }
    let leaf = command.rsplit(['\\', '/']).next().unwrap_or("");
    static LEAF: OnceLock<Regex> = OnceLock::new();
    Ok(re(&LEAF, r"^nekko-agent(\.cmd)?$", "i").find(leaf).is_some())
}

/// The existing entry's command and args, from either config format.
fn existing_entry(spec: &Tool, home: &str) -> Option<(Value, Vec<Value>)> {
    let text = read_config(spec, home)?;
    if spec.format == Format::Json {
        let cfg = parse_json(&text)?;
        let e = cfg.as_object()?.get("mcpServers")?.as_object()?.get(SERVER_NAME)?;
        if !js::truthy(Some(e)) {
            return None;
        }
        let command = e.get("command").cloned().unwrap_or(Value::Null);
        let args = e.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
        return Some((command, args));
    }
    let (clean, confident) = scan_toml(&text);
    if !confident {
        return None;
    }
    let (_, after, next) = toml_block(&clean)?;
    let body = &text[after..next.unwrap_or(text.len())];
    static COMMAND: OnceLock<Regex> = OnceLock::new();
    static ARGS: OnceLock<Regex> = OnceLock::new();
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    let command = re(&COMMAND, r#"^\s*command\s*=\s*"((?:[^"\\]|\\.)*)""#, "m")
        .find(body)
        .and_then(|m| m.group(1))
        .map(|r| json!(body[r].replace("\\\\", "\\")))
        .unwrap_or(Value::Null);
    let raw = re(&ARGS, r"^\s*args\s*=\s*\[([^\]]*)\]", "m")
        .find(body)
        .and_then(|m| m.group(1))
        .map(|r| &body[r])
        .unwrap_or("");
    let args = re(&QUOTED, r#""((?:[^"\\]|\\.)*)""#, "")
        .find_iter(raw)
        .filter_map(|m| m.group(1).map(|r| json!(&raw[r])))
        .collect();
    Some((command, args))
}

// ---- writing configs ----

#[cfg(unix)]
fn ensure_private(p: &str) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn ensure_private(_p: &str) {}

/// `backupFile`: copy the file to `<file>.bak` before an in-place merge.
fn backup_file(p: &str) -> Result<(), String> {
    if !nodefs::exists(p) {
        return Ok(());
    }
    let backup = format!("{p}.bak");
    std::fs::copy(p, &backup).map_err(|e| format!("{}: {e}, copyfile '{p}' -> '{backup}'", nodefs::code_name(&e)))?;
    ensure_private(&backup);
    Ok(())
}

/// `writeTextAtomic`: a private temp file beside the target, flushed to disk,
/// then renamed over it.
fn write_text_atomic(p: &str, content: &str) -> Result<(), String> {
    let opts = nekko_js::fs::AtomicWrite { mode: nekko_js::fs::Mode::Private, fsync: true, create_dir: false };
    nekko_js::fs::atomic_write(std::path::Path::new(p), content.as_bytes(), opts)
        .map_err(|e| format!("{}: {e}, open '{p}'", nodefs::code_name(&e)))
}

fn result(ok: bool, message: Option<String>, home: &str) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), json!(ok));
    if let Some(m) = message {
        out.insert("message".into(), json!(m));
    }
    out.insert("tools".into(), detect(home));
    Value::Object(out)
}

/// `installSubagent(tool, home, target)`: merge the entry into the tool's
/// config. Idempotent by value: an entry that already says the right thing is
/// left alone, a stale one is rewritten in place.
pub fn install(home: &str, tool: &Value, target: &Value) -> Result<Value, String> {
    let Some(spec) = spec_for(tool) else { return Ok(result(false, Some("Unknown tool.".into()), home)) };
    if !detected(spec, home) {
        let message =
            format!("{} wasn't found on this machine. Install it first, or use the manual config.", spec.label);
        return Ok(result(false, Some(message), home));
    }
    let file = under(home, spec.config_file);
    let text = read_config(spec, home);
    let already = || Ok(result(true, Some(format!("Already installed in {}.", spec.label)), home));
    let next = match spec.format {
        Format::Json => {
            let mut cfg = Map::new();
            if let Some(text) = &text {
                // An empty-but-present file is a fresh config, not a parse failure.
                let parsed = if js::trim(text).is_empty() { Some(json!({})) } else { parse_json(text) };
                match parsed {
                    Some(Value::Object(m)) => cfg = m,
                    Some(_) => {}
                    None => {
                        let message = format!(
                            "{} isn't valid JSON. Fix it by hand or add the entry manually.",
                            config_file(spec)
                        );
                        return Ok(result(false, Some(message), home));
                    }
                }
            }
            let entry = mcp_server_entry(target);
            let servers = match cfg.get("mcpServers") {
                None | Some(Value::Null) => json!({}),
                Some(v) => v.clone(),
            };
            let current = servers.as_object().and_then(|s| s.get(SERVER_NAME));
            if current.map(js::stringify) == Some(js::stringify(&entry)) {
                return already();
            }
            let mut merged = Map::new();
            js::spread_into(&mut merged, &servers);
            merged.insert(SERVER_NAME.into(), entry);
            cfg.insert("mcpServers".into(), Value::Object(merged));
            js::stringify_pretty(&Value::Object(cfg), "  ")
        }
        Format::Toml => {
            if text.as_deref().is_some_and(|t| !check_toml(t).1) {
                let message = format!(
                    "{} doesn't look like valid TOML. Fix it by hand or add the entry manually.",
                    config_file(spec)
                );
                return Ok(result(false, Some(message), home));
            }
            let section = toml_section(target);
            let replaced = text.as_deref().and_then(|t| replace_toml_section(t, &section));
            match replaced {
                Some(r) if Some(&r) == text.as_ref() => return already(),
                Some(r) => r,
                None => {
                    let body = trim_end(text.as_deref().unwrap_or(""));
                    if body.is_empty() { section } else { format!("{body}\n\n{section}") }
                }
            }
        }
    };
    backup_file(&file)?;
    nodefs::mkdir_p(&path::dirname(&file))?;
    write_text_atomic(&file, &next)?;
    Ok(result(true, None, home))
}

/// `refreshSubagent(tool, home, target)`: re-point an entry this app wrote at
/// the current server. Entries written by hand, and tools with no entry, are
/// left as they are. Whether anything was rewritten.
pub fn refresh(home: &str, tool: &Value, target: &Value) -> Result<bool, String> {
    let Some(spec) = spec_for(tool) else { return Ok(false) };
    let Some((command, args)) = existing_entry(spec, home) else { return Ok(false) };
    if !is_own_entry(&command, &args)? {
        return Ok(false);
    }
    let res = install(home, tool, target)?;
    Ok(res["ok"] == json!(true) && res.get("message").is_none())
}

/// `subagentSnippet(tool, target)`: the manual copy-paste fallback.
pub fn snippet(tool: &Value, target: &Value) -> Value {
    let Some(spec) = spec_for(tool) else { return json!({ "target": "", "snippet": "" }) };
    if spec.format == Format::Toml {
        return json!({ "target": spec.snippet_target, "snippet": trim_end(&toml_section(target)) });
    }
    let mut wrap = Map::new();
    wrap.insert(SERVER_NAME.into(), mcp_server_entry(target));
    let text = js::stringify_pretty(&Value::Object(wrap), "  ");
    let lines: Vec<&str> = text.split('\n').collect();
    let body = lines[1..lines.len() - 1].join("\n");
    json!({ "target": spec.snippet_target, "snippet": format!("\"mcpServers\": {{\n{body}\n}}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scan_blanks_strings_and_comments_byte_for_byte() {
        let (clean, ok) = scan_toml("a = \"[x] é\" # [y]\nb = 'z'\n");
        assert!(ok);
        assert_eq!(clean.len(), "a = \"[x] é\" # [y]\nb = 'z'\n".len());
        assert!(!clean.contains('['));
        let (_, ok) = scan_toml("a = \"open\nb = 1\n");
        assert!(!ok);
    }

    #[test]
    fn own_entries_are_npx_or_the_launcher() {
        assert_eq!(is_own_entry(&json!("npx"), &[json!("-y"), json!("nekko-agent")]), Ok(true));
        assert_eq!(is_own_entry(&json!("C:\\bin\\Nekko-Agent.CMD"), &[]), Ok(true));
        assert_eq!(is_own_entry(&json!("node"), &[json!("nekko-agent")]), Ok(false));
        assert_eq!(is_own_entry(&Value::Null, &[]), Ok(false));
        assert!(is_own_entry(&json!(5), &[]).is_err());
    }
}
