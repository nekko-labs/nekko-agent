//! The Claude policy table: which Nekko features each Claude auth gets.
//!
//! The mirror of `packages/shared/src/claude-policy.ts`, which is the source:
//! `tests/claude_policy.rs` checks this table, its reasons and the auth mapping
//! against the golden file the TS test writes
//! (`packages/host/src/claude-policy.golden.test.ts`).
//!
//! Claude on the user's own API key or cloud account keeps every feature.
//! Claude on a plan only runs through the user's own Claude Code, and some
//! features stay `awaiting_approval` there until Anthropic approves them. A
//! signed `claudePolicy` document can move rows between `enabled` and
//! `awaiting_approval` ([`apply_override`]); nothing moves an `unsupported` row,
//! and there is no end-user switch.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// How the Claude behind a provider is paid for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeAuth {
    ApiKey,
    Cloud,
    Subscription,
    /// Claude Code's auth status could not be read: treated as a plan (fail closed).
    Unknown,
}

impl ClaudeAuth {
    pub const ALL: [ClaudeAuth; 4] = [Self::ApiKey, Self::Cloud, Self::Subscription, Self::Unknown];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::Cloud => "cloud",
            Self::Subscription => "subscription",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|a| a.as_str() == s)
    }
}

/// A Nekko feature whose availability depends on how Claude is paid for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    InteractiveChat,
    PhoneRemote,
    UnattendedRuns,
    NekkoTools,
    ContextNote,
    UsageLimits,
    CostEstimate,
    ModelRouting,
}

impl Capability {
    pub const ALL: [Capability; 8] = [
        Self::InteractiveChat,
        Self::PhoneRemote,
        Self::UnattendedRuns,
        Self::NekkoTools,
        Self::ContextNote,
        Self::UsageLimits,
        Self::CostEstimate,
        Self::ModelRouting,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::InteractiveChat => "interactive_chat",
            Self::PhoneRemote => "phone_remote",
            Self::UnattendedRuns => "unattended_runs",
            Self::NekkoTools => "nekko_tools",
            Self::ContextNote => "context_note",
            Self::UsageLimits => "usage_limits",
            Self::CostEstimate => "cost_estimate",
            Self::ModelRouting => "model_routing",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == s)
    }

    /// The reason the row carries when it is `awaiting_approval`.
    pub fn awaiting_reason(self) -> ReasonId {
        match self {
            Self::UnattendedRuns => ReasonId::UnattendedNeedsApiKey,
            Self::NekkoTools => ReasonId::NekkoToolsNeedApiKey,
            Self::ContextNote => ReasonId::ContextNoteNeedsApiKey,
            Self::UsageLimits => ReasonId::UsageInClaudeCode,
            _ => ReasonId::AwaitingAnthropic,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowState {
    Enabled,
    /// Fully built and tested, off until Anthropic says yes.
    AwaitingApproval,
    /// Structurally impossible on this path; no approval turns it on.
    Unsupported,
}

/// Why a row is not enabled; [`ReasonId::reason`] is its user-facing line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasonId {
    AwaitingAnthropic,
    UnattendedNeedsApiKey,
    NekkoToolsNeedApiKey,
    ContextNoteNeedsApiKey,
    UsageInClaudeCode,
    BilledToPlan,
    ClaudeCodeOwnsLoop,
}

/// A reason's copy: what kind of limit it is, the line under a greyed
/// control, and the comparison table's cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Reason {
    pub kind: &'static str,
    pub text: &'static str,
    pub cell: &'static str,
}

