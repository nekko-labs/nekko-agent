//! The model library and its folders, served from the daemon
//! (`nekko-engine::library`): `engine:models`, `engine:importModel`,
//! `engine:deleteModel`, `engine:saveModelPreset`, `engine:folders`,
//! `engine:foldersSave` and `engine:autoload`, plus `engine:library`, the
//! bare rows the TS engine's model server reads. The daemon is the single
//! writer of `<models>/library.json`; the folder list and the autoload list
//! are engine settings, saved through the settings store; the first read of
//! the library seeds the folder list from the other apps on this machine, as
//! the host did at startup. Load state (which models are resident, the last
//! failure) is the daemon's model server's (model_server.rs).

use nekko_engine::capacity::{Device, Hardware};
use nekko_engine::library::{self as lib, LibraryConfig};
use nekko_settings::SettingsStore;
use nekko_tools::path::native as path;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

pub const CHANNELS: &[&str] = &[
    "engine:models",
    "engine:importModel",
    "engine:deleteModel",
    "engine:saveModelPreset",
    "engine:folders",
    "engine:foldersSave",
    "engine:autoload",
    "engine:library",
];

const MB: f64 = 1024.0 * 1024.0;

/// `DEFAULT_ENGINE_SETTINGS`, in its key order.
fn default_engine_settings() -> Map<String, Value> {
    let Value::Object(m) = json!({
        "port": 11500,
        "bind": "local",
        "autoStart": false,
        "jitLoad": true,
        "idleTtlSeconds": 900,
        "maxLoaded": 2,
    }) else {
        unreachable!()
    };
    m
}

/// `{ ...DEFAULT_ENGINE_SETTINGS, ...settings.engine }`.
pub fn engine_settings(settings: &Value) -> Map<String, Value> {
    let mut m = default_engine_settings();
    if let Some(engine) = settings.get("engine") {
        nekko_js::spread_into(&mut m, engine);
    }
    m
}

pub struct Library {
    settings: Arc<crate::settings::Settings>,
    store: Arc<SettingsStore>,
    data_dir: PathBuf,
    machine: Arc<nekko_machine::Machine>,
    engine: Arc<crate::engine::Engine>,
    /// One library operation at a time: they all read, change and write the index.
    lock: tokio::sync::Mutex<()>,
    /// Set once the first-start folder seed has run (or was not needed).
    seeded: tokio::sync::OnceCell<()>,
    /// The runtime installers, for the installed engine's version.
    installs: std::sync::OnceLock<Arc<crate::installs::Installs>>,
}

impl Library {
    pub fn new(
        settings: Arc<crate::settings::Settings>,
        machine: Arc<nekko_machine::Machine>,
        engine: Arc<crate::engine::Engine>,
    ) -> Arc<Self> {
        let store = settings.store.clone();
        let data_dir = store.path().parent().map(std::path::Path::to_path_buf).unwrap_or_default();
        Arc::new(Self {
            settings,
            store,
            data_dir,
            machine,
            engine,
            lock: tokio::sync::Mutex::new(()),
            seeded: tokio::sync::OnceCell::new(),
            installs: std::sync::OnceLock::new(),
        })
    }

