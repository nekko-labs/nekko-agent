//! Claude Agent chats end to end: the real `nekkod`, with this test binary
//! re-run as a fake `claude` (behind a `.cmd` / sh wrapper on a PATH that
//! holds nothing else of the user's), so the dispatch, the saved transcript
//! and session id, the approval bridge and Stop are exercised without ever
//! starting the real Claude Code or touching anyone's sign-in.

use crate::common::*;
use std::io::Write;
use std::path::{Path, PathBuf};

const FAKE_CLAUDE: &str = "NEKKOD_TEST_FAKE_CLAUDE";

/// Not a test of its own: with the env var set, this process is `claude -p`.
pub fn fake_claude() {
    if std::env::var(FAKE_CLAUDE).is_err() {
        return;
    }
    let args = split_args(&std::env::var("FAKE_CLAUDE_ARGS").unwrap_or_default());
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let session = flag("--session-id").or_else(|| flag("--resume")).unwrap_or_default();
    // Which Claude Code folder each launch ran on, and whether it resumed.
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from) {
        let _ = std::fs::create_dir_all(&dir);
        let how = if flag("--resume").is_some() { "resume" } else { "new" };
        let mut log =
            std::fs::OpenOptions::new().create(true).append(true).open(dir.join("fake-launches.log")).unwrap();
        let _ = writeln!(log, "{how} {session}");
    }
    let (token, url) = flag("--mcp-config")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|c| {
            let server = &c["mcpServers"]["nekko_bridge"];
            let a = &server["args"];
            let at = |name: &str| {
                a.as_array()
                    .and_then(|v| v.iter().position(|x| x == name))
                    .and_then(|i| a[i + 1].as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            (server["env"]["NEKKO_BRIDGE_TOKEN"].as_str().unwrap_or_default().to_string(), at("--url"))
        })
        .unwrap_or_default();
    let down = token.is_empty() || std::env::var("NEKKOD_TEST_BRIDGE_DOWN").is_ok();
    let bridge = if down { "failed" } else { "connected" };
    // libtest has printed "test fake_claude ... " with no newline: end that line first.
    println!();
    let out = |v: Value| {
        let mut o = std::io::stdout().lock();
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    };
    let result = |text: &str, reason: &str| {
        json!({
            "type": "result", "subtype": if reason == "completed" { "success" } else { "error_during_execution" },
            "is_error": reason != "completed", "terminal_reason": reason, "session_id": session,
            "num_turns": 1, "total_cost_usd": 0.01, "result": text,
            "usage": { "input_tokens": 3, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
            "modelUsage": { "claude-opus-5-5": { "inputTokens": 3, "outputTokens": 5, "contextWindow": 1_000_000 } },
        })
    };
    // Each call reports what it sent: Claude Code's ~20k of system prompt and tools plus the turn.
    let usage = json!({ "input_tokens": 2, "cache_read_input_tokens": 20_000, "cache_creation_input_tokens": 1_000, "output_tokens": 5 });
    let assistant = |id: &str, content: Value| json!({ "type": "assistant", "message": { "id": id, "role": "assistant", "content": content, "usage": usage }, "parent_tool_use_id": null, "session_id": session });
    let rt = tokio::runtime::Runtime::new().unwrap();
    // A permission prompt through the bridge, as Claude Code asks it.
    let ask = |id: &str| -> Value {
        rt.block_on(async {
            reqwest::Client::new()
                .post(format!("{url}/harness/approve"))
                .bearer_auth(&token)
                .json(&json!({ "tool_name": "Bash", "input": { "command": "rm -rf build" }, "tool_use_id": id }))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap()
        })
    };
    let init = || {
        json!({
            "type": "system", "subtype": "init", "session_id": session, "model": "claude-opus-5-5",
            "mcp_servers": [{ "name": "nekko_bridge", "status": bridge }], "claude_code_version": "2.1.303",
            "apiKeySource": "ANTHROPIC_API_KEY", "cwd": std::env::current_dir().unwrap().to_string_lossy(),
        })
    };
    let replay = args.iter().any(|a| a == "--replay-user-messages");
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    while let Some(Ok(line)) = lines.next() {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if msg["type"] == "control_request" {
            out(
                json!({ "type": "control_response", "response": { "subtype": "success", "request_id": msg["request_id"], "response": {} } }),
            );
            continue;
        }
        let text = msg["message"]["content"].as_str().unwrap_or_default().to_string();
        let lifecycle =
            |state: &str| json!({ "type": "command_lifecycle", "command_uuid": msg["uuid"], "state": state });
        if replay && msg["uuid"].is_string() {
            out(lifecycle("queued"));
            out(lifecycle("started"));
        }
        out(init());
        if text == "background" {
            // Start a background command, end the turn, then wake when it
            // finishes, with nothing written: a turn of Claude Code's own
            // whose command needs a person to approve it.
            out(assistant("m_bg", json!([{ "type": "text", "text": "started" }])));
            out(result("started", "completed"));
            out(json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [{ "task_id": "b1" }] }));
            std::thread::sleep(std::time::Duration::from_millis(300));
            out(
                json!({ "type": "system", "subtype": "task_updated", "task_id": "b1", "patch": { "status": "completed" } }),
            );
            out(json!({ "type": "system", "subtype": "task_notification", "task_id": "b1", "status": "completed" }));
            out(json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [] }));
            out(init());
            out(assistant(
                "m_w1",
                json!([{ "type": "tool_use", "id": "toolu_wake", "name": "Bash", "input": { "command": "rm -rf build" } }]),
            ));
            let decision = ask("toolu_wake");
            let allowed = decision["behavior"] == "allow";
            out(json!({ "type": "user", "message": { "role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "toolu_wake",
                "content": if allowed { "removed" } else { "denied" }, "is_error": !allowed,
            }] }, "parent_tool_use_id": null }));
            let reply = format!("woke: {}", decision["behavior"].as_str().unwrap_or("?"));
            out(assistant("m_w2", json!([{ "type": "text", "text": reply }])));
            out(result(&reply, "completed"));
        } else if text == "run rm" {
            // A prompt only a person may answer in guardrails mode, through the bridge.
            out(assistant(
                "m1",
                json!([{ "type": "tool_use", "id": "toolu_rm", "name": "Bash", "input": { "command": "rm -rf build" } }]),
            ));
            let decision = ask("toolu_rm");
            let allowed = decision["behavior"] == "allow";
            out(json!({ "type": "user", "message": { "role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "toolu_rm",
                "content": if allowed { "removed" } else { "denied" }, "is_error": !allowed,
            }] }, "parent_tool_use_id": null }));
            let reply = format!("done: {}", decision["behavior"].as_str().unwrap_or("?"));
            out(assistant("m2", json!([{ "type": "text", "text": reply }])));
            out(result(&reply, "completed"));
        } else if text == "hang" {
            out(
                json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "id": "m_h" } }, "parent_tool_use_id": null }),
            );
            out(
                json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "1\n2" } }, "parent_tool_use_id": null }),
            );
            // Until the interrupt arrives.
            for line in lines.by_ref() {
                let Ok(m) = serde_json::from_str::<Value>(&line.unwrap_or_default()) else { continue };
                if m["type"] == "control_request" {
                    out(
                        json!({ "type": "control_response", "response": { "subtype": "success", "request_id": m["request_id"], "response": { "still_queued": [] } } }),
                    );
                    break;
                }
            }
            out(
                json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "[Request interrupted by user]" }] }, "parent_tool_use_id": null }),
            );
            out(result("", "aborted_streaming"));
        } else {
            let reply = format!("echo {}: {text}", std::process::id());
            out(assistant("m_e", json!([{ "type": "text", "text": reply }])));
            out(result(&reply, "completed"));
        }
    }
}

