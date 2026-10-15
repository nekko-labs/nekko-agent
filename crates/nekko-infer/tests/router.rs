//! The supervisor and router against a real process: this test binary re-run
//! as a fake model server (see `fake_model_server`).

use nekko_infer::{BoxFuture, Decisions, EngineRouter, Kind, Policy, ServeConfig, SpawnOutcome, SpawnSpec, Supervisor};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const FAKE_ENV: &str = "NEKKO_INFER_FAKE_SERVER";

/// Not a test of its own: with the env var set, this process is a model
/// server on the port in its args. `/health` says "loading" for the first
/// 600 ms, then "ok"; chat completions stream five SSE chunks 100 ms apart;
/// a request for model `crash` makes it exit.
#[test]
fn fake_model_server() {
    if std::env::var(FAKE_ENV).is_err() {
        return;
    }
    // The port rides as a second test-name filter, the one extra argument the
    // test harness accepts without complaint.
    let port: u16 = std::env::args().skip(1).find_map(|a| a.parse().ok()).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async move {
        use axum::body::Body;
        use axum::routing::{get, post};
        let started = Instant::now();
        let app = axum::Router::new()
            .route(
                "/health",
                get(move || async move {
                    if started.elapsed() < Duration::from_millis(600) {
                        axum::Json(json!({ "status": "loading model" }))
                    } else {
                        axum::Json(json!({ "status": "ok" }))
                    }
                }),
            )
            .route(
                "/v1/chat/completions",
                post(|body: axum::Json<Value>| async move {
                    if body.0["model"] == "crash" {
                        std::process::exit(3);
                    }
                    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(8);
                    tokio::spawn(async move {
                        for i in 0..5 {
                            let chunk = format!(
                                "data: {}\n\n",
                                json!({ "choices": [{ "delta": { "content": format!("t{i}") } }] })
                            );
                            if tx.send(Ok(chunk.into())).await.is_err() {
                                return;
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        let _ = tx.send(Ok("data: [DONE]\n\n".into())).await;
                    });
                    let stream =
                        futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|c| (c, rx)) });
                    axum::response::Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(Body::from_stream(stream))
                        .unwrap()
                }),
            );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        println!("fake model server on {port}");
        axum::serve(listener, app).await.unwrap();
    });
}

fn spec(model: &str) -> SpawnSpec {
    SpawnSpec {
        model_id: model.into(),
        bin: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
        args: vec!["--exact".into(), "fake_model_server".into(), "{port}".into(), "--nocapture".into()],
        env: [(FAKE_ENV.to_string(), "1".to_string())].into(),
        kind: Kind::Chat,
        health_path: "/health".into(),
        health_expect: Some("\"ok\"".into()),
        budget_secs: Some(30),
    }
}

/// A policy that loads on demand by spawning the fake server.
struct Loader {
    sup: Arc<Supervisor>,
    loads: AtomicUsize,
}

impl Policy for Loader {
    fn load(&self, model: String, _image: bool) -> BoxFuture<Result<(), (u16, String)>> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        let sup = self.sup.clone();
        Box::pin(async move {
            if model == "unknown" {
                return Err((404, "No model named unknown.".into()));
            }
            match sup.spawn(spec(&model)).await {
                SpawnOutcome::Ready { .. } => Ok(()),
                SpawnOutcome::Failed { message, .. } => Err((503, message)),
            }
        })
    }
    fn models(&self) -> BoxFuture<Result<Value, String>> {
        Box::pin(async { Ok(json!({ "object": "list", "data": [{ "id": "m1" }] })) })
    }
    fn model(&self, id: String) -> BoxFuture<Result<Option<Value>, String>> {
        Box::pin(async move { Ok((id == "m1").then(|| json!({ "id": "m1" }))) })
    }
}


