//! `executeTool` from `packages/host/src/tools.ts`: one call, with the
//! sandbox, the guardrails and the chat mode applied in the same order.
//!
//! Every handler returns `Err(message)` where the TS code would throw; that
//! becomes an error result carrying the message, as the TS `catch` does.

use crate::allowlist::{Dialect, runs_git};
use crate::bash::{Failure, RunRequest};
use crate::context::{ChatMode, ToolCall, ToolContext, ToolResult};
use crate::gitguard::{harden_git_command, hardened_git_env, touches_git_config};
use crate::guardrails::{Action, NOT_READ_ONLY, Severity, classify_command, default_guardrails};
use crate::js;
use crate::nodefs;
use crate::sandbox::{asks_everything, assert_readable, assert_writable, first_workspace, process_cwd, resolve_path};
use crate::search::{glob_files, grep_files};
use serde_json::Value;

/// A file tool's read cap, in UTF-16 code units.
const READ_CAP: usize = 60_000;
const GLOB_LIMIT: usize = 200;
const GREP_LIMIT: usize = 100;

type Outcome = Result<ToolResult, String>;

/// Run one built-in tool call. Names this crate does not implement (see
/// [`crate::NOT_PORTED`]) get the TS host's `Unknown tool` error, so the
/// caller routes those elsewhere first.
pub async fn execute(call: &ToolCall, ctx: &ToolContext) -> ToolResult {
    let outcome = match call.name.as_str() {
        "read_file" => read_file(call, ctx),
        "write_file" => write_file(call, ctx).await,
        "edit_file" => edit_file(call, ctx).await,
        "list_dir" => list_dir(call, ctx),
        "glob" => glob(call, ctx),
        "grep" => grep(call, ctx),
        "bash" => bash(call, ctx).await,
        "start_process" | "read_process" | "kill_process" if ctx.processes.is_some() => {
            crate::process::run_tool(call, ctx, ctx.processes.as_ref().expect("checked")).await
        }
        _ => Ok(ToolResult::err(call, format!("Unknown tool: {}", call.name))),
    };
    outcome.unwrap_or_else(|message| ToolResult::err(call, message))
}

fn arg<'a>(call: &'a ToolCall, key: &str) -> Option<&'a Value> {
    call.input.get(key)
}

/// Ask the user; a cancel while the prompt is open counts as a no.
async fn approve(call: &ToolCall, ctx: &ToolContext, reason: &str, severity: Severity) -> bool {
    tokio::select! {
        ok = ctx.approver.approve(call, reason, severity) => ok,
        _ = ctx.cancel.cancelled() => false,
    }
}

/// Whether a write or edit to `p` may go ahead: asked in ask mode and the
/// ask-everything sandbox, and in every mode but YOLO when `p` is where git
/// reads configuration from (its config can name programs that a later
/// auto-run `git status` would run; decision 0010).
async fn write_approved(call: &ToolCall, ctx: &ToolContext, p: &str, verb: &str) -> bool {
    if ctx.mode != ChatMode::Yolo && touches_git_config(p) {
        let reason = format!("{verb} {p}: git configuration, which can name programs git runs");
        return approve(call, ctx, &reason, Severity::High).await;
    }
    !asks_everything(ctx) || approve(call, ctx, &format!("{verb} {p}"), Severity::Medium).await
}

fn session(ctx: &ToolContext) -> Option<&str> {
    ctx.session_id.as_deref().filter(|s| !s.is_empty())
}

fn record_original(ctx: &ToolContext, path: &str) {
    if let (Some(sid), Some(changes)) = (session(ctx), ctx.changes.as_ref()) {
        changes.record_original(sid, path);
    }
}

fn read_file(call: &ToolCall, ctx: &ToolContext) -> Outcome {
    let p = resolve_path(arg(call, "path"), ctx)?;
    assert_readable(&p, ctx)?;
    if !nodefs::exists(&p) {
        return Ok(ToolResult::err(call, format!("File not found: {p}")));
    }
    let content = nodefs::read_utf8(&p)?;
    if arg(call, "start_line").is_some_and(|v| !v.is_null()) || arg(call, "end_line").is_some_and(|v| !v.is_null()) {
        let line_arg = |key: &str, default: u64| -> Option<u64> {
            match arg(call, key).filter(|v| !v.is_null()) {
                None => Some(default),
                Some(v) => v.as_u64().filter(|n| *n > 0 && *n <= 9_007_199_254_740_991),
            }
        };
        let range =
            line_arg("start_line", 1).and_then(|start| line_arg("end_line", start + 199).map(|end| (start, end)));
        let Some((start, end)) = range.filter(|(start, end)| end >= start) else {
            return Ok(ToolResult::err(
                call,
                "start_line and end_line must be positive integers, with end_line >= start_line.",
            ));
        };
        let lines: Vec<&str> = content.split('\n').collect();
        let selected = lines
            .iter()
            .enumerate()
            .skip((start - 1) as usize)
            .take((end - start + 1) as usize)
            .map(|(i, line)| format!("{}: {line}", i + 1))
            .collect::<Vec<_>>()
            .join("\n");
        let output = if js::len16(&selected) > READ_CAP {
            format!("{}\n…(truncated; request a smaller line range)", js::slice16(&selected, READ_CAP))
        } else if selected.is_empty() {
            format!("(no lines at or after {start}; {} total lines)", lines.len())
        } else {
            selected
        };
        return Ok(ToolResult::ok(call, output));
    }
    Ok(ToolResult::ok(
        call,
        if js::len16(&content) > READ_CAP {
            format!(
                "{}\n\u{2026}(truncated; use start_line and end_line to read later lines)",
                js::slice16(&content, READ_CAP)
            )
        } else {
            content
        },
    ))
}

