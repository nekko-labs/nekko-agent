//! Claude Agent chats (`ProviderKind::ClaudeCode`): the user's own Claude
//! Code runs the turn and nekkod is the cockpit around it (nekko-harness).
//!
//! - One `claude -p` child per chat, kept between turns and reaped after
//!   [`IDLE_REAP`] without one, unless Claude Code still runs background
//!   tasks (a reap would end them). The chat stores Claude Code's session id
//!   (`claudeCodeSessionId`), so the next turn after a reap, a crash or an app
//!   restart continues the conversation with `--resume`.
//! - A change of model, permission mode or folders relaunches the child
//!   (with `--resume`): those are launch flags. A change of Claude Code
//!   account relaunches it too, as a new Claude Code session, since the old
//!   one lives in the other account's folder (turns.rs).
//! - The child inherits the user's environment as it is, plus
//!   `CLAUDE_CONFIG_DIR` when the provider names a second Claude Code account
//!   ([`provider_account`]). Nekko never reads Claude Code's credentials and
//!   never sets a token.
//!
//! - Between turns the child is watched ([`Harness::idle`]): Claude Code
//!   wakes on its own when a background command or sub-agent finishes, and
//!   that work becomes a Nekko turn (turns.rs `wake`), so its permission
//!   prompts have a turn to wait in and the chat shows it working. A wake-up
//!   reads the child that woke whatever flags it was launched with.
//! - The number of background tasks each child runs is published as it
//!   changes (`claude_code_background`) and kept for `claude:backgroundTasks`,
//!   so the chat can say Claude Code is still working after a turn's Done.
//!
//! The turn itself (events, transcript, Stop and Steer) runs in turns.rs
//! (`claude_code_turn`) over [`nekko_harness::run_turn`].

use nekko_harness::{ClaudeBin, LaunchSpec, PermissionMode, Session, SessionStart};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, OwnedMutexGuard};

/// A chat's Claude Code child is ended after this long without a turn.
pub const IDLE_REAP: Duration = Duration::from_secs(15 * 60);
/// How often the reaper looks.
const REAP_EVERY: Duration = Duration::from_secs(60);
/// How long Stop waits for Claude Code to answer the interrupt before the
/// process tree is ended.
pub const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A chat's Claude Code child, between and during turns.
#[derive(Default)]
pub struct Slot {
    pub session: Option<Session>,
    pub last_used: Option<Instant>,
}

/// The turns waiting for a chat's child, so its idle watch lets go of it.
#[derive(Default)]
struct Want {
    waiting: AtomicUsize,
    notify: Notify,
}

/// Counts a turn as waiting until it has the child (or gives up).
struct Waiting(Arc<Want>);

