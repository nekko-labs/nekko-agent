//! Model providers, owned by the daemon (PF14): the provider list in
//! settings.json, local server discovery, connection tests, model lists and
//! LM Studio's `lms` probe.
//!
//! `providers:list/save/remove/discover/probe/test/testConfig`, `models:list/listStatus`
//! and `lms:probe`, ported from the TS host (host.ts, `discoverLocalProviders`,
//! lms.ts). The provider list is a setting, so writes go through
//! `crate::settings::update` and the host hears of them. A provider signed in
//! through OAuth gets a fresh token from `crate::oauth` ([`resolve`]); other
//! daemon modules use [`resolve_provider`] and [`list_models`]. Owned while
//! the daemon knows the data directory (it then owns settings and tokens).

use crate::routes::Ctx;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const CHANNELS: &[&str] = &[
    "providers:list",
    "providers:save",
    "providers:remove",
    "providers:discover",
    "providers:probe",
    "providers:test",
    "providers:testConfig",
    "models:list",
    "models:listStatus",
    "lms:probe",
];

/// `DISCOVERY_TARGETS` (shared/models.ts): well-known local model servers.
const DISCOVERY_TARGETS: &[(&str, &str, &str)] = &[
    ("ollama", "http://localhost:11434", "/api/tags"),
    ("lmstudio", "http://localhost:1234/v1", "/models"),
    ("vllm", "http://localhost:8000/v1", "/models"),
];
const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(1500);

const LMS_REMOTE: &str = "Per-model load/unload needs the lms CLI on the machine running LM Studio. This server looks remote, use Stop server instead.";
const LMS_MISSING: &str =
    "LM Studio's lms CLI wasn't found. Run `lms bootstrap` (or reinstall LM Studio) to enable per-model load/unload.";

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    let id = |i: usize| match args.get(i) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    match channel {
        "providers:list" => Ok(providers(ctx).await.into()),
        "providers:save" => {
            let p = arg(0);
            if p.is_null() {
                return Err("Cannot read properties of undefined (reading 'id')".into());
            }
            let mut list: Vec<Value> =
                providers(ctx).await.into_iter().filter(|x| x.get("id") != p.get("id")).collect();
            list.push(p);
            save(ctx, list).await
        }
        "providers:remove" => {
            let target = id(0);
            let list = providers(ctx).await;
            if let Some(key) =
                find(&list, &target).and_then(|p| p.get("tokenKey")).filter(|k| nekko_js::truthy(Some(k)))
            {
                ctx.accounts.route("limits:clear", std::slice::from_ref(key)).await?;
            }
            save(
                ctx,
                list.into_iter().filter(|x| x.get("id").and_then(Value::as_str) != Some(target.as_str())).collect(),
            )
            .await
        }
        "providers:discover" => {
            let found = discover().await;
            let mut merged = providers(ctx).await;
            for d in found {
                if !merged.iter().any(|p| p.get("baseUrl") == d.get("baseUrl")) {
                    merged.push(d);
                }
            }
            save(ctx, merged).await
        }
        "providers:probe" => Ok(discover().await.into()),
        "providers:test" => {
            let Some(p) = find(&providers(ctx).await, &id(0)).cloned() else {
                return Ok(json!({ "ok": false, "message": "Not found" }));
            };
            if !is_enabled(&p) {
                return Ok(json!({ "ok": false, "message": DISABLED }));
            }
            Ok(test(ctx, &p).await)
        }
        "providers:testConfig" => Ok(test(ctx, &arg(0)).await),
        "models:list" => Ok(list_models(ctx, &id(0)).await),
        "models:listStatus" => Ok(list_models_status(ctx, &id(0)).await),
        "lms:probe" => {
            let Some(p) = find(&providers(ctx).await, &id(0)).cloned() else {
                return Ok(json!({ "available": false }));
            };
            if p.get("kind").and_then(Value::as_str) != Some("lmstudio") {
                return Ok(json!({ "available": false }));
            }
            if !is_enabled(&p) {
                return Ok(json!({ "available": false, "reason": DISABLED }));
            }
            let base = p.get("baseUrl").map(nekko_js::display).unwrap_or_default();
            if !is_localhost_url(&base) {
                return Ok(json!({ "available": false, "reason": LMS_REMOTE }));
            }
            Ok(if lms_installed().await {
                json!({ "available": true })
            } else {
                json!({ "available": false, "reason": LMS_MISSING })
            })
        }
        other => Err(format!("{other} is not a providers channel")),
    }
}

