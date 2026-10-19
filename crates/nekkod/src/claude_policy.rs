//! The Claude policy nekkod enforces: the shipped table
//! (`nekko_agent::claude_policy`), plus a signed `claudePolicy` override, plus
//! the dev-only preview, and the gate points the Claude paths call.
//!
//! **Signed override.** A release can carry `claude-policy.json` beside its
//! update feed file (native.rs fetches it on each update check):
//!
//! ```json
//! { "payload": "<base64 of the JSON below>", "signature": "<base64 Ed25519 signature of those bytes>" }
//! { "type": "nekko.claudePolicy", "version": 1, "serial": 3, "issuedAt": "2026-11-02T00:00:00Z",
//!   "rows": { "subscription": { "unattended_runs": "enabled" } } }
//! ```
//!
//! It is verified against [`RELEASE_POLICY_KEY`], may only move rows between
//! `enabled` and `awaiting_approval` (`apply_override`), must carry a higher
//! serial than the one applied before (no rollback to an older document), and
//! is kept in the data directory so it survives restarts. This is how a row
//! turns on after Anthropic approves it without a release, and how one turns
//! off within hours if they ask. There is no end-user switch anywhere.
//!
//! **Preview.** `NEKKO_CLAUDE_POLICY_PREVIEW=subscription` renders the plan's
//! approval-gated rows as enabled, for recording what we would turn on. It
//! exists only in builds with the `dev-tools` feature (`npm run dev`'s daemon;
//! never the release build `stage-daemon.mjs` packages) and never in a
//! packaged app.

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use nekko_agent::claude_policy::{self as policy, Capability, ClaudeAuth, Engine, Policy};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

/// The release's file name beside its update feed, and the cached copy in the data directory.
pub const FEED_FILE: &str = "claude-policy.json";

/// The Ed25519 public key `claudePolicy` documents are signed with.
///
/// TODO(Philip): replace with the release signing key's public half before
/// any signed policy ships. Nekko has no release signing key yet (the update
/// feed is checked by SHA-512 and, on Windows, Authenticode only). While this
/// is all zeros, every signed override is refused, so the shipped table is the
/// whole policy.
pub const RELEASE_POLICY_KEY: [u8; 32] = [0; 32];

const DOC_TYPE: &str = "nekko.claudePolicy";
const DOC_VERSION: u64 = 1;

/// Why a gate refused: the reason's id and its user-facing line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub capability: Capability,
    pub reason: policy::ReasonId,
    pub message: &'static str,
}

/// A plan usage read for the Claude Agent limits UI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanUsage {
    /// Nothing to show; the row's reason says why.
    Unavailable(&'static str),
    /// The dev-only preview: the UI renders `claudePlanUsageExample()`,
    /// labelled "Example data". Never real data.
    Example,
}

#[derive(Clone, Debug)]
struct Applied {
    serial: u64,
    issued_at: String,
    rows: Value,
}

struct State {
    effective: Policy,
    applied: Option<Applied>,
}

pub struct ClaudePolicyStore {
    key: [u8; 32],
    cache: Option<PathBuf>,
    preview: Option<ClaudeAuth>,
    state: RwLock<State>,
    /// Each Claude Code harness provider's last `claude auth status --json`, by provider id.
    auth_status: Mutex<HashMap<String, Value>>,
}

impl ClaudePolicyStore {
    /// The daemon's store: the release key, the cached override in `data_dir`,
    /// and the preview when this build and launch allow it.
    pub fn new(data_dir: Option<PathBuf>, is_packaged: bool) -> Self {
        Self::with_key(RELEASE_POLICY_KEY, data_dir.map(|d| d.join(FEED_FILE)), preview_from_env(is_packaged))
    }

