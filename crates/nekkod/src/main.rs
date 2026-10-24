//! `nekkod`, the Nekko Agent engine daemon.
//!
//! Started by the desktop app with `--config-stdin` and a JSON config as the
//! first line of its stdin (see `config.rs`). Prints one line,
//! `NEKKOD_READY {"port":N,"pid":P}`, once it is listening; everything else
//! goes to stderr. Shuts down when its stdin closes or on SIGTERM, SIGHUP or
//! Ctrl-C, ending everything it started (`procgroup.rs`). One daemon per data
//! directory (`datalock.rs`): a second exits with code 3.

mod accounts;
mod activity;
mod admission;
mod agent_logs;
mod api_server;
mod auto_continue;
mod automation;
mod background;

mod boot;
mod catalog;
mod claude_plan;
mod claude_policy;
mod cli_install;
mod compaction;
mod config;
mod connectors;
mod context;
mod datalock;
mod decide;
mod decisions;
mod desktop;
mod downloads;
mod engine;
mod gcp;
mod harness;
mod hub;
mod hypergate;
mod image_turns;
mod installs;
mod library;
mod local_relay;
mod logs;
mod machine;
mod mcp;
mod mdns;
mod messaging;
mod model_server;
mod native;
mod oauth;
mod pr_checkouts;
mod privacy;
mod procgroup;
mod providers;
mod remote;
mod remote_image;
mod repository_review;
mod resource_queue;
mod routes;
mod runtimes;
mod sandbox;
mod security;
mod settings;
mod side;
mod sideband;
mod skill_sources;
mod small_services;
mod spawn;
mod speeds;
mod tooling;
mod turns;
mod voice;
mod watches;
mod webhook_listener;
mod wire;
mod workspace;
mod worktrees;

use hub::Hub;
use nekko_term::Registry;
use routes::Ctx;
use std::io::Write;
use std::sync::Arc;

