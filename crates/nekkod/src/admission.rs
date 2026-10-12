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
//! What still involves the host, and how: the turn is handed to it
//! (`turn:adopt`, not waited on) so its callbacks find it (the tools that
//! still run there, hooks, `spawn_agent`, the next queued prompt's admission)
//! and so it runs what follows a turn (the agent terminal, TurnEnd hooks, the
//! linked spec); a setup command's output goes to its agent terminal
//! (`loop:log`); and connector and workspace-index snippets are asked of it
//! (`chat:connectorSnippets`, `chat:indexSnippets`) only when a connector is
//! connected or the prompt has words to search for, until those services
//! move. A sandbox chat, and every chat under `NEKKO_AGENT_LOOP=ts`, goes to
//! the host whole, as before.

use crate::routes::Ctx;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHANNELS: &[&str] = &["chat:send"];

/// `runWorktreeSetup`'s limit.
const SETUP_LIMIT: Duration = Duration::from_secs(15 * 60);

/// What the daemon keeps for admission: the chats being compacted (the host
/// compacts, and says so with `compaction` events, which pass through here).
pub struct Admission {
    compacting: Mutex<HashSet<String>>,
    /// The desktop app's host lets the agent drive a browser; the web edition's does not.
    pub allow_browser_control: bool,
    /// `NEKKO_AGENT_LOOP=ts`: every turn stays in the host.
    pub ts_loop: bool,
}