/// `%*` / `$*` back into arguments (paths here have no spaces or quotes).
fn split_args(s: &str) -> Vec<String> {
    s.split_whitespace().map(|a| a.trim_matches('"').to_string()).collect()
}

/// A folder with only a fake `claude` (and, with `cli`, a fake `nekko-agent`
/// for the bridge command to find), and the PATH to run nekkod with.
fn fake_bin(name: &str, cli: bool) -> (PathBuf, String) {
    let dir = std::env::temp_dir().join(format!("nekkod-fake-claude-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let exe = std::env::current_exe().unwrap();
    let exe = exe.to_string_lossy();
    let libtest = "--exact fake_claude --nocapture --test-threads=1";
    if cfg!(windows) {
        let script = format!(
            "@echo off\r\nif \"%~1\"==\"--version\" goto version\r\nset {FAKE_CLAUDE}=1\r\nset \"FAKE_CLAUDE_ARGS=%*\"\r\n\"{exe}\" {libtest}\r\nexit /b %errorlevel%\r\n:version\r\necho 2.1.284 (Claude Code)\r\n"
        );
        std::fs::write(dir.join("claude.cmd"), script).unwrap();
        if cli {
            std::fs::write(dir.join("nekko-agent.cmd"), "@exit /b 1\r\n").unwrap();
        }
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        (dir.clone(), format!("{};{system}\\System32;{system}", dir.display()))
    } else {
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"2.1.284 (Claude Code)\"; exit 0; fi\n{FAKE_CLAUDE}=1 FAKE_CLAUDE_ARGS=\"$*\" exec \"{exe}\" {libtest}\n"
        );
        write_exec(&dir.join("claude"), &script);
        if cli {
            write_exec(&dir.join("nekko-agent"), "#!/bin/sh\nexit 1\n");
        }
        (dir.clone(), format!("{}:/usr/bin:/bin", dir.display()))
    }
}

#[cfg(unix)]
fn write_exec(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(not(unix))]
fn write_exec(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
}

/// A turn rig (the daemon, its data dir and its recorded events) plus the
/// fake `claude` on its PATH.
struct Rig {
    t: TurnRig,
    bin: PathBuf,
}

impl std::ops::Deref for Rig {
    type Target = TurnRig;
    fn deref(&self) -> &TurnRig {
        &self.t
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        // The daemon first, so nothing still runs from the fake's folder.
        let _ = self.t.d.child.kill();
        let _ = self.t.d.child.wait();
        let _ = std::fs::remove_dir_all(&self.bin);
    }
}

fn rig(name: &str, mode: &str, cli: bool) -> Rig {
    rig_env(name, mode, cli, &[])
}

fn rig_env(name: &str, mode: &str, cli: bool, extra: &[(&str, Option<&str>)]) -> Rig {
    let data = std::env::temp_dir().join(format!("nekkod-cc-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let session = json!({ "id": "s_cc", "title": "cc", "messages": [], "mode": mode, "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_cc.json"), session.to_string()).unwrap();
    let (bin, path) = fake_bin(name, cli);
    // An isolated config dir as well: if anything ever ran a real `claude`, it would be signed out.
    let config = data.join("claude-config").to_string_lossy().into_owned();
    let mut env: Vec<(&str, Option<&str>)> =
        vec![("PATH", Some(&path)), ("CLAUDE_CONFIG_DIR", Some(&config)), ("ANTHROPIC_API_KEY", None)];
    env.extend_from_slice(extra);
    let d = start_with_env(&data, json!({}), &env);
    let events = record_events(d.port);
    Rig { t: TurnRig { data, workspace, d, events }, bin }
}

fn spec(rig: &Rig, turn_id: &str, text: &str) -> Value {
    let provider =
        json!({ "id": "cc", "kind": "claude-code", "label": "Claude Agent", "baseUrl": "", "enabled": true });
    spec_on(rig, turn_id, text, provider)
}

fn spec_on(rig: &Rig, turn_id: &str, text: &str, provider: Value) -> Value {
    json!({
        "turnId": turn_id,
        "opts": { "sessionId": "s_cc", "providerId": provider["id"], "modelId": "opus", "text": text },
        "allowBrowserControl": false,
        "settings": { "providers": [provider], "defaultChatMode": "guardrails", "unattendedQuestionMinutes": 0 },
        "facts": {
            "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
            "decide": false, "hooks": false, "connectorSnippets": [], "indexSnippets": [],
            "platform": std::env::consts::OS, "provider": provider, "headers": false,
        },
    })
}

fn saved(rig: &Rig) -> Value {
    serde_json::from_str(&std::fs::read_to_string(rig.data.join("sessions/s_cc.json")).unwrap()).unwrap()
}

fn kinds(events: &[Value]) -> Vec<String> {
    events.iter().filter_map(|e| e["type"].as_str().map(str::to_string)).collect()
}

fn assistant_texts(session: &Value) -> Vec<String> {
    session["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "assistant")
        .filter_map(|m| m["content"].as_str().map(str::to_string))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_turns_on_one_claude_code_process_and_keeps_its_session() {
    let rig = rig("plain", "guardrails", true);
    let (status, body) = post(rig.d.port, "chat:turn", json!([spec(&rig, "cc1", "hello")]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    let (events, end) = turn_record(&rig, "cc1", "s_cc").await;
    assert_eq!(end["aborted"], false, "{end}");
    let k = kinds(&events);
    assert!(k.ends_with(&["usage".into(), "done".into()]), "{k:?}");
    let first = saved(&rig);
    let session_id = first["claudeCodeSessionId"].as_str().expect("the session id is saved").to_string();
    assert_eq!(session_id.len(), 36);
    let replies = assistant_texts(&first);
    assert_eq!(replies.len(), 1);
    assert!(replies[0].ends_with(": hello"), "{replies:?}");
    assert!(first["messages"].as_array().unwrap().last().unwrap()["turnStats"].is_object());
    // What the context gauge shows: Claude Code's own figures, not Nekko's transcript estimate.
    assert_eq!(
        first["claudeCodeContext"],
        json!({ "used": 21_002, "window": 1_000_000, "model": "claude-opus-5-5", "modelId": "opus" })
    );

    // The second turn reuses the same child (same pid) and the same Claude Code session.
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "cc2", "again")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    turn_record(&rig, "cc2", "s_cc").await;
    let second = saved(&rig);
    assert_eq!(second["claudeCodeSessionId"], session_id.as_str());
    let replies = assistant_texts(&second);
    let pid = |r: &str| r.split(':').next().unwrap().to_string();
    assert_eq!(pid(&replies[0]), pid(&replies[1]), "{replies:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_prompts_reach_nekko_approvals() {
    let rig = rig("approve", "guardrails", true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "ccA", "run rm")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let approval = wait_pending(rig.d.port, "s_cc", "approval", "toolu_rm").await;
    assert_eq!(approval["call"]["name"], "Bash");
    assert_eq!(approval["call"]["executedBy"], "claude-code");
    assert_eq!(approval["severity"], "high");
    let (status, body) = post(rig.d.port, "tool:approve", json!(["s_cc", "toolu_rm", true]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    let (events, end) = turn_record(&rig, "ccA", "s_cc").await;
    assert_eq!(end["aborted"], false);
    let k = kinds(&events);
    for kind in ["tool_call", "tool_approval_required", "step", "tool_result", "done"] {
        assert!(k.contains(&kind.to_string()), "{kind} in {k:?}");
    }
    let s = saved(&rig);
    assert_eq!(assistant_texts(&s).last().unwrap(), "done: allow");
    let tool = s["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
    assert_eq!(tool["toolResult"]["output"], "removed");

    // The daemon's own token is not a bridge token, and a browser may not call it.
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/harness/approve", rig.d.port);
    let res = client.post(&url).bearer_auth(TOKEN).json(&json!({})).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 401);
    let res = client.post(&url).bearer_auth("x").header("Origin", "null").json(&json!({})).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_interrupts_claude_code_and_keeps_the_partial_reply() {
    let rig = rig("stop", "guardrails", true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "ccS", "hang")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    until("the reply to start streaming", Duration::from_secs(30), || async {
        let streamed = rig.events.lock().unwrap().iter().any(|e| e["sessionId"] == "s_cc" && e["type"] == "text");
        streamed.then_some(())
    })
    .await;
    let (status, body) = post(rig.d.port, "chat:abort", json!(["s_cc"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    let (events, end) = turn_record(&rig, "ccS", "s_cc").await;
    assert_eq!(end["aborted"], true, "{end}");
    let all = &events;
    assert_eq!(all.last().unwrap()["message"], "Stopped", "{all:?}");
    let s = saved(&rig);
    let last = s["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["interrupted"], true, "{last}");
    assert!(last["content"].as_str().unwrap().starts_with("1\n2"));
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_bridge_claude_code_never_starts() {
    let rig = rig("nobridge", "guardrails", false);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "ccN", "hello")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (events, _) = turn_record(&rig, "ccN", "s_cc").await;
    let all = &events;
    let error = all.iter().find(|e| e["type"] == "error").expect("an error");
    assert!(error["message"].as_str().unwrap().contains("approval bridge"), "{error}");
    assert!(assistant_texts(&saved(&rig)).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bridge_that_does_not_connect_stops_claude_code_before_it_acts() {
    let rig = rig_env("bridgedown", "guardrails", true, &[("NEKKOD_TEST_BRIDGE_DOWN", Some("1"))]);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "ccD", "run rm")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (events, _) = turn_record(&rig, "ccD", "s_cc").await;
    let all = &events;
    let k: Vec<&str> = all.iter().filter_map(|e| e["type"].as_str()).collect();
    assert!(!k.contains(&"tool_call"), "nothing ran: {k:?}");
    let error = all.iter().find(|e| e["type"] == "error").expect("an error");
    assert!(error["message"].as_str().unwrap().contains("did not connect"), "{error}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wake_up_after_the_turn_is_a_turn_its_prompts_can_wait_in() {
    let rig = rig("wake", "guardrails", true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "ccW", "background")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    turn_record(&rig, "ccW", "s_cc").await;

    // The background command finished and Claude Code went on by itself: its
    // prompt waits for the user instead of being refused, and the chat runs.
    let approval = wait_pending(rig.d.port, "s_cc", "approval", "toolu_wake").await;
    assert_eq!(approval["call"]["executedBy"], "claude-code");
    let (_, running) = post(rig.d.port, "chat:running", json!([]), Some(TOKEN)).await;
    assert_eq!(running, json!(["s_cc"]));
    let (status, body) = post(rig.d.port, "tool:approve", json!(["s_cc", "toolu_wake", true]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    until("the wake-up turn to end", Duration::from_secs(30), || async {
        let (_, running) = post(rig.d.port, "chat:running", json!([]), Some(TOKEN)).await;
        let s = saved(&rig);
        let last = assistant_texts(&s).last().cloned();
        (running == json!([]) && s.get("activeRun").is_none() && last.as_deref() == Some("woke: allow")).then_some(())
    })
    .await;
    let s = saved(&rig);
    let users = s["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "user").count();
    assert_eq!(users, 1, "a wake-up adds no user message");
    let events: Vec<Value> = rig.events.lock().unwrap().iter().filter(|e| e["sessionId"] == "s_cc").cloned().collect();
    assert_eq!(kinds(&events).iter().filter(|k| *k == "done").count(), 2, "{:?}", kinds(&events));

    // The next message is answered by its own reply, not one behind.
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "ccW2", "again")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    turn_record(&rig, "ccW2", "s_cc").await;
    let replies = assistant_texts(&saved(&rig));
    assert!(replies.last().unwrap().ends_with(": again"), "{replies:?}");
}

/// A Claude Agent on a second Claude Code account runs with that account's
/// folder, and a chat that switches account starts a new Claude Code session
/// there instead of resuming one from the other account's folder.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_account_runs_in_its_own_folder_and_a_switch_starts_afresh() {
    let home = std::env::temp_dir().join(format!("nekkod-cc-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let h = home.to_string_lossy().into_owned();
    let rig = rig_env("account", "guardrails", true, &[("HOME", Some(&h)), ("USERPROFILE", Some(&h))]);
    let launches = |dir: &Path| std::fs::read_to_string(dir.join("fake-launches.log")).unwrap_or_default();
    let default_dir = rig.data.join("claude-config");
    let work_dir = home.join(".claude-work");
    let work = json!({ "id": "cc-work", "kind": "claude-code", "label": "Claude Agent · Work", "baseUrl": "", "enabled": true, "claudeCode": { "account": "work" } });

    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "a1", "hello")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    turn_record(&rig, "a1", "s_cc").await;
    let first = saved(&rig);
    let s1 = first["claudeCodeSessionId"].as_str().unwrap().to_string();
    assert!(first.get("claudeCodeAccount").is_none(), "{first}");
    assert_eq!(launches(&default_dir), format!("new {s1}\n"));

    let (status, _) =
        post(rig.d.port, "chat:turn", json!([spec_on(&rig, "a2", "switched", work.clone())]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    turn_record(&rig, "a2", "s_cc").await;
    let second = saved(&rig);
    let s2 = second["claudeCodeSessionId"].as_str().unwrap().to_string();
    assert_ne!(s1, s2, "a session from the other account is never resumed");
    assert_eq!(second["claudeCodeAccount"], "work");
    assert_eq!(launches(&work_dir), format!("new {s2}\n"));

    // Back on the default login: again a new session, in the default folder.
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec(&rig, "a3", "back")]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    turn_record(&rig, "a3", "s_cc").await;
    let third = saved(&rig);
    assert!(third.get("claudeCodeAccount").is_none(), "{third}");
    let log = launches(&default_dir);
    assert_eq!(log.lines().count(), 2, "{log}");
    assert!(log.lines().all(|l| l.starts_with("new ")), "{log}");
    drop(rig);
    let _ = std::fs::remove_dir_all(&home);
}
