//! The Rust training engine against the TS one.
//!
//! `golden/training.json` is written by
//! `packages/host/src/training.golden.test.ts` (UPDATE_GOLDEN=1). The same
//! operations run here against a fake engine that behaves like the TS test's
//! mocks, and `training.json`, every reply, change notice, chat made and turn
//! sent must come out exactly as the TS wrote them.

use nekko_automation::training::{self, BoxFut, Training, TrainingHost};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("training.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(nekko_js::stringify(got), nekko_js::stringify(want), "{what}");
}

#[derive(Default)]
struct Fake {
    settings: Mutex<Value>,
    sessions: Mutex<HashMap<String, Value>>,
    next_session: Mutex<u32>,
    log: Mutex<Vec<Value>>,
    replies: Mutex<VecDeque<Value>>,
    turns: Mutex<Vec<Value>>,
    notices: Mutex<Vec<Value>>,
}

impl TrainingHost for Fake {
    fn settings(&self) -> BoxFut<'_, Value> {
        let s = self.settings.lock().unwrap().clone();
        Box::pin(async move { s })
    }

    fn create_session(
        &self,
        workspace_id: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> BoxFut<'_, Result<String, String>> {
        let id = {
            let mut n = self.next_session.lock().unwrap();
            *n += 1;
            format!("s_{n}")
        };
        let ws = workspace_id.unwrap_or(Value::Null);
        self.log.lock().unwrap().push(json!({ "create": ws, "id": id }));
        let mut title = Value::Null;
        let mut rest = Map::new();
        let mut session = json!({ "id": id, "messages": [] });
        for (k, v) in fields {
            session[k] = v.clone();
            if k == "title" {
                title = v;
            } else {
                rest.insert(k.into(), v);
            }
        }
        self.log.lock().unwrap().push(json!({ "save": id, "title": title, "fields": rest }));
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Box::pin(async move { Ok(id) })
    }

    fn get_session(&self, id: &str) -> Option<Value> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    fn delete_session(&self, id: &str) -> BoxFut<'_, ()> {
        self.log.lock().unwrap().push(json!({ "delete": id }));
        self.sessions.lock().unwrap().remove(id);
        Box::pin(async {})
    }

    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<(), String>> {
        self.turns.lock().unwrap().push(opts.clone());
        let next = self.replies.lock().unwrap().pop_front().unwrap_or(json!({ "reply": "" }));
        let result = if let Some(e) = next.get("error").and_then(Value::as_str) {
            Err(e.to_string())
        } else {
            let sid = opts["sessionId"].as_str().unwrap().to_string();
            if let Some(s) = self.sessions.lock().unwrap().get_mut(&sid) {
                let m = s["messages"].as_array_mut().unwrap();
                m.push(json!({ "role": "user", "content": opts["text"] }));
                m.push(json!({ "role": "assistant", "content": next.get("reply").cloned().unwrap_or(json!("")) }));
            }
            Ok(())
        };
        Box::pin(async move { result })
    }

    fn notify(&self, runs: &Value) {
        self.notices.lock().unwrap().push(runs.clone());
    }
}

/// A tool's answer as the TS test recorded it: the reply, or what it threw.
fn tool_result(r: Result<String, String>) -> Value {
    match r {
        Ok(s) => json!(s),
        Err(e) => json!({ "error": e }),
    }
}

