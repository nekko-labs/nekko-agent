//! Background processes: `start_process`, `read_process` and `kill_process`,
//! ported from `packages/host/src/processes.ts` and their cases in
//! `executeTool` (`packages/host/src/tools.ts`).
//!
//! A long-running command an agent starts and comes back to (a dev server,
//! a watcher, a long build) runs detached from the turn in the platform
//! shell, its output buffered until read and mirrored into the chat's agent
//! terminal, and dies with the chat's Stop, with `kill_process`, or when the
//! daemon exits. Buffers are measured and cut in UTF-16 units, as the TS
//! strings were.
//!
//! Deliberate differences: output is decoded across chunk boundaries (Node's
//! `String(chunk)` turned a character split between two reads into two
//! replacement characters), and a kill takes the whole tree on Windows too
//! (a job object, where Node's `taskkill /T` could miss a reparented child).

use crate::allowlist::{Dialect, runs_git};
use crate::bash::{Utf8Carry, shell, spawn_code, tree::Tree};
use crate::context::{ChatMode, ToolCall, ToolContext, ToolResult};
use crate::gitguard::hardened_git_env;
use crate::guardrails::{Action, NOT_READ_ONLY, classify_command, default_guardrails};
use crate::sandbox::{asks_everything, first_workspace, process_cwd, resolve_path};
use nekko_js as js;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

/// Output kept per process; the head falls off past this (UTF-16 units).
pub const PROCESS_BUFFER_MAX: usize = 1_000_000;
/// The most one read hands back.
pub const READ_MAX: usize = 60_000;
/// The longest a `read_process` may wait for new output.
pub const READ_WAIT_MAX_MS: f64 = 120_000.0;
/// Processes one chat may have running at once.
pub const PROCESS_LIMIT: usize = 8;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where a process's output is mirrored: the chat's agent terminal.
pub type Mirror = Arc<dyn Fn(&str, Option<&str>, &str) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exit {
    Code(i64),
    Signal(String),
}

#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub id: String,
    pub session_id: String,
    pub pid: Option<u32>,
    pub command: String,
    pub cwd: String,
    pub name: Option<String>,
    pub started_at: u64,
    /// Set when the process has exited.
    pub exit: Option<Exit>,
    pub ended_at: Option<u64>,
}

struct Entry {
    info: ProcessInfo,
    /// Output not yet handed to the agent.
    unread: Vec<u16>,
    /// Everything kept for `read_process` with `all`, tail-trimmed.
    all: Vec<u16>,
    tree: Option<Arc<Tree>>,
}

/// `clip(s, max)`: past `max` units, the tail behind an ellipsis line.
fn clip(mut s: Vec<u16>, max: usize) -> Vec<u16> {
    if s.len() <= max {
        return s;
    }
    let tail = s.split_off(s.len() - max);
    let mut out: Vec<u16> = "\u{2026}\n".encode_utf16().collect();
    out.extend(tail);
    out
}

/// Every background process the agent started, by id.
#[derive(Default)]
pub struct Processes {
    entries: Mutex<HashMap<String, Entry>>,
    /// Wakes a waiting `read_process` on output or exit.
    wake: Notify,
    counter: AtomicU64,
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub struct StartRequest<'a> {
    pub session_id: &'a str,
    pub workspace_id: Option<&'a str>,
    pub command: &'a str,
    pub cwd: &'a str,
    pub name: Option<String>,
    /// Environment changes on top of the daemon's own (and the platform's).
    pub env: &'a [crate::gitguard::EnvChange],
}

