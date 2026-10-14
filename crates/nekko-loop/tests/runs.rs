//! The Rust agent loop against the TS one, on scripted model responses.
//!
//! `golden/runs.expected.json` is written by `packages/host/src/agent-loop.golden.test.ts`
//! (UPDATE_GOLDEN=1) from the scenarios in `golden/runs.json`. This test plays
//! the same scripts through `run_agent` with a fake client and tool runner and
//! must produce the same events, transcript and requests after the same
//! normalization (ids and timestamps).

use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient, RunOptions, ToolRunner, run_agent};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;

fn golden(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// As the TS test normalizes: `(msg|nudge)_<[0-9a-z]+>_<n>` to `$1_ID` (repair ids
/// included, `repair` being the middle part), and every `createdAt` to 0.
fn normalize(v: &Value) -> Value {
    let text = serde_json::to_string(v).unwrap();
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let rest = &text[i..];
        let mut matched = false;
        for prefix in ["msg_", "nudge_"] {
            if let Some(r) = rest.strip_prefix(prefix) {
                let t = r.bytes().take_while(|c| c.is_ascii_digit() || c.is_ascii_lowercase()).count();
                if t > 0 && r.as_bytes().get(t) == Some(&b'_') {
                    let d = r[t + 1..].bytes().take_while(u8::is_ascii_digit).count();
                    if d > 0 {
                        out.push_str(&prefix[..prefix.len() - 1]);
                        out.push_str("_ID");
                        i += prefix.len() + t + 1 + d;
                        matched = true;
                        break;
                    }
                }
            }
        }
        if matched {
            continue;
        }
        // A retry's wait is 0 on the TS side (`retryBaseDelayMs: 0`) and real here.
        if let Some(r) = rest.strip_prefix("\"delayMs\":") {
            let d = r.bytes().take_while(u8::is_ascii_digit).count();
            if d > 0 {
                out.push_str("\"delayMs\":0");
                i += "\"delayMs\":".len() + d;
                continue;
            }
        }
        if let Some(r) = rest.strip_prefix("\"createdAt\":") {
            let d = r.bytes().take_while(u8::is_ascii_digit).count();
            if d > 0 {
                out.push_str("\"createdAt\":0");
                i += "\"createdAt\":".len() + d;
                continue;
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    serde_json::from_str(&out).unwrap()
}

struct Script {
    steps: VecDeque<Value>,
    cancel: Cancel,
    abort_at: Option<usize>,
    index: usize,
}

impl ChunkStream for Script {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        if self.cancel.is_cancelled() {
            return Some(Err("This operation was aborted".into()));
        }
        let step = self.steps.pop_front()?;
        let i = self.index;
        self.index += 1;
        if self.abort_at == Some(i) {
            self.cancel.cancel();
        }
        if let Some(e) = step.get("throw").and_then(Value::as_str) {
            return Some(Err(e.into()));
        }
        let chunk = if let Some(p) = step.get("phase").and_then(Value::as_str) {
            Chunk::Phase(p.into())
        } else if let Some(t) = step.get("text").and_then(Value::as_str) {
            Chunk::Text(t.into())
        } else if let Some(t) = step.get("reasoning").and_then(Value::as_str) {
            Chunk::Reasoning(t.into())
        } else if let Some(c) = step.get("call") {
            Chunk::ToolCall(c.clone())
        } else if let Some(u) = step.get("usage").and_then(Value::as_array) {
            Chunk::Usage {
                input_tokens: u[0].as_f64().unwrap(),
                cache_read_tokens: u.get(3).and_then(Value::as_f64),
                cache_write_tokens: u.get(4).and_then(Value::as_f64),
                output_tokens: u[1].as_f64().unwrap(),
                output_ms: u.get(2).and_then(Value::as_f64),
            }
        } else {
            Chunk::Done
        };
        Some(Ok(chunk))
    }
}

struct Fake {
    responses: Vec<Value>,
    abort_after: Option<(usize, usize)>,
    calls: Mutex<usize>,
    requests: Mutex<Vec<Value>>,
}

impl ModelClient for Fake {
    type Stream = Script;
    async fn chat(&self, req: ChatRequest, cancel: Cancel) -> Result<Script, String> {
        let n = {
            let mut c = self.calls.lock().unwrap();
            *c += 1;
            *c - 1
        };
        // All scripted paths (retry, nudge, commentary, and wrap-up) preserve off.
        assert_eq!(req.prompt_caching, Some(false));
        let tools: Vec<Value> = req.tools.iter().map(|t| t["name"].clone()).collect();
        self.requests
            .lock()
            .unwrap()
            .push(json!({ "model": req.model, "system": req.system, "tools": tools, "messages": req.messages }));
        let steps = self.responses.get(n).and_then(Value::as_array).cloned().unwrap_or_default();
        let abort_at = self.abort_after.filter(|(r, _)| *r == n).map(|(_, i)| i);
        Ok(Script { steps: steps.into(), cancel, abort_at, index: 0 })
    }
}

struct Tools(Value);

impl ToolRunner for Tools {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        let id = call["id"].as_str().unwrap_or("");
        let Some(t) = self.0.get(id) else { return Err(format!("no script for {id}")) };
        if let Some(e) = t.get("throw").and_then(Value::as_str) {
            return Err(e.into());
        }
        let mut r = json!({ "toolCallId": id, "output": t.get("output").cloned().unwrap_or(json!("")) });
        if t.get("isError") == Some(&json!(true)) {
            r["isError"] = json!(true);
        }
        Ok(r)
    }
}

#[tokio::test(start_paused = true)]
async fn every_scripted_run_matches_the_ts_loop() {
    let runs = golden("runs.json");
    let expected = golden("runs.expected.json");
    for (i, s) in runs["scenarios"].as_array().unwrap().iter().enumerate() {
        let mut history = s.get("history").unwrap_or(&runs["defaultHistory"]).as_array().unwrap().clone();
        let cancel = Cancel::default();
        if s.get("abortBefore") == Some(&json!(true)) {
            cancel.cancel();
        }
        let abort_after = s
            .get("abortAfter")
            .and_then(Value::as_array)
            .map(|a| (a[0].as_u64().unwrap() as usize, a[1].as_u64().unwrap() as usize));
        let client = Fake {
            responses: s["responses"].as_array().unwrap().clone(),
            abort_after,
            calls: Mutex::new(0),
            requests: Mutex::new(Vec::new()),
        };
        let tools = Tools(s.get("tools").cloned().unwrap_or(json!({})));
        let mut events = Vec::new();
        run_agent(
            RunOptions {
                session_id: "s1".into(),
                model: "test-model".into(),
                system: "SYSTEM".into(),
                history: &mut history,
                tools: runs["tools"].as_array().unwrap().clone(),
                temperature: None,
                effort: None,
                think: None,
                prompt_caching: Some(false),
                max_history_turns: s.get("maxHistoryTurns").and_then(Value::as_f64),
                context_window: s.get("contextWindow").and_then(Value::as_f64),
                max_output_tokens: None,
                resume: s.get("resume") == Some(&json!(true)),
                cancel,
                steering: Default::default(),
            },
            &client,
            &tools,
            &mut |e, _| events.push(e),
        )
        .await;
        let got = normalize(
            &json!({ "name": s["name"], "events": events, "history": history, "requests": client.requests.lock().unwrap().clone() }),
        );
        let want = &expected[i];
        for key in ["events", "history", "requests"] {
            assert_eq!(got[key], want[key], "{}: {key} differs", s["name"]);
        }
    }
}

#[tokio::test]
async fn a_progressing_run_has_no_step_limit() {
    struct Progressing(Mutex<usize>);
    impl ModelClient for Progressing {
        type Stream = Script;
        async fn chat(&self, _req: ChatRequest, cancel: Cancel) -> Result<Script, String> {
            let mut n = self.0.lock().unwrap();
            let step = if *n < 1001 {
                json!({ "call": { "id": format!("c{}", *n), "name": "read_file", "input": { "path": format!("file{}", *n) } } })
            } else {
                json!({ "text": "finished" })
            };
            *n += 1;
            Ok(Script { steps: vec![step].into(), cancel, abort_at: None, index: 0 })
        }
    }
    struct ProgressTools;
    impl ToolRunner for ProgressTools {
        async fn run(&self, call: &Value) -> Result<Value, String> {
            Ok(json!({ "toolCallId": call["id"], "output": call["id"] }))
        }
    }
    let mut history = vec![json!({ "id": "u", "role": "user", "content": "go", "createdAt": 0 })];
    let client = Progressing(Mutex::new(0));
    let mut last = Value::Null;
    run_agent(
        RunOptions {
            session_id: "s".into(),
            model: "m".into(),
            system: "sys".into(),
            history: &mut history,
            tools: vec![],
            temperature: None,
            effort: None,
            think: None,
            prompt_caching: None,
            max_history_turns: None,
            context_window: None,
            max_output_tokens: None,
            resume: false,
            cancel: Cancel::default(),
            steering: Default::default(),
        },
        &client,
        &ProgressTools,
        &mut |e, _| last = e,
    )
    .await;
    assert_eq!(last["stop"], "complete");
    assert_eq!(last["steps"], 1001);
    assert_eq!(*client.0.lock().unwrap(), 1002);
}
