//! Deterministic connectivity tests: probes and models never leave this process.
use super::*;
use std::sync::atomic::AtomicUsize;

fn monitor() -> Arc<Connectivity> {
    Connectivity::with_probe(Arc::new(|| Box::pin(std::future::pending())))
}
fn sink() -> (Sink, Arc<Mutex<Vec<Value>>>) {
    let notices = Arc::new(Mutex::new(Vec::new()));
    let n = notices.clone();
    (
        Arc::new(move |v| {
            lock(&n).push(v);
            Box::pin(async {})
        }),
        notices,
    )
}
fn allowed(on: Arc<AtomicBool>) -> Allowed {
    Arc::new(move || {
        let on = on.load(Ordering::SeqCst);
        Box::pin(async move { on })
    })
}
async fn lost(m: &Connectivity) {
    for _ in 0..3 {
        m.sample(false).await;
    }
}
async fn restored(m: &Connectivity) {
    for _ in 0..2 {
        m.sample(true).await;
    }
}
fn request() -> ChatRequest {
    ChatRequest {
        model: "synthetic".into(),
        messages: vec![],
        system: String::new(),
        tools: vec![],
        temperature: None,
        effort: None,
        think: None,
        prompt_caching: None,
        max_output_tokens: None,
    }
}
struct Model(Arc<AtomicUsize>);
struct Stream;
impl ModelClient for Model {
    type Stream = Stream;
    async fn chat(&self, _req: ChatRequest, _cancel: Cancel) -> Result<Stream, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Stream)
    }
}
impl ChunkStream for Stream {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        std::future::pending().await
    }
}

#[test]
fn loss_and_restoration_are_debounced_independently() {
    let mut d = Debounce::default();
    assert_eq!(d.sample(false), State::Unknown);
    assert_eq!(d.sample(true), State::Unknown);
    assert_eq!(d.sample(true), State::Online);
    assert_eq!(d.sample(false), State::Online);
    assert_eq!(d.sample(false), State::Online);
    assert_eq!(d.sample(false), State::Offline);
    assert_eq!(d.sample(true), State::Offline);
    assert_eq!(d.sample(false), State::Offline);
    assert_eq!(d.sample(true), State::Offline);
    assert_eq!(d.sample(true), State::Online);
}

#[test]
fn only_public_model_endpoints_need_internet() {
    for url in [
        "http://localhost:1",
        "http://127.0.0.2:1",
        "http://[::1]",
        "http://10.1.2.3",
        "http://192.168.1.2",
        "http://[fd00::1]",
        "http://host.local",
        "http://host.lan",
        "http://inference",
    ] {
        assert!(!needs_internet(&json!({"kind":"openai", "baseUrl":url})), "{url}");
    }
    assert!(!needs_internet(&json!({"kind":"ollama", "baseUrl":"https://inference.example.com"})));
    assert!(needs_internet(&json!({"kind":"openai", "baseUrl":"https://api.openai.com/v1"})));
    assert!(!needs_internet(&json!({"kind":"claude-code"})), "child harness owns its transport");
}

#[tokio::test]
async fn notices_are_deduplicated_timestamped_and_survive_turn_end_until_restoration() {
    let m = monitor();
    let (sink, notices) = sink();
    let observation = m.observe("s1", Cancel::default(), sink);
    lost(&m).await;
    m.sample(false).await;
    assert_eq!(lock(&notices).len(), 1);
    assert_eq!(lock(&notices)[0]["kind"], "lost");
    assert!(lock(&notices)[0]["createdAt"].as_i64().unwrap() > 0);
    drop(observation);
    restored(&m).await;
    m.sample(true).await;
    assert_eq!(lock(&notices).len(), 2);
    assert_eq!(lock(&notices)[1]["kind"], "restored");
    assert!(lock(&notices)[1]["content"].as_str().unwrap().contains("remains interrupted"));
    assert!(lock(&m.inner).observations.is_empty());
}

#[tokio::test]
async fn stop_or_a_new_turn_invalidates_old_observers() {
    let m = monitor();
    let (sink, notices) = sink();
    let old = m.observe("s1", Cancel::default(), sink.clone());
    lost(&m).await;
    drop(old);
    let next = m.observe("s1", Cancel::default(), sink);
    drop(next);
    restored(&m).await;
    assert_eq!(lock(&notices).len(), 1, "no stale restored notice for the old run");
    let (sink, notices) = self::sink();
    let cancel = Cancel::default();
    let _o = m.observe("s2", cancel.clone(), sink);
    lost(&m).await;
    cancel.cancel();
    restored(&m).await;
    assert_eq!(lock(&notices).len(), 1);
}

#[tokio::test]
async fn default_off_blocks_requests_and_interrupts_only_the_model_call() {
    let m = monitor();
    let (sink, _) = sink();
    let calls = Arc::new(AtomicUsize::new(0));
    let cancel = Cancel::default();
    let client =
        ConnectedClient::new(Model(calls.clone()), Some(m.clone()), allowed(Arc::new(AtomicBool::new(false))), sink);
    let mut stream = client.chat(request(), cancel.clone()).await.unwrap();
    lost(&m).await;
    assert_eq!(stream.next().await.unwrap().unwrap_err(), LOST);
    assert!(!cancel.is_cancelled(), "tool/user cancellation was not triggered");
    assert!(client.chat(request(), cancel).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!nekko_loop::is_transient_error(LOST));
    assert!(!nekko_loop::is_network_error(LOST));
}

