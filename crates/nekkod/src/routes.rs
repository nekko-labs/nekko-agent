//! Channel routing: every channel the daemon serves, and `unknown channel`
//! for any other.

use crate::hub::Hub;
use nekko_term::{
    CreateSpec, Registry, RegistryEvent, TAIL_DEFAULT, TAIL_MAX, TerminalViewer, UpdatePatch, detect_shells,
    resolve_shell,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct Ctx {
    pub terminals: Arc<Registry>,
    pub hub: Hub,
    pub engine: Arc<crate::engine::Engine>,
    /// Session reads (`nekko-store`), when the data directory is known.
    pub sessions: Option<Arc<nekko_store::SessionStore>>,
    /// Pending changes the agent's file tools recorded (`changes:*`).
    pub changes: Arc<nekko_tools::ChangeTracker>,
    /// MCP servers, synced and called by turns (and `mcp:sync`, `mcp:call`).
    pub mcp: Arc<crate::mcp::Mcp>,
    /// Whole chat turns (`chat:turn`) and the input they wait on.
    pub turns: Arc<crate::turns::Turns>,
    /// Usage, reply and limit accounting (`usage:summary`, `limits:*`).
    pub accounts: Arc<crate::accounts::Accounts>,
    /// settings.json, when the data directory is known (`settings:*`).
    pub settings: Option<Arc<crate::settings::Settings>>,
    /// Nekko Voice (`voice:*`), when the data directory is known.
    pub voice: Option<Arc<crate::voice::Voice>>,
    /// Nekko Cloud sign-in and end-to-end encrypted sync (`cloud:*`, `sync:*`), with the data directory.
    pub cloud: Option<Arc<nekko_cloud::Cloud>>,
    /// Sign-in and tokens.json, when the data directory is known (`oauth:*`).
    pub oauth: Option<Arc<crate::oauth::OAuth>>,
    /// `chat:send` admitted here, when the daemon owns settings, tokens and sessions.
    pub admission: Option<Arc<crate::admission::Admission>>,
    /// The model catalog, when the daemon has the settings store (for the Hugging Face token).
    pub catalog: Option<Arc<nekko_engine::catalog::Catalog>>,
    /// Files, memory, comments and the workspace index (`workspace:*`, `file:*`).
    pub workspace: Arc<crate::workspace::Workspace>,
    /// Automation tasks and their scheduler (`tasks:*`, `task:*`).
    pub automation: Arc<crate::automation::Automation>,
    /// Phone remote access (`remote:*`) and the relay agent.
    pub remote: Arc<crate::remote::Remote>,
    /// Settings → Security and the step-up check on the desktop's and the
    /// Local Web UI's guarded calls (`security:*`, SK-4/SK-5). Reached from the
    /// wire only (wire.rs), never through `route`, so a phone cannot call it.
    pub security: Arc<crate::security::Security>,
    /// GPU and system stats, the readiness advisor, the hardware profile and model
    /// recommendations (`gpu:stats`, `system:stats`, `machine:*`).
    pub machine: Arc<nekko_machine::Machine>,
    /// CI runners (`runner:*`), when the data directory is known.
    pub runners: Option<Arc<crate::runner::Runners>>,
    /// The experimental resource-queue client, when the data directory is known.
    pub resource_queue: Option<Arc<crate::resource_queue::ResourceQueue>>,
    /// Sandbox chats' containers (sandbox.rs), with a data directory.
    pub sandboxes: Option<Arc<crate::sandbox::Sandboxes>>,
    /// The runtime control plane, with the settings store.
    pub runtimes: Option<Arc<nekko_engine::runtimes::Runtimes>>,
    /// The model library and its folders (`engine:models`...), with the settings store.
    pub library: Option<Arc<crate::library::Library>>,
    /// Model downloads (`engine:downloadModel`...), with the library and the catalog.
    pub downloads: Option<Arc<crate::downloads::ModelDownloads>>,
    /// The runtime installers (`engine:install`...), with the downloads.
    pub installs: Option<Arc<crate::installs::Installs>>,
    /// The model server's policy (`engine:status`...), with the installers.
    pub server: Option<Arc<crate::model_server::Server>>,
    /// Chats being compacted (`chat:compact`), the daemon's when it admits turns.
    pub compactions: Arc<crate::compaction::Compactions>,
    /// Image-generation turns (`chat:generateImage`), with the model server.
    pub image_turns: Arc<crate::image_turns::ImageTurns>,
    /// What `app:info` reports, and the desktop bridge `workspace:add` opens the picker through.
    pub app: Arc<AppCtx>,
    /// The catalog refresh checks (`updates:check`) and their scheduler.
    pub update_checks: Arc<crate::small_services::UpdateChecks>,
    /// The Claude policy: the shipped table, a verified signed override, and
    /// the dev-only preview (`claude:*`, and the gates the Claude paths call).
    pub claude_policy: Arc<crate::claude_policy::ClaudePolicyStore>,
    /// The messaging bridges (`messaging:status`), with a data directory.
    pub messaging: Option<Arc<crate::messaging::Messaging>>,
    /// What Electron main used to answer (dialogs, shell, microphone, updater), for the desktop app.
    pub native: Option<Arc<crate::native::Native>>,
    /// What the TS desktop backend used to serve (the local API server, CLI install, the
    /// webhook listener, the local relay, network visibility), for the desktop app.
    pub desktop: Option<Arc<crate::desktop::Desktop>>,
}

/// The app around the daemon: its facts and the desktop bridge.
#[derive(Default)]
pub struct AppCtx {
    pub facts: crate::small_services::AppFacts,
    /// `(url, token)` of Electron main's bridge (`config.browserBridge`).
    pub bridge: Option<(String, String)>,
    /// Where the decision models' release is (`config.decisionModelsUrl`); absent, the pinned one.
    pub decision_models_url: Option<String>,
}

/// The small services (small_services.rs) are the daemon's with a data
/// directory, the settings and the sessions.
fn owns_small_services(ctx: &Ctx) -> bool {
    ctx.sessions.is_some() && ctx.settings.is_some()
}

/// `chat:compact` and `chat:cancelCompaction` are the daemon's when it admits turns.
fn owns_compaction(ctx: &Ctx) -> bool {
    ctx.sessions.is_some() && ctx.settings.is_some() && ctx.admission.is_some()
}

/// `chat:generateImage` is the daemon's when it runs the model server and admits turns.
fn owns_image_turns(ctx: &Ctx) -> bool {
    ctx.server.is_some() && owns_compaction(ctx)
}

/// Terminals whose ids start with this are the read-only agent command logs
/// (agent_logs.rs); everything else is a daemon pty.
const AGENT_PREFIX: &str = "agent_";

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
    // With no data directory there are no chats to make or set up.
    if ctx.sessions.is_none()
        && (channel == "session:create"
            || (channel == "session:setOptions"
                && ["executionMode", "sandbox", "gitIsolation"].iter().any(|key| arg(&args, 1).get(*key).is_some())))
    {
        return Err(NO_SESSIONS.into());
    }
    if channel == "session:create" {
        return create_session(ctx, arg(&args, 0).as_str(), None, None).await;
    }
    if channel == "session:setOptions"
        && ["executionMode", "gitIsolation"].iter().any(|key| arg(&args, 1).get(*key).is_some())
    {
        let id = str_arg(&args, 0).unwrap_or_default();
        let busy = ctx.turns.running_sessions().iter().any(|s| s == id)
            || ctx.admission.as_ref().is_some_and(|a| a.is_admitting(id));
        if busy {
            return Err("Wait for the current reply to finish before changing this chat's Git isolation.".into());
        }
    }
    if matches!(channel, "terminal:create" | "mcp:call" | "ssh:open") {
        // `ssh:open(alias, opts)` carries its options second.
        let opts = arg(&args, if channel == "ssh:open" { 1 } else { 0 });
        if opts.get("executionMode").and_then(Value::as_str) == Some("sandbox") {
            return Err(format!("{channel} cannot execute sandbox work natively; use the host container router"));
        }
        let session_id = opts
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| if channel == "mcp:call" { str_arg(&args, 1) } else { None });
        if let Some(id) = session_id {
            let (store, sid) = (ctx.sessions.clone().ok_or(NO_SESSIONS)?, id.to_string());
            // Only the chat's own fields are read: its transcript is skipped, off the async workers.
            let session = tokio::task::spawn_blocking(move || store.meta(&sid))
                .await
                .map_err(|e| e.to_string())?
                .ok_or("Session not found")?;
            if session.get("id").and_then(Value::as_str) != Some(id) || !session.messages_array {
                return Err("Cannot verify session execution mode: session not found".into());
            }
            if session.get("executionMode").and_then(Value::as_str) == Some("sandbox") {
                return Err(format!("{channel} is unsupported for sandbox sessions; use the host container router"));
            }
        }
    }
    match channel {
        "claude:policy" => Ok(ctx.claude_policy.status()),
        "claude:capability" => crate::claude_policy::capability_route(ctx, &args).await,
        "claude:planUsage" => crate::claude_policy::plan_usage_route(ctx, &args).await,
        "claude:codeStatus" => crate::claude_policy::code_status_route(ctx, &args).await,
        "daemon:info" => Ok(json!({
            "app": "nekkod",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
        })),
        "terminals:list" => {
            // `{ sessionId }` narrows it to one chat's terminals and its agent log.
            let only = arg(&args, 0).get("sessionId").and_then(Value::as_str);
            let mut native = ctx.terminals.list();
            let mut agent = ctx.turns.agent_logs.as_ref().map(|logs| logs.list()).unwrap_or_default();
            if let Some(sid) = only {
                native.retain(|t| t.session_id.as_deref() == Some(sid));
                agent.retain(|t| t.get("agentSessionId").and_then(Value::as_str) == Some(sid));
            }
            let mut all = serde_json::to_value(native).unwrap_or(json!([]));
            if let Value::Array(list) = &mut all {
                list.extend(agent);
            }
            Ok(all)
        }
        "terminals:list:native" => Ok(serde_json::to_value(ctx.terminals.list()).unwrap_or(json!([]))),
        "terminal:shells" => Ok(serde_json::to_value(detect_shells()).unwrap_or(json!([]))),
        "terminal:create" => create_terminal(ctx, arg(&args, 0)).await,
        "terminal:snapshot" | "terminal:tail" => {
            let id = str_arg(&args, 0).unwrap_or_default().to_string();
            let max = tail_bytes(channel, &args);
            if is_agent(&id) {
                let snap = match &ctx.turns.agent_logs {
                    Some(logs) => logs.route("terminal:snapshot", &id, &args).await?,
                    None => return Err(NO_SESSIONS.into()),
                };
                return Ok(match max {
                    Some(max) => cap_buffer(snap, max),
                    None => snap,
                });
            }
            Ok(native_snapshot(&ctx.terminals, &id, max))
        }
        "terminal:update" | "terminal:write" | "terminal:resize" | "terminal:run" | "terminal:signal"
        | "terminal:close" => {
            let id = str_arg(&args, 0).unwrap_or_default().to_string();
            if is_agent(&id) {
                return match &ctx.turns.agent_logs {
                    Some(logs) => logs.route(channel, &id, &args).await,
                    None => Err(NO_SESSIONS.into()),
                };
            }
            terminal_op(ctx, channel, &id, &args)
        }
        "terminal:attach" => attach_viewer(&ctx.terminals, str_arg(&args, 0).unwrap_or_default(), arg(&args, 1)),
        "terminal:detach" => detach_viewer(&ctx.terminals, str_arg(&args, 0), str_arg(&args, 1).unwrap_or_default()),
        "ssh:hosts" => {
            let home = home_dir().ok_or("No home folder to read ~/.ssh/config from.")?;
            let hosts = tokio::task::spawn_blocking(move || nekko_term::read_ssh_hosts(&home))
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(hosts).unwrap_or(json!([])))
        }
        "ssh:open" => open_ssh(ctx, str_arg(&args, 0).unwrap_or_default(), arg(&args, 1)).await,
        "chat:turn" => ctx.turns.start(ctx.hub.clone(), arg(&args, 0).clone()),
        "turn:abort" => Ok(json!(ctx.turns.abort(str_arg(&args, 0).unwrap_or_default()))),
        "turn:alive" => Ok(json!(ctx.turns.is_running(str_arg(&args, 0).unwrap_or_default()))),
        // The chats whose turn runs here.
        "turn:running" => Ok(json!(ctx.turns.running_sessions())),
        "turn:steer" => Ok(json!(ctx.turns.steer(str_arg(&args, 0).unwrap_or_default(), arg(&args, 1).clone()))),
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
            ctx.turns.pending.approve(sid, cid, arg(&args, 2) == &json!(true));
            Ok(Value::Null)
        }
        "chat:answer" => {
            let (sid, cid) = (str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
            ctx.turns.pending.answer(sid, cid, arg(&args, 2).clone());
            Ok(Value::Null)
        }
        "chat:pending" => Ok(merge_pending(json!({}), ctx.turns.pending.snapshot())),
        "chat:running" => Ok(json!(running_chats(ctx))),
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
            // Nothing running to steer: the text waits for after the turn, as `steerChat` queued it.
            let Some(store) = ctx.sessions.clone() else { return Ok(Value::Null) };
            if content.is_empty() {
                return tokio::task::spawn_blocking(move || store.get(&sid).unwrap_or(Value::Null))
                    .await
                    .map_err(|e| e.to_string());
            }
            tokio::task::spawn_blocking(move || store.queue(&sid, &json!(content)).map(|s| s.unwrap_or(Value::Null)))
                .await
                .map_err(|e| e.to_string())?
        }
        // Stop the chat's turn, image turn and dev servers at once.
        "chat:abort" => stop_chat(ctx, str_arg(&args, 0).unwrap_or_default()).await,
        "changes:list" => {
            let (changes, id) = (ctx.changes.clone(), str_arg(&args, 0).unwrap_or_default().to_string());
            let list =
                tokio::task::spawn_blocking(move || changes.list_changes(&id)).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(list).unwrap_or(json!([])))
        }
        "changes:accept" => {
            ctx.changes.accept_change(str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
            Ok(Value::Null)
        }
        "changes:acceptAll" => {
            ctx.changes.accept_all(str_arg(&args, 0).unwrap_or_default());
            Ok(Value::Null)
        }
        // The host snapshots a file here before its own tool executor writes it.
        "changes:record" => {
            let changes = ctx.changes.clone();
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
        // Probe and claim a token here, save the entry, and run the server list.
        "mcp:hypergate:connect" => {
            let base = crate::hypergate::base(crate::hypergate::port_arg(arg(&args, 0)), |k| std::env::var(k).ok());
            let Some(info) = crate::hypergate::resolve(&base).await else { return Ok(Value::Null) };
            let info = Value::Object(info);
            let configured = crate::settings::current(ctx).await.get("mcpServers").and_then(Value::as_array).cloned();
            let list = crate::hypergate::with_hypergate(&configured.unwrap_or_default(), &info);
            let saved = crate::settings::update(ctx, json!({ "mcpServers": list })).await?;
            let servers = saved.get("mcpServers").cloned().unwrap_or(json!([]));
            ctx.mcp.sync(&servers).await;
            Ok(info)
        }
        "mcp:call" => Ok(ctx.mcp.call(arg(&args, 0)).await),
        // Internal: a `spawn_agent` call checked, its child made and its turn admitted (spawn.rs).
        "turn:spawnPrepare" if ctx.sessions.is_some() => Ok(crate::spawn::prepare(ctx, arg(&args, 0)).await),
        // Internal: one PR's live state, for an agent watch's snapshot (watches.rs).
        "watch:prInfo" => Ok(crate::workspace::pr_info(ctx, str_arg(&args, 0).unwrap_or_default()).await),
        // `mcpStatus`: sync the configured servers here, then report them.
        "mcp:status" if ctx.settings.is_some() => {
            let settings = crate::settings::current(ctx).await;
            let configs = settings.get("mcpServers").filter(|v| v.is_array()).cloned().unwrap_or(json!([]));
            let snapshot = ctx.mcp.sync(&configs).await;
            Ok(crate::mcp::status(&configs, &snapshot))
        }
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
        c if crate::side::CHANNELS.contains(&c) && crate::side::owned(ctx) => crate::side::route(ctx, c, &args).await,
        c if crate::privacy::CHANNELS.contains(&c) && ctx.settings.is_some() => {
            crate::privacy::route(ctx, c, &args).await
        }
        "chat:send" if ctx.admission.is_some() => {
            crate::admission::send(ctx, ctx.admission.as_ref().expect("checked"), args).await
        }
        "chat:interruptQueued" if ctx.admission.is_some() => {
            crate::admission::interrupt_queued(ctx, ctx.admission.as_ref().expect("checked"), args).await
        }
        c if crate::compaction::CHANNELS.contains(&c) && owns_compaction(ctx) => {
            ctx.compactions.clone().route(ctx, c, &args).await
        }
        "chat:generateImage" if owns_image_turns(ctx) => ctx.image_turns.generate(ctx, arg(&args, 0)).await,
        c if crate::worktrees::CHANNELS.contains(&c) && ctx.settings.is_some() && ctx.sessions.is_some() => {
            crate::worktrees::route(ctx, c, &args).await
        }
        c if crate::providers::CHANNELS.contains(&c) && ctx.oauth.is_some() => {
            crate::providers::route(ctx, c, &args).await
        }
        c if crate::oauth::CHANNELS.contains(&c) && ctx.oauth.is_some() => {
            ctx.oauth.as_ref().expect("checked").route(c, &args).await
        }
        c if crate::model_server::CHANNELS.contains(&c) && ctx.server.is_some() => {
            ctx.server.clone().expect("checked").route(c, &args).await
        }
        c if crate::installs::CHANNELS.contains(&c) && ctx.installs.is_some() => {
            ctx.installs.clone().expect("checked").route(c, &args).await
        }
        c if crate::downloads::CHANNELS.contains(&c) && ctx.downloads.is_some() => {
            ctx.downloads.clone().expect("checked").route(c, &args).await
        }
        c if crate::library::CHANNELS.contains(&c) && ctx.library.is_some() => {
            ctx.library.clone().expect("checked").route(c, &args).await
        }
        c if crate::catalog::CHANNELS.contains(&c) && ctx.catalog.is_some() => {
            crate::catalog::route(ctx.catalog.as_ref().expect("checked"), c, &args).await
        }
        c if crate::tooling::CHANNELS.contains(&c) => crate::tooling::route(ctx, c, &args).await,
        c if crate::runner::CHANNELS.contains(&c) && ctx.runners.is_some() => {
            ctx.runners.clone().expect("checked").route(c, &args).await
        }
        c if crate::telemetry::CHANNELS.contains(&c) => crate::telemetry::route(c, &args).await,
        c if crate::connections::CHANNELS.contains(&c) => {
            crate::connections::route(ctx.workspace.data_dir(), c, &args).await
        }
        c if crate::feedback::CHANNELS.contains(&c) => crate::feedback::route(ctx, c, &args).await,
        // An `agent_watch` call outside a turn.
        "watch:tool" if ctx.turns.watches.is_some() => {
            let w = ctx.turns.watches.clone().expect("checked");
            w.tool(str_arg(&args, 0).unwrap_or_default(), arg(&args, 1))
                .await
                .map(Value::String)
                .or_else(|e| Ok(json!({ "error": e })))
        }
        "session:nextWatch" if ctx.turns.watches.is_some() => {
            Ok(ctx.turns.watches.as_ref().expect("checked").next_wake_at(str_arg(&args, 0).unwrap_or_default()))
        }
        "session:watches" if ctx.turns.watches.is_some() => {
            Ok(ctx.turns.watches.as_ref().expect("checked").views(str_arg(&args, 0).unwrap_or_default()))
        }
        c if crate::native::CHANNELS.contains(&c) && ctx.native.is_some() => {
            ctx.native.clone().expect("checked").route(ctx, c, &args).await
        }
        c if crate::desktop::CHANNELS.contains(&c) && ctx.desktop.is_some() => {
            ctx.desktop.clone().expect("checked").route(ctx, c, &args).await
        }
        c if crate::small_services::CHANNELS.contains(&c) && owns_small_services(ctx) => {
            crate::small_services::route(ctx, c, &args).await
        }
        c if crate::sandbox::CHANNELS.contains(&c) && ctx.sandboxes.is_some() => {
            ctx.sandboxes.clone().expect("checked").route(ctx, c, &args).await
        }
        c if crate::settings::CHANNELS.contains(&c) && ctx.settings.is_some() => {
            crate::settings::route(ctx.settings.as_ref().expect("checked"), c, &args).await
        }
        c if nekko_cloud::CHANNELS.contains(&c) && ctx.cloud.is_some() => match &ctx.cloud {
            Some(cloud) => cloud.route(c, &args).await,
            None => Err("Nekko Cloud needs the data directory".into()),
        },
        c if crate::voice::CHANNELS.contains(&c) && ctx.voice.is_some() => match &ctx.voice {
            Some(voice) => voice.route(c, &args).await,
            None => Err("voice needs the data directory".into()),
        },
        // What the agent linked in a chat, for a phone (#1095).
        c if crate::artifacts::CHANNELS.contains(&c) => crate::artifacts::route(ctx, c, &args).await,
        c if ctx.workspace.serves(c) => crate::workspace::route(ctx, c, &args).await,
        c if crate::logs::CHANNELS.contains(&c) && ctx.workspace.data_dir().is_some() => {
            crate::logs::route(ctx, c, &args).await
        }
        c if crate::automation::TASK_CHANNELS.contains(&c) && ctx.automation.owns_tasks() => {
            ctx.automation.route(c, &args).await
        }
        c if crate::automation::WORKFLOW_CHANNELS.contains(&c) && ctx.automation.owns_workflows() => {
            ctx.automation.route(c, &args).await
        }
        c if (crate::automation::TRAINING_CHANNELS.contains(&c) || c == crate::automation::TRAINING_TOOL)
            && ctx.automation.owns_training() =>
        {
            ctx.automation.route(c, &args).await
        }
        c if crate::connectors::CHANNELS.contains(&c) && crate::connectors::owned(ctx) => {
            crate::connectors::route(ctx, c, &args).await
        }
        c if crate::remote::CHANNELS.contains(&c) && ctx.remote.enabled() => ctx.remote.route(c, &args).await,
        c if crate::messaging::CHANNELS.contains(&c) && ctx.messaging.is_some() => {
            ctx.messaging.as_ref().expect("checked").route(c)
        }
        c if crate::runtimes::CHANNELS.contains(&c) && ctx.runtimes.is_some() => {
            crate::runtimes::route(ctx, ctx.runtimes.as_ref().expect("checked"), c, &args).await
        }
        crate::machine::SUMMARY => Ok(crate::machine::summary(ctx).await),
        c if crate::machine::CHANNELS.contains(&c) => {
            crate::machine::route(&ctx.machine, ctx.library.as_ref(), c, &args).await
        }
        c if crate::activity::CHANNELS.contains(&c) => crate::activity::route(ctx, c, &args).await,
        c if crate::background::CHANNELS.contains(&c) => Ok(ctx.turns.background_state()),
        "resource:queue" => match &ctx.resource_queue {
            Some(queue) => queue.route(&args).await,
            None => Err(NO_SESSIONS.into()),
        },
        c if SESSION_CHANNELS.contains(&c) && ctx.sessions.is_some() => {
            // A deleted Claude Agent chat's Claude Code child goes with it.
            if c == "session:delete"
                && let Some(id) = args.first().and_then(Value::as_str)
            {
                ctx.turns.harness.close(id).await;
            }
            session_op(ctx.sessions.clone().expect("checked"), ctx.turns.agent_logs.clone(), channel, args).await
        }
        _ => {
            if let Some(r) = crate::engine::route(&ctx.engine, channel, &args).await {
                return r;
            }
            if let Some(r) = crate::remote_image::route(ctx, channel, &args).await {
                return r;
            }
            if let Some(r) = crate::skill_sources::route(ctx, channel, &args).await {
                return r;
            }
            // The Local Web UI's GitHub review (repository_review.rs).
            if channel == "repository:review" && ctx.settings.is_some() {
                return crate::repository_review::review(ctx, arg(&args, 0)).await;
            }
            Err(format!("unknown channel {channel}"))
        }
    }
}

