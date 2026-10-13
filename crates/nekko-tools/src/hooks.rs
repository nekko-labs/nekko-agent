//! Tool hooks: the user's own commands around the agent's tool calls, ported
//! from `packages/host/src/hooks.ts`.
//!
//! A hook is a shell command run with the event as JSON on stdin, in the
//! chat's workspace, with `NEKKO_HOOK_EVENT`, `NEKKO_SESSION_ID` and (for
//! tool events) `NEKKO_TOOL_NAME` set:
//!
//! - `PreToolUse` runs before a tool. Exit code 2, or stdout JSON
//!   `{"decision":"block","reason":"..."}`, blocks the call; the reason goes
//!   back to the model as the tool's error.
//! - `PostToolUse` runs after a tool; what it prints is appended to the
//!   tool's output for the model.
//! - `TurnEnd` runs when a reply ends; nothing waits on it.
//!
//! `matcher` is a JavaScript regular expression on the tool name, matched
//! case-insensitively ([`crate::jsre`]); one that does not compile is read as
//! a list of names. The payload is the same JSON text the TS host wrote, key
//! order and number format included.
//!
//! Deliberate differences: a hook that times out has its whole process tree
//! killed (Node signalled only the shell), and its output is decoded in one
//! piece rather than chunk by chunk.

use crate::bash::{Utf8Carry, shell, spawn_code, tree::Tree};
use crate::jsre::JsRegex;
use nekko_js as js;
use serde_json::{Map, Value, json};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const HOOK_TIMEOUT_MS: f64 = 60_000.0;
/// Most output (UTF-16 units) a hook may hand to the model.
pub const HOOK_OUTPUT_MAX: usize = 2_000;

/// One rule from `settings.hooks`, kept as the JSON the settings hold.
#[derive(Clone, Debug)]
pub struct HookRule(pub Value);

impl HookRule {
    fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    fn command(&self) -> &str {
        self.str("command").unwrap_or_default()
    }
}

/// The rules in `settings.hooks` (anything that is not a list reads as none).
pub fn rules(hooks: &Value) -> Vec<HookRule> {
    hooks.as_array().map(|a| a.iter().filter(|h| h.is_object()).cloned().map(HookRule).collect()).unwrap_or_default()
}

/// `matchingHooks(settings, event, toolName)`.
pub fn matching_hooks<'a>(rules: &'a [HookRule], event: &str, tool_name: Option<&str>) -> Vec<&'a HookRule> {
    rules
        .iter()
        .filter(|h| {
            if h.0.get("enabled") == Some(&Value::Bool(false))
                || h.str("event") != Some(event)
                || js::trim(h.command()).is_empty()
            {
                return false;
            }
            let matcher = h.str("matcher").map(js::trim).unwrap_or_default();
            let (Some(name), false) = (tool_name.filter(|n| !n.is_empty()), matcher.is_empty()) else {
                return true;
            };
            let raw = h.str("matcher").unwrap_or_default();
            match JsRegex::new(raw, "i") {
                Ok(re) => re.test(name),
                Err(_) => raw.split(|c: char| c == '|' || c == ',' || js::is_js_space(c)).any(|part| part == name),
            }
        })
        .collect()
}

/// `hasToolHooks(settings)`: whether any hook wants to see tool calls.
pub fn has_tool_hooks(rules: &[HookRule]) -> bool {
    rules.iter().any(|h| {
        h.0.get("enabled") != Some(&Value::Bool(false))
            && !js::trim(h.command()).is_empty()
            && matches!(h.str("event"), Some("PreToolUse" | "PostToolUse"))
    })
}