/// 32 random bytes as hex.
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("the OS random source is available");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() -> std::process::ExitCode {
    machine::mark_started();
    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nekkod: {e}");
            return std::process::ExitCode::from(2);
        }
    };
    // One daemon per data directory, held until the process ends.
    let _lock = match cfg.data_dir.as_deref().map(|d| datalock::acquire(std::path::Path::new(d), LOCK_WAIT)) {
        Some(Err(e)) => {
            eprintln!("nekkod: {e}");
            return std::process::ExitCode::from(datalock::LOCKED_EXIT);
        }
        Some(Ok(f)) => Some(f),
        None => None,
    };
    // `<dataDir>/logs/nekkod.log` (logs.rs): stderr teed to a rotating file,
    // held until main returns so the last lines are copied out.
    let _daemon_log = cfg.data_dir.as_ref().and_then(|d| logs::start_daemon_log(&std::path::Path::new(d).join("logs")));
    logs::note(&format!("nekkod {} starting, pid {}", env!("CARGO_PKG_VERSION"), std::process::id()));
    procgroup::init();
    // What a predecessor killed outright left running goes first; then keep
    // our own record for the next one.
    if let Some(d) = &cfg.data_dir {
        let run = procgroup::run_dir(std::path::Path::new(d));
        procgroup::reap_leftovers(&run);
        procgroup::track(&run);
    }

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let result = rt.block_on(run(cfg));
    // Whatever the shutdown above did not stop (or a failed start left).
    procgroup::sweep(SWEEP_GRACE);
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("nekkod: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// How long a second daemon waits for the data directory's lock: long
/// enough for a predecessor that is shutting down to finish.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
/// Open connections get this long to finish once shutdown starts.
const DRAIN: std::time::Duration = std::time::Duration::from_secs(2);
/// A shutdown that takes longer than this is cut short (children ended, exit 1).
const SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(8);
/// Children still running at the end get this long after SIGTERM before SIGKILL.
const SWEEP_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

async fn run(cfg: config::Config) -> anyhow::Result<()> {
    // Before anything starts children: SIGTERM and SIGHUP stop the daemon
    // gracefully instead of killing it with them still running.
    let signals = Signals::new()?;
    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    let port = listener.local_addr()?.port();

    let hub = Hub::new();
    let terminals = Arc::new(Registry::new());
    let engine = Arc::new(engine::Engine::new());
    let sessions = cfg.data_dir.clone().map(|d| Arc::new(nekko_store::SessionStore::new(d)));
    let mcp: Arc<mcp::Mcp> = Arc::default();
    let changes = Arc::new(nekko_tools::ChangeTracker::new());
    {
        // The UI (and a paired phone, through the relay agent here) hears that a chat's changes moved.
        let hub = hub.clone();
        changes.set_notifier(move |session_id| {
            hub.publish("changes:updated", serde_json::json!({ "sessionId": session_id }), false);
        });
    }
    let accounts = Arc::new(accounts::Accounts::new(cfg.data_dir.clone().map(std::path::PathBuf::from), hub.clone()));
    let settings = cfg.data_dir.clone().map(|d| settings::Settings::new(d.into(), hub.clone()));
    // Older builds signed in to Claude plans; delete what they left (claude_plan.rs).
    if let (Some(d), Some(s)) = (&cfg.data_dir, &settings) {
        match claude_plan::migrate(std::path::Path::new(d), &s.store, nekko_oauth::now_ms()) {
            Ok(done) if !done.is_empty() => eprintln!(
                "nekkod: removed {} Claude sign-in token(s) and turned off {} Claude plan provider(s)",
                done.tokens.len(),
                done.providers.len()
            ),
            Ok(_) => {}
            Err(e) => eprintln!("nekkod: Claude sign-in cleanup failed: {e}"),
        }
    }
    // Voice reads its settings from the daemon's store.
    let voice = cfg.data_dir.clone().zip(settings.clone()).map(|(d, s)| {
        let store = s.store.clone();
        let read: Arc<dyn Fn() -> serde_json::Value + Send + Sync> = Arc::new(move || store.get());
        voice::Voice::new(std::path::PathBuf::from(d).join("voice"), read, voice::Sources::default())
    });
    let compactions = compaction::Compactions::new();
    let sandboxes = cfg.data_dir.clone().filter(|_| sessions.is_some()).map(|d| sandbox::Sandboxes::new(d.into()));
    // Turns are admitted here wherever this daemon owns the data.
    let admission =
        cfg.data_dir.is_some().then(|| admission::Admission::new(compactions.clone(), cfg.allow_browser_control));
    let catalog = settings.as_deref().map(|s| catalog::new(s, cfg.hugging_face_url.clone()));
    let automation = Arc::new(automation::Automation::new(sessions.clone(), settings.clone(), hub.clone()));
    let remote = Arc::new(remote::Remote::new(cfg.data_dir.clone().map(std::path::PathBuf::from), hub.clone()));
    // Nekko Cloud sign-in and end-to-end encrypted sync, with the data directory.
    // A chat a turn is running in is never overwritten from the cloud; the turns
    // are known once the context below is built.
    let running: Arc<std::sync::OnceLock<Arc<turns::Turns>>> = Arc::default();
    let cloud = match (&cfg.data_dir, &sessions) {
        (Some(d), Some(store)) => {
            let dir = std::path::PathBuf::from(d).join("cloud");
            let publish_hub = hub.clone();
            let busy = running.clone();
            Some(nekko_cloud::Cloud::new(nekko_cloud::Options {
                vault: nekko_cloud::vault::default_vault(&dir),
                dir,
                api_url: std::env::var("NEKKO_CLOUD_URL")
                    .ok()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| "https://nekko-agent-api.fly.dev".into()),
                device_label: gethostname::gethostname().to_string_lossy().chars().take(40).collect(),
                sessions: store.clone(),
                publish: Arc::new(move |status| publish_hub.publish(nekko_cloud::EVENT, status, false)),
                busy: Arc::new(move |id| busy.get().is_some_and(|t| t.running_sessions().iter().any(|s| s == id))),
            }))
        }
        _ => None,
    };
    // The messaging bridges, with the data directory (and so the settings and sessions).
    let messaging = match (&cfg.data_dir, &settings, &sessions) {
        (Some(d), Some(s), Some(store)) => {
            let api = cfg
                .telegram_api_url
                .clone()
                .or_else(|| std::env::var("NEKKO_TELEGRAM_API_URL").ok().filter(|u| !u.is_empty()));
            Some(messaging::Messaging::new(d.into(), s.store.clone(), store.clone(), api))
        }
        _ => None,
    };
    // The machine probes and the resource queue read the daemon's settings store.
    let read_settings = |s: &Option<Arc<settings::Settings>>| {
        let store = s.as_ref().map(|s| s.store.clone());
        move || store.as_ref().map_or(serde_json::Value::Null, |s| s.get())
    };
    let engine_bin = {
        let read = read_settings(&settings);
        move || nekko_js::truthy_str(read().get("engineBinPath")).map(str::to_string)
    };
    // Agent watches, when the daemon knows the data directory (watches.rs).
    let agent_watches = match (&cfg.data_dir, &sessions) {
        (Some(d), Some(store)) => Some(watches::Watches::new(d.into(), store.clone(), hub.clone())),
        _ => None,
    };
    let machine =
        Arc::new(nekko_machine::Machine::new(cfg.data_dir.clone().map(std::path::PathBuf::from), Box::new(engine_bin)));
    let library = settings.clone().map(|s| library::Library::new(s, machine.clone(), engine.clone()));
    if let Some(library) = &library {
        let _ = engine.speeds.sink.set(speeds::Speeds::new(machine.clone(), library.clone()));
    }
    let model_downloads = library.clone().zip(catalog.clone()).map(|(library, catalog)| {
        let fetch =
            downloads::Rebased(nekko_engine::download::HttpFetch(reqwest::Client::new()), cfg.hugging_face_url.clone());
        downloads::ModelDownloads::new(Arc::new(fetch), library, catalog, hub.clone())
    });
    // The runtimes install through the same queue as the models.
    let installs = cfg.data_dir.clone().zip(model_downloads.clone()).zip(settings.clone()).map(|((dir, d), s)| {
        installs::Installs::new(
            &dir,
            d.queue(),
            s.store.clone(),
            machine.clone(),
            engine.clone(),
            cfg.github_api_url.clone(),
        )
    });
    // The model server's policy, over the daemon's own processes and router.
    let server = cfg.data_dir.clone().zip(settings.clone()).zip(library.clone()).zip(installs.clone()).map(
        |(((dir, s), library), installs)| {
            library.set_installs(installs.clone());
            let server = model_server::Server::new(s, dir, library, installs, machine.clone(), engine.clone());
            let _ = engine.server.set(server.model.clone());
            server
        },
    );
    let runtimes = settings
        .as_deref()
        .map(|s| runtimes::new(s, machine.clone(), library.clone(), installs.clone(), server.clone()));
    let ctx = Ctx {
        terminals: terminals.clone(),
        hub: hub.clone(),
        engine: engine.clone(),
        sessions: sessions.clone(),
        changes: changes.clone(),
        turns: Arc::new(
            turns::Turns::new(
                sessions.clone(),
                cfg.data_dir.clone().map(std::path::PathBuf::from),
                changes,
                accounts.clone(),
                mcp.clone(),
                engine.decide.clone(),
            )
            .with_settings(settings.as_ref().map(|s| s.store.clone()))
            .with_bridge(cfg.browser_bridge.clone().map(|b| (b.url, b.token)))
            .with_watches(agent_watches.clone())
            .with_training(automation.training.clone())
            .with_sandboxes(sandboxes.clone())
            .with_agent_logs(cfg.data_dir.as_ref().map(|d| {
                let read = read_settings(&settings);
                agent_logs::AgentLogs::new(std::path::Path::new(d), sessions.clone(), Arc::new(read), hub.clone())
            })),
        ),
        mcp: mcp.clone(),
        accounts: accounts.clone(),
        settings: settings.clone(),
        admission,
        oauth: match (&cfg.data_dir, &settings) {
            (Some(d), Some(s)) => {
                let o = oauth::OAuth::new(
                    d.into(),
                    s.store.clone(),
                    accounts.clone(),
                    hub.clone(),
                    cfg.sign_in,
                    oauth::Endpoints::default(),
                );
                let _ = accounts.oauth.set(Arc::downgrade(&o));
                Some(o)
            }
            _ => None,
        },
        machine,
        runtimes: runtimes.clone(),
        library: library.clone(),
        downloads: model_downloads.clone(),
        installs: installs.clone(),
        server: server.clone(),
        resource_queue: cfg.data_dir.clone().map(|d| {
            Arc::new(resource_queue::ResourceQueue::new(
                std::path::PathBuf::from(d),
                Box::new(read_settings(&settings)),
            ))
        }),
        voice: voice.clone(),
        cloud: cloud.clone(),
        catalog,
        workspace: Arc::new(workspace::Workspace::new(
            cfg.data_dir.clone().map(std::path::PathBuf::from),
            cfg.github_api_url.as_deref(),
        )),
        automation: automation.clone(),
        remote: remote.clone(),
        security: Arc::new(security::Security::new(remote.security_store(), nekko_remote::system_clock())),
        sandboxes,
        compactions,
        image_turns: image_turns::ImageTurns::new(),
        app: Arc::new(routes::AppCtx {
            facts: small_services::AppFacts { version: cfg.app_version.clone(), edition: cfg.edition.clone() },
            bridge: cfg.browser_bridge.clone().map(|b| (b.url, b.token)),
            decision_models_url: cfg.decision_models_url.clone(),
        }),
        update_checks: small_services::UpdateChecks::new(),
        claude_policy: Arc::new(claude_policy::ClaudePolicyStore::new(
            cfg.data_dir.clone().map(std::path::PathBuf::from),
            cfg.native.as_ref().is_some_and(|n| n.is_packaged),
        )),
        messaging: messaging.clone(),
        native: cfg
            .native
            .clone()
            .filter(|_| cfg.browser_bridge.is_some())
            .map(|n| native::Native::new(n, cfg.app_version.clone())),
        desktop: match (&cfg.native, &cfg.data_dir, &settings) {
            (Some(n), Some(d), Some(_)) => Some(desktop::Desktop::new(n, std::path::Path::new(d))),
            _ => None,
        },
    };
    let _ = running.set(ctx.turns.clone());
    if let Some(cloud) = &cloud {
        cloud.start(std::time::Duration::from_secs(60));
    }
    routes::forward_terminal_events(&ctx);
    ctx.turns.set_background(background::Background::new(
        ctx.machine.clone(),
        ctx.admission.clone(),
        ctx.settings.as_ref().map(|s| s.store.clone()),
        ctx.hub.clone(),
    ));
    if let Some(adm) = ctx.admission.clone() {
        let c = ctx.clone();
        ctx.turns.set_preparer(Arc::new(move |payload| {
            let (c, adm) = (c.clone(), adm.clone());
            Box::pin(async move { admission::admit_queued(&c, &adm, &payload).await })
        }));
    }
    {
        // A turn's tool that asks another service (delegation_targets), through the router.
        let c = ctx.clone();
        ctx.turns.set_dispatcher(Arc::new(move |channel: String, args: Vec<serde_json::Value>| {
            let c = c.clone();
            Box::pin(async move { routes::route(&c, &channel, args).await })
        }));
    }
    {
        // A workflow stops a chat through the router, as the UI would.
        let ctx = ctx.clone();
        automation.set_dispatcher(Arc::new(move |channel: String, args: Vec<serde_json::Value>| {
            let ctx = ctx.clone();
            Box::pin(async move { routes::route(&ctx, &channel, args).await })
        }));
    }
    // What a host used to do when it started (boot.rs): first, so no turn
    // starts before the last run's leftovers are written off.
    boot::start(&ctx, cfg.auto_start_engine);
    automation.start();
    if let Some(n) = &ctx.native {
        n.start(ctx.clone());
    }
    if let Some(w) = &agent_watches {
        let c = ctx.clone();
        w.set_dispatcher(Arc::new(move |channel: String, args: Vec<serde_json::Value>| {
            let c = c.clone();
            Box::pin(async move { routes::route(&c, &channel, args).await })
        }));
        w.start(ctx.turns.clone());
    }
    // The catalog refresh checks, where the daemon serves `updates:check`.
    if ctx.sessions.is_some() && ctx.settings.is_some() {
        ctx.update_checks.start(ctx.clone());
    }
    let processes = ctx.turns.processes.clone();
    {
        // A paired phone reaches what the UI reaches: the router.
        let ctx = ctx.clone();
        remote.set_dispatcher(Arc::new(move |channel: String, args: serde_json::Value| {
            let ctx = ctx.clone();
            Box::pin(async move {
                // The TS dispatcher destructures the list and threw on anything else.
                let serde_json::Value::Array(args) = args else {
                    return Err(format!("{channel}: args is not a list"));
                };
                routes::route(&ctx, &channel, args).await
            })
        }));
    }
    remote.start();
    if let Some(m) = &messaging {
        // A chat's turn, approvals and answers go through the router, as the UI's do.
        let ctx = ctx.clone();
        m.set_dispatcher(Arc::new(move |channel: String, args: Vec<serde_json::Value>| {
            let ctx = ctx.clone();
            Box::pin(async move { routes::route(&ctx, &channel, args).await })
        }));
        m.start(&hub);
    }

    if let Some(d) = ctx.desktop.clone() {
        let c = ctx.clone();
        tokio::spawn(async move { d.start(&c).await });
    }
    // Claude Agent chats' idle Claude Code children are ended after 15 minutes.
    ctx.turns.harness.start_reaper();
    // Claude Agent's approval bridge: the app's own CLI, else `nekko-agent` on PATH.
    ctx.turns.harness.configure(harness::BridgeSetup {
        wire_url: format!("http://127.0.0.1:{port}"),
        command: cfg
            .native
            .as_ref()
            .and_then(cli_install::bundled_cli)
            .map(|(exe, cli)| harness::BridgeCommand::electron(&exe, &cli))
            .or_else(|| harness::cli_on_path().map(|p| harness::BridgeCommand::launcher(&p.to_string_lossy()))),
        dir: cfg
            .data_dir
            .as_ref()
            .map_or_else(|| std::env::temp_dir().join("nekko-harness"), |d| std::path::Path::new(d).join("harness")),
    });
    let after = ctx.clone();
    let app = wire::App { ctx, token: cfg.token.clone().into(), origins: Arc::new(cfg.allowed_origins.clone()) };
    let router = wire::router(app);

    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "NEKKOD_READY {}", serde_json::json!({ "port": port, "pid": std::process::id() }))?;
        out.flush()?;
    }

    // Serve until told to stop; open connections (the UI's sockets) then get
    // a moment to finish, and cleanup goes ahead either way.
    let (drain_tx, drain_rx) = tokio::sync::oneshot::channel::<()>();
    let serve = axum::serve(listener, router).with_graceful_shutdown(async {
        let _ = drain_rx.await;
    });
    let mut serve = std::pin::pin!(std::future::IntoFuture::into_future(serve));
    let mut signals = signals;
    tokio::select! {
        r = &mut serve => r?,
        why = shutdown_signal(cfg.exit_on_stdin_close, &mut signals) => {
            logs::note(&format!("nekkod: shutting down ({why})"));
            // A second signal, or a shutdown that hangs, ends it hard.
            tokio::spawn(async move {
                let why = signals.next().await;
                procgroup::hard_exit(&format!("{why} during shutdown"));
            });
            std::thread::spawn(|| {
                std::thread::sleep(SHUTDOWN_DEADLINE);
                procgroup::hard_exit("shutdown took too long");
            });
            let _ = drain_tx.send(());
            if tokio::time::timeout(DRAIN, &mut serve).await.is_err() {
                eprintln!("nekkod: open connections did not close; shutting down anyway");
            }
        }
    }

    if let Some(d) = &after.desktop {
        d.shutdown(&after).await;
    }
    remote.stop();
    if let Some(m) = &messaging {
        m.stop();
    }
    engine.shutdown();
    // The servers this daemon started (Ollama) go down with it.
    if let Some(rt) = &runtimes {
        rt.kill_all().await;
    }
    if let Some(voice) = &voice {
        voice.stop().await;
    }
    terminals.close_all();
    mcp.stop_all();
    processes.kill_all();
    Ok(())
}

