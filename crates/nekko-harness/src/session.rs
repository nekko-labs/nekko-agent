//! One long-lived `claude -p` child per chat, spoken to in stream-json.

use crate::locate::{ClaudeBin, command};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc;

/// How many stderr lines are kept for an exit's error message.
const STDERR_TAIL: usize = 40;

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// Claude Code's permission mode for the chat. There is deliberately no
/// `bypassPermissions`: every prompt Nekko does not auto-allow reaches the
/// approval bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
}

impl PermissionMode {
    pub fn flag(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
        }
    }
}

/// A new conversation with the id Nekko chose, or one Claude Code already has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStart {
    New(String),
    Resume(String),
}

impl SessionStart {
    pub fn id(&self) -> &str {
        match self {
            Self::New(id) | Self::Resume(id) => id,
        }
    }
}

/// Everything a launch needs. Nothing here touches the environment: the
/// child gets the user's as it is.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub bin: ClaudeBin,
    /// The chat's workspace or worktree.
    pub cwd: PathBuf,
    pub session: SessionStart,
    /// A Claude Code model alias or id (`opus`, `sonnet`, `claude-opus-5-5`).
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    /// The per-chat MCP config with the approval bridge.
    pub mcp_config: Option<PathBuf>,
    /// `mcp__nekko_bridge__approve`.
    pub permission_prompt_tool: Option<String>,
    /// The chat's other workspaces.
    pub add_dirs: Vec<PathBuf>,
    /// `CLAUDE_CONFIG_DIR` for a second Claude Code account; `None` runs on
    /// the user's default login.
    pub config_dir: Option<PathBuf>,
}

/// The command line, without the binary. Always stream-json both ways with
/// partial messages (without them text arrives in one block), and with each
/// message Nekko writes reported back as Claude Code takes it up
/// (`command_lifecycle`), so a turn knows which `result` answers it.
pub fn launch_args(spec: &LaunchSpec) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    match &spec.session {
        SessionStart::New(id) => a.extend(["--session-id".into(), id.clone()]),
        SessionStart::Resume(id) => a.extend(["--resume".into(), id.clone()]),
    }
    if let Some(model) = spec.model.as_ref().filter(|m| !m.trim().is_empty()) {
        a.extend(["--model".into(), model.clone()]);
    }
    a.extend(["--permission-mode".into(), spec.permission_mode.flag().into()]);
    if let Some(config) = &spec.mcp_config {
        a.extend(["--mcp-config".into(), config.to_string_lossy().into_owned()]);
    }
    if let Some(tool) = &spec.permission_prompt_tool {
        a.extend(["--permission-prompt-tool".into(), tool.clone()]);
    }
    for dir in &spec.add_dirs {
        a.extend(["--add-dir".into(), dir.to_string_lossy().into_owned()]);
    }
    a
}

/// A random v4 UUID, for `--session-id`.
pub fn new_session_id() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// A user message line. `uuid` comes back in the `command_lifecycle` events
/// Claude Code reports for it.
pub fn user_line(content: Value, uuid: &str) -> Value {
    json!({ "type": "user", "uuid": uuid, "message": { "role": "user", "content": content } })
}

/// The stream-json interrupt (what the Agent SDK's `interrupt()` sends).
pub fn interrupt_line(request_id: &str) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "interrupt" } })
}

/// Declining a control request Claude Code sent.
pub fn control_error_line(request_id: &str, error: &str) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": error } })
}

/// A running `claude -p` child.
pub struct Session {
    child: Child,
    pid: Option<u32>,
    stdin: Option<ChildStdin>,
    lines: mpsc::UnboundedReceiver<String>,
    /// A line [`Session::readable`] looked at and left for [`recv`](crate::Transport::recv).
    peeked: Option<String>,
    /// Background tasks Claude Code says are running (`background_tasks_changed`).
    background: usize,
    /// Told the new count whenever it changes ([`Session::on_background_change`]).
    on_background: Option<Box<dyn Fn(usize) + Send + Sync>>,
    /// Whether this child has reported a `command_lifecycle` for a message.
    reports_commands: bool,
    stderr: Arc<Mutex<VecDeque<String>>>,
    /// Claude Code's session id (`--session-id` / `--resume`).
    pub claude_session_id: String,
    /// What it was launched with, so a change (model, mode) relaunches.
    pub spec: LaunchSpec,
}

