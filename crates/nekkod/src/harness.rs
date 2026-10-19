//! Claude Agent chats (`ProviderKind::ClaudeCode`): the user's own Claude
//! Code runs the turn and nekkod is the cockpit around it (nekko-harness).
//!
//! - One `claude -p` child per chat, kept between turns and reaped after
//!   [`IDLE_REAP`] without one. The chat stores Claude Code's session id
//!   (`claudeCodeSessionId`), so the next turn after a reap, a crash or an app
//!   restart continues the conversation with `--resume`.
//! - A change of model, permission mode or folders relaunches the child
//!   (with `--resume`): those are launch flags.
//! - The child inherits the user's environment as it is. Nekko never reads
//!   Claude Code's credentials and never sets a token or `CLAUDE_CONFIG_DIR`.
//!
//! The turn itself (events, transcript, Stop and Steer) runs in turns.rs
//! (`claude_code_turn`) over [`nekko_harness::run_turn`].

use nekko_harness::{ClaudeBin, LaunchSpec, PermissionMode, Session, SessionStart};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

/// Every Claude Agent chat's child.
#[derive(Default)]
pub struct Harness {
    /// By Nekko chat id. The async lock is held for a whole turn, so one chat
    /// never has two turns writing to the same child.
    slots: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Slot>>>>,
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
}

impl Wanted {
    /// Whether a running child already matches.
    pub fn matches(&self, spec: &LaunchSpec) -> bool {
        spec.cwd == self.cwd
            && spec.add_dirs == self.add_dirs
            && spec.model == self.model
            && spec.permission_mode == self.permission_mode
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
        }
    }
}

impl Harness {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The chat's slot (made on first use).
    pub fn slot(&self, session_id: &str) -> Arc<tokio::sync::Mutex<Slot>> {
        lock(&self.slots).entry(session_id.to_string()).or_default().clone()
    }

    /// End a chat's child (the chat was deleted, or the daemon is stopping).
    pub async fn close(&self, session_id: &str) {
        let slot = lock(&self.slots).remove(session_id);
        if let Some(slot) = slot {
            slot.lock().await.session = None;
        }
    }

    /// End every child idle longer than `max_idle`. A slot in a turn is
    /// locked and skipped.
    pub fn reap(&self, max_idle: Duration) -> usize {
        let now = Instant::now();
        let slots: Vec<(String, Arc<tokio::sync::Mutex<Slot>>)> =
            lock(&self.slots).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut reaped = 0;
        for (id, slot) in slots {
            let Ok(mut s) = slot.try_lock() else { continue };
            let idle = s.last_used.is_none_or(|t| now.duration_since(t) >= max_idle);
            if s.session.is_some() && idle {
                s.session = None;
                reaped += 1;
            }
            if s.session.is_none() {
                drop(s);
                lock(&self.slots).remove(&id);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn wanted() -> Wanted {
        Wanted {
            cwd: "C:/w".into(),
            add_dirs: vec![],
            model: Some("opus".into()),
            permission_mode: PermissionMode::Default,
        }
    }

    fn bin() -> ClaudeBin {
        ClaudeBin { path: "claude".into(), version: "2.1.284".into() }
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