impl Waiting {
    fn new(want: Arc<Want>) -> Self {
        want.waiting.fetch_add(1, Ordering::SeqCst);
        want.notify.notify_waiters();
        Self(want)
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.waiting.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Why [`Harness::idle`] stopped watching a child.
#[derive(Debug, PartialEq, Eq)]
pub enum Idle {
    /// Claude Code started work of its own: its output waits for a turn.
    Woke,
    /// A turn wants the child.
    Yielded,
    /// The child is gone (exited, reaped, or the chat closed).
    Gone,
}

type SlotEntry = (Arc<tokio::sync::Mutex<Slot>>, Arc<Want>);

/// Every Claude Agent chat's child.
#[derive(Default)]
pub struct Harness {
    /// By Nekko chat id. The async lock is held for a whole turn, so one chat
    /// never has two turns writing to the same child, and by the idle watch
    /// between turns, which lets go as soon as a turn asks ([`Harness::take`]).
    slots: Mutex<HashMap<String, SlotEntry>>,
    /// Bridge tokens: which chat (and its folders) each one answers for.
    bridges: Mutex<HashMap<String, BridgeEntry>>,
    /// Set once at startup: the daemon's loopback URL, how to start the
    /// bridge (`None`: no CLI to run it, so every launch fails closed), and
    /// where the per-chat MCP configs are written.
    bridge: OnceLock<BridgeSetup>,
    /// Plan usage each Claude Agent provider's Claude Code last reported in its
    /// own stream (`rate_limit_event`, `/usage`), by provider id. Shown only
    /// where the `usage_limits` policy row allows (`claude:planUsage`).
    plan_usage: Mutex<HashMap<String, serde_json::Value>>,
    /// Background tasks each chat's Claude Code still runs, by chat id
    /// (`claude:backgroundTasks`); a chat with none is not listed.
    background: Mutex<HashMap<String, usize>>,
}

#[derive(Debug, Clone)]
pub struct BridgeEntry {
    pub session_id: String,
    pub roots: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct BridgeSetup {
    pub wire_url: String,
    pub command: Option<BridgeCommand>,
    pub dir: PathBuf,
}

/// The permission mode for a chat's Nekko mode: Ask and Guardrails keep
/// Claude Code's default (every prompt reaches Nekko's approvals), YOLO lets
/// Claude Code accept edits itself, Plan is Claude Code's plan mode.
pub fn permission_mode(mode: &str) -> PermissionMode {
    match mode {
        "yolo" => PermissionMode::AcceptEdits,
        "plan" => PermissionMode::Plan,
        _ => PermissionMode::Default,
    }
}

/// What a turn wants the child launched with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    pub cwd: PathBuf,
    pub add_dirs: Vec<PathBuf>,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    /// The provider's Claude Code account folder; `None` for the default login.
    pub config_dir: Option<PathBuf>,
}

/// The Claude Code account a Claude Agent provider names
/// (`claudeCode.account`), `None` for the user's default login.
pub fn provider_account(provider: &serde_json::Value) -> Option<&str> {
    provider.pointer("/claudeCode/account").and_then(serde_json::Value::as_str).filter(|a| !a.is_empty())
}

impl Wanted {
    /// Whether a running child already matches.
    pub fn matches(&self, spec: &LaunchSpec) -> bool {
        spec.cwd == self.cwd
            && spec.add_dirs == self.add_dirs
            && spec.model == self.model
            && spec.permission_mode == self.permission_mode
            && spec.config_dir == self.config_dir
    }

    /// The launch, continuing `stored` when the chat has one.
    pub fn launch(&self, bin: ClaudeBin, stored: Option<&str>) -> LaunchSpec {
        let session = match stored.filter(|s| !s.is_empty()) {
            Some(id) => SessionStart::Resume(id.to_string()),
            None => SessionStart::New(nekko_harness::new_session_id()),
        };
        LaunchSpec {
            bin,
            cwd: self.cwd.clone(),
            session,
            model: self.model.clone(),
            permission_mode: self.permission_mode,
            mcp_config: None,
            permission_prompt_tool: None,
            add_dirs: self.add_dirs.clone(),
            config_dir: self.config_dir.clone(),
        }
    }
}

impl Harness {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Fold one plan-usage event from a provider's Claude Code into what it last reported.
    pub fn note_plan_usage(&self, provider_id: &str, event: &serde_json::Value) {
        let mut all = lock(&self.plan_usage);
        let now = nekko_oauth::now_ms() as f64;
        if let Some(next) = nekko_usage::parse_claude_code_usage(event, all.get(provider_id), now) {
            all.insert(provider_id.to_string(), next);
        }
    }

    /// What a provider's Claude Code last reported about plan usage, if anything.
    pub fn plan_usage(&self, provider_id: &str) -> Option<serde_json::Value> {
        lock(&self.plan_usage).get(provider_id).cloned()
    }

    /// A chat's Claude Code now runs `n` background tasks.
    pub fn note_background(&self, session_id: &str, n: usize) {
        let mut all = lock(&self.background);
        if n == 0 {
            all.remove(session_id);
        } else {
            all.insert(session_id.to_string(), n);
        }
    }

    /// `claude:backgroundTasks`: how many background tasks each chat's Claude
    /// Code runs, for the chats that run any.
    pub fn background_tasks(&self) -> serde_json::Value {
        serde_json::json!(*lock(&self.background))
    }

    /// The chat's slot (made on first use).
    #[cfg(test)]
    pub fn slot(&self, session_id: &str) -> Arc<tokio::sync::Mutex<Slot>> {
        self.entry(session_id).0
    }

    fn entry(&self, session_id: &str) -> SlotEntry {
        lock(&self.slots).entry(session_id.to_string()).or_default().clone()
    }

    /// The chat's child for a turn, once the turn before it is over; the
    /// idle watch lets go of it at once.
    pub async fn take(&self, session_id: &str) -> OwnedMutexGuard<Slot> {
        let (slot, want) = self.entry(session_id);
        let _waiting = Waiting::new(want);
        slot.lock_owned().await
    }

    /// End a chat's child (the chat was deleted, or the daemon is stopping).
    pub async fn close(&self, session_id: &str) {
        let entry = lock(&self.slots).remove(session_id);
        if let Some((slot, want)) = entry {
            let _waiting = Waiting::new(want);
            slot.lock().await.session = None;
        }
        self.forget(session_id);
    }

    /// Watch the chat's child between turns, holding it until Claude Code
    /// prints something that starts work of its own ([`Idle::Woke`]: the line
    /// stays for the turn that reads it), a turn asks for it, or it is gone.
    /// Bookkeeping lines ([`nekko_harness::is_passive`]) are dropped. The
    /// watch also ends a child idle for [`IDLE_REAP`] with no background
    /// task, as the reaper does (it skips a watched slot).
    pub async fn idle(&self, session_id: &str) -> Idle {
        let Some((slot, want)) = lock(&self.slots).get(session_id).cloned() else { return Idle::Gone };
        let mut tick = tokio::time::interval(REAP_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        enum Next {
            Yield,
            Line(bool),
            Tick,
        }
        loop {
            let notified = want.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if want.waiting.load(Ordering::SeqCst) > 0 {
                return Idle::Yielded;
            }
            let mut s = tokio::select! {
                s = slot.clone().lock_owned() => s,
                _ = &mut notified => return Idle::Yielded,
            };
            let Some(child) = s.session.as_mut() else { return Idle::Gone };
            let next = tokio::select! {
                biased;
                _ = &mut notified => Next::Yield,
                open = child.readable() => Next::Line(open),
                _ = tick.tick() => Next::Tick,
            };
            match next {
                Next::Yield => return Idle::Yielded,
                Next::Line(false) => return Idle::Gone,
                Next::Line(true) if child.skip_passive() => {}
                Next::Line(true) => return Idle::Woke,
                Next::Tick => {
                    let idle = s.last_used.is_none_or(|t| t.elapsed() >= IDLE_REAP);
                    if idle && !s.session.as_ref().is_some_and(Session::has_background_tasks) {
                        s.session = None;
                        return Idle::Gone;
                    }
                }
            }
        }
    }

    /// Where the bridge comes from (startup).
    pub fn configure(&self, setup: BridgeSetup) {
        let _ = self.bridge.set(setup);
    }

    /// A fresh bridge for the chat's next launch: its token, and the
    /// `--mcp-config` file that starts `nekko-agent mcp --bridge` with it.
    /// An error means Claude Code must not start: nothing could answer its
    /// permission prompts.
    pub fn prepare_bridge(&self, session_id: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
        const UNAVAILABLE: &str = "Nekko's approval bridge is not available (the nekko-agent CLI was not found), so Claude Code was not started.";
        let setup = self.bridge.get().ok_or(UNAVAILABLE)?;
        let command = setup.command.as_ref().ok_or(UNAVAILABLE)?;
        self.forget(session_id);
        let token = new_token();
        let file = setup.dir.join(format!("{session_id}.mcp.json"));
        // The file holds the token: owner-only (0600), written atomically.
        nekko_settings::write_json_atomic(&file, &command.mcp_config(&setup.wire_url, &token))
            .map_err(|e| format!("Could not write the approval bridge's config: {e}"))?;
        lock(&self.bridges).insert(token, BridgeEntry { session_id: session_id.into(), roots: roots.to_vec() });
        Ok(file)
    }

    /// Which chat a bridge token answers for.
    pub fn bridge_session(&self, token: &str) -> Option<BridgeEntry> {
        lock(&self.bridges).iter().find(|(t, _)| crate::wire::token_eq(t, token)).map(|(_, e)| e.clone())
    }

    /// Drop a chat's bridge tokens and config file.
    fn forget(&self, session_id: &str) {
        lock(&self.bridges).retain(|_, e| e.session_id != session_id);
        if let Some(setup) = self.bridge.get() {
            let _ = std::fs::remove_file(setup.dir.join(format!("{session_id}.mcp.json")));
        }
    }

    /// End every child idle longer than `max_idle` with no background task
    /// running. A slot in a turn (or watched) is locked and skipped.
    pub fn reap(&self, max_idle: Duration) -> usize {
        let now = Instant::now();
        let slots: Vec<(String, Arc<tokio::sync::Mutex<Slot>>)> =
            lock(&self.slots).iter().map(|(k, (v, _))| (k.clone(), v.clone())).collect();
        let mut reaped = 0;
        for (id, slot) in slots {
            let Ok(mut s) = slot.try_lock() else { continue };
            let idle = s.last_used.is_none_or(|t| now.duration_since(t) >= max_idle);
            let busy = s.session.as_ref().is_some_and(Session::has_background_tasks);
            if s.session.is_some() && idle && !busy {
                s.session = None;
                reaped += 1;
            }
            if s.session.is_none() {
                drop(s);
                lock(&self.slots).remove(&id);
                self.forget(&id);
            }
        }
        reaped
    }

    /// Reap idle children every minute, for the daemon's life.
    pub fn start_reaper(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(REAP_EVERY);
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(h) = me.upgrade() else { break };
                h.reap(IDLE_REAP);
            }
        });
    }
}

