//! What an unattended workflow run may do with tools (shared/workflow-access.ts).
//!
//! `none` turns every tool off, `read` keeps the file readers, `allowlist`
//! keeps what the step lists in Claude Code's allowed-tools syntax (a shell
//! call runs only when its parsed command matches a `Bash(...)` entry, and
//! `gh`/`git` stay reads), and `workspace` (or no setting) changes nothing.
//! The golden cases in `tests/golden/expected.json` (`workflowAccess`) keep
//! this and the TS the same.

use crate::catalog::catalog;
use serde_json::{Value, json};

/// The file tools `read` access keeps.
pub const READ_TOOLS: &[&str] = &["read_file", "glob", "grep", "list_dir"];
/// Bookkeeping every run keeps: it touches nothing outside the run's chat.
pub const ALWAYS_TOOLS: &[&str] = &["update_plan", "set_chat_title"];

/// `unattendedDenial(tool, reason)`.
pub fn unattended_denial(tool: &str, reason: &str) -> String {
    format!("Denied: unattended automation run ({tool}: {reason})")
}

fn claude_tool(name: &str) -> Option<&'static str> {
    Some(match name {
        "Read" => "read_file",
        "Write" => "write_file",
        "Edit" | "MultiEdit" => "edit_file",
        "Glob" => "glob",
        "Grep" => "grep",
        "LS" => "list_dir",
        "WebFetch" => "fetch_url",
        "Bash" => "bash",
        _ => return None,
    })
}

/// A parsed `Bash(...)` pattern: `None` allows any command.
type BashPattern = Option<(Vec<String>, bool)>;

/// `parseAllowed(entry)`: the Nekko tool, and for bash the pattern.
fn parse_allowed(entry: &str) -> Option<(String, BashPattern)> {
    let text = entry.trim();
    let (name, inner) = match text.find('(') {
        Some(i) if text.ends_with(')') => (&text[..i], Some(&text[i + 1..text.len() - 1])),
        Some(_) => return None,
        None => (text, None),
    };
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if !first_ok || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    if name.starts_with("mcp__") {
        return inner.is_none().then(|| (name.to_string(), None));
    }
    let tool = claude_tool(name)?;
    if tool != "bash" {
        return inner.is_none().then(|| (tool.to_string(), None));
    }
    let Some(inner) = inner else { return Some((tool.to_string(), None)) };
    let mut spec = inner.trim();
    let mut any = false;
    if let Some(s) = spec.strip_suffix(":*") {
        spec = s;
        any = true;
    } else if spec == "*" {
        return Some((tool.to_string(), None));
    } else if let Some(s) = spec.strip_suffix(" *") {
        spec = s;
        any = true;
    }
    let prefix = tokenize_command(spec)?;
    if prefix.is_empty() {
        return None;
    }
    Some((tool.to_string(), Some((prefix, any))))
}

/// `allowlistTools(allowed)`.
pub fn allowlist_tools(allowed: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |t: &str| {
        if !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    };
    for entry in allowed {
        if let Some((tool, _)) = parse_allowed(entry) {
            add(&tool);
            if tool == "bash" {
                add("start_process");
            }
        }
    }
    out
}

/// `workflowToolAllowed(access, name, allowed)`.
pub fn tool_allowed(access: Option<&str>, name: &str, allowed: &[String]) -> bool {
    if ALWAYS_TOOLS.contains(&name) {
        return true;
    }
    match access.unwrap_or("workspace") {
        "none" => false,
        "read" => READ_TOOLS.contains(&name),
        "allowlist" => {
            let tools = allowlist_tools(allowed);
            let has = |t: &str| tools.iter().any(|x| x == t);
            has(name) || ((name == "read_process" || name == "kill_process") && has("start_process"))
        }
        "workspace" => true,
        // An access this build does not know allows nothing (fail closed).
        _ => false,
    }
}

/// `workflowDisabledTools(access, allowed)`: in TOOL_CATEGORY_OF's order.
pub fn disabled_tools(access: Option<&str>, allowed: &[String]) -> Vec<String> {
    if matches!(access, None | Some("workspace")) {
        return Vec::new();
    }
    let names = catalog().tool_categories.keys();
    if access == Some("none") {
        return names.cloned().collect();
    }
    names.filter(|n| !tool_allowed(access, n, allowed)).cloned().collect()
}

/// `tokenizeCommand(command)`.
pub fn tokenize_command(command: &str) -> Option<Vec<String>> {
    if command.chars().any(|c| matches!(c, ';' | '&' | '|' | '<' | '>' | '`' | '$' | '\n' | '\r' | '(' | ')' | '\\')) {
        return None;
    }
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                cur.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                in_word = true;
            }
            ' ' | '\t' => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                }
                cur.clear();
                in_word = false;
            }
            _ => {
                cur.push(ch);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_word {
        words.push(cur);
    }
    Some(words)
}

