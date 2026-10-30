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
mod artifacts;
mod auto_continue;
mod automation;
mod background;

mod boot;
mod catalog;
mod chat_client;
mod claude_plan;
mod claude_policy;
mod cli_install;
mod compaction;
mod config;
mod connections;
mod connectivity;
mod connectors;
mod context;
mod datalock;
mod decide;
mod decisions;
mod desktop;
mod downloads;
mod engine;
mod feedback;
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
// The runner supervisor that calls into it lands with the VM pool (T211, T212).
// Unix only: VMs run only on macOS, and the NAT is built on Unix sockets.
#[cfg(unix)]
#[allow(dead_code)]
mod runner;
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
mod telemetry;
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
    let _lock = match datalock::acquire(std::path::Path::new(&cfg.data_dir), LOCK_WAIT) {
        Err(e) => {
            eprintln!("nekkod: {e}");
            return std::process::ExitCode::from(datalock::LOCKED_EXIT);
        }
        Ok(f) => f,
    };
    // `<dataDir>/logs/nekkod.log` (logs.rs): stderr teed to a rotating file,
    // held until main returns so the last lines are copied out.
    let _daemon_log = logs::start_daemon_log(&std::path::Path::new(&cfg.data_dir).join("logs"));
    logs::note(&format!("nekkod {} starting, pid {}", env!("CARGO_PKG_VERSION"), std::process::id()));
    procgroup::init();
    // Each job VM's NAT holds a socket per guest flow; 256 runs out.
    #[cfg(unix)]
    runner::raise_nofile();
    // What a predecessor killed outright left running goes first; then keep
    // our own record for the next one.
    {
        let run = procgroup::run_dir(std::path::Path::new(&cfg.data_dir));
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
    let data_dir = std::path::PathBuf::from(&cfg.data_dir);
    let sessions = Arc::new(nekko_store::SessionStore::new(&cfg.data_dir));
    let mcp: Arc<mcp::Mcp> = Arc::default();
    let changes = Arc::new(nekko_tools::ChangeTracker::new());
    {
        // The UI (and a paired phone, through the relay agent here) hears that a chat's changes moved.
        let hub = hub.clone();
        changes.set_notifier(move |session_id| {
            hub.publish("changes:updated", serde_json::json!({ "sessionId": session_id }), false);
        });
    }
    let settings = settings::Settings::new(data_dir.clone(), hub.clone());
    let accounts = Arc::new(accounts::Accounts::new(data_dir.clone(), hub.clone()));
    // Older builds signed in to Claude plans; delete what they left (claude_plan.rs).
    match claude_plan::migrate(&data_dir, &settings.store, nekko_oauth::now_ms()) {
        Ok(done) if !done.is_empty() => eprintln!(
            "nekkod: removed {} Claude sign-in token(s) and turned off {} Claude plan provider(s)",
            done.tokens.len(),
            done.providers.len()
        ),
        Ok(_) => {}
        Err(e) => eprintln!("nekkod: Claude sign-in cleanup failed: {e}"),
    }
    // Settings > Connections: the switch, before anything below reaches the network.
    connections::start(&data_dir, &settings);
    // Voice reads its settings from the daemon's store.
    let voice = {
        let store = settings.store.clone();
        let read: Arc<dyn Fn() -> serde_json::Value + Send + Sync> = Arc::new(move || store.get());
        voice::Voice::new(data_dir.join("voice"), read, voice::Sources::default())
    };
    let compactions = compaction::Compactions::new();
    let sandboxes = sandbox::Sandboxes::new(data_dir.clone());
    let admission = admission::Admission::new(compactions.clone(), cfg.allow_browser_control);
    let catalog = catalog::new(&settings, cfg.hugging_face_url.clone());
    let automation = Arc::new(automation::Automation::new(sessions.clone(), settings.clone(), hub.clone()));
    let remote = Arc::new(remote::Remote::new(data_dir.clone(), hub.clone()));
    // Nekko Cloud sign-in and end-to-end encrypted sync. A chat a turn is
    // running in is never overwritten from the cloud; the turns are known
    // once the context below is built.
    let running: Arc<std::sync::OnceLock<Arc<turns::Turns>>> = Arc::default();
    let cloud = {
        let dir = data_dir.join("cloud");
        let publish_hub = hub.clone();
        let busy = running.clone();
        nekko_cloud::Cloud::new(nekko_cloud::Options {
            vault: nekko_cloud::vault::default_vault(&dir),
            dir,
            api_url: feedback::cloud_url(),
            device_label: gethostname::gethostname().to_string_lossy().chars().take(40).collect(),
            sessions: sessions.clone(),
            publish: Arc::new(move |status| publish_hub.publish(nekko_cloud::EVENT, status, false)),
            busy: Arc::new(move |id| busy.get().is_some_and(|t| t.running_sessions().iter().any(|s| s == id))),
        })
    };
    // The messaging bridges.
    let messaging = {
        let api = cfg
            .telegram_api_url
            .clone()
            .or_else(|| std::env::var("NEKKO_TELEGRAM_API_URL").ok().filter(|u| !u.is_empty()));
        messaging::Messaging::new(data_dir.clone(), settings.store.clone(), sessions.clone(), api)
    };
    // The machine probes and the resource queue read the daemon's settings store.
    let read_settings = || {
        let store = settings.store.clone();
        move || store.get()
    };
    let engine_bin = {
        let read = read_settings();
        move || nekko_js::truthy_str(read().get("engineBinPath")).map(str::to_string)
    };
    // Agent watches (watches.rs).
    let agent_watches = watches::Watches::new(data_dir.clone(), sessions.clone(), hub.clone());
    let machine = Arc::new(nekko_machine::Machine::new(Some(data_dir.clone()), Box::new(engine_bin)));
    let library = library::Library::new(settings.clone(), machine.clone(), engine.clone());
    let _ = engine.speeds.sink.set(speeds::Speeds::new(machine.clone(), library.clone()));
    {
        // Abandoned downloads can be GBs each (#1035).
        let dir = std::path::PathBuf::from(library.models_dir());
        tokio::task::spawn_blocking(move || {
            let freed = downloads::sweep_stale_parts(&dir, std::time::SystemTime::now());
            if freed > 0 {
                logs::note(&format!("nekkod: removed {freed} bytes of abandoned downloads"));
            }
        });
    }
    let model_downloads = {
        let fetch =
            downloads::Rebased(nekko_engine::download::HttpFetch(reqwest::Client::new()), cfg.hugging_face_url.clone());
        downloads::ModelDownloads::new(Arc::new(fetch), library.clone(), catalog.clone(), hub.clone())
    };
    // The runtimes install through the same queue as the models.
    let installs = installs::Installs::new(
        &cfg.data_dir,
        model_downloads.queue(),
        settings.store.clone(),
        machine.clone(),
        engine.clone(),
        cfg.github_api_url.clone(),
    );
    // The model server's policy, over the daemon's own processes and router.
    library.set_installs(installs.clone());
    let server = model_server::Server::new(
        settings.clone(),
        cfg.data_dir.clone(),
        library.clone(),
        installs.clone(),
        machine.clone(),
        engine.clone(),
    );
    let _ = engine.server.set(server.model.clone());
    let runtimes = runtimes::new(&settings, machine.clone(), library.clone(), installs.clone(), server.clone());
    let oauth = oauth::OAuth::new(
        data_dir.clone(),
        settings.store.clone(),
        accounts.clone(),
        hub.clone(),
        cfg.sign_in,
        oauth::Endpoints::default(),
    );
    let _ = accounts.oauth.set(Arc::downgrade(&oauth));
    // The desktop app's Electron-main channels, with its browser bridge.
    let native = cfg
        .native
        .clone()
        .filter(|_| cfg.browser_bridge.is_some())
        .map(|n| native::Native::new(n, cfg.app_version.clone()));
    let ctx = Ctx {
        terminals: terminals.clone(),
        hub: hub.clone(),
        engine: engine.clone(),
        sessions: sessions.clone(),
        changes: changes.clone(),
        turns: Arc::new(
            turns::Turns::new(
                sessions.clone(),
                data_dir.clone(),
                changes,
                accounts.clone(),
                mcp.clone(),
                engine.decide.clone(),
                settings.store.clone(),
                agent_logs::AgentLogs::new(&data_dir, sessions.clone(), Arc::new(read_settings()), hub.clone()),
                agent_watches.clone(),
                sandboxes.clone(),
                automation.training.clone(),
            )
            .with_bridge(cfg.browser_bridge.clone().map(|b| (b.url, b.token))),
        ),
        mcp: mcp.clone(),
        accounts: accounts.clone(),
        settings: settings.clone(),
        admission,
        oauth,
        machine: machine.clone(),
        runtimes: runtimes.clone(),
        library: library.clone(),
        downloads: model_downloads.clone(),
        installs: installs.clone(),
        server: server.clone(),
        #[cfg(unix)]
        runners: runner::Runners::start(
            data_dir.clone(),
            machine.clone(),
            Box::new(read_settings()),
            hub.clone(),
            cfg.github_api_url.clone(),
        ),
        resource_queue: Arc::new(resource_queue::ResourceQueue::new(data_dir.clone(), Box::new(read_settings()))),
        voice: voice.clone(),
        cloud: cloud.clone(),
        catalog,
        workspace: Arc::new(workspace::Workspace::new(data_dir.clone(), cfg.github_api_url.as_deref())),
        automation: automation.clone(),
        remote: remote.clone(),
        security: Arc::new(security::Security::new(Some(remote.security_store()), nekko_remote::system_clock())),
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
            Some(data_dir.clone()),
            cfg.native.as_ref().is_some_and(|n| n.is_packaged),
            settings.as_ref().map(|s| s.store.clone()),
        )),
        messaging: messaging.clone(),
        native: native.clone(),
        desktop: cfg.native.as_ref().map(|n| desktop::Desktop::new(n, &data_dir)),
        routes: Arc::new(routes::Table::new(native.is_some(), cfg.native.is_some())),
    };
    let _ = running.set(ctx.turns.clone());
    cloud.start(std::time::Duration::from_secs(60));
    routes::forward_terminal_events(&ctx);
    ctx.turns.set_background(background::Background::new(
        ctx.machine.clone(),
        Some(ctx.admission.clone()),
        Some(ctx.settings.store.clone()),
        ctx.hub.clone(),
    ));
    {
        let (c, adm) = (ctx.clone(), ctx.admission.clone());
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
    {
        let c = ctx.clone();
        agent_watches.set_dispatcher(Arc::new(move |channel: String, args: Vec<serde_json::Value>| {
            let c = c.clone();
            Box::pin(async move { routes::route(&c, &channel, args).await })
        }));
        agent_watches.start(ctx.turns.clone());
    }
    // The catalog refresh checks (`updates:check`).
    ctx.update_checks.start(ctx.clone());
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
    {
        // A chat's turn, approvals and answers go through the router, as the UI's do.
        let ctx = ctx.clone();
        messaging.set_dispatcher(Arc::new(move |channel: String, args: Vec<serde_json::Value>| {
            let ctx = ctx.clone();
            Box::pin(async move { routes::route(&ctx, &channel, args).await })
        }));
        messaging.start(&hub);
    }

    if let Some(d) = ctx.desktop.clone() {
        let c = ctx.clone();
        tokio::spawn(async move { d.start(&c).await });
    }
    connections::follow(ctx.clone());
    telemetry::start(ctx.clone());
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
        dir: data_dir.join("harness"),
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
    #[cfg(unix)]
    after.runners.shutdown().await;
    remote.stop();
    messaging.stop();
    engine.shutdown();
    // The servers this daemon started (Ollama) go down with it.
    runtimes.kill_all().await;
    voice.stop().await;
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
