//! Model downloads, served from the daemon (`nekko-engine::download` and
//! `acquire`): `engine:downloadModel`, `engine:downloadCompanions`,
//! `engine:imageCompanions`, `engine:downloadImageCompanions`,
//! `engine:downloads`, `engine:cancelDownload` and `engine:dismissDownload`.
//!
//! The runtime installs (llama.cpp, stable-diffusion.cpp, MLX) still run in
//! the TS engine's own queue, so the list the UI sees is both: the host
//! sends its jobs here on every change (`engine:hostDownloads`), the daemon
//! publishes the merged list (`downloads:updated`), and a cancel or dismiss
//! for one of the host's jobs goes back to it (`engine:runtime`). When a
//! model finishes, the daemon does what the host did: turn on `autoStart`
//! and save a GPU-first preset for it.

use crate::hub::Hub;
use crate::library::Library;
use nekko_engine::BoxFuture;
use nekko_engine::acquire;
use nekko_engine::catalog::Catalog;
use nekko_engine::download::{Downloads, Fetch, HttpFetch, Reply, Request};
use nekko_engine::folders::companions_dir;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const CHANNELS: &[&str] = &[
    "engine:downloadModel",
    "engine:downloadCompanions",
    "engine:imageCompanions",
    "engine:downloadImageCompanions",
    "engine:downloads",
    "engine:cancelDownload",
    "engine:dismissDownload",
    "engine:hostDownloads",
];

/// Downloads from Hugging Face wherever the config says it is (`huggingFaceUrl`).
pub struct Rebased(pub HttpFetch, pub Option<String>);

impl Fetch for Rebased {
    fn get(&self, url: String, headers: Vec<(String, String)>) -> BoxFuture<Result<Reply, String>> {
        self.0.get(crate::catalog::rebase(url, self.1.as_deref()), headers)
    }
}

pub struct ModelDownloads {
    queue: Downloads,
    library: Arc<Library>,
    catalog: Arc<Catalog>,
    hub: Hub,
    /// The host's own jobs (runtime installs), as it last sent them.
    host_jobs: Mutex<Vec<Value>>,
    /// Every job's last state, so a finished model is followed up once.
    seen: Mutex<HashMap<String, String>>,
}

fn landed(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.len() > 0)
}

impl ModelDownloads {
    pub fn new(fetch: Arc<dyn Fetch>, library: Arc<Library>, catalog: Arc<Catalog>, hub: Hub) -> Arc<Self> {
        Arc::new_cyclic(|me: &std::sync::Weak<ModelDownloads>| {
            let me = me.clone();
            let queue = Downloads::new(fetch, Arc::new(nekko_js::now_ms_f64), move |jobs| {
                if let Some(me) = me.upgrade() {
                    me.changed(jobs);
                }
            });
            ModelDownloads { queue, library, catalog, hub, host_jobs: Mutex::default(), seen: Mutex::default() }
        })
    }

    /// Ours and the host's, newest first.
    fn merged(&self, ours: Vec<Value>) -> Vec<Value> {
        let mut all = ours;
        all.extend(self.host_jobs.lock().unwrap().iter().cloned());
        let started = |j: &Value| j.get("startedAt").and_then(Value::as_f64).unwrap_or(0.0);
        all.sort_by(|a, b| started(b).partial_cmp(&started(a)).unwrap_or(std::cmp::Ordering::Equal));
        all
    }

    fn publish(&self, ours: Vec<Value>) {
        self.hub.publish("downloads:updated", Value::Array(self.merged(ours)), false);
    }

