//! The Claude Agent provider's engine: Nekko drives the user's own,
//! unmodified `claude` binary headless instead of calling a model itself.
//!
//! Anthropic's terms allow a Claude plan to power work in a third-party app
//! only through Claude Code itself, signed in through Claude Code's own
//! `/login`. So Nekko is the cockpit around Claude Code here: it starts the
//! binary, writes the user's messages to it, renders its stream, answers its
//! permission prompts (through the approval bridge nekkod serves) and keeps
//! the chat in Nekko's own transcript. Claude Code runs the loop and the tools.
//!
//! What this crate never does, by design (see the design's "Context"):
//!
//! - read, copy or store Claude Code's credentials (the config directory's
//!   credential file, the keychain). Sign-in status comes from
//!   `claude auth status` only;
//! - set `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` or
//!   `CLAUDE_CONFIG_DIR`: the child inherits the user's environment unchanged;
//! - patch or wrap the binary, or pass `--system-prompt`, `--bare`,
//!   `--dangerously-skip-permissions` or the `bypassPermissions` mode. The
//!   permission modes this crate can express ([`PermissionMode`]) leave no way
//!   to ask for them.
//!
//! - [`locate`]: find the installed `claude` and its version.
//! - [`auth_status`]: whether, and how, Claude Code is signed in.
//! - [`Session`]: one long-lived child per chat (`-p` stream-json).
//! - [`Mapper`]: Claude Code's stream-json, line by line, as Nekko's agent
//!   events and transcript messages.
//! - [`run_turn`]: one Nekko turn over a session, with Stop (the stream-json
//!   interrupt, a process-tree kill only as the fallback) and Steer
//!   (interrupt, then send).

mod auth;
mod locate;
mod map;
mod session;
mod turn;

pub use auth::{AuthStatus, auth_status, parse_auth_status};
pub use locate::{ClaudeBin, MIN_VERSION, locate, parse_version, pick_windows_candidate};
pub use map::{Init, Mapped, Mapper, Outcome, ReportedContext, StopKind, TurnEnd, USER_STOPPED, user_content};
pub use session::{
    LaunchSpec, PermissionMode, Session, SessionStart, control_error_line, interrupt_line, launch_args, new_session_id,
    user_line,
};
pub use turn::{Transport, TurnExit, TurnInput, run_turn};