// ---- The approval bridge (H3) ----
//
// Claude Code asks for permission through `--permission-prompt-tool
// mcp__nekko_bridge__approve`: an MCP stdio server (`nekko-agent mcp
// --bridge`, its token in [`BRIDGE_TOKEN_ENV`], never in argv where any
// local user could list it) that nekkod lists in a per-chat, owner-only
// `--mcp-config`. Each
// call comes back here over the loopback wire (`POST /harness/approve`,
// authenticated by that chat's bridge token, never the daemon's own), is
// decided by the chat's mode ([`decide`]) and, when it needs a person, waits
// in Nekko's approvals like any other tool call.

/// The MCP server name and the tool Claude Code is told to ask.
pub const BRIDGE_SERVER: &str = "nekko_bridge";
pub const BRIDGE_TOOL: &str = "mcp__nekko_bridge__approve";
/// The environment variable the bridge server reads its token from.
pub const BRIDGE_TOKEN_ENV: &str = "NEKKO_BRIDGE_TOKEN";

/// How the daemon starts `nekko-agent mcp --bridge`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl BridgeCommand {
    /// The app's own CLI, run by its Electron binary as Node (no Node install needed).
    pub fn electron(exe: &str, cli: &str) -> Self {
        Self { command: exe.into(), args: vec![cli.into()], env: vec![("ELECTRON_RUN_AS_NODE".into(), "1".into())] }
    }

    /// A `nekko-agent` launcher on PATH. A Windows `.cmd` needs `cmd /c`.
    pub fn launcher(path: &str) -> Self {
        if cfg!(windows) && path.to_ascii_lowercase().ends_with(".cmd") {
            return Self { command: "cmd".into(), args: vec!["/c".into(), path.into()], env: Vec::new() };
        }
        Self { command: path.into(), args: Vec::new(), env: Vec::new() }
    }

    /// The chat's `--mcp-config` document.
    pub fn mcp_config(&self, wire_url: &str, token: &str) -> serde_json::Value {
        let mut args = self.args.clone();
        args.extend(["mcp".into(), "--bridge".into(), "--url".into(), wire_url.into()]);
        let mut env: serde_json::Map<String, serde_json::Value> =
            self.env.iter().map(|(k, v)| (k.clone(), serde_json::json!(v))).collect();
        env.insert(BRIDGE_TOKEN_ENV.into(), serde_json::json!(token));
        serde_json::json!({
            "mcpServers": {
                BRIDGE_SERVER: { "type": "stdio", "command": self.command, "args": args, "env": env }
            }
        })
    }
}

