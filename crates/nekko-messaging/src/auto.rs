//! `pickAutoModel` (packages/shared/src/model-select.ts) as the bridge calls
//! it: the Normal profile, no favorites. A chat set to Auto answers on the
//! model this picks for the message.

use nekko_tools::jsre::JsRegex;
use serde_json::Value;
use std::sync::OnceLock;

const COMPLEX: &str = r"\b(implement|refactor|debug|architecture|design|migrat|optim[iy]|algorithm|concurren|distributed|security|performance|test|build|fix the|root cause|trace|why does|explain how)\b";

const NON_CHAT: &str = r"(^|[\W_])(whisper|distil-whisper|parakeet|wav2vec|seamless|tts|piper|kokoro|bark|xtts|embed|embedding|bge|gte|e5|nomic-embed|minilm|jina-(embed|clip)|rerank|reranker|colbert|clip|siglip|sd|sdxl|sd3|stable-diffusion|flux|dall-e|dalle|ocr|trocr|paddle|florence|donut|layoutlm|translate|moderation|guard)([\W_]|$)";

const TIERS: [(&str, i32); 3] = [
    (r"opus|gpt-5|o1-pro|405b|70b|72b", 5),
    (
        r"sonnet|gpt-4o(?!-mini)|gpt-4\.1(?!-mini)|o3(?!-mini)|o1(?!-mini)|llama-3\.[13]|qwen2?\.?5?-?(32|34)b|mixtral",
        4,
    ),
    (r"haiku|mini|flash|small|1\.5b|3b|7b|8b|9b|phi|gemma", 2),
];

const TIER_RULES: &str = include_str!("../../../packages/shared/src/model-tiers.json");

/// Shared suggestions, with user overrides applied before family/parameter rules.
pub fn capability(model: &Value, overrides: Option<&Value>) -> Option<String> {
    let key = format!("{}::{}", crate::show(model.get("providerId")), crate::show(model.get("id")));
    if let Some(tier) = overrides.and_then(|o| o.get(&key)).and_then(Value::as_str)
        && capability_rank(tier).is_some()
    {
        return Some(tier.into());
    }
    res().tiers.iter().find(|(re, _)| re.test(&label(model))).map(|(_, tier)| tier.clone())
}

pub fn capability_rank(tier: &str) -> Option<i32> {
    match tier {
        "small" => Some(2),
        "medium" => Some(3),
        "large" => Some(4),
        "frontier" => Some(5),
        _ => None,
    }
}

pub fn tier_with_overrides(model: &Value, overrides: Option<&Value>) -> i32 {
    capability(model, overrides).and_then(|t| capability_rank(&t)).unwrap_or(3)
}

struct Res {
    legacy_tiers: Vec<(JsRegex, i32)>,
    complex: JsRegex,
    fence: JsRegex,
    non_chat: JsRegex,
    tiers: Vec<(JsRegex, String)>,
}

fn res() -> &'static Res {
    static RES: OnceLock<Res> = OnceLock::new();
    RES.get_or_init(|| Res {
        legacy_tiers: TIERS.iter().map(|(s, t)| (JsRegex::new(s, "").expect("valid"), *t)).collect(),
        complex: JsRegex::new(COMPLEX, "i").expect("valid"),
        fence: JsRegex::new("```", "").expect("valid"),
        non_chat: JsRegex::new(NON_CHAT, "i").expect("valid"),
        tiers: serde_json::from_str::<Vec<Value>>(TIER_RULES)
            .expect("valid rules")
            .iter()
            .map(|r| {
                (
                    JsRegex::new(r["pattern"].as_str().expect("pattern"), "i").expect("valid regex"),
                    r["tier"].as_str().expect("tier").to_string(),
                )
            })
            .collect(),
    })
}

/// `isComplexPrompt`.
pub fn is_complex(prompt: &str) -> bool {
    nekko_js::len16(prompt) > 600 || res().fence.test(prompt) || res().complex.test(prompt)
}

/// `${model.id} ${model.name}`.
fn label(model: &Value) -> String {
    format!("{} {}", crate::show(model.get("id")), crate::show(model.get("name")))
}

/// `isChatModel`.
pub fn is_chat_model(model: &Value) -> bool {
    !res().non_chat.test(&label(model))
}

/// `modelTier`.
pub fn tier(model: &Value) -> i32 {
    let id = label(model).to_lowercase();
    res().legacy_tiers.iter().find(|(re, _)| re.test(&id)).map_or(3, |(_, t)| *t)
}

/// `pickAutoModel(models, prompt)?.modelId`: the strongest model for complex
/// work, else the smallest capable one (tier 2 and up), ties in list order.
pub fn pick(models: &[Value], prompt: &str) -> Option<Value> {
    if models.is_empty() {
        return None;
    }
    let chat: Vec<&Value> = models.iter().filter(|m| is_chat_model(m)).collect();
    let candidates: Vec<&Value> = if chat.is_empty() { models.iter().collect() } else { chat };
    let want_strong = is_complex(prompt);
    let mut ranked: Vec<(&Value, i32)> = candidates.into_iter().map(|m| (m, tier(m))).collect();
    // Stable, so equal tiers keep list order (the TS breaks ties by index).
    ranked.sort_by(|a, b| if want_strong { b.1.cmp(&a.1) } else { a.1.cmp(&b.1) });
    let chosen = if want_strong { ranked.first() } else { ranked.iter().find(|r| r.1 >= 2).or(ranked.first()) };
    chosen.map(|(m, _)| m.get("id").cloned().unwrap_or(Value::Null))
}