/// The signals that stop the daemon: Ctrl-C everywhere, SIGTERM and SIGHUP on Unix.
struct Signals {
    #[cfg(unix)]
    term: tokio::signal::unix::Signal,
    #[cfg(unix)]
    hup: tokio::signal::unix::Signal,
}

impl Signals {
    fn new() -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Ok(Self { term: signal(SignalKind::terminate())?, hup: signal(SignalKind::hangup())? })
        }
        #[cfg(not(unix))]
        Ok(Self {})
    }

    /// The next one, by name.
    async fn next(&mut self) -> &'static str {
        #[cfg(unix)]
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => "SIGINT",
                _ = self.term.recv() => "SIGTERM",
                _ = self.hup.recv() => "SIGHUP",
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            "Ctrl-C"
        }
    }
}

/// Resolves when the app that started us is gone (stdin closed) or on a
/// stop signal, with which.
async fn shutdown_signal(watch_stdin: bool, signals: &mut Signals) -> &'static str {
    let stdin_closed = async {
        if !watch_stdin {
            return std::future::pending::<()>().await;
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        std::thread::spawn(move || {
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin();
            loop {
                match std::io::Read::read(&mut stdin, &mut sink) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let _ = tx.send(());
        });
        let _ = rx.await;
    };
    tokio::select! {
        _ = stdin_closed => "stdin closed",
        why = signals.next() => why,
        _ = small_services::QUIT.notified() => "app:quit from a phone",
    }
}