/// What the bridge does with one permission prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Put it in front of the user.
    Ask {
        reason: String,
        severity: &'static str,
    },
    Deny(String),
}

fn severity(s: nekko_tools::Severity) -> &'static str {
    match s {
        nekko_tools::Severity::Low => "low",
        nekko_tools::Severity::Medium => "medium",
        nekko_tools::Severity::High => "high",
    }
}

const SHELL_TOOLS: &[&str] = &["Bash", "PowerShell"];
const EDIT_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Whether `path` is inside one of the chat's folders (relative paths are
/// the first folder's). Case-insensitive on Windows, as its paths are.
pub fn inside(path: &str, roots: &[PathBuf]) -> bool {
    let Some(first) = roots.first() else { return false };
    let p = std::path::Path::new(path);
    let full = if p.is_absolute() { p.to_path_buf() } else { first.join(p) };
    let norm = |p: &std::path::Path| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for c in p.components() {
            match c {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                c => {
                    let s = c.as_os_str().to_string_lossy().replace('\\', "/");
                    out.push(if cfg!(windows) { s.to_lowercase() } else { s });
                }
            }
        }
        out
    };
    let full = norm(&full);
    roots.iter().any(|r| {
        let r = norm(r);
        full.len() >= r.len() && full[..r.len()] == r[..]
    })
}

