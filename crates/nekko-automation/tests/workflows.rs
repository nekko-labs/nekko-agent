//! The Rust workflow engine against the TS one.
//!
//! `golden/workflow-rules.json` and `golden/workflows.json` are written by
//! `packages/host/src/workflows.golden.test.ts` (UPDATE_GOLDEN=1). The rules
//! must give the same answers; the engine, driven through the same operations
//! against a fake daemon that behaves like the TS test's mocks, must leave the
//! same files and make the same chats, turns, shell calls and actions.

use nekko_automation::workflow_rules as rules;
use nekko_automation::workflows::{BoxFut, ShellResult, WorkflowHost, Workflows};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

fn golden(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(nekko_js::stringify(got), nekko_js::stringify(want), "{what}");
}

fn opt(v: Option<f64>) -> Value {
    v.map_or(Value::Null, nekko_automation::json::num)
}

#[test]
fn cron_schedules_and_matching_follow_the_shared_rules() {
    let g = golden("workflow-rules.json");
    let cron = g["cron"].as_array().unwrap();
    assert!(cron.len() > 200);
    for c in cron {
        let zone: chrono_tz::Tz = c["tz"].as_str().unwrap().parse().unwrap();
        let expr = c["expr"].as_str().unwrap();
        assert_eq!(rules::is_valid_cron(expr), c["valid"].as_bool().unwrap(), "{expr}");
        let got = rules::next_cron_run(&zone, expr, c["from"].as_f64().unwrap());
        same(&opt(got), &c["next"], &format!("{expr} in {} from {}", c["tz"], c["from"]));
    }
    for c in g["scheduled"].as_array().unwrap() {
        let got = rules::next_scheduled_run(&chrono_tz::UTC, &c["workflow"], c["from"].as_f64().unwrap());
        same(&opt(got), &c["next"], &format!("{}", c["workflow"]["triggers"]));
    }
    let list = g["list"].as_array().unwrap();
    for m in g["matches"].as_array().unwrap() {
        let e = &m["event"];
        let got: Vec<Value> = rules::match_workflows(list, e).iter().map(|w| w["id"].clone()).collect();
        same(&json!(got), &m["matched"], &format!("matched {e}"));
        let accepts: Vec<Vec<bool>> = list
            .iter()
            .map(|w| w["triggers"].as_array().unwrap().iter().map(|t| rules::trigger_accepts(w, t, e)).collect())
            .collect();
        same(&json!(accepts), &m["accepts"], &format!("accepts {e}"));
    }
    for c in g["contexts"].as_array().unwrap() {
        assert_eq!(rules::event_context(&c["event"]), c["context"].as_str().unwrap());
    }
    for c in g["outcomes"].as_array().unwrap() {
        assert_eq!(rules::read_step_outcome(c["text"].as_str().unwrap()), c["outcome"].as_str().unwrap());
    }
    for c in g["slugs"].as_array().unwrap() {
        assert_eq!(rules::slugify(c["name"].as_str().unwrap()), c["slug"].as_str().unwrap(), "{}", c["name"]);
    }
    for c in g["commands"].as_array().unwrap() {
        assert_eq!(rules::cli_command(&c["workflow"], Some(&c["trigger"])), c["command"].as_str().unwrap());
    }
    for c in g["branches"].as_array().unwrap() {
        let patterns = (!c["patterns"].is_null()).then(|| &c["patterns"]);
        assert_eq!(
            rules::branch_matches(c["branch"].as_str().unwrap(), patterns),
            c["matches"].as_bool().unwrap(),
            "{c}"
        );
    }
    assert_eq!(rules::step_outcome_instruction(true), g["instructions"][0].as_str().unwrap());
    assert_eq!(rules::step_outcome_instruction(false), g["instructions"][1].as_str().unwrap());
    for a in g["actions"].as_array().unwrap() {
        assert_eq!(nekko_automation::templates::find_action(a["op"].as_str().unwrap()), Some(a["connector"].as_str()));
    }
}