#[derive(Clone, Debug, Default)]
pub struct HookOutcome {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// `Math.min(Math.max(1000, timeoutMs ?? 60000), 600000)`.
fn limit(rule: &HookRule) -> Duration {
    let ms = match rule.0.get("timeoutMs") {
        None | Some(Value::Null) => HOOK_TIMEOUT_MS,
        Some(v) => js::to_number(Some(v)),
    };
    // Math.max(1000, NaN) is NaN, which setTimeout reads as at once.
    let ms = if ms.is_nan() { 1.0 } else { ms.clamp(1_000.0, 600_000.0) };
    Duration::from_millis(ms as u64)
}

/// `runHook(rule, payload)`: run one hook with the payload on stdin. Never fails.
pub async fn run_hook(
    rule: &HookRule,
    event: &str,
    session_id: &str,
    tool_name: Option<&str>,
    cwd: &str,
    payload: &Value,
) -> HookOutcome {
    let shell = shell();
    let mut cmd = tokio::process::Command::new(&shell);
    #[cfg(windows)]
    {
        cmd.raw_arg(format!("/d /s /c \"{}\"", rule.command()));
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        cmd.arg("-c").arg(rule.command());
        cmd.process_group(0);
    }
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NEKKO_HOOK_EVENT", event)
        .env("NEKKO_SESSION_ID", session_id)
        .kill_on_drop(true);
    if let Some(name) = tool_name {
        cmd.env("NEKKO_TOOL_NAME", name);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return HookOutcome { stderr: format!("spawn {shell} {}", spawn_code(cwd, &e)), ..Default::default() };
        }
    };
    let tree = Tree::attach(&child);
    let input = js::stringify(payload);
    let stdin = child.stdin.take();
    // A hook may exit without reading stdin; a broken pipe is fine.
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
    });
    let read = |pipe: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
        tokio::spawn(async move {
            let mut out = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut out).await;
            }
            let mut carry = Utf8Carry::default();
            let mut s = carry.decode(&out);
            s.push_str(&carry.finish());
            s
        })
    };
    let out = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>));
    let err = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>));
    let mut timed_out = false;
    let status = match tokio::time::timeout(limit(rule), child.wait()).await {
        Ok(s) => s.ok(),
        Err(_) => {
            timed_out = true;
            tree.kill();
            tokio::time::timeout(Duration::from_secs(5), child.wait()).await.ok().and_then(Result::ok)
        }
    };
    writer.abort();
    // Pipes a grandchild still holds must not keep the call waiting.
    let grace = Duration::from_secs(if timed_out { 1 } else { 5 });
    let stdout = tokio::time::timeout(grace, out).await.ok().and_then(Result::ok).unwrap_or_default();
    let stderr = tokio::time::timeout(grace, err).await.ok().and_then(Result::ok).unwrap_or_default();
    HookOutcome { code: if timed_out { None } else { status.and_then(|s| s.code()) }, stdout, stderr, timed_out }
}

fn clip(s: &str) -> String {
    let t = js::trim(s);
    if js::len16(t) <= HOOK_OUTPUT_MAX { t.to_string() } else { format!("{}\u{2026}", js::slice16(t, HOOK_OUTPUT_MAX)) }
}

/// `label(rule)`: the hook's name, else its command's first word.
pub fn label(rule: &HookRule) -> String {
    let name = rule.str("name").map(js::trim).unwrap_or_default();
    if !name.is_empty() {
        return name.to_string();
    }
    let first = js::trim(rule.command()).split(js::is_js_space).next().unwrap_or_default();
    if first.is_empty() { "hook".into() } else { first.to_string() }
}

/// `decisionOf(outcome)`: a block from exit code 2 or a JSON verdict on stdout.
pub fn decision_of(outcome: &HookOutcome) -> Option<String> {
    let out = js::trim(&outcome.stdout);
    if out.starts_with('{')
        && let Ok(Value::Object(v)) = serde_json::from_str::<Value>(out)
        && matches!(v.get("decision").and_then(Value::as_str), Some("block" | "deny"))
    {
        // `v.reason?.trim()` throws on a reason that is not a string, and the
        // catch reads the whole thing as not a verdict.
        match v.get("reason") {
            None | Some(Value::Null) => return Some("Blocked by a hook.".into()),
            Some(Value::String(r)) => {
                let r = js::trim(r);
                return Some(if r.is_empty() { "Blocked by a hook.".into() } else { r.to_string() });
            }
            Some(_) => {}
        }
    }
    if outcome.code == Some(2) {
        let text = clip(if outcome.stderr.is_empty() { out } else { &outcome.stderr });
        return Some(if text.is_empty() { "Blocked by a hook.".into() } else { text });
    }
    None
}

