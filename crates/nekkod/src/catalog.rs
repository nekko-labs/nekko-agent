//! The model catalog (`engine:catalog`, `engine:catalogModel`,
//! `engine:catalogDetail`), served from the daemon (`nekko-engine`). The TS
//! engine keeps its own copy for the downloads it still starts.

use nekko_engine::catalog::{Catalog, HttpFetch};
use serde_json::Value;
use std::sync::Arc;

pub const CHANNELS: &[&str] = &["engine:catalog", "engine:catalogModel", "engine:catalogDetail"];

/// The catalog over the daemon's settings store (`hfToken`, for gated repos).
pub fn new(settings: &crate::settings::Settings) -> Arc<Catalog> {
    let store = settings.store.clone();
    let token = move || nekko_js::truthy_str(store.get().get("hfToken")).map(str::to_string);
    // MLX folders are offered only where `mlx_lm` runs: an Apple Silicon Mac.
    let mlx = || cfg!(all(target_os = "macos", target_arch = "aarch64"));
    Arc::new(Catalog::new(Arc::new(HttpFetch(reqwest::Client::new())), Box::new(token), Box::new(mlx)))
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