async fn providers(ctx: &Ctx) -> Vec<Value> {
    crate::settings::current(ctx).await.get("providers").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// A provider switched off on the Models page is never contacted or launched.
pub const DISABLED: &str = "This provider is disabled. Turn it on in Model Providers to use it.";

/// Only an explicit `enabled: false` switches a provider off for probing, so
/// an older entry saved without the field keeps being checked.
pub fn is_enabled(p: &Value) -> bool {
    p.get("enabled") != Some(&Value::Bool(false))
}

/// The `kind` of the settings provider `id`, when there is one.
pub async fn kind_of(ctx: &Ctx, id: &str) -> Option<String> {
    find(&providers(ctx).await, id).and_then(|p| p.get("kind")).and_then(Value::as_str).map(str::to_string)
}

fn find<'a>(list: &'a [Value], id: &str) -> Option<&'a Value> {
    list.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id))
}

async fn save(ctx: &Ctx, list: Vec<Value>) -> Result<Value, String> {
    let next = crate::settings::update(ctx, json!({ "providers": list })).await?;
    Ok(next.get("providers").cloned().unwrap_or(json!([])))
}

/// `resolveSubscriptionProvider`: a provider whose credential lives in the
/// token store (a subscription, or OpenRouter's signed-in key) with a fresh
/// token as its `apiKey`, and the account id backfilled from the stored token.
pub async fn resolve(ctx: &Ctx, config: &Value) -> Result<Value, String> {
    // Claude on Vertex AI authenticates with the user's own Google Cloud
    // credentials: a short-lived access token, fetched fresh for each use.
    if config.get("kind").and_then(Value::as_str) == Some("vertex") {
        let mut out = config.as_object().cloned().unwrap_or_default();
        out.insert("apiKey".into(), Value::String(crate::gcp::access_token().await?));
        return Ok(Value::Object(out));
    }
    let subscription = config.get("auth").and_then(Value::as_str) == Some("subscription");
    let key = config.get("tokenKey").filter(|k| nekko_js::truthy(Some(k)));
    if !subscription && key.is_none() {
        return Ok(config.clone());
    }
    let Some(key) = key.map(nekko_js::display) else {
        return Err(
            "Provider is configured for subscription sign-in but has no token key. Sign in again in Settings.".into()
        );
    };
    let oauth = ctx.oauth.as_ref().ok_or("Sign-in is not available here.")?;
    let access = oauth.ensure_fresh(&key, false).await?;
    let account = match config.get("accountId") {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => oauth.stored(&key).and_then(|t| t.get("accountId").cloned()),
    };
    let mut out = config.as_object().cloned().unwrap_or_default();
    out.insert("apiKey".into(), access);
    match account {
        Some(a) => {
            out.insert("accountId".into(), a);
        }
        None => {
            // `accountId: undefined` keeps its key, which JSON then leaves out.
            out.shift_remove("accountId");
        }
    }
    Ok(Value::Object(out))
}

/// A saved provider by id, ready to call: [`resolve`] applied.
pub async fn resolve_provider(ctx: &Ctx, id: &str) -> Result<Value, String> {
    let p = find(&providers(ctx).await, id).cloned().ok_or("Provider not found.")?;
    resolve(ctx, &p).await
}

fn build(config: &Value) -> Result<nekko_agent::AnyProvider, String> {
    let config: nekko_agent::ProviderConfig = serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
    Ok(nekko_agent::create_provider(config))
}

/// The host's `testProvider`/`testProviderConfig`.
async fn test(ctx: &Ctx, config: &Value) -> Value {
    let result = match resolve(ctx, config).await.and_then(|c| build(&c)) {
        Ok(p) => p.test().await,
        Err(e) => nekko_agent::TestResult::fail(e),
    };
    serde_json::to_value(result).unwrap_or(Value::Null)
}

/// `listModels(providerId)`: the provider's models, `[]` on any failure.
pub async fn list_models(ctx: &Ctx, id: &str) -> Value {
    list_models_status(ctx, id).await.get("models").cloned().unwrap_or(json!([]))
}

/// `listModelsStatus(providerId)`: `{ models, error? }`, where `error` says why
/// the list failed. A disabled or unknown provider is `{ models: [] }`.
pub async fn list_models_status(ctx: &Ctx, id: &str) -> Value {
    match listed_models(ctx, id).await {
        Ok(models) => json!({ "models": serde_json::to_value(models).unwrap_or(json!([])) }),
        Err(e) => json!({ "models": [], "error": e }),
    }
}

/// The provider's models as it listed them, `fallback` flags included (the
/// wire drops them). A disabled or unknown provider lists nothing.
pub async fn listed_models(ctx: &Ctx, id: &str) -> Result<Vec<nekko_agent::ModelInfo>, String> {
    use nekko_agent::Provider;
    // Checked before resolving, so a disabled subscription is not refreshed either.
    if find(&providers(ctx).await, id).is_none_or(|p| !is_enabled(p)) {
        return Ok(Vec::new());
    }
    let provider = resolve_provider(ctx, id).await.and_then(|c| build(&c))?;
    provider.list_models().await.map_err(|e| e.to_string())
}