/// What a hook sees of a call: `{ id, name, input }`.
fn tool_payload(call: &Value) -> Value {
    let mut tool = Map::new();
    tool.insert("id".into(), call.get("id").cloned().unwrap_or(Value::Null));
    tool.insert("name".into(), call.get("name").cloned().unwrap_or(Value::Null));
    tool.insert("input".into(), call.get("input").cloned().unwrap_or(Value::Null));
    Value::Object(tool)
}

/// `preToolHooks`: the first hook that blocks wins; one that times out never
/// blocks but leaves a note.
pub async fn pre_tool_hooks(
    rules: &[HookRule],
    call: &Value,
    session_id: &str,
    cwd: &str,
) -> (Option<String>, Vec<String>) {
    let mut notes = Vec::new();
    let name = call.get("name").and_then(Value::as_str);
    for rule in matching_hooks(rules, "PreToolUse", name) {
        let payload = json!({ "event": "PreToolUse", "sessionId": session_id, "cwd": cwd, "tool": tool_payload(call) });
        let outcome = run_hook(rule, "PreToolUse", session_id, name, cwd, &payload).await;
        if outcome.timed_out {
            notes.push(format!("[hook {} timed out and was ignored]", label(rule)));
            continue;
        }
        if let Some(reason) = decision_of(&outcome) {
            return (Some(format!("Blocked by hook {}: {reason}", label(rule))), notes);
        }
    }
    (None, notes)
}

