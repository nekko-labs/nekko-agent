//! Cloud picture models through the user's own OpenRouter provider
//! (spec/agents/media-tools-for-chat-agents.md, plan step 5). The key never
//! leaves the daemon: the agents' tools reach OpenRouter through these
//! channels, which answer with models, prices and pictures only.
//!
//! - `media:cloudModels`: the picture models of every enabled OpenRouter
//!   provider (`GET {base}/images/models`), each with its price per picture
//!   from its endpoints (`GET {base}/images/models/{id}/endpoints`). Only
//!   models priced per picture, or per megapixel (estimated at one megapixel),
//!   are listed: a paid call shows its price before it runs. Cached an hour.
//! - `media:cloudImage`: one picture (`POST {base}/images`, `n: 1`), with
//!   pictures to edit as `input_references`; answers `{ b64, mediaType, costUsd }`,
//!   the cost being OpenRouter's own `usage.cost`.

use crate::routes::Ctx;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const CHANNELS: &[&str] = &["media:cloudModels", "media:cloudImage"];

const DEFAULT_BASE: &str = "https://openrouter.ai/api/v1";
const LIST_TTL: Duration = Duration::from_secs(60 * 60);
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// The id an agent names a cloud model by: `openrouter:<provider id>:<model id>`.
pub fn cloud_id(provider_id: &str, model: &str) -> String {
    format!("openrouter:{provider_id}:{model}")
}

/// `(provider id, model id)` of a cloud id.
pub fn parse_cloud_id(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix("openrouter:")?;
    let (provider, model) = rest.split_once(':')?;
    (!provider.is_empty() && !model.is_empty()).then_some((provider, model))
}

/// Each provider's listed models and when they were read.
type Listed = Mutex<HashMap<String, (Instant, Vec<Value>)>>;

fn cache() -> &'static Listed {
    static CACHE: std::sync::OnceLock<Listed> = std::sync::OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "media:cloudModels" => Ok(Value::Array(models(ctx).await)),
        "media:cloudImage" => image(ctx, args.first().unwrap_or(&Value::Null)).await,
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// The enabled OpenRouter providers' ids.
async fn providers(ctx: &Ctx) -> Vec<String> {
    let settings = crate::settings::current(ctx).await;
    settings
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| p.get("kind").and_then(Value::as_str) == Some("openrouter"))
        .filter(|p| p.get("enabled") != Some(&Value::Bool(false)))
        .filter_map(|p| p.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// A provider's base URL and key, resolved in the daemon.
async fn access(ctx: &Ctx, provider_id: &str) -> Result<(String, String), String> {
    let p = crate::providers::resolve_provider(ctx, provider_id).await?;
    let base = p
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|b| !b.trim().is_empty())
        .unwrap_or(DEFAULT_BASE)
        .trim_end_matches('/')
        .to_string();
    let key = p
        .get("apiKey")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .ok_or("This OpenRouter provider has no key.")?;
    Ok((base, key.to_string()))
}

async fn models(ctx: &Ctx) -> Vec<Value> {
    let mut out = Vec::new();
    for provider in providers(ctx).await {
        if let Some((at, list)) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&provider).cloned()
            && at.elapsed() < LIST_TTL
        {
            out.extend(list);
            continue;
        }
        let Ok(list) = list_provider(ctx, &provider).await else { continue };
        cache().lock().unwrap_or_else(|e| e.into_inner()).insert(provider.clone(), (Instant::now(), list.clone()));
        out.extend(list);
    }
    out
}

async fn list_provider(ctx: &Ctx, provider: &str) -> Result<Vec<Value>, String> {
    let (base, key) = access(ctx, provider).await?;
    let client = reqwest::Client::new();
    let get = |url: String| {
        let (client, key) = (client.clone(), key.clone());
        async move {
            let res = client.get(url).bearer_auth(key).timeout(LIST_TIMEOUT).send().await.map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("OpenRouter answered HTTP {}", res.status().as_u16()));
            }
            res.json::<Value>().await.map_err(|e| e.to_string())
        }
    };
    let listed = get(format!("{base}/images/models")).await?;
    let rows: Vec<Value> = listed.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    let priced =
        futures_util::future::join_all(
            rows.iter().map(|m| {
                let id = m.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                let get = &get;
                let base = &base;
                async move {
                    get(format!("{base}/images/models/{id}/endpoints")).await.ok().and_then(|e| price_per_picture(&e))
                }
            }),
        )
        .await;
    Ok(rows.iter().zip(priced).filter_map(|(m, price)| model_row(provider, m, price?)).collect())
}