    pub fn with_key(key: [u8; 32], cache: Option<PathBuf>, preview: Option<ClaudeAuth>) -> Self {
        let store = Self {
            key,
            cache,
            preview,
            state: RwLock::new(State { effective: Policy::shipped(), applied: None }),
            auth_status: Mutex::new(HashMap::new()),
        };
        store.recompute(None);
        if let Some(doc) = store.cache.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) {
            match serde_json::from_str::<Value>(&doc).map_err(|e| e.to_string()).and_then(|d| store.verify(&d)) {
                Ok(applied) => store.recompute(Some(applied)),
                Err(e) => eprintln!("nekkod: cached claude policy ignored: {e}"),
            }
        }
        store
    }

    fn recompute(&self, applied: Option<Applied>) {
        let base = Policy::shipped();
        let overridden = match &applied {
            // Verified before it got here; a failure keeps the shipped table.
            Some(a) => policy::apply_override(&base, &a.rows).unwrap_or(base),
            None => base,
        };
        let effective = match self.preview {
            Some(auth) => policy::preview(&overridden, auth),
            None => overridden,
        };
        let mut st = self.state.write().unwrap_or_else(|e| e.into_inner());
        st.effective = effective;
        st.applied = applied;
    }

    /// Check a signed document: key, signature, type, version and rows.
    fn verify(&self, doc: &Value) -> Result<Applied, String> {
        if self.key == [0; 32] {
            return Err("no Claude policy signing key is configured".into());
        }
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload = doc.get("payload").and_then(Value::as_str).ok_or("missing payload")?;
        let signature = doc.get("signature").and_then(Value::as_str).ok_or("missing signature")?;
        let payload = b64.decode(payload).map_err(|_| "payload is not base64")?;
        let signature: [u8; 64] = b64
            .decode(signature)
            .map_err(|_| "signature is not base64")?
            .try_into()
            .map_err(|_| "signature is not 64 bytes")?;
        let key = VerifyingKey::from_bytes(&self.key).map_err(|_| "the signing key is invalid")?;
        key.verify_strict(&payload, &Signature::from_bytes(&signature)).map_err(|_| "bad signature")?;
        let body: Value = serde_json::from_slice(&payload).map_err(|_| "payload is not JSON")?;
        if body.get("type").and_then(Value::as_str) != Some(DOC_TYPE) {
            return Err("not a claudePolicy document".into());
        }
        if body.get("version").and_then(Value::as_u64) != Some(DOC_VERSION) {
            return Err("unsupported claudePolicy version".into());
        }
        let serial = body.get("serial").and_then(Value::as_u64).ok_or("missing serial")?;
        let rows = body.get("rows").cloned().ok_or("missing rows")?;
        policy::apply_override(&Policy::shipped(), &rows)?;
        let issued_at = body.get("issuedAt").and_then(Value::as_str).unwrap_or_default().to_string();
        Ok(Applied { serial, issued_at, rows })
    }

    /// Verify and apply a signed `claudePolicy` document, and keep it for the
    /// next start. Refuses one whose serial is not above the applied one's.
    pub fn apply_signed(&self, doc: &Value) -> Result<(), String> {
        let applied = self.verify(doc)?;
        let current = self.state.read().unwrap_or_else(|e| e.into_inner()).applied.clone();
        if let Some(cur) = current {
            if applied.serial == cur.serial && applied.rows == cur.rows {
                return Ok(());
            }
            if applied.serial <= cur.serial {
                return Err(format!("serial {} is not newer than the applied {}", applied.serial, cur.serial));
            }
        }
        if let Some(path) = &self.cache {
            let text = serde_json::to_string(doc).map_err(|e| e.to_string())?;
            std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        self.recompute(Some(applied));
        Ok(())
    }

    /// The effective table.
    pub fn policy(&self) -> Policy {
        self.state.read().unwrap_or_else(|e| e.into_inner()).effective.clone()
    }

    /// `claude:policy`: the effective table, where it came from, and every
    /// reason's copy, so the renderer shows exactly what is enforced.
    pub fn status(&self) -> Value {
        let st = self.state.read().unwrap_or_else(|e| e.into_inner());
        json!({
            "policy": st.effective,
            "override": st.applied.as_ref().map(|a| json!({ "serial": a.serial, "issuedAt": a.issued_at })),
            "preview": self.preview.map(ClaudeAuth::as_str),
        })
    }

    /// Record a harness provider's `claude auth status --json`; its
    /// `authMethod` picks the row its next turns get. The harness calls this
    /// before each session launch and when the app regains focus.
    pub fn note_auth_status(&self, provider_id: &str, status: Value) {
        self.auth_status.lock().unwrap_or_else(|e| e.into_inner()).insert(provider_id.to_string(), status);
    }

    /// Whether a status has been recorded for `provider_id`.
    pub fn has_auth_status(&self, provider_id: &str) -> bool {
        self.auth_status.lock().unwrap_or_else(|e| e.into_inner()).contains_key(provider_id)
    }

    /// How the Claude behind `provider` is paid for; `None` for a non-Claude provider.
    pub fn auth_for(&self, provider: &Value) -> Option<ClaudeAuth> {
        let id = provider.get("id").and_then(Value::as_str).unwrap_or_default();
        let statuses = self.auth_status.lock().unwrap_or_else(|e| e.into_inner());
        policy::auth_for(provider, statuses.get(id))
    }

    /// Whether `provider` may use `cap`. A non-Claude provider always may.
    pub fn gate(&self, provider: &Value, cap: Capability) -> Result<(), Refusal> {
        let Some(auth) = self.auth_for(provider) else { return Ok(()) };
        let kind = provider.get("kind").and_then(Value::as_str).unwrap_or_default();
        let row = policy::capability(&self.policy(), auth, cap, Engine::for_kind(kind));
        if row.enabled() {
            return Ok(());
        }
        let reason = row.reason.unwrap_or_else(|| cap.awaiting_reason());
        Err(Refusal { capability: cap, reason, message: reason.reason().text })
    }

    /// The admission gate for a turn nobody is watching start (a scheduled
    /// task, a workflow or goal step, an agent watch, auto-continue: their
    /// `chat:send` carries `unattended: true`). Refuses a Claude Code harness
    /// turn when `unattended_runs` is off for its auth. Nekko-engine Claude
    /// providers are not gated here: on an API key or cloud the row is
    /// enabled, and the old subscription path is being removed (H6).
    pub fn gate_turn(&self, provider: &Value, opts: &Value) -> Result<(), Refusal> {
        let kind = provider.get("kind").and_then(Value::as_str).unwrap_or_default();
        if kind != policy::CLAUDE_CODE_KIND || !is_unattended(opts) {
            return Ok(());
        }
        self.gate(provider, Capability::UnattendedRuns)
    }

    /// Whether a harness session may offer Nekko's MCP tools (`--mcp-config`).
    #[allow(dead_code)] // the harness's --mcp-config (H3) calls it
    pub fn allows_nekko_tools(&self, provider: &Value) -> Result<(), Refusal> {
        self.gate(provider, Capability::NekkoTools)
    }

    /// Whether a harness session may pass Nekko's context note (`--append-system-prompt`).
    #[allow(dead_code)] // the harness's launch (H2) calls it
    pub fn allows_context_note(&self, provider: &Value) -> Result<(), Refusal> {
        self.gate(provider, Capability::ContextNote)
    }

    /// Plan usage for a Claude provider's limits UI. There is no sanctioned
    /// source of Claude plan usage, so even with `usage_limits` enabled this
    /// returns nothing until Anthropic names one; the preview shows example data.
    pub fn plan_usage(&self, provider: &Value) -> PlanUsage {
        if let Err(r) = self.gate(provider, Capability::UsageLimits) {
            return PlanUsage::Unavailable(r.message);
        }
        if self.preview.is_some() && self.auth_for(provider) == self.preview {
            return PlanUsage::Example;
        }
        PlanUsage::Unavailable("No plan usage source is available yet.")
    }
}

