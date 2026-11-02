//! Channel routing: every channel the daemon serves, and `unknown channel`
//! for any other.

use crate::hub::Hub;
use nekko_term::{
    CreateSpec, Registry, RegistryEvent, TAIL_DEFAULT, TAIL_MAX, TerminalViewer, UpdatePatch, detect_shells,
    resolve_shell,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

type ProtectedSession = Arc<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct Ctx {
    pub terminals: Arc<Registry>,
    pub hub: Hub,
    pub engine: Arc<crate::engine::Engine>,
    /// Session reads (`nekko-store`).
    pub sessions: Arc<nekko_store::SessionStore>,
    /// Pending changes the agent's file tools recorded (`changes:*`).
    pub changes: Arc<nekko_tools::ChangeTracker>,
    /// MCP servers, synced and called by turns (and `mcp:sync`, `mcp:call`).
    pub mcp: Arc<crate::mcp::Mcp>,
    /// Whole chat turns (`chat:turn`) and the input they wait on.
    pub turns: Arc<crate::turns::Turns>,
    /// Usage, reply and limit accounting (`usage:summary`, `limits:*`).
    pub accounts: Arc<crate::accounts::Accounts>,
    /// settings.json (`settings:*`).
    pub settings: Arc<crate::settings::Settings>,
    /// Nekko Voice (`voice:*`).
    pub voice: Arc<crate::voice::Voice>,
    /// Nekko Cloud sign-in and end-to-end encrypted sync (`cloud:*`, `sync:*`).
    pub cloud: Arc<nekko_cloud::Cloud>,
    /// Sign-in and tokens.json (`oauth:*`).
    pub oauth: Arc<crate::oauth::OAuth>,
    /// `chat:send` admitted here.
    pub admission: Arc<crate::admission::Admission>,
    /// The model catalog (with the settings store, for the Hugging Face token).
    pub catalog: Arc<nekko_engine::catalog::Catalog>,
    /// Files, memory, comments and the workspace index (`workspace:*`, `file:*`).
    pub workspace: Arc<crate::workspace::Workspace>,
    /// Automation tasks and their scheduler (`tasks:*`, `task:*`).
    pub automation: Arc<crate::automation::Automation>,
    /// Phone remote access (`remote:*`) and the relay agent.
    pub remote: Arc<crate::remote::Remote>,
    /// This computer's Model Server, for connected computers (`model:*`).
    pub tunnel: Arc<crate::model_tunnel::Tunnel>,
    /// Links to other computers (`computers:*`), answered in wire.rs for the window only.
    pub computers: Arc<crate::computers::Computers>,
    /// Settings → Security and the step-up check on the desktop's and the
    /// Local Web UI's guarded calls (`security:*`, SK-4/SK-5). Reached from the
    /// wire only (wire.rs), never through `route`, so a phone cannot call it.
    pub security: Arc<crate::security::Security>,
    /// GPU and system stats, the readiness advisor, the hardware profile and model
    /// recommendations (`gpu:stats`, `system:stats`, `machine:*`).
    pub machine: Arc<nekko_machine::Machine>,
    /// CI runners (`runner:*`).
    #[cfg(unix)]
    pub runners: Arc<crate::runner::Runners>,
    /// The experimental resource-queue client.
    pub resource_queue: Arc<crate::resource_queue::ResourceQueue>,
    /// Sandbox chats' containers (sandbox.rs).
    pub sandboxes: Arc<crate::sandbox::Sandboxes>,
    /// The runtime control plane.
    pub runtimes: Arc<nekko_engine::runtimes::Runtimes>,
    /// The model library and its folders (`engine:models`...).
    pub library: Arc<crate::library::Library>,
    /// Model downloads (`engine:downloadModel`...).
    pub downloads: Arc<crate::downloads::ModelDownloads>,
    /// The runtime installers (`engine:install`...).
    pub installs: Arc<crate::installs::Installs>,
    /// The model server's policy (`engine:status`...).
    pub server: Arc<crate::model_server::Server>,
    /// Chats being compacted (`chat:compact`).
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
    /// The messaging bridges (`messaging:status`).
    pub messaging: Arc<crate::messaging::Messaging>,
    /// What Electron main used to answer (dialogs, shell, microphone, updater), for the desktop app.
    pub native: Option<Arc<crate::native::Native>>,
    /// What the TS desktop backend used to serve (the local API server, CLI install, the
    /// webhook listener, the local relay, network visibility), for the desktop app.
    pub desktop: Option<Arc<crate::desktop::Desktop>>,
    /// Which handler answers each channel ([`Table`]).
    pub routes: Arc<Table>,
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

/// A channel's reply, still to be awaited.
pub type Reply<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// What answers a channel: called with the context, the channel's name and its arguments.
pub type Handler = for<'a> fn(&'a Ctx, &'a str, Vec<Value>) -> Reply<'a>;

/// A [`Handler`] from a body that may use `ctx`, `channel` and `args` and
/// `return` early, as a match arm of the old router did.
macro_rules! handler {
    (|$ctx:ident, $channel:ident, $args:ident| $body:expr) => {{
        #[allow(unused_variables, unused_mut)]
        fn handle<'a>($ctx: &'a Ctx, $channel: &'a str, mut $args: Vec<Value>) -> Reply<'a> {
            Box::pin(async move { $body })
        }
        handle as Handler
    }};
}

/// Every channel the daemon serves, and its handler: built once at startup
/// from the services that exist, so a call is one hash lookup instead of a
/// walk down a long match. Each channel is registered once.
pub struct Table {
    handlers: HashMap<&'static str, Handler>,
    /// Channels registered twice: always empty (a unit test holds it so).
    twice: Vec<&'static str>,
}

impl Table {
    /// The first registration of a channel wins, as the first matching arm
    /// of the old router's match did; a second is recorded in `twice`.
    fn add(&mut self, channels: &[&'static str], h: Handler) {
        for c in channels {
            match self.handlers.entry(c) {
                std::collections::hash_map::Entry::Occupied(_) => self.twice.push(c),
                std::collections::hash_map::Entry::Vacant(v) => {
                    v.insert(h);
                }
            }
        }
    }

    pub fn get(&self, channel: &str) -> Option<Handler> {
        self.handlers.get(channel).copied()
    }

    /// The table for a daemon with these optional services: `native` (the
    /// desktop app's Electron-main channels, `Ctx::native`) and `desktop` (the
    /// desktop backend's, `Ctx::desktop`).
    pub fn new(native: bool, desktop: bool) -> Table {
        let mut t = Table { handlers: HashMap::new(), twice: Vec::new() };
        t.add(
            &["session:create"],
            handler!(|ctx, channel, args| create_session(ctx, arg(&args, 0).as_str(), None, None).await),
        );
        t.add(&["claude:policy"], handler!(|ctx, channel, args| Ok(ctx.claude_policy.status())));
        t.add(
            &["claude:capability"],
            handler!(|ctx, channel, args| crate::claude_policy::capability_route(ctx, &args).await),
        );
        t.add(
            &["claude:planUsage"],
            handler!(|ctx, channel, args| crate::claude_policy::plan_usage_route(ctx, &args).await),
        );
        t.add(
            &["claude:codeStatus"],
            handler!(|ctx, channel, args| crate::claude_policy::code_status_route(ctx, &args).await),
        );
        t.add(
            &["daemon:info"],
            handler!(|ctx, channel, args| Ok(json!({
                "app": "nekkod",
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
            }))),
        );
        t.add(
            &["terminals:list"],
            handler!(|ctx, channel, args| {
                // `{ sessionId }` narrows it to one chat's terminals and its agent log.
                let only = arg(&args, 0).get("sessionId").and_then(Value::as_str);
                let mut native = ctx.terminals.list();
                let mut agent = ctx.turns.agent_logs.list();
                if let Some(sid) = only {
                    native.retain(|t| t.session_id.as_deref() == Some(sid));
                    agent.retain(|t| t.get("agentSessionId").and_then(Value::as_str) == Some(sid));
                }
                let mut all = serde_json::to_value(native).unwrap_or(json!([]));
                if let Value::Array(list) = &mut all {
                    list.extend(agent);
                }
                Ok(all)
            }),
        );
        t.add(
            &["terminals:list:native"],
            handler!(|ctx, channel, args| Ok(serde_json::to_value(ctx.terminals.list()).unwrap_or(json!([])))),
        );
        t.add(
            &["terminal:shells"],
            handler!(|ctx, channel, args| Ok(serde_json::to_value(detect_shells()).unwrap_or(json!([])))),
        );
        t.add(&["terminal:create"], handler!(|ctx, channel, args| create_terminal(ctx, arg(&args, 0)).await));
        t.add(
            &["terminal:snapshot", "terminal:tail"],
            handler!(|ctx, channel, args| {
                let id = str_arg(&args, 0).unwrap_or_default().to_string();
                let max = tail_bytes(channel, &args);
                if is_agent(&id) {
                    let snap = ctx.turns.agent_logs.route("terminal:snapshot", &id, &args).await?;
                    return Ok(match max {
                        Some(max) => cap_buffer(snap, max),
                        None => snap,
                    });
                }
                Ok(native_snapshot(&ctx.terminals, &id, max))
            }),
        );
        t.add(
            &[
                "terminal:update",
                "terminal:write",
                "terminal:resize",
                "terminal:run",
                "terminal:signal",
                "terminal:close",
            ],
            handler!(|ctx, channel, args| {
                let id = str_arg(&args, 0).unwrap_or_default().to_string();
                if is_agent(&id) {
                    return ctx.turns.agent_logs.route(channel, &id, &args).await;
                }
                terminal_op(ctx, channel, &id, &args)
            }),
        );
        t.add(
            &["terminal:attach"],
            handler!(|ctx, channel, args| attach_viewer(
                &ctx.terminals,
                str_arg(&args, 0).unwrap_or_default(),
                arg(&args, 1)
            )),
        );
        t.add(
            &["terminal:detach"],
            handler!(|ctx, channel, args| detach_viewer(
                &ctx.terminals,
                str_arg(&args, 0),
                str_arg(&args, 1).unwrap_or_default()
            )),
        );
        t.add(
            &["ssh:hosts"],
            handler!(|ctx, channel, args| {
                let home = nekko_js::home_dir().ok_or("No home folder to read ~/.ssh/config from.")?;
                let hosts = tokio::task::spawn_blocking(move || nekko_term::read_ssh_hosts(&home))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(hosts).unwrap_or(json!([])))
            }),
        );
        t.add(
            &["ssh:open"],
            handler!(|ctx, channel, args| open_ssh(ctx, str_arg(&args, 0).unwrap_or_default(), arg(&args, 1)).await),
        );
        t.add(&["chat:turn"], handler!(|ctx, channel, args| ctx.turns.start(ctx.hub.clone(), arg(&args, 0).clone())));
        t.add(
            &["turn:abort"],
            handler!(|ctx, channel, args| Ok(json!(ctx.turns.abort(str_arg(&args, 0).unwrap_or_default())))),
        );
        t.add(
            &["turn:alive"],
            handler!(|ctx, channel, args| Ok(json!(ctx.turns.is_running(str_arg(&args, 0).unwrap_or_default())))),
        );
        // The chats whose turn runs here.
        t.add(&["turn:running"], handler!(|ctx, channel, args| Ok(json!(ctx.turns.running_sessions()))));
        t.add(
            &["turn:steer"],
            handler!(|ctx, channel, args| Ok(json!(
                ctx.turns.steer(str_arg(&args, 0).unwrap_or_default(), arg(&args, 1).clone())
            ))),
        );
        t.add(&["turn:pending"], handler!(|ctx, channel, args| Ok(ctx.turns.pending.snapshot())));
        t.add(
            &["turn:approve"],
            handler!(|ctx, channel, args| Ok(json!(ctx.turns.pending.approve(
                str_arg(&args, 0).unwrap_or_default(),
                str_arg(&args, 1).unwrap_or_default(),
                arg(&args, 2) == &json!(true)
            )))),
        );
        t.add(
            &["turn:answer"],
            handler!(|ctx, channel, args| Ok(json!(ctx.turns.pending.answer(
                str_arg(&args, 0).unwrap_or_default(),
                str_arg(&args, 1).unwrap_or_default(),
                arg(&args, 2).clone()
            )))),
        );
        // The UI's side of pending input: answered here when a daemon turn
        // waits on it, otherwise by the host (an in-process turn's).
        t.add(
            &["tool:approve"],
            handler!(|ctx, channel, args| {
                let (sid, cid) = (str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
                ctx.turns.pending.approve(sid, cid, arg(&args, 2) == &json!(true));
                Ok(Value::Null)
            }),
        );
        t.add(
            &["chat:answer"],
            handler!(|ctx, channel, args| {
                let (sid, cid) = (str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
                ctx.turns.pending.answer(sid, cid, arg(&args, 2).clone());
                Ok(Value::Null)
            }),
        );
        t.add(
            &["chat:pending"],
            handler!(|ctx, channel, args| Ok(merge_pending(json!({}), ctx.turns.pending.snapshot()))),
        );
        t.add(&["chat:running"], handler!(|ctx, channel, args| Ok(json!(running_chats(ctx)))));
        t.add(
            crate::model_tunnel::CHANNELS,
            handler!(|ctx, channel, args| ctx.tunnel.clone().route(ctx, channel, &args).await),
        );
        // A callable form of the replay a window's socket gets when it starts
        // showing a chat, for a paired computer that has no such socket.
        t.add(
            &["agent:replay"],
            handler!(|ctx, channel, args| {
                let id: std::sync::Arc<str> = str_arg(&args, 0).unwrap_or_default().into();
                let frame = ctx.hub.replay(&[id]).into_iter().next();
                let frame = frame.and_then(|(_, _, text)| serde_json::from_str::<Value>(&text).ok());
                Ok(frame.map_or(Value::Null, |mut f| f["payload"].take()))
            }),
        );
        t.add(
            &["chat:steer"],
            handler!(|ctx, channel, args| {
                let sid = str_arg(&args, 0).unwrap_or_default().to_string();
                let content = nekko_js::trim(str_arg(&args, 1).unwrap_or_default()).to_string();
                if !content.is_empty() && ctx.turns.steer(&sid, crate::turns::Turns::steering_message(&content)) {
                    let store = ctx.sessions.clone();
                    return tokio::task::spawn_blocking(move || store.get(&sid).unwrap_or(Value::Null))
                        .await
                        .map_err(|e| e.to_string());
                }
                // Nothing running to steer: the text waits for after the turn, as `steerChat` queued it.
                let store = ctx.sessions.clone();
                if content.is_empty() {
                    return tokio::task::spawn_blocking(move || store.get(&sid).unwrap_or(Value::Null))
                        .await
                        .map_err(|e| e.to_string());
                }
                tokio::task::spawn_blocking(move || {
                    store.queue(&sid, &json!(content)).map(|s| s.unwrap_or(Value::Null))
                })
                .await
                .map_err(|e| e.to_string())?
            }),
        );
        // Stop the chat's turn, image turn and dev servers at once.
        t.add(
            &["chat:abort"],
            handler!(|ctx, channel, args| stop_chat(ctx, str_arg(&args, 0).unwrap_or_default()).await),
        );
        t.add(
            &["changes:list"],
            handler!(|ctx, channel, args| {
                let (changes, id) = (ctx.changes.clone(), str_arg(&args, 0).unwrap_or_default().to_string());
                let list =
                    tokio::task::spawn_blocking(move || changes.list_changes(&id)).await.map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(list).unwrap_or(json!([])))
            }),
        );
        t.add(
            &["changes:accept"],
            handler!(|ctx, channel, args| {
                ctx.changes.accept_change(str_arg(&args, 0).unwrap_or_default(), str_arg(&args, 1).unwrap_or_default());
                Ok(Value::Null)
            }),
        );
        t.add(
            &["changes:acceptAll"],
            handler!(|ctx, channel, args| {
                ctx.changes.accept_all(str_arg(&args, 0).unwrap_or_default());
                Ok(Value::Null)
            }),
        );
        // The host snapshots a file here before its own tool executor writes it.
        t.add(
            &["changes:record"],
            handler!(|ctx, channel, args| {
                let changes = ctx.changes.clone();
                let (id, path) = (
                    str_arg(&args, 0).unwrap_or_default().to_string(),
                    str_arg(&args, 1).unwrap_or_default().to_string(),
                );
                tokio::task::spawn_blocking(move || changes.record_original(&id, &path))
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }),
        );
        t.add(&["mcp:sync"], handler!(|ctx, channel, args| Ok(ctx.mcp.sync(arg(&args, 0)).await)));
        t.add(
            &["mcp:hypergate"],
            handler!(|ctx, channel, args| {
                let base = crate::hypergate::base(crate::hypergate::port_arg(arg(&args, 0)), |k| std::env::var(k).ok());
                Ok(crate::hypergate::detect(&base).await.map_or(Value::Null, Value::Object))
            }),
        );
        // Probe and claim a token here, save the entry, and run the server list.
        t.add(
            &["mcp:hypergate:connect"],
            handler!(|ctx, channel, args| {
                let base = crate::hypergate::base(crate::hypergate::port_arg(arg(&args, 0)), |k| std::env::var(k).ok());
                let Some(info) = crate::hypergate::resolve(&base).await else { return Ok(Value::Null) };
                let info = Value::Object(info);
                let configured =
                    crate::settings::current(ctx).await.get("mcpServers").and_then(Value::as_array).cloned();
                let list = crate::hypergate::with_hypergate(&configured.unwrap_or_default(), &info);
                let saved = crate::settings::update(ctx, json!({ "mcpServers": list })).await?;
                let servers = saved.get("mcpServers").cloned().unwrap_or(json!([]));
                ctx.mcp.sync(&servers).await;
                Ok(info)
            }),
        );
        t.add(&["mcp:call"], handler!(|ctx, channel, args| Ok(ctx.mcp.call(arg(&args, 0)).await)));
        // Internal: a `spawn_agent` call checked, its child made and its turn admitted (spawn.rs).
        t.add(
            &["turn:spawnPrepare"],
            handler!(|ctx, channel, args| Ok(crate::spawn::prepare(ctx, arg(&args, 0)).await)),
        );
        // Internal: one PR's live state, for an agent watch's snapshot (watches.rs).
        t.add(
            &["watch:prInfo"],
            handler!(|ctx, channel, args| Ok(
                crate::workspace::pr_info(ctx, str_arg(&args, 0).unwrap_or_default()).await
            )),
        );
        // `mcpStatus`: sync the configured servers here, then report them.
        t.add(
            &["mcp:status"],
            handler!(|ctx, channel, args| {
                let settings = crate::settings::current(ctx).await;
                let configs = settings.get("mcpServers").filter(|v| v.is_array()).cloned().unwrap_or(json!([]));
                let snapshot = ctx.mcp.sync(&configs).await;
                Ok(crate::mcp::status(&configs, &snapshot))
            }),
        );
        t.add(&["provider:complete"], handler!(|ctx, channel, args| crate::sideband::complete(arg(&args, 0)).await));
        t.add(
            crate::accounts::CHANNELS,
            handler!(|ctx, channel, args| match crate::claude_policy::limits_key_provider(channel, &args) {
                Some(id) => crate::claude_policy::plan_usage_limits(ctx, id).await,
                None => ctx.accounts.route(channel, &args).await,
            }),
        );
        t.add(
            crate::decisions::CHANNELS,
            handler!(|ctx, channel, args| {
                crate::decisions::route(ctx, ctx.workspace.data_dir(), channel, &args).await
            }),
        );
        t.add(crate::context::CHANNELS, handler!(|ctx, channel, args| crate::context::route(ctx, channel, args).await));
        t.add(crate::side::CHANNELS, handler!(|ctx, channel, args| crate::side::route(ctx, channel, &args).await));
        t.add(
            crate::privacy::CHANNELS,
            handler!(|ctx, channel, args| crate::privacy::route(ctx, channel, &args).await),
        );
        t.add(&["chat:send"], handler!(|ctx, channel, args| crate::admission::send(ctx, &ctx.admission, args).await));
        t.add(
            &["chat:interruptQueued"],
            handler!(|ctx, channel, args| crate::admission::interrupt_queued(ctx, &ctx.admission, args).await),
        );
        t.add(
            crate::compaction::CHANNELS,
            handler!(|ctx, channel, args| ctx.compactions.clone().route(ctx, channel, &args).await),
        );
        t.add(
            &["chat:generateImage"],
            handler!(|ctx, channel, args| ctx.image_turns.generate(ctx, arg(&args, 0)).await),
        );
        t.add(
            crate::worktrees::CHANNELS,
            handler!(|ctx, channel, args| crate::worktrees::route(ctx, channel, &args).await),
        );
        t.add(
            crate::providers::CHANNELS,
            handler!(|ctx, channel, args| crate::providers::route(ctx, channel, &args).await),
        );
        t.add(crate::oauth::CHANNELS, handler!(|ctx, channel, args| ctx.oauth.route(channel, &args).await));
        t.add(
            crate::model_server::CHANNELS,
            handler!(|ctx, channel, args| ctx.server.clone().route(channel, &args).await),
        );
        t.add(
            crate::installs::CHANNELS,
            handler!(|ctx, channel, args| ctx.installs.clone().route(channel, &args).await),
        );
        t.add(
            crate::downloads::CHANNELS,
            handler!(|ctx, channel, args| ctx.downloads.clone().route(channel, &args).await),
        );
        t.add(crate::library::CHANNELS, handler!(|ctx, channel, args| ctx.library.clone().route(channel, &args).await));
        t.add(
            crate::catalog::CHANNELS,
            handler!(|ctx, channel, args| crate::catalog::route(&ctx.catalog, channel, &args).await),
        );
        t.add(
            crate::tooling::CHANNELS,
            handler!(|ctx, channel, args| crate::tooling::route(ctx, channel, &args).await),
        );
        // Elsewhere runner:* falls through to the unknown-channel reply.
        #[cfg(unix)]
        t.add(crate::runner::CHANNELS, handler!(|ctx, channel, args| ctx.runners.route(channel, &args).await));
        #[cfg(unix)]
        t.add(
            crate::runner::github_setup::CHANNELS,
            handler!(|ctx, channel, args| ctx.runners.route(channel, &args).await),
        );
        #[cfg(unix)]
        t.add(
            crate::runner::image::CHANNELS,
            handler!(|ctx, channel, args| ctx.runners.image_route(channel, &args).await),
        );
        t.add(crate::telemetry::CHANNELS, handler!(|ctx, channel, args| crate::telemetry::route(channel, &args).await));
        t.add(
            crate::connections::CHANNELS,
            handler!(|ctx, channel, args| {
                crate::connections::route(Some(ctx.workspace.data_dir()), channel, &args).await
            }),
        );
        t.add(
            crate::feedback::CHANNELS,
            handler!(|ctx, channel, args| crate::feedback::route(ctx, channel, &args).await),
        );
        // An `agent_watch` call outside a turn.
        t.add(
            &["watch:tool"],
            handler!(|ctx, channel, args| ctx
                .turns
                .watches
                .tool(str_arg(&args, 0).unwrap_or_default(), arg(&args, 1))
                .await
                .map(Value::String)
                .or_else(|e| Ok(json!({ "error": e })))),
        );
        t.add(
            &["session:nextWatch"],
            handler!(|ctx, channel, args| Ok(ctx.turns.watches.next_wake_at(str_arg(&args, 0).unwrap_or_default()))),
        );
        t.add(
            &["session:cancelWatch"],
            handler!(|ctx, channel, args| {
                ctx.turns
                    .watches
                    .tool(
                        str_arg(&args, 0).unwrap_or_default(),
                        &json!({ "action": "cancel", "id": str_arg(&args, 1).unwrap_or_default() }),
                    )
                    .await?;
                Ok(Value::Null)
            }),
        );
        t.add(
            &["session:watches"],
            handler!(|ctx, channel, args| Ok(ctx.turns.watches.views(str_arg(&args, 0).unwrap_or_default()))),
        );
        if native {
            t.add(
                crate::native::CHANNELS,
                handler!(|ctx, channel, args| match &ctx.native {
                    Some(native) => native.route(ctx, channel, &args).await,
                    None => Err(format!("unknown channel {channel}")),
                }),
            );
        }
        if desktop {
            t.add(
                crate::desktop::CHANNELS,
                handler!(|ctx, channel, args| match &ctx.desktop {
                    Some(desktop) => desktop.route(ctx, channel, &args).await,
                    None => Err(format!("unknown channel {channel}")),
                }),
            );
        }
        t.add(
            crate::small_services::CHANNELS,
            handler!(|ctx, channel, args| crate::small_services::route(ctx, channel, &args).await),
        );
        t.add(
            crate::sandbox::CHANNELS,
            handler!(|ctx, channel, args| ctx.sandboxes.clone().route(ctx, channel, &args).await),
        );
        t.add(
            crate::settings::CHANNELS,
            handler!(|ctx, channel, args| crate::settings::route(&ctx.settings, channel, &args).await),
        );
        t.add(nekko_cloud::CHANNELS, handler!(|ctx, channel, args| ctx.cloud.route(channel, &args).await));
        t.add(crate::voice::CHANNELS, handler!(|ctx, channel, args| ctx.voice.route(channel, &args).await));
        // What the agent linked in a chat, for a phone (#1095).
        t.add(
            crate::artifacts::CHANNELS,
            handler!(|ctx, channel, args| crate::artifacts::route(ctx, channel, &args).await),
        );
        {
            let h = handler!(|ctx, channel, args| crate::workspace::route(ctx, channel, &args).await);
            t.add(crate::workspace::CHANNELS, h);
            t.add(crate::workspace::DATA_CHANNELS, h);
        }
        t.add(crate::logs::CHANNELS, handler!(|ctx, channel, args| crate::logs::route(ctx, channel, &args).await));
        {
            let h = handler!(|ctx, channel, args| ctx.automation.route(channel, &args).await);
            t.add(crate::automation::TASK_CHANNELS, h);
            t.add(crate::automation::WORKFLOW_CHANNELS, h);
            t.add(crate::automation::TRAINING_CHANNELS, h);
            t.add(&[crate::automation::TRAINING_TOOL], h);
        }
        t.add(
            crate::connectors::CHANNELS,
            handler!(|ctx, channel, args| crate::connectors::route(ctx, channel, &args).await),
        );
        t.add(crate::remote::CHANNELS, handler!(|ctx, channel, args| ctx.remote.route(channel, &args).await));
        t.add(crate::messaging::CHANNELS, handler!(|ctx, channel, args| ctx.messaging.route(channel)));
        t.add(
            crate::runtimes::CHANNELS,
            handler!(|ctx, channel, args| crate::runtimes::route(ctx, &ctx.runtimes, channel, &args).await),
        );
        t.add(&[crate::machine::SUMMARY], handler!(|ctx, channel, args| Ok(crate::machine::summary(ctx).await)));
        t.add(
            crate::machine::CHANNELS,
            handler!(|ctx, channel, args| {
                crate::machine::route(&ctx.machine, Some(&ctx.library), channel, &args).await
            }),
        );
        t.add(
            crate::activity::CHANNELS,
            handler!(|ctx, channel, args| crate::activity::route(ctx, channel, &args).await),
        );
        t.add(crate::background::CHANNELS, handler!(|ctx, channel, args| Ok(ctx.turns.background_state())));
        t.add(&["resource:queue"], handler!(|ctx, channel, args| ctx.resource_queue.route(&args).await));
        t.add(
            SESSION_CHANNELS,
            handler!(|ctx, channel, args| {
                // A deleted Claude Agent chat's Claude Code child goes with it.
                if channel == "session:delete"
                    && let Some(id) = args.first().and_then(Value::as_str)
                {
                    ctx.turns.harness.close(id).await;
                }
                let closing = channel == "session:delete"
                    || (channel == "session:setOptions"
                        && arg(&args, 1).get("archivedAt").is_some_and(|v| !v.is_null()));
                let id = str_arg(&args, 0).unwrap_or_default().to_string();
                let protected: Option<ProtectedSession> = if channel == "sessions:clearHistory" {
                    let (turns, image_turns, admission) =
                        (ctx.turns.clone(), ctx.image_turns.clone(), ctx.admission.clone());
                    Some(Arc::new(move |id| {
                        turns.running_sessions().iter().any(|running| running == id)
                            || image_turns.running_sessions().iter().any(|running| running == id)
                            || admission.is_admitting(id)
                    }))
                } else {
                    None
                };
                let result = session_op(
                    ctx.sessions.clone(),
                    Some(ctx.turns.agent_logs.clone()),
                    Some(ctx.turns.watches.clone()),
                    protected,
                    channel,
                    args,
                )
                .await?;
                if closing {
                    stop_chat(ctx, &id).await?;
                }
                Ok(result)
            }),
        );
        {
            let h = handler!(|ctx, channel, args| match crate::engine::route(&ctx.engine, channel, &args).await {
                Some(r) => r,
                None => Err(format!("unknown channel {channel}")),
            });
            t.add(crate::engine::CHANNELS, h);
            t.add(crate::decide::CHANNELS, h);
        }
        t.add(
            crate::remote_image::CHANNELS,
            handler!(|ctx, channel, args| match crate::remote_image::route(ctx, channel, &args).await {
                Some(r) => r,
                None => Err(format!("unknown channel {channel}")),
            }),
        );
        t.add(
            crate::skill_sources::CHANNELS,
            handler!(|ctx, channel, args| match crate::skill_sources::route(ctx, channel, &args).await {
                Some(r) => r,
                None => Err(format!("unknown channel {channel}")),
            }),
        );
        // The Local Web UI's GitHub review (repository_review.rs).
        t.add(
            &["repository:review"],
            handler!(|ctx, channel, args| crate::repository_review::review(ctx, arg(&args, 0)).await),
        );
        debug_assert!(t.twice.is_empty(), "channels registered twice: {:?}", t.twice);
        t
    }
}

/// Answer one call: the checks every caller gets, then the channel's handler.
pub async fn route(ctx: &Ctx, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    if channel == "session:setOptions"
        && ["executionMode", "gitIsolation"].iter().any(|key| arg(&args, 1).get(*key).is_some())
    {
        let id = str_arg(&args, 0).unwrap_or_default();
        let busy = ctx.turns.running_sessions().iter().any(|s| s == id) || ctx.admission.is_admitting(id);
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
            let (store, sid) = (ctx.sessions.clone(), id.to_string());
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
    match ctx.routes.get(channel) {
        Some(handler) => handler(ctx, channel, args).await,
        None => Err(format!("unknown channel {channel}")),
    }
}

/// `chat:abort`: stop the daemon's turn at once (and its image turn and its
/// admission) and the chat's dev servers.
pub async fn stop_chat(ctx: &Ctx, session_id: &str) -> Result<Value, String> {
    // Include detached delegated descendants: their parent turn may already have ended.
    let mut ids = vec![session_id.to_string()];
    {
        let metas = ctx.sessions.list_meta();
        loop {
            let before = ids.len();
            for meta in &metas {
                if let (Some(parent), Some(id)) =
                    (meta.get("parentSessionId").and_then(Value::as_str), meta.get("id").and_then(Value::as_str))
                    && ids.iter().any(|s| s == parent)
                    && !ids.iter().any(|s| s == id)
                {
                    ids.push(id.to_string());
                }
            }
            if ids.len() == before {
                break;
            }
        }
    }
    for id in &ids {
        ctx.admission.abort(id);
        ctx.image_turns.abort(id);
        ctx.turns.abort_session(id);
        ctx.turns.processes.kill_session(id);
        ctx.turns.watches.cancel_session(id).await?;
    }
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
    nekko_js::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()))
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
    let home = nekko_js::home_dir().ok_or("No home folder to read ~/.ssh/config from.")?;
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
    "sessions:clearHistory",
    "sessions:historyUsage",
    "sessions:purgeArchived",
    "session:get",
    "session:page",
    "session:images",
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
    let store = ctx.sessions.clone();
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
    watches: Option<Arc<crate::watches::Watches>>,
    protected: Option<ProtectedSession>,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let channel = channel.to_string();
    tokio::task::spawn_blocking(move || {
        let id = str_arg(&args, 0).unwrap_or_default();
        let delete_log = |id: &str| delete_agent_log(logs.as_deref(), id);
        let or_null = |r: Result<Option<Value>, String>| r.map(|v| v.unwrap_or(Value::Null));
        match channel.as_str() {
            "sessions:summaries" | "sessions:list" => {
                let mut sessions = if channel == "sessions:summaries" { store.summaries() } else { store.list() };
                // One watch-file read per listing, not per chat. A due or pending
                // delivery is still active until the scheduler finishes it.
                let mut counts = std::collections::HashMap::<String, usize>::new();
                for watch in watches.as_ref().and_then(|w| w.list(None).ok()).unwrap_or_default() {
                    if watch.get("status").and_then(Value::as_str) == Some("active")
                        && let Some(id) = watch.get("sessionId").and_then(Value::as_str)
                    {
                        *counts.entry(id.to_string()).or_default() += 1;
                    }
                }
                for session in &mut sessions {
                    let count =
                        session.get("id").and_then(Value::as_str).and_then(|id| counts.get(id)).copied().unwrap_or(0);
                    if let Some(obj) = session.as_object_mut() {
                        obj.insert("activeWatchCount".into(), json!(count));
                    }
                }
                Ok(Value::Array(sessions))
            }
            "sessions:clear" => store.clear_with(id, delete_log).map(|n| json!(n)),
            "sessions:clearHistory" => store
                .clear_history_with(id, |id| protected.as_ref().is_some_and(|protected| protected(id)), delete_log)
                .map(|n| json!(n)),
            "sessions:historyUsage" => {
                let (bytes, count) = store.history_usage();
                Ok(json!({ "bytes": bytes, "count": count }))
            }
            "sessions:purgeArchived" => store.purge_archived(delete_log).map(|n| json!(n)),
            "session:get" => Ok(store.get(id).unwrap_or(Value::Null)),
            "session:page" => Ok(nekko_remote::phone::message_page(
                &store.get(id).unwrap_or(Value::Null),
                arg(&args, 1).as_str(),
                arg(&args, 2).as_f64(),
            )),
            "session:images" => Ok(Value::Array(store.images(id, arg(&args, 1).as_f64().unwrap_or(1.0)))),
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

    #[tokio::test]
    async fn session_listings_count_only_active_watches_and_preserve_phone_summaries() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(nekko_store::SessionStore::new(tmp.path()));
        std::fs::create_dir_all(store.dir()).unwrap();
        for (id, updated) in [("s1", 1), ("s2", 2), ("s3", 3)] {
            let session = json!({ "id": id, "title": id, "updatedAt": updated, "workspaceId": "w1",
                "archivedAt": 42, "activeWatchCount": 99,
                "messages": [{ "role": "assistant", "content": "reply", "createdAt": 1 }] });
            std::fs::write(store.dir().join(format!("{id}.json")), session.to_string()).unwrap();
        }
        let path = tmp.path().join("agent-watches.json");
        std::fs::write(&path, json!([
            { "sessionId": "s1", "status": "active", "kind": "timer", "deadlineAt": 9999999999999_u64, "prompt": "private continuation" },
            { "sessionId": "s1", "status": "active", "kind": "pr", "deadlineAt": 0 },
            { "sessionId": "s1", "status": "active", "pending": true, "deadlineAt": 0, "failures": 2, "lastError": "private error" },
            { "sessionId": "s1", "status": "done" },
            { "sessionId": "s1", "status": "cancelled", "pending": true },
            { "sessionId": "s1", "status": "error" },
            { "sessionId": "s2", "status": "active" },
            { "sessionId": "s3", "status": "done" },
            { "sessionId": "missing", "status": "active" },
            { "status": "active" },
            { "sessionId": "s1" }
        ]).to_string()).unwrap();
        let watches = crate::watches::Watches::new(tmp.path().to_path_buf(), store.clone(), Hub::new());
        for channel in ["sessions:list", "sessions:summaries"] {
            let got = session_op(store.clone(), None, Some(watches.clone()), None, channel, vec![]).await.unwrap();
            let rows = got.as_array().unwrap();
            assert_eq!(rows.iter().map(|s| s["id"].as_str().unwrap()).collect::<Vec<_>>(), ["s3", "s2", "s1"]);
            assert_eq!(rows.iter().map(|s| s["activeWatchCount"].as_u64().unwrap()).collect::<Vec<_>>(), [0, 1, 3]);
            let mut expected = if channel == "sessions:list" { store.list() } else { store.summaries() };
            for (session, count) in expected.iter_mut().zip([0, 1, 3]) {
                session["activeWatchCount"] = json!(count);
            }
            assert_eq!(got, json!(expected), "all other metadata and transcript behavior stays unchanged");
            if channel == "sessions:summaries" {
                assert!(nekko_remote::phone::screen(channel, &[]).is_ok());
                let phone = nekko_remote::phone::redact(channel, got.clone());
                assert_eq!(phone, got);
                for row in phone.as_array().unwrap() {
                    assert!(row.get("messages").is_none());
                    assert!(row.get("prompt").is_none());
                    assert!(row.get("lastError").is_none());
                }
                assert!(!phone.to_string().contains("private"));
            }
        }
        // Counts are live even when the session summaries came from the cache.
        std::fs::write(path, "[]").unwrap();
        let got = session_op(store, None, Some(watches), None, "sessions:summaries", vec![]).await.unwrap();
        assert!(got.as_array().unwrap().iter().all(|s| s["activeWatchCount"] == 0));
    }

    #[tokio::test]
    async fn session_listings_default_watch_counts_to_zero_when_unavailable() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(nekko_store::SessionStore::new(tmp.path()));
        store.create(None).unwrap();
        let watches = crate::watches::Watches::new(tmp.path().to_path_buf(), store.clone(), Hub::new());
        for state in [None, Some("not json")] {
            if let Some(state) = state {
                std::fs::write(tmp.path().join("agent-watches.json"), state).unwrap();
            }
            for channel in ["sessions:list", "sessions:summaries"] {
                for watches in [None, Some(watches.clone())] {
                    let got = session_op(store.clone(), None, watches, None, channel, vec![]).await.unwrap();
                    assert_eq!(got[0]["activeWatchCount"], 0);
                }
            }
        }
    }

    #[tokio::test]
    async fn clear_history_skips_a_protected_running_chat() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(nekko_store::SessionStore::new(tmp.path()));
        std::fs::create_dir_all(store.dir()).unwrap();
        for id in ["s_busy", "s_idle"] {
            let session = json!({ "id": id, "updatedAt": 1, "archivedAt": 1, "messages": [] });
            std::fs::write(store.dir().join(format!("{id}.json")), session.to_string()).unwrap();
        }
        let protected: ProtectedSession = Arc::new(|id| id == "s_busy");
        let removed = session_op(
            store.clone(),
            None,
            None,
            Some(protected),
            "sessions:clearHistory",
            vec![json!("older-2-weeks")],
        )
        .await
        .unwrap();
        assert_eq!(removed, json!(1));
        assert!(store.dir().join("s_busy.json").exists());
        assert!(!store.dir().join("s_idle.json").exists());
    }

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
    fn every_channel_has_one_handler() {
        for (native, desktop) in [(false, false), (true, false), (false, true), (true, true)] {
            let t = Table::new(native, desktop);
            assert!(t.twice.is_empty(), "registered twice: {:?}", t.twice);
            assert_eq!(t.get("shell:openPath").is_some(), native);
        }
        let t = Table::new(true, true);
        // `lms:probe` is the providers' (it was the first arm to match it).
        assert!(!crate::runtimes::CHANNELS.contains(&"lms:probe"));
        assert!(crate::providers::CHANNELS.contains(&"lms:probe"));
        for c in [
            "chat:send",
            "session:create",
            "session:get",
            "decide:status",
            "infer:list",
            "image:fetch",
            "repository:review",
            "machine:summary",
            "background:state",
        ] {
            assert!(t.get(c).is_some(), "{c}");
        }
        assert!(t.get("no:such").is_none());
    }

    #[test]
    fn agent_logs_are_recognised() {
        assert!(is_agent("agent_s1"));
        assert!(!is_agent("term_abc_1"));
    }
}