#[derive(Default)]
struct Fake {
    settings: Mutex<Value>,
    sessions: Mutex<HashMap<String, Value>>,
    next_session: Mutex<u32>,
    log: Mutex<Vec<Value>>,
    replies: Mutex<VecDeque<Value>>,
    turns: Mutex<Vec<Value>>,
    aborts: Mutex<Vec<String>>,
    shells: Mutex<Vec<Value>>,
    shell_results: Mutex<VecDeque<Value>>,
    actions: Mutex<Vec<Value>>,
    action_results: Mutex<VecDeque<Value>>,
    notices: Mutex<Vec<Value>>,
    now: Mutex<f64>,
    engine: Mutex<Option<std::sync::Weak<Workflows>>>,
    /// The settings each poll got, and what the next polls return (none: no poll).
    polls: Mutex<Vec<Value>>,
    poll_results: Mutex<VecDeque<Value>>,
}

impl WorkflowHost for Fake {
    fn settings(&self) -> BoxFut<'_, Value> {
        let s = self.settings.lock().unwrap().clone();
        Box::pin(async move { s })
    }
    fn create_session(
        &self,
        ws: Option<Value>,
        fields: Vec<(&'static str, Value)>,
    ) -> BoxFut<'_, Result<String, String>> {
        let id = {
            let mut n = self.next_session.lock().unwrap();
            *n += 1;
            format!("s_{n}")
        };
        self.log.lock().unwrap().push(json!({ "create": ws.unwrap_or(Value::Null), "id": id }));
        let (mut title, mut rest) = (Value::Null, Map::new());
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
    fn send_chat(&self, opts: Value) -> BoxFut<'_, Result<Option<String>, String>> {
        self.turns.lock().unwrap().push(opts.clone());
        let next = self.replies.lock().unwrap().pop_front().unwrap_or(json!({ "reply": "" }));
        if next["cancel"] == json!(true) {
            let engine = self.engine.lock().unwrap().clone().and_then(|w| w.upgrade());
            if let Some(engine) = engine
                && let Some(running) = engine.runs(None).into_iter().find(|r| r["status"] == "running")
            {
                engine.cancel(running["id"].as_str().unwrap());
            }
        }
        let result = if let Some(t) = next["throws"].as_str() {
            Err(t.to_string())
        } else {
            let sid = opts["sessionId"].as_str().unwrap();
            if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
                let m = s["messages"].as_array_mut().unwrap();
                m.push(json!({ "role": "user", "content": opts["text"] }));
                m.push(json!({ "role": "assistant", "content": next.get("reply").cloned().unwrap_or(json!("")) }));
            }
            Ok(next["event"].as_str().map(str::to_string))
        };
        Box::pin(async move { result })
    }
    fn abort_chat(&self, id: &str) {
        self.aborts.lock().unwrap().push(id.to_string());
    }
    fn skill_defs(&self) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async {
            vec![
                json!({ "id": "review", "name": "Code Review", "template": "  Review the diff.  " }),
                json!({ "id": "empty", "name": "Empty", "template": "   " }),
            ]
        })
    }
    fn run_action(&self, op: &str, config: Option<Value>, params: Value, ctx: Value) -> BoxFut<'_, Value> {
        self.actions
            .lock()
            .unwrap()
            .push(json!({ "op": op, "config": config.unwrap_or(Value::Null), "params": params, "ctx": ctx }));
        let r = self.action_results.lock().unwrap().pop_front().unwrap_or(json!({ "output": "ok" }));
        Box::pin(async move { r })
    }
    fn run_shell(&self, cmd: &str, cwd: &str, timeout_ms: f64) -> BoxFut<'_, ShellResult> {
        self.shells
            .lock()
            .unwrap()
            .push(json!({ "cmd": cmd, "cwd": cwd, "timeout": nekko_automation::json::num(timeout_ms) }));
        let r = self.shell_results.lock().unwrap().pop_front().unwrap_or(json!({}));
        let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let res = ShellResult {
            stdout: s("stdout"),
            stderr: s("stderr"),
            error: r.get("error").and_then(Value::as_str).map(str::to_string),
            killed: r.get("killed") == Some(&json!(true)),
        };
        Box::pin(async move { res })
    }
    fn poll(&self, _: &str, _: &str, settings: Value, cursor: f64) -> BoxFut<'_, Option<Result<Value, String>>> {
        let next = self.poll_results.lock().unwrap().pop_front();
        if next.is_some() {
            self.polls.lock().unwrap().push(json!({ "settings": settings, "cursor": cursor }));
        }
        Box::pin(async move { next.map(Ok) })
    }
    fn notify(&self, snapshot: &Value) {
        self.notices.lock().unwrap().push(snapshot.clone());
    }
    fn next_run(&self, wf: &Value, from: f64) -> Option<f64> {
        rules::next_scheduled_run(&chrono_tz::UTC, wf, from)
    }
    fn resolve_path(&self, root: &str, rel: &str) -> String {
        if rel.starts_with('/') { rel.to_string() } else { format!("{root}/{rel}") }
    }
}

