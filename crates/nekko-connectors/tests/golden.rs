//! The Rust connectors and actions against the TS ones.
//!
//! `golden/connectors.json` is written by
//! `packages/core/src/connectors/connectors.golden.test.ts` (UPDATE_GOLDEN=1):
//! each case's scripted responses, the requests the TS code sent (method,
//! URL, headers in order, body) and what it returned or threw. The port must
//! send the same requests and return the same results.

use nekko_connectors::http::{BoxFut, Http, Request, Response};
use nekko_connectors::{fetch, poll, render_template, run_action, template_context};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("connectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(nekko_js::stringify(got), nekko_js::stringify(want), "{what}");
}

/// Answers from the case's script in order and records each request.
struct Scripted {
    replies: Mutex<VecDeque<Value>>,
    seen: Mutex<Vec<Value>>,
}

impl Scripted {
    fn new(case: &Value) -> Self {
        Self {
            replies: Mutex::new(case["replies"].as_array().unwrap().iter().cloned().collect()),
            seen: Mutex::default(),
        }
    }
}

impl Http for Scripted {
    fn send(&self, req: Request) -> BoxFut<'_, Result<Response, String>> {
        let headers: Vec<Value> = req.headers.iter().map(|(k, v)| json!([k, v])).collect();
        self.seen.lock().unwrap().push(json!({
            "method": req.method,
            "url": req.url,
            "headers": headers,
            "body": req.body,
            "redirect": if req.no_redirect { json!("manual") } else { Value::Null },
        }));
        let next = self.replies.lock().unwrap().pop_front();
        Box::pin(async move {
            let next = next.ok_or_else(|| "fetch failed".to_string())?;
            let status = next.get("status").and_then(Value::as_u64).unwrap_or(200) as u16;
            let body = match (next.get("text"), next.get("json")) {
                (Some(t), _) => t.as_str().unwrap().to_string(),
                (None, Some(j)) => nekko_js::stringify(j),
                (None, None) => String::new(),
            };
            Ok(Response { status, body, location: None })
        })
    }
}

fn outcome(r: Result<Value, String>) -> (Option<Value>, Option<String>) {
    match r {
        Ok(v) => (Some(v), None),
        Err(e) => (None, Some(e)),
    }
}

fn check_case(i: usize, what: &str, case: &Value, http: &Scripted, result: (Option<Value>, Option<String>)) {
    same(&json!(*http.seen.lock().unwrap()), &case["requests"], &format!("{what} {i} requests"));
    match (result, case.get("error")) {
        ((None, Some(e)), Some(want)) => assert_eq!(e, want.as_str().unwrap(), "{what} {i} error"),
        ((Some(v), None), None) => same(&v, &case["result"], &format!("{what} {i} result")),
        (got, want) => panic!("{what} {i}: got {got:?}, want error {want:?} / result {}", case["result"]),
    }
}

#[tokio::test]
async fn fetches_match() {
    let g = golden();
    for (i, c) in g["fetches"].as_array().unwrap().iter().enumerate() {
        let http = Scripted::new(c);
        let r = fetch(
            &http,
            c["kind"].as_str().unwrap(),
            c["token"].as_str().unwrap(),
            c["query"].as_str(),
            c.get("settings"),
        )
        .await;
        check_case(i, &format!("fetch {}", c["kind"]), c, &http, outcome(r));
    }
}

#[tokio::test]
async fn polls_match() {
    let g = golden();
    for (i, c) in g["polls"].as_array().unwrap().iter().enumerate() {
        let http = Scripted::new(c);
        let r = poll(
            &http,
            c["kind"].as_str().unwrap(),
            c["token"].as_str().unwrap(),
            &c["settings"],
            c["cursor"].as_f64().unwrap(),
        )
        .await;
        check_case(i, &format!("poll {}", c["kind"]), c, &http, outcome(r));
    }
}

#[tokio::test]
async fn actions_match() {
    let g = golden();
    let cases = g["actions"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for (i, c) in cases.iter().enumerate() {
        let http = Scripted::new(c);
        let ctx = c.get("ctx").cloned().unwrap_or(json!({}));
        let r = run_action(&http, c["op"].as_str().unwrap(), c.get("config"), &c["params"], &ctx).await;
        check_case(i, &format!("action {}", c["op"]), c, &http, (Some(r.value()), None));
    }
}

#[test]
fn templates_match() {
    let g = golden();
    let tctx = &g["templateContext"];
    // The context as templateContext builds it from the same inputs.
    let event = json!({ "kind": "git", "provider": "github", "repo": "o/r", "branch": "main", "payload": { "sha": "abc", "n": 5, "obj": { "a": [1, 2] }, "nul": null, "flag": false } });
    let run = json!({ "id": "r1", "workflowId": "w1", "workflowName": "Ship It!", "status": "success", "triggerKind": "git" });
    let built = template_context(
        Some(&event),
        &[("build".into(), "ok\nlines".into()), ("test".into(), String::new())],
        Some(&run),
    );
    same(&built, tctx, "templateContext");
    for t in g["templates"].as_array().unwrap() {
        assert_eq!(
            render_template(t["template"].as_str().unwrap(), tctx),
            t["rendered"].as_str().unwrap(),
            "{}",
            t["template"]
        );
    }
}

#[tokio::test]
async fn snippets_take_five_per_connector_and_skip_failures() {
    // Teams with a webhook needs no network; a disconnected or tokenless
    // connector is skipped; a failing one adds nothing.
    let connectors = json!([
        { "kind": "teams", "connected": true, "token": "", "settings": { "webhookUrl": "https://a.webhook.office.com/x" } },
        { "kind": "slack", "connected": false, "token": "t" },
        { "kind": "discord", "connected": true, "token": "bot" },
    ]);
    let http = Scripted::new(
        &json!({ "replies": [{ "json": (0..8).map(|i| json!({ "id": format!("g{i}"), "name": format!("G{i}") })).collect::<Vec<_>>() }] }),
    );
    let got =
        nekko_connectors::snippets(&http, connectors.as_array().unwrap(), None, std::time::Duration::from_secs(5))
            .await;
    assert_eq!(got.len(), 5, "{got:?}");
    assert_eq!(got[0], json!({ "label": "G0", "origin": "discord", "body": "Discord server" }));
}
