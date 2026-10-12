//! What a tool call runs with: the call itself, the chat's policy, and the
//! hooks back into the rest of the engine (approval prompts, the agent's
//! command-log terminal, pending changes, cancellation).

use crate::bash::{BashLimits, CommandRunner, ShellRunner};
use crate::changes::ChangeTracker;
use crate::guardrails::{GuardrailRule, Severity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `ToolCall` from `@nekko-agent/shared`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The model's arguments; read field by field with JavaScript's coercions.
    #[serde(default)]
    pub input: Value,
}

/// `ToolResult` from `@nekko-agent/shared`: `isError` is left out on success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_call_id: String,
    pub output: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(call: &ToolCall, output: impl Into<String>) -> Self {
        Self { tool_call_id: call.id.clone(), output: output.into(), is_error: false }
    }

    pub fn err(call: &ToolCall, output: impl Into<String>) -> Self {
        Self { tool_call_id: call.id.clone(), output: output.into(), is_error: true }
    }
}

/// `ChatMode`: how much a chat asks before its tools act. A chat with no
/// mode behaves as `guardrails`, which is also the TS default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatMode {
    Ask,
    #[default]
    Guardrails,
    Yolo,
}

/// `settings.sandboxMode`.
///
/// `Docker` is accepted but, as in the TS host today, runs nothing in a
/// container: it behaves as `Off`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    #[default]
    WorkspaceJail,
    AskEverything,
    Docker,
    Off,
}

/// A workspace folder from settings (`WorkspaceFolder`, the fields tools use).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub path: String,
}

/// Asks the user whether a call may proceed; resolves `true` to go ahead.
/// The daemon wires this to the renderer's approval prompt.
pub trait Approver: Send + Sync {
    fn approve<'a>(&'a self, call: &'a ToolCall, reason: &'a str, severity: Severity) -> BoxFuture<'a, bool>;
}

struct FnApprover<F>(F);

impl<F, Fut> Approver for FnApprover<F>
where
    F: Fn(ToolCall, String, Severity) -> Fut + Send + Sync,
    Fut: Future<Output = bool> + Send + 'static,
{
    fn approve<'a>(&'a self, call: &'a ToolCall, reason: &'a str, severity: Severity) -> BoxFuture<'a, bool> {
        Box::pin((self.0)(call.clone(), reason.to_string(), severity))
    }
}

/// An [`Approver`] from an async closure over owned arguments.
pub fn approver_fn<F, Fut>(f: F) -> Arc<dyn Approver>
where
    F: Fn(ToolCall, String, Severity) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = bool> + Send + 'static,
{
    Arc::new(FnApprover(f))
}

/// Where the shell tool mirrors what it runs: the chat's "Agent commands"
/// terminal ([`agent_terminal_id`]). `data` is already sanitized and uses
/// `\r\n` line ends, ready for a terminal.
pub trait CommandLog: Send + Sync {
    fn append(&self, session_id: &str, workspace_id: Option<&str>, data: &str);
}

/// The id of a chat's agent command-log terminal, `agent_<sessionId>`.
pub fn agent_terminal_id(session_id: &str) -> String {
    format!("agent_{session_id}")
}

/// A cancellation signal, cloned into whatever needs to watch it.
#[derive(Clone)]
pub struct Cancel(Arc<tokio::sync::watch::Sender<bool>>);

impl Default for Cancel {
    fn default() -> Self {
        Self(Arc::new(tokio::sync::watch::channel(false).0))
    }
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    /// Resolves once [`Cancel::cancel`] has been called (at once if it has).
    pub async fn cancelled(&self) {
        let mut rx = self.0.subscribe();
        // The sender lives in `self`, so this only ends by being cancelled.
        let _ = rx.wait_for(|c| *c).await;
    }
}

/// Everything `execute` needs, the Rust side of `ToolHostOptions`.
#[derive(Clone)]
pub struct ToolContext {
    pub sandbox_mode: SandboxMode,
    /// `settings.guardrails`; `None` means the defaults, as when the setting
    /// is missing in TS.
    pub guardrails: Option<Vec<GuardrailRule>>,
    /// `settings.workspaces`, in settings order: the first is the default
    /// root for `glob`, `grep` and `bash`.
    pub workspaces: Vec<Workspace>,
    /// Relative paths resolve against this (the chat's workspace), then the
    /// first workspace, then the process directory.
    pub default_cwd: Option<String>,
    pub mode: ChatMode,
    /// The chat this call runs for: enables change tracking and the command log.
    pub session_id: Option<String>,
    pub approver: Arc<dyn Approver>,
    pub changes: Option<Arc<ChangeTracker>>,
    pub command_log: Option<Arc<dyn CommandLog>>,
    /// Runs `bash` commands; [`ShellRunner`] unless a caller substitutes one.
    pub runner: Arc<dyn CommandRunner>,
    pub limits: BashLimits,
    pub cancel: Cancel,
    /// Background processes (`start_process`, `read_process`, `kill_process`);
    /// those tools are unknown without it.
    pub processes: Option<Arc<crate::process::Processes>>,
}

impl ToolContext {
    /// A context with the TS defaults: guardrails mode, workspace jail, the
    /// default rules, no workspaces, the real shell.
    pub fn new(approver: Arc<dyn Approver>) -> Self {
        Self {
            sandbox_mode: SandboxMode::default(),
            guardrails: None,
            workspaces: Vec::new(),
            default_cwd: None,
            mode: ChatMode::default(),
            session_id: None,
            approver,
            changes: None,
            command_log: None,
            runner: Arc::new(ShellRunner),
            limits: BashLimits::default(),
            cancel: Cancel::new(),
            processes: None,
        }
    }
}