/// `dirname(p)` for a resolved path.
fn dirname(p: &str) -> String {
    std::path::Path::new(p).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

async fn write_file(call: &ToolCall, ctx: &ToolContext) -> Outcome {
    let p = resolve_path(arg(call, "path"), ctx)?;
    assert_writable(&p, ctx)?;
    if !write_approved(call, ctx, &p, "Write").await {
        return Ok(ToolResult::err(call, "Write not approved by user."));
    }
    record_original(ctx, &p);
    nodefs::mkdir_p(&dirname(&p))?;
    // String(a.content ?? '')
    let content = if js::nullish(arg(call, "content")) { String::new() } else { js::to_string(arg(call, "content")) };
    nodefs::write_utf8(&p, &content)?;
    Ok(ToolResult::ok(call, format!("Wrote {p} ({} bytes)", js::len16(&content))))
}

async fn edit_file(call: &ToolCall, ctx: &ToolContext) -> Outcome {
    let p = resolve_path(arg(call, "path"), ctx)?;
    assert_writable(&p, ctx)?;
    if !nodefs::exists(&p) {
        return Ok(ToolResult::err(call, format!("File not found: {p}")));
    }
    if !write_approved(call, ctx, &p, "Edit").await {
        return Ok(ToolResult::err(call, "Edit not approved by user."));
    }
    let cur = nodefs::read_utf8(&p)?;
    // `cur.split(old_string)`: undefined splits nothing off; anything else is
    // String(x), null included.
    let old = arg(call, "old_string").map(|v| js::to_string(Some(v)));
    let count = match &old {
        None => 0,
        Some(sep) => js::split_count(&cur, sep),
    };
    if count == 0 {
        return Ok(ToolResult::err(call, "old_string not found in file."));
    }
    if count > 1 {
        return Ok(ToolResult::err(call, format!("old_string matched {count} times; make it unique.")));
    }
    record_original(ctx, &p);
    let old = old.unwrap_or_default();
    // `replace` coerces a missing replacement to "undefined", as String() does.
    let new = js::to_string(arg(call, "new_string"));
    nodefs::write_utf8(&p, &js::replace_first(&cur, &old, &new))?;
    Ok(ToolResult::ok(call, format!("Edited {p}")))
}

fn list_dir(call: &ToolCall, ctx: &ToolContext) -> Outcome {
    let p = resolve_path(arg(call, "path"), ctx)?;
    assert_readable(&p, ctx)?;
    if !nodefs::exists(&p) {
        return Ok(ToolResult::err(call, format!("Directory not found: {p}")));
    }
    let entries: Vec<String> =
        nodefs::read_dir(&p)?.into_iter().map(|e| if e.is_dir { format!("{}/", e.name) } else { e.name }).collect();
    Ok(ToolResult::ok(call, if entries.is_empty() { "(empty)".to_string() } else { entries.join("\n") }))
}

fn glob(call: &ToolCall, ctx: &ToolContext) -> Outcome {
    let root = if js::truthy(arg(call, "path")) {
        resolve_path(arg(call, "path"), ctx)?
    } else {
        ctx.default_cwd.clone().or_else(|| first_workspace(ctx).map(str::to_string)).unwrap_or_else(process_cwd)
    };
    assert_readable(&root, ctx)?;
    if !nodefs::exists(&root) {
        return Ok(ToolResult::err(call, format!("Directory not found: {root}")));
    }
    let matches = glob_files(&root, arg(call, "pattern"), GLOB_LIMIT)?;
    Ok(ToolResult::ok(call, if matches.is_empty() { "(no matches)".to_string() } else { matches.join("\n") }))
}

fn grep(call: &ToolCall, ctx: &ToolContext) -> Outcome {
    let root = if js::truthy(arg(call, "path")) {
        resolve_path(arg(call, "path"), ctx)?
    } else {
        ctx.default_cwd.clone().or_else(|| first_workspace(ctx).map(str::to_string)).unwrap_or_else(process_cwd)
    };
    assert_readable(&root, ctx)?;
    if !nodefs::exists(&root) {
        return Ok(ToolResult::err(call, format!("Path not found: {root}")));
    }
    let lines = grep_files(&root, arg(call, "pattern"), GREP_LIMIT);
    Ok(ToolResult::ok(call, if lines.is_empty() { "(no matches)".to_string() } else { lines.join("\n") }))
}

/// What the command-log terminal is sent: control characters other than tab
/// and newline dropped, newlines as `\r\n`.
pub(crate) fn sanitize_for_terminal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\n' => out.push_str("\r\n"),
            '\t' | '\u{20}'..='\u{7E}' => out.push(c),
            c if u32::from(c) >= 0x80 => out.push(c),
            _ => {}
        }
    }
    out
}

