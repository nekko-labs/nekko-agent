//! `pickAutoModel` (packages/shared/src/model-select.ts) as the bridge calls
//! it: the Normal profile, no favorites. A chat set to Auto answers on the
//! model this picks for the message.

use nekko_tools::jsre::JsRegex;
use serde_json::Value;
use std::sync::OnceLock;

const COMPLEX: &str = r"\b(implement|refactor|debug|architecture|design|migrat|optim[iy]|algorithm|concurren|distributed|security|performance|test|build|fix the|root cause|trace|why does|explain how)\b";

const NON_CHAT: &str = r"(^|[\W_])(whisper|distil-whisper|parakeet|wav2vec|seamless|tts|piper|kokoro|bark|xtts|embed|embedding|bge|gte|e5|nomic-embed|minilm|jina-(embed|clip)|rerank|reranker|colbert|clip|siglip|sd|sdxl|sd3|stable-diffusion|flux|qwen[-_]?image|z[-_]image|hidream|pixart|ltxv|dall-e|dalle|ocr|trocr|paddle|florence|donut|layoutlm|translate|moderation|guard)([\W_]|$)";

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

/// The built-in engine files every model under its kind (`chat/…`,
/// `image/…`): anything outside chat is never a chat model, whatever its name.
const NON_CHAT_KINDS: [&str; 4] = ["image/", "video/", "audio/", "embedding/"];

/// `isChatModel`.
pub fn is_chat_model(model: &Value) -> bool {
    let id = crate::show(model.get("id"));
    !NON_CHAT_KINDS.iter().any(|k| id.starts_with(k)) && !res().non_chat.test(&label(model))
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

#[cfg(test)]
mod tests {
    use super::is_chat_model;
    use serde_json::json;

    #[test]
    fn picture_and_video_models_are_not_chat_models() {
        let m = |id: &str, name: &str| json!({ "id": id, "name": name });
        // Built-in engine kinds, whatever the file is called.
        assert!(!is_chat_model(&m(
            "image/unsloth_Qwen-Image-Edit-2511-GGUF/qwen-image-edit-2511-Q8_0",
            "qwen-image-edit-2511-Q8_0"
        )));
        assert!(!is_chat_model(&m("image/QuantStack_Qwen-Image-GGUF/Qwen_Image-Q8_0", "Qwen_Image-Q8_0")));
        assert!(!is_chat_model(&m("video/some-model", "some-model")));
        assert!(!is_chat_model(&m("embedding/Qwen3-Embedding-0.6B", "Qwen3-Embedding-0.6B")));
        // The same families served by another server, by name.
        assert!(!is_chat_model(&m("qwen-image-edit-2511", "Qwen Image Edit")));
        assert!(!is_chat_model(&m("z-image-turbo", "Z Image Turbo")));
        // Chat and vision models stay in.
        assert!(is_chat_model(&m(
            "chat/lmstudio-community_Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-Q4_K_M",
            "Qwen3-Coder-Next-Q4_K_M"
        )));
        assert!(is_chat_model(&m("chat/Qwen3.8-27B", "Qwen3.8-27B")));
        assert!(is_chat_model(&m("qwen2.5-vl-7b-instruct", "Qwen2.5 VL 7B")));
    }
}
