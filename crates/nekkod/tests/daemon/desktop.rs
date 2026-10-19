//! The desktop-only features with no TS backend (PF14 step 5 prep, part 6):
//! the real `nekkod` binary started the way the desktop app now starts it
//! (`native` in its config, no `backend`), with its home, PATH and CLI link
//! directory kept inside the test's own folder.

use crate::common::*;

const API_TOKEN: &str = "api-token-0123456789abcdef";

struct Desk {
    root: std::path::PathBuf,
    data: std::path::PathBuf,
    /// The CLI's link directory (`NEKKO_DATA_DIR` for the daemon).
    link_dir: std::path::PathBuf,
    home: std::path::PathBuf,
}

impl Desk {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("nekkod-desktop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (data, link_dir, home) = (root.join("data"), root.join("cli"), root.join("home"));
        for d in [&data.join("sessions"), &link_dir, &home, &root.join("user-data")] {
            std::fs::create_dir_all(d).unwrap();
        }
        Desk { root, data, link_dir, home }
    }

    fn settings(&self, settings: Value) {
        std::fs::write(self.data.join("settings.json"), settings.to_string()).unwrap();
    }

    fn start(&self, env: &[(&str, Option<&str>)]) -> Daemon {
        let native = json!({
            "isPackaged": false,
            "exePath": "",
            "userData": self.root.join("user-data"),
            "appPath": self.root.join("app"),
        });
        let (home, link) = (self.home.to_string_lossy().to_string(), self.link_dir.to_string_lossy().to_string());
        let mut all: Vec<(&str, Option<&str>)> =
            vec![("USERPROFILE", Some(&home)), ("HOME", Some(&home)), ("NEKKO_DATA_DIR", Some(&link))];
        all.extend_from_slice(env);
        start_with_env(Some(&self.data), json!({ "native": native, "edition": "desktop" }), &all)
    }

    fn link(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.link_dir.join("cli-link.json")).unwrap_or_default())
            .unwrap_or(Value::Null)
    }

    fn saved(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.data.join("settings.json")).unwrap()).unwrap()
    }
}