#[tokio::test(flavor = "multi_thread")]
async fn waits_for_ready_and_reports_the_process() {
    let sup = Arc::new(Supervisor::new());
    let t = Instant::now();
    let SpawnOutcome::Ready { port, pid } = sup.spawn(spec("m1")).await else { panic!("did not start") };
    // "loading model" for 600 ms must not count as ready.
    assert!(t.elapsed() >= Duration::from_millis(550), "ready after {:?}", t.elapsed());
    assert!(port > 0 && pid > 0);
    let list = sup.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].model_id, "m1");
    assert!(sup.kill("m1"));
    assert!(sup.list().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_process_that_exits_during_load_fails_with_its_log() {
    let sup = Arc::new(Supervisor::new());
    let mut bad = spec("broken");
    bad.args = vec!["--no-such-test-filter-flag".into()];
    let SpawnOutcome::Failed { message, .. } = sup.spawn(bad).await else {
        panic!("a broken server was reported ready")
    };
    assert!(message.contains("exited"), "{message}");
    assert!(sup.list().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_through_the_router_and_loads_on_demand() {
    let sup = Arc::new(Supervisor::new());
    let loader = Arc::new(Loader { sup: sup.clone(), loads: AtomicUsize::new(0) });
    let router = EngineRouter::new(sup.clone(), loader.clone());
    // Port 0: the router binds an OS-assigned port and reports it. Picking a
    // "free" port first and binding it later raced the parallel tests' fake
    // model servers for it ("Port ... is already in use").
    router
        .serve(ServeConfig { port: 0, host: "127.0.0.1".into(), api_key: Some("k".into()), cors_origins: vec![] })
        .await
        .unwrap();
    let port = router.serving().unwrap().port;
    let http = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}");

    // Health needs no key; everything else does.
    assert_eq!(http.get(format!("{base}/health")).send().await.unwrap().status(), 200);
    assert_eq!(http.get(format!("{base}/v1/models")).send().await.unwrap().status(), 401);
    let models: Value =
        http.get(format!("{base}/v1/models")).bearer_auth("k").send().await.unwrap().json().await.unwrap();
    assert_eq!(models["data"][0]["id"], "m1");

    // Not loaded: the policy loads it, then the reply streams through.
    let started = Instant::now();
    let mut res = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("k")
        .json(&json!({ "model": "m1", "stream": true, "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let mut first_chunk_at = None;
    let mut text = String::new();
    while let Some(chunk) = res.chunk().await.unwrap() {
        first_chunk_at.get_or_insert(started.elapsed());
        text.push_str(&String::from_utf8_lossy(&chunk));
    }
    let total = started.elapsed();
    assert!(text.contains("t0") && text.contains("t4") && text.contains("[DONE]"), "{text}");
    // Streamed, not buffered: the first chunk arrived well before the end.
    assert!(total - first_chunk_at.unwrap() >= Duration::from_millis(300), "first {first_chunk_at:?} of {total:?}");
    assert_eq!(loader.loads.load(Ordering::SeqCst), 1);

    // Loaded now: no second load, and nothing counted in flight afterwards.
    let again = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("k")
        .json(&json!({ "model": "m1", "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 200);
    let _ = again.bytes().await.unwrap();
    assert_eq!(loader.loads.load(Ordering::SeqCst), 1);
    assert_eq!(sup.list()[0].active_requests, 0);

    // Unknown models get the policy's answer.
    let unknown = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("k")
        .json(&json!({ "model": "unknown", "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);

    // Image route against a chat model is refused, not proxied.
    let wrong = http
        .post(format!("{base}/v1/images/generations"))
        .bearer_auth("k")
        .json(&json!({ "model": "m1", "prompt": "cat" }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 400);

    // Serving the same config again is a no-op, and the model keeps running.
    router
        .serve(ServeConfig { port, host: "127.0.0.1".into(), api_key: Some("k".into()), cors_origins: vec![] })
        .await
        .unwrap();
    assert_eq!(sup.list().len(), 1);
    router.stop();
    sup.kill_all();
}

/// A decision service that answers when "loaded" and echoes the question ids.
struct FakeDecisions {
    loaded: bool,
}

impl Decisions for FakeDecisions {
    fn decide(&self, body: Value) -> BoxFuture<Result<Value, (u16, String)>> {
        let loaded = self.loaded;
        Box::pin(async move {
            if !loaded {
                return Err((409, "No decision model is loaded.".into()));
            }
            let ids: Vec<String> =
                body["questions"].as_object().map(|q| q.keys().cloned().collect()).unwrap_or_default();
            Ok(
                json!({ "model": "laya", "answers": ids.iter().map(|id| (id.clone(), json!({ "type": "noul", "noul": 0.5 }))).collect::<serde_json::Map<_, _>>(), "usage": { "input_tokens": 1, "output_tokens": 0 } }),
            )
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn decisions_are_answered_in_process_behind_the_same_auth_and_cors() {
    let sup = Arc::new(Supervisor::new());
    let loader = Arc::new(Loader { sup: sup.clone(), loads: AtomicUsize::new(0) });
    let http = reqwest::Client::new();
    let body = json!({ "state": "hi", "questions": { "b": { "type": "noul", "instructions": "?" }, "a": { "type": "noul", "instructions": "?" } } });
    let config = |port| ServeConfig {
        port,
        host: "127.0.0.1".into(),
        api_key: Some("k".into()),
        cors_origins: vec!["http://app.test".into()],
    };

    // No decision service at all: a clear 409, never a proxy attempt.
    let bare = EngineRouter::new(sup.clone(), loader.clone());
    bare.serve(config(0)).await.unwrap();
    let port = bare.serving().unwrap().port;
    let res =
        http.post(format!("http://127.0.0.1:{port}/v1/decisions")).bearer_auth("k").json(&body).send().await.unwrap();
    assert_eq!(res.status(), 409);
    let err: Value = res.json().await.unwrap();
    assert!(err["error"]["message"].as_str().unwrap().contains("No decision model"), "{err}");
    bare.stop();

    for loaded in [false, true] {
        let router = EngineRouter::new(sup.clone(), loader.clone()).with_decisions(Arc::new(FakeDecisions { loaded }));
        router.serve(config(0)).await.unwrap();
        let port = router.serving().unwrap().port;
        let base = format!("http://127.0.0.1:{port}");
        assert_eq!(http.post(format!("{base}/v1/decisions")).json(&body).send().await.unwrap().status(), 401);
        for path in ["/v1/decisions", "/v1/systemone"] {
            let res = http
                .post(format!("{base}{path}"))
                .bearer_auth("k")
                .header("origin", "http://app.test")
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(res.headers().get("access-control-allow-origin").unwrap(), "http://app.test");
            if !loaded {
                assert_eq!(res.status(), 409);
                continue;
            }
            assert_eq!(res.status(), 200);
            let text = res.text().await.unwrap();
            // Question order survives the round trip (b before a).
            assert!(text.find("\"b\"").unwrap() < text.find("\"a\"").unwrap(), "{text}");
        }
        let get = http.get(format!("{base}/v1/decisions")).bearer_auth("k").send().await.unwrap();
        assert_eq!(get.status(), 405);
        let junk = http.post(format!("{base}/v1/decisions")).bearer_auth("k").body("nope").send().await.unwrap();
        assert_eq!(junk.status(), 400);
        router.stop();
    }
    assert_eq!(loader.loads.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_model_server_that_dies_is_forgotten() {
    let sup = Arc::new(Supervisor::new());
    let SpawnOutcome::Ready { port, .. } = sup.spawn(spec("crash")).await else { panic!("did not start") };
    let _ = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({ "model": "crash" }))
        .send()
        .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !sup.list().is_empty() {
        assert!(Instant::now() < deadline, "a dead model server stayed listed");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
