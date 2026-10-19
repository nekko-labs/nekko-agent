//! The model server's runtimes, installed from the daemon
//! (`nekko-engine::install` and `mlx`): `engine:install`,
//! `engine:uninstall`, `engine:installPreview`, `engine:detect` and
//! `engine:installedBin`. The daemon writes `<data>/engine`; the install
//! jobs run in the same queue as the model downloads. The model server is
//! stopped before its files are replaced, and a runtime is not uninstalled
//! under it.

use nekko_engine::download::Downloads;
use nekko_engine::install::{InstallIo, Installer, SystemIo, VcOptions};
use nekko_engine::mlx::MlxRuntime;
use nekko_tools::path::native as path;
use serde_json::{Value, json};
use std::sync::Arc;

pub const CHANNELS: &[&str] =
    &["engine:install", "engine:uninstall", "engine:installPreview", "engine:detect", "engine:installedBin"];

pub struct Installs {
    pub llama: Arc<Installer>,
    diffusion: Arc<Installer>,
    mlx: Arc<MlxRuntime>,
    queue: Downloads,
    engine: Arc<crate::engine::Engine>,
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

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// Whether the model server is running. Before the server is set, the
/// daemon serving the engine's port says so instead.
fn server_running(engine: &crate::engine::Engine) -> bool {
    match engine.server.get() {
        Some(server) => server.is_running(),
        None => engine.router.serving().is_some(),
    }
}

impl Installs {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        data_dir: &str,
        queue: Downloads,
        settings: Arc<nekko_settings::SettingsStore>,
        machine: Arc<nekko_machine::Machine>,
        engine: Arc<crate::engine::Engine>,
        github_api: Option<String>,
    ) -> Arc<Self> {
        let io = Arc::new(SystemIo { client: reqwest::Client::new(), github_api });
        let engine_dir = path::join(&[data_dir, "engine"]);
        let gpu = {
            let machine = machine.clone();
            Arc::new(move || {
                let machine = machine.clone();
                Box::pin(async move { machine.gpu_stats().await.map(|s| s.to_value()) }) as nekko_engine::BoxFuture<_>
            })
        };
        let adapters_cache: Arc<tokio::sync::OnceCell<Vec<Value>>> = Arc::default();
        let adapters = Arc::new(move || {
            let cache = adapters_cache.clone();
            Box::pin(async move { cache.get_or_init(nekko_engine::gpu_adapters::probe).await.clone() })
                as nekko_engine::BoxFuture<_>
        });
        let external = {
            let settings = settings.clone();
            Arc::new(move || nekko_js::truthy_str(settings.get().get("engineBinPath")).map(str::to_string))
        };
        let before_replace = {
            let engine = engine.clone();
            Arc::new(move || {
                let engine = engine.clone();
                // Windows will not replace a running server's files.
                Box::pin(async move {
                    if server_running(&engine)
                        && let Some(server) = engine.server.get()
                    {
                        server.stop().await;
                    }
                }) as nekko_engine::BoxFuture<()>
            })
        };
        let vc = VcOptions {
            system_dir: None,
            runtime_dir: std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned())),
        };
        let installer =
            |runtime: &'static str, dir: String, external: Arc<dyn Fn() -> Option<String> + Send + Sync>| {
                Installer::new(
                    runtime,
                    dir,
                    platform().into(),
                    arch().into(),
                    io.clone() as Arc<dyn InstallIo>,
                    queue.clone(),
                    gpu.clone(),
                    adapters.clone(),
                    external,
                    before_replace.clone(),
                    Arc::new(now),
                    vc.clone(),
                )
            };
        let llama = installer("llama", engine_dir.clone(), external);
        let diffusion = installer("diffusion", path::join(&[&engine_dir, "diffusion"]), Arc::new(|| None));
        let mlx =
            MlxRuntime::new(path::join(&[&engine_dir, "mlx"]), platform().into(), arch().into(), io, queue.clone());
        Arc::new(Self { llama, diffusion, mlx, queue, engine })
    }

    fn installer(&self, runtime: &str) -> &Arc<Installer> {
        if runtime == "diffusion" { &self.diffusion } else { &self.llama }
    }

    /// One runtime's install state (`detect`).
    pub async fn detect(&self, runtime: &str) -> Value {
        if runtime == "mlx" { self.mlx.detect().await } else { self.installer(runtime).detect().await }
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        // `runtime = 'llama'` when left out; a build id only when one is given.
        let text = |i: usize| args.get(i).and_then(Value::as_str).filter(|s| !s.is_empty());
        Ok(match channel {
            "engine:install" => {
                let (build, runtime) = (text(0), text(1).unwrap_or("llama"));
                if runtime == "mlx" { self.mlx.install().await } else { self.installer(runtime).install(build).await }
            }
            "engine:installPreview" => {
                let (runtime, build) = (text(0).unwrap_or("llama"), text(1));
                if runtime == "mlx" { self.mlx.preview() } else { self.installer(runtime).preview(build).await }
            }
            "engine:uninstall" => {
                let runtime = text(0).unwrap_or("llama");
                if server_running(&self.engine) {
                    return Ok(
                        json!({ "ok": false, "message": "Stop the model server before uninstalling a runtime." }),
                    );
                }
                let prefix = format!("engine:{runtime}:");
                let busy = self
                    .queue
                    .list()
                    .iter()
                    .filter_map(|j| j.get("id").and_then(Value::as_str).map(str::to_string))
                    .any(|id| id.starts_with(&prefix) && self.queue.is_active(&id));
                if busy {
                    return Ok(json!({
                        "ok": false,
                        "message": "Wait for the runtime installation to finish or cancel it before uninstalling.",
                    }));
                }
                if runtime == "mlx" { self.mlx.uninstall() } else { self.installer(runtime).uninstall() }
            }
            "engine:detect" => self.detect(text(0).unwrap_or("llama")).await,
            "engine:installedBin" => json!(self.llama.installed_bin().await),
            other => return Err(format!("{other} is not an install channel")),
        })
    }
}
