//! A background call steps aside when its gate says so, holds the next call
//! until the gate lets it run, and tells a yield from the turn's Stop.

use nekko_chat::{GateFuture, YieldGate, YieldingClient};
use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient, RunOptions, ToolRunner, YIELDED, run_agent};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// A gate the test opens and closes: `true` lets work run.
struct Switch(watch::Sender<bool>);

impl Switch {
    fn new(open: bool) -> Arc<Self> {
        Arc::new(Self(watch::channel(open).0))
    }
    fn set(&self, open: bool) {
        self.0.send_replace(open);
    }
}

impl YieldGate for Switch {
    fn wait_turn(&self) -> GateFuture<'_> {
        let mut rx = self.0.subscribe();
        Box::pin(async move {
            let _ = rx.wait_for(|open| *open).await;
        })
    }
    fn must_yield(&self) -> GateFuture<'_> {
        let mut rx = self.0.subscribe();
        Box::pin(async move {
            let _ = rx.wait_for(|open| !*open).await;
        })
    }
}

/// A model that streams `words` one every 10 ms and stops when its call is
/// cancelled, as the provider task does when its request is aborted.
struct Slow {
    words: usize,
    calls: AtomicUsize,
    stopped: Arc<AtomicUsize>,
}

struct SlowStream {
    left: usize,
    cancel: Cancel,
    stopped: Arc<AtomicUsize>,
}

impl ChunkStream for SlowStream {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        if self.left == 0 {
            return None;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            _ = self.cancel.cancelled() => {
                self.stopped.fetch_add(1, Ordering::SeqCst);
                self.left = 0;
                return Some(Err("This operation was aborted".into()));
            }
        }
        self.left -= 1;
        Some(Ok(if self.left == 0 { Chunk::Done } else { Chunk::Text("word ".into()) }))
    }
}

impl ModelClient for Slow {
    type Stream = SlowStream;
    async fn chat(&self, _req: ChatRequest, cancel: Cancel) -> Result<SlowStream, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(SlowStream { left: self.words, cancel, stopped: self.stopped.clone() })
    }
}

fn slow(words: usize) -> Slow {
    Slow { words, calls: AtomicUsize::new(0), stopped: Arc::default() }
}

fn req() -> ChatRequest {
    ChatRequest {
        model: "m".into(),
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

#[tokio::test(start_paused = true)]
async fn a_call_under_way_stops_when_the_gate_says_yield() {
    let gate = Switch::new(true);
    let model = slow(100);
    let stopped = model.stopped.clone();
    let client = YieldingClient::new(model, Some(gate.clone()));
    let mut stream = client.chat(req(), Cancel::default()).await.unwrap();
    for _ in 0..3 {
        assert!(matches!(stream.next().await, Some(Ok(Chunk::Text(_)))));
    }
    gate.set(false);
    let started = tokio::time::Instant::now();
    assert_eq!(stream.next().await, Some(Err(YIELDED.to_string())));
    assert!(started.elapsed() <= Duration::from_millis(10), "stops within the chunk under way");
    assert_eq!(stream.next().await, None);
    tokio::task::yield_now().await;
    assert_eq!(stopped.load(Ordering::SeqCst), 1, "the request itself was stopped");
}

#[tokio::test(start_paused = true)]
async fn the_next_call_waits_until_the_gate_opens() {
    let gate = Switch::new(false);
    let client = Arc::new(YieldingClient::new(slow(2), Some(gate.clone())));
    let pending = {
        let client = client.clone();
        tokio::spawn(async move { client.chat(req(), Cancel::default()).await.map(|_| ()) })
    };
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert!(!pending.is_finished(), "held while the user is here");
    gate.set(true);
    assert_eq!(pending.await.unwrap(), Ok(()));
}

#[tokio::test(start_paused = true)]
async fn stop_is_not_a_yield() {
    // Held at the gate: Stop ends the wait.
    let held = YieldingClient::new(slow(2), Some(Switch::new(false)));
    let cancel = Cancel::default();
    cancel.cancel();
    assert!(held.chat(req(), cancel).await.is_err_and(|e| e != YIELDED));
    // Under way: Stop stops it, and says so.
    let client = YieldingClient::new(slow(100), Some(Switch::new(true)));
    let cancel = Cancel::default();
    let mut stream = client.chat(req(), cancel.clone()).await.unwrap();
    assert!(matches!(stream.next().await, Some(Ok(_))));
    cancel.cancel();
    let end = stream.next().await;
    assert!(matches!(&end, Some(Err(e)) if e != YIELDED), "{end:?}");
}

struct NoTools;

impl ToolRunner for NoTools {
    async fn run(&self, _call: &Value) -> Result<Value, String> {
        Err("no tools".into())
    }
}

/// The whole loop: the user comes back mid-reply and leaves again; the reply
/// is the second attempt's, whole, with no word of the first.
#[tokio::test(start_paused = true)]
async fn a_reply_paused_for_the_user_finishes_once_they_leave() {
    let gate = Switch::new(true);
    let client = YieldingClient::new(slow(6), Some(gate.clone()));
    let flip = {
        let gate = gate.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            gate.set(false);
            tokio::time::sleep(Duration::from_secs(300)).await;
            gate.set(true);
        })
    };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let events = Mutex::new(Vec::new());
    let opts = RunOptions {
        session_id: "s1".into(),
        model: "m".into(),
        system: "sys".into(),
        history: &mut history,
        tools: Vec::new(),
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
    };
    let started = tokio::time::Instant::now();
    run_agent(opts, &client, &NoTools, &mut |e, _| events.lock().unwrap().push(e)).await;
    flip.await.unwrap();
    assert!(started.elapsed() >= Duration::from_secs(300), "waited for the user to leave");
    let events = events.into_inner().unwrap();
    let paused: Vec<&Value> = events.iter().filter(|e| e["type"] == "retry").collect();
    assert_eq!(paused.len(), 1);
    assert_eq!(paused[0]["paused"], json!(true));
    assert_eq!(events.last().unwrap()["type"], "done");
    assert_eq!(history.last().unwrap()["content"], json!("word word word word word "));
}

#[tokio::test(start_paused = true)]
async fn with_no_gate_the_stream_is_the_inner_one() {
    let client = YieldingClient::new(slow(3), None);
    let mut stream = client.chat(req(), Cancel::default()).await.unwrap();
    let mut chunks = 0;
    while let Some(item) = stream.next().await {
        assert!(item.is_ok());
        chunks += 1;
    }
    assert_eq!(chunks, 3);
}