/// A listed model as `media_models` shows it, or `None` when it makes no pictures.
pub fn model_row(provider: &str, m: &Value, (price, exact): (f64, bool)) -> Option<Value> {
    let id = m.get("id").and_then(Value::as_str)?;
    let arch = m.get("architecture").unwrap_or(&Value::Null);
    let has = |k: &str, v: &str| arch.get(k).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x == v));
    if !has("output_modalities", "image") {
        return None;
    }
    let mut can = vec!["create"];
    if has("input_modalities", "image") {
        can.push("edit");
    }
    let name = m.get("name").and_then(Value::as_str).unwrap_or(id);
    Some(json!({
        "id": cloud_id(provider, id), "name": name, "capabilities": can, "defaults": {},
        "source": "cloud", "via": "OpenRouter", "priceUsd": price, "priceExact": exact,
    }))
}

/// The lowest price of one output picture over a model's endpoints: per
/// picture (exact), else per megapixel at one megapixel (an estimate).
/// `None` when no endpoint prices pictures that way.
pub fn price_per_picture(endpoints: &Value) -> Option<(f64, bool)> {
    let mut records = Vec::new();
    collect_pricing(endpoints, &mut records, 0);
    let pick = |unit: &str| {
        records
            .iter()
            .filter(|p| p.get("billable").and_then(Value::as_str) == Some("output_image"))
            .filter(|p| p.get("unit").and_then(Value::as_str) == Some(unit))
            .filter_map(|p| p.get("cost_usd").and_then(|c| c.as_f64().or_else(|| c.as_str()?.parse().ok())))
            .filter(|c| c.is_finite() && *c >= 0.0)
            .fold(None, |m: Option<f64>, c| Some(m.map_or(c, |m| m.min(c))))
    };
    pick("image").map(|p| (p, true)).or_else(|| pick("megapixel").map(|p| (p * 1.05, false)))
}

