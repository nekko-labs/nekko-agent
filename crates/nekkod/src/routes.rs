//! Channel routing: the strangler table.
//!
//! A channel listed here is served by the daemon; any other is forwarded to
//! the TS backend unchanged. Porting a service means adding its channels here
//! and deleting the TS implementation, with no change to any client.

use crate::backend::Backend;
use crate::hub::Hub;
use nekko_term::{CreateSpec, Registry, RegistryEvent, UpdatePatch, detect_shells, resolve_shell};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct Ctx {
    pub terminals: Arc<Registry>,
    pub backend: Arc<Backend>,
    pub hub: Hub,
    pub engine: Arc<crate::engine::Engine>,
    /// Session reads (`nekko-store`), when the data directory is known.
    pub sessions: Option<Arc<nekko_store::SessionStore>>,
    /// Agent runs the TS host hands the daemon (`loop:run`).
    pub loops: Arc<crate::loops::Loops>,
    /// MCP servers the TS host syncs and calls (`mcp:sync`, `mcp:call`).
    pub mcp: Arc<crate::mcp::Mcp>,
    /// Whole chat turns (`chat:turn`) and the input they wait on.
    pub turns: Arc<crate::turns::Turns>,
    /// Usage, reply and limit accounting (`usage:summary`, `limits:*`).
    pub accounts: Arc<crate::accounts::Accounts>,
    /// settings.json, when the data directory is known (`settings:*`).
    pub settings: Option<Arc<crate::settings::Settings>>,
    /// Nekko Voice (`voice:*`), when the data directory is known.
    pub voice: Option<Arc<crate::voice::Voice>>,
    /// Sign-in and tokens.json, when the data directory is known (`oauth:*`).
    pub oauth: Option<Arc<crate::oauth::OAuth>>,
    /// `chat:send` admitted here, when the daemon owns settings, tokens and sessions.
    pub admission: Option<Arc<crate::admission::Admission>>,
    /// The model catalog, when the daemon has the settings store (for the Hugging Face token).
    pub catalog: Option<Arc<nekko_engine::catalog::Catalog>>,
    /// GPU and system stats and the readiness advisor (`gpu:stats`, `system:stats`, `machine:readiness`).
    pub machine: Arc<nekko_machine::Machine>,
    /// The experimental resource-queue client, when the data directory is known.
    pub resource_queue: Option<Arc<crate::resource_queue::ResourceQueue>>,
}

/// Terminals whose ids start with this are the TS host's read-only agent
/// command logs; everything else is a daemon pty.
const AGENT_PREFIX: &str = "agent_";

/// How long a daemon-served call waits on the backend for supporting data
/// (settings, the agent logs) before carrying on without it.
pub const AUX_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn str_arg(args: &[Value], i: usize) -> Option<&str> {
    arg(args, i).as_str()
}

fn is_agent(id: &str) -> bool {
    id.starts_with(AGENT_PREFIX)
}

