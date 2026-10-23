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
    let (_, end) = turn_record(&rig, "t_large", "s_large").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_large");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages[0]["images"][0], image);
    assert_eq!(messages.last().unwrap()["content"], format!("synthetic-image-{}", image.len()));
    assert_ne!(messages.last().unwrap()["interrupted"], true);

    let (status, started) =
        post(rig.d.port, "chat:turn", json!([spec_for("t_next", "followup", json!([]))]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    let (_, end) = turn_record(&rig, "t_next", "s_large").await;
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
    events.iter().map(|e| e["type"].as_str().unwrap_or_default().to_string()).collect()
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
    write_settings(&rig, settings).await;

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
    // The disabled provider's turn was refused; this one ran and ended.
    let events = rig.events.lock().unwrap().clone();
    assert!(events.iter().any(|e| e["sessionId"] == "s_admit" && e["type"] == "error"), "{events:?}");
    assert!(events.iter().any(|e| e["sessionId"] == "s_admit" && e["type"] == "done"), "{events:?}");
    // The daemon's own index snippets and the guidelines reached the model.
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

/// The next frame about a chat or a request.
async fn next_chat_frame(socket: &mut Socket) -> Value {
    next_json(socket, Duration::from_secs(5)).await.expect("a frame")
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
async fn sockets_take_only_the_chats_they_subscribe_to() {
    let chat = |id: &str| json!({ "id": id, "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("subscribe", chat("s_one"));
    std::fs::write(rig.data.join("sessions").join("s_two.json"), chat("s_two").to_string()).unwrap();
    // Each reply is 40 chunks, interleaved; a burst of them goes out as a few
    // joined text events (turns.rs `DELTA_WINDOW`), so the stream is short.
    let model = scripted_model(vec![slow_text("one", 40), slow_text("two", 40)]).await;
    let port = rig.d.port;

    // Socket A takes s_one's stream (daemon:subscribe), B s_two's (?sessions=),
    // C every chat (no subscription, as before).
    let mut a = ws(port, &format!("/api/ws?token={TOKEN}"), None).await.unwrap();
    a.send(Message::Text(json!({ "id": 1, "channel": "daemon:subscribe", "args": [["s_one"]] }).to_string().into()))
        .await
        .unwrap();
    // No chat's event may land first.
    let ack = next_chat_frame(&mut a).await;
    assert_eq!(
        ack,
        json!({ "id": 1, "result": true }),
        "no turn is running yet, so no chat event comes before the answer"
    );
    let mut b = ws(port, &format!("/api/ws?sessions=s_two&token={TOKEN}"), None).await.unwrap();
    let mut c = ws(port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let one = turn_spec(&rig, &model, "turn_one", "s_one", json!({}));
    let two = turn_spec(&rig, &model, "turn_two", "s_two", json!({}));
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
    assert!(frames(&fa) < frames(&fc), "a {} frames vs c {}", frames(&fa), frames(&fc));
    println!("agent frames per socket: subscribed a={} b={}, unsubscribed c={}", frames(&fa), frames(&fb), frames(&fc));

    // A socket that starts showing a chat mid-turn is sent the turn so far.
    let model2 = scripted_model(vec![
        call_tool("c_wait", "ask_user", json!({ "questions": [{ "question": "Go?", "options": ["yes", "no"] }] })),
        say_text("went"),
    ])
    .await;
    let three = turn_spec(&rig, &model2, "turn_three", "s_one", json!({}));
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
    assert_eq!((status, body), (200, Value::Null), "answered by the daemon");

    let (events, end) = turn_record(&rig, "turn_q", "s_turn_q").await;
    assert_eq!(end["aborted"], false, "{end}");
    assert_eq!(end["stop"], "complete", "{end}");
    let types = event_types(&events);
    for t in ["session_meta", "question", "question_resolved", "tool_call", "tool_result", "done"] {
        assert!(types.iter().any(|x| x == t), "no {t} event in {types:?}");
    }
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
    // delegation_targets runs here: a coded answer, never a guess.
    let delegation: Value = serde_json::from_str(&tool_out("c_host")).unwrap();
    assert_eq!(delegation["fallbackUsed"], false, "{delegation}");
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
    assert_eq!((status, body), (200, Value::Null), "answered by the daemon");

    wait_pending(rig.d.port, "s_turn_a", "question", "c_slow").await;
    let answers = json!([{ "questionId": "q1", "labels": ["Yes"] }]);
    post(rig.d.port, "chat:answer", json!(["s_turn_a", "c_slow", answers]), Some(TOKEN)).await;

    let (events, end) = turn_record(&rig, "turn_a", "s_turn_a").await;
    assert_eq!(end["stop"], "complete", "{end}");
    assert_eq!(std::fs::read_to_string(rig.workspace.join("new.txt")).unwrap(), "hi");
    let types = event_types(&events);
    assert_eq!(types.iter().filter(|t| *t == "tool_approval_required").count(), 1, "{types:?}");
    // The host's own approval channel is gone with the host.
    let (status, _) = post(rig.d.port, "turn:approval", json!(["turn_a", {}, "x", "medium"]), Some(TOKEN)).await;
    assert_ne!(status, 200);
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
    let (events, end) = turn_record(&rig, "turn_s", "s_turn_s").await;
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
    let (events, end) = turn_record(&rig, "turn_e", "s_turn_e").await;
    assert_eq!(end["stop"], Value::Null, "it never ran: {end}");
    assert_eq!(events[0]["message"], "Queued prompt changed before it could start.");
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
    write_settings(&rig, settings).await;

    let opts = json!({ "sessionId": "s_chain", "providerId": "p1", "modelId": "synthetic", "text": "first" });
    let (status, body) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null));
    let saved = saved_session(&rig, "s_chain");
    let contents: Vec<&str> =
        saved["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(contents, ["first", "first answer", "and then this", "second answer"]);
    assert_eq!(saved["queue"], json!([]));
    // Two turns of one chain, each told to the UI as it ended.
    let dones =
        rig.events.lock().unwrap().iter().filter(|e| e["sessionId"] == "s_chain" && e["type"] == "done").count();
    assert_eq!(dones, 2);
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
    // The follow-up is admitted here, from these settings.
    write_settings(&rig, scripted_settings(&rig, &model)).await;
    // A turn the daemon admitted (`turn_d...`) runs its chat's queue on.
    let spec = turn_spec(&rig, &model, "turn_d_after", "s_turn_t", json!({}));
    // A follow-up queued while the turn runs: it is the daemon's to run next.
    let (status, _) = post(rig.d.port, "chat:queue", json!(["s_turn_t", "and then this"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    let (_, first) = turn_record(&rig, "turn_d_after", "s_turn_t").await;
    assert_eq!(first["stop"], "complete", "{first}");
    // The next turn of the chain: the queued prompt, answered.
    until("the follow-up's reply", Duration::from_secs(20), || async {
        let saved = saved_session(&rig, "s_turn_t");
        let last = saved["messages"].as_array()?.last()?.clone();
        (last["content"] == "second answer").then_some(())
    })
    .await;
    until("the follow-up to end", Duration::from_secs(20), || async {
        let (_, running) = post(rig.d.port, "chat:running", json!([]), Some(TOKEN)).await;
        (!running.as_array()?.iter().any(|r| r == "s_turn_t")).then_some(())
    })
    .await;

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

    // The title call's usage is in the log, written by the daemon.
    let log = std::fs::read_to_string(rig.data.join("usage.jsonl")).unwrap_or_default();
    assert!(
        log.lines().filter(|l| l.contains(r#""sessionId":"s_turn_t""#)).any(|l| l.contains(r#""providerId":"p1""#)),
        "{log}"
    );
    assert!(rig.events.lock().unwrap().iter().any(|e| e["sessionId"] == "s_turn_t" && e["type"] == "session_meta"));
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
    write_settings(&rig, json!({ "providers": [{ "id": "p1", "kind": "openai-compat" }, { "id": "c1", "kind": "chatgpt", "auth": "subscription", "tokenKey": "chatgpt:t" }] })).await;

    let model = scripted_model(vec![say_text("hello")]).await;
    let mut spec = turn_spec(&rig, &model, "turn_u", "s_turn_u", json!({}));
    spec["facts"]["account"] = json!({ "auth": "apikey", "kind": "openai-compat", "incognito": false });
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(&rig, "turn_u", "s_turn_u").await;
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

    // Limits are read here. No sign-in stored: a poll says so rather than guessing.
    let (_, polled) = post(rig.d.port, "limits:get", json!(["chatgpt:none"]), Some(TOKEN)).await;
    assert_eq!(polled, Value::Null);
    let (_, problem) = post(rig.d.port, "limits:problem", json!(["chatgpt:none"]), Some(TOKEN)).await;
    assert_eq!(problem["kind"], "signed_out");
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
    write_settings(&rig, settings).await;
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

/// The `compaction` progress the UI heard, in order.
fn compaction_progress(rig: &TurnRig, session_id: &str) -> Vec<Value> {
    rig.events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "compaction" && e["sessionId"] == session_id)
        .map(|e| e["progress"].clone())
        .collect()
}

async fn wait_progress(rig: &TurnRig, session_id: &str, state: &str) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let all = compaction_progress(rig, session_id);
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
    write_settings(&rig, settings).await;
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

    // Progress from start to done, told to the UI, and its usage in the log.
    let progress = wait_progress(&rig, "s_compact", "done").await;
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
    let progress = wait_progress(&rig, "s_fresh", "done").await;
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
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_compaction_keeps_the_history_and_refuses_turns_meanwhile() {
    let rig = turn_rig("compact-cancel", compaction_chat("s_cancel"));
    let model = scripted_model(vec![HANG.into()]).await;
    write_settings(&rig, scripted_settings(&rig, &model)).await;
    let original = saved_session(&rig, "s_cancel")["messages"].clone();
    let port = rig.d.port;
    let compacting = tokio::spawn(async move { post(port, "chat:compact", json!(["s_cancel"]), Some(TOKEN)).await });
    until_model_asked(&model, 1, "the summary call to start", Duration::from_secs(10)).await;

    // Admission reads the daemon's own compaction state.
    let opts = json!({ "sessionId": "s_cancel", "providerId": "p1", "modelId": "synthetic", "text": "hello" });
    let (status, _) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let refused = |e: &Value| {
        e["type"] == "error"
            && e["sessionId"] == "s_cancel"
            && e["message"] == "This chat is being compacted. Wait or move to a new chat."
    };
    wait_for("the refusal to reach the chat", || rig.events.lock().unwrap().iter().any(refused)).await;
    let progress = compaction_progress(&rig, "s_cancel");
    assert_eq!(progress.last().unwrap()["state"], "running", "{progress:?}");

    let started = Instant::now();
    let (status, _) = post(rig.d.port, "chat:cancelCompaction", json!(["s_cancel"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (status, body) = compacting.await.unwrap();
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "Compaction cancelled.");
    assert!(started.elapsed() < Duration::from_secs(5), "the held call was cut, not waited out");
    let progress = wait_progress(&rig, "s_cancel", "cancelled").await;
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
    write_settings(&rig, scripted_settings(&rig, &model)).await;

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
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resent_client_message_id_runs_one_turn_and_queues_once() {
    let session = json!({ "id": "s_once", "title": "Named", "titleAuto": false, "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("once", session);
    let model = scripted_model(vec![HANG.to_string(), say_text("second")]).await;
    let settings = json!({ "providers": [{ "id": "p1", "kind": "openai-compat", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }], "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }], "defaultChatMode": "yolo" });
    write_settings(&rig, settings).await;
    let opts = json!({ "sessionId": "s_once", "providerId": "p1", "modelId": "synthetic", "text": "from the phone", "clientMessageId": "6f1c2a9e-7b1d-4c35-9a52-2b8f0f6f8d11" });
    let port = rig.d.port;
    let first_opts = opts.clone();
    let first = tokio::spawn(async move { post(port, "chat:send", json!([first_opts]), Some(TOKEN)).await });
    let until = std::time::Instant::now() + Duration::from_secs(20);
    while model.requests.lock().unwrap().is_empty() {
        assert!(std::time::Instant::now() < until, "the first send never reached the model");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The phone resends while the first is still running (its connection dropped): answered at once, not refused.
    let (status, reply) = post(port, "chat:send", json!([opts.clone()]), Some(TOKEN)).await;
    assert_eq!((status, reply), (200, Value::Null));
    post(port, "chat:abort", json!(["s_once"]), Some(TOKEN)).await;
    let (status, _) = tokio::time::timeout(Duration::from_secs(10), first).await.expect("Stop ends the turn").unwrap();
    assert_eq!(status, 200);
    // After the turn ended, saved with the chat: a repeat still starts nothing.
    let (status, reply) = post(port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, reply), (200, Value::Null));
    let saved = saved_session(&rig, "s_once");
    let users = saved["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "user").count();
    assert_eq!(users, 1, "{saved}");
    assert_eq!(saved["clientMessageIds"], json!(["6f1c2a9e-7b1d-4c35-9a52-2b8f0f6f8d11"]));
    assert_eq!(model.requests.lock().unwrap().len(), 1);

    // chat:queue: the same id twice queues one prompt.
    for _ in 0..2 {
        let (status, _) =
            post(port, "chat:queue", json!(["s_once", { "text": "later", "clientMessageId": "q-1" }]), Some(TOKEN))
                .await;
        assert_eq!(status, 200);
    }
    let saved = saved_session(&rig, "s_once");
    assert_eq!(saved["queue"], json!(["later"]));
    assert_eq!(saved["clientMessageIds"], json!(["6f1c2a9e-7b1d-4c35-9a52-2b8f0f6f8d11", "q-1"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unattended_workflow_turn_denies_approvals_and_follows_its_allowlist() {
    // A workflow run's chat in ask mode: nothing may park, ask_user is not
    // offered, and the step's allowlist runs a matching command without asking.
    let session = json!({
        "id": "s_turn_u", "title": "Run", "mode": "ask", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1,
        "unattended": true, "workflowRunId": "run_1", "toolAccess": "allowlist",
        "allowedTools": ["Read", "Bash(echo:*)"], "executionMode": "unified",
    });
    let rig = turn_rig("unattended", session);
    let model = scripted_model(vec![
        call_tool("c_write", "write_file", json!({ "path": "new.txt", "content": "hi" })),
        call_tool("c_echo", "bash", json!({ "command": "echo allowed" })),
        call_tool("c_chain", "bash", json!({ "command": "echo a && touch pwned" })),
        call_tool("c_push", "bash", json!({ "command": "git push" })),
        say_text("done"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_u", "s_turn_u", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (events, end) = turn_record(&rig, "turn_u", "s_turn_u").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let types = event_types(&events);
    assert!(!types.iter().any(|t| t == "tool_approval_required"), "{types:?}");
    assert!(!rig.workspace.join("new.txt").exists());
    assert!(!rig.workspace.join("pwned").exists());
    let results: Vec<Value> =
        events.iter().filter(|e| e["type"] == "tool_result").map(|e| e["result"].clone()).collect();
    let by = |id: &str| {
        results.iter().find(|r| r["toolCallId"] == id).cloned().unwrap_or_else(|| panic!("no {id}: {results:?}"))
    };
    for id in ["c_write", "c_chain", "c_push"] {
        let r = by(id);
        assert_eq!(r["isError"], true, "{r}");
        assert!(r["output"].as_str().unwrap().starts_with("Denied: unattended automation run ("), "{r}");
    }
    let echo = by("c_echo");
    assert_ne!(echo["isError"], true, "{echo}");
    assert!(echo["output"].as_str().unwrap().contains("allowed"), "{echo}");
    let first = model.requests.lock().unwrap()[0].clone();
    let tools: Vec<String> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_string())
        .collect();
    assert!(!tools.contains(&"ask_user".to_string()), "{tools:?}");
    let (_, pending) = post(rig.d.port, "chat:pending", json!([]), Some(TOKEN)).await;
    assert!(pending.get("s_turn_u").is_none(), "{pending}");
}

#[tokio::test(flavor = "multi_thread")]
async fn privacy_shield_sends_placeholders_and_keeps_real_values_on_this_computer() {
    let session = json!({
        "id": "s_shield", "title": "New chat", "workspaceId": "w1", "createdAt": 1, "updatedAt": 1,
        "privacy": { "mode": "redact" },
        "messages": [
            { "id": "u0", "role": "user", "content": "My email is jane.doe@example.com", "createdAt": 1 },
            { "id": "a0", "role": "assistant", "content": "Noted.", "createdAt": 2 },
        ],
    });
    let rig = turn_rig("shield", session);
    let model = scripted_model(vec![
        call_tool("c_write", "write_file", json!({ "path": "contact.txt", "content": "[PII_EMAIL_1]\n" })),
        say_text("Saved [PII_EMAIL_1] to contact.txt"),
    ])
    .await;
    let mut spec =
        turn_spec(&rig, &model, "turn_shield", "s_shield", json!({ "text": "Save my email to contact.txt" }));
    // A cloud provider (the scripted server stands in for it): only these get a shield.
    let cloud = json!({
        "id": "p1", "kind": "openai", "label": "Cloud", "enabled": true, "apiKey": "k",
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    spec["settings"]["providers"] = json!([cloud]);
    spec["facts"]["provider"] = cloud;
    let (status, started) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    let (_, end) = turn_record(&rig, "turn_shield", "s_shield").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // On the wire: placeholders only, and the note that explains them.
    let requests = model.requests.lock().unwrap().clone();
    let wire = serde_json::to_string(&requests).unwrap();
    assert!(!wire.contains("jane.doe@example.com"), "the email left the computer: {wire}");
    assert!(wire.contains("[PII_EMAIL_1]"), "{wire}");
    assert!(wire.contains("## Private values"), "{wire}");

    // On this computer: the tool wrote the real value, and the chat keeps it.
    let written = std::fs::read_to_string(rig.workspace.join("contact.txt")).unwrap();
    assert_eq!(written, "jane.doe@example.com\n");
    let saved = saved_session(&rig, "s_shield");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages[0]["content"], "My email is jane.doe@example.com");
    assert_eq!(messages.last().unwrap()["content"], "Saved jane.doe@example.com to contact.txt");
    let call = messages.iter().find_map(|m| m["toolCalls"].as_array().and_then(|c| c.first()).cloned()).unwrap();
    assert_eq!(call["input"]["content"], "jane.doe@example.com\n");

    // The preview names it, and says the shield is on for this cloud chat.
    write_settings(&rig, json!({ "providers": [{ "id": "p1", "kind": "openai", "enabled": true, "baseUrl": "https://api.openai.com/v1" }], "defaultProviderId": "p1" })).await;
    let (status, preview) =
        post(rig.d.port, "privacy:preview", json!(["s_shield", "cc bob@example.com"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["enabled"], true);
    assert_eq!(preview["reach"], "cloud");
    assert_eq!(preview["draft"], "cc [PII_EMAIL_2]");
    let values: Vec<&str> =
        preview["findings"].as_array().unwrap().iter().map(|f| f["value"].as_str().unwrap()).collect();
    assert_eq!(values, ["jane.doe@example.com", "bob@example.com"]);
}