/// Decide a permission prompt by the chat's Nekko mode:
///
/// - **ask**: every prompt goes to the user.
/// - **guardrails**: shell commands made only of known read-only commands
///   (or ones a user `allow` rule covers) run; edits inside the chat's
///   folders run; everything else asks (decision 0010).
/// - **yolo**: everything runs except shell commands the rules mark
///   high-severity (destructive) and edits outside the chat's folders, which ask.
/// - **plan**: everything asks.
///
/// A rule whose action is `deny` blocks in every mode.
pub fn decide(
    mode: &str,
    tool: &str,
    input: &serde_json::Value,
    rules: &[nekko_tools::GuardrailRule],
    roots: &[PathBuf],
) -> Decision {
    use nekko_tools::Action;
    let ask = |reason: String, sev: &'static str| Decision::Ask { reason, severity: sev };
    if SHELL_TOOLS.contains(&tool) {
        let command = input.get("command").and_then(serde_json::Value::as_str).unwrap_or_default();
        // Claude Code's Bash tool runs bash (Git Bash on Windows).
        let dialect = if tool == "PowerShell" { nekko_tools::Dialect::PowerShell } else { nekko_tools::Dialect::Posix };
        let d = nekko_tools::classify_command_in(command, rules, dialect);
        let why = d.matches.iter().find(|m| m.rule_id != nekko_tools::NOT_READ_ONLY).map(|m| m.label.clone());
        if d.action == Action::Deny {
            return Decision::Deny(format!("Blocked by a guardrail rule ({}).", why.unwrap_or_else(|| "deny".into())));
        }
        let reason = why.unwrap_or_else(|| "Claude Code wants to run a command.".into());
        let sev = severity(d.severity);
        return match mode {
            "guardrails" if d.action == Action::Allow => Decision::Allow,
            "yolo" if !(d.action == Action::Ask && d.severity == nekko_tools::Severity::High) => Decision::Allow,
            _ => ask(reason, if d.action == Action::Allow { "medium" } else { sev }),
        };
    }
    if EDIT_TOOLS.contains(&tool) {
        let path = ["file_path", "notebook_path", "path"]
            .iter()
            .find_map(|k| input.get(*k).and_then(serde_json::Value::as_str))
            .unwrap_or_default();
        let ours = !path.is_empty() && inside(path, roots);
        // Git config can name programs a later auto-allowed `git status` runs (decision 0010).
        let git = !path.is_empty() && {
            let p = std::path::Path::new(path);
            let full = if p.is_absolute() || roots.is_empty() { p.to_path_buf() } else { roots[0].join(p) };
            nekko_tools::gitguard::touches_git_config(&full.to_string_lossy())
        };
        return match mode {
            "guardrails" if ours && git => ask(
                format!("Claude Code wants to change git configuration, which can name programs git runs: {path}"),
                "high",
            ),
            "guardrails" | "yolo" if ours => Decision::Allow,
            _ if !ours => {
                ask(format!("Claude Code wants to change a file outside this chat's folders: {path}"), "high")
            }
            _ => ask(format!("Claude Code wants to change {path}."), "medium"),
        };
    }
    match mode {
        "yolo" => Decision::Allow,
        _ => ask(format!("Claude Code wants to use {tool}."), "medium"),
    }
}