    /// The library's folders as the engine settings say now.
    fn config(&self) -> LibraryConfig {
        let engine = engine_settings(&self.store.get());
        let models_dir = nekko_js::truthy_str(engine.get("modelsDir"))
            .map(str::to_string)
            .unwrap_or_else(|| path::join(&[&self.data_dir.to_string_lossy(), "models"]));
        LibraryConfig {
            models_dir,
            folders: engine.get("modelFolders").and_then(Value::as_array).cloned().unwrap_or_default(),
            mlx_runnable: cfg!(all(target_os = "macos", target_arch = "aarch64")),
            now: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |d| d.as_millis() as f64),
        }
    }

    /// Run one library operation off the async threads, serialized.
    async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(LibraryConfig) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let _turn = self.lock.lock().await;
        let cfg = self.config();
        tokio::task::spawn_blocking(move || f(cfg)).await.map_err(|e| e.to_string())?
    }

    /// The bare rows (`library.list()`).
    pub async fn list(self: &Arc<Self>) -> Result<Vec<Value>, String> {
        self.seed().await;
        self.run(|cfg| lib::list(&cfg)).await
    }

    /// One row by id (`library.find`).
    pub async fn find(self: &Arc<Self>, id: &str) -> Result<Option<Value>, String> {
        Ok(self.list().await?.into_iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id)))
    }

    /// Save a model's load preset (`library.savePreset`).
    pub async fn save_preset(self: &Arc<Self>, id: &str, preset: Value) -> Result<(), String> {
        let id = id.to_string();
        self.run(move |cfg| lib::save_preset(&cfg, &id, &preset)).await
    }

    /// Where downloads land (`modelsDir`).
    pub fn models_dir(&self) -> String {
        self.config().models_dir
    }

    /// The current settings.
    pub fn settings(&self) -> Value {
        self.store.get()
    }

    /// What the model server knows: the resident ids, the last load errors
    /// and the installed llama.cpp version. Before the server is set, the
    /// daemon's own record of what it runs says what is loaded.
    pub fn set_installs(&self, installs: Arc<crate::installs::Installs>) {
        let _ = self.installs.set(installs);
    }

    pub async fn host_state(&self) -> (HashSet<String>, Map<String, Value>, Option<Value>) {
        // The daemon's own model server, when it runs one.
        if let (Some(server), Some(installs)) = (self.engine.server.get(), self.installs.get()) {
            let version = installs.detect("llama").await.get("version").cloned();
            return (server.loaded_ids().into_iter().collect(), server.load_errors(), version);
        }
        (self.engine.supervisor.list().into_iter().map(|c| c.model_id).collect(), Map::new(), None)
    }

    /// `overheadFloorFor('llamacpp', version)` from `runtime-calibration.json`.
    pub fn overhead_floor(&self, version: Option<&Value>) -> f64 {
        let calibration = std::fs::read(self.data_dir.join("runtime-calibration.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({}));
        nekko_engine::runtimes::overhead_floor(&calibration, "llamacpp", version)
    }

    /// `engine:models`: rows with load state, the last failure and the GPU fit.
    pub async fn models(self: &Arc<Self>) -> Result<Value, String> {
        let rows = self.list().await?;
        let (loaded, errors, version) = self.host_state().await;
        let hw = self.hardware().await;
        let floor = self.overhead_floor(version.as_ref());
        Ok(Value::Array(lib::with_load_state(rows, &loaded, &errors, Some(&hw), Some(floor))))
    }

    /// The machine's memory pools in the planner's shape (`hardware()`).
    pub async fn hardware(&self) -> Hardware {
        let gpu = self.machine.gpu_stats().await;
        let (ram_total, ram_free) = nekko_machine::probe::memory_now();
        Hardware {
            devices: gpu
                .as_ref()
                .map(|g| {
                    g.devices
                        .iter()
                        .map(|d| Device { name: d.name.clone(), total: d.total_mb * MB, free: d.free_mb * MB })
                        .collect()
                })
                .unwrap_or_default(),
            unified: gpu.as_ref().is_some_and(|g| g.unified),
            ram_total,
            ram_free,
        }
    }

    /// Save an engine settings patch as the TS engine's `saveSettings` does:
    /// `{ ...DEFAULT_ENGINE_SETTINGS, ...settings.engine, ...patch }`, which
    /// it returns. The host hears about it (`settings:changed`).
    pub async fn save_engine(&self, patch: Value) -> Result<Value, String> {
        let mut next = engine_settings(&self.store.get());
        nekko_js::spread_into(&mut next, &patch);
        let next = Value::Object(next);
        crate::settings::route(&self.settings, "settings:update", &[json!({ "engine": next })]).await?;
        Ok(next)
    }

    /// The folder list with suggestions, from this machine's other apps.
    async fn folders(self: &Arc<Self>) -> Result<Value, String> {
        self.seed().await;
        self.run(|cfg| lib::folders_with_suggestions(&cfg, &nekko_engine::folders::machine_candidates())).await
    }

    /// With no folder list at all, adopt every known folder on this machine
    /// that has models in it (`seedFolders`), before the library is first
    /// read. Once per daemon, and never again once a list is saved: a folder
    /// removed on purpose stays removed. Never fatal.
    async fn seed(self: &Arc<Self>) {
        self.seeded
            .get_or_init(|| async {
                if engine_settings(&self.store.get()).contains_key("modelFolders") {
                    return;
                }
                let found = self
                    .run(|cfg| Ok(lib::seed_folder_list(&cfg.models_dir, &nekko_engine::folders::machine_candidates())))
                    .await;
                let saved = match found {
                    Ok(found) => self.save_engine(json!({ "modelFolders": found })).await.map(|_| ()),
                    Err(e) => Err(e),
                };
                if let Err(e) = saved {
                    eprintln!("nekkod: seeding the model folders failed: {e}");
                }
            })
            .await;
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let text = |i: usize| nekko_js::display(&arg(i));
        match channel {
            "engine:library" => Ok(Value::Array(self.list().await?)),
            "engine:models" => self.models().await,
            "engine:importModel" => {
                let p = text(0);
                self.run(move |cfg| lib::import_file(&cfg, &p)).await
            }
            "engine:deleteModel" => {
                let id = text(0);
                self.run(move |cfg| lib::remove(&cfg, &id)).await
            }
            "engine:saveModelPreset" => {
                let (id, preset) = (text(0), arg(1));
                self.run(move |cfg| lib::save_preset(&cfg, &id, &preset)).await.map(|()| Value::Null)
            }
            "engine:folders" => self.folders().await,
            "engine:foldersSave" => {
                // The primary folder is not in the list and never moves here.
                let Value::Array(next) = arg(0) else {
                    return Err("next.filter is not a function".into());
                };
                let next: Vec<Value> = next
                    .into_iter()
                    .filter(|f| f.get("id").and_then(Value::as_str) != Some(lib::PRIMARY_FOLDER_ID))
                    .collect();
                self.save_engine(json!({ "modelFolders": next })).await?;
                self.folders().await
            }
            "engine:autoload" => {
                // The list loaded when the engine starts.
                let (id, enabled) = (arg(0), nekko_js::truthy(args.get(1)));
                let current = engine_settings(&self.store.get())
                    .get("autoload")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let next: Vec<Value> = if enabled {
                    let mut out: Vec<Value> = Vec::new();
                    for v in current.into_iter().chain(std::iter::once(id)) {
                        if !out.contains(&v) {
                            out.push(v);
                        }
                    }
                    out
                } else {
                    current.into_iter().filter(|m| *m != id).collect()
                };
                self.save_engine(json!({ "autoload": next })).await
            }
            other => Err(format!("{other} is not a library channel")),
        }
    }
}