impl ReasonId {
    pub const ALL: [ReasonId; 7] = [
        Self::AwaitingAnthropic,
        Self::UnattendedNeedsApiKey,
        Self::NekkoToolsNeedApiKey,
        Self::ContextNoteNeedsApiKey,
        Self::UsageInClaudeCode,
        Self::BilledToPlan,
        Self::ClaudeCodeOwnsLoop,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingAnthropic => "awaiting_anthropic",
            Self::UnattendedNeedsApiKey => "unattended_needs_api_key",
            Self::NekkoToolsNeedApiKey => "nekko_tools_need_api_key",
            Self::ContextNoteNeedsApiKey => "context_note_needs_api_key",
            Self::UsageInClaudeCode => "usage_in_claude_code",
            Self::BilledToPlan => "billed_to_plan",
            Self::ClaudeCodeOwnsLoop => "claude_code_owns_loop",
        }
    }

    pub fn reason(self) -> Reason {
        let (kind, text, cell) = match self {
            Self::AwaitingAnthropic => (
                "awaiting_anthropic",
                "Off with a Claude plan for now: the terms don't clearly cover it for third-party apps.",
                "Not yet",
            ),
            Self::UnattendedNeedsApiKey => {
                ("awaiting_anthropic", "Scheduled runs need Claude with an API key.", "Not yet")
            }
            Self::NekkoToolsNeedApiKey => {
                ("awaiting_anthropic", "Nekko tools inside a Claude chat need Claude with an API key.", "Not yet")
            }
            Self::ContextNoteNeedsApiKey => (
                "awaiting_anthropic",
                "Nekko's workspace note for Claude Code needs Claude with an API key.",
                "Not yet",
            ),
            Self::UsageInClaudeCode => {
                ("awaiting_anthropic", "Check your plan's usage in Claude Code.", "No, check in Claude Code")
            }
            Self::BilledToPlan => {
                ("billing", "Billed to your Claude plan, so Nekko shows tokens, not a cost.", "No, billed to your plan")
            }
            Self::ClaudeCodeOwnsLoop => ("structural", "Claude Code runs this chat's model choices.", "No"),
        };
        Reason { kind, text, cell }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub state: RowState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ReasonId>,
}

impl Row {
    pub const ENABLED: Row = Row { state: RowState::Enabled, reason: None };

    pub fn awaiting(cap: Capability) -> Row {
        Row { state: RowState::AwaitingApproval, reason: Some(cap.awaiting_reason()) }
    }

    pub fn enabled(&self) -> bool {
        self.state == RowState::Enabled
    }

    /// The user-facing line for a row that is not enabled.
    pub fn reason_text(&self) -> Option<&'static str> {
        (!self.enabled()).then(|| self.reason.unwrap_or(ReasonId::AwaitingAnthropic).reason().text)
    }
}

/// The table: one row per auth and capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Policy(pub BTreeMap<ClaudeAuth, BTreeMap<Capability, Row>>);

impl Policy {
    /// The shipped table. `api_key` and `cloud` keep every feature;
    /// `subscription` has the four approval-gated features off; `unknown` is
    /// the same as `subscription`.
    pub fn shipped() -> Policy {
        let all_on: BTreeMap<_, _> = Capability::ALL.into_iter().map(|c| (c, Row::ENABLED)).collect();
        let plan: BTreeMap<_, _> = Capability::ALL
            .into_iter()
            .map(|c| {
                let row = match c {
                    Capability::InteractiveChat | Capability::PhoneRemote => Row::ENABLED,
                    Capability::UnattendedRuns
                    | Capability::NekkoTools
                    | Capability::ContextNote
                    | Capability::UsageLimits => Row::awaiting(c),
                    Capability::CostEstimate => {
                        Row { state: RowState::Unsupported, reason: Some(ReasonId::BilledToPlan) }
                    }
                    Capability::ModelRouting => {
                        Row { state: RowState::Unsupported, reason: Some(ReasonId::ClaudeCodeOwnsLoop) }
                    }
                };
                (c, row)
            })
            .collect();
        Policy(BTreeMap::from([
            (ClaudeAuth::ApiKey, all_on.clone()),
            (ClaudeAuth::Cloud, all_on),
            (ClaudeAuth::Subscription, plan.clone()),
            (ClaudeAuth::Unknown, plan),
        ]))
    }

    pub fn row(&self, auth: ClaudeAuth, cap: Capability) -> Row {
        // Every row exists by construction; a missing one fails closed.
        self.0.get(&auth).and_then(|r| r.get(&cap)).copied().unwrap_or(Row::awaiting(cap))
    }

    fn set(&mut self, auth: ClaudeAuth, cap: Capability, row: Row) {
        self.0.entry(auth).or_default().insert(cap, row);
    }
}

/// Which engine runs a Claude turn: Nekko's own loop, or the user's Claude Code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Nekko,
    ClaudeCode,
}

/// The provider kind of the Claude Code harness ("Claude Agent").
pub const CLAUDE_CODE_KIND: &str = "claude-code";

