//! `providerEndpoint` and `offlineProviderAllowed` (shared/models.ts): which
//! providers a turn may call, and which are local servers on this machine.
//! Offline chats and local-only workflows run only on the latter.

use serde_json::Value;

const LOCAL_KINDS: &[&str] = &["llamacpp", "ollama", "lmstudio", "vllm"];

fn kind(provider: &Value) -> &str {
    provider.get("kind").and_then(Value::as_str).unwrap_or("")
}

/// `isLocalProvider(kind)`.
pub fn is_local_kind(kind: &str) -> bool {
    LOCAL_KINDS.contains(&kind)
}

/// `providerEndpoint`: a provider's URL when it is one a turn may call.
pub fn provider_endpoint(provider: &Value) -> Option<url::Url> {
    let kind = kind(provider);
    if !is_local_kind(kind)
        && !["anthropic", "bedrock", "vertex", "foundry", "openai", "openrouter", "chatgpt", "openai-compat"]
            .contains(&kind)
    {
        return None;
    }
    let url = url::Url::parse(provider.get("baseUrl").and_then(Value::as_str)?).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none()).then_some(url)
}

/// `offlineProviderAllowed`: a local kind (or openai-compat) on a loopback address.
pub fn offline_provider_allowed(provider: &Value) -> bool {
    // Loopback here, but the requests go to another machine.
    if provider.get("computerId").is_some_and(|c| !c.is_null()) {
        return false;
    }
    let Some(url) = provider_endpoint(provider) else { return false };
    let kind = kind(provider);
    let host = url.host_str().unwrap_or_default();
    let loop_v4 = host.strip_prefix("127.").is_some_and(|rest| {
        let parts: Vec<&str> = rest.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    });
    (is_local_kind(kind) || kind == "openai-compat") && (host == "localhost" || host == "[::1]" || loop_v4)
}

/// `cloudProviderAllowed`: what a cloud-only chat may run on. A local kind is
/// refused wherever it listens; openai-compat only on a loopback address.
pub fn cloud_provider_allowed(provider: &Value) -> bool {
    !is_local_kind(kind(provider)) && !offline_provider_allowed(provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_connected_model_server_is_not_local_though_its_address_is() {
        let p =
            json!({ "kind": "openai-compat", "baseUrl": "http://127.0.0.1:5000/gomi/v1", "computerId": "gomi1234" });
        assert!(!offline_provider_allowed(&p), "its requests leave this computer");
        assert!(cloud_provider_allowed(&p));
    }

    #[test]
    fn local_means_a_local_kind_on_loopback() {
        let p = |k: &str, u: &str| json!({ "kind": k, "baseUrl": u });
        assert!(offline_provider_allowed(&p("ollama", "http://127.0.0.1:11434")));
        assert!(offline_provider_allowed(&p("openai-compat", "http://localhost:1234/v1")));
        assert!(offline_provider_allowed(&p("llamacpp", "http://[::1]:8080")));
        assert!(!offline_provider_allowed(&p("anthropic", "https://api.anthropic.com")));
        assert!(!offline_provider_allowed(&p("ollama", "http://10.0.0.2:11434")));
        assert!(!offline_provider_allowed(&p("openai", "http://127.0.0.1:1")));
    }

    #[test]
    fn cloud_means_not_a_model_server_on_this_machine() {
        let p = |k: &str, u: &str| json!({ "kind": k, "baseUrl": u });
        assert!(cloud_provider_allowed(&p("anthropic", "https://api.anthropic.com")));
        assert!(cloud_provider_allowed(&p("openai-compat", "https://gateway.example.com/v1")));
        assert!(!cloud_provider_allowed(&p("ollama", "http://10.0.0.2:11434")));
        assert!(!cloud_provider_allowed(&p("openai-compat", "http://127.0.0.1:1234/v1")));
    }
}