impl Drop for Desk {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn api(
    port: u16,
    method: reqwest::Method,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> (u16, Value, String) {
    let mut req = reqwest::Client::new().request(method, format!("http://127.0.0.1:{port}{path}"));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.header("content-type", "application/json").body(b.to_string());
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    let cors = res.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    (status, res.json().await.unwrap_or(Value::Null), cors)
}

async fn call(port: u16, channel: &str, args: Value, token: &str) -> (u16, Value) {
    let body = json!({ "args": args }).to_string();
    let (s, v, _) = api(port, reqwest::Method::POST, &format!("/api/{channel}"), Some(token), Some(&body)).await;
    (s, v)
}

/// Close the daemon's stdin, its shutdown signal, and wait for it to exit.
fn quit(mut d: Daemon) {
    drop(d.child.stdin.take());
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if let Ok(Some(_)) = d.child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("nekkod did not exit after its stdin closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_local_api_server_and_its_link_with_no_backend() {
    let desk = Desk::new("api");
    let work = desk.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(
        desk.data.join("sessions/s_cli.json"),
        json!({ "id": "s_cli", "title": "CLI", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 })
            .to_string(),
    )
    .unwrap();
    let model = scripted_model(vec![say_text("hello from the cli")]).await;
    let port = free_port();
    desk.settings(json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "workspaces": [{ "id": "w1", "name": "work", "path": work }],
        "defaultChatMode": "yolo",
        "apiServer": { "port": port, "token": API_TOKEN },
    }));
    let d = desk.start(&[]);

    let (_, status) = until("the API server listening", Duration::from_secs(15), || async {
        let s = post(d.port, "apiServer:status", json!([]), Some(TOKEN)).await;
        (s.1["running"] == true).then_some(s)
    })
    .await;
    assert_eq!(status["url"], format!("http://127.0.0.1:{port}"), "{status}");
    assert_eq!(status["clientUrl"], format!("http://127.0.0.1:{port}"));
    assert_eq!(status["settings"]["enabled"], true);
    assert_eq!(status["available"], true);
    assert!(status.get("error").is_none(), "{status}");

    // Every request needs the server's own token; the daemon's is not it.
    let (s, body, cors) = api(port, reqwest::Method::GET, "/api/health", None, None).await;
    assert_eq!((s, body["error"].as_str(), cors.as_str()), (401, Some("unauthorized"), "null"));
    let (s, _, _) = api(port, reqwest::Method::GET, "/api/health", Some(TOKEN), None).await;
    assert_eq!(s, 401);
    let (s, health, cors) = api(port, reqwest::Method::GET, "/api/health", Some(API_TOKEN), None).await;
    assert_eq!(s, 200);
    assert_eq!(health, json!({ "ok": true, "app": "nekko-agent", "edition": "desktop" }));
    assert_eq!(cors, "null");
    let (s, body, _) =
        api(port, reqwest::Method::GET, &format!("/api/settings:get?token={API_TOKEN}"), None, None).await;
    assert_eq!((s, body["error"].as_str()), (404, Some("not found")), "a GET is not a call");
    let (s, body, _) = api(port, reqwest::Method::POST, "/api/settings:get", Some(API_TOKEN), Some("{oops")).await;
    assert_eq!((s, body["error"].as_str()), (400, Some("body is not JSON")));
    let (s, settings) = call(port, "settings:get", json!([]), API_TOKEN).await;
    assert_eq!(s, 200);
    assert_eq!(settings["apiServer"]["token"], API_TOKEN);
    // What only the window answers is not reachable from here, worded as the TS dispatcher worded it.
    let (s, body) = call(port, "apiServer:newToken", json!([]), API_TOKEN).await;
    assert_eq!((s, body["error"].as_str()), (500, Some("Unknown channel: apiServer:newToken")));
    let (s, body) = call(port, "no:such", json!([]), API_TOKEN).await;
    assert_eq!((s, body["error"].as_str()), (500, Some("Unknown channel: no:such")));

    // The CLI's link file names this server, this token and this process.
    let link = desk.link();
    assert_eq!(link["url"], format!("http://127.0.0.1:{port}"), "{link}");
    assert_eq!(link["token"], API_TOKEN);
    assert_eq!(link["enabled"], true);
    assert_eq!(link["pid"], d.child.id());

    // The events socket: only the server's token, and only agent events.
    assert!(ws(port, &format!("/api/events?token={TOKEN}"), None).await.is_err());
    let mut events = ws(port, &format!("/api/events?token={API_TOKEN}"), None).await.unwrap();
    let (_, status) = until("the socket counted", Duration::from_secs(5), || async {
        let s = post(d.port, "apiServer:status", json!([]), Some(TOKEN)).await;
        (s.1["clients"] == 1).then_some(s)
    })
    .await;
    // The three calls that reached the router; the probe and the bad body are not counted, as before.
    assert_eq!(status["requests"], 3, "{status}");
    assert!(status["lastRequestAt"].as_u64().unwrap() > 0, "{status}");

    // A CLI's `chat`: a whole turn through this server, its events on the socket.
    let opts = json!({ "sessionId": "s_cli", "providerId": "p1", "modelId": "synthetic", "text": "hi" });
    let (s, body) = call(port, "chat:send", json!([opts]), API_TOKEN).await;
    assert_eq!(s, 200, "{body}");
    let mut channels = std::collections::BTreeSet::new();
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let Some(frame) = next_json(&mut events, Duration::from_secs(5)).await else { break };
        channels.insert(frame["channel"].as_str().unwrap_or("").to_string());
        text.push_str(&frame["payload"].to_string());
        if frame["payload"]["type"] == "done" {
            break;
        }
    }
    assert_eq!(channels.into_iter().collect::<Vec<_>>(), vec!["agent:event".to_string()]);
    assert!(text.contains("hello from the cli"), "{text}");

    // An MCP entry written with no target points at this server (`integrations:target`).
    let (_, target) = post(d.port, "integrations:target", json!([]), Some(TOKEN)).await;
    assert_eq!(target, json!({ "url": format!("http://127.0.0.1:{port}"), "token": API_TOKEN }));
    let (_, snippet) = post(d.port, "integrations:snippet", json!(["claude", null]), Some(TOKEN)).await;
    assert!(snippet.to_string().contains(API_TOKEN), "{snippet}");

    // A new token: the old one stops working, the link follows.
    let (_, status) = post(d.port, "apiServer:newToken", json!([]), Some(TOKEN)).await;
    let fresh = status["settings"]["token"].as_str().unwrap().to_string();
    assert_eq!(fresh.len(), 32);
    assert_eq!(status["running"], true, "{status}");
    let (s, _, _) = api(port, reqwest::Method::GET, "/api/health", Some(API_TOKEN), None).await;
    assert_eq!(s, 401);
    let (s, _, _) = api(port, reqwest::Method::GET, "/api/health", Some(&fresh), None).await;
    assert_eq!(s, 200);
    assert_eq!(desk.link()["token"], fresh.as_str());
    assert_eq!(desk.saved()["apiServer"]["token"], fresh.as_str());

    // A port something else holds: said, not claimed to be serving.
    let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let busy = held.local_addr().unwrap().port();
    let (_, status) = post(d.port, "apiServer:save", json!([{ "port": busy }]), Some(TOKEN)).await;
    assert_eq!(status["running"], false, "{status}");
    assert!(status["error"].as_str().unwrap().starts_with("listen EADDRINUSE"), "{status}");
    let (_, status) = post(d.port, "apiServer:save", json!([{ "port": 80 }]), Some(TOKEN)).await;
    assert_eq!(status["error"], "Pick a port between 1024 and 65535.");
    drop(held);

