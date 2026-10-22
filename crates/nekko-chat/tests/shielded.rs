//! Privacy Shield on the loop's model client: the provider gets
//! placeholders, the loop gets real values back.

use nekko_chat::ShieldedClient;
use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient};
use nekko_privacy::{Policy, Shield};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

struct Script(VecDeque<Result<Chunk, String>>);

impl ChunkStream for Script {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        self.0.pop_front()
    }
}

#[derive(Default)]
struct Recorder {
    seen: Mutex<Vec<ChatRequest>>,
    reply: Vec<Result<Chunk, String>>,
}

impl ModelClient for Recorder {
    type Stream = Script;
    async fn chat(&self, req: ChatRequest, _cancel: Cancel) -> Result<Script, String> {
        self.seen.lock().unwrap().push(req);
        Ok(Script(self.reply.clone().into()))
    }
}

fn request() -> ChatRequest {
    ChatRequest {
        model: "m".into(),
        system: "Work in /Users/philip/app.".into(),
        messages: vec![json!({ "id": "1", "role": "user", "content": "Email jane@example.com the report" })],
        ..Default::default()
    }
}

async fn drain(stream: &mut impl ChunkStream) -> Vec<Result<Chunk, String>> {
    let mut out = Vec::new();
    while let Some(item) = stream.next().await {
        out.push(item);
    }
    out
}

fn shield() -> Arc<Mutex<Shield>> {
    Arc::new(Mutex::new(Shield::new(Policy { usernames: vec!["philip".into()], ..Policy::all() })))
}

#[tokio::test]
async fn sends_placeholders_and_returns_real_values() {
    let recorder = Recorder {
        reply: vec![
            Ok(Chunk::Text("Sending to [PII_EM".into())),
            Ok(Chunk::Text("AIL_1] now".into())),
            Ok(Chunk::ToolCall(
                json!({ "id": "c", "name": "write_file", "input": { "path": "/Users/[PII_USER_1]/app/to.txt", "content": "[PII_EMAIL_1]" } }),
            )),
            Ok(Chunk::Done),
        ],
        ..Default::default()
    };
    let client = ShieldedClient::new(recorder, Some(shield()));
    let mut stream = client.chat(request(), Cancel::default()).await.unwrap();
    let chunks = drain(&mut stream).await;

    let sent = &client_inner(&client)[0];
    assert!(sent.system.starts_with("Work in /Users/[PII_USER_1]/app."));
    assert!(sent.system.contains("## Private values"));
    assert_eq!(sent.messages[0]["content"], "Email [PII_EMAIL_1] the report");

    let text: String = chunks
        .iter()
        .filter_map(|c| match c {
            Ok(Chunk::Text(t)) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Sending to jane@example.com now");
    let call = chunks.iter().find_map(|c| match c {
        Ok(Chunk::ToolCall(v)) => Some(v.clone()),
        _ => None,
    });
    assert_eq!(call.unwrap()["input"], json!({ "path": "/Users/philip/app/to.txt", "content": "jane@example.com" }));
    assert!(matches!(chunks.last(), Some(Ok(Chunk::Done))));
}

#[tokio::test]
async fn a_held_tail_goes_out_before_an_error() {
    let recorder = Recorder {
        reply: vec![Ok(Chunk::Text("to [PII_".into())), Err("anthropic 500: [PII_EMAIL_1] bad".into())],
        ..Default::default()
    };
    let client = ShieldedClient::new(recorder, Some(shield()));
    let mut stream = client.chat(request(), Cancel::default()).await.unwrap();
    let chunks = drain(&mut stream).await;
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[1], Ok(Chunk::Text("[PII_".into())));
    assert_eq!(chunks[2], Err("anthropic 500: jane@example.com bad".into()));
}

#[tokio::test]
async fn without_a_shield_it_is_the_inner_client() {
    let recorder = Recorder { reply: vec![Ok(Chunk::Text("[PII_EMAIL_1]".into()))], ..Default::default() };
    let client = ShieldedClient::new(recorder, None);
    let mut stream = client.chat(request(), Cancel::default()).await.unwrap();
    assert_eq!(drain(&mut stream).await, vec![Ok(Chunk::Text("[PII_EMAIL_1]".into()))]);
    let sent = &client_inner(&client)[0];
    assert_eq!(sent.system, "Work in /Users/philip/app.");
    assert_eq!(sent.messages[0]["content"], Value::from("Email jane@example.com the report"));
}

fn client_inner(client: &ShieldedClient<Recorder>) -> Vec<ChatRequest> {
    client.inner().seen.lock().unwrap().clone()
}