/// Provider kinds that run Claude on the user's own cloud account.
pub const CLOUD_KINDS: [&str; 3] = ["bedrock", "vertex", "foundry"];

impl Engine {
    pub fn for_kind(kind: &str) -> Engine {
        if kind == CLAUDE_CODE_KIND { Engine::ClaudeCode } else { Engine::Nekko }
    }
}

/// What a Claude Code turn cannot do on any auth, because Claude Code runs its own loop.
pub fn claude_code_unsupported(cap: Capability) -> Option<ReasonId> {
    (cap == Capability::ModelRouting).then_some(ReasonId::ClaudeCodeOwnsLoop)
}

/// One capability's row for an auth on an engine.
pub fn capability(policy: &Policy, auth: ClaudeAuth, cap: Capability, engine: Engine) -> Row {
    if engine == Engine::ClaudeCode
        && let Some(reason) = claude_code_unsupported(cap)
    {
        return Row { state: RowState::Unsupported, reason: Some(reason) };
    }
    policy.row(auth, cap)
}

const API_KEY_METHODS: [&str; 4] = ["api_key", "apikey", "api_key_helper", "apikeyhelper"];
const PLAN_METHODS: [&str; 6] = ["claude.ai", "claude_ai", "claudeai", "oauth", "oauth_token", "subscription"];

/// Map `claude auth status --json`. Signed out, unreadable or unrecognized is `Unknown`.
pub fn auth_from_status(status: Option<&Value>) -> ClaudeAuth {
    let Some(status) = status.filter(|s| s.is_object()) else { return ClaudeAuth::Unknown };
    if status.get("loggedIn") == Some(&Value::Bool(false)) {
        return ClaudeAuth::Unknown;
    }
    let field = |k: &str| status.get(k).and_then(Value::as_str).unwrap_or_default().to_lowercase();
    let (provider, method) = (field("apiProvider"), field("authMethod"));
    if CLOUD_KINDS.contains(&provider.as_str()) || CLOUD_KINDS.contains(&method.as_str()) {
        ClaudeAuth::Cloud
    } else if API_KEY_METHODS.contains(&method.as_str()) {
        ClaudeAuth::ApiKey
    } else if PLAN_METHODS.contains(&method.as_str()) {
        ClaudeAuth::Subscription
    } else {
        ClaudeAuth::Unknown
    }
}

/// How the Claude behind `provider` (a settings provider entry) is paid for,
/// or `None` when it is not a Claude provider. `status` is Claude Code's last
/// `claude auth status`, for a harness provider whose auth Nekko did not set.
pub fn auth_for(provider: &Value, status: Option<&Value>) -> Option<ClaudeAuth> {
    let kind = provider.get("kind").and_then(Value::as_str).unwrap_or_default();
    if kind == "anthropic" {
        let sub = provider.get("auth").and_then(Value::as_str) == Some("subscription");
        return Some(if sub { ClaudeAuth::Subscription } else { ClaudeAuth::ApiKey });
    }
    if CLOUD_KINDS.contains(&kind) {
        return Some(ClaudeAuth::Cloud);
    }
    if kind != CLAUDE_CODE_KIND {
        return None;
    }
    let source = provider.pointer("/claudeCode/authSource").and_then(Value::as_str).unwrap_or_default();
    if source == "nekko-anthropic-key" {
        return Some(ClaudeAuth::ApiKey);
    }
    if CLOUD_KINDS.contains(&source) {
        return Some(ClaudeAuth::Cloud);
    }
    Some(auth_from_status(status))
}