    // Switched off: nothing listens, the link says so, and entries fall back to npx.
    let (_, status) = post(d.port, "apiServer:save", json!([{ "port": port, "enabled": false }]), Some(TOKEN)).await;
    assert_eq!(status["running"], false);
    assert!(status.get("error").is_none(), "{status}");
    assert!(reqwest::Client::new().get(format!("http://127.0.0.1:{port}/api/health")).send().await.is_err());
    assert_eq!(desk.link()["enabled"], false);
    let (_, target) = post(d.port, "integrations:target", json!([]), Some(TOKEN)).await;
    assert_eq!(target, json!({}));
    // Back on: the first "on" with no token mints one.
    let (_, status) = post(d.port, "apiServer:save", json!([{ "enabled": true, "token": "" }]), Some(TOKEN)).await;
    assert_eq!(status["running"], true, "{status}");
    assert_eq!(status["settings"]["token"].as_str().unwrap().len(), 32);

    // Quitting tells the CLI the app no longer serves.
    quit(d);
    let link = desk.link();
    assert_eq!(link["enabled"], false, "{link}");
    assert!(link.get("pid").is_none(), "{link}");
}

#[tokio::test(flavor = "multi_thread")]
async fn honours_start_on_launch_and_mints_a_first_token() {
    let desk = Desk::new("launch");
    let port = free_port();
    desk.settings(json!({ "apiServer": { "port": port, "token": API_TOKEN, "startOnLaunch": false } }));
    let d = desk.start(&[]);
    let (_, status) = until("startOnLaunch applied", Duration::from_secs(10), || async {
        let s = post(d.port, "apiServer:status", json!([]), Some(TOKEN)).await;
        (s.1["settings"]["enabled"] == false).then_some(s)
    })
    .await;
    assert_eq!(status["running"], false, "{status}");
    assert_eq!(desk.saved()["apiServer"]["enabled"], false);
    until("the link written", Duration::from_secs(10), || async { (desk.link()["enabled"] == false).then_some(()) })
        .await;
    drop(d);

    // A fresh install's server is on and gets a token rather than refusing to listen.
    let desk = Desk::new("fresh");
    let port = free_port();
    desk.settings(json!({ "apiServer": { "port": port } }));
    let d = desk.start(&[]);
    let (_, status) = until("the server up", Duration::from_secs(15), || async {
        let s = post(d.port, "apiServer:status", json!([]), Some(TOKEN)).await;
        (s.1["running"] == true).then_some(s)
    })
    .await;
    let token = status["settings"]["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 32);
    let (s, _, _) = api(port, reqwest::Method::GET, "/api/health", Some(&token), None).await;
    assert_eq!(s, 200);
    drop(d);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_webhook_listener_starts_runs_and_refuses_as_the_ts_did() {
    let desk = Desk::new("hooks");
    let work = desk.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let hook = free_port();
    desk.settings(json!({
        "workspaces": [{ "id": "w1", "path": work }],
        "apiServer": { "enabled": false },
        "experimental": { "workflowLoopbackListener": true },
    }));
    let d = desk.start(&[("NEKKO_LOOPBACK_PORT", Some(&hook.to_string()))]);
    let input = json!({
        "name": "Hook Flow",
        "steps": [{ "id": "a", "name": "Say", "kind": "shell", "run": "echo hooked" }],
        "triggers": [{ "id": "t", "kind": "webhook", "webhookSecret": "sekret" }],
    });
    let (_, wf) = post(d.port, "workflow:create", json!([input]), Some(TOKEN)).await;
    assert!(wf["id"].is_string(), "{wf}");
    let client = reqwest::Client::new();
    let url = |path: &str| format!("http://127.0.0.1:{hook}{path}");
    let res = until("the listener up", Duration::from_secs(15), || async {
        client.post(url("/api/hooks/hook-flow?key=sekret")).body(r#"{"ref":"main"}"#).send().await.ok()
    })
    .await;
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.json::<Value>().await.unwrap(), json!({ "started": 1 }));
    let (_, runs) = post(d.port, "workflow:runs", json!([wf["id"]]), Some(TOKEN)).await;
    assert_eq!(runs[0]["triggerKind"], "webhook", "{runs}");

    let cases: [(&str, &str, u16, &str); 5] = [
        ("/api/hooks/hook-flow?key=nope", "{}", 403, "unauthorized"),
        ("/api/hooks/hook-flow", "{}", 401, "missing key"),
        ("/api/hooks/hook-flow?key=sekret", "", 413, "body too large"),
        ("/api/hooks/a/b?key=sekret", "{}", 404, "not found"),
        ("/api/other?key=sekret", "{}", 404, "not found"),
    ];
    for (path, body, status, error) in cases {
        let res = client.post(url(path)).body(body).send().await.unwrap();
        assert_eq!(res.status().as_u16(), status, "{path}");
        assert_eq!(res.json::<Value>().await.unwrap()["error"], error, "{path}");
    }

    // Switched off: the port closes within a check.
    post(d.port, "settings:update", json!([{ "experimental": { "workflowLoopbackListener": false } }]), Some(TOKEN))
        .await;
    until("the listener down", Duration::from_secs(15), || async {
        client.post(url("/api/hooks/hook-flow?key=sekret")).body("{}").send().await.is_err().then_some(())
    })
    .await;
    drop(d);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_boot_work_runs_here_and_the_relay_and_listing_report_their_state() {
    let desk = Desk::new("boot");
    // A reply the last run left running, and one already marked.
    let running = json!({
        "id": "s_cut", "title": "Cut", "createdAt": 1, "updatedAt": 1, "activeRun": { "startedAt": 5 },
        "messages": [{ "id": "m1", "role": "user", "content": "go" }, { "id": "m2", "role": "assistant", "content": "half" }],
    });
    let user_last = json!({
        "id": "s_asked", "title": "Asked", "createdAt": 1, "updatedAt": 1, "activeRun": { "startedAt": 5 },
        "messages": [{ "id": "m1", "role": "user", "content": "go" }],
    });
    std::fs::write(desk.data.join("sessions/s_cut.json"), running.to_string()).unwrap();
    std::fs::write(desk.data.join("sessions/s_asked.json"), user_last.to_string()).unwrap();
    desk.settings(json!({ "apiServer": { "enabled": false } }));
    let d = desk.start(&[]);

    let (_, cut) = post(d.port, "session:get", json!(["s_cut"]), Some(TOKEN)).await;
    assert!(cut.get("activeRun").is_none(), "{cut}");
    let last = cut["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["role"], "assistant");
    assert_eq!(last["interrupted"], true);
    assert!(last["content"].as_str().unwrap().starts_with("_The app closed while this reply was running._"), "{last}");
    let (_, asked) = post(d.port, "session:get", json!(["s_asked"]), Some(TOKEN)).await;
    assert!(asked.get("activeRun").is_none(), "{asked}");
    assert_eq!(asked["messages"].as_array().unwrap().len(), 1, "a user message last gets no note");

    // The model server's provider entry exists from the first launch.
    until("the engine provider", Duration::from_secs(10), || async {
        let providers = desk.saved()["providers"].clone();
        providers
            .as_array()?
            .iter()
            .find(|p| p["kind"] == "llamacpp" && p["baseUrl"] == "http://127.0.0.1:11500/v1")
            .cloned()
    })
    .await;

    // The relay: switched on and off from here, saved beside the data. With no
    // bundled relay in this config it says why it is not running.
    let (_, relay) = post(d.port, "localRelay:status", json!([]), Some(TOKEN)).await;
    assert_eq!(
        (relay["available"].clone(), relay["running"].clone(), relay["enabled"].clone()),
        (json!(true), json!(false), json!(false))
    );
    assert_eq!(relay["port"], 4400);
    let (_, relay) = post(d.port, "localRelay:start", json!([]), Some(TOKEN)).await;
    assert_eq!(relay["enabled"], true, "{relay}");
    assert_eq!(relay["running"], false, "{relay}");
    assert!(relay["error"].is_string(), "{relay}");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(desk.data.join("local-relay.json")).unwrap()).unwrap();
    assert_eq!(saved, json!({ "enabled": true, "port": 4400 }));
    let (_, relay) = post(d.port, "localRelay:stop", json!([]), Some(TOKEN)).await;
    assert_eq!(relay["enabled"], false, "{relay}");
    // Visible on this network: off unless switched on (not switched on here, so
    // nothing is announced on this machine's network).
    let (_, vis) = post(d.port, "networkVisibility:status", json!([]), Some(TOKEN)).await;
    assert_eq!(vis, json!({ "available": true, "enabled": false, "advertising": false }));
    // The launcher: this config ships no CLI, and nothing is written.
    let (_, cli) = post(d.port, "cli:installStatus", json!([]), Some(TOKEN)).await;
    assert_eq!(cli["installed"], false, "{cli}");
    assert!(cli["message"].as_str().unwrap().contains("npm install -g nekko-agent"), "{cli}");
    let (_, cli) = post(d.port, "cli:install", json!([]), Some(TOKEN)).await;
    assert_eq!(cli["installed"], false, "{cli}");
    assert!(!desk.root.join("user-data/bin").exists());
    drop(d);
}