/// The settings provider `id`.
/// `claude:codeStatus(providerId?)`: whether the user's own Claude Code is
/// installed and how it is signed in, for the Claude Agent setup states. It
/// runs `claude --version` and `claude auth status`, never reads Claude Code's
/// credentials, and records the status for `providerId` so the policy rows its
/// turns get match what the user sees.
pub async fn code_status_route(ctx: &crate::routes::Ctx, args: &[Value]) -> Result<Value, String> {
    let provider_id = args.first().and_then(Value::as_str).filter(|id| !id.is_empty());
    let bin = match nekko_harness::locate(None).await {
        Ok(bin) => bin,
        Err(message) => return Ok(json!({ "installed": false, "message": message })),
    };
    match nekko_harness::auth_status(&bin).await {
        Ok(s) => {
            let status = json!({ "loggedIn": s.logged_in, "authMethod": s.auth_method, "apiProvider": s.api_provider });
            if let Some(id) = provider_id {
                ctx.claude_policy.note_auth_status(id, status.clone());
            }
            let auth = if s.logged_in { policy::auth_from_status(Some(&status)) } else { ClaudeAuth::Unknown };
            Ok(json!({
                "installed": true,
                "version": bin.version,
                "loggedIn": s.logged_in,
                "authMethod": s.auth_method,
                "apiProvider": s.api_provider,
                "auth": auth.as_str(),
            }))
        }
        Err(message) => Ok(json!({ "installed": true, "version": bin.version, "loggedIn": false, "message": message })),
    }
}