    /// The queue changed: tell the UI, and follow up finished models.
    fn changed(self: &Arc<Self>, jobs: Vec<Value>) {
        let finished = acquire::finished_model_jobs(&jobs, &mut self.seen.lock().unwrap());
        self.publish(jobs);
        if finished.is_empty() {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            for job in finished {
                if let Err(e) = me.on_model_downloaded(&job).await {
                    eprintln!("nekkod: after downloading {}: {e}", job["id"]);
                }
            }
        });
    }

    /// What finishing a model download sets up for free: the engine starts
    /// with the app from now on, and the model gets settings planned for
    /// this machine. An existing preset is a choice somebody made.
    async fn on_model_downloaded(&self, job: &Value) -> Result<(), String> {
        let engine = crate::library::engine_settings(&self.library.settings());
        if !nekko_js::truthy(engine.get("autoStart")) {
            self.library.save_engine(json!({ "autoStart": true })).await?;
        }
        let list = self.library.list().await?;
        let Some(model) = acquire::downloaded_model(&list, job) else { return Ok(()) };
        // A picture model starts only with its text encoders and VAE: fetch
        // them now, wherever the download was started from, rather than at
        // the first prompt. Files already on disk are skipped.
        if model.get("modality").and_then(Value::as_str) == Some("image")
            && acquire::image_companion_set_for(&model).is_some()
        {
            let id = model.get("id").map(nekko_js::display).unwrap_or_default();
            self.download_image_companions(&id).await?;
        }
        if model.get("format").and_then(Value::as_str) == Some("mlx") || nekko_js::truthy(model.get("preset")) {
            return Ok(());
        }
        let hw = self.library.hardware().await;
        // No GPU to fill: the engine defaults already mean CPU.
        if hw.devices.is_empty() {
            return Ok(());
        }
        let (_, _, install) = self.library.host_state().await;
        let version = install.as_ref().and_then(|i| i.get("version"));
        let floor = self.library.overhead_floor(version);
        if let Some(preset) = acquire::gpu_first_preset(&model, Some(&hw), floor) {
            let id = model.get("id").map(nekko_js::display).unwrap_or_default();
            self.library.save_preset(&id, preset).await?;
        }
        Ok(())
    }

    fn hf_token(&self) -> Option<String> {
        nekko_js::truthy_str(self.library.settings().get("hfToken")).map(str::to_string)
    }

    fn start(&self, planned: &Value, verify_gguf: bool) -> Value {
        let mut req = Request::from_value(planned);
        req.verify = verify_gguf.then(nekko_engine::download::gguf_verify);
        self.queue.start(req)
    }

    /// One quantization of a catalog model (`downloadModel`).
    async fn download_model(&self, model_id: &str, quant: &str, choice: &Value) -> Value {
        let mut model = self.catalog.model(model_id).await;
        let selected = model["quants"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|q| q["label"] == quant && (choice.is_null() || q["file"] == choice["file"]))
            .cloned();
        let Some(selected) = selected else { return acquire::refusal("That build is no longer published.") };
        let dir = self.library.models_dir();
        let mut base_plan = None;
        let file = selected["file"].as_str().unwrap_or_default();
        // No library scan for an ordinary build. A detail download has already read its
        // header, but other entry points may not have, so check the selected file here.
        let facts = if selected["format"] == "mlx" { None } else { self.catalog.file_facts(model_id, file).await };
        let dependent = model["dependent"] == true
            || selected["dependent"] == true
            || !choice.is_null()
            || facts.as_ref().is_some_and(Catalog::facts_are_dependent);
        if dependent {
            let installed = match self.library.list().await {
                Ok(m) => m,
                Err(e) => return acquire::refusal(format!("Could not check the local base models: {e}")),
            };
            if let Some(companion) = self.catalog.companion(&model, &selected, &installed, true).await {
                if choice.is_null() {
                    return acquire::refusal("Open this companion in the catalog to choose how to download it.");
                }
                if let Some(reason) = companion["reason"].as_str() {
                    return acquire::refusal(reason);
                }
                let offered = &companion["base"];
                let accepted = &choice["base"];
                if companion["installedBase"].is_null() {
                    if offered.is_null() {
                        return acquire::refusal("No compatible base build was verified.");
                    }
                    if !accepted.is_null() {
                        if offered != accepted {
                            return acquire::refusal(
                                "The compatible base download changed. Reopen the model page and check its size before downloading both.",
                            );
                        }
                        let repo = offered["repo"].as_str().unwrap_or_default();
                        let label = offered["quant"].as_str().unwrap_or_default();
                        let mut base = self.catalog.model(repo).await;
                        let build = base["quants"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .find(|q| q["label"] == label && q["file"] == offered["file"])
                            .cloned();
                        let Some(build) = build else {
                            return acquire::refusal("The compatible base build is no longer available.");
                        };
                        base["quants"] = json!([build]);
                        let plan = acquire::model_download_plan(&base, repo, label, &dir, &landed);
                        if plan["ok"] != true {
                            return plan;
                        }
                        base_plan = Some(plan);
                    }
                }
                // A GGUF adapter is one file. It must not inherit the repository's
                // projector or tokenizer (including when its filename did not say LoRA).
                if companion["kind"] == "lora" {
                    let mut selected = selected;
                    selected["extraFiles"] = json!([]);
                    model["quants"] = json!([selected]);
                } else {
                    model["quants"] = json!([selected]);
                }
            } else if !choice["base"].is_null() {
                return acquire::refusal("This build does not have a verified base download.");
            } else {
                model["quants"] = json!([selected]);
            }
        } else {
            model["quants"] = json!([selected]);
        }
        let plan = acquire::model_download_plan(&model, model_id, quant, &dir, &landed);
        if plan["ok"] != true {
            return plan;
        }
        // Plan and validate both before enqueuing either. Do not re-download a
        // compatible installed base, even if it appeared after the page opened.
        let paired = base_plan.is_some();
        let job = self.start_plan(&plan);
        if let Some(base) = base_plan {
            self.start_plan(&base);
        }
        json!({ "ok": true, "message": if paired { json!("Queued the companion and its base model.") } else { plan["message"].clone() }, "jobId": job["id"] })
    }

    fn start_plan(&self, plan: &Value) -> Value {
        let job = self.start(&plan["main"], plan["verifyGguf"] == true);
        for extra in plan["extras"].as_array().into_iter().flatten() {
            self.start(extra, false);
        }
        job
    }

    /// The files a model on disk is missing, from its repo (`downloadCompanions`).
    async fn download_companions(&self, model_id: &str) -> Result<Value, String> {
        let Some(model) = self.library.find(model_id).await? else {
            return Ok(acquire::refusal("That model is not in the library."));
        };
        let Some(repo) = acquire::source_repo_for(&model) else {
            let name = model.get("name").map(nekko_js::display).unwrap_or_default();
            return Ok(acquire::refusal(format!(
                "Cannot tell which Hugging Face repo {name} came from, so there is nowhere to fetch its companion files from."
            )));
        };
        let found = self.catalog.companions(&repo).await;
        let plan = acquire::companions_plan(&model, &repo, &found, &self.library.models_dir(), &landed);
        for request in plan["requests"].as_array().into_iter().flatten() {
            self.start(request, false);
        }
        Ok(json!({ "ok": plan["ok"], "message": plan["message"] }))
    }

    /// An image model's text encoders and VAE (`imageCompanions`).
    async fn image_companions(&self, model_id: &str) -> Result<Value, String> {
        let model = self.library.find(model_id).await?;
        let Some(model) = model.filter(|m| m.get("modality").and_then(Value::as_str) == Some("image")) else {
            return Ok(Value::Null);
        };
        let dir = self.library.models_dir();
        let id = model.get("id").map(nekko_js::display).unwrap_or_default();
        let token = self.hf_token();
        tokio::task::spawn_blocking(move || {
            let beside = acquire::companions_beside(&model, &[companions_dir(&dir, &id)]);
            acquire::image_companion_status(&model, &acquire::image_companions_dir(&dir), &beside, token.is_some())
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// Fetch what an image model's set lacks (`downloadImageCompanions`).
    async fn download_image_companions(&self, model_id: &str) -> Result<Value, String> {
        let Some(model) = self.library.find(model_id).await? else {
            return Ok(acquire::refusal("That model is not in the library."));
        };
        let status = self.image_companions(model_id).await?;
        let token = self.hf_token();
        let plan = acquire::image_companions_plan(&model, &status, token.as_deref(), &self.library.models_dir());
        for request in plan["requests"].as_array().into_iter().flatten() {
            self.start(request, false);
        }
        Ok(json!({ "ok": plan["ok"], "message": plan["message"] }))
    }

    /// The queue, which the runtime installs share.
    pub fn queue(&self) -> Downloads {
        self.queue.clone()
    }

    fn ours(&self, id: &str) -> bool {
        self.queue.list().iter().any(|j| j.get("id").and_then(Value::as_str) == Some(id))
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        let text = |i: usize| args.get(i).map(nekko_js::display).unwrap_or_else(|| "undefined".into());
        match channel {
            "engine:downloadModel" => {
                Ok(self.download_model(&text(0), &text(1), args.get(2).unwrap_or(&Value::Null)).await)
            }
            "engine:downloadCompanions" => self.download_companions(&text(0)).await,
            "engine:imageCompanions" => self.image_companions(&text(0)).await,
            "engine:downloadImageCompanions" => self.download_image_companions(&text(0)).await,
            // The host's jobs arrive pushed (`engine:hostDownloads`); with the
            // runtimes here, its queue is empty.
            "engine:downloads" => Ok(Value::Array(self.merged(self.queue.list()))),
            "engine:cancelDownload" | "engine:dismissDownload" => {
                let id = text(0);
                let cancel = channel == "engine:cancelDownload";
                // A job that is not ours is unknown (the host's queue holds nothing
                // since the runtime installs moved here): nothing to do, as before.
                if self.ours(&id) {
                    if cancel {
                        self.queue.cancel(&id);
                    } else {
                        self.queue.dismiss(&id);
                    }
                }
                Ok(Value::Null)
            }
            // The host's queue changed: merge it into what the UI sees.
            "engine:hostDownloads" => {
                *self.host_jobs.lock().unwrap() = args.first().and_then(Value::as_array).cloned().unwrap_or_default();
                self.publish(self.queue.list());
                Ok(Value::Null)
            }
            other => Err(format!("{other} is not a download channel")),
        }
    }
}

/// A `<file>.part` untouched this long is an abandoned download (#1035).
pub const STALE_PART: std::time::Duration = std::time::Duration::from_secs(7 * 86_400);

/// Remove `.part` files under `dir` not written for [`STALE_PART`]; the queue
/// is not kept across restarts, so only a new download of the same file would
/// have resumed one. Returns the bytes freed. Never follows a symlink.
pub fn sweep_stale_parts(dir: &std::path::Path, now: std::time::SystemTime) -> u64 {
    let mut freed = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
            if meta.is_dir() {
                stack.push(e.path());
            } else if meta.is_file()
                && e.path().extension().is_some_and(|x| x == "part")
                && meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= STALE_PART)
                && std::fs::remove_file(e.path()).is_ok()
            {
                freed += meta.len();
            }
        }
    }
    freed
}

#[cfg(test)]
mod stale_parts_tests {
    use super::*;

    #[test]
    fn only_old_part_files_go() {
        let d = std::env::temp_dir().join(format!("nekko-parts-{}", std::process::id()));
        std::fs::create_dir_all(d.join("gguf/repo")).unwrap();
        std::fs::write(d.join("gguf/repo/a.gguf.part"), b"12345").unwrap();
        std::fs::write(d.join("gguf/repo/b.gguf"), b"model").unwrap();
        let soon = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        assert_eq!(sweep_stale_parts(&d, soon), 0, "a fresh .part stays");
        let later = std::time::SystemTime::now() + STALE_PART + std::time::Duration::from_secs(60);
        assert_eq!(sweep_stale_parts(&d, later), 5);
        assert!(!d.join("gguf/repo/a.gguf.part").exists());
        assert!(d.join("gguf/repo/b.gguf").exists(), "finished models are never touched");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
