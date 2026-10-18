//! `nekkod`, the Nekko Agent engine daemon.
//!
//! Started by the desktop app with a JSON config in `NEKKOD_CONFIG` (see
//! `config.rs`). Prints one line, `NEKKOD_READY {"port":N,"pid":P}`, once it
//! is listening; everything else goes to stderr. Exits when its stdin closes.

mod accounts;
mod admission;
mod agent_logs;
mod api_server;
mod automation;
mod backend;
mod boot;
mod catalog;
mod cli_install;
mod compaction;
mod config;
mod connectors;
mod context;
mod decide;
mod decisions;
mod desktop;
mod downloads;
mod engine;
mod gcp;
mod hub;
mod hypergate;
mod image_turns;
mod installs;
mod library;
mod local_relay;
mod machine;
mod mcp;
mod mdns;
mod messaging;
mod model_server;
mod native;
mod oauth;
mod procgroup;
mod providers;
mod remote;
mod remote_image;
mod resource_queue;
mod routes;
mod runtimes;
mod sandbox;
mod settings;
mod side;
mod sideband;
mod skill_sources;
mod small_services;
mod spawn;
mod tooling;
mod turns;
mod voice;
mod watches;
mod webhook_listener;
mod wire;
mod workspace;
mod worktrees;

use backend::Backend;
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
    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nekkod: {e}");
            return std::process::ExitCode::from(2);
        }
    };
    // The token must not leak into the environment of every shell we start.
    // SAFETY: no other thread exists yet.
    unsafe { std::env::remove_var("NEKKOD_CONFIG") };
    procgroup::init();

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(run(cfg)) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("nekkod: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run(cfg: config::Config) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    let port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{port}");

    let hub = Hub::new();
    let terminals = Arc::new(Registry::new());
    let backend = match cfg.backend.clone() {
        Some(mut cmd) => {
            // What the backend must reach through the daemon rather than write itself.
            if cfg.data_dir.is_some() {
                let owns = [
                    settings::OWNS,
                    voice::OWNS,
                    oauth::OWNS,
                    automation::OWNS,
                    remote::OWNS,
                    messaging::OWNS,
                    watches::OWNS,
                    sandbox::OWNS,
                    library::OWNS,
                    downloads::OWNS,
                    installs::OWNS,
                    model_server::OWNS,
                    small_services::OWNS,
                    // Compactions are the daemon's wherever it admits turns.
                    compaction::OWNS,
                ];
                cmd.env.insert("NEKKOD_OWNS".into(), owns.join(","));
            }
            Backend::spawn(cmd, url.clone(), cfg.token.clone(), hub.clone())
        }
        None => Backend::disabled(),
    };
    let engine = Arc::new(engine::Engine::new(backend.clone()));
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
    let accounts = Arc::new(accounts::Accounts::new(
        cfg.data_dir.clone().map(std::path::PathBuf::from),
        backend.clone(),
        hub.clone(),
    ));
    let settings = cfg.data_dir.clone().map(|d| settings::Settings::new(d.into(), backend.clone(), hub.clone()));
    // Voice reads its settings from the daemon's store.
    let voice = cfg.data_dir.clone().zip(settings.clone()).map(|(d, s)| {
        let store = s.store.clone();
        let read: Arc<dyn Fn() -> serde_json::Value + Send + Sync> = Arc::new(move || store.get());
        voice::Voice::new(std::path::PathBuf::from(d).join("voice"), read, voice::Sources::default())
    });
    let compactions = compaction::Compactions::new();
    let sandboxes = cfg.data_dir.clone().filter(|_| sessions.is_some()).map(|d| sandbox::Sandboxes::new(d.into()));
    // Turns are admitted here wherever this daemon owns the data, with or without a TS backend.
    let admission =
        cfg.data_dir.is_some().then(|| admission::Admission::new(compactions.clone(), cfg.allow_browser_control));
    let catalog = settings.as_deref().map(|s| catalog::new(s, cfg.hugging_face_url.clone()));
    let automation =
        Arc::new(automation::Automation::new(sessions.clone(), settings.clone(), backend.clone(), hub.clone()));
    let remote = Arc::new(remote::Remote::new(cfg.data_dir.clone().map(std::path::PathBuf::from), hub.clone()));
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
        (Some(d), Some(store)) => Some(watches::Watches::new(d.into(), store.clone(), backend.clone(), hub.clone())),
        _ => None,
    };
    let machine =
        Arc::new(nekko_machine::Machine::new(cfg.data_dir.clone().map(std::path::PathBuf::from), Box::new(engine_bin)));
    let library = settings.clone().map(|s| library::Library::new(s, backend.clone(), machine.clone(), engine.clone()));
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
            backend.clone(),
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
        .map(|s| runtimes::new(s, backend.clone(), machine.clone(), library.clone(), installs.clone(), server.clone()));
    let ctx = Ctx {
        terminals: terminals.clone(),
        backend: backend.clone(),
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
        catalog,
        workspace: Arc::new(workspace::Workspace::new(
            cfg.data_dir.clone().map(std::path::PathBuf::from),
            cfg.github_api_url.as_deref(),
        )),
        automation: automation.clone(),
        remote: remote.clone(),
        sandboxes,
        compactions,
        image_turns: image_turns::ImageTurns::new(),
        app: Arc::new(routes::AppCtx {
            facts: small_services::AppFacts { version: cfg.app_version.clone(), edition: cfg.edition.clone() },
            bridge: cfg.browser_bridge.clone().map(|b| (b.url, b.token)),
            decision_models_url: cfg.decision_models_url.clone(),
        }),
        update_checks: small_services::UpdateChecks::new(),
        messaging: messaging.clone(),
        native: cfg
            .native
            .clone()
            .filter(|_| cfg.browser_bridge.is_some())
            .map(|n| native::Native::new(n, cfg.app_version.clone())),
        desktop: match (&cfg.native, &cfg.data_dir, &settings) {
            // A desktop backend, while one runs, still serves these itself.
            (Some(n), Some(d), Some(_)) if cfg.backend.is_none() => {
                Some(desktop::Desktop::new(n, std::path::Path::new(d)))
            }
            _ => None,
        },
    };
    routes::forward_terminal_events(&ctx);
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
    // What a host used to do when it started, with no host to do it (boot.rs):
    // first, so no turn starts before the last run's leftovers are written off.
    if backend.is_none() {
        boot::start(&ctx);
    }
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
    let after = ctx.clone();
    let app = wire::App { ctx, token: cfg.token.clone().into(), origins: Arc::new(cfg.allowed_origins.clone()) };
    let router = wire::router(app);

    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "NEKKOD_READY {}", serde_json::json!({ "port": port, "pid": std::process::id() }))?;
        out.flush()?;
    }

    // The backend goes first, while this daemon still serves: what it is still
    // sending (a settings change, a session save) has somewhere to land.
    let (first, watch_stdin) = (backend.clone(), cfg.exit_on_stdin_close);
    let stop = async move {
        shutdown_signal(watch_stdin).await;
        first.shutdown().await;
    };
    axum::serve(listener, router).with_graceful_shutdown(stop).await?;

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
    backend.shutdown().await;
    terminals.close_all();
    mcp.stop_all();
    processes.kill_all();
    Ok(())
}

/// Resolves when the app that started us is gone (stdin closed) or on Ctrl-C.
async fn shutdown_signal(watch_stdin: bool) {
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
        _ = stdin_closed => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
