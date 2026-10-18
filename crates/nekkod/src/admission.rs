//! `chat:send`, admitted by the daemon (PF14): a chat turn starts without
//! waiting on the TS host.
//!
//! A port of `admitTurn` and `buildDaemonTurn` (chat.ts): the provider and
//! chat checks, a worktree chat's checkouts and their setup command
//! (`worktrees.rs`), the offline and endpoint checks, the decision runner,
//! the provider resolved with a fresh token (`providers.rs`), and the
//! `chat:turn` spec, which `turns.rs` then drives, along with the queued
//! prompts after it; `chat:send` answers once the chain is done, as the host's
//! `sendChat` did.
//!
//! Connector and workspace-index snippets, a setup command's output (the
//! chat's agent terminal, agent_logs.rs) and tool hooks are all this
//! daemon's. When a host runs beside it, the turn is handed to it as well
//! (`turn:adopt`, not waited on) so it runs what follows a turn (TurnEnd
//! hooks, the linked spec) and the turn's few host-side tools; with no host,
//! turns.rs runs that after-work itself. A sandbox chat is admitted here too (its setup checked, ask mode,
//! only its copied folders, no host context, MCP, decision runner, hooks or
//! sub-agents) and its turn runs every tool in the daemon's container for it
//! (sandbox.rs). Only a sandbox chat on a daemon with no containers (no data
//! directory) goes to the host whole.

use crate::routes::Ctx;
use nekko_loop::Cancel;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHANNELS: &[&str] = &["chat:send", "chat:interruptQueued"];

/// `runWorktreeSetup`'s limit.
const SETUP_LIMIT: Duration = Duration::from_secs(15 * 60);

/// What the daemon keeps for admission: the chats being prepared, and the
/// compactions (compaction.rs), which refuse a turn while they run.
pub struct Admission {
    pending: Mutex<HashMap<String, Cancel>>,
    /// The chats whose queued prompt is being started at once (`chat:interruptQueued`).
    interrupting: Arc<Mutex<HashSet<String>>>,
    compactions: Arc<crate::compaction::Compactions>,
    /// The desktop app's host lets the agent drive a browser; the Local Web UI's does not.
    pub allow_browser_control: bool,
}

impl Admission {
    pub fn new(compactions: Arc<crate::compaction::Compactions>, allow_browser_control: bool) -> Arc<Self> {
        Arc::new(Admission {
            pending: Mutex::default(),
            interrupting: Arc::default(),
            compactions,
            allow_browser_control,
        })
    }

    fn interrupting(&self, id: &str) -> bool {
        self.interrupting.lock().unwrap_or_else(|e| e.into_inner()).contains(id)
    }