async fn bash(call: &ToolCall, ctx: &ToolContext) -> Outcome {
    let raw_command = arg(call, "command");
    let command = js::to_string(raw_command);
    let default_rules;
    let rules = match &ctx.guardrails {
        Some(r) => r.as_slice(),
        None => {
            default_rules = default_guardrails();
            &default_rules
        }
    };
    let decision = classify_command(&command, rules);
    // "Not a read-only command" says nothing the prompt's own wording does not.
    let labels = decision
        .matches
        .iter()
        .filter(|m| m.rule_id != NOT_READ_ONLY)
        .map(|m| m.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    // A deny guardrail is a hard floor in every mode (even YOLO).
    if decision.action == Action::Deny {
        return Ok(ToolResult::err(call, format!("Blocked by guardrail ({labels}).")));
    }
    // YOLO never prompts; Ask always prompts; Guardrails prompts unless every
    // command in it is read-only or allowed by a user rule (decision 0010).
    let needs_approval = ctx.mode != ChatMode::Yolo && (asks_everything(ctx) || decision.action == Action::Ask);
    // An auto-run git gets an environment, and options, that keep repo config from running anything.
    let auto_git = !needs_approval && ctx.mode == ChatMode::Guardrails && runs_git(&command, Dialect::host());
    let env = if auto_git { hardened_git_env() } else { Vec::new() };
    let hardened = auto_git.then(|| harden_git_command(&command, Dialect::host()));
    if needs_approval {
        let reason = if labels.is_empty() { "Run command" } else { labels.as_str() };
        if !approve(call, ctx, reason, decision.severity).await {
            return Ok(ToolResult::err(call, "Command not approved by user."));
        }
    }
    let cwd = if js::truthy(arg(call, "cwd")) {
        resolve_path(arg(call, "cwd"), ctx)?
    } else {
        ctx.default_cwd.clone().or_else(|| first_workspace(ctx).map(str::to_string)).unwrap_or_else(process_cwd)
    };

    let workspace_id = ctx.workspaces.iter().find(|w| w.path == cwd).map(|w| w.id.clone());
    let mirror = |text: &str| {
        if let (Some(sid), Some(log)) = (session(ctx), ctx.command_log.as_ref()) {
            log.append(sid, workspace_id.as_deref(), &sanitize_for_terminal(text));
        }
    };
    mirror(&format!("$ {command}\n"));

    let outcome = match raw_command {
        // `exec` validates its argument before spawning anything.
        Some(Value::String(cmd)) => {
            ctx.runner
                .run(RunRequest {
                    command: hardened.as_deref().unwrap_or(cmd),
                    cwd: &cwd,
                    limits: ctx.limits,
                    cancel: &ctx.cancel,
                    on_output: &mirror,
                    env: &env,
                })
                .await
        }
        other => crate::bash::RunOutcome {
            failure: Some(Failure::Error(js::invalid_string_arg("command", other))),
            ..Default::default()
        },
    };

    let cap = ctx.limits.output_cap;
    Ok(match outcome.failure {
        None => {
            let mut output = outcome.stdout.clone();
            if !outcome.stderr.is_empty() {
                output.push_str("\n[stderr]\n");
                output.push_str(&outcome.stderr);
            }
            let output = js::slice16(&output, cap);
            if outcome.stdout.is_empty() && outcome.stderr.is_empty() {
                mirror("(no output)\n");
            }
            ToolResult::ok(call, if output.is_empty() { "(no output)" } else { output })
        }
        Some(Failure::Error(message)) => {
            let output = format!("Command failed: {message}\n{}{}", outcome.stdout, outcome.stderr);
            mirror("[command failed]\n");
            ToolResult::err(call, js::slice16(&output, cap))
        }
        Some(Failure::Cancelled) => {
            let output = format!("Command cancelled.\n{}{}", outcome.stdout, outcome.stderr);
            mirror("[command cancelled]\n");
            ToolResult::err(call, js::slice16(&output, cap))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_like_the_ts_mirror() {
        assert_eq!(sanitize_for_terminal("a\r\nb\x1b[0m\x7f\tc😀"), "a\r\nb[0m\tc😀");
    }
}
