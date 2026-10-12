//! `nekkod`, the Nekko Agent engine daemon.
//!
//! Started by the desktop app with a JSON config in `NEKKOD_CONFIG` (see
//! `config.rs`). Prints one line, `NEKKOD_READY {"port":N,"pid":P}`, once it
//! is listening; everything else goes to stderr. Exits when its stdin closes.

mod accounts;
mod admission;
mod automation;
mod backend;
mod catalog;
mod config;
mod connectors;
mod context;
mod decide;
mod decisions;
mod engine;
mod hub;
mod hypergate;
mod loops;
mod machine;
mod mcp;
mod oauth;
mod procgroup;
mod providers;
mod remote;
mod resource_queue;
mod routes;
mod settings;
mod sideband;
mod tooling;
mod turns;
mod voice;
mod watches;
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
                cmd.env.insert(
                    "NEKKOD_OWNS".into(),
                    [settings::OWNS, voice::OWNS, oauth::OWNS, automation::OWNS, remote::OWNS, watches::OWNS].join(","),
                );
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
        // The host tells the UI and the phone relay, as it did when it kept the list.
        let backend = backend.clone();
        changes.set_notifier(move |session_id| {
            let (backend, id) = (backend.clone(), session_id.to_string());
            tokio::spawn(async move {
                let _ = backend.call("changes:notify", serde_json::json!([id])).await;
            });
        });
    }
    let accounts = Arc::new(accounts::Accounts::new(
        cfg.data_dir.clone().map(std::path::PathBuf::from),
        backend.clone(),
        hub.clone(),
    ));
    let settings = cfg.data_dir.clone().map(|d| settings::Settings::new(d.into(), backend.clone()));
    // Voice reads its settings from the daemon's store.
    let voice = cfg.data_dir.clone().zip(settings.clone()).map(|(d, s)| {
        let store = s.store.clone();
        let read: Arc<dyn Fn() -> serde_json::Value + Send + Sync> = Arc::new(move || store.get());
        voice::Voice::new(std::path::PathBuf::from(d).join("voice"), read, voice::Sources::default())
    });
    // `NEKKO_AGENT_LOOP=ts` (here or set for the backend) keeps every turn in the host.
    let ts_loop = std::env::var("NEKKO_AGENT_LOOP").is_ok_and(|v| v == "ts")
        || cfg.backend.as_ref().is_some_and(|b| b.env.get("NEKKO_AGENT_LOOP").is_some_and(|v| v == "ts"));
    let admission = (cfg.data_dir.is_some() && cfg.backend.is_some())
        .then(|| admission::Admission::new(&hub, cfg.allow_browser_control, ts_loop));
    let catalog = settings.as_deref().map(catalog::new);
    let automation =
        Arc::new(automation::Automation::new(sessions.clone(), settings.clone(), backend.clone(), hub.clone()));
    let remote = Arc::new(remote::Remote::new(cfg.data_dir.clone().map(std::path::PathBuf::from), hub.clone()));
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
        (Some(d), Some(store)) => Some(watches::Watches::new(d.into(), store.clone(), backend.clone())),
        _ => None,
    };
    let ctx = Ctx {
        terminals: terminals.clone(),
        backend: backend.clone(),
        hub: hub.clone(),
        engine: engine.clone(),
        sessions: sessions.clone(),
        loops: Arc::new(loops::Loops::new(changes.clone())),
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
            .with_watches(agent_watches.clone()),
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
        machine: Arc::new(nekko_machine::Machine::new(
            cfg.data_dir.clone().map(std::path::PathBuf::from),
            Box::new(engine_bin),
        )),
        resource_queue: cfg.data_dir.clone().map(|d| {
            Arc::new(resource_queue::ResourceQueue::new(
                std::path::PathBuf::from(d),
                Box::new(read_settings(&settings)),
            ))
        }),
        voice: voice.clone(),
        catalog,
        workspace: Arc::new(workspace::Workspace::new(cfg.data_dir.clone().map(std::path::PathBuf::from))),
        automation: automation.clone(),
        remote: remote.clone(),
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
        // A workflow stops a chat through the router, as the UI would.
        let ctx = ctx.clone();
        automation.set_dispatcher(Arc::new(move |channel: String, args: Vec<serde_json::Value>| {
            let ctx = ctx.clone();
            Box::pin(async move { routes::route(&ctx, &channel, args).await })
        }));
    }
    automation.start();
    if let Some(w) = &agent_watches {
        w.start(ctx.turns.clone());
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

    let app = wire::App { ctx, token: cfg.token.clone().into(), origins: Arc::new(cfg.allowed_origins.clone()) };
    let router = wire::router(app);

    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "NEKKOD_READY {}", serde_json::json!({ "port": port, "pid": std::process::id() }))?;
        out.flush()?;
    }

    axum::serve(listener, router).with_graceful_shutdown(shutdown_signal(cfg.exit_on_stdin_close)).await?;

    remote.stop();
    engine.shutdown();
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