const GIT_READ: &[&str] = &["diff", "log", "show", "status", "rev-parse", "fetch"];

/// `readOnlyViolation(words)`.
pub fn read_only_violation(words: &[String]) -> Option<&'static str> {
    let bin = words.first().map(|w| w.rsplit('/').next().unwrap_or(w)).unwrap_or("");
    let at = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    if bin == "gh" {
        let (group, sub) = (at(1), at(2));
        if group == "pr" && matches!(sub, "view" | "diff" | "checks") {
            return None;
        }
        if group == "repo" && sub == "view" {
            return None;
        }
        if group == "api" {
            for i in 2..words.len() {
                let w = words[i].as_str();
                let method = if w == "-X" || w == "--method" {
                    words.get(i + 1).map(String::as_str)
                } else if let Some(m) = w.strip_prefix("--method=") {
                    Some(m)
                } else if w.starts_with("-X") && w.len() > 2 {
                    Some(&w[2..])
                } else {
                    None
                };
                if method.is_some_and(|m| m.to_uppercase() != "GET") {
                    return Some("gh api may only GET");
                }
                let field = matches!(w, "-f" | "-F" | "--field" | "--raw-field" | "--input")
                    || ((w.starts_with("-f") || w.starts_with("-F")) && w.chars().count() > 2)
                    || w.starts_with("--field=")
                    || w.starts_with("--raw-field=")
                    || w.starts_with("--input=");
                if field {
                    return Some("gh api may not send fields or input");
                }
            }
            return None;
        }
        return Some("gh is limited to pr view|diff|checks, repo view and api GETs");
    }
    if bin == "git" {
        let sub = at(1);
        if sub.is_empty() || !GIT_READ.contains(&sub) {
            return Some("git is limited to diff, log, show, status, rev-parse and fetch");
        }
        if words
            .iter()
            .any(|w| ["--output", "--upload-pack", "--exec", "--receive-pack"].iter().any(|p| w.starts_with(p)))
        {
            return Some("git option not allowed");
        }
        return None;
    }
    None
}

/// `commandAllowed(command, allowed)`: `Ok(())` or the reason.
pub fn command_allowed(command: &str, allowed: &[String]) -> Result<(), String> {
    let words = match tokenize_command(command) {
        Some(w) if !w.is_empty() => w,
        _ => {
            return Err(
                "only a single plain command can match the allowlist (no chaining, substitution or redirection)".into(),
            );
        }
    };
    if let Some(v) = read_only_violation(&words) {
        return Err(v.into());
    }
    for entry in allowed {
        let Some((tool, pattern)) = parse_allowed(entry) else { continue };
        if tool != "bash" {
            continue;
        }
        let Some((prefix, any)) = pattern else { return Ok(()) };
        if words.len() < prefix.len() || (!any && words.len() != prefix.len()) {
            continue;
        }
        if prefix.iter().zip(&words).all(|(p, w)| p == w) {
            return Ok(());
        }
    }
    Err("command does not match the step's allowed tools".into())
}

/// `workflowToolDecision(session, call)`, as JSON: `{kind:"allow"}`,
/// `{kind:"auto"}` or `{kind:"deny", reason}`.
pub fn tool_decision(session: &Value, call: &Value) -> Value {
    let access = session.get("toolAccess").and_then(Value::as_str);
    let name = call.get("name").and_then(Value::as_str).unwrap_or("");
    let allowed: Vec<String> = session
        .get("allowedTools")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let Some(access) = access.filter(|a| *a != "workspace") else { return json!({ "kind": "allow" }) };
    if ALWAYS_TOOLS.contains(&name) {
        return json!({ "kind": "allow" });
    }
    if !tool_allowed(Some(access), name, &allowed) {
        let label = if access == "allowlist" {
            "not in the step's allowed tools".to_string()
        } else {
            format!("not available with {} tool access", if access == "none" { "no" } else { "read-only" })
        };
        return json!({ "kind": "deny", "reason": unattended_denial(name, &label) });
    }
    if access == "read" {
        return json!({ "kind": "allow" });
    }
    if name == "bash" || name == "start_process" {
        let command = call.pointer("/input/command").and_then(Value::as_str).unwrap_or("");
        return match command_allowed(command, &allowed) {
            Ok(()) => json!({ "kind": "auto" }),
            Err(r) => json!({ "kind": "deny", "reason": unattended_denial(name, &r) }),
        };
    }
    json!({ "kind": "auto" })
}