/// How long a provider's reported windows are trusted (`CACHE_MS`, context-window.ts).
const WINDOW_CACHE: Duration = Duration::from_secs(60);
const WINDOW_LOOKUP: Duration = Duration::from_millis(2500);

/// Per provider: when it was asked, each model's window, and each model's
/// listed input modalities (`details.inputModalities`, comma-joined).
type WindowCache = Mutex<Vec<(String, Instant, Vec<(String, u64)>, Vec<(String, String)>)>>;
fn window_cache() -> &'static WindowCache {
    static CACHE: std::sync::OnceLock<WindowCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Ollama's loaded context per model (`/api/ps`).
async fn ollama_loaded(base_url: &str) -> Vec<(String, u64)> {
    let root = base_url.trim_end_matches('/').trim_end_matches("/v1").trim_end_matches('/');
    let client = reqwest::Client::builder().no_proxy().timeout(WINDOW_LOOKUP).build().unwrap_or_default();
    let Ok(res) = client.get(format!("{root}/api/ps")).send().await else { return Vec::new() };
    let Ok(body) = res.json::<Value>().await else { return Vec::new() };
    let mut out = Vec::new();
    for m in body.get("models").and_then(Value::as_array).into_iter().flatten() {
        let Some(ctx) = m.get("context_length").and_then(Value::as_u64).filter(|c| *c > 0) else { continue };
        for key in ["name", "model"] {
            if let Some(id) = m.get(key).and_then(Value::as_str) {
                out.push((id.to_string(), ctx));
            }
        }
    }
    out
}

/// `contextWindowFor` (context-window.ts): the window `model_id` was loaded
/// with on this provider when the server reports one, else the id guess.
/// Never blocks a turn for long, and never fails it.
pub async fn context_window_for(ctx: &Ctx, provider: &Value, model_id: &str) -> u64 {
    let guess = crate::context::guess_context_window(Some(model_id));
    let Some((windows, _)) = listing(ctx, provider).await else { return guess };
    windows.iter().rev().find(|(m, _)| m == model_id).map(|(_, w)| *w).unwrap_or(guess)
}

/// `imageInputFor` (context-window.ts), from the listing's evidence: false only
/// when the provider lists this model's inputs and images are not among them
/// (the engine's model without a projector, a text-only OpenRouter model).
/// Anything unlisted stays true, as an unknown model does in the composer.
pub async fn image_input_for(ctx: &Ctx, provider: &Value, model_id: &str) -> bool {
    let Some((_, inputs)) = listing(ctx, provider).await else { return true };
    match inputs.iter().rev().find(|(m, _)| m == model_id) {
        Some((_, list)) => list.split(',').any(|m| m.trim().eq_ignore_ascii_case("image")),
        None => true,
    }
}

/// The provider's cached model listing (windows, input modalities), asked
/// for at most once a minute; `None` for providers whose list is not asked.
async fn listing(ctx: &Ctx, provider: &Value) -> Option<(Vec<(String, u64)>, Vec<(String, String)>)> {
    let kind = provider.get("kind").and_then(Value::as_str).unwrap_or("");
    let asks = matches!(kind, "ollama" | "lmstudio" | "vllm" | "llamacpp" | "engine" | "openai-compat" | "openrouter");
    let id = provider.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if !asks || id.is_empty() {
        return None;
    }
    let cached = {
        let cache = window_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache
            .iter()
            .find(|(p, at, _, _)| *p == id && at.elapsed() < WINDOW_CACHE)
            .map(|(_, _, w, i)| (w.clone(), i.clone()))
    };
    if cached.is_some() {
        return cached;
    }
    let models = match tokio::time::timeout(WINDOW_LOOKUP, list_models(ctx, &id)).await {
        Ok(Value::Array(models)) => models,
        _ => Vec::new(),
    };
    let mut windows: Vec<(String, u64)> = models
        .iter()
        .filter_map(|m| {
            let ctx = m.get("contextLength").and_then(Value::as_u64).filter(|c| *c > 0)?;
            Some((m.get("id")?.as_str()?.to_string(), ctx))
        })
        .collect();
    let inputs: Vec<(String, String)> = models
        .iter()
        .filter_map(|m| {
            let list = m.pointer("/details/inputModalities")?.as_str()?;
            Some((m.get("id")?.as_str()?.to_string(), list.to_string()))
        })
        .collect();
    if kind == "ollama" {
        windows.extend(ollama_loaded(provider.get("baseUrl").and_then(Value::as_str).unwrap_or("")).await);
    }
    let mut cache = window_cache().lock().unwrap_or_else(|e| e.into_inner());
    cache.retain(|(p, _, _, _)| *p != id);
    cache.push((id, Instant::now(), windows.clone(), inputs.clone()));
    Some((windows, inputs))
}