impl Admission {
    pub fn new(hub: &crate::hub::Hub, allow_browser_control: bool, ts_loop: bool) -> Arc<Self> {
        let me = Arc::new(Admission { compacting: Mutex::default(), allow_browser_control, ts_loop });
        let (weak, mut rx) = (Arc::downgrade(&me), hub.subscribe());
        tokio::spawn(async move {
            loop {
                let ev = match rx.recv().await {
                    Ok(ev) => ev,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                if ev.term_data || !ev.text.contains("\"compaction\"") {
                    continue;
                }
                let Some(me) = weak.upgrade() else { break };
                me.observe(&ev.text);
            }
        });
        me
    }

    /// Note a `compaction` progress event: running starts one, anything else ends it.
    fn observe(&self, frame: &str) {
        let Ok(v) = serde_json::from_str::<Value>(frame) else { return };
        let p = &v["payload"];
        if v["channel"] != "agent:event" || p["type"] != "compaction" {
            return;
        }
        let Some(id) = p["sessionId"].as_str() else { return };
        let mut set = self.compacting.lock().unwrap_or_else(|e| e.into_inner());
        if p.pointer("/progress/state").and_then(Value::as_str) == Some("running") {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
    }

    fn is_compacting(&self, id: &str) -> bool {
        self.compacting.lock().unwrap_or_else(|e| e.into_inner()).contains(id)
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
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
fn provider_endpoint(provider: &Value) -> Option<url::Url> {
    let kind = s(provider, "kind");
    if !is_local(kind) && !["anthropic", "openai", "openrouter", "chatgpt", "openai-compat"].contains(&kind) {
        return None;
    }
    let url = url::Url::parse(provider.get("baseUrl").and_then(Value::as_str)?).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none()).then_some(url)
}

/// `offlineProviderAllowed`: a local kind (or openai-compat) on a loopback address.
fn offline_provider_allowed(provider: &Value) -> bool {
    let Some(url) = provider_endpoint(provider) else { return false };
    let kind = s(provider, "kind");
    let host = url.host_str().unwrap_or_default();
    let loop_v4 = host.strip_prefix("127.").is_some_and(|rest| {
        let parts: Vec<&str> = rest.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    });
    (is_local(kind) || kind == "openai-compat") && (host == "localhost" || host == "[::1]" || loop_v4)
}

/// `hasToolHooks`.
fn has_tool_hooks(settings: &Value) -> bool {
    settings.get("hooks").and_then(Value::as_array).is_some_and(|hooks| {
        hooks.iter().any(|h| {
            h.get("enabled") != Some(&json!(false))
                && !nekko_js::trim(s(h, "command")).is_empty()
                && matches!(s(h, "event"), "PreToolUse" | "PostToolUse")
        })
    })
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

fn platform() -> &'static str {
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
fn host_provider_config(ctx: &Ctx, config: &Value) -> Value {
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

/// `chat:send`.
pub async fn send(ctx: &Ctx, adm: &Arc<Admission>, args: Vec<Value>) -> Result<Value, String> {
    let opts = args.first().cloned().unwrap_or(Value::Null);
    let session_id = s(&opts, "sessionId").to_string();
    let store = ctx.sessions.clone().ok_or("chat:send needs the data directory")?;
    let session = {
        let (st, id) = (store.clone(), session_id.clone());
        tokio::task::spawn_blocking(move || st.get(&id)).await.map_err(|e| e.to_string())?
    };
    // A sandbox chat runs in the host's container router; the kill switch keeps everything there.
    if adm.ts_loop || session.as_ref().is_some_and(|s| crate::worktrees::execution_mode(s) == "sandbox") {
        return ctx.backend.call("chat:send", Value::Array(args)).await;
    }
    if adm.is_compacting(&session_id) {
        return fail(ctx, &session_id, "This chat is being compacted. Wait or move to a new chat.").await;
    }
    let settings = crate::settings::current(ctx).await;
    let provider = settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| p.get("id") == opts.get("providerId")).cloned());
    let Some(provider) = provider.filter(|p| nekko_js::truthy(p.get("enabled"))) else {
        return fail(ctx, &session_id, "Provider not configured or disabled.").await;
    };
    let Some(mut session) = session else { return fail(ctx, &session_id, "Session not found.").await };

    let mode_name = crate::worktrees::execution_mode(&session);
    let offline = nekko_js::truthy(session.get("offline"));
    let incognito = nekko_js::truthy(session.get("incognito"));
    if mode_name == "worktree"
        && !incognito
        && !offline
        && let Err(message) = provision(ctx, &store, &mut session, &settings).await
    {
        return fail(ctx, &session_id, &message).await;
    }
    let mut chat = session.clone();
    chat["gitIsolation"] = json!(mode_name == "worktree");
    let workspaces = crate::worktrees::chat_workspaces(Some(&chat), &settings);

    let mode = match session.get("mode").filter(|m| !m.is_null()) {
        Some(m) => m.clone(),
        None => settings.get("defaultChatMode").filter(|m| !m.is_null()).cloned().unwrap_or(json!("guardrails")),
    };
    if offline && !offline_provider_allowed(&provider) {
        return fail(
            ctx,
            &session_id,
            "Offline chat requires a local-compatible provider with a loopback HTTP(S) endpoint.",
        )
        .await;
    }
    if provider_endpoint(&provider).is_none() {
        return fail(ctx, &session_id, "Provider requires a valid HTTP(S) endpoint.").await;
    }

    let disabled_decide = session
        .get("disabledTools")
        .and_then(Value::as_array)
        .is_some_and(|d| d.iter().any(|t| t.as_str() == Some("decide")));
    let decide_with = if offline || disabled_decide {
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
    let connector_snippets = if offline || !connected {
        json!([])
    } else {
        ctx.backend.call("chat:connectorSnippets", json!([text])).await.unwrap_or(json!([]))
    };
    let has_worktrees = session.get("gitWorktrees").and_then(Value::as_object).is_some_and(|m| !m.is_empty());
    let ids = crate::worktrees::session_workspace_ids(&session);
    let index_snippets =
        if has_worktrees || ids.is_empty() || nekko_js::trim(&text).is_empty() || !has_index_words(&text) {
            json!([])
        } else {
            ctx.backend.call("chat:indexSnippets", json!([ids, text])).await.unwrap_or(json!([]))
        };

    let turn_id = daemon_turn_id();
    let (resolved, provider_error) = match crate::providers::resolve(ctx, &provider).await {
        Ok(p) => (Some(host_provider_config(ctx, &p)), None),
        Err(e) => (None, Some(e)),
    };
    let model_id = s(&opts, "modelId");
    let effort_setting: Option<nekko_agent::EffortLevel> =
        settings.get("effort").and_then(|e| serde_json::from_value(e.clone()).ok());
    let stats_effort = nekko_agent::claude::effective_effort(effort_setting, model_id);
    let kind = s(&provider, "kind");

    let mut facts = Map::new();
    facts.insert(
        "workspaces".into(),
        Value::Array(workspaces.iter().map(|w| pick(w, &["id", "name", "path"])).collect()),
    );
    facts.insert(
        "mcpServers".into(),
        if offline {
            json!([])
        } else {
            settings.get("mcpServers").filter(|v| !v.is_null()).cloned().unwrap_or(json!([]))
        },
    );
    facts.insert("decide".into(), json!(!decide_with.is_null()));
    facts.insert("decideWith".into(), decide_with.clone());
    facts.insert("hooks".into(), json!(has_tool_hooks(&settings)));
    facts.insert("connectorSnippets".into(), connector_snippets);
    facts.insert("indexSnippets".into(), index_snippets);
    facts.insert("platform".into(), json!(platform()));
    facts.insert("temperature".into(), json!(effort_temperature(stats_effort)));
    facts.insert("effort".into(), settings.get("effort").filter(|e| !e.is_null()).cloned().unwrap_or(json!("normal")));
    facts.insert("statsEffort".into(), json!(effort_name(stats_effort)));
    if is_local(kind) {
        facts.insert(
            "maxOutputTokens".into(),
            nekko_oauth::num(clamp_max_output_tokens(settings.get("maxOutputTokens"))),
        );
    }
    facts.insert("promptCaching".into(), json!(settings.get("promptCaching") != Some(&json!(false))));
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
    facts.insert("spawn".into(), json!(true));
    let mut account = pick(&provider, &["auth", "kind", "tokenKey"]);
    account["incognito"] = json!(incognito);
    facts.insert("account".into(), account);

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
    let spec = json!({
        "turnId": turn_id,
        "opts": opts,
        "allowBrowserControl": adm.allow_browser_control,
        "settings": spec_settings,
        "facts": Value::Object(facts),
    });

    // The host registers the turn for its callbacks; nothing here waits on it.
    {
        let backend = ctx.backend.clone();
        let payload = json!([{
            "turnId": turn_id,
            "opts": opts,
            "workspaces": workspaces,
            "mode": mode,
            "decideWith": decide_with,
            "allowBrowserControl": adm.allow_browser_control,
            "provider": resolved,
        }]);
        tokio::spawn(async move {
            if let Err(e) = backend.call("turn:adopt", payload).await {
                eprintln!("nekkod: the host could not adopt a turn: {e}");
            }
        });
    }

    ctx.turns.watch(&session_id);
    let result = drive_chain(ctx, spec).await;
    ctx.turns.unwatch(&session_id);
    if let Err(e) = result {
        return fail(ctx, &session_id, &e).await;
    }
    Ok(Value::Null)
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
        let log = |text: String| {
            let backend = ctx.backend.clone();
            let args = json!([id, folder_id, text]);
            async move {
                let _ = backend.call("loop:log", args).await;
            }
        };
        log(format!("\r\n$ {command}  (worktree setup in {path})\r\n")).await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let writer = {
            let (backend, id, folder_id) = (ctx.backend.clone(), id.clone(), folder_id.clone());
            tokio::spawn(async move {
                while let Some(text) = rx.recv().await {
                    let _ = backend.call("loop:log", json!([id, folder_id, text])).await;
                }
            })
        };
        let (ok, detail) = crate::worktrees::run_setup(
            &command,
            &path,
            move |text| {
                let _ = tx.send(terminal_text(&text));
            },
            SETUP_LIMIT,
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