/// Read Claude Code's auth status for a Claude Agent provider that has none
/// recorded yet, so its first turn gets the right rows rather than `unknown`.
/// Any failure leaves it unrecorded, which fails closed.
pub async fn ensure_auth_status(ctx: &crate::routes::Ctx, provider: &Value) {
    let id = provider.get("id").and_then(Value::as_str).unwrap_or_default();
    if provider.get("kind").and_then(Value::as_str) != Some(policy::CLAUDE_CODE_KIND)
        || ctx.claude_policy.has_auth_status(id)
    {
        return;
    }
    let _ = code_status_route(ctx, &[json!(id)]).await;
}

async fn provider(ctx: &crate::routes::Ctx, id: &str) -> Result<Value, String> {
    let settings = crate::settings::current(ctx).await;
    settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id)).cloned())
        .ok_or_else(|| "Provider not found.".into())
}

/// `claude:capability(providerId, capability)`: the row a provider gets, with
/// its reason's id and line, for a greyed control and its "Why?" link.
/// `{ claude: false }` for a provider that is not Claude.
pub async fn capability_route(ctx: &crate::routes::Ctx, args: &[Value]) -> Result<Value, String> {
    let id = args.first().and_then(Value::as_str).ok_or("claude:capability needs a provider id")?;
    let cap = args.get(1).and_then(Value::as_str).and_then(Capability::parse).ok_or("unknown capability")?;
    let provider = provider(ctx, id).await?;
    let store = &ctx.claude_policy;
    let Some(auth) = store.auth_for(&provider) else { return Ok(json!({ "claude": false })) };
    let kind = provider.get("kind").and_then(Value::as_str).unwrap_or_default();
    let row = policy::capability(&store.policy(), auth, cap, Engine::for_kind(kind));
    Ok(json!({
        "claude": true,
        "auth": auth.as_str(),
        "state": row.state,
        "reason": row.reason,
        "message": row.reason_text(),
    }))
}

/// `claude:planUsage(providerId)`: `{ source: "none", message }`, or in the
/// dev-only preview `{ source: "example", label: "Example data" }` (the UI
/// renders `claudePlanUsageExample()`).
pub async fn plan_usage_route(ctx: &crate::routes::Ctx, args: &[Value]) -> Result<Value, String> {
    let id = args.first().and_then(Value::as_str).ok_or("claude:planUsage needs a provider id")?;
    let provider = provider(ctx, id).await?;
    Ok(match ctx.claude_policy.plan_usage(&provider) {
        PlanUsage::Unavailable(message) => json!({ "source": "none", "message": message }),
        PlanUsage::Example => json!({ "source": "example", "label": "Example data" }),
    })
}

/// Whether a `chat:send` was started by automation rather than a person.
pub fn is_unattended(opts: &Value) -> bool {
    opts.get("unattended").and_then(Value::as_bool) == Some(true)
}

/// Mark a `chat:send` as unattended.
pub fn mark_unattended(mut opts: Value) -> Value {
    if let Some(o) = opts.as_object_mut() {
        o.insert("unattended".into(), Value::Bool(true));
    }
    opts
}

/// `NEKKO_CLAUDE_POLICY_PREVIEW`, in a `dev-tools` build of an unpackaged app only.
#[cfg(any(test, feature = "dev-tools"))]
fn preview_from_env(is_packaged: bool) -> Option<ClaudeAuth> {
    if is_packaged {
        return None;
    }
    let value = std::env::var("NEKKO_CLAUDE_POLICY_PREVIEW").ok()?;
    let auth = ClaudeAuth::parse(value.trim()).filter(|a| *a == ClaudeAuth::Subscription);
    if auth.is_some() {
        eprintln!("nekkod: Claude policy preview on: subscription rows render as enabled (dev build only)");
    }
    auth
}

