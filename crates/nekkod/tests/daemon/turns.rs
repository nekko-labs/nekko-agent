//! The real `nekkod` binary end to end: turns the daemon admits and drives: streaming, approvals, stops, queues, titles, accounting and compaction.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn large_image_reply_completes_and_followup_starts_with_local_provider() {
    use axum::routing::post as route_post;

    // The only model endpoint is this ephemeral loopback listener. No provider
    // credentials, user files, external service, or paid model are involved.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_port = listener.local_addr().unwrap().port();
    let provider = axum::Router::new()
        .route(
            "/v1/chat/completions",
            route_post(|axum::Json(request): axum::Json<Value>| async move {
                let messages = request["messages"].as_array().unwrap();
                let image = messages
                    .iter()
                    .find_map(|m| m["content"].as_array()?.iter().find_map(|part| part["image_url"]["url"].as_str()));
                let Some(url) = image else {
                    return (axum::http::StatusCode::BAD_REQUEST, "missing synthetic image".to_string());
                };
                if request["model"] != "synthetic"
                    || url != format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024))
                {
                    return (axum::http::StatusCode::BAD_REQUEST, "invalid synthetic image".to_string());
                }
                let answer = if messages.last().is_some_and(|m| m["content"] == "followup") {
                    "synthetic-followup".to_string()
                } else if messages.last().is_some_and(|m| m["role"] == "user") {
                    format!("synthetic-image-{}", url.len())
                } else {
                    return (axum::http::StatusCode::BAD_REQUEST, "unexpected synthetic request".to_string());
                };
                let sse = format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    json!({ "choices": [{ "delta": { "content": answer }, "finish_reason": "stop" }] })
                );
                (axum::http::StatusCode::OK, sse)
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024));
    let server = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let session = json!({
        "id": "s_large", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("large-image", session);
    let unused = scripted_model(vec![]).await;
    let image = format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024));
    let spec_for = |turn: &str, text: &str, images: Value| {
        let mut spec = turn_spec(&rig, &unused, turn, "s_large", json!({ "text": text, "images": images }));
        let base = format!("http://127.0.0.1:{provider_port}/v1");
        spec["facts"]["provider"]["baseUrl"] = json!(base);
        spec["settings"]["providers"][0]["baseUrl"] = json!(base);
        spec
    };
    let (status, started) =
        post(rig.d.port, "chat:turn", json!([spec_for("t_large", "image", json!([image.clone()]))]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["started"], true);
    let (_, end) = turn_record(rig.d.port, "t_large").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_large");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages[0]["images"][0], image);
    assert_eq!(messages.last().unwrap()["content"], format!("synthetic-image-{}", image.len()));
    assert_ne!(messages.last().unwrap()["interrupted"], true);

    let (status, started) =
        post(rig.d.port, "chat:turn", json!([spec_for("t_next", "followup", json!([]))]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    let (_, end) = turn_record(rig.d.port, "t_next").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_large");
    let last = saved["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["content"], "synthetic-followup");
    assert_eq!(last["role"], "assistant");
    server.abort();
}

fn title_requests(model: &ScriptedModel) -> usize {
    model.requests.lock().unwrap().iter().filter(|r| r["messages"].to_string().contains("short title")).count()
}

async fn wait_for_title_requests(model: &ScriptedModel, count: usize) {
    until("the title request", Duration::from_secs(20), || async { (title_requests(model) >= count).then_some(()) })
        .await
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .flat_map(|p| p["events"].as_array().cloned().unwrap_or_default())
        .map(|e| e["type"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn chat_send_is_admitted_and_driven_by_the_daemon() {
    let session = json!({
        "id": "s_admit", "title": "New chat", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("admit", session);
    let model = scripted_model(vec![say_text("the answer")]).await;
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let settings = json!({
        "providers": [provider, { "id": "off", "kind": "openai", "label": "Off", "enabled": false, "baseUrl": "https://api.openai.com/v1" }],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();

    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("chat:send")));
    // A disabled provider is refused here, as admitTurn refuses it.
    let opts = json!({ "sessionId": "s_admit", "providerId": "off", "modelId": "m", "text": "hello" });
    let (status, _) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    // The workspace index now lives in this daemon, not in the fake host.
    let (status, indexed) = post(rig.d.port, "workspace:index", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{indexed}");
    assert_eq!(indexed["state"], "ready");

    // The whole chain runs before chat:send answers, as sendChat resolved.
    let opts =
        json!({ "sessionId": "s_admit", "providerId": "p1", "modelId": "synthetic", "text": "Explain the pineapple" });
    let (status, body) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null));
    let saved = saved_session(&rig, "s_admit");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages.first().unwrap()["content"], "Explain the pineapple");
    assert_eq!(messages.last().unwrap()["content"], "the answer");

    let calls = until_adopted(rig.d.port, 1).await;
    let adopt = calls.iter().find(|c| c[0] == "turn:adopt").expect("the host was handed the turn");
    let turn_id = adopt[1][0]["turnId"].as_str().unwrap().to_string();
    assert!(turn_id.starts_with("turn_d"), "{turn_id}");
    assert_eq!(adopt[1][0]["workspaces"][0]["id"], "w1");
    assert!(calls.iter().any(|c| c[0] == "turn:end" && c[1][0] == turn_id.as_str()));
    assert!(!calls.iter().any(|c| c[0] == "chat:indexSnippets"), "the daemon gathers its own index snippets");
    assert!(!calls.iter().any(|c| c[0] == "chat:connectorSnippets"), "no connector is connected");
    // The snippets and the guidelines reached the model.
    let requests = model.requests.lock().unwrap().clone();
    let system = requests[0]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(system.contains("Always run the tests."), "{system}");
    assert!(system.contains("1: export const secret = 'pineapple';"), "{system}");
}

/// A model reply of `n` text chunks (`word0 word1 ...`), then a stop.
fn slow_text(word: &str, n: usize) -> String {
    let mut chunks: Vec<Value> = (0..n)
        .map(|i| json!({ "choices": [{ "delta": { "content": format!("{word}{i} ") }, "finish_reason": null }] }))
        .collect();
    chunks.push(json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 10, "completion_tokens": n } }));
    sse(&chunks)
}

/// Everything a socket receives until both chats' `done`, as (channel, payload).
async fn collect_until_done(socket: &mut Socket, sessions: &[&str]) -> Vec<(String, Value)> {
    let mut seen = Vec::new();
    let mut done = std::collections::HashSet::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    while done.len() < sessions.len() {
        let Some(frame) = next_json(socket, deadline.saturating_duration_since(Instant::now())).await else {
            panic!("socket went quiet; done for {done:?}, saw {}", seen.len())
        };
        let Some(channel) = frame["channel"].as_str() else { continue };
        let payload = frame["payload"].clone();
        if channel == "agent:event" && payload["type"] == "done" {
            done.insert(payload["sessionId"].as_str().unwrap_or_default().to_string());
        }
        seen.push((channel.to_string(), payload));
    }
    seen
}

/// The next frame about a chat or a request, past the backend's own chatter:
/// the fake backend greets every socket every 100 ms with a session-less
/// `hello-from-backend`, and a socket may hear `daemon:backend` when the
/// backend comes up. Either can land between any two frames a test expects.
async fn next_chat_frame(socket: &mut Socket) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let f = next_json(socket, deadline.saturating_duration_since(Instant::now())).await.expect("a frame");
        let hello = f["channel"] == "agent:event"
            && f["payload"]["type"] == "hello-from-backend"
            && f["payload"]["sessionId"].is_null();
        if !hello && f["channel"] != "daemon:backend" {
            return f;
        }
    }
}

fn streamed_text(frames: &[(String, Value)], session: &str) -> String {
    let mut out = String::new();
    for (channel, p) in frames {
        if channel == "agent:replay" && p["sessionId"] == session {
            for e in p["events"].as_array().unwrap() {
                if e["type"] == "text" {
                    out.push_str(e["delta"].as_str().unwrap());
                }
            }
        } else if channel == "agent:event" && p["sessionId"] == session && p["type"] == "text" {
            out.push_str(p["delta"].as_str().unwrap());
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn sockets_take_only_the_chats_they_subscribe_to_and_the_host_only_how_turns_end() {
    let chat = |id: &str| json!({ "id": id, "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("subscribe", chat("s_one"));
    std::fs::write(rig.data.join("sessions").join("s_two.json"), chat("s_two").to_string()).unwrap();
    // Each reply is 40 chunks, so 40 text events per chat, interleaved.
    let model = scripted_model(vec![slow_text("one", 40), slow_text("two", 40)]).await;
    let port = rig.d.port;

    // Socket A takes s_one's stream (daemon:subscribe), B s_two's (?sessions=),
    // C every chat (no subscription, as before).
    let mut a = ws(port, &format!("/api/ws?token={TOKEN}"), None).await.unwrap();
    a.send(Message::Text(json!({ "id": 1, "channel": "daemon:subscribe", "args": [["s_one"]] }).to_string().into()))
        .await
        .unwrap();
    // The backend's own chatter may land first (`next_chat_frame`). No chat's event may.
    let ack = next_chat_frame(&mut a).await;
    assert_eq!(
        ack,
        json!({ "id": 1, "result": true }),
        "no turn is running yet, so no chat event comes before the answer"
    );
    let mut b = ws(port, &format!("/api/ws?sessions=s_two&token={TOKEN}"), None).await.unwrap();
    let mut c = ws(port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let mut one = turn_spec(&rig, &model, "turn_one", "s_one", json!({}));
    let mut two = turn_spec(&rig, &model, "turn_two", "s_two", json!({}));
    // As a host whose relay, messaging and accounting are the daemon's asks.
    one["facts"]["hostEvents"] = json!(["done", "error"]);
    two["facts"]["hostEvents"] = json!(["done", "error"]);
    let (s1, _) = post(port, "chat:turn", json!([one]), Some(TOKEN)).await;
    let (s2, _) = post(port, "chat:turn", json!([two]), Some(TOKEN)).await;
    assert_eq!((s1, s2), (200, 200));

    let (fa, fb, fc) = tokio::join!(
        collect_until_done(&mut a, &["s_one", "s_two"]),
        collect_until_done(&mut b, &["s_one", "s_two"]),
        collect_until_done(&mut c, &["s_one", "s_two"]),
    );
    let words = |w: &str| (0..40).map(|i| format!("{w}{i} ")).collect::<String>();
    // The model answers in the order the turns reach it, which the two posts
    // above don't fix: each chat gets one of the two replies, whole.
    let (c_one, c_two) = (streamed_text(&fc, "s_one"), streamed_text(&fc, "s_two"));
    let mut got = [c_one.clone(), c_two.clone()];
    got.sort();
    assert_eq!(got, [words("one"), words("two")]);
    // Every socket has its own chat's whole reply, once.
    assert_eq!(streamed_text(&fa, "s_one"), c_one);
    assert_eq!(streamed_text(&fb, "s_two"), c_two);
    // Of the other chat a subscribed socket hears the turn start and end,
    // and none of its stream after the first event.
    let of = |frames: &[(String, Value)], s: &str| -> Vec<String> {
        frames
            .iter()
            .filter(|(ch, p)| ch == "agent:event" && p["sessionId"] == s)
            .map(|(_, p)| p["type"].as_str().unwrap().to_string())
            .collect()
    };
    let other_a = of(&fa, "s_two");
    let other_b = of(&fb, "s_one");
    assert!(other_a.first().is_some_and(|t| t != "done") && other_a.last().is_some_and(|t| t == "done"), "{other_a:?}");
    assert!(other_a.len() <= 4, "a's view of s_two is a summary: {other_a:?}");
    assert!(other_b.len() <= 4, "b's view of s_one is a summary: {other_b:?}");
    let frames = |f: &[(String, Value)]| f.iter().filter(|(ch, _)| ch == "agent:event").count();
    assert!(frames(&fa) * 3 < frames(&fc) * 2, "a {} frames vs c {}", frames(&fa), frames(&fc));
    println!("agent frames per socket: subscribed a={} b={}, unsubscribed c={}", frames(&fa), frames(&fb), frames(&fc));

    // The host asked only for how the turns end.
    for turn in ["turn_one", "turn_two"] {
        let (events, _) = turn_record(port, turn).await;
        assert_eq!(event_types(&events), ["done"], "{turn}");
    }

    // A socket that starts showing a chat mid-turn is sent the turn so far.
    let model2 = scripted_model(vec![
        call_tool("c_wait", "ask_user", json!({ "questions": [{ "question": "Go?", "options": ["yes", "no"] }] })),
        say_text("went"),
    ])
    .await;
    let mut three = turn_spec(&rig, &model2, "turn_three", "s_one", json!({}));
    three["facts"]["hostEvents"] = json!(["done", "error"]);
    post(port, "chat:turn", json!([three]), Some(TOKEN)).await;
    wait_pending(port, "s_one", "question", "c_wait").await;
    // The question is pending before its event is published: wait until a
    // socket that hears every chat has it, so the replay below holds it too.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let f = next_json(&mut c, Duration::from_secs(10)).await.expect("c is still open");
            if f["channel"] == "agent:event"
                && f["payload"]["sessionId"] == "s_one"
                && f["payload"]["type"] == "question"
            {
                break;
            }
        }
    })
    .await
    .expect("the question event reached every chat's socket");
    let mut late = ws(port, &format!("/api/ws?sessions=s_two&token={TOKEN}"), None).await.unwrap();
    // Connected narrowed: told that s_one is running (its first event).
    let first = next_chat_frame(&mut late).await;
    assert_eq!(
        (first["channel"].as_str(), first["payload"]["sessionId"].as_str()),
        (Some("agent:event"), Some("s_one")),
        "{first}"
    );
    late.send(Message::Text(
        json!({ "id": 7, "channel": "daemon:subscribe", "args": [["s_one", "s_two"]] }).to_string().into(),
    ))
    .await
    .unwrap();
    let replay = next_chat_frame(&mut late).await;
    assert_eq!(replay["channel"], "agent:replay", "{replay}");
    let types: Vec<&str> =
        replay["payload"]["events"].as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert!(types.contains(&"tool_call") && types.contains(&"question"), "{types:?}");
    assert_eq!(next_chat_frame(&mut late).await, json!({ "id": 7, "result": true }));
    post(port, "chat:answer", json!(["s_one", "c_wait", [{ "questionId": "q1", "labels": ["yes"] }]]), Some(TOKEN))
        .await;
    let rest = collect_until_done(&mut late, &["s_one"]).await;
    assert!(
        rest.iter().all(|(ch, p)| ch != "agent:event" || p["type"] != "question"),
        "the question is not sent twice"
    );
    assert_eq!(streamed_text(&rest, "s_one"), "went");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_asks_runs_tools_and_saves_every_step() {
    let session = json!({
        "id": "s_turn_q", "title": "New chat", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("ask", session);
    let model = scripted_model(vec![
        call_tool(
            "c_ask",
            "ask_user",
            json!({ "questions": [{ "question": "Which bug?", "options": ["Login", "Logout"] }] }),
        ),
        call_tool("c_read", "read_file", json!({ "path": "app.ts" })),
        call_tool("c_host", "delegation_targets", json!({})),
        say_text("all done"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_q", "s_turn_q", json!({}));
    let (status, started) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["started"], true);

    // The question is the daemon's: the board sees it, and answering it there resumes the turn.
    let question = wait_pending(rig.d.port, "s_turn_q", "question", "c_ask").await;
    assert_eq!(question["questions"][0]["question"], "Which bug?");
    let (_, alive) = post(rig.d.port, "turn:alive", json!(["turn_q"]), Some(TOKEN)).await;
    assert_eq!(alive, json!(true));
    let answers = json!([{ "questionId": "q1", "labels": ["Login"] }]);
    let (status, body) = post(rig.d.port, "chat:answer", json!(["s_turn_q", "c_ask", answers]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null), "answered by the daemon, not forwarded to the host");

    let (events, end) = turn_record(rig.d.port, "turn_q").await;
    assert_eq!(end["aborted"], false, "{end}");
    assert_eq!(end["stop"], "complete", "{end}");
    let types = event_types(&events);
    for t in ["session_meta", "question", "question_resolved", "tool_call", "tool_result", "done"] {
        assert!(types.iter().any(|x| x == t), "no {t} event in {types:?}");
    }
    let done = events.iter().find(|p| p["events"][0]["type"] == "done").unwrap();
    assert_eq!(done["stats"]["calls"], 1, "only the last reply reported usage: {done}");
    assert!(done["startedAt"].is_u64());
    let (_, pending) = post(rig.d.port, "chat:pending", json!([]), Some(TOKEN)).await;
    assert_eq!(pending, json!({}), "nothing may stay pending after the turn");

    let saved = saved_session(&rig, "s_turn_q");
    // The placeholder, or the generated title once it has landed after the turn.
    let titled = (saved["title"].clone(), saved["titleAuto"].clone());
    assert!(
        titled == (json!("Fix the bug"), json!(true)) || titled == (json!("Login bug fix"), json!(false)),
        "{titled:?}"
    );
    assert_eq!(saved["providerId"], "p1");
    assert!(saved.get("activeRun").is_none(), "the run marker is cleared");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "Fix the bug");
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert!(tool_out("c_ask").contains("Q: Which bug?\nA: Login"), "{}", tool_out("c_ask"));
    assert!(tool_out("c_read").contains("pineapple"));
    assert_eq!(tool_out("c_host"), "host tool ran");
    let last = messages.last().unwrap();
    assert_eq!(last["content"], "all done");
    assert_eq!(last["turnStats"]["calls"], 1);
    assert_eq!(last["turnStats"]["providerId"], "p1");

    // What the model was sent: the composed prompt and tools.
    let first = model.requests.lock().unwrap()[0].clone();
    let system = first["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(system.contains("Asking first:"), "ask_user is offered, so the prompt says when to ask");
    assert!(system.contains(&rig.workspace.to_string_lossy().to_string()));
    assert!(system.contains("Always run the tests."), "the project's AGENTS.md is in the context block");
    let tools: Vec<String> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_string())
        .collect();
    for t in ["read_file", "ask_user", "update_plan", "set_chat_title", "complete_session"] {
        assert!(tools.contains(&t.to_string()), "{t} missing from {tools:?}");
    }
    assert!(!tools.contains(&"browser".to_string()), "no browser control was allowed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_parks_approvals_and_answers_them_itself() {
    let session = json!({
        "id": "s_turn_a", "title": "Named", "mode": "ask", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("approve", session);
    let model = scripted_model(vec![
        call_tool("c_w", "write_file", json!({ "path": "new.txt", "content": "hi" })),
        call_tool("c_slow", "ask_user", json!({ "questions": [{ "question": "Go on?", "options": ["Yes", "No"] }] })),
        say_text("wrote it"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_a", "s_turn_a", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let approval = wait_pending(rig.d.port, "s_turn_a", "approval", "c_w").await;
    assert_eq!(approval["call"]["name"], "write_file");
    assert!(!rig.workspace.join("new.txt").exists(), "nothing is written before the approval");
    let (status, body) = post(rig.d.port, "tool:approve", json!(["s_turn_a", "c_w", true]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null), "answered by the daemon, not forwarded to the host");

    // While the turn waits on its question, a host-run tool's approval parks
    // here too, and the host hears the answer.
    wait_pending(rig.d.port, "s_turn_a", "question", "c_slow").await;
    let (status, ok) = post(
        rig.d.port,
        "turn:approval",
        json!(["turn_a", { "id": "c_host_ok", "name": "start_process", "input": {} }, "Start a background process", "medium"]),
        Some(TOKEN),
    )
    .await;
    assert_eq!((status, ok), (200, json!(true)));
    let parked = wait_pending(rig.d.port, "s_turn_a", "approval", "c_host_ok").await;
    assert_eq!(parked["reason"], "Start a background process");
    let (_, body) = post(rig.d.port, "tool:approve", json!(["s_turn_a", "c_host_ok", false]), Some(TOKEN)).await;
    assert_eq!(body, Value::Null);
    let answers = json!([{ "questionId": "q1", "labels": ["Yes"] }]);
    post(rig.d.port, "chat:answer", json!(["s_turn_a", "c_slow", answers]), Some(TOKEN)).await;

    let (events, end) = turn_record(rig.d.port, "turn_a").await;
    assert_eq!(end["stop"], "complete", "{end}");
    assert_eq!(std::fs::read_to_string(rig.workspace.join("new.txt")).unwrap(), "hi");
    let types = event_types(&events);
    assert_eq!(types.iter().filter(|t| *t == "tool_approval_required").count(), 2, "{types:?}");
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let answered =
        all.as_array().unwrap().iter().any(|e| e[0] == "turn:approved" && e[1] == json!(["c_host_ok", false]));
    assert!(answered, "the host heard its approval was refused");
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_a_daemon_turn_ends_it_and_clears_the_run_marker() {
    let session = json!({
        "id": "s_turn_s", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("stop", session);
    let model = scripted_model(vec![HANG.to_string()]).await;
    let spec = turn_spec(&rig, &model, "turn_s", "s_turn_s", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    until_model_asked(&model, 1, "the model to be asked", Duration::from_secs(20)).await;
    let saved = saved_session(&rig, "s_turn_s");
    assert!(saved["activeRun"]["startedAt"].is_u64(), "the run marker is on disk while the turn runs");
    let (_, running) = post(rig.d.port, "chat:running", json!([]), Some(TOKEN)).await;
    assert!(running.as_array().unwrap().contains(&json!("s_turn_s")), "{running}");

    let (status, _) = post(rig.d.port, "chat:abort", json!(["s_turn_s"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (events, end) = turn_record(rig.d.port, "turn_s").await;
    assert_eq!(end["aborted"], true);
    assert!(event_types(&events).contains(&"error".to_string()));
    assert!(saved_session(&rig, "s_turn_s").get("activeRun").is_none());
    let (_, alive) = post(rig.d.port, "turn:alive", json!(["turn_s"]), Some(TOKEN)).await;
    assert_eq!(alive, json!(false));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_turn_whose_prompt_changed_ends_before_it_starts() {
    let session = json!({
        "id": "s_turn_e", "title": "Named", "workspaceId": "w1", "messages": [], "queue": ["other"],
        "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("early", session);
    let model = scripted_model(vec![]).await;
    let mut spec = turn_spec(&rig, &model, "turn_e", "s_turn_e", json!({ "text": "mine" }));
    spec["queued"] = json!({ "index": 0, "item": "mine" });
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (events, end) = turn_record(rig.d.port, "turn_e").await;
    assert_eq!(end["early"], true);
    assert_eq!(events[0]["events"][0]["message"], "Queued prompt changed before it could start.");
    assert!(model.requests.lock().unwrap().is_empty(), "no model call for a turn that never started");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chain_the_daemon_admitted_admits_its_queued_prompts_too() {
    let session = json!({
        "id": "s_chain", "title": "New chat", "workspaceId": "w1", "messages": [], "queue": ["and then this"],
        "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("chain", session);
    let model = scripted_model(vec![say_text("first answer"), say_text("second answer")]).await;
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let settings = json!({
        "providers": [provider],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();

    let opts = json!({ "sessionId": "s_chain", "providerId": "p1", "modelId": "synthetic", "text": "first" });
    let (status, body) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null));
    let saved = saved_session(&rig, "s_chain");
    let contents: Vec<&str> =
        saved["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(contents, ["first", "first answer", "and then this", "second answer"]);
    assert_eq!(saved["queue"], json!([]));

    let calls = until_adopted(rig.d.port, 2).await;
    assert!(!calls.iter().any(|c| c[0] == "turn:prepare"), "the daemon admitted the follow-up itself");
    let adopts: Vec<&Value> = calls.iter().filter(|c| c[0] == "turn:adopt").collect();
    assert_eq!(adopts.len(), 2, "{adopts:?}");
    assert_eq!(adopts[0][1][0]["chained"], false);
    assert_eq!(adopts[1][1][0]["chained"], true);
    assert_eq!(adopts[1][1][0]["opts"]["text"], "and then this");
    let (first, second) = (adopts[0][1][0]["turnId"].as_str().unwrap(), adopts[1][1][0]["turnId"].as_str().unwrap());
    assert!(second.starts_with("turn_d"), "{second}");
    let ends: Vec<&Value> = calls.iter().filter(|c| c[0] == "turn:end").collect();
    let first_end = ends.iter().find(|c| c[1][0] == first).expect("the first turn ended");
    assert_eq!(first_end[1][1]["next"], second);
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_daemon_turn_the_title_lands_and_the_queue_drains() {
    let session = json!({
        "id": "s_turn_t", "title": "New chat", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("after", session);
    let (release, responses) = tokio::sync::mpsc::unbounded_channel();
    let model = scripted_model_with_titles(
        vec![say_text("first answer"), say_text("second answer")],
        Some(std::sync::Arc::new(tokio::sync::Mutex::new(responses))),
    )
    .await;
    let spec = turn_spec(&rig, &model, "turn_t", "s_turn_t", json!({}));
    let (status, _) = post(rig.d.port, "test:prepareTemplate", json!([spec.clone()]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    // A follow-up queued while the turn runs: it is the daemon's to run next.
    let (status, _) = post(rig.d.port, "chat:queue", json!(["s_turn_t", "and then this"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    let (_, first) = turn_record(rig.d.port, "turn_t").await;
    assert_eq!(first["next"], "turn_next_1", "{first}");
    let (_, second) = turn_record(rig.d.port, "turn_next_1").await;
    assert_eq!(second["stop"], "complete", "{second}");
    assert!(second.get("next").is_none(), "the queue is empty after one follow-up");

    wait_for_title_requests(&model, 1).await;
    let pending = saved_session(&rig, "s_turn_t");
    assert_eq!(pending["titleAuto"], true, "title response is still held");
    assert_eq!(pending["queue"], json!([]), "queue drains without waiting for the title");
    assert_eq!(title_requests(&model), 1, "the queued turn must not request another title");
    release.send(say_text("\"Login bug fix.\"")).unwrap();

    // The title lands on its own, after the first turn.
    let saved = until("the title to land", Duration::from_secs(20), || async {
        let saved = saved_session(&rig, "s_turn_t");
        (saved["titleAuto"] == false).then_some(saved)
    })
    .await;
    assert_eq!(saved["title"], "Login bug fix");
    let messages = saved["messages"].as_array().unwrap();
    let contents: Vec<&str> = messages.iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(contents, ["Fix the bug", "first answer", "and then this", "second answer"]);
    assert_eq!(saved["queue"], json!([]), "the queued prompt was claimed by its turn");

    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let all = all.as_array().unwrap();
    let prepare = all.iter().find(|e| e[0] == "turn:prepare").expect("the host admitted the follow-up");
    assert_eq!(prepare[1][0], "turn_t");
    assert_eq!(prepare[1][1]["queued"], json!({ "index": 0, "item": "and then this" }));
    assert_eq!(prepare[1][1]["opts"]["text"], "and then this");
    // The title call's usage is in the log, written by the daemon, which keeps it.
    assert!(!all.iter().any(|e| e[0] == "turn:usage"), "no usage callback when the daemon keeps the log");
    let log = std::fs::read_to_string(rig.data.join("usage.jsonl")).unwrap_or_default();
    assert!(
        log.lines().filter(|l| l.contains(r#""sessionId":"s_turn_t""#)).any(|l| l.contains(r#""providerId":"p1""#)),
        "{log}"
    );
    assert!(all.iter().any(|e| e[0] == "turn:notify" && e[1][0]["type"] == "session_meta"));
    let titles =
        model.requests.lock().unwrap().iter().filter(|r| r["messages"].to_string().contains("short title")).count();
    assert_eq!(titles, 1, "one title, for the first turn only");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_writes_its_own_usage_and_reply_lines() {
    let session = json!({
        "id": "s_turn_u", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("usage", session);
    std::fs::write(
        rig.data.join("settings.json"),
        json!({ "providers": [{ "id": "p1", "kind": "openai-compat" }, { "id": "c1", "kind": "anthropic", "auth": "subscription", "tokenKey": "claude:t" }] }).to_string(),
    )
    .unwrap();
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["turn:account", "usage:summary", "limits:get", "limits:headers"] {
        assert!(info["owned"].as_array().unwrap().iter().any(|o| o == c), "{c} not owned: {info}");
    }

    let model = scripted_model(vec![say_text("hello")]).await;
    let mut spec = turn_spec(&rig, &model, "turn_u", "s_turn_u", json!({}));
    spec["facts"]["account"] = json!({ "auth": "apikey", "kind": "openai-compat", "incognito": false });
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_u").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // The lines the host would have written, written by the daemon.
    let usage = std::fs::read_to_string(rig.data.join("usage.jsonl")).unwrap();
    let lines: Vec<Value> = usage.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 1, "{usage}");
    let keys: Vec<&str> = lines[0].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["ts", "providerId", "modelId", "inputTokens", "outputTokens", "sessionId", "auth", "local"]);
    assert_eq!(lines[0]["inputTokens"], 10);
    assert_eq!(lines[0]["outputTokens"], 3);
    assert_eq!(lines[0]["local"], false);
    let replies = std::fs::read_to_string(rig.data.join("replies.jsonl")).unwrap();
    let reply: Value = serde_json::from_str(replies.trim()).unwrap();
    assert_eq!(reply["stop"], "complete");
    assert_eq!(reply["steps"], 0);
    assert_eq!(reply["sessionId"], "s_turn_u");
    assert_eq!(reply["effort"], "normal");
    assert!(reply["startedAt"].as_u64().unwrap() <= reply["ts"].as_u64().unwrap());

    // And the summary is the daemon's.
    let (status, summary) = post(rig.d.port, "usage:summary", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{summary}");
    assert_eq!(summary["totalInput"], 10);
    assert_eq!(summary["bySession"]["s_turn_u"]["output"], 3);
    assert_eq!(summary["replies"]["total"], 1);

    // Limits: headers recorded here, read back here, history written, the host told for the relay.
    let pairs = json!([
        ["anthropic-ratelimit-unified-5h-utilization", "0.25"],
        ["anthropic-ratelimit-unified-5h-reset", "1760003600"]
    ]);
    let (_, recorded) = post(rig.d.port, "limits:headers", json!(["claude:t", "anthropic", pairs]), Some(TOKEN)).await;
    assert_eq!(recorded["windows"][0]["usedPercent"], 25);
    let (_, got) = post(rig.d.port, "limits:get", json!(["claude:t"]), Some(TOKEN)).await;
    assert_eq!(got, recorded, "a fresh header snapshot is served without a poll");
    let history = std::fs::read_to_string(rig.data.join("quota-history.jsonl")).unwrap();
    assert!(history.contains(r#""providerId":"c1","source":"headers""#), "{history}");
    let notified = until("the host to hear limits:notify", Duration::from_secs(10), || async {
        host_calls(rig.d.port).await.into_iter().find(|e| e[0] == "limits:notify")
    })
    .await;
    assert_eq!(notified[1][0]["tokenKey"], "claude:t");
    // No sign-in stored: a poll says so rather than guessing.
    let (_, polled) = post(rig.d.port, "limits:get", json!(["claude:none"]), Some(TOKEN)).await;
    assert_eq!(polled, Value::Null);
    let (_, problem) = post(rig.d.port, "limits:problem", json!(["claude:none"]), Some(TOKEN)).await;
    assert_eq!(problem["kind"], "signed_out");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_data_dir_accounting_stays_with_the_host() {
    let d = start(true);
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    let owned = info["owned"].as_array().unwrap();
    assert!(!owned.iter().any(|o| o == "limits:get" || o == "turn:account"), "{info}");
    let (status, body) = post(d.port, "limits:get", json!(["k"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(body["echo"], "limits:get", "forwarded to the host: {body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_during_admission_cancels_setup_and_refuses_duplicate_send() {
    let session = json!({ "id": "s_prepare_stop", "title": "Prepared", "titleAuto": false, "workspaceId": "w1", "gitIsolation": true, "executionMode": "worktree", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("prepare-stop", session);
    for args in [
        vec!["init", "-q"],
        vec!["add", "."],
        vec!["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Fixture"],
    ] {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(&rig.workspace);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    let model = scripted_model(vec![say_text("after stop")]).await;
    let setup =
        if cfg!(windows) { "echo setup-begun & ping -n 30 127.0.0.1 >nul" } else { "echo setup-begun; sleep 30" };
    let settings = json!({ "providers": [{ "id": "p1", "kind": "openai-compat", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }], "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy(), "worktreeSetup": setup }], "defaultChatMode": "yolo" });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();
    let opts =
        json!({ "sessionId": "s_prepare_stop", "providerId": "p1", "modelId": "synthetic", "text": "prepare this" });
    let send_opts = opts.clone();
    let port = rig.d.port;
    let sender = tokio::spawn(async move { post(port, "chat:send", json!([send_opts]), Some(TOKEN)).await });
    until_agent_log(port, "s_prepare_stop", "setup-begun", Duration::from_secs(20)).await;
    let (status, refused) = post(port, "chat:send", json!([opts.clone()]), Some(TOKEN)).await;
    assert_eq!(status, 400, "{refused}");
    assert!(refused.to_string().contains("already being prepared"));
    post(port, "chat:abort", json!(["s_prepare_stop"]), Some(TOKEN)).await;
    let (status, reply) =
        tokio::time::timeout(Duration::from_secs(5), sender).await.expect("Stop ends admission promptly").unwrap();
    assert_eq!((status, reply), (200, Value::Null));
    assert!(model.requests.lock().unwrap().is_empty(), "a stopped preparation must never reach a model");
    assert!(saved_session(&rig, "s_prepare_stop")["messages"].as_array().unwrap().is_empty());
    // The admission guard releases; a fresh send on the prepared checkout can run.
    let (status, reply) = post(port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, reply), (200, Value::Null));
    assert_eq!(
        saved_session(&rig, "s_prepare_stop")["messages"].as_array().unwrap().last().unwrap()["content"],
        "after stop"
    );
}

/// A chat with three turns on the scripted provider, for compaction.
fn compaction_chat(id: &str) -> Value {
    let long = |s: &str| format!("{s} {}", "background detail ".repeat(30));
    json!({
        "id": id, "title": "Long chat", "workspaceId": "w1", "providerId": "p1", "modelId": "synthetic",
        "messages": [
            { "id": "u1", "role": "user", "content": long("First request:"), "createdAt": 1 },
            { "id": "a1", "role": "assistant", "content": long("First answer:"), "createdAt": 2 },
            { "id": "u2", "role": "user", "content": "Second request", "createdAt": 3 },
            { "id": "a2", "role": "assistant", "content": "Second answer", "createdAt": 4 },
            { "id": "u3", "role": "user", "content": "Third request", "createdAt": 5 },
            { "id": "a3", "role": "assistant", "content": "Third answer", "createdAt": 6 },
        ],
        "createdAt": 1, "updatedAt": 1,
    })
}

/// The `compaction` progress the host heard (`turn:notify`), in order.
async fn compaction_progress(port: u16, session_id: &str) -> Vec<Value> {
    let (_, calls) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
    calls
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c[0] == "turn:notify" && c[1][0]["type"] == "compaction" && c[1][0]["sessionId"] == session_id)
        .map(|c| c[1][0]["progress"].clone())
        .collect()
}

async fn wait_progress(port: u16, session_id: &str, state: &str) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let all = compaction_progress(port, session_id).await;
        if all.last().is_some_and(|p| p["state"] == state) {
            return all;
        }
        assert!(Instant::now() < deadline, "compaction never reached {state}: {all:?}");
        tokio::time::sleep(POLL).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_compacts_a_chat_and_owns_its_state() {
    let rig = turn_rig("compact", compaction_chat("s_compact"));
    let model = scripted_model(vec![sse(&[json!({
        "choices": [{ "delta": { "content": "  Summary of decisions and next steps.  " }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 200, "completion_tokens": 20 }
    })])])
    .await;
    // A second provider for the new-chat case, so settings are written once.
    let model2 = scripted_model(vec![say_text("A fresh summary.")]).await;
    let mut settings = scripted_settings(&rig, &model);
    settings["providers"].as_array_mut().unwrap().push(json!({
        "id": "p2", "kind": "openai-compat", "label": "Second", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model2.port),
    }));
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["chat:compact", "chat:cancelCompaction", "chat:interruptQueued"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} is not owned");
    }
    let original = saved_session(&rig, "s_compact")["messages"].clone();

    // An omitted options argument can cross IPC as null.
    let (status, landed) = post(rig.d.port, "chat:compact", json!(["s_compact", null]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{landed}");
    assert_eq!(landed["id"], "s_compact");
    let messages = saved_session(&rig, "s_compact")["messages"].as_array().unwrap().clone();
    assert_eq!(messages.len(), 7, "nothing is deleted: the summary goes in after what it replaces");
    assert_eq!(json!(messages[..2]), json!(original.as_array().unwrap()[..2]));
    assert_eq!(messages[2]["role"], "assistant");
    assert_eq!(messages[2]["content"], "Summary of decisions and next steps.");
    assert_eq!(messages[2]["compaction"], json!({ "summarized": 2 }));
    assert_eq!(messages[2]["createdAt"], 2);
    assert!(messages[2]["id"].as_str().unwrap().starts_with("compact_"));
    assert_eq!(json!(messages[3..]), json!(original.as_array().unwrap()[2..]));

    // The summary call carried the ported prompt, and only what was summarized.
    let requests = model.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    let sent = requests[0]["messages"].to_string();
    assert!(sent.contains("Summarize conversation history for the same assistant"), "{sent}");
    assert!(sent.contains("Summarize this transcript segment:\\n\\nUSER: First request:"), "{sent}");
    assert!(!sent.contains("Third request"), "the recent turns stay verbatim: {sent}");

    // Progress from start to done, told to the host, and its usage in the log.
    let progress = wait_progress(rig.d.port, "s_compact", "done").await;
    assert_eq!(progress[0], json!({ "state": "running", "done": 0, "total": 0, "target": "here" }));
    assert_eq!(progress.last().unwrap(), &json!({ "state": "done", "done": 1, "total": 1, "target": "here" }));
    let usage = std::fs::read_to_string(rig.data.join("usage.jsonl")).unwrap();
    let line: Value = serde_json::from_str(usage.lines().next().unwrap()).unwrap();
    assert_eq!((line["providerId"].clone(), line["inputTokens"].clone()), (json!("p1"), json!(200)));
    assert_eq!(line["sessionId"], "s_compact");

    // Nothing new since that summary: refused, the history kept.
    let (status, again) = post(rig.d.port, "chat:compact", json!(["s_compact"]), Some(TOKEN)).await;
    assert_eq!(status, 400, "{again}");
    assert_eq!(again["error"], "Nothing new to compact since the last summary.");

    // To a new chat: this one is left as it was.
    let mut fresh = compaction_chat("s_fresh");
    fresh["providerId"] = json!("p2");
    std::fs::write(rig.data.join("sessions/s_fresh.json"), fresh.to_string()).unwrap();
    let before = saved_session(&rig, "s_fresh")["messages"].clone();
    let (status, next) = post(rig.d.port, "chat:compact", json!(["s_fresh", { "newChat": true }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{next}");
    let new_id = next["id"].as_str().unwrap().to_string();
    assert_ne!(new_id, "s_fresh");
    assert_eq!(next["title"], "Long chat (continued)");
    assert_eq!(next["workspaceId"], "w1");
    assert_eq!(next["messages"][0]["compaction"], json!({ "summarized": 2 }));
    assert_eq!(saved_session(&rig, &new_id)["messages"], next["messages"]);
    assert_eq!(saved_session(&rig, "s_fresh")["messages"], before);
    let progress = wait_progress(rig.d.port, "s_fresh", "done").await;
    assert_eq!(progress.last().unwrap()["newSessionId"], json!(new_id));
    assert_eq!(progress.last().unwrap()["target"], "new");

    // Refusals, with the host's words.
    std::fs::write(
        rig.data.join("sessions/s_secret.json"),
        json!({ "id": "s_secret", "title": "x", "incognito": true, "providerId": "p1", "modelId": "m", "messages": [{ "id": "u", "role": "user", "content": "hi", "createdAt": 1 }], "createdAt": 1, "updatedAt": 1 }).to_string(),
    )
    .unwrap();
    let (_, refused) = post(rig.d.port, "chat:compact", json!(["s_secret"]), Some(TOKEN)).await;
    assert_eq!(refused["error"], "Incognito conversations cannot be compacted.");
    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!calls.as_array().unwrap().iter().any(|c| c[0] == "chat:compact"), "the host compacted nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_compaction_keeps_the_history_and_refuses_turns_meanwhile() {
    let rig = turn_rig("compact-cancel", compaction_chat("s_cancel"));
    let model = scripted_model(vec![HANG.into()]).await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();
    let original = saved_session(&rig, "s_cancel")["messages"].clone();
    let port = rig.d.port;
    let compacting = tokio::spawn(async move { post(port, "chat:compact", json!(["s_cancel"]), Some(TOKEN)).await });
    until_model_asked(&model, 1, "the summary call to start", Duration::from_secs(10)).await;

    // Admission reads the daemon's own compaction state.
    let opts = json!({ "sessionId": "s_cancel", "providerId": "p1", "modelId": "synthetic", "text": "hello" });
    let (status, _) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(
        calls.as_array().unwrap().iter().any(|c| c[0] == "turn:notify"
            && c[1][0]["type"] == "error"
            && c[1][0]["message"] == "This chat is being compacted. Wait or move to a new chat."),
        "{calls}"
    );
    let progress = compaction_progress(rig.d.port, "s_cancel").await;
    assert_eq!(progress.last().unwrap()["state"], "running", "{progress:?}");

    let started = Instant::now();
    let (status, _) = post(rig.d.port, "chat:cancelCompaction", json!(["s_cancel"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (status, body) = compacting.await.unwrap();
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "Compaction cancelled.");
    assert!(started.elapsed() < Duration::from_secs(5), "the held call was cut, not waited out");
    let progress = wait_progress(rig.d.port, "s_cancel", "cancelled").await;
    assert_eq!(progress.last().unwrap()["state"], "cancelled");
    assert_eq!(saved_session(&rig, "s_cancel")["messages"], original);
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupting_starts_the_chosen_queued_prompt_and_keeps_the_others() {
    let session = json!({
        "id": "s_jump", "title": "Jump", "workspaceId": "w1", "providerId": "p1", "modelId": "synthetic",
        "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("interrupt", session);
    // The first reply hangs until stopped; the rest answer at once.
    let model = scripted_model(vec![
        HANG.into(),
        say_text("selected answer"),
        say_text("first answer"),
        say_text("last answer"),
    ])
    .await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();

    // Validation, before anything is stopped.
    for bad in [json!(-1), json!(0), json!(1.5), json!("0")] {
        let (status, body) = post(rig.d.port, "chat:interruptQueued", json!(["s_jump", bad]), Some(TOKEN)).await;
        assert_eq!((status, body["error"].clone()), (400, json!("Queued prompt not found.")), "{bad}");
    }

    let port = rig.d.port;
    let opts = json!({ "sessionId": "s_jump", "providerId": "p1", "modelId": "synthetic", "text": "old" });
    let old = tokio::spawn(async move { post(port, "chat:send", json!([opts]), Some(TOKEN)).await });
    until_model_asked(&model, 1, "the first reply to start", Duration::from_secs(10)).await;
    for text in ["first", "selected", "last"] {
        post(rig.d.port, "chat:queue", json!(["s_jump", text]), Some(TOKEN)).await;
    }
    let (_, refused) = post(
        rig.d.port,
        "chat:interruptQueued",
        json!(["s_jump", 1, { "providerId": "p1", "modelId": "__auto__" }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(refused["error"], "Choose a provider and model before starting the queued prompt.");

    let (status, body) = post(rig.d.port, "chat:interruptQueued", json!(["s_jump", 1]), Some(TOKEN)).await;
    assert_eq!((status, body.clone()), (200, Value::Null), "{body}");
    let (status, _) = old.await.unwrap();
    assert_eq!(status, 200);
    let saved = saved_session(&rig, "s_jump");
    let users: Vec<&str> = saved["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .filter_map(|m| m["content"].as_str())
        .collect();
    // The stopped reply, then the selected prompt, then the rest of the queue in order.
    assert_eq!(users, ["old", "selected", "first", "last"], "{saved}");
    assert_eq!(saved["queue"], json!([]));
    let calls = until_adopted(rig.d.port, 4).await;
    assert!(!calls.iter().any(|c| c[0] == "chat:interruptQueued"), "the host started nothing");
    let adopts: Vec<&Value> = calls.iter().filter(|c| c[0] == "turn:adopt").collect();
    assert_eq!(adopts.len(), 4, "{adopts:?}");
    assert_eq!(adopts[1][1][0]["opts"]["text"], "selected");
    assert_eq!(adopts[1][1][0]["chained"], false, "a new chain, which the host adopts as its own");
}