#[tokio::test]
async fn opt_in_holds_the_same_call_then_allows_exactly_one_request() {
    let m = monitor();
    let (sink, notices) = sink();
    let calls = Arc::new(AtomicUsize::new(0));
    let cancel = Cancel::default();
    let client = Arc::new(ConnectedClient::new(
        Model(calls.clone()),
        Some(m.clone()),
        allowed(Arc::new(AtomicBool::new(true))),
        sink,
    ));
    let mut stream = client.chat(request(), cancel.clone()).await.unwrap();
    lost(&m).await;
    let reason = stream.next().await.unwrap().unwrap_err();
    assert_eq!(reason, PAUSED);
    assert!(nekko_loop::is_yield(&reason));
    let c = client.clone();
    let task = tokio::spawn(async move { c.chat(request(), cancel).await });
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    restored(&m).await;
    tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(lock(&notices).last().unwrap()["kind"], "resuming");
}

#[tokio::test]
async fn disabling_opt_in_or_stop_ends_a_restoration_wait_without_a_call() {
    for stop in [false, true] {
        let m = monitor();
        let (sink, _) = sink();
        let on = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        let cancel = Cancel::default();
        let client = Arc::new(ConnectedClient::new(Model(calls.clone()), Some(m.clone()), allowed(on.clone()), sink));
        lost(&m).await;
        let c = client.clone();
        let user_cancel = cancel.clone();
        let task = tokio::spawn(async move { c.chat(request(), user_cancel).await });
        tokio::task::yield_now().await;
        if stop {
            cancel.cancel();
        } else {
            on.store(false, Ordering::SeqCst);
        }
        assert!(tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap().is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn local_client_never_observes_or_probes_public_connectivity() {
    let m = monitor();
    let (sink, _) = sink();
    let calls = Arc::new(AtomicUsize::new(0));
    lost(&m).await;
    let client = ConnectedClient::new(Model(calls.clone()), None, allowed(Arc::new(AtomicBool::new(false))), sink);
    assert!(client.chat(request(), Cancel::default()).await.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!lock(&m.inner).running);
}

#[tokio::test]
async fn the_real_loop_retains_completed_tools_across_a_connectivity_pause() {
    use nekko_loop::{RunOptions, ToolRunner, run_agent};
    use std::collections::VecDeque;
    struct ScriptModel {
        n: AtomicUsize,
        monitor: Arc<Connectivity>,
    }
    struct ScriptStream(VecDeque<Chunk>);
    impl ChunkStream for ScriptStream {
        async fn next(&mut self) -> Option<Result<Chunk, String>> {
            self.0.pop_front().map(Ok)
        }
    }
    impl ModelClient for ScriptModel {
        type Stream = ScriptStream;
        async fn chat(&self, request: ChatRequest, _cancel: Cancel) -> Result<ScriptStream, String> {
            match self.n.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(ScriptStream(VecDeque::from([
                    Chunk::ToolCall(json!({"id":"c1","name":"write","input":{}})),
                    Chunk::Done,
                ]))),
                1 => {
                    lost(&self.monitor).await;
                    let monitor = self.monitor.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        restored(&monitor).await;
                    });
                    Err(PAUSED.into())
                }
                2 => {
                    assert!(
                        request.messages.iter().any(|m| m["role"] == "tool"),
                        "completed tool is in resumed history"
                    );
                    Ok(ScriptStream(VecDeque::from([Chunk::Text("Finished".into()), Chunk::Done])))
                }
                _ => panic!("duplicate recovery call"),
            }
        }
    }
    struct Tools(AtomicUsize);
    impl ToolRunner for Tools {
        async fn run(&self, _call: &Value) -> Result<Value, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"output":"written once"}))
        }
    }
    let m = monitor();
    let (sink, _) = sink();
    let model = ConnectedClient::new(
        ScriptModel { n: AtomicUsize::new(0), monitor: m.clone() },
        Some(m),
        allowed(Arc::new(AtomicBool::new(true))),
        sink,
    );
    let tools = Tools(AtomicUsize::new(0));
    let mut history = vec![json!({"id":"u1","role":"user","content":"Write once"})];
    let mut events = Vec::new();
    run_agent(
        RunOptions {
            session_id: "s1".into(),
            model: "synthetic".into(),
            system: String::new(),
            history: &mut history,
            tools: vec![],
            temperature: None,
            effort: None,
            think: None,
            prompt_caching: None,
            max_history_turns: None,
            context_window: None,
            max_output_tokens: None,
            image_input: None,
            resume: false,
            cancel: Cancel::default(),
            steering: Default::default(),
        },
        &model,
        &tools,
        &mut |e, _| events.push(e),
    )
    .await;
    assert_eq!(tools.0.load(Ordering::SeqCst), 1);
    assert!(events.iter().any(|e| e["type"] == "done"));
    assert!(!events.iter().any(|e| e["type"] == "error"));
    assert_eq!(history.last().unwrap()["content"], "Finished");
}