    /// Mark the chat as starting a queued prompt until the guard drops.
    fn begin_interrupt(&self, id: &str) -> InterruptGuard {
        self.interrupting.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string());
        InterruptGuard { set: self.interrupting.clone(), id: id.to_string() }
    }

    /// Whether a `chat:send` for this chat is being admitted or driven here.
    pub fn is_admitting(&self, id: &str) -> bool {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).contains_key(id)
    }

    fn begin(self: &Arc<Self>, id: &str) -> Result<AdmissionGuard, String> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.contains_key(id) {
            return Err("A reply is already being prepared or running in this chat.".into());
        }
        let cancel = Cancel::default();
        pending.insert(id.into(), cancel.clone());
        Ok(AdmissionGuard { admission: self.clone(), id: id.into(), cancel })
    }

    fn cancellation(&self, id: &str) -> Option<Cancel> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }

    pub fn abort(&self, id: &str) {
        if let Some(cancel) = self.cancellation(id) {
            cancel.cancel();
        }
    }

    fn is_compacting(&self, id: &str) -> bool {
        self.compactions.is_compacting(id)
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

struct InterruptGuard {
    set: Arc<Mutex<HashSet<String>>>,
    id: String,
}
impl Drop for InterruptGuard {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

struct AdmissionGuard {
    admission: Arc<Admission>,
    id: String,
    cancel: Cancel,
}
impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        self.admission.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

async fn stopped(ctx: &Ctx, session_id: &str) -> Result<Admit, String> {
    emit(ctx, json!({ "type": "done", "sessionId": session_id, "aborted": true })).await;
    Ok(Admit::Ended)
}

/// Tell the UI (and, through the host, the phone relay) what happened.
async fn emit(ctx: &Ctx, event: Value) {
    ctx.hub.publish("agent:event", event.clone(), false);
    let backend = ctx.backend.clone();
    tokio::spawn(async move {
        let _ = backend.call("turn:notify", json!([event])).await;
    });
}

async fn fail(ctx: &Ctx, session_id: &str, message: &str) -> Result<Value, String> {
    emit(ctx, json!({ "type": "error", "sessionId": session_id, "message": message })).await;
    Ok(Value::Null)
}

/// `newTurnId()`, marked `turn_d` so the host knows to wait for its `turn:adopt`.
fn daemon_turn_id() -> String {
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("turn_d{}_{hex}", radix36(nekko_oauth::now_ms() as u64))
}

fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

const LOCAL_KINDS: &[&str] = &["llamacpp", "ollama", "lmstudio", "vllm"];

/// `isLocalProvider`.
fn is_local(kind: &str) -> bool {
    LOCAL_KINDS.contains(&kind)
}

/// `providerEndpoint`: a provider's URL when it is one a turn may call.
pub(crate) fn provider_endpoint(provider: &Value) -> Option<url::Url> {
    let kind = s(provider, "kind");
    if !is_local(kind) && !["anthropic", "openai", "openrouter", "chatgpt", "openai-compat"].contains(&kind) {
        return None;
    }
    let url = url::Url::parse(provider.get("baseUrl").and_then(Value::as_str)?).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none()).then_some(url)
}

/// `offlineProviderAllowed`: a local kind (or openai-compat) on a loopback address.
pub(crate) fn offline_provider_allowed(provider: &Value) -> bool {
    let Some(url) = provider_endpoint(provider) else { return false };
    let kind = s(provider, "kind");
    let host = url.host_str().unwrap_or_default();
    let loop_v4 = host.strip_prefix("127.").is_some_and(|rest| {
        let parts: Vec<&str> = rest.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    });
    (is_local(kind) || kind == "openai-compat") && (host == "localhost" || host == "[::1]" || loop_v4)
}

/// `clampMaxOutputTokens`.
fn clamp_max_output_tokens(n: Option<&Value>) -> f64 {
    match n.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => (n + 0.5).floor().clamp(256.0, 200_000.0),
        _ => 8192.0,
    }
}

fn effort_name(e: nekko_agent::EffortLevel) -> &'static str {
    use nekko_agent::EffortLevel::*;
    match e {
        Low => "low",
        Medium => "medium",
        Normal => "normal",
        High => "high",
        Xhigh => "xhigh",
        Max => "max",
    }
}