pub async fn route(ctx: &Ctx, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    // Creation and execution-policy patches belong to the host, which owns defaults and setup.
    if channel == "session:create"
        || (channel == "session:setOptions"
            && ["executionMode", "sandbox", "gitIsolation"].iter().any(|key| arg(&args, 1).get(*key).is_some()))
    {
        return ctx.backend.call(channel, Value::Array(args)).await;
    }
    if matches!(channel, "loop:run" | "terminal:create" | "mcp:call") {
        if arg(&args, 0).get("executionMode").and_then(Value::as_str) == Some("sandbox") {
            return Err(format!("{channel} cannot execute sandbox work natively; use the host container router"));
        }
        let session_id = arg(&args, 0)
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| if channel == "mcp:call" { str_arg(&args, 1) } else { None });
        if let Some(id) = session_id {
            let session = if let Some(store) = &ctx.sessions {
                store.get(id).ok_or("Session not found")?
            } else {
                // Editions without a daemon store must ask the owning host.
                ctx.backend.call("session:get", json!([id])).await?
            };
            if session.get("id").and_then(Value::as_str) != Some(id)
                || !session.get("messages").is_some_and(Value::is_array)
            {
                return Err("Cannot verify session execution mode: session not found".into());
            }
            if session.get("executionMode").and_then(Value::as_str) == Some("sandbox") {
                return Err(format!("{channel} is unsupported for sandbox sessions; use the host container router"));
            }
        }
    }
    match channel {
        "daemon:info" => Ok(json!({
            "app": "nekkod",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "backend": match ctx.backend.state() {
                crate::backend::State::Disabled => "disabled",
                crate::backend::State::Starting => "starting",
                crate::backend::State::Ready { .. } => "ready",
                crate::backend::State::Down { .. } => "down",
            },
            "owned": owned(ctx),
        })),
        "terminals:list" => {
            let mut all = serde_json::to_value(ctx.terminals.list()).unwrap_or(json!([]));
            // The agent command logs still live in the TS host.
            // A starting backend must not hold the terminal list hostage.
            let agent = tokio::time::timeout(AUX_WAIT, ctx.backend.call("terminals:list:agent", json!([]))).await;
            if let Ok(Ok(Value::Array(agent))) = agent
                && let Value::Array(list) = &mut all
            {
                list.extend(agent);
            }
            Ok(all)
        }
        "terminals:list:native" => Ok(serde_json::to_value(ctx.terminals.list()).unwrap_or(json!([]))),
        "terminal:shells" => Ok(serde_json::to_value(detect_shells()).unwrap_or(json!([]))),
        "terminal:create" => create_terminal(ctx, arg(&args, 0)).await,
        "terminal:snapshot" | "terminal:update" | "terminal:write" | "terminal:resize" | "terminal:run"
        | "terminal:signal" | "terminal:close" => {
            let id = str_arg(&args, 0).unwrap_or_default().to_string();
            if is_agent(&id) {
                return ctx.backend.call(channel, Value::Array(args)).await;
            }
            terminal_op(ctx, channel, &id, &args)
        }
        "loop:run" => ctx.loops.start(ctx.backend.clone(), ctx.hub.clone(), arg(&args, 0).clone()),
        "loop:abort" => Ok(json!(ctx.loops.abort(str_arg(&args, 0).unwrap_or_default()))),
        "loop:alive" => Ok(json!(ctx.loops.is_running(str_arg(&args, 0).unwrap_or_default()))),
        "loop:steer" => Ok(json!(ctx.loops.steer(str_arg(&args, 0).unwrap_or_default(), arg(&args, 1).clone()))),
        "chat:turn" => ctx.turns.start(ctx.backend.clone(), ctx.hub.clone(), arg(&args, 0).clone()),
        "turn:abort" => Ok(json!(ctx.turns.abort(str_arg(&args, 0).unwrap_or_default()))),
        "turn:alive" => Ok(json!(ctx.turns.is_running(str_arg(&args, 0).unwrap_or_default()))),
        // The chats whose turn runs here, for a host that restarted mid-turn.
        "turn:running" => Ok(json!(ctx.turns.running_sessions())),
        "turn:steer" => Ok(json!(ctx.turns.steer(str_arg(&args, 0).unwrap_or_default(), arg(&args, 1).clone()))),
        "turn:approval" => ctx.turns.host_approval(
            ctx.backend.clone(),
            str_arg(&args, 0).unwrap_or_default(),
            args.get(1..).unwrap_or(&[]),
        ),
        // Only the daemon's own input: the host merges these with its turns' (daemon-turn.ts).
        "turn:pending" => Ok(ctx.turns.pending.snapshot()),
        "turn:approve" => Ok(json!(ctx.turns.pending.approve(
            str_arg(&args, 0).unwrap_or_default(),
            str_arg(&args, 1).unwrap_or_default(),
            arg(&args, 2) == &json!(true)
        ))),
        "turn:answer" => Ok(json!(ctx.turns.pending.answer(
            str_arg(&args, 0).unwrap_or_default(),
            str_arg(&args, 1).unwrap_or_default(),
            arg(&args, 2).clone()
        ))),
        // The UI's side of pending input: answered here when a daemon turn
        // waits on it, otherwise by the host (an in-process turn's).
        "tool:approve" => {
            let (sid, cid) = (str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
            if ctx.turns.pending.approve(sid, cid, arg(&args, 2) == &json!(true)) {
                return Ok(Value::Null);
            }
            ctx.backend.call(channel, Value::Array(args)).await
        }
        "chat:answer" => {
            let (sid, cid) = (str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
            if ctx.turns.pending.answer(sid, cid, arg(&args, 2).clone()) {
                return Ok(Value::Null);
            }
            ctx.backend.call(channel, Value::Array(args)).await
        }
        "chat:pending" => {
            let host = tokio::time::timeout(AUX_WAIT, ctx.backend.call("chat:pending:host", json!([]))).await;
            let host = match host {
                Ok(Ok(v)) if v.is_object() => v,
                _ => json!({}),
            };
            Ok(merge_pending(host, ctx.turns.pending.snapshot()))
        }
        "chat:running" => Ok(json!(running_chats(ctx).await)),
        "chat:steer" => {
            let sid = str_arg(&args, 0).unwrap_or_default().to_string();
            let content = nekko_js::trim(str_arg(&args, 1).unwrap_or_default()).to_string();
            if !content.is_empty()
                && ctx.turns.steer(&sid, crate::turns::Turns::steering_message(&content))
                && let Some(store) = &ctx.sessions
            {
                let store = store.clone();
                return tokio::task::spawn_blocking(move || store.get(&sid).unwrap_or(Value::Null))
                    .await
                    .map_err(|e| e.to_string());
            }
            ctx.backend.call(channel, Value::Array(args)).await
        }
        // Stop the daemon's turn at once, then the host's part of stopping
        // (its own turns, image turns, the chat's dev servers).
        "chat:abort" => {
            ctx.turns.abort_session(str_arg(&args, 0).unwrap_or_default());
            // A dev server the agent started belongs to the work it was doing.
            ctx.turns.processes.kill_session(str_arg(&args, 0).unwrap_or_default());
            ctx.backend.call(channel, Value::Array(args)).await
        }
        "changes:list" => {
            let (changes, id) = (ctx.loops.changes.clone(), str_arg(&args, 0).unwrap_or_default().to_string());
            let list =
                tokio::task::spawn_blocking(move || changes.list_changes(&id)).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(list).unwrap_or(json!([])))
        }
        "changes:accept" => {
            ctx.loops
                .changes
                .accept_change(str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
            Ok(Value::Null)
        }
        "changes:acceptAll" => {
            ctx.loops.changes.accept_all(str_arg(&args, 0).unwrap_or_default());
            Ok(Value::Null)
        }
        // The host snapshots a file here before its own tool executor writes it.
        "changes:record" => {
            let changes = ctx.loops.changes.clone();
            let (id, path) =
                (str_arg(&args, 0).unwrap_or_default().to_string(), str_arg(&args, 1).unwrap_or_default().to_string());
            tokio::task::spawn_blocking(move || changes.record_original(&id, &path))
                .await
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "mcp:sync" => Ok(ctx.mcp.sync(arg(&args, 0)).await),
        "mcp:hypergate" => {
            let base = crate::hypergate::base(crate::hypergate::port_arg(arg(&args, 0)), |k| std::env::var(k).ok());
            Ok(crate::hypergate::detect(&base).await.map_or(Value::Null, Value::Object))
        }
        // Probe and claim a token here; the host saves the entry (it owns the
        // settings) and hands back the server list, which this daemon runs.
        "mcp:hypergate:connect" => {
            let base = crate::hypergate::base(crate::hypergate::port_arg(arg(&args, 0)), |k| std::env::var(k).ok());
            let Some(info) = crate::hypergate::resolve(&base).await else { return Ok(Value::Null) };
            let info = Value::Object(info);
            let servers = ctx.backend.call("mcp:hypergate:save", json!([info])).await?;
            ctx.mcp.sync(&servers).await;
            Ok(info)
        }
        "mcp:call" => Ok(ctx.mcp.call(arg(&args, 0)).await),
        "provider:complete" => crate::sideband::complete(arg(&args, 0)).await,
        c if crate::accounts::CHANNELS.contains(&c) && ctx.accounts.enabled() => ctx.accounts.route(c, &args).await,
        // The daemon's settings store says where the data directory is.
        c if crate::decisions::CHANNELS.contains(&c) && ctx.settings.is_some() => {
            let data_dir =
                ctx.settings.as_ref().and_then(|s| s.store.path().parent().map(Path::to_path_buf)).unwrap_or_default();
            crate::decisions::route(ctx, &data_dir, c, &args).await
        }
        c if crate::context::CHANNELS.contains(&c) && ctx.settings.is_some() && ctx.sessions.is_some() => {
            crate::context::route(ctx, c, args).await
        }
        "chat:send" if ctx.admission.is_some() => {
            crate::admission::send(ctx, ctx.admission.as_ref().expect("checked"), args).await
        }
        c if crate::worktrees::CHANNELS.contains(&c) && ctx.settings.is_some() && ctx.sessions.is_some() => {
            crate::worktrees::route(ctx, c, &args).await
        }
        c if crate::providers::CHANNELS.contains(&c) && ctx.oauth.is_some() => {
            crate::providers::route(ctx, c, &args).await
        }
        c if crate::oauth::CHANNELS.contains(&c) && ctx.oauth.is_some() => {
            ctx.oauth.as_ref().expect("checked").route(c, &args).await
        }
        c if crate::catalog::CHANNELS.contains(&c) && ctx.catalog.is_some() => match &ctx.catalog {
            Some(catalog) => crate::catalog::route(catalog, c, &args).await,
            None => ctx.backend.call(c, Value::Array(args)).await,
        },
        c if crate::tooling::CHANNELS.contains(&c) => crate::tooling::route(ctx, c, &args).await,
        c if crate::settings::CHANNELS.contains(&c) && ctx.settings.is_some() => {
            crate::settings::route(ctx.settings.as_ref().expect("checked"), c, &args).await
        }
        c if crate::voice::CHANNELS.contains(&c) && ctx.voice.is_some() => match &ctx.voice {
            Some(voice) => voice.route(c, &args).await,
            None => Err("voice needs the data directory".into()),
        },
        c if crate::machine::CHANNELS.contains(&c) => crate::machine::route(&ctx.machine, c, &args).await,
        // Without a data directory the host keeps the coordinator file.
        "resource:queue" => match &ctx.resource_queue {
            Some(queue) => queue.route(&args).await,
            None => ctx.backend.call(channel, Value::Array(args)).await,
        },
        c if SESSION_CHANNELS.contains(&c) && ctx.sessions.is_some() => {
            session_op(ctx.sessions.clone().expect("checked"), ctx.backend.clone(), channel, args).await
        }
        _ => {
            if let Some(r) = crate::engine::route(&ctx.engine, channel, &args).await {
                return r;
            }
            ctx.backend.call(channel, Value::Array(args)).await
        }
    }
}

/// Merge the host's pending input with the daemon's, the daemon's winning
/// field by field (`mergePending` in daemon-turn.ts).
/// The chats with a turn running, the host's and the daemon's.
pub async fn running_chats(ctx: &Ctx) -> Vec<String> {
    let host = tokio::time::timeout(AUX_WAIT, ctx.backend.call("chat:running", json!([]))).await;
    let mut ids: Vec<String> = match host {
        Ok(Ok(Value::Array(a))) => a.into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    };
    for id in ctx.turns.running_sessions() {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

fn merge_pending(host: Value, daemon: Value) -> Value {
    let mut out = host.as_object().cloned().unwrap_or_default();
    for (id, p) in daemon.as_object().cloned().unwrap_or_default() {
        let mut entry = match out.get(&id) {
            Some(Value::Object(m)) => m.clone(),
            _ => {
                let mut m = serde_json::Map::new();
                m.insert("sessionId".into(), json!(id));
                m
            }
        };
        for (k, v) in p.as_object().cloned().unwrap_or_default() {
            if !v.is_null() {
                entry.insert(k, v);
            }
        }
        out.insert(id, Value::Object(entry));
    }
    Value::Object(out)
}

/// What `daemon:info` reports: the fixed table, and accounting when this
/// daemon knows the data directory. A host that delegates limits to a daemon
/// that would forward them straight back would loop, so they are only listed
/// when they are really served here.
fn owned(ctx: &Ctx) -> Vec<&'static str> {
    let mut all = OWNED.to_vec();
    all.extend_from_slice(crate::tooling::CHANNELS);
    if ctx.accounts.enabled() {
        all.extend_from_slice(crate::accounts::OWNED);
    }
    if ctx.catalog.is_some() {
        all.extend_from_slice(crate::catalog::CHANNELS);
    }
    if ctx.settings.is_some() {
        all.extend_from_slice(crate::decisions::CHANNELS);
    }
    if ctx.settings.is_some() {
        all.extend_from_slice(crate::settings::CHANNELS);
    }
    if ctx.voice.is_some() {
        all.extend_from_slice(crate::voice::CHANNELS);
    }
    if ctx.oauth.is_some() {
        all.extend_from_slice(crate::oauth::CHANNELS);
        all.extend_from_slice(crate::providers::CHANNELS);
    }
    if ctx.settings.is_some() && ctx.sessions.is_some() {
        all.extend_from_slice(crate::worktrees::CHANNELS);
    }
    if ctx.admission.is_some() {
        all.extend_from_slice(crate::admission::CHANNELS);
    }
    if ctx.settings.is_some() && ctx.sessions.is_some() {
        all.extend_from_slice(crate::context::CHANNELS);
    }
    all.extend_from_slice(crate::machine::CHANNELS);
    if ctx.resource_queue.is_some() {
        all.extend_from_slice(crate::resource_queue::CHANNELS);
    }
    all
}

/// Channels the daemon serves itself (reported by `daemon:info`).
pub const OWNED: &[&str] = &[
    "daemon:info",
    // Whole chat turns and the input they wait on (turns.rs).
    "chat:turn",
    "turn:abort",
    "turn:alive",
    "turn:running",
    "turn:steer",
    "turn:approval",
    "turn:pending",
    "turn:approve",
    "turn:answer",
    "tool:approve",
    "chat:answer",
    "chat:pending",
    "chat:running",
    "chat:steer",
    "chat:abort",
    "loop:run",
    // Not a channel: a capability. `loop:run` has no tool-step limit. The host
    // hands runs only to a daemon that says so, because daemons built before
    // the limit was removed read the host's budget as a real cap.
    "loop:unbounded",
    // Caching policy and usage counters survive every loop/provider boundary.
    "loop:prompt-caching",
    "loop:abort",
    "loop:alive",
    "loop:steer",
    "provider:complete",
    "provider:prompt-caching",
    "changes:list",
    "changes:accept",
    "changes:acceptAll",
    "changes:record",
    "mcp:sync",
    "mcp:call",
    "mcp:hypergate",
    "mcp:hypergate:connect",
    // Not a channel: a turn whose spec carries `facts.mcpServers` syncs and
    // calls its MCP servers here (turns.rs), approvals included.
    "turn:mcp",
    // Not a channel: a turn whose spec says `facts.spawn` drives its
    // `spawn_agent` children here, the host making them (`spawn:prepare`).
    "turn:spawn",
    // Not a channel: a turn whose spec carries `facts.hookRules` runs its
    // PreToolUse and PostToolUse hooks here (nekko-tools `hooks`).
    "turn:hooks",
    "sessions:summaries",
    "sessions:list",
    "sessions:clear",
    "session:get",
    "session:images",
    "session:create",
    "session:delete",
    "session:setOptions",
    "session:setWorkspace",
    "session:setSupportingWorkspaces",
    "session:setAttachments",
    "session:truncate",
    "spec:setLinked",
    "chat:queue",
    "chat:dequeue",
    "terminals:list",
    "terminals:list:native",
    "terminal:shells",
    "terminal:create",
    "terminal:snapshot",
    "terminal:update",
    "terminal:write",
    "terminal:resize",
    "terminal:run",
    "terminal:signal",
    "terminal:close",
    "infer:serve",
    "infer:stopServing",
    "infer:serving",
    "infer:spawn",
    "infer:kill",
    "infer:list",
    "infer:log",
    "decide:load",
    "decide:unload",
    "decide:status",
    "decide:run",
];

fn terminal_op(ctx: &Ctx, channel: &str, id: &str, args: &[Value]) -> Result<Value, String> {
    let reg = &ctx.terminals;
    match channel {
        "terminal:snapshot" => Ok(match reg.snapshot(id) {
            Some(s) => json!({
                "info": s.info,
                "buffer": String::from_utf8_lossy(&s.buffer),
                "cols": s.cols,
                "rows": s.rows,
            }),
            None => Value::Null,
        }),
        "terminal:update" => {
            let patch = arg(args, 1);
            reg.update(
                id,
                UpdatePatch {
                    workspace_id: patch.get("workspaceId").map(|v| v.as_str().map(str::to_string)),
                    order: patch.get("order").and_then(Value::as_f64),
                    title: patch.get("title").and_then(Value::as_str).map(str::to_string),
                },
            );
            Ok(Value::Null)
        }
        "terminal:write" => {
            if let Some(data) = str_arg(args, 1) {
                reg.write(id, data.as_bytes());
            }
            Ok(Value::Null)
        }
        "terminal:resize" => {
            let cols = arg(args, 1).as_u64().unwrap_or(80).min(u16::MAX as u64) as u16;
            let rows = arg(args, 2).as_u64().unwrap_or(24).min(u16::MAX as u64) as u16;
            reg.resize(id, cols, rows);
            Ok(Value::Null)
        }
        "terminal:run" => {
            if let Some(cmd) = str_arg(args, 1) {
                reg.run(id, cmd);
            }
            Ok(Value::Null)
        }
        "terminal:signal" => {
            reg.interrupt(id);
            Ok(Value::Null)
        }
        "terminal:close" => {
            reg.close(id);
            Ok(Value::Null)
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// Where a new terminal starts: the explicit directory, else the project's,
/// else the first project's, else home. Needs the user's settings, which the
/// TS host still owns.
fn resolve_cwd(settings: &Value, workspace_id: Option<&str>, cwd: Option<&str>) -> PathBuf {
    if let Some(c) = cwd.filter(|c| Path::new(c).is_dir()) {
        return c.into();
    }
    let workspaces = settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
    let path_of = |w: &Value| w.get("path").and_then(Value::as_str).map(str::to_string);
    if let Some(id) = workspace_id
        && let Some(p) = workspaces
            .iter()
            .find(|w| w.get("id").and_then(Value::as_str) == Some(id))
            .and_then(path_of)
            .filter(|p| Path::new(p).is_dir())
    {
        return p.into();
    }
    if let Some(p) = workspaces.first().and_then(path_of).filter(|p| Path::new(p).is_dir()) {
        return p.into();
    }
    home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

async fn create_terminal(ctx: &Ctx, opts: &Value) -> Result<Value, String> {
    let settings = crate::settings::current(ctx).await;
    let s = |k: &str| opts.get(k).and_then(Value::as_str);
    let dim = |k: &str, d: u16| opts.get(k).and_then(Value::as_u64).map(|n| n.clamp(1, 1000) as u16).unwrap_or(d);
    let shell = resolve_shell(s("shell"), settings.get("defaultShellPath").and_then(Value::as_str));
    let spec = CreateSpec {
        title: s("title").map(str::to_string),
        workspace_id: s("workspaceId").map(str::to_string),
        cwd: resolve_cwd(&settings, s("workspaceId"), s("cwd")),
        shell,
        cols: dim("cols", 80),
        rows: dim("rows", 24),
        env: Vec::new(),
    };
    Ok(serde_json::to_value(ctx.terminals.create(spec)).unwrap_or(Value::Null))
}

/// Mirror the registry's events onto the JSON bus as `terminal:event`.
pub fn forward_terminal_events(ctx: &Ctx) {
    let mut rx = ctx.terminals.events();
    let hub = ctx.hub.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(RegistryEvent::Data { id, text }) => {
                    hub.publish("terminal:event", json!({ "type": "data", "terminalId": id, "data": text }), true)
                }
                Ok(RegistryEvent::Exit { id, code }) => {
                    hub.publish("terminal:event", json!({ "type": "exit", "terminalId": id, "code": code }), false)
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

/// The channels `nekko-store` serves when the daemon knows the data dir.
/// Running-turn checkpoints still stay with the TS host (PF14).
const SESSION_CHANNELS: &[&str] = &[
    "sessions:summaries",
    "sessions:list",
    "sessions:clear",
    "session:get",
    "session:images",
    "session:create",
    "session:delete",
    "session:setOptions",
    "session:setWorkspace",
    "session:setSupportingWorkspaces",
    "session:setAttachments",
    "session:truncate",
    "spec:setLinked",
    "chat:queue",
    "chat:dequeue",
];

/// Session reads and the UI's own writes, off the async threads: a listing
/// reads every changed chat file, and one image chat can be tens of megabytes.
async fn session_op(
    store: Arc<nekko_store::SessionStore>,
    backend: Arc<Backend>,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let channel = channel.to_string();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let id = str_arg(&args, 0).unwrap_or_default();
        let delete_log = |id: &str| runtime.block_on(backend.call("sessions:deleteAgentLog", json!([id]))).map(|_| ());
        let or_null = |r: Result<Option<Value>, String>| r.map(|v| v.unwrap_or(Value::Null));
        match channel.as_str() {
            "sessions:summaries" => Ok(Value::Array(store.summaries())),
            "sessions:list" => Ok(Value::Array(store.list())),
            "sessions:clear" => store.clear_with(id, delete_log).map(|n| json!(n)),
            "session:get" => Ok(store.get(id).unwrap_or(Value::Null)),
            "session:images" => Ok(Value::Array(store.images(id, arg(&args, 1).as_f64().unwrap_or(1.0)))),
            "session:create" => store.create(str_arg(&args, 0)),
            "session:delete" => {
                delete_log(id)?;
                store.delete(id).map(|()| Value::Null)
            }
            "session:setOptions" => {
                if arg(&args, 1).get("executionMode").is_some() || arg(&args, 1).get("sandbox").is_some() {
                    return Err("Execution mode changes require the host setup route".into());
                }
                or_null(store.set_options(id, arg(&args, 1)))
            }
            "session:setWorkspace" => or_null(store.set_workspace(id, str_arg(&args, 1))),
            "session:setSupportingWorkspaces" => or_null(store.set_supporting(id, arg(&args, 1))),
            "session:setAttachments" => or_null(store.set_attachments(id, arg(&args, 1))),
            "session:truncate" => or_null(store.truncate(id, arg(&args, 1))),
            "spec:setLinked" => or_null(store.set_spec_linked(id, arg(&args, 1))),
            "chat:queue" => or_null(store.queue(id, arg(&args, 1))),
            "chat:dequeue" => or_null(store.dequeue(id, arg(&args, 1))),
            other => Err(format!("{other} is not a session channel")),
        }
    })
    .await
    .map_err(|e| format!("session call failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_prefers_the_explicit_directory_then_the_project() {
        let tmp = std::env::temp_dir();
        let t = tmp.to_string_lossy().to_string();
        let settings = json!({ "workspaces": [{ "id": "w1", "path": t }] });
        assert_eq!(resolve_cwd(&settings, None, Some(&t)), tmp);
        assert_eq!(resolve_cwd(&settings, Some("w1"), Some("/no/such/dir")), tmp);
        assert_eq!(resolve_cwd(&settings, Some("missing"), None), tmp);
    }

    #[test]
    fn info_says_the_loop_has_no_step_limit() {
        // packages/host/src/daemon-loop.ts daemonRunsLoops needs both, or the
        // host keeps every run in process.
        assert!(OWNED.contains(&"loop:run"));
        assert!(OWNED.contains(&"loop:unbounded"));
        assert!(OWNED.contains(&"loop:prompt-caching"));
        assert!(OWNED.contains(&"provider:prompt-caching"));
    }

    #[test]
    fn pending_input_merges_with_the_daemons_winning() {
        let host = json!({ "s1": { "sessionId": "s1", "question": { "callId": "q" } }, "s2": { "sessionId": "s2", "approval": { "x": 1 } } });
        let daemon = json!({ "s1": { "sessionId": "s1", "approval": { "y": 2 } }, "s3": { "sessionId": "s3", "question": { "callId": "z" } } });
        let merged = merge_pending(host, daemon);
        assert_eq!(merged["s1"], json!({ "sessionId": "s1", "question": { "callId": "q" }, "approval": { "y": 2 } }));
        assert_eq!(merged["s2"]["approval"], json!({ "x": 1 }));
        assert_eq!(merged["s3"]["question"]["callId"], "z");
    }

    #[test]
    fn agent_logs_are_recognised() {
        assert!(is_agent("agent_s1"));
        assert!(!is_agent("term_abc_1"));
    }
}