/// `nekko-agent` on PATH: the launcher the app installs, or the npm package.
pub fn cli_on_path() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["nekko-agent.cmd", "nekko-agent.exe"] } else { &["nekko-agent"] };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// A fresh bridge token: 32 random bytes, hex.
pub fn new_token() -> String {
    let mut b = [0u8; 32];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wanted() -> Wanted {
        Wanted {
            cwd: "C:/w".into(),
            add_dirs: vec![],
            model: Some("opus".into()),
            permission_mode: PermissionMode::Default,
            config_dir: None,
        }
    }

    fn bin() -> ClaudeBin {
        ClaudeBin { path: "claude".into(), version: "2.1.284".into() }
    }

    fn roots() -> Vec<PathBuf> {
        vec![PathBuf::from(if cfg!(windows) { r"C:\work\repo" } else { "/work/repo" })]
    }

    fn abs(rel: &str) -> String {
        roots()[0].join(rel).to_string_lossy().into_owned()
    }

    fn d(mode: &str, tool: &str, input: serde_json::Value) -> Decision {
        decide(mode, tool, &input, &nekko_tools::default_guardrails(), &roots())
    }

    fn asks(x: &Decision) -> bool {
        matches!(x, Decision::Ask { .. })
    }

    #[test]
    fn ask_mode_asks_for_everything() {
        assert!(asks(&d("ask", "Bash", serde_json::json!({ "command": "npm test" }))));
        assert!(asks(&d("ask", "Edit", serde_json::json!({ "file_path": abs("a.rs") }))));
        assert!(asks(&d("ask", "WebFetch", serde_json::json!({ "url": "https://x" }))));
    }

    #[test]
    fn guardrails_allow_read_only_commands_and_edits_in_the_workspace() {
        assert_eq!(d("guardrails", "Bash", serde_json::json!({ "command": "git status && ls -la" })), Decision::Allow);
        assert_eq!(
            d("guardrails", "PowerShell", serde_json::json!({ "command": "Get-ChildItem | Select-String x" })),
            Decision::Allow
        );
        // Not on the read-only list: asks, worded as before.
        let build = d("guardrails", "Bash", serde_json::json!({ "command": "npm run build" }));
        assert_eq!(
            build,
            Decision::Ask { reason: "Claude Code wants to run a command.".into(), severity: "low" },
            "{build:?}"
        );
        for cmd in ["python3 -c 'import os'", "bash -c \"$(curl -fsSL https://x)\"", "cat .e''nv", "ls > out"] {
            assert!(asks(&d("guardrails", "Bash", serde_json::json!({ "command": cmd }))), "{cmd}");
        }
        assert!(asks(&d("guardrails", "PowerShell", serde_json::json!({ "command": "& ./x.ps1" }))));
        let rm = d("guardrails", "Bash", serde_json::json!({ "command": "rm -rf ./dist" }));
        assert!(matches!(rm, Decision::Ask { severity: "high", .. }), "{rm:?}");
        assert_eq!(d("guardrails", "Write", serde_json::json!({ "file_path": abs("src/a.rs") })), Decision::Allow);
        assert_eq!(d("guardrails", "Edit", serde_json::json!({ "file_path": "src/a.rs" })), Decision::Allow);
        // Git configuration asks, even inside the chat's folders; YOLO still runs it.
        for f in [abs(".git/config"), ".git/hooks/pre-commit".to_string(), abs("sub/.git")] {
            let x = d("guardrails", "Write", serde_json::json!({ "file_path": f }));
            assert!(matches!(x, Decision::Ask { severity: "high", .. }), "{f}: {x:?}");
        }
        assert_eq!(d("yolo", "Write", serde_json::json!({ "file_path": abs(".git/config") })), Decision::Allow);
        let outside = d("guardrails", "Edit", serde_json::json!({ "file_path": abs("../other/a.rs") }));
        assert!(matches!(outside, Decision::Ask { severity: "high", .. }), "{outside:?}");
        assert!(asks(&d("guardrails", "WebFetch", serde_json::json!({}))));
    }

    #[test]
    fn yolo_asks_only_for_destructive_commands_and_outside_edits() {
        assert_eq!(d("yolo", "Bash", serde_json::json!({ "command": "git push origin main" })), Decision::Allow);
        assert_eq!(d("yolo", "WebFetch", serde_json::json!({})), Decision::Allow);
        assert!(asks(&d("yolo", "Bash", serde_json::json!({ "command": "rm -rf /" }))));
        assert!(asks(&d("yolo", "Write", serde_json::json!({ "file_path": abs("../../etc/x") }))));
    }

    #[test]
    fn deny_rules_block_in_every_mode() {
        for mode in ["ask", "guardrails", "yolo", "plan"] {
            let x = d(mode, "Bash", serde_json::json!({ "command": "dd if=/dev/zero of=/dev/sda" }));
            assert!(matches!(x, Decision::Deny(_)), "{mode}: {x:?}");
        }
    }

    #[test]
    fn paths_inside_the_chat_folders() {
        assert!(inside(&abs("a/b.txt"), &roots()));
        assert!(inside("a/./b.txt", &roots()));
        assert!(!inside(&abs("../repo2/x"), &roots()));
        assert!(!inside("x", &[]));
        if cfg!(windows) {
            assert!(inside(r"c:\WORK\Repo\x", &roots()));
        }
    }

    #[test]
    fn the_mcp_config_starts_the_bridge_with_its_token() {
        let cmd = BridgeCommand::electron("C:/app/Nekko.exe", "C:/app/resources/cli/nekko-agent-cli.cjs");
        let c = cmd.mcp_config("http://127.0.0.1:5000", "tok");
        let s = &c["mcpServers"][BRIDGE_SERVER];
        assert_eq!(s["command"], "C:/app/Nekko.exe");
        assert_eq!(
            s["args"],
            serde_json::json!([
                "C:/app/resources/cli/nekko-agent-cli.cjs",
                "mcp",
                "--bridge",
                "--url",
                "http://127.0.0.1:5000"
            ])
        );
        assert_eq!(s["env"]["ELECTRON_RUN_AS_NODE"], "1");
        // The token travels in the environment, never in argv.
        assert_eq!(s["env"][BRIDGE_TOKEN_ENV], "tok");
        assert!(!s["args"].as_array().unwrap().iter().any(|a| a == "tok"));
        let l = BridgeCommand::launcher("C:/bin/nekko-agent.cmd");
        if cfg!(windows) {
            assert_eq!((l.command.as_str(), l.args[0].as_str()), ("cmd", "/c"));
        }
    }

    #[test]
    fn bridges_fail_closed_and_answer_only_their_chat() {
        let h = Harness::new();
        let err = h.prepare_bridge("s1", &roots()).unwrap_err();
        assert!(err.contains("approval bridge"), "{err}");
        let dir = std::env::temp_dir().join(format!("nekko-harness-test-{}", new_token()));
        h.configure(BridgeSetup { wire_url: "http://127.0.0.1:1".into(), command: None, dir: dir.clone() });
        assert!(h.prepare_bridge("s1", &roots()).is_err(), "no CLI, no launch");

        let h = Harness::new();
        h.configure(BridgeSetup {
            wire_url: "http://127.0.0.1:1".into(),
            command: Some(BridgeCommand::launcher("/bin/nekko-agent")),
            dir: dir.clone(),
        });
        let file = h.prepare_bridge("s1", &roots()).unwrap();
        let config: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let token = config["mcpServers"][BRIDGE_SERVER]["env"][BRIDGE_TOKEN_ENV].as_str().unwrap().to_string();
        assert_eq!(h.bridge_session(&token).unwrap().session_id, "s1");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the config holds the token: owner-only");
        }
        assert!(h.bridge_session("not-a-token").is_none());
        // A relaunch replaces the token; the old one answers nothing.
        let _ = h.prepare_bridge("s1", &roots()).unwrap();
        assert!(h.bridge_session(&token).is_none());
        h.forget("s1");
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn maps_nekko_modes() {
        assert_eq!(permission_mode("ask"), PermissionMode::Default);
        assert_eq!(permission_mode("guardrails"), PermissionMode::Default);
        assert_eq!(permission_mode("yolo"), PermissionMode::AcceptEdits);
        assert_eq!(permission_mode("plan"), PermissionMode::Plan);
        assert_eq!(permission_mode("anything-new"), PermissionMode::Default);
    }

    #[test]
    fn resumes_a_stored_session_and_relaunches_on_change() {
        let w = wanted();
        let fresh = w.launch(bin(), None);
        assert!(matches!(fresh.session, SessionStart::New(_)));
        let resumed = w.launch(bin(), Some("abc"));
        assert_eq!(resumed.session, SessionStart::Resume("abc".into()));
        assert!(w.matches(&resumed));
        let mut other = w.clone();
        other.model = Some("sonnet".into());
        assert!(!other.matches(&resumed));
        other = w.clone();
        other.permission_mode = PermissionMode::AcceptEdits;
        assert!(!other.matches(&resumed));
        other = w.clone();
        other.config_dir = Some("/home/u/.claude-work".into());
        assert!(!other.matches(&resumed));
        assert_eq!(other.launch(bin(), None).config_dir, other.config_dir);
    }

    #[test]
    fn provider_account_reads_claude_code_account() {
        assert_eq!(provider_account(&serde_json::json!({ "claudeCode": { "account": "work" } })), Some("work"));
        assert_eq!(provider_account(&serde_json::json!({ "claudeCode": { "account": "" } })), None);
        assert_eq!(provider_account(&serde_json::json!({ "kind": "claude-code" })), None);
    }

    #[tokio::test]
    async fn the_idle_watch_lets_a_waiting_turn_have_the_child() {
        let h = Harness::new();
        assert_eq!(h.idle("nobody").await, Idle::Gone);
        let slot = h.slot("s1");
        // An empty slot has nothing to watch.
        assert_eq!(h.idle("s1").await, Idle::Gone);
        let held = slot.clone().lock_owned().await;
        let take = {
            let h = h.clone();
            tokio::spawn(async move { drop(h.take("s1").await) })
        };
        let want = lock(&h.slots).get("s1").unwrap().1.clone();
        while want.waiting.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(h.idle("s1").await, Idle::Yielded, "a turn is waiting");
        drop(held);
        take.await.unwrap();
        assert_eq!(want.waiting.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn reaps_idle_slots_only() {
        let h = Harness::new();
        let busy = h.slot("busy");
        let _turn = busy.lock().await;
        h.slot("empty");
        assert_eq!(h.reap(Duration::ZERO), 0);
        assert_eq!(lock(&h.slots).len(), 1, "the empty slot goes, the busy one stays");
    }
}