/// Apply a verified override's `rows` (`{ auth: { capability: state } }`) to
/// `base`. All or nothing: an unknown auth, capability or state, a move into
/// or out of `unsupported`, or turning an `unknown` row on (it stays fail
/// closed) rejects the whole override.
pub fn apply_override(base: &Policy, rows: &Value) -> Result<Policy, String> {
    let rows = rows.as_object().ok_or("rows must be an object")?;
    let mut next = base.clone();
    for (auth_name, caps) in rows {
        let auth = ClaudeAuth::parse(auth_name).ok_or_else(|| format!("unknown auth {auth_name}"))?;
        let caps = caps.as_object().ok_or_else(|| format!("rows.{auth_name} must be an object"))?;
        for (cap_name, state) in caps {
            let cap = Capability::parse(cap_name).ok_or_else(|| format!("unknown capability {cap_name}"))?;
            let state: RowState =
                serde_json::from_value(state.clone()).map_err(|_| format!("bad state for {auth_name}.{cap_name}"))?;
            if base.row(auth, cap).state == RowState::Unsupported {
                return Err(format!("{auth_name}.{cap_name} is unsupported and cannot be changed"));
            }
            let row = match state {
                RowState::Enabled if auth == ClaudeAuth::Unknown => {
                    return Err(format!("{auth_name}.{cap_name} stays off: an unknown auth fails closed"));
                }
                RowState::Enabled => Row::ENABLED,
                RowState::AwaitingApproval => Row::awaiting(cap),
                RowState::Unsupported => return Err(format!("{auth_name}.{cap_name} cannot be made unsupported")),
            };
            next.set(auth, cap, row);
        }
    }
    Ok(next)
}

/// The dev-only policy preview: `auth`'s `awaiting_approval` rows render as
/// enabled. `unsupported` rows stay as they are.
pub fn preview(policy: &Policy, auth: ClaudeAuth) -> Policy {
    let mut next = policy.clone();
    for cap in Capability::ALL {
        if policy.row(auth, cap).state == RowState::AwaitingApproval {
            next.set(auth, cap, Row::ENABLED);
        }
    }
    next
}

/// Every reason's copy, keyed by id (what the golden file holds).
pub fn reasons_json() -> Value {
    Value::Object(ReasonId::ALL.into_iter().map(|r| (r.as_str().to_string(), json!(r.reason()))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fails_closed() {
        let p = Policy::shipped();
        assert_eq!(p.0[&ClaudeAuth::Unknown], p.0[&ClaudeAuth::Subscription]);
        assert!(!p.row(ClaudeAuth::Unknown, Capability::UnattendedRuns).enabled());
    }

    #[test]
    fn override_moves_only_between_enabled_and_awaiting() {
        let base = Policy::shipped();
        let on = apply_override(&base, &json!({ "subscription": { "unattended_runs": "enabled" } })).unwrap();
        assert!(on.row(ClaudeAuth::Subscription, Capability::UnattendedRuns).enabled());
        let off = apply_override(&base, &json!({ "api_key": { "nekko_tools": "awaiting_approval" } })).unwrap();
        assert_eq!(off.row(ClaudeAuth::ApiKey, Capability::NekkoTools), Row::awaiting(Capability::NekkoTools));
        for bad in [
            json!({ "subscription": { "model_routing": "enabled" } }),
            json!({ "subscription": { "cost_estimate": "awaiting_approval" } }),
            json!({ "api_key": { "nekko_tools": "unsupported" } }),
            json!({ "unknown": { "unattended_runs": "enabled" } }),
            json!({ "everyone": { "unattended_runs": "enabled" } }),
            json!({ "subscription": { "teleport": "enabled" } }),
            json!({ "subscription": { "unattended_runs": "on" } }),
            json!([]),
        ] {
            assert!(apply_override(&base, &bad).is_err(), "{bad}");
        }
        // All or nothing: one bad row rejects the good ones beside it.
        let mixed = json!({ "subscription": { "unattended_runs": "enabled", "model_routing": "enabled" } });
        assert!(apply_override(&base, &mixed).is_err());
    }

    #[test]
    fn preview_enables_awaiting_rows_only() {
        let p = preview(&Policy::shipped(), ClaudeAuth::Subscription);
        for cap in
            [Capability::UnattendedRuns, Capability::NekkoTools, Capability::ContextNote, Capability::UsageLimits]
        {
            assert!(p.row(ClaudeAuth::Subscription, cap).enabled());
        }
        assert_eq!(p.row(ClaudeAuth::Subscription, Capability::ModelRouting).state, RowState::Unsupported);
        assert!(!p.row(ClaudeAuth::Unknown, Capability::UnattendedRuns).enabled());
    }

    #[test]
    fn claude_code_never_routes() {
        let p = Policy::shipped();
        assert_eq!(
            capability(&p, ClaudeAuth::ApiKey, Capability::ModelRouting, Engine::ClaudeCode).state,
            RowState::Unsupported
        );
        assert!(capability(&p, ClaudeAuth::ApiKey, Capability::ModelRouting, Engine::Nekko).enabled());
    }
}