#[tokio::test]
async fn training_json_and_every_side_effect_match() {
    let g = golden();
    let dir = std::env::temp_dir().join(format!("nekko-automation-training-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fake = Arc::new(Fake::default());
    let now = Arc::new(Mutex::new(g["start"].as_f64().unwrap()));
    let uuid = Arc::new(Mutex::new(0u32));
    let clock_now = now.clone();
    let svc = Training::with_manual_timers(
        &dir,
        fake.clone(),
        Arc::new(move || *clock_now.lock().unwrap()),
        Arc::new(move || {
            let mut n = uuid.lock().unwrap();
            *n += 1;
            format!("00000000-0000-4000-8000-{:012}", *n)
        }),
    );
    let file = dir.join("training.json");
    let ops = g["ops"].as_array().unwrap();
    assert!(ops.len() > 60);
    for (i, op) in ops.iter().enumerate() {
        *now.lock().unwrap() = op["now"].as_f64().unwrap();
        *fake.settings.lock().unwrap() = op["settings"].clone();
        for id in op["chats"].as_array().unwrap() {
            let id = id.as_str().unwrap();
            fake.sessions
                .lock()
                .unwrap()
                .insert(id.into(), json!({ "id": id, "providerId": "p1", "modelId": "m1", "messages": [] }));
        }
        *fake.replies.lock().unwrap() = op["replies"].as_array().unwrap().iter().cloned().collect();
        let (n, s, t) =
            (fake.notices.lock().unwrap().len(), fake.log.lock().unwrap().len(), fake.turns.lock().unwrap().len());
        let args = op["args"].as_array().unwrap();
        let name = op["op"].as_str().unwrap();
        let a = |k: usize| args[k].as_str().unwrap_or_default().to_string();
        // A turn's first half runs inside the call; its second half the TS
        // awaited later, in the same step.
        let mut started = Vec::new();
        let result = match name {
            "list" => svc.route("training:list", args).await.unwrap(),
            "create" => svc.create(&args[0]).await.unwrap(),
            "update" => svc.route("training:update", args).await.unwrap(),
            "delete" => svc.route("training:delete", args).await.unwrap(),
            "start" => {
                if svc.mark_started(&a(0))
                    && let Some(p) = svc.begin(&a(0)).await
                {
                    started.push(p);
                }
                Value::Array(svc.list())
            }
            "pause" => svc.route("training:pause", args).await.unwrap(),
            "stop" => svc.route("training:stop", args).await.unwrap(),
            "hint" => svc.route("training:hint", args).await.unwrap(),
            "experiment" => tool_result(svc.report_experiment(&a(0), &args[1])),
            "artifact" => tool_result(svc.report_artifact(&a(0), &args[1])),
            "plan" => tool_result(svc.update_plan(&a(0), &args[1])),
            "planFor" => svc.plan_for_session(&a(0)).unwrap_or(Value::Null),
            "advance" => {
                // The TS clock stood 4 s earlier when the timers were armed.
                for id in svc.take_armed() {
                    if let Some(p) = svc.begin(&id).await {
                        started.push(p);
                    }
                }
                Value::Null
            }
            "resume" => {
                started = svc.resume().await;
                Value::Null
            }
            "file" => {
                std::fs::write(&file, op["file"].as_str().unwrap()).unwrap();
                Value::Null
            }
            other => panic!("unknown op {other}"),
        };
        for p in started {
            svc.finish(p).await;
        }
        same(&result, &op["result"], &format!("op {i} {name} result"));
        assert_eq!(std::fs::read_to_string(&file).ok().as_deref(), op["file"].as_str(), "op {i} {name} training.json");
        same(&json!(fake.notices.lock().unwrap()[n..]), &op["notices"], &format!("op {i} {name} notices"));
        same(&json!(fake.log.lock().unwrap()[s..]), &op["sessions"], &format!("op {i} {name} chats"));
        same(&json!(fake.turns.lock().unwrap()[t..]), &op["turns"], &format!("op {i} {name} turns"));
        assert_eq!(svc.armed() as u64, op["timers"].as_u64().unwrap(), "op {i} {name} armed turns");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prompts_and_fingerprints_match() {
    let g = golden();
    let prompts = g["prompts"].as_array().unwrap();
    assert!(prompts.len() >= 12);
    for (i, c) in prompts.iter().enumerate() {
        let hints: Vec<String> =
            c["hints"].as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_string()).collect();
        assert_eq!(training::turn_prompt(&c["run"], &hints), c["prompt"].as_str().unwrap(), "prompt {i}");
    }
    for c in g["progress"].as_array().unwrap() {
        assert_eq!(training::progress_signature(&c["run"]), c["signature"].as_str().unwrap());
    }
    for c in g["outputs"].as_array().unwrap() {
        assert_eq!(training::output_signature(c["text"].as_str().unwrap()), c["signature"].as_str().unwrap());
    }
}

/// No em dash in any prompt the engine writes, as the project bans them.
#[test]
fn the_prompts_hold_no_em_dashes() {
    for c in golden()["prompts"].as_array().unwrap() {
        assert!(!c["prompt"].as_str().unwrap().contains('\u{2014}'));
    }
}
