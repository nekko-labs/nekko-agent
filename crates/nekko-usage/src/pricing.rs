//! `getModelPrice` and `estimateCost` (`packages/shared/src/limits.ts`).
//!
//! The price tables are the TS ones, embedded from `pricing.json`, which
//! `packages/host/src/usage.golden.test.ts` writes from `MODEL_PRICING` and
//! `MODEL_PRICING_SNAPSHOT` (and fails on when stale).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// The rates `estimateCost` reads off a price entry, USD per million tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

impl Price {
    fn from(v: &Value) -> Option<Price> {
        let f = |k: &str| v.get(k).and_then(Value::as_f64);
        Some(Price {
            input: f("input")?,
            output: f("output")?,
            cache_read: f("cacheRead"),
            cache_write: f("cacheWrite"),
        })
    }
}

struct Tables {
    /// Published ids (and ids without their vendor prefix), first entry wins.
    published: HashMap<String, Price>,
    /// Family entries by match substring, longest first.
    family: Vec<(String, Price)>,
    claude: regress::Regex,
    local: regress::Regex,
    gpt_generation: regress::Regex,
    gpt_published: regress::Regex,
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let raw: Value = serde_json::from_str(include_str!("pricing.json")).unwrap_or(Value::Null);
        let mut published = HashMap::new();
        for p in raw.get("published").and_then(Value::as_array).into_iter().flatten() {
            let (Some(id), Some(price)) = (p.get("id").and_then(Value::as_str), Price::from(p)) else { continue };
            let unprefixed = id.split('/').skip(1).collect::<Vec<_>>().join("/");
            for key in [id.to_string(), unprefixed] {
                published.entry(key).or_insert(price);
            }
        }
        let mut family: Vec<(String, Price)> = raw
            .get("family")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p.get("match")?.as_str()?.to_string(), Price::from(p)?)))
            .collect();
        // Stable, as Array.prototype.sort is: equal lengths keep table order.
        family.sort_by_key(|(m, _)| std::cmp::Reverse(nekko_js::len16(m)));
        let re = |p: &str| regress::Regex::new(p).expect("a valid built-in pattern");
        Tables {
            published,
            family,
            claude: re(r"^(claude-[a-z]+)-(\d+)-(\d+)(?=$|-)"),
            local: re(r"^(qwen3|gpt-oss):(\d+b)(?=$|[-_])"),
            gpt_generation: re(r"(?:^|\/)gpt-[5-9](?:[.\-]|$)"),
            gpt_published: re(
                r"(?:^|\/)gpt-(?:5(?:-(?:mini|nano))?|6-astra|6\.1-sol|6-luna|5\.6-(?:sol|cyber))(?:$|-\d{4}-\d{2}-\d{2}$)",
            ),
        }
    })
}

/// `s.replace(re, template)` for an anchored pattern and a `$1…$n` template
/// with literal separators between the groups.
fn replace_first(s: &str, re: &regress::Regex, sep: &[&str]) -> String {
    let Some(m) = re.find(s) else { return s.to_string() };
    let mut out = String::new();
    for (i, sep) in sep.iter().enumerate() {
        if let Some(r) = m.group(i + 1) {
            out.push_str(&s[r]);
        }
        out.push_str(sep);
    }
    out.push_str(&s[m.range().end..]);
    format!("{}{}", &s[..m.range().start], out)
}

/// `getModelPrice(modelId)`'s rates: an exact published id first, then the
/// longest family substring, never a base price for an unpublished GPT-5+ id.
pub fn model_price(model_id: &str) -> Option<Price> {
    if model_id.is_empty() {
        return None;
    }
    // A summary prices every record, mostly the same few ids: remember them.
    static SEEN: OnceLock<std::sync::Mutex<HashMap<String, Option<Price>>>> = OnceLock::new();
    let seen = SEEN.get_or_init(Default::default);
    if let Some(p) = seen.lock().ok().and_then(|m| m.get(model_id).copied()) {
        return p;
    }
    let price = lookup(model_id);
    if let Ok(mut m) = seen.lock() {
        if m.len() >= 4096 {
            m.clear();
        }
        m.insert(model_id.to_string(), price);
    }
    price
}

fn lookup(model_id: &str) -> Option<Price> {
    let t = tables();
    let lower = model_id.to_lowercase();
    let id = replace_first(&lower, &t.claude, &["-", ".", ""]);
    let id = replace_first(&id, &t.local, &["-", ""]);
    if let Some(p) = t.published.get(&id) {
        return Some(*p);
    }
    if t.gpt_generation.find(&id).is_some() && t.gpt_published.find(&id).is_none() {
        return None;
    }
    t.family.iter().find(|(m, _)| id.contains(m.as_str())).map(|(_, p)| *p)
}

/// `estimateCost`'s usage argument, each count as the TS record holds it
/// (`undefined` is `None`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Tokens<'a> {
    pub input: Option<&'a Value>,
    pub output: Option<&'a Value>,
    pub cache_read: Option<&'a Value>,
    pub cache_write: Option<&'a Value>,
    pub subscription: bool,
}

/// `x / 1e6` with JavaScript's coercion.
fn per_million(v: Option<&Value>) -> f64 {
    nekko_js::to_number(v) / 1e6
}

/// `estimateCost(modelId, usage)`: `None` for no model or no published price,
/// 0 for subscription usage. `Err` where the TS throws (a model id that is
/// not a string).
pub fn estimate_cost(model_id: Option<&Value>, usage: Tokens) -> Result<Option<f64>, String> {
    if !nekko_js::truthy(model_id) {
        return Ok(None);
    }
    if usage.subscription {
        return Ok(Some(0.0));
    }
    let Some(Value::String(id)) = model_id else {
        return Err("modelId.toLowerCase is not a function".into());
    };
    let Some(p) = model_price(id) else { return Ok(None) };
    let mut cost = per_million(usage.input) * p.input + per_million(usage.output) * p.output;
    if nekko_js::truthy(usage.cache_read) {
        cost += per_million(usage.cache_read) * p.cache_read.unwrap_or(p.input);
    }
    if nekko_js::truthy(usage.cache_write) {
        cost += per_million(usage.cache_write) * p.cache_write.unwrap_or(p.input);
    }
    Ok(Some(cost))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dated_claude_ids_and_local_tags_find_their_prices() {
        assert!(model_price("claude-sonnet-4-5").is_some());
        assert_eq!(model_price("qwen3:32b"), model_price("qwen3-32b"));
        assert!(model_price("gpt-5.9-unreleased").is_none(), "an unpublished GPT-5 id gets no base price");
        assert!(model_price("").is_none());
    }
}
