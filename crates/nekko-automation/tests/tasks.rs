//! The Rust task service against the TS one.
//!
//! `golden/tasks.json` is written by `packages/host/src/tasks.golden.test.ts`
//! (UPDATE_GOLDEN=1). The same operations run here against a fake engine that
//! behaves like the TS test's mocks, and `tasks.json`, every reply, change
//! notice, chat made and turn sent must come out exactly as the TS wrote them.

use nekko_automation::tasks::{self, BoxFut, TaskHost, Tasks};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("tasks.json");
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

impl TaskHost for Fake {
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
        for (k, v) in fields {
            if k == "title" {
                title = v;
            } else {
                rest.insert(k.into(), v);
            }
        }
        self.log.lock().unwrap().push(json!({ "save": id, "title": title, "fields": rest }));
        self.sessions.lock().unwrap().insert(id.clone(), json!({ "id": id, "messages": [] }));
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

    fn notify(&self, list: &Value) {
        self.notices.lock().unwrap().push(list.clone());
    }
}

#[tokio::test]
async fn tasks_json_and_every_side_effect_match() {
    let g = golden();
    let dir = std::env::temp_dir().join(format!("nekko-automation-tasks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fake = Arc::new(Fake::default());
    let now = Arc::new(Mutex::new(g["start"].as_f64().unwrap()));
    let uuid = Arc::new(Mutex::new(0u32));
    let clock_now = now.clone();
    let svc = Tasks::new(
        &dir,
        fake.clone(),
        Arc::new(move || *clock_now.lock().unwrap()),
        Arc::new(move || {
            let mut n = uuid.lock().unwrap();
            *n += 1;
            format!("00000000-0000-4000-8000-{:012}", *n)
        }),
    );
    let file = dir.join("tasks.json");
    let ops = g["ops"].as_array().unwrap();
    assert!(ops.len() > 25);
    for (i, op) in ops.iter().enumerate() {
        *now.lock().unwrap() = op["now"].as_f64().unwrap();
        *fake.settings.lock().unwrap() = op["settings"].clone();
        if let Some(sid) = op["deleteSession"].as_str() {
            fake.sessions.lock().unwrap().remove(sid);
        }
        *fake.replies.lock().unwrap() = op["replies"].as_array().unwrap().iter().cloned().collect();
        let (n, s, t) =
            (fake.notices.lock().unwrap().len(), fake.log.lock().unwrap().len(), fake.turns.lock().unwrap().len());
        let args = op["args"].as_array().unwrap();
        let name = op["op"].as_str().unwrap();
        let result = match name {
            "list" => svc.route("tasks:list", args).await.unwrap(),
            "create" => svc.route("task:create", args).await.unwrap(),
            "update" => svc.route("task:update", args).await.unwrap(),
            "delete" => svc.route("task:delete", args).await.unwrap(),
            "run" => {
                svc.fire(args[0].as_str().unwrap()).await;
                Value::Null
            }
            "tick" => {
                for id in svc.due(op["now"].as_f64().unwrap()) {
                    svc.fire(&id).await;
                }
                Value::Null
            }
            "start" => Value::Null,
            "reconcile" => {
                svc.reconcile();
                Value::Null
            }
            "file" => {
                std::fs::write(&file, op["file"].as_str().unwrap()).unwrap();
                Value::Null
            }
            other => panic!("unknown op {other}"),
        };
        same(&result, &op["result"], &format!("op {i} {name} result"));
        assert_eq!(std::fs::read_to_string(&file).ok().as_deref(), op["file"].as_str(), "op {i} {name} tasks.json");
        let notices = fake.notices.lock().unwrap()[n..].to_vec();
        let want = op["notices"].as_array().unwrap();
        if name == "tick" {
            // Fires run concurrently in the TS, so their middle snapshots
            // interleave differently; the count and the last one must agree.
            assert_eq!(notices.len(), want.len(), "op {i} tick notices");
            same(notices.last().unwrap(), want.last().unwrap(), &format!("op {i} last notice"));
        } else {
            same(&json!(notices), &json!(want), &format!("op {i} {name} notices"));
        }
        same(&json!(fake.log.lock().unwrap()[s..]), &op["sessions"], &format!("op {i} {name} chats"));
        same(&json!(fake.turns.lock().unwrap()[t..]), &op["turns"], &format!("op {i} {name} turns"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prompts_and_finished_fires_match() {
    let g = golden();
    for c in g["prompts"].as_array().unwrap() {
        assert_eq!(tasks::task_prompt(&c["task"]), c["prompt"].as_str().unwrap(), "{}", c["task"]);
    }
    let patches = g["patches"].as_array().unwrap();
    assert!(patches.len() >= 40);
    for c in patches {
        let patch = tasks::task_run_patch(&c["task"], c["result"].as_str().unwrap(), c["now"].as_f64().unwrap());
        let mut m = Map::new();
        for (k, v) in patch {
            if let Some(v) = v {
                m.insert(k.into(), v);
            }
        }
        same(&Value::Object(m), &c["patch"], &format!("{} with {:?}", c["task"], c["result"]));
    }
}