fn collect_pricing(v: &Value, out: &mut Vec<Value>, depth: usize) {
    if depth > 6 {
        return;
    }
    match v {
        Value::Object(o) => {
            if let Some(Value::Array(p)) = o.get("pricing") {
                out.extend(p.iter().cloned());
            }
            for (k, x) in o {
                if k != "pricing" {
                    collect_pricing(x, out, depth + 1);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_pricing(x, out, depth + 1)),
        _ => {}
    }
}

/// One picture: `{ id, prompt, aspectRatio?, images? }` in, `{ b64, mediaType, costUsd }` out.
async fn image(ctx: &Ctx, req: &Value) -> Result<Value, String> {
    let id = req.get("id").and_then(Value::as_str).unwrap_or_default();
    let (provider, model) = parse_cloud_id(id).ok_or("Not a cloud picture model.")?;
    if !providers(ctx).await.iter().any(|p| p == provider) {
        return Err("That OpenRouter provider is not set up or is turned off.".into());
    }
    let (base, key) = access(ctx, provider).await?;
    let mut body = json!({
        "model": model, "prompt": req.get("prompt").cloned().unwrap_or(Value::Null), "n": 1, "output_format": "png",
    });
    if let Some(r) = req.get("aspectRatio").and_then(Value::as_str) {
        body["aspect_ratio"] = json!(r);
    }
    let refs: Vec<Value> = req
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|u| json!({ "type": "image_url", "image_url": { "url": u } }))
        .collect();
    if !refs.is_empty() {
        body["input_references"] = Value::Array(refs);
    }
    let res = reqwest::Client::new()
        .post(format!("{base}/images"))
        .bearer_auth(key)
        .json(&body)
        .timeout(IMAGE_TIMEOUT)
        .send()
        .await
        .map_err(|_| "OpenRouter could not be reached.".to_string())?;
    let status = res.status();
    let answer: Value = res.json().await.map_err(|e| e.to_string())?;
    let first = answer.get("data").and_then(Value::as_array).and_then(|d| d.first());
    let Some(b64) = first.and_then(|d| d.get("b64_json")).and_then(Value::as_str).filter(|_| status.is_success())
    else {
        let why = answer.pointer("/error/message").and_then(Value::as_str).unwrap_or("no picture came back");
        return Err(format!("OpenRouter: {why} (HTTP {}).", status.as_u16()));
    };
    Ok(json!({
        "b64": b64,
        "mediaType": first.and_then(|d| d.get("media_type")).cloned().unwrap_or(json!("image/png")),
        "costUsd": answer.pointer("/usage/cost").cloned().unwrap_or(Value::Null),
    }))
}

/// The common aspect ratio nearest a picture size (`1344x768` → `16:9`):
/// providers take a fixed set, not any fraction.
pub fn aspect_ratio(width: u64, height: u64) -> String {
    const RATIOS: [(u64, u64); 9] = [(1, 1), (16, 9), (9, 16), (4, 3), (3, 4), (3, 2), (2, 3), (21, 9), (9, 21)];
    let want = (width.max(1) as f64 / height.max(1) as f64).ln();
    let (w, h) = RATIOS
        .iter()
        .min_by(|a, b| {
            let d = |r: &(u64, u64)| ((r.0 as f64 / r.1 as f64).ln() - want).abs();
            d(a).total_cmp(&d(b))
        })
        .copied()
        .unwrap_or((1, 1));
    format!("{w}:{h}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_ids_round_trip_and_reject_anything_else() {
        let id = cloud_id("p_or", "google/gemini-3-pro-image");
        assert_eq!(id, "openrouter:p_or:google/gemini-3-pro-image");
        assert_eq!(parse_cloud_id(&id), Some(("p_or", "google/gemini-3-pro-image")));
        assert_eq!(parse_cloud_id("z-image-turbo"), None);
        assert_eq!(parse_cloud_id("openrouter::x"), None);
    }

    #[test]
    fn a_price_per_picture_wins_over_one_per_megapixel_and_tokens_list_nothing() {
        let endpoints = json!({ "data": { "endpoints": [
            { "provider": "a", "pricing": [{ "billable": "output_image", "unit": "image", "cost_usd": "0.04" }, { "billable": "input_image", "unit": "image", "cost_usd": 0.001 }] },
            { "provider": "b", "pricing": [{ "billable": "output_image", "unit": "image", "cost_usd": 0.035 }] },
        ] } });
        assert_eq!(price_per_picture(&endpoints), Some((0.035, true)));
        let mp = json!([{ "pricing": [{ "billable": "output_image", "unit": "megapixel", "cost_usd": 0.02 }] }]);
        let (p, exact) = price_per_picture(&mp).unwrap();
        assert!(!exact && (p - 0.021).abs() < 1e-9);
        let tokens = json!([{ "pricing": [{ "billable": "output_image", "unit": "token", "cost_usd": 0.00003 }] }]);
        assert_eq!(price_per_picture(&tokens), None);
    }

    #[test]
    fn a_listed_model_says_what_it_can_do_and_what_it_costs() {
        let m = json!({ "id": "google/gemini-3-pro-image", "name": "Nano Banana Pro",
            "architecture": { "input_modalities": ["text", "image"], "output_modalities": ["image", "text"] } });
        let row = model_row("p_or", &m, (0.04, true)).unwrap();
        assert_eq!(row["capabilities"], json!(["create", "edit"]));
        assert_eq!((row["source"].clone(), row["priceUsd"].clone()), (json!("cloud"), json!(0.04)));
        let text = json!({ "id": "x", "architecture": { "output_modalities": ["text"] } });
        assert!(model_row("p_or", &text, (0.01, true)).is_none());
    }

    #[test]
    fn sizes_become_the_nearest_common_aspect_ratio() {
        assert_eq!(aspect_ratio(1024, 1024), "1:1");
        assert_eq!(aspect_ratio(1344, 768), "16:9");
        assert_eq!(aspect_ratio(768, 1344), "9:16");
        assert_eq!(aspect_ratio(1152, 896), "4:3");
    }
}