impl Processes {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn next_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("p_{}_{}", base36(nekko_js::now_ms()), base36(n))
    }

    fn push_output(&self, id: &str, text: &str) {
        let units: Vec<u16> = text.encode_utf16().collect();
        if let Some(e) = lock(&self.entries).get_mut(id) {
            let mut unread = std::mem::take(&mut e.unread);
            unread.extend_from_slice(&units);
            e.unread = clip(unread, PROCESS_BUFFER_MAX);
            let mut all = std::mem::take(&mut e.all);
            all.extend_from_slice(&units);
            e.all = clip(all, PROCESS_BUFFER_MAX);
        }
        self.wake.notify_waiters();
    }

    fn set_exit(&self, id: &str, exit: Exit) {
        if let Some(e) = lock(&self.entries).get_mut(id) {
            e.info.exit = Some(exit);
            e.info.ended_at = Some(nekko_js::now_ms());
        }
        self.wake.notify_waiters();
    }

    /// `startProcess`: start a command for a chat. Fails when the chat
    /// already has [`PROCESS_LIMIT`] running.
    pub fn start(self: &Arc<Self>, req: StartRequest<'_>, mirror: Mirror) -> Result<ProcessInfo, String> {
        let running = lock(&self.entries)
            .values()
            .filter(|e| e.info.session_id == req.session_id && e.info.exit.is_none())
            .count();
        if running >= PROCESS_LIMIT {
            return Err(format!(
                "This chat already has {PROCESS_LIMIT} processes running. Stop one with kill_process first."
            ));
        }
        let shell = shell();
        let mut cmd = tokio::process::Command::new(&shell);
        #[cfg(windows)]
        {
            // As the bash tool: cmd.exe gets the command line verbatim, not re-quoted.
            cmd.raw_arg(format!("/d /s /c \"{}\"", req.command));
            cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            cmd.arg("-c").arg(req.command);
            cmd.process_group(0);
        }
        cmd.current_dir(req.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1")
            .env("CI", std::env::var("CI").unwrap_or_else(|_| "1".into()))
            .kill_on_drop(true);
        crate::bash::apply_env(&mut cmd, req.env);
        let spawned = cmd.spawn();
        let mut info = ProcessInfo {
            id: self.next_id(),
            session_id: req.session_id.to_string(),
            pid: spawned.as_ref().ok().and_then(|c| c.id()),
            command: req.command.to_string(),
            cwd: req.cwd.to_string(),
            name: req.name,
            started_at: nekko_js::now_ms(),
            exit: None,
            ended_at: None,
        };
        let id = info.id.clone();
        let label = info.name.clone().unwrap_or_else(|| id.clone());
        let (session, workspace) = (req.session_id.to_string(), req.workspace_id.map(str::to_string));
        mirror(&session, workspace.as_deref(), &format!("$ {}  [{label}, background]\n", req.command));
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                // Node's spawn reports this as an 'error' event after start returns.
                let message = format!("[could not start: spawn {shell} {}]\n", spawn_code(req.cwd, &e));
                info.exit = Some(Exit::Code(-1));
                info.ended_at = Some(nekko_js::now_ms());
                let units: Vec<u16> = message.encode_utf16().collect();
                lock(&self.entries)
                    .insert(id.clone(), Entry { info: info.clone(), unread: units.clone(), all: units, tree: None });
                mirror(&session, workspace.as_deref(), &message);
                info.exit = None;
                info.ended_at = None;
                return Ok(info);
            }
        };
        let tree = Arc::new(Tree::attach(&child));
        lock(&self.entries)
            .insert(id.clone(), Entry { info: info.clone(), unread: Vec::new(), all: Vec::new(), tree: Some(tree) });

        let (tx, mut rx) = tokio::sync::mpsc::channel::<(bool, Vec<u8>)>(64);
        for (is_err, pipe) in [
            (false, child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)),
            (true, child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)),
        ] {
            let Some(mut pipe) = pipe else { continue };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match pipe.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send((is_err, buf[..n].to_vec())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
        drop(tx);
        let me = self.clone();
        tokio::spawn(async move {
            let (mut out_carry, mut err_carry) = (Utf8Carry::default(), Utf8Carry::default());
            let emit = |text: &str| {
                if !text.is_empty() {
                    me.push_output(&id, text);
                    mirror(&session, workspace.as_deref(), text);
                }
            };
            let mut status = None;
            let mut open = true;
            while open || status.is_none() {
                tokio::select! {
                    msg = rx.recv(), if open => match msg {
                        Some((is_err, chunk)) => {
                            let carry = if is_err { &mut err_carry } else { &mut out_carry };
                            emit(&carry.decode(&chunk));
                        }
                        None => open = false,
                    },
                    s = child.wait(), if status.is_none() => status = Some(s.ok()),
                }
            }
            emit(&out_carry.finish());
            emit(&err_carry.finish());
            let exit = exit_of(status.flatten());
            let tail = match &exit {
                Exit::Code(c) => format!(" with code {c}"),
                Exit::Signal(s) => format!(" on {s}"),
            };
            me.set_exit(&id, exit);
            mirror(&session, workspace.as_deref(), &format!("[{label} exited{tail}]\n"));
        });
        Ok(info)
    }

    pub fn get(&self, id: &str) -> Option<ProcessInfo> {
        lock(&self.entries).get(id).map(|e| e.info.clone())
    }

    /// `listProcesses`: the chat's processes, running first, then by start.
    pub fn list(&self, session_id: &str) -> Vec<ProcessInfo> {
        let mut list: Vec<ProcessInfo> =
            lock(&self.entries).values().filter(|e| e.info.session_id == session_id).map(|e| e.info.clone()).collect();
        list.sort_by(|a, b| a.exit.is_some().cmp(&b.exit.is_some()).then(a.started_at.cmp(&b.started_at)));
        list
    }

    /// `readProcess`: output since the last read (or everything kept, with
    /// `all`), waiting up to `wait_ms` when there is nothing yet and the
    /// process still runs. An exited process is forgotten once read.
    pub async fn read(&self, id: &str, wait_ms: Option<f64>, all: bool) -> Option<(ProcessInfo, String, bool)> {
        let wait = wait_ms.unwrap_or(0.0).clamp(0.0, READ_WAIT_MAX_MS);
        let wait = if wait.is_nan() { 0.0 } else { wait };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait as u64);
        let idle = |me: &Self| {
            let entries = lock(&me.entries);
            entries.get(id).map(|e| e.unread.is_empty() && e.info.exit.is_none())
        };
        if idle(self)? && wait > 0.0 {
            // One wake (output or exit) or the deadline ends the wait, as in TS.
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if idle(self) == Some(true) {
                let _ = tokio::time::timeout_at(deadline, notified).await;
            }
        }
        let mut entries = lock(&self.entries);
        let e = entries.get_mut(id)?;
        let source = if all { &e.all } else { &e.unread };
        let truncated = source.len() > READ_MAX;
        let output = String::from_utf16_lossy(if truncated { &source[source.len() - READ_MAX..] } else { source });
        e.unread.clear();
        let info = e.info.clone();
        if info.exit.is_some() {
            entries.remove(id);
        }
        Some((info, output, truncated))
    }

    /// `killProcess`: stop one process; false when there is none by that id.
    pub fn kill(&self, id: &str) -> bool {
        let tree = match lock(&self.entries).get(id) {
            None => return false,
            Some(e) => e.tree.clone().filter(|_| e.info.exit.is_none()),
        };
        if let Some(t) = tree {
            t.kill();
        }
        true
    }

    /// `killSessionProcesses`: stop every process a chat started. Returns how many were running.
    pub fn kill_session(&self, session_id: &str) -> usize {
        let trees: Vec<Arc<Tree>> = lock(&self.entries)
            .values()
            .filter(|e| e.info.session_id == session_id && e.info.exit.is_none())
            .filter_map(|e| e.tree.clone())
            .collect();
        for t in &trees {
            t.kill();
        }
        trees.len()
    }

    /// `killAllProcesses`: stop everything (the daemon is exiting).
    pub fn kill_all(&self) {
        let trees: Vec<Arc<Tree>> =
            lock(&self.entries).values().filter(|e| e.info.exit.is_none()).filter_map(|e| e.tree.clone()).collect();
        for t in trees {
            t.kill();
        }
    }
}