#[cfg(not(any(test, feature = "dev-tools")))]
fn preview_from_env(_is_packaged: bool) -> Option<ClaudeAuth> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const SEED: [u8; 32] = [7; 32];

    fn key() -> [u8; 32] {
        SigningKey::from_bytes(&SEED).verifying_key().to_bytes()
    }

    fn sign_with(seed: [u8; 32], body: &Value) -> Value {
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload = serde_json::to_vec(body).unwrap();
        let sig = SigningKey::from_bytes(&seed).sign(&payload);
        json!({ "payload": b64.encode(&payload), "signature": b64.encode(sig.to_bytes()) })
    }

    fn signed(serial: u64, rows: Value) -> Value {
        sign_with(
            SEED,
            &json!({ "type": DOC_TYPE, "version": 1, "serial": serial, "issuedAt": "2026-11-01T00:00:00Z", "rows": rows }),
        )
    }

    fn harness(source: Option<&str>) -> Value {
        match source {
            Some(s) => json!({ "id": "cc", "kind": "claude-code", "claudeCode": { "authSource": s } }),
            None => json!({ "id": "cc", "kind": "claude-code" }),
        }
    }

    const ALL_GATED: [Capability; 4] =
        [Capability::UnattendedRuns, Capability::NekkoTools, Capability::ContextNote, Capability::UsageLimits];

    fn store(preview: Option<ClaudeAuth>) -> ClaudePolicyStore {
        ClaudePolicyStore::with_key(key(), None, preview)
    }

    fn on_plan(s: &ClaudePolicyStore) -> Value {
        s.note_auth_status("cc", json!({ "loggedIn": true, "authMethod": "claude.ai" }));
        harness(Some("cli"))
    }

    #[test]
    fn every_gate_is_off_for_a_plan_and_on_for_an_api_key() {
        let s = store(None);
        let plan = on_plan(&s);
        for cap in ALL_GATED {
            let refusal = s.gate(&plan, cap).unwrap_err();
            assert_eq!(refusal.message, cap.awaiting_reason().reason().text);
            assert!(s.gate(&harness(Some("nekko-anthropic-key")), cap).is_ok());
            assert!(s.gate(&harness(Some("vertex")), cap).is_ok());
        }
        assert!(s.allows_nekko_tools(&plan).is_err());
        assert!(s.allows_context_note(&plan).is_err());
        assert_eq!(s.plan_usage(&plan), PlanUsage::Unavailable("Check your plan's usage in Claude Code."));
        // Interactive chat and the phone stay on.
        assert!(s.gate(&plan, Capability::InteractiveChat).is_ok());
        assert!(s.gate(&plan, Capability::PhoneRemote).is_ok());
    }

    #[test]
    fn every_gate_turns_on_with_a_signed_override() {
        let s = store(None);
        let plan = on_plan(&s);
        let rows = json!({ "subscription": {
            "unattended_runs": "enabled", "nekko_tools": "enabled", "context_note": "enabled", "usage_limits": "enabled"
        } });
        s.apply_signed(&signed(1, rows)).unwrap();
        for cap in ALL_GATED {
            assert!(s.gate(&plan, cap).is_ok(), "{cap:?}");
        }
        assert!(s.gate_turn(&plan, &json!({ "unattended": true })).is_ok());
        // Usage is allowed, but there is still no sanctioned source.
        assert_eq!(s.plan_usage(&plan), PlanUsage::Unavailable("No plan usage source is available yet."));
        assert_eq!(s.status()["override"], json!({ "serial": 1, "issuedAt": "2026-11-01T00:00:00Z" }));
        // And off again with a newer one.
        s.apply_signed(&signed(2, json!({ "subscription": { "nekko_tools": "awaiting_approval" } }))).unwrap();
        assert!(s.allows_nekko_tools(&plan).is_err());
        assert!(s.gate(&plan, Capability::UnattendedRuns).is_err(), "a new document replaces the old one whole");
    }

    #[test]
    fn unattended_harness_turns_are_refused_on_a_plan() {
        let s = store(None);
        let plan = on_plan(&s);
        let refusal = s.gate_turn(&plan, &mark_unattended(json!({ "sessionId": "x" }))).unwrap_err();
        assert_eq!(refusal.message, "Scheduled runs need Claude with an API key.");
        // A person's own message is never gated, nor a Nekko-engine provider.
        assert!(s.gate_turn(&plan, &json!({ "sessionId": "x" })).is_ok());
        assert!(s.gate_turn(&json!({ "id": "a", "kind": "anthropic" }), &json!({ "unattended": true })).is_ok());
        assert!(s.gate_turn(&json!({ "id": "o", "kind": "openai" }), &json!({ "unattended": true })).is_ok());
        // An API key in Claude Code runs unattended.
        assert!(s.gate_turn(&harness(Some("nekko-anthropic-key")), &json!({ "unattended": true })).is_ok());
    }

    #[test]
    fn unknown_auth_fails_closed() {
        let s = store(None);
        // No status recorded yet.
        assert!(s.gate_turn(&harness(Some("cli")), &json!({ "unattended": true })).is_err());
        s.note_auth_status("cc", json!({ "loggedIn": false, "authMethod": "none" }));
        assert!(s.gate(&harness(None), Capability::NekkoTools).is_err());
        s.note_auth_status("cc", json!({ "loggedIn": true, "authMethod": "api_key" }));
        assert!(s.gate(&harness(None), Capability::NekkoTools).is_ok());
    }

    #[test]
    fn refuses_bad_documents() {
        let s = store(None);
        let rows = json!({ "subscription": { "unattended_runs": "enabled" } });
        let mut tampered = signed(1, rows.clone());
        let other = signed(1, json!({ "subscription": { "nekko_tools": "enabled" } }));
        tampered["payload"] = other["payload"].clone();
        let foreign = sign_with([9; 32], &json!({ "type": DOC_TYPE, "version": 1, "serial": 1, "rows": rows }));
        let wrong_type = sign_with(SEED, &json!({ "type": "other", "version": 1, "serial": 1, "rows": rows }));
        let unsupported = signed(1, json!({ "subscription": { "model_routing": "enabled" } }));
        for doc in [tampered, foreign, wrong_type, unsupported, json!({}), json!({ "payload": "!!", "signature": "" })]
        {
            assert!(s.apply_signed(&doc).is_err(), "{doc}");
        }
        assert!(s.status()["override"].is_null());
        // No rollback to an older serial.
        s.apply_signed(&signed(5, rows.clone())).unwrap();
        assert!(s.apply_signed(&signed(4, json!({}))).is_err());
        assert!(s.apply_signed(&signed(5, rows)).is_ok(), "the same document again is a no-op");
    }

    #[test]
    fn the_placeholder_key_refuses_every_override() {
        let s = ClaudePolicyStore::with_key(RELEASE_POLICY_KEY, None, None);
        let err = s.apply_signed(&signed(1, json!({ "subscription": { "unattended_runs": "enabled" } }))).unwrap_err();
        assert!(err.contains("no Claude policy signing key"));
    }

    #[test]
    fn an_applied_override_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("nekkod-claude-policy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FEED_FILE);
        let s = ClaudePolicyStore::with_key(key(), Some(path.clone()), None);
        s.apply_signed(&signed(3, json!({ "subscription": { "context_note": "enabled" } }))).unwrap();
        let again = ClaudePolicyStore::with_key(key(), Some(path.clone()), None);
        assert!(again.policy().row(ClaudeAuth::Subscription, Capability::ContextNote).enabled());
        // A cache file someone edited by hand does not verify, so it is ignored.
        std::fs::write(&path, r#"{"payload":"e30=","signature":"AAAA"}"#).unwrap();
        let tampered = ClaudePolicyStore::with_key(key(), Some(path), None);
        assert!(!tampered.policy().row(ClaudeAuth::Subscription, Capability::ContextNote).enabled());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn preview_turns_the_plan_rows_on_with_example_usage() {
        let s = store(Some(ClaudeAuth::Subscription));
        let plan = on_plan(&s);
        for cap in ALL_GATED {
            assert!(s.gate(&plan, cap).is_ok(), "{cap:?}");
        }
        assert_eq!(s.plan_usage(&plan), PlanUsage::Example);
        assert_eq!(s.status()["preview"], json!("subscription"));
        // Structural limits stay.
        assert!(s.gate(&plan, Capability::ModelRouting).is_err());
    }

    #[test]
    fn preview_never_runs_in_a_packaged_app() {
        // The env var is read in this (test) build, but a packaged app ignores it.
        assert_eq!(preview_from_env(true), None);
    }
}