/// `EFFORT_TEMPERATURE`.
fn effort_temperature(e: nekko_agent::EffortLevel) -> f64 {
    use nekko_agent::EffortLevel::*;
    match e {
        Low => 0.2,
        Medium => 0.5,
        Normal => 0.7,
        High | Xhigh | Max => 1.0,
    }
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// `{ ...pick }` of the keys present, as `JSON.stringify` keeps them.
fn pick(v: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for k in keys {
        if let Some(x) = v.get(*k) {
            out.insert((*k).into(), x.clone());
        }
    }
    Value::Object(out)
}

/// `hostProviderConfig`: `managedCachePrompt` only for the engine this app serves.
pub(crate) fn host_provider_config(ctx: &Ctx, config: &Value) -> Value {
    let mut out = config.as_object().cloned().unwrap_or_default();
    out.shift_remove("managedCachePrompt");
    let managed = ctx.engine.router.serving().map(|c| format!("http://127.0.0.1:{}/v1", c.port));
    if managed.is_some_and(|m| {
        s(config, "kind") == "llamacpp" && config.get("baseUrl").and_then(Value::as_str) == Some(m.as_str())
    }) {
        out.insert("managedCachePrompt".into(), json!(true));
    }
    Value::Object(out)
}

/// `/[a-z0-9_]{4,}/g` over the lowercased prompt: whether the index has anything to search for.
fn has_index_words(text: &str) -> bool {
    let lower = text.to_lowercase();
    let mut run = 0;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
            run += 1;
            if run >= 4 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// What admitting a turn came to.
enum Admit {
    /// The host runs it (a sandbox chat, or the kill switch).
    Host,
    /// It cannot run; the chat was told why.
    Ended,
    /// The `chat:turn` spec to drive; the host has been handed the turn.
    Spec(Value),
}

async fn ended(ctx: &Ctx, session_id: &str, message: &str) -> Result<Admit, String> {
    fail(ctx, session_id, message).await?;
    Ok(Admit::Ended)
}

/// A `spawn_agent` child's turn (`admitTurn` then `buildDaemonTurn`, in the
/// parent's `spawn` callback): admitted like any chat's, never with the
/// browser. `None` when it cannot start; its chat was told why.
pub async fn admit_child(ctx: &Ctx, opts: Value) -> Result<Option<Value>, String> {
    let adm = ctx.admission.clone().ok_or("Sub-agents need the daemon to admit turns.")?;
    let pending = adm.begin(s(&opts, "sessionId"))?;
    match admit(ctx, &adm, opts, None, false, &pending.cancel).await? {
        Admit::Spec(mut spec) => {
            spec["allowBrowserControl"] = json!(false);
            Ok(Some(spec))
        }
        Admit::Host | Admit::Ended => Ok(None),
    }
}

/// `chat:send`.
pub async fn send(ctx: &Ctx, adm: &Arc<Admission>, args: Vec<Value>) -> Result<Value, String> {
    let opts = args.first().cloned().unwrap_or(Value::Null);
    if adm.interrupting(s(&opts, "sessionId")) {
        return Err("A queued prompt is already starting.".into());
    }
    send_with(ctx, adm, opts, None).await
}

/// `sendChat(opts, ..., queued)`: admit and drive a turn and its chain; with
/// `queued`, the turn runs that queue entry and claims it.
async fn send_with(ctx: &Ctx, adm: &Arc<Admission>, opts: Value, queued: Option<Value>) -> Result<Value, String> {
    let session_id = s(&opts, "sessionId").to_string();
    let pending = adm.begin(&session_id)?;
    let result = admit(ctx, adm, opts.clone(), queued, false, &pending.cancel).await?;
    if pending.cancel.is_cancelled() && !matches!(&result, Admit::Ended) {
        stopped(ctx, &session_id).await?;
        return Ok(Value::Null);
    }
    let spec = match result {
        Admit::Host => {
            drop(pending);
            return ctx.backend.call("chat:send", json!([opts])).await;
        }
        Admit::Ended => return Ok(Value::Null),
        Admit::Spec(spec) => spec,
    };
    ctx.turns.watch(&session_id);
    let result = drive_chain(ctx, spec).await;
    ctx.turns.unwatch(&session_id);
    if let Err(e) = result {
        return fail(ctx, &session_id, &e).await;
    }
    Ok(Value::Null)
}

/// How long `chat:interruptQueued` waits for the stopped reply to let go of the chat.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(30);

/// `chat:interruptQueued(sessionId, index, brain)`: stop the reply that runs
/// (the daemon's or the host's), wait for it to end, then start the queued
/// prompt at `index` at once, on the model picked for it, claiming it from
/// the queue in the same write as its user message (host.ts
/// `interruptQueuedPrompt`).
pub async fn interrupt_queued(ctx: &Ctx, adm: &Arc<Admission>, args: Vec<Value>) -> Result<Value, String> {
    let session_id = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
    let index = args.get(1).cloned().unwrap_or(Value::Null);
    let brain = args.get(2).cloned().unwrap_or(Value::Null);
    let store = ctx.sessions.clone().ok_or("Session not found.")?;
    let (st, id) = (store.clone(), session_id.clone());
    let session = tokio::task::spawn_blocking(move || st.get(&id)).await.map_err(|e| e.to_string())?;
    let session = session.ok_or("Session not found.")?;
    // A sandbox chat without containers here stays in the host whole.
    if crate::worktrees::execution_mode(&session) == "sandbox" && ctx.sandboxes.is_none() {
        return ctx.backend.call("chat:interruptQueued", Value::Array(args)).await;
    }
    let index = nekko_turn::variants::queued_index_valid(&session, &index).ok_or("Queued prompt not found.")?;
    if adm.interrupting(&session_id) {
        return Err("A queued prompt is already starting.".into());
    }
    if adm.is_compacting(&session_id) {
        return Err("This chat is being compacted.".into());
    }
    let settings = crate::settings::current(ctx).await;
    let (opts, item) = nekko_turn::variants::interrupt_queued_plan(&session, index, &brain, &settings)?;
    let _interrupting = adm.begin_interrupt(&session_id);

    let busy = |ctx: &Ctx, adm: &Arc<Admission>, id: String| {
        let (ctx, adm) = (ctx.clone(), adm.clone());
        async move {
            adm.is_admitting(&id)
                || ctx.turns.running_sessions().contains(&id)
                || crate::routes::running_chats(&ctx).await.contains(&id)
        }
    };
    if busy(ctx, adm, session_id.clone()).await {
        // The UI's Stop, then wait for the reply to let go of the chat.
        crate::routes::stop_chat(ctx, &session_id).await?;
        let until = tokio::time::Instant::now() + INTERRUPT_SETTLE;
        while busy(ctx, adm, session_id.clone()).await {
            if tokio::time::Instant::now() > until {
                return Err("The running reply did not stop. Try again when it finishes.".into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    } else if ctx.image_turns.abort(&session_id) {
        return Err("Image turn is still stopping. Try again when it finishes.".into());
    }
    if adm.is_compacting(&session_id) {
        return Err("This chat is being compacted.".into());
    }
    send_with(ctx, adm, opts, Some(json!({ "index": index, "item": item }))).await
}

/// The next queued prompt of a chain the daemon admitted (`turn:prepare`,
/// answered here): `{ spec }`, `{ ended: true }` (it could not start and the
/// chat was told why), or `{ inProcess: true }` (the host must run it).
/// `None` (a sandbox chat, or the kill switch) leaves it to the host's `turn:prepare`.
pub async fn admit_queued(ctx: &Ctx, adm: &Arc<Admission>, payload: &Value) -> Option<Value> {
    let opts = payload.get("opts").cloned().unwrap_or(Value::Null);
    let cancel = adm.cancellation(s(&opts, "sessionId")).unwrap_or_default();
    match admit(ctx, adm, opts, payload.get("queued").cloned(), true, &cancel).await {
        Ok(Admit::Spec(spec)) => Some(json!({ "spec": spec })),
        Ok(Admit::Host) => None,
        Ok(Admit::Ended) | Err(_) => Some(json!({ "ended": true })),
    }
}

/// `admitTurn` and `buildDaemonTurn`: check, provision and describe a turn,
/// and hand it to the host for its callbacks.
async fn admit(
    ctx: &Ctx,
    adm: &Arc<Admission>,
    opts: Value,
    queued: Option<Value>,
    chained: bool,
    cancel: &Cancel,
) -> Result<Admit, String> {
    let session_id = s(&opts, "sessionId").to_string();
    let store = ctx.sessions.clone().ok_or("chat:send needs the data directory")?;
    let session = {
        let (st, id) = (store.clone(), session_id.clone());
        tokio::task::spawn_blocking(move || st.get(&id)).await.map_err(|e| e.to_string())?
    };
    // A sandbox chat stays in the host when this daemon has no containers
    // (no data directory).
    let sandbox = session.as_ref().is_some_and(|s| crate::worktrees::execution_mode(s) == "sandbox");
    if sandbox && ctx.sandboxes.is_none() {
        return Ok(Admit::Host);
    }
    // A chained queued prompt was admitted by the host without this check; so it stays.
    if !chained && adm.is_compacting(&session_id) {
        return ended(ctx, &session_id, "This chat is being compacted. Wait or move to a new chat.").await;
    }
    let settings = crate::settings::current(ctx).await;
    let provider = settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| p.get("id") == opts.get("providerId")).cloned());
    let Some(provider) = provider.filter(|p| nekko_js::truthy(p.get("enabled"))) else {
        return ended(ctx, &session_id, "Provider not configured or disabled.").await;
    };
    // A scheduled task, workflow, goal step, watch or auto-continue on Claude
    // Code needs `unattended_runs` for its auth (claude_policy.rs).
    if let Err(refusal) = ctx.claude_policy.gate_turn(&provider, &opts) {
        return ended(ctx, &session_id, refusal.message).await;
    }
    let Some(mut session) = session else { return ended(ctx, &session_id, "Session not found.").await };
    if sandbox && let Some(refusal) = nekko_turn::variants::sandbox_admission_refusal(&session, &opts) {
        return ended(ctx, &session_id, refusal).await;
    }

    let mode_name = crate::worktrees::execution_mode(&session);
    let offline = nekko_js::truthy(session.get("offline"));
    let incognito = nekko_js::truthy(session.get("incognito"));
    if mode_name == "worktree"
        && !incognito
        && !offline
        && let Err(message) = provision(ctx, &store, &mut session, &settings, cancel).await
    {
        return ended(ctx, &session_id, &message).await;
    }
    if cancel.is_cancelled() {
        return stopped(ctx, &session_id).await;
    }
    let mut chat = session.clone();
    chat["gitIsolation"] = json!(mode_name == "worktree");
    // A sandbox chat sees only its copied folders (`folder-N`), never the host's.
    let workspaces = if sandbox {
        nekko_turn::variants::sandbox_workspaces(&session)
    } else {
        crate::worktrees::chat_workspaces(Some(&chat), &settings)
    };

    // A sandbox chat always asks.
    let mode = match session.get("mode").filter(|m| !m.is_null()) {
        _ if sandbox => json!("ask"),
        Some(m) => m.clone(),
        None => settings.get("defaultChatMode").filter(|m| !m.is_null()).cloned().unwrap_or(json!("guardrails")),
    };
    if offline && !offline_provider_allowed(&provider) {
        return ended(
            ctx,
            &session_id,
            "Offline chat requires a local-compatible provider with a loopback HTTP(S) endpoint.",
        )
        .await;
    }
    if provider_endpoint(&provider).is_none() {
        return ended(ctx, &session_id, "Provider requires a valid HTTP(S) endpoint.").await;
    }

    let disabled_decide = session
        .get("disabledTools")
        .and_then(Value::as_array)
        .is_some_and(|d| d.iter().any(|t| t.as_str() == Some("decide")));
    let decide_with = if offline || disabled_decide || sandbox {
        Value::Null
    } else if ctx.engine.decide.status()["loaded"] == json!(true) {
        json!("local")
    } else if nekko_js::truthy(settings.get("typesafeApiKey"))
        || std::env::var("TYPESAFE_API_KEY").is_ok_and(|k| !k.is_empty())
    {
        json!("typesafe")
    } else {
        Value::Null
    };

    let text = s(&opts, "text").to_string();
    let connected = settings
        .get("connectors")
        .and_then(Value::as_array)
        .is_some_and(|cs| cs.iter().any(|c| nekko_js::truthy(c.get("connected")) && nekko_js::truthy(c.get("token"))));
    // Context is not silently read from host connectors or indices for a sandbox chat.
    let connector_snippets = if offline || !connected || sandbox {
        json!([])
    } else {
        Value::Array(crate::connectors::snippets(ctx, Some(&text), &session).await)
    };
    let has_worktrees = session.get("gitWorktrees").and_then(Value::as_object).is_some_and(|m| !m.is_empty());
    let ids = crate::worktrees::session_workspace_ids(&session);
    let index_snippets =
        if sandbox || has_worktrees || ids.is_empty() || nekko_js::trim(&text).is_empty() || !has_index_words(&text) {
            json!([])
        } else {
            Value::Array(crate::workspace::index_snippets(ctx, &ids, &text).await)
        };

    let turn_id = daemon_turn_id();
    let resolution = tokio::select! {
        _ = cancel.cancelled() => return stopped(ctx, &session_id).await,
        result = crate::providers::resolve(ctx, &provider) => result,
    };
    let (resolved, provider_error) = match resolution {
        Ok(p) => (Some(host_provider_config(ctx, &p)), None),
        Err(e) => (None, Some(e)),
    };
    let model_id = s(&opts, "modelId");
    // The chat's own effort wins over the app-wide one (`chatEffort`).
    let effort = nekko_turn::chat_effort(&session, settings.get("effort"));
    let effort_setting: Option<nekko_agent::EffortLevel> =
        effort.as_ref().and_then(|e| serde_json::from_value(e.clone()).ok());
    let stats_effort = nekko_agent::claude::effective_effort(effort_setting, model_id);
    let kind = s(&provider, "kind");

    let mut facts = Map::new();
    facts.insert(
        "workspaces".into(),
        Value::Array(workspaces.iter().map(|w| pick(w, &["id", "name", "path"])).collect()),
    );
    facts.insert(
        "mcpServers".into(),
        if offline || sandbox {
            json!([])
        } else {
            settings.get("mcpServers").filter(|v| !v.is_null()).cloned().unwrap_or(json!([]))
        },
    );
    facts.insert("decide".into(), json!(!decide_with.is_null()));
    facts.insert("decideWith".into(), decide_with.clone());
    // Tool hooks run here (turns.rs, nekko-tools `hooks`), never through the host;
    // a sandbox chat runs none.
    facts.insert("hooks".into(), json!(false));
    if !sandbox {
        facts.insert("hookRules".into(), settings.get("hooks").filter(|h| h.is_array()).cloned().unwrap_or(json!([])));
    }
    // The turn runs its tools in this daemon's container for the chat (turns.rs).
    facts.insert("sandbox".into(), json!(sandbox));
    facts.insert("connectorSnippets".into(), connector_snippets);
    facts.insert("indexSnippets".into(), index_snippets);
    facts.insert("platform".into(), json!(platform()));
    facts.insert("temperature".into(), json!(effort_temperature(stats_effort)));
    facts.insert("effort".into(), effort.unwrap_or(json!("normal")));
    facts.insert("statsEffort".into(), json!(effort_name(stats_effort)));
    if is_local(kind) {
        facts.insert(
            "maxOutputTokens".into(),
            nekko_oauth::num(clamp_max_output_tokens(settings.get("maxOutputTokens"))),
        );
    }
    facts.insert("promptCaching".into(), json!(settings.get("promptCaching") != Some(&json!(false))));
    // The loaded window, for the loop to keep a long run inside (nekko-loop fit.rs).
    facts.insert("contextWindow".into(), json!(crate::providers::context_window_for(ctx, &provider, model_id).await));
    // False for a model the provider lists without image input: pictures go as a note.
    facts.insert("imageInput".into(), json!(crate::providers::image_input_for(ctx, &provider, model_id).await));
    if let Some(p) = &resolved {
        facts.insert("provider".into(), p.clone());
    }
    if let Some(e) = &provider_error {
        facts.insert("providerError".into(), json!(e));
    }
    facts.insert(
        "headers".into(),
        json!(
            kind == "anthropic" && s(&provider, "auth") == "subscription" && nekko_js::truthy(provider.get("tokenKey"))
        ),
    );
    // An API key's own rate limits, read off each response (`limitsKeyFor`).
    if kind == "anthropic" && s(&provider, "auth") != "subscription" && nekko_js::truthy(provider.get("apiKey")) {
        facts.insert("apiLimitsKey".into(), json!(format!("provider:{}", s(&provider, "id"))));
    }
    facts.insert("spawn".into(), json!(!sandbox));
    let mut account = pick(&provider, &["auth", "kind", "tokenKey"]);
    account["incognito"] = json!(incognito);
    facts.insert("account".into(), account);
    // The phone relay, messaging and accounting are this daemon's wherever it
    // admits turns, so the host is sent only how a turn ends (an agent watch's
    // resume reads the error; turns.rs `host_events`).
    facts.insert("hostEvents".into(), json!(crate::turns::HOST_END_EVENTS));

    let providers: Vec<Value> = settings
        .get("providers")
        .and_then(Value::as_array)
        .map(|ps| ps.iter().map(|p| pick(p, &["id", "label", "enabled", "apiKey", "baseUrl"])).collect())
        .unwrap_or_default();
    let mut spec_settings = pick(
        &settings,
        &[
            "systemInstructions",
            "turnWrapper",
            "aboutUser",
            "orchestration",
            "sandboxMode",
            "guardrails",
            "defaultChatMode",
            "unattendedQuestionMinutes",
        ],
    );
    spec_settings["providers"] = Value::Array(providers);
    let mut spec = json!({
        "turnId": turn_id,
        "opts": opts,
        "allowBrowserControl": adm.allow_browser_control,
        "settings": spec_settings,
        "facts": Value::Object(facts),
    });
    if let Some(q) = &queued {
        spec["queued"] = q.clone();
    }

    if cancel.is_cancelled() {
        return stopped(ctx, &session_id).await;
    }
    // The host registers the turn for its callbacks; nothing here waits on it
    // (a queued turn's previous turn stays registered there until it lands).
    // With no host, nothing adopts it.
    if !ctx.backend.is_none() {
        let backend = ctx.backend.clone();
        let cancel = cancel.clone();
        let payload = json!([{
            "turnId": turn_id,
            "opts": opts,
            "workspaces": workspaces,
            "mode": mode,
            "decideWith": decide_with,
            "allowBrowserControl": adm.allow_browser_control,
            "provider": resolved,
            // A queued turn joins the chain the host already follows.
            "chained": chained,
        }]);
        tokio::spawn(async move {
            if cancel.is_cancelled() {
                return;
            }
            if let Err(e) = backend.call("turn:adopt", payload).await {
                eprintln!("nekkod: the host could not adopt a turn: {e}");
            }
        });
    }

    Ok(Admit::Spec(spec))
}

/// Start the turn and wait for it and every queued turn the daemon chains after it.
async fn drive_chain(ctx: &Ctx, spec: Value) -> Result<(), String> {
    let (_, mut ended) = ctx.turns.launch(ctx.backend.clone(), ctx.hub.clone(), spec)?;
    loop {
        let Ok((summary, _)) = ended.await else { return Ok(()) };
        let Some(next) = summary.get("next").and_then(Value::as_str) else { return Ok(()) };
        match ctx.turns.take_chained(next) {
            Some(n) => ended = n,
            None => return Ok(()),
        }
    }
}

/// A worktree chat's checkouts before its turn: made (or restored) and
/// saved, each new one's setup command run with its output in the chat's
/// agent terminal and its progress in the checkout's notice.
async fn provision(
    ctx: &Ctx,
    store: &Arc<nekko_store::SessionStore>,
    session: &mut Value,
    settings: &Value,
    cancel: &Cancel,
) -> Result<(), String> {
    let before = nekko_js::stringify(session.get("gitWorktrees").unwrap_or(&Value::Null));
    let (mut s2, set) = (session.clone(), settings.clone());
    let (made, created) = tokio::task::spawn_blocking(move || {
        let created = crate::worktrees::prepare(&mut s2, &set);
        (s2, created)
    })
    .await
    .map_err(|e| e.to_string())?;
    let created = created?;
    *session = made;
    let id = s(session, "id").to_string();
    let announce = |session: &Value| {
        let (st, id, wt) = (store.clone(), id.clone(), session.get("gitWorktrees").cloned().unwrap_or(json!({})));
        async move {
            let _ = tokio::task::spawn_blocking(move || st.set_git_worktrees(&id, &wt)).await;
        }
    };
    if nekko_js::stringify(session.get("gitWorktrees").unwrap_or(&Value::Null)) != before {
        announce(session).await;
        emit(ctx, json!({ "type": "session_meta", "sessionId": id })).await;
    }
    let workspaces = settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
    for (folder_id, checkout) in created {
        let command = workspaces
            .iter()
            .find(|w| s(w, "id") == folder_id)
            .map(|w| nekko_js::trim(s(w, "worktreeSetup")).to_string())
            .unwrap_or_default();
        if command.is_empty() {
            continue;
        }
        let notice = s(&checkout, "notice").to_string();
        let root = s(&checkout, "root").to_string();
        let path = s(&checkout, "path").to_string();
        let set_notice = |session: &mut Value, text: &str| {
            if let Some(m) = session.get_mut("gitWorktrees").and_then(Value::as_object_mut) {
                for w in m.values_mut() {
                    if s(w, "root") == root {
                        w["notice"] = json!(format!("{notice} {text}"));
                    }
                }
            }
        };
        set_notice(session, &format!("Running setup: {command}"));
        announce(session).await;
        emit(ctx, json!({ "type": "session_meta", "sessionId": id })).await;
        let folder = json!(folder_id);
        ctx.turns
            .command_output(&ctx.backend, &id, &folder, &format!("\r\n$ {command}  (worktree setup in {path})\r\n"))
            .await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let writer = {
            let (turns, backend, id, folder) = (ctx.turns.clone(), ctx.backend.clone(), id.clone(), folder.clone());
            tokio::spawn(async move {
                while let Some(text) = rx.recv().await {
                    turns.command_output(&backend, &id, &folder, &text).await;
                }
            })
        };
        let (ok, detail) = crate::worktrees::run_setup_with_cancel(
            &command,
            &path,
            move |text| {
                let _ = tx.send(terminal_text(&text));
            },
            SETUP_LIMIT,
            Some(cancel),
        )
        .await;
        let _ = writer.await;
        set_notice(
            session,
            &if ok {
                format!("Setup ran: {command}.")
            } else {
                format!(
                    "Setup failed ({detail}): {command}. Dependencies may be missing; see the Agent commands terminal."
                )
            },
        );
        announce(session).await;
        emit(ctx, json!({ "type": "session_meta", "sessionId": id })).await;
    }
    Ok(())
}

/// What the agent terminal is sent of a setup command's output: printable
/// characters only (`/[^\x09\x0a\x20-\x7e\u0080-￿]/g` removed) and CRLF lines.
fn terminal_text(text: &str) -> String {
    text.chars()
        // Above U+FFFF a character is a surrogate pair in JavaScript, whose halves the class keeps.
        .filter(|&c| c == '\t' || c == '\n' || (' '..='~').contains(&c) || c >= '\u{80}')
        .collect::<String>()
        .replace('\n', "\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_needs_a_local_provider_on_a_loopback_address() {
        let p = |kind: &str, url: &str| json!({ "kind": kind, "baseUrl": url });
        assert!(offline_provider_allowed(&p("ollama", "http://127.0.0.1:11434")));
        assert!(offline_provider_allowed(&p("openai-compat", "http://localhost:1234/v1")));
        assert!(offline_provider_allowed(&p("llamacpp", "http://[::1]:8080")));
        assert!(!offline_provider_allowed(&p("openai", "http://127.0.0.1:1")));
        assert!(!offline_provider_allowed(&p("ollama", "http://10.0.0.2:11434")));
        assert!(provider_endpoint(&p("openai", "https://u:p@api.openai.com")).is_none());
        assert!(provider_endpoint(&p("openai", "ftp://x")).is_none());
        assert!(provider_endpoint(&p("mystery", "http://x")).is_none());
    }

    #[test]
    fn output_caps_and_index_words_follow_the_ts_rules() {
        assert_eq!(clamp_max_output_tokens(None), 8192.0);
        assert_eq!(clamp_max_output_tokens(Some(&json!(10))), 256.0);
        assert_eq!(clamp_max_output_tokens(Some(&json!(1_000_000))), 200_000.0);
        assert_eq!(clamp_max_output_tokens(Some(&json!(1000.5))), 1001.0);
        assert_eq!(clamp_max_output_tokens(Some(&json!("4096"))), 8192.0);
        assert!(has_index_words("fix the auth bug"));
        assert!(!has_index_words("hi, ok?"));
        assert_eq!(terminal_text("a\u{1b}[0mb\nc"), "a[0mb\r\nc");
        assert!(daemon_turn_id().starts_with("turn_d"));
    }
}
