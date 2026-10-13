//! The model catalog (`engine:catalog`, `engine:catalogModel`,
//! `engine:catalogDetail`), served from the daemon (`nekko-engine`). The TS
//! engine keeps its own copy for the downloads it still starts.

use nekko_engine::BoxFuture;
use nekko_engine::catalog::{Catalog, Fetch, HttpFetch, Reply};
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
}

pub const CHANNELS: &[&str] = &["engine:catalog", "engine:catalogModel", "engine:catalogDetail"];

/// The catalog over the daemon's settings store (`hfToken`, for gated repos).
pub fn new(settings: &crate::settings::Settings, hf: Option<String>) -> Arc<Catalog> {
    let store = settings.store.clone();
    let token = move || nekko_js::truthy_str(store.get().get("hfToken")).map(str::to_string);
    // MLX folders are offered only where `mlx_lm` runs: an Apple Silicon Mac.
    let mlx = || cfg!(all(target_os = "macos", target_arch = "aarch64"));
    Arc::new(Catalog::new(Arc::new(Rebased(HttpFetch(reqwest::Client::new()), hf)), Box::new(token), Box::new(mlx)))
}

pub async fn route(catalog: &Catalog, channel: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    match channel {
        "engine:catalog" => Ok(Value::Array(catalog.catalog(arg(0), arg(1)).await)),
        "engine:catalogModel" => Ok(catalog.model(&nekko_js::display(arg(0))).await),
        "engine:catalogDetail" => Ok(catalog.detail(&nekko_js::display(arg(0))).await),
        other => Err(format!("{other} is not a catalog channel")),
    }
}
