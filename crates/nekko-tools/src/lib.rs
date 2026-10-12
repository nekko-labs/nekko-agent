//! The agent's built-in tools for the engine daemon, ported from the TS host:
//! `executeTool` (`packages/host/src/tools.ts`), the guardrail classifier
//! (`packages/core/src/guardrails`), the pending-changes store
//! (`packages/host/src/changes.ts`) and the ported tools' `BUILTIN_TOOLS`
//! specs.
//!
//! The agent loop moves to Rust next (PF14) and calls [`execute`] with a
//! [`ToolContext`] per call. Until then nothing calls this crate at run
//! time; it is held to the TS behaviour by golden files the TS code writes
//! (`tests/golden`, see `packages/host/src/agent-tools.golden.test.ts`).
//!
//! Parity is the point, so the TS semantics are ported rather than
//! approximated: JavaScript regular expressions ([`jsre`]), Node's `path`
//! module ([`path`]), Node's fs error messages and directory order, UTF-16
//! lengths and `String()` coercion of tool arguments. The few deliberate
//! differences are listed where they live (the shell runner kills whole
//! process trees and can be cancelled; strings are never cut inside a
//! surrogate pair).

mod bash;
mod changes;
mod context;
mod exec;
mod guardrails;
mod js;
pub mod jsre;
mod nodefs;
pub mod path;
pub mod process;
mod sandbox;
mod search;
mod spec;

pub use bash::{BashLimits, CommandRunner, Failure, RunOutcome, RunRequest, ShellRunner, shell};
pub use changes::{ChangeTracker, FileChange};
pub use context::{
    Approver, BoxFuture, Cancel, ChatMode, CommandLog, SandboxMode, ToolCall, ToolContext, ToolResult, Workspace,
    agent_terminal_id, approver_fn,
};
pub use exec::execute;
pub use guardrails::{
    Action, GuardrailDecision, GuardrailMatch, GuardrailRule, Severity, classify_command, default_guardrails,
};
pub use process::{Processes, describe_process};
pub use spec::{NOT_PORTED, PORTED_TOOLS, ToolSpec, builtin_tools, is_ported};
