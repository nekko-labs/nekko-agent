//! The model catalog (`engine:catalog`, `engine:catalogModel`,
//! `engine:catalogDetail`), served from the daemon (`nekko-engine`). The TS
//! engine keeps its own copy for the downloads it still starts.

use nekko_engine::BoxFuture;
use nekko_engine::catalog::{Catalog, Fetch, HttpFetch, Reply, with_stock};
use nekko_engine::load_check::EngineInUse;
use serde_json::Value;
use std::sync::Arc;

/// Hugging Face's address, as every catalog and download URL starts.
pub const HF: &str = "https://huggingface.co";

/// `url` with Hugging Face moved to `base` (the daemon's `huggingFaceUrl`).
pub fn rebase(url: String, base: Option<&str>) -> String {
    match (base, url.strip_prefix(HF)) {
        (Some(base), Some(rest)) => format!("{}{rest}", base.trim_end_matches('/')),
        _ => url,
    }
}

/// The catalog's requests, sent to Hugging Face wherever the config says it is.
struct Rebased(HttpFetch, Option<String>);

impl Fetch for Rebased {
    fn get(&self, url: String, headers: Vec<(&'static str, String)>) -> BoxFuture<Result<Reply, String>> {
        self.0.get(rebase(url, self.1.as_deref()), headers)
    }
    fn get_bytes(
        &self,
        url: String,
        headers: Vec<(&'static str, String)>,
        max: usize,
    ) -> BoxFuture<Result<(u16, Vec<u8>), String>> {
        self.0.get_bytes(rebase(url, self.1.as_deref()), headers, max)
    }
}

pub const CHANNELS: &[&str] = &["engine:catalog", "engine:catalogModel", "engine:catalogDetail"];

/// What the engine in use makes of each build of a repo (`engine:catalogChecks`),
/// so the Models page's list of builds says the same as the library rows.
pub const CHECK_CHANNELS: &[&str] = &["engine:catalogChecks"];

/// The catalog over the daemon's settings store (`hfToken`, for gated repos).
pub fn new(settings: &crate::settings::Settings, hf: Option<String>, data_dir: &std::path::Path) -> Arc<Catalog> {
    let store = settings.store.clone();
    let token = move || nekko_js::truthy_str(store.get().get("hfToken")).map(str::to_string);
    // MLX folders are offered only where `mlx_lm` runs: an Apple Silicon Mac.
    let mlx = || cfg!(all(target_os = "macos", target_arch = "aarch64"));
    // What a build's header says is kept for good, one small file per Hugging Face file hash.
    let headers = data_dir.join("catalog").join("gguf-headers");
    Arc::new(
        Catalog::new(Arc::new(Rebased(HttpFetch(reqwest::Client::new()), hf)), Box::new(token), Box::new(mlx))
            .with_header_cache(headers),
    )
}

pub async fn route(
    catalog: &Catalog,
    library: &Arc<crate::library::Library>,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    match channel {
        "engine:catalog" => Ok(Value::Array(catalog.catalog(arg(0), arg(1)).await)),
        "engine:catalogModel" => Ok(with_stock(catalog.model(&nekko_js::display(arg(0))).await)),
        "engine:catalogDetail" => {
            let id = nekko_js::display(arg(0));
            let mut model = with_stock(catalog.detail(&id).await);
            let quants = model["quants"].as_array().cloned().unwrap_or_default();
            let needs_library = model["dependent"] == true
                || quants.iter().any(|q| {
                    q["dependent"] == true
                        || q["file"].as_str().is_some_and(|file| catalog.known_facts(&id, file).is_some())
                });
            if needs_library {
                let installed = library.list().await?;
                let mut resolved = Vec::new();
                for mut q in quants {
                    if let Some(companion) = catalog.companion(&model, &q, &installed, false).await {
                        q["companion"] = companion;
                    }
                    resolved.push(q);
                }
                if !resolved.is_empty() && resolved.iter().all(|q| !q["companion"].is_null()) {
                    model["dependent"] = Value::Bool(true);
                }
                model["quants"] = Value::Array(resolved);
            }
            Ok(model)
        }
        other => Err(format!("{other} is not a catalog channel")),
    }
}

/// `engine:catalogChecks(repo, file?)`: [`Catalog::load_checks`] against the engine a
/// load would use, as the library listing judges files on disk. Without `file` it
/// answers from headers already known and fetches nothing; with it, that one build's
/// header is read first.
pub async fn route_checks(
    catalog: &Catalog,
    library: &crate::library::Library,
    args: &[Value],
) -> Result<Value, String> {
    let id = args.first().map(nekko_js::display).unwrap_or_default();
    if id.is_empty() {
        return Err("engine:catalogChecks needs a repo".to_string());
    }
    let (_, _, install) = library.host_state().await;
    let engine = install.as_ref().map(EngineInUse::from_install).unwrap_or_default();
    let file = args.get(1).filter(|v| !v.is_null()).map(nekko_js::display).filter(|f| !f.is_empty());
    Ok(catalog.load_checks(&id, &engine, file.as_deref()).await)
}