/// `postToolHooks`: what they print is appended to the result for the model.
pub async fn post_tool_hooks(rules: &[HookRule], call: &Value, result: Value, session_id: &str, cwd: &str) -> Value {
    let name = call.get("name").and_then(Value::as_str);
    let matched = matching_hooks(rules, "PostToolUse", name);
    if matched.is_empty() {
        return result;
    }
    let mut notes = Vec::new();
    for rule in matched {
        let mut res = Map::new();
        res.insert("output".into(), result.get("output").cloned().unwrap_or(Value::Null));
        if js::truthy(result.get("isError")) {
            res.insert("isError".into(), Value::Bool(true));
        }
        let payload = json!({ "event": "PostToolUse", "sessionId": session_id, "cwd": cwd, "tool": tool_payload(call), "result": res });
        let outcome = run_hook(rule, "PostToolUse", session_id, name, cwd, &payload).await;
        if outcome.timed_out {
            notes.push(format!("[hook {} timed out]", label(rule)));
            continue;
        }
        let text = clip(&outcome.stdout);
        if !text.is_empty() {
            notes.push(format!("[hook {}]: {text}", label(rule)));
        }
    }
    if notes.is_empty() {
        return result;
    }
    let mut result = result;
    let output = format!("{}\n\n{}", result.get("output").map(js::display).unwrap_or_default(), notes.join("\n"));
    result["output"] = json!(output);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(v: Value) -> HookRule {
        HookRule(v)
    }

    #[test]
    fn matches_like_the_ts_host() {
        let rules = vec![
            rule(json!({ "id": "a", "event": "PreToolUse", "matcher": "bash|write_file", "command": "x" })),
            rule(json!({ "id": "b", "event": "PreToolUse", "matcher": "", "command": "y" })),
            rule(json!({ "id": "c", "event": "PreToolUse", "matcher": "(bad", "command": "z" })),
            rule(json!({ "id": "d", "event": "PreToolUse", "command": "  ", "matcher": "" })),
            rule(json!({ "id": "e", "event": "PreToolUse", "command": "w", "enabled": false })),
            rule(json!({ "id": "f", "event": "PostToolUse", "command": "v" })),
            rule(json!({ "id": "g", "event": "PreToolUse", "matcher": "(bad, read_file", "command": "u" })),
            rule(json!({ "id": "h", "event": "PreToolUse", "matcher": "BASH", "command": "t" })),
        ];
        let ids = |name: Option<&str>| -> Vec<String> {
            matching_hooks(&rules, "PreToolUse", name).iter().map(|r| r.str("id").unwrap().to_string()).collect()
        };
        assert_eq!(ids(Some("bash")), ["a", "b", "h"]);
        assert_eq!(ids(Some("read_file")), ["b", "g"]);
        assert_eq!(ids(Some("(bad")), ["b", "c", "g"]);
        assert_eq!(ids(None), ["a", "b", "c", "g", "h"]);
        assert!(has_tool_hooks(&rules));
        assert!(!has_tool_hooks(&[rule(json!({ "event": "TurnEnd", "command": "x" }))]));
    }

    #[test]
    fn reads_decisions_like_the_ts_host() {
        let o = |code: Option<i32>, stdout: &str, stderr: &str| HookOutcome {
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
            timed_out: false,
        };
        assert_eq!(decision_of(&o(Some(0), r#" {"decision":"block","reason":" no "}"#, "")), Some("no".into()));
        assert_eq!(decision_of(&o(Some(0), r#"{"decision":"deny"}"#, "")), Some("Blocked by a hook.".into()));
        assert_eq!(decision_of(&o(Some(0), r#"{"decision":"deny","reason":5}"#, "")), None);
        assert_eq!(
            decision_of(&o(Some(2), r#"{"decision":"deny","reason":5}"#, "")),
            Some(r#"{"decision":"deny","reason":5}"#.into())
        );
        assert_eq!(decision_of(&o(Some(2), "out", "  err  ")), Some("err".into()));
        assert_eq!(decision_of(&o(Some(2), "", "")), Some("Blocked by a hook.".into()));
        assert_eq!(decision_of(&o(Some(1), "{nope", "x")), None);
        assert_eq!(label(&rule(json!({ "name": "  ", "command": "  lint  --fix" }))), "lint");
        assert_eq!(label(&rule(json!({ "name": " Linter ", "command": "x" }))), "Linter");
    }

    #[tokio::test]
    async fn runs_hooks_with_the_payload_on_stdin() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        // Echo the event variable and block with exit 2.
        let (pre_cmd, post_cmd) = if cfg!(windows) {
            ("echo nope %NEKKO_TOOL_NAME% 1>&2 & exit /b 2", "echo checked %NEKKO_HOOK_EVENT%")
        } else {
            ("echo nope $NEKKO_TOOL_NAME 1>&2; exit 2", "echo checked $NEKKO_HOOK_EVENT")
        };
        let rules = vec![
            rule(json!({ "id": "p", "event": "PreToolUse", "name": "guard", "matcher": "bash", "command": pre_cmd })),
            rule(json!({ "id": "q", "event": "PostToolUse", "command": post_cmd })),
        ];
        let call = json!({ "id": "c1", "name": "bash", "input": { "command": "ls" } });
        let (block, notes) = pre_tool_hooks(&rules, &call, "s1", &cwd).await;
        assert_eq!(block.as_deref(), Some("Blocked by hook guard: nope bash"));
        assert!(notes.is_empty());
        let other = json!({ "id": "c2", "name": "read_file", "input": {} });
        assert_eq!(pre_tool_hooks(&rules, &other, "s1", &cwd).await.0, None);
        let out = post_tool_hooks(&rules, &other, json!({ "toolCallId": "c2", "output": "body" }), "s1", &cwd).await;
        assert_eq!(out["output"], "body\n\n[hook echo]: checked PostToolUse");
    }

    #[tokio::test]
    async fn a_slow_hook_times_out_and_never_blocks() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let slow = if cfg!(windows) { "ping -n 20 127.0.0.1 >nul & exit /b 2" } else { "sleep 20; exit 2" };
        let rules =
            vec![rule(json!({ "id": "s", "event": "PreToolUse", "name": "slow", "command": slow, "timeoutMs": 10 }))];
        let call = json!({ "id": "c1", "name": "bash", "input": {} });
        let started = std::time::Instant::now();
        let (block, notes) = pre_tool_hooks(&rules, &call, "s1", &cwd).await;
        assert_eq!(block, None);
        assert_eq!(notes, ["[hook slow timed out and was ignored]"]);
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    }
}