#[tokio::test]
async fn the_engine_leaves_the_same_files_and_side_effects() {
    let g = golden("workflows.json");
    let dir = std::env::temp_dir().join(format!("nekko-automation-workflows-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fake = Arc::new(Fake::default());
    *fake.settings.lock().unwrap() = g["settings"].clone();
    *fake.now.lock().unwrap() = g["start"].as_f64().unwrap();
    let uuid = Arc::new(Mutex::new(0u32));
    let clock = fake.clone();
    let engine = Workflows::new(
        &dir,
        fake.clone(),
        Arc::new(move || *clock.now.lock().unwrap()),
        Arc::new(move || {
            let mut n = uuid.lock().unwrap();
            *n += 1;
            format!("id-{:03}", *n)
        }),
    );
    *fake.engine.lock().unwrap() = Some(Arc::downgrade(&engine));
    let ops = g["ops"].as_array().unwrap();
    for (i, op) in ops.iter().enumerate() {
        let name = op["op"].as_str().unwrap();
        *fake.now.lock().unwrap() = op["now"].as_f64().unwrap();
        *fake.replies.lock().unwrap() = op["replies"].as_array().unwrap().iter().cloned().collect();
        *fake.shell_results.lock().unwrap() = op["shells"].as_array().unwrap().iter().cloned().collect();
        *fake.action_results.lock().unwrap() = op["actions"].as_array().unwrap().iter().cloned().collect();
        let mark = (
            fake.notices.lock().unwrap().len(),
            fake.log.lock().unwrap().len(),
            fake.turns.lock().unwrap().len(),
            fake.aborts.lock().unwrap().len(),
            fake.shells.lock().unwrap().len(),
            fake.actions.lock().unwrap().len(),
        );
        let args = op["args"].as_array().unwrap();
        let a = |k: usize| args[k].as_str().unwrap_or("").to_string();
        let result = match name {
            "snapshot" => engine.snapshot(),
            "create" => engine.create(&args[0]).await.unwrap(),
            "update" => engine.update(&a(0), &args[1]).unwrap_or(Value::Null),
            "delete" => {
                engine.delete(&a(0)).await;
                Value::Null
            }
            "duplicate" => engine.duplicate(&a(0)).await.unwrap().unwrap_or(Value::Null),
            "run" => engine.run(&a(0)).await.unwrap_or(Value::Null),
            "cancel" => {
                engine.cancel(&a(0));
                Value::Null
            }
            "runs" => Value::Array(engine.runs(Some(&a(0)))),
            "event" => Value::Array(engine.dispatch_event(&args[0]).await),
            "webhook" => match engine.dispatch_webhook(&a(0), &a(1), &args[2]).await {
                Ok(v) => Value::Array(v),
                Err(e) => json!({ "thrown": e, "code": "WEBHOOK_UNAUTHORIZED" }),
            },
            "tick" => {
                for id in engine.due(op["now"].as_f64().unwrap()) {
                    engine.dispatch_scheduled(&id).await;
                }
                Value::Null
            }
            "reconcile" => {
                engine.reconcile();
                Value::Null
            }
            "settings" => {
                if let (Value::Object(s), Value::Object(patch)) = (&mut *fake.settings.lock().unwrap(), &args[0]) {
                    for (k, v) in patch {
                        s.insert(k.clone(), v.clone());
                    }
                }
                Value::Null
            }
            "file" => {
                let f = op["file"].as_array().unwrap();
                std::fs::write(dir.join(f[0].as_str().unwrap()), f[1].as_str().unwrap()).unwrap();
                Value::Null
            }
            other => panic!("unknown op {other}"),
        };
        let what = |k: &str| format!("op {i} {name} {k}");
        same(&result, &op["result"], &what("result"));
        let read = |f: &str| std::fs::read_to_string(dir.join(f)).ok();
        assert_eq!(read("workflows.json").as_deref(), op["workflowsFile"].as_str(), "{}", what("workflows.json"));
        assert_eq!(read("workflow-runs.json").as_deref(), op["runsFile"].as_str(), "{}", what("workflow-runs.json"));
        let notices = fake.notices.lock().unwrap()[mark.0..].to_vec();
        assert_eq!(notices.len() as u64, op["noticeCount"].as_u64().unwrap(), "{}", what("notice count"));
        if let Some(last) = notices.last() {
            same(last, &op["lastNotice"], &what("last notice"));
        }
        same(&json!(fake.log.lock().unwrap()[mark.1..]), &op["sessions"], &what("chats"));
        same(&json!(fake.turns.lock().unwrap()[mark.2..]), &op["turns"], &what("turns"));
        same(&json!(fake.aborts.lock().unwrap()[mark.3..]), &op["aborts"], &what("aborts"));
        same(&json!(fake.shells.lock().unwrap()[mark.4..]), &op["shellCalls"], &what("shell calls"));
        same(&json!(fake.actions.lock().unwrap()[mark.5..]), &op["actionCalls"], &what("actions"));
    }
    for d in g["described"].as_array().unwrap() {
        assert_eq!(rules::describe_event(&d["event"]), d["label"].as_str().unwrap(), "{}", d["event"]);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_poll_state_is_kept_in_the_cursor_record_across_restarts() {
    let dir = std::env::temp_dir().join(format!("nekko-automation-poll-state-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fake = Arc::new(Fake::default());
    *fake.settings.lock().unwrap() = json!({ "connectors": [{ "kind": "github", "connected": true, "token": "t" }] });
    *fake.now.lock().unwrap() = 1_000_000.0;
    let start = |fake: &Arc<Fake>| {
        let clock = fake.clone();
        Workflows::new(
            &dir,
            fake.clone(),
            Arc::new(move || *clock.now.lock().unwrap()),
            Arc::new(|| "id-1".to_string()),
        )
    };
    let engine = start(&fake);
    engine
        .create(&json!({
            "name": "Review PRs",
            "steps": [{ "id": "s", "name": "S", "kind": "prompt", "run": "Review {{trigger.number}}" }],
            "triggers": [{ "id": "t1", "kind": "connector", "connector": "github", "repo": "o/r", "event": "pr_opened", "includeDrafts": true }],
        }))
        .await
        .unwrap();
    // Arming: the poll returns its state and no events.
    fake.poll_results
        .lock()
        .unwrap()
        .push_back(json!({ "events": [], "nextCursor": 1_000_000, "pollState": { "prHeads": { "1": "a" } } }));
    engine.tick_listeners().await;
    let first = fake.polls.lock().unwrap()[0].clone();
    assert_eq!(first["settings"]["includeDrafts"], true);
    assert!(first["settings"].get("pollState").is_none());
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("workflow-cursors.json")).unwrap()).unwrap();
    assert_eq!(file["version"], 1);
    assert_eq!(file["cursors"]["t1"]["lastCursor"], 1_000_000);
    assert_eq!(file["cursors"]["t1"]["pollState"], json!({ "prHeads": { "1": "a" } }));

    // A restart reads the state back and hands it to the next poll.
    drop(engine);
    let engine = start(&fake);
    *fake.now.lock().unwrap() = 2_000_000.0;
    fake.poll_results
        .lock()
        .unwrap()
        .push_back(json!({ "events": [], "nextCursor": 1_000_000, "pollState": { "prHeads": { "1": "a" } } }));
    engine.tick_listeners().await;
    assert_eq!(fake.polls.lock().unwrap()[1]["settings"]["pollState"], json!({ "prHeads": { "1": "a" } }));
    let _ = std::fs::remove_dir_all(&dir);
}