impl Drop for Processes {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn exit_of(status: Option<std::process::ExitStatus>) -> Exit {
    let Some(status) = status else { return Exit::Code(-1) };
    if let Some(code) = status.code() {
        return Exit::Code(i64::from(code));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return Exit::Signal(signal_name(sig));
        }
    }
    Exit::Signal("signal".into())
}

#[cfg(unix)]
fn signal_name(sig: i32) -> String {
    let name = match sig {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGABRT => "SIGABRT",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGTERM => "SIGTERM",
        _ => return format!("signal {sig}"),
    };
    name.into()
}

/// `describeProcess(info)`: a line about a process, for tool output.
pub fn describe_process(info: &ProcessInfo, now: u64) -> String {
    let label = match &info.name {
        Some(n) => format!("{} ({n})", info.id),
        None => info.id.clone(),
    };
    let state = match &info.exit {
        None => {
            let secs = ((now.saturating_sub(info.started_at)) as f64 / 1000.0 + 0.5).floor();
            let pid = info.pid.map(|p| format!(", pid {p}")).unwrap_or_default();
            format!("running for {secs} s{pid}")
        }
        Some(Exit::Signal(s)) => format!("exited on {s}"),
        Some(Exit::Code(c)) => format!("exited with code {c}"),
    };
    format!("{label}: {state}, started with `{}` in {}", info.command, info.cwd)
}

