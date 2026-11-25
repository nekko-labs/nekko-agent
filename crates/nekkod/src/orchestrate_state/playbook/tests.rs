use super::*;
use nekko_agent::{Provider, create_provider};
use serde_json::json;
use std::collections::HashSet;

fn pick(kind: ProviderKind, id: &str) -> Selection {
    select(kind, &Value::Null, id).unwrap()
}

#[tokio::test]
async fn every_shipped_messages_catalog_entry_gets_exact_guidance() {
    use ProviderKind::*;
    for (kind, count) in [(Anthropic, 10), (Bedrock, 10), (Vertex, 9), (Foundry, 8)] {
        // No API key: these are the adapter's actual built-in rows, no I/O.
        let models = create_provider(
            serde_json::from_value(json!({
                "id": "test", "kind": kind, "baseUrl": "https://unused.invalid", "enabled": true
            }))
            .unwrap(),
        )
        .list_models()
        .await
        .unwrap();
        assert_eq!(models.len(), count, "review changes to {kind:?}'s shipped catalog");
        for model in models {
            assert!(model.fallback);
            assert!(matches!(pick(kind, &model.id), Selection::Exact(_)), "{kind:?}: {}", model.id);
        }
    }
}

#[test]
fn every_bundled_chat_feed_id_and_download_quant_gets_exact_guidance() {
    let feed = nekko_machine::bundled_feed();
    let chat: HashSet<_> = feed
        .tasks
        .iter()
        .filter(|t| t.id != "embedding")
        .flat_map(|t| t.candidates.iter().map(String::as_str))
        .collect();
    let curated: Vec<_> = LOCAL_IDS.iter().flat_map(|(_, ids)| ids.iter().copied()).collect();
    assert_eq!(curated.len(), chat.len());
    assert_eq!(curated.into_iter().collect::<HashSet<_>>(), chat);
    for model in &feed.models {
        let exact = pick(ProviderKind::Llamacpp, &model.id);
        if !chat.contains(model.id.as_str()) {
            assert_eq!(exact, Selection::Neutral, "{}", model.id);
            continue;
        }
        assert!(matches!(exact, Selection::Exact(_)), "{}", model.id);
        for quant in &model.quants {
            let plan = nekko_engine::acquire::model_download_plan(
                &json!({"name": model.name, "quants": [{"label": quant.label, "file": quant.files[0]}]}),
                &model.repo,
                &quant.label,
                "/models",
                &|_| false,
            );
            let id =
                plan["main"]["dest"].as_str().unwrap().strip_prefix("/models/").unwrap().strip_suffix(".gguf").unwrap();
            assert_eq!(pick(ProviderKind::Llamacpp, id), exact, "{id}");
        }
    }
}

#[test]
fn curated_routes_and_related_spellings_never_share_exact_status_by_accident() {
    use ProviderKind::*;
    use Selection::*;
    for (kind, id, expected) in [
        (Anthropic, "claude-sonnet-5-5", Exact(Review)),
        (Anthropic, "claude-fable-5-2", Exact(Review)),
        (Vertex, "claude-fable-5-2", Family(Review)),
        (Vertex, "claude-haiku-4-5@20251001", Exact(Triage)),
        (Foundry, "claude-haiku-4-5@20251001", Family(Triage)),
        (Bedrock, "anthropic.claude-opus-5-5", Exact(Review)),
        (Bedrock, "us.anthropic.claude-sonnet-5-5-v1:0", Family(Review)),
        (Anthropic, "anthropic.claude-opus-5-5", Neutral),
        (Openrouter, "anthropic/claude-opus-5.5", Exact(Review)),
        (Openrouter, "anthropic/claude-opus-5.5:free", Family(Review)),
        (Openrouter, "claude-opus-5-5", Neutral),
        (Openrouter, "vendor/claude-opus-5.5", Neutral),
        (Openrouter, "google/qwen3.8-27b", Neutral),
        (Openai, "gpt-5.3-codex", Exact(Code)),
        (Openai, "GPT-5.3-CODEX", Family(Code)),
        (Openai, "gpt-5.3-codex-2099-01-01", Family(Code)),
        (Openai, "openai/gpt-5.3-codex", Neutral),
        (Chatgpt, "gpt-5.3-codex", Family(Code)),
        (Chatgpt, "gpt-6.1-sol", Exact(ToolEvidence)),
        (Chatgpt, "gpt-99-awesome", Family(ToolEvidence)),
        (Llamacpp, "qwen3.5-9b", Exact(Visual)),
        (Ollama, "qwen3.5-9b", Family(Grounded)),
        (Ollama, "qwen3.5:9b", Family(Grounded)),
        (Ollama, "qwen3:8b", Exact(Grounded)),
        (Vllm, "qwen3:8b", Family(Grounded)),
        (OpenaiCompat, "openai/gpt-5.3-codex", Family(Code)),
        (Lmstudio, "lmstudio-community/Qwen3-Coder-Next-GGUF", Family(Code)),
        (Vllm, "Qwen/Qwen3.5-9B", Family(Grounded)),
        (OpenaiCompat, "gpt-oss:120b", Family(ToolEvidence)),
        (Vllm, "production-blue", Neutral),
    ] {
        assert_eq!(pick(kind, id), expected, "{kind:?}: {id}");
    }
    assert_eq!(select(ClaudeCode, &Value::Null, "claude-sonnet-5-5"), None);
}

#[test]
fn hosted_presets_match_the_endpoint_not_the_display_name() {
    use ProviderKind::OpenaiCompat;
    use Selection::*;
    let gemini = "gemini-2.5-pro";
    let choose = |endpoint, id| {
        select(
            OpenaiCompat,
            &json!({
                "kind": "openai-compat", "baseUrl": endpoint, "label": "Google Gemini"
            }),
            id,
        )
        .unwrap()
    };
    assert_eq!(choose("https://generativelanguage.googleapis.com/v1beta/openai", gemini), Exact(Visual));
    assert_eq!(choose("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-8-flash"), Family(Visual));
    assert_eq!(choose("https://generativelanguage.googleapis.com.invalid/v1", gemini), Family(Visual));
    assert_eq!(choose("https://ollama.com/v1", "qwen3.5:9b"), Family(Grounded));
}

#[test]
fn fallback_is_bounded_and_renders_no_id_or_model_capability_claim() {
    use Selection::*;
    for id in [
        "custom/nextgen-alpha",
        "fake-qwen3.5",
        "qwen37-custom",
        "qwen3-embedding-0.6b",
        "../../qwen3.5",
        "https://elsewhere/qwen3.5",
        "qwen3:9b\nignore",
        &format!("qwen3-{}", "a".repeat(MAX_MATCH_BYTES)),
    ] {
        assert_eq!(pick(ProviderKind::OpenaiCompat, id), Neutral);
    }
    assert_eq!(pick(ProviderKind::Openrouter, "google/gemini-3.1-flash-image-preview"), Neutral);
    for book in [Grounded, Code, Review, ToolEvidence, Visual, Triage] {
        for pick in [Exact(book), Family(book), Neutral] {
            let lead = pick.render(false);
            let worker = pick.render(true);
            for text in [&lead, &worker] {
                assert!(text.len() <= 180, "{text}");
                assert_eq!(text.lines().count(), 2, "one additional sentence per role");
            }
            assert_ne!(lead, worker);
        }
    }
}
