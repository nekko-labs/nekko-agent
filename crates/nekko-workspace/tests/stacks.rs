//! stacks.rs against the TS functions: `golden/stacks.json` is written by
//! packages/host/src/pr-stacks.golden.test.ts, every scenario run through the
//! real `continuePrStack` / `linkPrStack` with git, GitHub and the chats
//! scripted. The port must give the same answer and make the same calls, in
//! the same order, matched as text.

use futures_util::future::BoxFuture;
use nekko_workspace::stacks::{self, StackHost};
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::Mutex;

struct Scripted {
    s: Value,
    calls: Mutex<Vec<Value>>,
}

fn answer(v: &Value) -> Result<Value, String> {
    match v.get("__error") {
        Some(e) => Err(nekko_js::display(e)),
        None => Ok(v.clone()),
    }
}

impl Scripted {
    fn log(&self, v: Value) {
        self.calls.lock().unwrap().push(v);
    }
}

impl StackHost for Scripted {
    fn session(&self, id: &str) -> Option<Value> {
        self.s["sessions"].get(id).filter(|v| !v.is_null()).cloned()
    }

    fn workspaces(&self) -> Vec<Value> {
        self.s["workspaces"].as_array().cloned().unwrap_or_default()
    }

    fn git<'a>(&'a self, cwd: &'a str, args: &'a [String]) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            self.log(json!(["git", cwd, args]));
            let key = format!("{cwd}|{}", args.join(" "));
            match self.s["git"].get(&key) {
                None => Err(format!("Command failed: git {}", args.join(" "))),
                Some(v) => answer(v).map(|v| nekko_js::display(&v)),
            }
        })
    }

    fn fetch<'a>(&'a self, cwd: &'a str, args: &'a [String]) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            self.log(json!(["fetch", cwd, args]));
            self.s.get("fetchFails") != Some(&json!(true))
        })
    }

    fn request<'a>(&'a self, path: &'a str, body: Option<&'a [Value]>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.log(match body {
                Some(b) => json!(["request", path, b]),
                None => json!(["request", path]),
            });
            match self.s["requests"].get(path) {
                None => Err(format!("no answer for {path}")),
                Some(v) => answer(v),
            }
        })
    }

    fn refresh<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            self.log(json!(["refresh", url]));
            self.s.get("refresh").cloned().unwrap_or(Value::Null)
        })
    }

    fn create<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.log(json!(["create", workspace_id]));
            Ok(self.s["created"].clone())
        })
    }

    fn save<'a>(&'a self, session: &'a mut Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.log(json!(["save", session.clone()]));
            Ok(())
        })
    }
}

#[tokio::test]
async fn pr_stacks_match_the_ts_host() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/stacks.json");
    let golden: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(golden.len() > 40);
    for want in golden {
        let mut input = want.as_object().cloned().unwrap();
        for k in ["result", "error", "calls"] {
            input.shift_remove(k);
        }
        let host = Scripted { s: Value::Object(input.clone()), calls: Mutex::new(Vec::new()) };
        let (sid, url) = (want["sessionId"].as_str().unwrap(), want["url"].as_str().unwrap());
        let mut got: Map<String, Value> = input;
        match want["op"].as_str().unwrap() {
            "continue" => match stacks::continue_stack(&host, sid, url).await {
                Ok(v) => got.insert("result".into(), v),
                Err(e) => got.insert("error".into(), json!(e)),
            },
            _ => got.insert("result".into(), stacks::link_stack(&host, sid, url).await),
        };
        got.insert("calls".into(), Value::Array(host.calls.into_inner().unwrap()));
        assert_eq!(nekko_js::stringify(&Value::Object(got)), nekko_js::stringify(&want), "scenario {}", want["name"]);
    }
}