/// What a channel that needs the data directory says without one.
const NO_SESSIONS: &str = "this needs the daemon to know the data directory";

/// `chat:abort`: stop the daemon's turn at once (and its image turn and its
/// admission) and the chat's dev servers.
pub async fn stop_chat(ctx: &Ctx, session_id: &str) -> Result<Value, String> {
    if let Some(admission) = &ctx.admission {
        admission.abort(session_id);
    }
    ctx.image_turns.abort(session_id);
    ctx.turns.abort_session(session_id);
    // A dev server the agent started belongs to the work it was doing.
    ctx.turns.processes.kill_session(session_id);
    Ok(Value::Null)
}

/// The chats with a turn (or an image turn) running.
pub fn running_chats(ctx: &Ctx) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in ctx.turns.running_sessions().into_iter().chain(ctx.image_turns.running_sessions()) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// Merge the host's pending input with the daemon's, the daemon's winning
/// field by field (`mergePending` in daemon-turn.ts).
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

fn terminal_op(ctx: &Ctx, channel: &str, id: &str, args: &[Value]) -> Result<Value, String> {
    let reg = &ctx.terminals;
    match channel {
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

/// The scroll-back cap a snapshot call asks for: `terminal:tail(id, maxBytes?)`
/// always caps (64 KB unless named, never over `TAIL_MAX`),
/// `terminal:snapshot(id, { maxBytes })` only when asked.
fn tail_bytes(channel: &str, args: &[Value]) -> Option<usize> {
    if channel == "terminal:tail" {
        let asked = arg(args, 1).as_u64().map(|n| n as usize).unwrap_or(TAIL_DEFAULT);
        return Some(asked.min(TAIL_MAX));
    }
    arg(args, 1).get("maxBytes").and_then(Value::as_u64).map(|n| n as usize)
}

/// `{ info, buffer, cols, rows }` for a daemon pty, the buffer capped to its
/// last `max` bytes (with `truncated` and `totalBytes`) when asked.
fn native_snapshot(reg: &Registry, id: &str, max: Option<usize>) -> Value {
    let (s, total) = match max {
        Some(max) => match reg.tail(id, max) {
            Some((s, total)) => (s, Some(total)),
            None => return Value::Null,
        },
        None => match reg.snapshot(id) {
            Some(s) => (s, None),
            None => return Value::Null,
        },
    };
    let mut out = json!({
        "info": s.info,
        "buffer": String::from_utf8_lossy(&s.buffer),
        "cols": s.cols,
        "rows": s.rows,
    });
    if let Some(total) = total {
        out["truncated"] = json!(s.buffer.len() < total);
        out["totalBytes"] = json!(total);
    }
    out
}

/// Cap an already-built snapshot's `buffer` (an agent log's) the same way.
fn cap_buffer(mut snap: Value, max: usize) -> Value {
    let Some(buffer) = snap.get("buffer").and_then(Value::as_str) else { return snap };
    let bytes = buffer.as_bytes();
    let cut = nekko_term::tail_cut(bytes, max);
    // `tail_cut` never starts inside a UTF-8 character.
    let tail = String::from_utf8_lossy(&bytes[cut..]).into_owned();
    let total = bytes.len();
    snap["truncated"] = json!(cut > 0);
    snap["totalBytes"] = json!(total);
    snap["buffer"] = json!(tail);
    snap
}

/// `terminal:attach(id, { id, kind?, name? })`: a remote viewer (a phone)
/// is watching this terminal. Returns the terminal's viewers.
fn attach_viewer(reg: &Registry, id: &str, viewer: &Value) -> Result<Value, String> {
    if is_agent(id) {
        return Err("Agent command logs do not track viewers.".into());
    }
    let viewer_id =
        viewer.get("id").and_then(Value::as_str).filter(|v| !v.is_empty()).ok_or("A viewer needs an id.")?;
    let kind = viewer.get("kind").and_then(Value::as_str).filter(|k| !k.is_empty()).unwrap_or("phone");
    let name = viewer.get("name").and_then(Value::as_str).map(|n| n.chars().take(80).collect::<String>());
    let viewers = reg.attach_viewer(id, TerminalViewer::new(viewer_id, kind, name)).ok_or("Terminal not found")?;
    Ok(serde_json::to_value(viewers).unwrap_or(json!([])))
}

/// `terminal:detach(id, viewerId)`: the viewer left that terminal; returns its
/// viewers. `terminal:detach(null, viewerId)`: it left every terminal (its
/// connection dropped); returns the ids it was attached to.
fn detach_viewer(reg: &Registry, id: Option<&str>, viewer_id: &str) -> Result<Value, String> {
    if viewer_id.is_empty() {
        return Err("A viewer needs an id.".into());
    }
    match id {
        Some(id) => {
            let viewers = reg.detach_viewer(id, viewer_id).ok_or("Terminal not found")?;
            Ok(serde_json::to_value(viewers).unwrap_or(json!([])))
        }
        None => Ok(json!(reg.detach_viewer_everywhere(viewer_id))),
    }
}

/// `ssh:open(alias, { cols, rows, sessionId?, workspaceId? })`: a terminal
/// running the system `ssh` to a host alias from `~/.ssh/config`. The alias
/// must be one the config lists; it is passed as its own argument.
async fn open_ssh(ctx: &Ctx, alias: &str, opts: &Value) -> Result<Value, String> {
    let home = home_dir().ok_or("No home folder to read ~/.ssh/config from.")?;
    let alias = alias.to_string();
    let found = tokio::task::spawn_blocking(move || {
        let hosts = nekko_term::read_ssh_hosts(&home);
        nekko_term::ssh_shell(&hosts, &alias, nekko_term::find_ssh().as_deref()).map(|shell| (shell, home))
    })
    .await
    .map_err(|e| e.to_string())?;
    let (shell, home) = found?;
    let s = |k: &str| opts.get(k).and_then(Value::as_str).map(str::to_string);
    let spec = CreateSpec {
        title: Some(shell.label.clone()),
        workspace_id: s("workspaceId"),
        session_id: s("sessionId"),
        cwd: home,
        shell,
        cols: dim(opts, "cols", 80),
        rows: dim(opts, "rows", 24),
        env: Vec::new(),
    };
    Ok(serde_json::to_value(ctx.terminals.create(spec)).unwrap_or(Value::Null))
}

fn dim(opts: &Value, key: &str, default: u16) -> u16 {
    opts.get(key).and_then(Value::as_u64).map(|n| n.clamp(1, 1000) as u16).unwrap_or(default)
}

async fn create_terminal(ctx: &Ctx, opts: &Value) -> Result<Value, String> {
    let settings = crate::settings::current(ctx).await;
    let s = |k: &str| opts.get(k).and_then(Value::as_str);
    let shell = resolve_shell(s("shell"), settings.get("defaultShellPath").and_then(Value::as_str));
    // `claudeAccount`: a terminal for signing in to a second Claude Code
    // account, so a `claude` typed there uses that account's folder. Only a
    // checked account name is accepted, never a path or other variables.
    let env = match nekko_harness::account_config_dir(s("claudeAccount"))? {
        Some(dir) => vec![("CLAUDE_CONFIG_DIR".to_string(), dir.to_string_lossy().into_owned())],
        None => Vec::new(),
    };
    let spec = CreateSpec {
        title: s("title").map(str::to_string),
        workspace_id: s("workspaceId").map(str::to_string),
        session_id: s("sessionId").map(str::to_string),
        cwd: resolve_cwd(&settings, s("workspaceId"), s("cwd")),
        shell,
        cols: dim(opts, "cols", 80),
        rows: dim(opts, "rows", 24),
        env,
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
                Ok(RegistryEvent::Viewers { id, viewers }) => {
                    hub.publish("terminal:viewers", json!({ "terminalId": id, "viewers": viewers }), false)
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
    "sessions:purgeArchived",
    "session:get",
    "session:images",
    "session:create",
    "session:delete",
    "session:setOptions",
    "session:setWorkspace",
    "session:setSupportingWorkspaces",
    "session:setAttachments",
    "session:truncate",
    "session:fork",
    "spec:setLinked",
    "chat:queue",
    "chat:dequeue",
    "chat:editQueued",
];

/// `createSession(workspaceId, parentSessionId, supportingWorkspaceIds)` with
/// the host's check that the folder is one of the user's (`Workspace not
/// found`): the settings' execution mode, Git management and default saved
/// mode for a top-level chat, the parent's checkout for a sub-agent's.
pub async fn create_session(
    ctx: &Ctx,
    workspace_id: Option<&str>,
    parent_id: Option<&str>,
    supporting: Option<Value>,
) -> Result<Value, String> {
    let store = ctx.sessions.clone().ok_or("session:create needs the data directory")?;
    let settings = crate::settings::current(ctx).await;
    if let Some(w) = workspace_id.filter(|w| !w.is_empty()) {
        let known = settings
            .get("workspaces")
            .and_then(Value::as_array)
            .is_some_and(|ws| ws.iter().any(|f| f.get("id").and_then(Value::as_str) == Some(w)));
        if !known {
            return Err("Workspace not found".into());
        }
    }
    let (w, p) = (workspace_id.map(str::to_string), parent_id.map(str::to_string));
    tokio::task::spawn_blocking(move || {
        store.create_with_mode_defaults(w.as_deref(), p.as_deref(), supporting.as_ref(), &settings, true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `deleteAgentLog` for a chat being removed, from a blocking caller.
pub fn delete_agent_log(logs: Option<&crate::agent_logs::AgentLogs>, id: &str) -> Result<(), String> {
    match logs {
        Some(logs) => logs.delete_blocking(id),
        None => Ok(()),
    }
}

/// Session reads and the UI's own writes, off the async threads: a listing
/// reads every changed chat file, and one image chat can be tens of megabytes.
async fn session_op(
    store: Arc<nekko_store::SessionStore>,
    logs: Option<Arc<crate::agent_logs::AgentLogs>>,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let channel = channel.to_string();
    tokio::task::spawn_blocking(move || {
        let id = str_arg(&args, 0).unwrap_or_default();
        let delete_log = |id: &str| delete_agent_log(logs.as_deref(), id);
        let or_null = |r: Result<Option<Value>, String>| r.map(|v| v.unwrap_or(Value::Null));
        match channel.as_str() {
            "sessions:summaries" => Ok(Value::Array(store.summaries())),
            "sessions:list" => Ok(Value::Array(store.list())),
            "sessions:clear" => store.clear_with(id, delete_log).map(|n| json!(n)),
            "sessions:purgeArchived" => store.purge_archived(delete_log).map(|n| json!(n)),
            "session:get" => Ok(store.get(id).unwrap_or(Value::Null)),
            "session:images" => Ok(Value::Array(store.images(id, arg(&args, 1).as_f64().unwrap_or(1.0)))),
            "session:create" => store.create(str_arg(&args, 0)),
            "session:delete" => {
                delete_log(id)?;
                store.delete(id).map(|()| Value::Null)
            }
            // The execution-mode rules and the sandbox refusal are the store's (`setSessionOptions`).
            "session:setOptions" => or_null(store.set_options(id, arg(&args, 1))),
            "session:setWorkspace" => or_null(store.set_workspace(id, str_arg(&args, 1))),
            "session:setSupportingWorkspaces" => or_null(store.set_supporting(id, arg(&args, 1))),
            "session:setAttachments" => or_null(store.set_attachments(id, arg(&args, 1))),
            "session:truncate" => or_null(store.truncate(id, arg(&args, 1))),
            "session:fork" => or_null(store.fork(id, arg(&args, 1))),
            "spec:setLinked" => or_null(store.set_spec_linked(id, arg(&args, 1))),
            "chat:queue" => or_null(store.queue(id, arg(&args, 1))),
            "chat:dequeue" => or_null(store.dequeue(id, arg(&args, 1))),
            "chat:editQueued" => or_null(store.edit_queued(id, arg(&args, 1), arg(&args, 2))),
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
    fn pending_input_merges_with_the_daemons_winning() {
        let host = json!({ "s1": { "sessionId": "s1", "question": { "callId": "q" } }, "s2": { "sessionId": "s2", "approval": { "x": 1 } } });
        let daemon = json!({ "s1": { "sessionId": "s1", "approval": { "y": 2 } }, "s3": { "sessionId": "s3", "question": { "callId": "z" } } });
        let merged = merge_pending(host, daemon);
        assert_eq!(merged["s1"], json!({ "sessionId": "s1", "question": { "callId": "q" }, "approval": { "y": 2 } }));
        assert_eq!(merged["s2"]["approval"], json!({ "x": 1 }));
        assert_eq!(merged["s3"]["question"]["callId"], "z");
    }

    #[test]
    fn tail_sizes_default_cap_and_stay_optional_for_snapshots() {
        assert_eq!(tail_bytes("terminal:tail", &[json!("t")]), Some(TAIL_DEFAULT));
        assert_eq!(tail_bytes("terminal:tail", &[json!("t"), json!(1000)]), Some(1000));
        assert_eq!(tail_bytes("terminal:tail", &[json!("t"), json!(100_000_000)]), Some(TAIL_MAX));
        assert_eq!(tail_bytes("terminal:snapshot", &[json!("t")]), None);
        assert_eq!(tail_bytes("terminal:snapshot", &[json!("t"), json!({ "maxBytes": 10 })]), Some(10));
    }

    #[test]
    fn an_agent_log_snapshot_is_capped_on_a_character_boundary() {
        let snap = json!({ "info": { "id": "agent_s" }, "buffer": "line one\r\nab猫cd", "cols": 80, "rows": 24 });
        let capped = cap_buffer(snap.clone(), 4);
        assert_eq!(capped["buffer"], "cd");
        assert_eq!(capped["truncated"], true);
        assert_eq!(capped["totalBytes"], "line one\r\nab猫cd".len());
        let whole = cap_buffer(snap, 1000);
        assert_eq!((whole["buffer"].clone(), whole["truncated"].clone()), (json!("line one\r\nab猫cd"), json!(false)));
    }

    #[test]
    fn viewer_calls_need_an_id_and_skip_agent_logs() {
        let reg = Registry::new();
        assert!(attach_viewer(&reg, "agent_s1", &json!({ "id": "d" })).is_err());
        assert!(attach_viewer(&reg, "term_x", &json!({})).unwrap_err().contains("needs an id"));
        assert_eq!(attach_viewer(&reg, "term_x", &json!({ "id": "d" })).unwrap_err(), "Terminal not found");
        assert!(detach_viewer(&reg, None, "").is_err());
        assert_eq!(detach_viewer(&reg, None, "d").unwrap(), json!([]));
    }

    #[test]
    fn agent_logs_are_recognised() {
        assert!(is_agent("agent_s1"));
        assert!(!is_agent("term_abc_1"));
    }
}