impl Session {
    /// Start the child in the chat's folder, with the user's environment.
    pub fn spawn(spec: LaunchSpec) -> io::Result<Self> {
        let mut cmd = command(&spec.bin.path);
        cmd.args(launch_args(&spec))
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = &spec.config_dir {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
        let mut child = cmd.spawn()?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let (tx, lines) = mpsc::unbounded_channel();
        if let Some(out) = child.stdout.take() {
            tokio::spawn(async move {
                let mut r = BufReader::new(out).lines();
                while let Ok(Some(line)) = r.next_line().await {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
        }
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(err) = child.stderr.take() {
            let tail = stderr.clone();
            tokio::spawn(async move {
                let mut r = BufReader::new(err).lines();
                while let Ok(Some(line)) = r.next_line().await {
                    let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                    if t.len() == STDERR_TAIL {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            });
        }
        let claude_session_id = spec.session.id().to_string();
        Ok(Self {
            child,
            pid,
            stdin,
            lines,
            peeked: None,
            background: 0,
            on_background: None,
            reports_commands: false,
            stderr,
            claude_session_id,
            spec,
        })
    }

    /// Wait for the next stdout line without taking it; false once the
    /// process is gone. Cancel-safe, as the channel's receive is.
    pub async fn readable(&mut self) -> bool {
        if self.peeked.is_some() {
            return true;
        }
        match self.lines.recv().await {
            Some(line) => {
                self.note(&line);
                self.peeked = Some(line);
                true
            }
            None => false,
        }
    }

    /// Drop the line [`Session::readable`] waited for, when it is only
    /// bookkeeping ([`is_passive`]) that no turn needs to see.
    pub fn skip_passive(&mut self) -> bool {
        if self.peeked.as_deref().is_some_and(is_passive) {
            self.peeked = None;
            return true;
        }
        false
    }

    /// Whether Claude Code has background tasks (shell commands, sub-agents)
    /// still running: ending the process would end them too.
    pub fn has_background_tasks(&self) -> bool {
        self.background > 0
    }

    /// Hear the number of background tasks each time it changes, and 0 when
    /// the child ends with some still counted (they end with it).
    pub fn on_background_change(&mut self, f: impl Fn(usize) + Send + Sync + 'static) {
        self.on_background = Some(Box::new(f));
    }

    fn note(&mut self, line: &str) {
        if !line.contains("background_tasks_changed") {
            return;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line)
            && v.get("subtype").and_then(Value::as_str) == Some("background_tasks_changed")
        {
            self.set_background(v.get("tasks").and_then(Value::as_array).map_or(0, Vec::len));
        }
    }

    fn set_background(&mut self, n: usize) {
        if n != self.background {
            self.background = n;
            if let Some(f) = &self.on_background {
                f(n);
            }
        }
    }

    /// Whether the child is still running.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// End the child and everything it started (on Windows the spawned
    /// process is the `cmd` shim; Claude Code is its child).
    pub fn kill_tree(&mut self) {
        self.stdin = None;
        if let Some(pid) = self.pid.take() {
            kill_tree(pid);
        }
        let _ = self.child.start_kill();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill_tree();
        self.set_background(0);
    }
}

impl crate::turn::Transport for Session {
    async fn send(&mut self, line: Value) -> io::Result<()> {
        let stdin = self.stdin.as_mut().ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "stdin closed"))?;
        let mut bytes = serde_json::to_vec(&line).map_err(io::Error::other)?;
        bytes.push(b'\n');
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    }

    async fn recv(&mut self) -> Option<String> {
        if let Some(line) = self.peeked.take() {
            return Some(line);
        }
        let line = self.lines.recv().await?;
        self.note(&line);
        Some(line)
    }

    fn reports_commands(&self) -> bool {
        self.reports_commands
    }

    fn set_reports_commands(&mut self) {
        self.reports_commands = true;
    }

    fn kill(&mut self) {
        self.kill_tree();
    }

    fn next_request_id(&mut self) -> String {
        format!("nekko-{}", REQUEST_SEQ.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn diagnostics(&mut self) -> String {
        let code = self.child.try_wait().ok().flatten().map(|s| s.to_string());
        let tail: Vec<String> = self.stderr.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
        let tail = tail.join("\n");
        match (code, tail.trim().is_empty()) {
            (Some(c), false) => format!("Claude Code exited ({c}):\n{tail}"),
            (Some(c), true) => format!("Claude Code exited ({c})."),
            (None, false) => format!("Claude Code stopped responding:\n{tail}"),
            (None, true) => "Claude Code stopped responding.".into(),
        }
    }
}

/// A line Claude Code prints between turns that starts no work of its own:
/// background-task bookkeeping, rate limits, message lifecycle, or anything
/// that is not JSON.
pub fn is_passive(line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return true };
    match v.get("type").and_then(Value::as_str) {
        Some("command_lifecycle" | "rate_limit_event") => true,
        Some("system") => matches!(
            v.get("subtype").and_then(Value::as_str),
            Some("background_tasks_changed" | "task_started" | "task_updated" | "task_progress")
        ),
        _ => false,
    }
}

/// End a process tree: `taskkill /T` on Windows (a bare kill of the `cmd`
/// shim leaves Claude Code running, H0), the process group elsewhere.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        // SAFETY: kill takes a process group id and a signal number, no pointers.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(session: SessionStart) -> LaunchSpec {
        LaunchSpec {
            bin: ClaudeBin { path: "claude".into(), version: "2.1.284".into() },
            cwd: ".".into(),
            session,
            model: Some("opus".into()),
            permission_mode: PermissionMode::AcceptEdits,
            mcp_config: Some("C:/data/harness/s1.mcp.json".into()),
            permission_prompt_tool: Some("mcp__nekko_bridge__approve".into()),
            add_dirs: vec!["D:/other".into()],
            config_dir: None,
        }
    }

    #[test]
    fn launches_headless_stream_json() {
        let a = launch_args(&spec(SessionStart::New("u-1".into())));
        assert_eq!(
            a,
            [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--replay-user-messages",
                "--session-id",
                "u-1",
                "--model",
                "opus",
                "--permission-mode",
                "acceptEdits",
                "--mcp-config",
                "C:/data/harness/s1.mcp.json",
                "--permission-prompt-tool",
                "mcp__nekko_bridge__approve",
                "--add-dir",
                "D:/other",
            ]
        );
        let r = launch_args(&spec(SessionStart::Resume("u-2".into())));
        assert!(r.windows(2).any(|w| w == ["--resume", "u-2"]));
        assert!(!r.contains(&"--session-id".to_string()));
    }

    /// The compliance line: no flag that replaces Claude Code's prompt, skips
    /// the user's setup, or turns permissions off can ever be produced.
    #[test]
    fn never_passes_a_forbidden_flag() {
        for mode in [PermissionMode::Default, PermissionMode::AcceptEdits, PermissionMode::Plan] {
            let mut s = spec(SessionStart::New("u".into()));
            s.permission_mode = mode;
            let a = launch_args(&s).join(" ");
            for bad in [
                "--system-prompt",
                "--append-system-prompt",
                "--bare",
                "--dangerously-skip-permissions",
                "bypassPermissions",
            ] {
                assert!(!a.contains(bad), "{bad} in {a}");
            }
        }
    }

    #[test]
    fn session_ids_are_v4_uuids() {
        let id = new_session_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, new_session_id());
    }

    #[test]
    fn control_lines() {
        assert_eq!(
            interrupt_line("r1"),
            json!({ "type": "control_request", "request_id": "r1", "request": { "subtype": "interrupt" } })
        );
        let line = user_line(json!("hi"), "u-1");
        assert_eq!(line["message"], json!({ "role": "user", "content": "hi" }));
        assert_eq!(line["uuid"], "u-1");
    }

    #[test]
    fn bookkeeping_between_turns_is_passive() {
        for line in [
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#,
            r#"{"type":"system","subtype":"task_updated","task_id":"b1","patch":{"status":"completed"}}"#,
            r#"{"type":"command_lifecycle","command_uuid":"u","state":"completed"}"#,
            "not json",
        ] {
            assert!(is_passive(line), "{line}");
        }
        for line in [
            r#"{"type":"system","subtype":"task_notification","task_id":"b1","status":"completed"}"#,
            r#"{"type":"system","subtype":"init","session_id":"s"}"#,
            r#"{"type":"assistant","message":{"content":[]}}"#,
        ] {
            assert!(!is_passive(line), "{line}");
        }
    }
}
