//! The Rust workflow engine against the TS one.
//!
//! `golden/workflow-rules.json` and `golden/workflows.json` are a frozen
//! record of the deleted TS engine (edit them by hand per
//! docs/runbooks/golden-fixtures.md). The rules
//! must give the same answers; the engine, driven through the same operations
//! against a fake daemon that behaves like the TS test's mocks, must leave the
//! same files and make the same chats, turns, shell calls and actions.
//! The fixtures are frozen (the TS writer is gone); `workflows.json`'s run
//! chats were edited by hand to add `unattended` and `workflowRunId` (#681).
//! The tests after the golden one cover model choice and run safety directly.

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

/// A chat's title and its other saved fields.
type SavedChat = (Value, Map<String, Value>);

#[derive(Default)]
struct Fake {
    settings: Mutex<Value>,
    sessions: Mutex<HashMap<String, Value>>,
    /// Each chat's saved fields besides id, title, workspace and messages (the TS mock's `rest`).
    fields: Mutex<HashMap<String, SavedChat>>,
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
    /// PR checkouts made (`[folder, number, run]`) and removed, and a refusal to make one.
    checkouts: Mutex<Vec<Value>>,
    removed: Mutex<Vec<Value>>,
    checkout_error: Mutex<Option<String>>,
    /// A synthetic `activity:state`, in place of the OS reading (none: cannot tell).
    activity: Mutex<Option<Value>>,
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
        self.fields.lock().unwrap().insert(id.clone(), (title, rest));
        self.sessions.lock().unwrap().insert(id.clone(), json!({ "id": id, "messages": [] }));
        Box::pin(async move { Ok(id) })
    }
    fn get_session(&self, id: &str) -> Option<Value> {
        self.sessions.lock().unwrap().get(id).cloned()
    }
    fn update_session(&self, id: &str, fields: Vec<(&'static str, Value)>) -> BoxFut<'_, Result<(), String>> {
        let mut all = self.fields.lock().unwrap();
        if let Some((title, rest)) = all.get_mut(id) {
            for (k, v) in fields {
                rest.insert(k.into(), v);
            }
            self.log.lock().unwrap().push(json!({ "save": id, "title": title, "fields": rest }));
        }
        Box::pin(async { Ok(()) })
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
                json!({ "id": "nyaa:cr", "name": "nyaa:cr", "source": "plugin", "pluginRoot": "/plugins/nyaa/1.0.0",
                    "origin": { "dir": "/plugins/nyaa/1.0.0" },
                    "template": "Review PR $ARGUMENTS with ${CLAUDE_PLUGIN_ROOT}/skills/nyaa/references/rules.md.",
                    "allowedTools": ["Bash(gh:*)", "Bash(git:*)", "Bash(pnpm:*)", "Read", "Grep", "Glob"] }),
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
    fn activity(&self, _idle_after_secs: f64) -> BoxFut<'_, Option<Value>> {
        let a = self.activity.lock().unwrap().clone();
        Box::pin(async move { a })
    }
    fn resolve_path(&self, root: &str, rel: &str) -> String {
        if rel.starts_with('/') { rel.to_string() } else { format!("{root}/{rel}") }
    }
    fn pr_checkout(&self, folder: &str, number: &str, run_id: &str) -> BoxFut<'_, Result<Value, String>> {
        self.checkouts.lock().unwrap().push(json!([folder, number, run_id]));
        let r = match self.checkout_error.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(
                json!({ "path": format!("/checkouts/{run_id}"), "root": format!("/checkouts/{run_id}"), "sourceRoot": folder }),
            ),
        };
        Box::pin(async move { r })
    }
    fn remove_pr_checkout(&self, checkout: &Value) -> BoxFut<'_, ()> {
        self.removed.lock().unwrap().push(checkout.clone());
        Box::pin(async {})
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
async fn an_armed_cursor_holds_until_the_first_event() {
    // A failed-run poll returns no state, and its cursor only moves with an
    // event: the arming time must be kept, or every poll re-arms at "now" and
    // a run failing between two polls is never seen.
    let dir = std::env::temp_dir().join(format!("nekko-automation-armed-cursor-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fake = Arc::new(Fake::default());
    *fake.settings.lock().unwrap() = json!({ "connectors": [{ "kind": "github", "connected": true, "token": "t" }] });
    *fake.now.lock().unwrap() = 1_000_000.0;
    let clock = fake.clone();
    let engine = Workflows::new(
        &dir,
        fake.clone(),
        Arc::new(move || *clock.now.lock().unwrap()),
        Arc::new(|| "id-1".to_string()),
    );
    engine
        .create(&json!({
            "name": "Diagnose",
            "steps": [{ "id": "s", "name": "S", "kind": "prompt", "run": "x" }],
            "triggers": [{ "id": "t1", "kind": "connector", "connector": "github", "repo": "o/r", "event": "workflow_run_failed", "pollIntervalMs": 120_000 }],
        }))
        .await
        .unwrap();
    fake.poll_results.lock().unwrap().push_back(json!({ "events": [], "nextCursor": 1_000_000 }));
    engine.tick_listeners().await;
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("workflow-cursors.json")).unwrap()).unwrap();
    assert_eq!(file["cursors"]["t1"]["lastCursor"], 1_000_000);

    // Two minutes later, from a fresh engine (a restart), the poll still asks from the arming time.
    drop(engine);
    *fake.now.lock().unwrap() = 1_120_001.0;
    let clock = fake.clone();
    let engine = Workflows::new(
        &dir,
        fake.clone(),
        Arc::new(move || *clock.now.lock().unwrap()),
        Arc::new(|| "id-1".to_string()),
    );
    fake.poll_results.lock().unwrap().push_back(json!({ "events": [], "nextCursor": 1_000_000 }));
    engine.tick_listeners().await;
    assert_eq!(fake.polls.lock().unwrap()[1]["cursor"], 1_000_000.0);
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

/// A fresh engine over the fake, with the given settings, in its own folder.
fn engine_with(name: &str, settings: Value) -> (Arc<Workflows>, Arc<Fake>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("nekko-automation-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fake = Arc::new(Fake::default());
    *fake.settings.lock().unwrap() = settings;
    *fake.now.lock().unwrap() = 1_000.0;
    let n = Arc::new(Mutex::new(0u32));
    let engine = Workflows::new(
        &dir,
        fake.clone(),
        Arc::new(|| 1_000.0),
        Arc::new(move || {
            let mut n = n.lock().unwrap();
            *n += 1;
            format!("id-{n}")
        }),
    );
    (engine, fake, dir)
}

fn local_settings() -> Value {
    json!({
        "workspaces": [{ "id": "w", "path": "/work" }],
        "defaultProviderId": "cloud", "defaultModelId": "claude",
        "providers": [
            { "id": "cloud", "kind": "anthropic", "label": "Cloud", "baseUrl": "https://api.anthropic.com", "enabled": true },
            { "id": "local", "kind": "llamacpp", "label": "Local", "baseUrl": "http://127.0.0.1:8080/v1", "enabled": true },
            { "id": "lan", "kind": "ollama", "label": "LAN box", "baseUrl": "http://10.0.0.5:11434", "enabled": true },
        ],
        "connectors": [{ "kind": "slack", "connected": true, "token": "x" }],
    })
}

fn prompt_step(id: &str, extra: Value) -> Value {
    let mut s = json!({ "id": id, "name": id, "kind": "prompt", "run": "do it" });
    for (k, v) in extra.as_object().unwrap() {
        s[k] = v.clone();
    }
    s
}

#[tokio::test]
async fn a_local_only_workflow_refuses_cloud_models_without_falling_back() {
    let (engine, fake, dir) = engine_with("local-only", local_settings());
    // The global default is cloud: refused, not used.
    let wf = engine
        .create(&json!({ "name": "L", "localModelOnly": true, "steps": [prompt_step("a", json!({}))] }))
        .await
        .unwrap();
    let run = engine.run(wf["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(run["status"], "failure");
    assert!(
        run["message"].as_str().unwrap().contains("This workflow uses local models only; Cloud is not local."),
        "{run}"
    );
    // A step override to cloud, and a local kind on a LAN address, are refused too.
    let wf = engine
        .create(&json!({ "name": "L2", "localModelOnly": true, "providerId": "local", "modelId": "m",
            "steps": [prompt_step("a", json!({ "providerId": "cloud", "modelId": "claude" }))] }))
        .await
        .unwrap();
    assert!(
        engine.run(wf["id"].as_str().unwrap()).await.unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("Cloud is not local.")
    );
    let wf = engine
        .create(&json!({ "name": "L3", "localModelOnly": true, "providerId": "lan", "modelId": "m", "steps": [prompt_step("a", json!({}))] }))
        .await
        .unwrap();
    assert!(
        engine.run(wf["id"].as_str().unwrap()).await.unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("LAN box is not local.")
    );
    assert!(fake.turns.lock().unwrap().is_empty(), "no turn reached any model");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_local_only_run_is_offline_and_still_runs_action_steps() {
    let (engine, fake, dir) = engine_with("local-actions", local_settings());
    fake.replies.lock().unwrap().push_back(json!({ "reply": "diagnosis ⟦PASS⟧" }));
    let wf = engine
        .create(&json!({ "name": "L4", "localModelOnly": true, "toolAccess": "read", "providerId": "local", "modelId": "m",
            "steps": [prompt_step("a", json!({})),
                { "id": "post", "name": "Post", "kind": "action", "run": "slack.postMessage", "params": { "channel": "#ci", "text": "{{steps.a.output}}" } }] }))
        .await
        .unwrap();
    let run = engine.run(wf["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(run["status"], "success", "{run}");
    assert_eq!(fake.turns.lock().unwrap()[0]["providerId"], "local");
    assert_eq!(fake.actions.lock().unwrap()[0]["op"], "slack.postMessage");
    // The outcome token routes the step; it is not part of what gets posted.
    assert_eq!(fake.actions.lock().unwrap()[0]["params"]["text"], "diagnosis");
    let saved = fake.log.lock().unwrap().iter().find(|e| e.get("save").is_some()).cloned().unwrap();
    let fields = &saved["fields"];
    assert_eq!(fields["unattended"], true);
    assert_eq!(fields["workflowRunId"], run["id"]);
    assert_eq!(fields["offline"], true);
    assert_eq!(fields["toolAccess"], "read");
    let off: Vec<&str> = fields["disabledTools"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(off.contains(&"write_file") && off.contains(&"bash") && !off.contains(&"read_file"), "{off:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_allowlist_workflow_sets_each_steps_tools_before_it_runs() {
    let (engine, fake, dir) = engine_with("allowlist", local_settings());
    fake.replies.lock().unwrap().extend([json!({ "reply": "a" }), json!({ "reply": "b" })]);
    let wf = engine
        .create(&json!({ "name": "A", "toolAccess": "allowlist", "providerId": "local", "modelId": "m",
            "steps": [prompt_step("a", json!({ "allowedTools": ["Read", "Bash(gh:*)"] })), prompt_step("b", json!({}))] }))
        .await
        .unwrap();
    engine.run(wf["id"].as_str().unwrap()).await.unwrap();
    let saves: Vec<Value> = fake.log.lock().unwrap().iter().filter(|e| e.get("save").is_some()).cloned().collect();
    assert_eq!(saves[1]["fields"]["allowedTools"], json!(["Read", "Bash(gh:*)"]));
    let off: Vec<&str> =
        saves[1]["fields"]["disabledTools"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(!off.contains(&"read_file") && !off.contains(&"bash") && off.contains(&"write_file"), "{off:?}");
    assert_eq!(saves[2]["fields"]["allowedTools"], json!([]));
    let _ = std::fs::remove_dir_all(&dir);
}

fn pr_event(assoc: &str, fork: bool) -> Value {
    json!({ "kind": "connector", "connector": "github", "event": "pr_opened", "repo": "o/r",
        "payload": { "number": 42, "sha": "abc", "author_association": assoc, "is_fork": fork } })
}

fn review_workflow(extra: Value) -> Value {
    let mut wf = json!({ "name": "Review PRs", "providerId": "local", "modelId": "m", "prCheckout": true,
        "toolAccess": "allowlist",
        "triggers": [{ "id": "t", "kind": "connector", "connector": "github", "event": "pr_opened" }],
        "steps": [{ "id": "review", "name": "Review", "kind": "skill", "run": "nyaa:cr", "args": "{{trigger.number}}" }] });
    for (k, v) in extra.as_object().unwrap() {
        wf[k] = v.clone();
    }
    wf
}

/// Every save of the run's chat, in order.
fn saves(fake: &Fake) -> Vec<Value> {
    fake.log.lock().unwrap().iter().filter(|e| e.get("save").is_some()).map(|e| e["fields"].clone()).collect()
}

#[tokio::test]
async fn a_skill_step_fills_its_arguments_and_runs_under_its_skills_allowlist() {
    let (engine, fake, dir) = engine_with("skill-args", local_settings());
    fake.replies.lock().unwrap().push_back(json!({ "reply": "LGTM" }));
    let mut wf = review_workflow(json!({ "prCheckout": false }));
    wf["steps"][0]["args"] = json!("42 --strict");
    let wf = engine.create(&wf).await.unwrap();
    let run = engine.run(wf["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(run["status"], "success", "{run}");
    let text = fake.turns.lock().unwrap()[0]["text"].as_str().unwrap().to_string();
    assert!(text.contains("Review PR 42 --strict with /plugins/nyaa/1.0.0/skills/nyaa/references/rules.md."), "{text}");
    assert!(!text.contains("$ARGUMENTS") && !text.contains("${CLAUDE_PLUGIN_ROOT}"), "{text}");
    let last = saves(&fake).last().cloned().unwrap();
    assert_eq!(last["allowedTools"], json!(["Bash(gh:*)", "Bash(git:*)", "Bash(pnpm:*)", "Read", "Grep", "Glob"]));
    assert_eq!(last["readOnlyFolders"], json!(["/plugins/nyaa/1.0.0"]));
    // A step that lists its own tools narrows the skill's.
    let mut wf2 = review_workflow(json!({ "prCheckout": false, "name": "Narrow" }));
    wf2["steps"][0]["allowedTools"] = json!(["Read"]);
    let wf2 = engine.create(&wf2).await.unwrap();
    fake.replies.lock().unwrap().push_back(json!({ "reply": "ok" }));
    engine.run(wf2["id"].as_str().unwrap()).await.unwrap();
    assert_eq!(saves(&fake).last().unwrap()["allowedTools"], json!(["Read"]));
    // No match names the skill it looked for.
    let wf3 = engine
        .create(&json!({ "name": "Missing", "providerId": "local", "modelId": "m",
            "steps": [{ "id": "s", "name": "s", "kind": "skill", "run": "nope:x" }] }))
        .await
        .unwrap();
    let run = engine.run(wf3["id"].as_str().unwrap()).await.unwrap();
    assert!(run["message"].as_str().unwrap().contains("No skill matches \"nope:x\""), "{run}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_trusted_pr_is_reviewed_in_its_own_checkout_which_is_removed_after() {
    let (engine, fake, dir) = engine_with("pr-trusted", local_settings());
    fake.replies.lock().unwrap().push_back(json!({ "reply": "verdict" }));
    engine.create(&review_workflow(json!({}))).await.unwrap();
    let runs = engine.dispatch_event(&pr_event("MEMBER", false)).await;
    assert_eq!(runs[0]["status"], "success", "{runs:?}");
    let checkouts = fake.checkouts.lock().unwrap().clone();
    assert_eq!(checkouts, vec![json!(["/work", "42", runs[0]["id"]])]);
    let first = saves(&fake)[0].clone();
    assert_eq!(first["gitIsolation"], true);
    assert_eq!(first["gitWorktrees"]["w"]["path"], json!(format!("/checkouts/{}", runs[0]["id"].as_str().unwrap())));
    // Trusted: the skill's tools as they are, package managers included.
    let text = fake.turns.lock().unwrap()[0]["text"].as_str().unwrap().to_string();
    assert!(text.contains("Review PR 42 with"), "{text}");
    assert!(!text.contains("untrusted"), "{text}");
    assert!(saves(&fake).iter().any(|f| f["allowedTools"].to_string().contains("pnpm")));
    assert_eq!(fake.removed.lock().unwrap().len(), 1);
    assert_eq!(saves(&fake).last().unwrap()["gitWorktrees"], json!({}));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_untrusted_pr_never_gets_tools_that_run_its_code() {
    for (name, event, access) in [
        ("fork", pr_event("MEMBER", true), "allowlist"),
        ("outsider", pr_event("CONTRIBUTOR", false), "allowlist"),
        ("workspace-access", pr_event("NONE", false), "workspace"),
    ] {
        let (engine, fake, dir) = engine_with(&format!("pr-untrusted-{name}"), local_settings());
        fake.replies.lock().unwrap().push_back(json!({ "reply": "lint/audit skipped: untrusted PR" }));
        engine.create(&review_workflow(json!({ "toolAccess": access }))).await.unwrap();
        let runs = engine.dispatch_event(&event).await;
        assert_eq!(runs[0]["status"], "success", "{name}: {runs:?}");
        let all = saves(&fake);
        // From the chat's first save on, nothing but reads.
        assert_eq!(all[0]["toolAccess"], "allowlist", "{name}");
        let step = all.iter().rev().find(|f| f.get("readOnlyFolders").is_some()).unwrap();
        assert_eq!(step["toolAccess"], "allowlist", "{name}");
        assert_eq!(step["allowedTools"], json!(["Bash(gh:*)", "Bash(git:*)", "Read", "Grep", "Glob"]), "{name}");
        let off: Vec<&str> = step["disabledTools"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(off.contains(&"write_file") && !off.contains(&"bash"), "{name}: {off:?}");
        let text = fake.turns.lock().unwrap()[0]["text"].as_str().unwrap().to_string();
        assert!(text.contains("lint/audit skipped: untrusted PR"), "{name}: {text}");
        assert_eq!(fake.removed.lock().unwrap().len(), 1, "{name}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tokio::test]
async fn the_checkout_is_removed_when_the_run_fails_or_is_cancelled() {
    let (engine, fake, dir) = engine_with("pr-fail", local_settings());
    *fake.engine.lock().unwrap() = Some(Arc::downgrade(&engine));
    engine.create(&review_workflow(json!({}))).await.unwrap();
    fake.replies.lock().unwrap().push_back(json!({ "throws": "model down" }));
    let runs = engine.dispatch_event(&pr_event("OWNER", false)).await;
    assert_eq!(runs[0]["status"], "failure");
    assert_eq!(fake.removed.lock().unwrap().len(), 1);
    fake.replies.lock().unwrap().push_back(json!({ "cancel": true, "reply": "" }));
    let runs = engine.dispatch_event(&pr_event("OWNER", false)).await;
    assert_eq!(runs[0]["status"], "cancelled");
    assert_eq!(fake.removed.lock().unwrap().len(), 2);
    // A checkout that cannot be made fails the run before any turn.
    *fake.checkout_error.lock().unwrap() = Some("no such ref".into());
    let turns = fake.turns.lock().unwrap().len();
    let runs = engine.dispatch_event(&pr_event("OWNER", false)).await;
    assert_eq!(runs[0]["status"], "failure");
    assert!(runs[0]["message"].as_str().unwrap().contains("could not check out PR #42: no such ref"), "{runs:?}");
    assert_eq!(fake.turns.lock().unwrap().len(), turns);
    assert_eq!(fake.removed.lock().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn without_pr_checkout_a_pr_run_uses_the_workspace_as_before() {
    let (engine, fake, dir) = engine_with("pr-off", local_settings());
    fake.replies.lock().unwrap().push_back(json!({ "reply": "ok" }));
    engine.create(&review_workflow(json!({ "prCheckout": false }))).await.unwrap();
    let runs = engine.dispatch_event(&pr_event("NONE", true)).await;
    assert_eq!(runs[0]["status"], "success");
    assert!(fake.checkouts.lock().unwrap().is_empty());
    assert!(saves(&fake)[0].get("gitWorktrees").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_local_schedule_waits_for_idle_and_an_event_never_waits() {
    let (engine, fake, dir) = engine_with("idle-gate", local_settings());
    fake.replies.lock().unwrap().extend([json!({ "reply": "one" }), json!({ "reply": "two" })]);
    *fake.activity.lock().unwrap() = Some(json!({ "userActive": true, "strain": [] }));
    let wf = engine
        .create(&json!({ "name": "Nightly", "providerId": "local", "modelId": "m",
            "triggers": [{ "id": "s", "kind": "schedule", "intervalMs": 60_000 },
                { "id": "c", "kind": "connector", "connector": "github", "event": "pr_opened" }],
            "steps": [prompt_step("a", json!({}))] }))
        .await
        .unwrap();
    let id = wf["id"].as_str().unwrap();
    assert!(engine.dispatch_scheduled(id).await.is_none(), "held while the user is active");
    assert!(fake.turns.lock().unwrap().is_empty());
    assert_eq!(engine.list()[0]["waitingSince"], json!(1000));

    // An event is not something to drop: it runs at once, beside the user.
    let runs = engine.dispatch_event(&pr_event("MEMBER", false)).await;
    assert_eq!(runs[0]["status"], "success", "{runs:?}");
    assert_eq!(runs[0]["lowPriority"], json!(true));
    assert_eq!(fake.turns.lock().unwrap()[0]["background"], json!("lowPriority"));
    assert!(engine.list()[0].get("waitingSince").is_none(), "a run started: no longer waiting");

    *fake.activity.lock().unwrap() = Some(json!({ "userActive": false, "strain": [] }));
    let run = engine.dispatch_scheduled(id).await.unwrap();
    assert_eq!(run["status"], "success", "{run}");
    assert!(run.get("lowPriority").is_none(), "{run}");
    assert_eq!(fake.turns.lock().unwrap().len(), 2);
    assert_eq!(fake.turns.lock().unwrap()[1]["background"], json!("idle"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_cloud_schedule_and_a_manual_run_do_not_wait() {
    let (engine, fake, dir) = engine_with("idle-cloud", local_settings());
    *fake.activity.lock().unwrap() = Some(json!({ "userActive": true, "strain": ["hot"] }));
    let cloud = engine
        .create(&json!({ "name": "Cloud", "triggers": [{ "id": "s", "kind": "schedule", "intervalMs": 60_000 }],
            "steps": [prompt_step("a", json!({}))] }))
        .await
        .unwrap();
    assert!(engine.dispatch_scheduled(cloud["id"].as_str().unwrap()).await.is_some(), "the default is cloud");
    let local = engine
        .create(
            &json!({ "name": "Local", "providerId": "local", "modelId": "m", "steps": [prompt_step("a", json!({}))] }),
        )
        .await
        .unwrap();
    assert!(engine.run(local["id"].as_str().unwrap()).await.is_some(), "a person asked");
    assert_eq!(fake.turns.lock().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}