fn label(info: &ProcessInfo) -> String {
    match &info.name {
        Some(n) => format!("{} ({n})", info.id),
        None => info.id.clone(),
    }
}

const NO_CHAT: &str = "Background processes need a chat to belong to.";

fn session(ctx: &ToolContext) -> Option<&str> {
    ctx.session_id.as_deref().filter(|s| !s.is_empty())
}

/// The three process tools, as `executeTool` runs them.
pub async fn run_tool(call: &ToolCall, ctx: &ToolContext, procs: &Arc<Processes>) -> Result<ToolResult, String> {
    let a = &call.input;
    match call.name.as_str() {
        "start_process" => {
            let command = match a.get("command") {
                Some(Value::String(c)) if !js::trim(c).is_empty() => c.clone(),
                _ => return Ok(ToolResult::err(call, "A command is required.")),
            };
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
            if decision.action == Action::Deny {
                return Ok(ToolResult::err(call, format!("Blocked by guardrail ({labels}).")));
            }
            let needs_approval = ctx.mode != ChatMode::Yolo && (asks_everything(ctx) || decision.action == Action::Ask);
            // An auto-run git gets an environment that keeps repo config from running anything.
            let env = if !needs_approval && ctx.mode == ChatMode::Guardrails && runs_git(&command, Dialect::host()) {
                hardened_git_env()
            } else {
                Vec::new()
            };
            if needs_approval {
                let reason = if labels.is_empty() { "Start a background process" } else { labels.as_str() };
                let ok = tokio::select! {
                    ok = ctx.approver.approve(call, reason, decision.severity) => ok,
                    _ = ctx.cancel.cancelled() => false,
                };
                if !ok {
                    return Ok(ToolResult::err(call, "Command not approved by user."));
                }
            }
            let Some(sid) = session(ctx) else { return Ok(ToolResult::err(call, NO_CHAT)) };
            let cwd = if js::truthy(a.get("cwd")) {
                resolve_path(a.get("cwd"), ctx)?
            } else {
                ctx.default_cwd.clone().or_else(|| first_workspace(ctx).map(str::to_string)).unwrap_or_else(process_cwd)
            };
            let workspace_id = ctx.workspaces.iter().find(|w| w.path == cwd).map(|w| w.id.clone());
            let name = match a.get("name") {
                Some(Value::String(n)) if !js::trim(n).is_empty() => {
                    let t = js::trim(n);
                    Some(js::slice16(t, 40).to_string())
                }
                _ => None,
            };
            let log = ctx.command_log.clone();
            let mirror: Mirror = Arc::new(move |s: &str, w: Option<&str>, text: &str| {
                if let Some(log) = &log {
                    log.append(s, w, text);
                }
            });
            let req = StartRequest {
                session_id: sid,
                workspace_id: workspace_id.as_deref(),
                command: &command,
                cwd: &cwd,
                name,
                env: &env,
            };
            match procs.start(req, mirror) {
                Ok(info) => {
                    let pid = info.pid.map(|p| format!(", pid {p}")).unwrap_or_default();
                    Ok(ToolResult::ok(
                        call,
                        format!(
                            "Started {}{pid}, in {cwd}. Call read_process with this id to see its output (wait_ms waits for more), kill_process to stop it. It stops when this chat stops.",
                            label(&info)
                        ),
                    ))
                }
                Err(e) => Ok(ToolResult::err(call, e)),
            }
        }
        "read_process" => {
            let Some(sid) = session(ctx) else { return Ok(ToolResult::err(call, NO_CHAT)) };
            let id = match a.get("id") {
                Some(Value::String(id)) if !id.is_empty() => id.clone(),
                _ => {
                    let list = procs.list(sid);
                    let now = nekko_js::now_ms();
                    return Ok(ToolResult::ok(
                        call,
                        if list.is_empty() {
                            "No background processes in this chat.".to_string()
                        } else {
                            list.iter().map(|p| describe_process(p, now)).collect::<Vec<_>>().join("\n")
                        },
                    ));
                }
            };
            // Another chat's process is not this one's to read (or to drain).
            if procs.get(&id).is_some_and(|p| p.session_id != sid) {
                return Ok(ToolResult::err(
                    call,
                    format!(
                        "No process {id} in this chat. It may have exited and been read already; start it again if you need it."
                    ),
                ));
            }
            let wait = a.get("wait_ms").and_then(Value::as_f64);
            let all = a.get("all") == Some(&Value::Bool(true));
            let read = tokio::select! {
                r = procs.read(&id, wait, all) => r,
                _ = ctx.cancel.cancelled() => procs.read(&id, None, all).await,
            };
            match read {
                Some((info, output, truncated)) if info.session_id == sid => {
                    let head = describe_process(&info, nekko_js::now_ms());
                    let body = if output.is_empty() {
                        "(no new output)".to_string()
                    } else {
                        format!("{}{output}", if truncated { "\u{2026}(older output dropped)\n" } else { "" })
                    };
                    Ok(ToolResult::ok(call, format!("{head}\n\n{body}")))
                }
                _ => Ok(ToolResult::err(
                    call,
                    format!(
                        "No process {id} in this chat. It may have exited and been read already; start it again if you need it."
                    ),
                )),
            }
        }
        "kill_process" => {
            let Some(sid) = session(ctx) else { return Ok(ToolResult::err(call, NO_CHAT)) };
            let id = match a.get("id") {
                Some(Value::String(id)) if !id.is_empty() => id.clone(),
                _ => return Ok(ToolResult::err(call, "A process id is required.")),
            };
            let Some(info) = procs.list(sid).into_iter().find(|p| p.id == id) else {
                return Ok(ToolResult::err(call, format!("No process {id} in this chat.")));
            };
            if info.exit.is_some() {
                return Ok(ToolResult::ok(
                    call,
                    format!("{} (already exited)", describe_process(&info, nekko_js::now_ms())),
                ));
            }
            procs.kill(&id);
            Ok(ToolResult::ok(call, format!("Stopping {}.", label(&info))))
        }
        other => Ok(ToolResult::err(call, format!("Unknown tool: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(exit: Option<Exit>, name: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            id: "p_1_1".into(),
            session_id: "s".into(),
            pid: Some(42),
            command: "npm run dev".into(),
            cwd: "/w".into(),
            name: name.map(str::to_string),
            started_at: 1_000,
            exit,
            ended_at: None,
        }
    }

    #[test]
    fn describes_like_the_ts_host() {
        assert_eq!(
            describe_process(&info(None, Some("web")), 3_600),
            "p_1_1 (web): running for 3 s, pid 42, started with `npm run dev` in /w"
        );
        assert_eq!(
            describe_process(&info(Some(Exit::Code(0)), None), 0),
            "p_1_1: exited with code 0, started with `npm run dev` in /w"
        );
        assert_eq!(
            describe_process(&info(Some(Exit::Signal("SIGTERM".into())), None), 0),
            "p_1_1: exited on SIGTERM, started with `npm run dev` in /w"
        );
    }

    #[test]
    fn clips_from_the_head() {
        let s: Vec<u16> = "abcdef".encode_utf16().collect();
        assert_eq!(String::from_utf16_lossy(&clip(s.clone(), 10)), "abcdef");
        assert_eq!(String::from_utf16_lossy(&clip(s, 3)), "\u{2026}\ndef");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
    }

    fn echo(text: &str) -> String {
        if cfg!(windows) { format!("echo {text}") } else { format!("printf '{text}\\n'") }
    }

    #[tokio::test]
    async fn runs_reads_and_forgets_a_finished_process() {
        let procs = Processes::new();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let seen = Arc::new(Mutex::new(String::new()));
        let s2 = seen.clone();
        let mirror: Mirror = Arc::new(move |_, _, t| lock(&s2).push_str(t));
        let cmd = echo("hello");
        let info = procs
            .start(
                StartRequest { session_id: "s", workspace_id: None, command: &cmd, cwd: &cwd, name: None, env: &[] },
                mirror,
            )
            .unwrap();
        let mut out = String::new();
        for _ in 0..50 {
            let (i, o, _) = procs.read(&info.id, Some(200.0), false).await.unwrap();
            out.push_str(&o);
            if i.exit.is_some() {
                assert_eq!(i.exit, Some(Exit::Code(0)));
                break;
            }
        }
        assert!(out.contains("hello"), "{out}");
        assert!(procs.get(&info.id).is_none(), "read after exit forgets it");
        tokio::time::sleep(Duration::from_millis(50)).await;
        let seen = lock(&seen).clone();
        assert!(seen.contains("[background]") || seen.contains(", background]"), "{seen}");
        assert!(seen.contains(&format!("[{} exited with code 0]", info.id)), "{seen}");
    }

    #[tokio::test]
    async fn kills_a_chats_processes_and_enforces_the_limit() {
        let procs = Processes::new();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let sleep = if cfg!(windows) { "ping -n 30 127.0.0.1 >nul" } else { "sleep 30" };
        let mirror: Mirror = Arc::new(|_, _, _| {});
        let mut ids = Vec::new();
        for _ in 0..PROCESS_LIMIT {
            let req =
                StartRequest { session_id: "s", workspace_id: None, command: sleep, cwd: &cwd, name: None, env: &[] };
            ids.push(procs.start(req, mirror.clone()).unwrap().id);
        }
        let req = StartRequest { session_id: "s", workspace_id: None, command: sleep, cwd: &cwd, name: None, env: &[] };
        assert!(procs.start(req, mirror.clone()).unwrap_err().contains("already has 8 processes"));
        assert_eq!(procs.kill_session("s"), PROCESS_LIMIT);
        for id in &ids {
            let mut exited = false;
            for _ in 0..100 {
                if procs.get(id).and_then(|p| p.exit).is_some() {
                    exited = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(exited, "{id} still running");
        }
    }

    #[tokio::test]
    async fn a_bad_folder_is_reported_like_node() {
        let procs = Processes::new();
        let mirror: Mirror = Arc::new(|_, _, _| {});
        let req = StartRequest {
            session_id: "s",
            workspace_id: None,
            command: "echo x",
            cwd: "/definitely/not/here/nekko",
            name: Some("x".into()),
            env: &[],
        };
        let info = procs.start(req, mirror).unwrap();
        assert!(info.pid.is_none());
        let (i, out, _) = procs.read(&info.id, None, false).await.unwrap();
        assert_eq!(i.exit, Some(Exit::Code(-1)));
        assert!(out.starts_with("[could not start: spawn "), "{out}");
    }
}
