use super::*;
use crate::http::{BoxFuture, HttpResponse, ResponseBody, Transport, TransportError};
use std::sync::Mutex;

/// Answers every request with one status and body, and keeps what was sent.
struct Wire {
    status: u16,
    body: String,
    sent: Mutex<Vec<HttpRequest>>,
}

struct Body(Option<Vec<u8>>);

impl ResponseBody for Body {
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        let next = self.0.take();
        Box::pin(async move { Ok(next) })
    }
}

impl Transport for Wire {
    fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        self.sent.lock().unwrap().push(req.clone());
        let res = HttpResponse {
            status: self.status,
            headers: Vec::new(),
            body: Box::new(Body(Some(self.body.clone().into_bytes()))),
        };
        Box::pin(async move { Ok(res) })
    }
}

fn provider(extra: Value, status: u16, body: &str) -> (AnthropicProvider, Arc<Wire>) {
    let mut config = json!({
        "id": "anthropic",
        "kind": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "sk-ant-test",
        "enabled": true,
    });
    config.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    let wire = Arc::new(Wire { status, body: body.into(), sent: Mutex::default() });
    let io = Io { transport: wire.clone(), clock: Arc::new(|| 0) };
    let p = AnthropicProvider::with_memory(serde_json::from_value(config).unwrap(), io, Arc::default());
    (p, wire)
}

fn workspace_header(req: &HttpRequest) -> Option<&str> {
    req.headers.iter().find(|(k, _)| k == "anthropic-workspace-id").map(|(_, v)| v.as_str())
}

fn chat_req() -> ChatRequest {
    ChatRequest {
        model: "claude-opus-5-5".into(),
        messages: vec![ChatMessage::new(Role::User, "hi")],
        ..Default::default()
    }
}

#[test]
fn chat_sends_the_workspace_only_when_one_is_set() {
    let (p, _) = provider(json!({ "workspaceId": " wrkspc_01 " }), 200, "");
    assert_eq!(workspace_header(&p.chat_request(&chat_req(), SamplingShape::Effort)), Some("wrkspc_01"));

    for extra in [json!({}), json!({ "workspaceId": "  " })] {
        let (p, _) = provider(extra, 200, "");
        assert_eq!(workspace_header(&p.chat_request(&chat_req(), SamplingShape::Effort)), None);
    }

    // A subscription token is not an organization key: no workspace header.
    let (p, _) = provider(json!({ "auth": "subscription", "workspaceId": "wrkspc_01" }), 200, "");
    assert_eq!(workspace_header(&p.chat_request(&chat_req(), SamplingShape::Effort)), None);
}

#[tokio::test]
async fn the_catalog_fetch_sends_the_workspace_too() {
    let body = r#"{"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5"}]}"#;
    let (p, wire) = provider(json!({ "workspaceId": "wrkspc_01" }), 200, body);
    assert_eq!(p.list_models().await.unwrap().len(), 1);
    let sent = wire.sent.lock().unwrap()[0].clone();
    assert!(sent.url.ends_with("/v1/models?limit=1000"));
    assert_eq!(workspace_header(&sent), Some("wrkspc_01"));

    let (p, wire) = provider(json!({}), 200, body);
    p.list_models().await.unwrap();
    assert_eq!(workspace_header(&wire.sent.lock().unwrap()[0]), None);
}

#[tokio::test]
async fn an_unscoped_key_turn_error_points_at_the_workspace_field() {
    let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use."}}"#;
    let (p, _) = provider(json!({}), 400, body);
    let (_, error) = p.chat(chat_req()).collect().await;
    let error = error.expect("the turn fails");
    assert_eq!(error.message, WORKSPACE_HINT);
    assert_eq!(error.status, Some(400));

    // Any other 400 keeps the raw wording.
    let (p, _) = provider(json!({}), 400, r#"{"error":{"message":"bad"}}"#);
    let (_, error) = p.chat(chat_req()).collect().await;
    assert!(error.unwrap().message.starts_with("anthropic 400: "));
}