/// `knownContextWindow` (context-window.ts): the window a turn last found for
/// `model_id` on this provider, without asking anyone; else the id's guess.
pub fn known_context_window(provider: &Value, model_id: &str) -> u64 {
    let guess = crate::context::guess_context_window(Some(model_id));
    let id = provider.get("id").and_then(Value::as_str).unwrap_or("");
    let cache = window_cache().lock().unwrap_or_else(|e| e.into_inner());
    cache
        .iter()
        .find(|(p, _, _, _)| p == id)
        .and_then(|(_, _, w, _)| w.iter().rev().find(|(m, _)| m == model_id).map(|(_, w)| *w))
        .unwrap_or(guess)
}

/// `discoverLocalProviders()`: each well-known server that answers, IPv4
/// first (on Windows `localhost` often resolves to `::1` while the servers
/// bind only IPv4), in the order they answer.
async fn discover() -> Vec<Value> {
    let client = reqwest::Client::builder().no_proxy().timeout(DISCOVERY_TIMEOUT).build().unwrap_or_default();
    let mut probes = tokio::task::JoinSet::new();
    for &(kind, base_url, probe) in DISCOVERY_TARGETS {
        let client = client.clone();
        probes.spawn(async move {
            for host in ["127.0.0.1", "localhost"] {
                let base = base_url.replacen("localhost", host, 1);
                if let Ok(res) = client.get(format!("{base}{probe}")).send().await
                    && res.status().is_success()
                {
                    return Some(json!({
                        "id": format!("{kind}-local"),
                        "kind": kind,
                        "label": format!("{kind} (local)"),
                        "baseUrl": base,
                        "discovered": true,
                        "enabled": true,
                    }));
                }
            }
            None
        });
    }
    let mut found = Vec::new();
    while let Some(done) = probes.join_next().await {
        if let Ok(Some(p)) = done {
            found.push(p);
        }
    }
    found
}

/// `isLocalhostUrl`.
pub fn is_localhost_url(base_url: &str) -> bool {
    match url::Url::parse(base_url) {
        // WHATWG `hostname`: an IPv6 host keeps its brackets, so `[::1]` is not `::1`.
        Ok(u) => {
            let h = u.host_str().unwrap_or_default().to_lowercase();
            matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        }
        Err(_) => {
            let t = nekko_js::trim(base_url).to_lowercase();
            let t = t.strip_prefix("http://").or_else(|| t.strip_prefix("https://")).unwrap_or(&t);
            ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].iter().any(|h| t.starts_with(h))
        }
    }
}

/// `lmsBin()`: LM Studio's own install of the CLI, else whatever is on PATH.
fn lms_bin() -> PathBuf {
    let name = if cfg!(windows) { "lms.exe" } else { "lms" };
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    match home.map(|h| h.join(".lmstudio").join("bin").join(name)) {
        Some(p) if p.exists() => p,
        _ => PathBuf::from("lms"),
    }
}

/// `lmsInstalled()`: `lms version` exits 0, remembered for 15 seconds.
async fn lms_installed() -> bool {
    static LAST: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    if let Some((at, ok)) = *LAST.lock().unwrap_or_else(|e| e.into_inner())
        && at.elapsed() < Duration::from_secs(15)
    {
        return ok;
    }
    let mut cmd = tokio::process::Command::new(lms_bin());
    cmd.arg("version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never flash a console on the user's screen.
        cmd.creation_flags(0x0800_0000);
    }
    let ok = match cmd.spawn() {
        Ok(mut child) => {
            matches!(tokio::time::timeout(Duration::from_secs(4), child.wait()).await, Ok(Ok(s)) if s.success())
        }
        Err(_) => false,
    };
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), ok));
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localhost_urls_are_recognised_as_lms_js_did() {
        assert!(is_localhost_url("http://localhost:1234/v1"));
        assert!(is_localhost_url("http://127.0.0.1:1234"));
        assert!(is_localhost_url("http://0.0.0.0:1234"));
        assert!(!is_localhost_url("http://[::1]:1234"));
        assert!(!is_localhost_url("http://10.0.0.2:1234"));
        // `localhost:1234` parses, as a URL whose scheme is `localhost:` and has no host.
        assert!(!is_localhost_url("localhost:1234"));
    }
}
