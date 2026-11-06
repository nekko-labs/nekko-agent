//! Real websocket producer integration, with a controlled complete-read source.
use futures_util::StreamExt;
use nekko_remote::agent::activity_tag;
use nekko_remote::{ATTENTION_GAP, LinkHandle, Pending, RelayAgent, Spawn, hello, proof};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

type Reply = oneshot::Sender<Result<Value, String>>;
type Socket = WebSocketStream<TcpStream>;

fn source() -> (Pending, mpsc::UnboundedReceiver<Reply>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let read: Pending = Arc::new(move || {
        let (reply, result) = oneshot::channel();
        tx.send(reply).unwrap();
        Box::pin(async move { result.await.map_err(|_| "source closed".to_string())? })
    });
    (read, rx)
}

async fn request(rx: &mut mpsc::UnboundedReceiver<Reply>) -> Reply {
    tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap()
}

async fn next(ws: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        match ws.next().await.unwrap().unwrap() {
            Message::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("unexpected producer frame: {other:?}"),
        }
    })
    .await
    .unwrap()
}

async fn snapshot(ws: &mut Socket) -> Value {
    loop {
        let frame = next(ws).await;
        assert_ne!(frame["type"], "dismiss", "no chat-wide dismiss before a confirming snapshot");
        if frame["type"] == "attention-snapshot" {
            return frame;
        }
    }
}

struct Rig {
    agent: RelayAgent,
    events: mpsc::UnboundedSender<(String, Value)>,
    listener: TcpListener,
    ws: Socket,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.agent.stop();
    }
}

impl Rig {
    async fn new(pending: Option<Pending>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (events, rx) = mpsc::unbounded_channel();
        let agent = RelayAgent::spawn(
            &tokio::runtime::Handle::current(),
            Spawn {
                url: format!("ws://{}", listener.local_addr().unwrap()),
                secret: "secret".into(),
                room: "room".into(),
                host_key: proof::new_key(&hello::os_random()),
                verify: Arc::new(|_| json!({ "type": "denied" })),
                dispatch: Arc::new(|_, _, _| Box::pin(async { Err("unused".into()) })),
                events: rx,
                terminals: nekko_remote::PhoneTerminals::new(),
                summaries: None,
                pending,
            },
        );
        let (tcp, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await.unwrap().unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        assert_eq!(next(&mut ws).await, json!({ "type": "attention-unknown" }));
        Self { agent, events, listener, ws }
    }

    fn event(&self, payload: Value) {
        self.events.send(("agent:event".into(), payload)).unwrap();
    }

    fn gap(&self) {
        self.events.send((ATTENTION_GAP.into(), Value::Null)).unwrap();
    }
}

#[tokio::test]
async fn socket_publishes_full_sets_and_keeps_overlapping_duplicate_requests_pending() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    request(&mut reads)
        .await
        .send(Ok(json!({ "s": { "approval": {}, "question": {} }, "other": { "question": {} } })))
        .unwrap();
    let first = snapshot(&mut rig.ws).await;
    assert_eq!(first["tags"].as_array().unwrap().len(), 2);
    for n in 0..2 {
        rig.event(json!({ "type": "tool_approval_required", "sessionId": "s", "call": { "id": "a" } }));
        request(&mut reads).await.send(Ok(json!({ "s": { "approval": {}, "question": {} } }))).unwrap();
        assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("s")]));
        if n == 0 {
            assert_eq!(next(&mut rig.ws).await, json!({ "type": "dismiss", "tag": activity_tag("other") }));
        }
    }
    rig.event(json!({ "type": "tool_result", "sessionId": "s", "result": { "toolCallId": "a" } }));
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(json!({ "s": { "question": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("s")]));
    rig.event(json!({ "type": "question_resolved", "sessionId": "s", "callId": "q" }));
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
}

// The full map includes every pending chat, but each chat exposes only its
// newest approval/question. Once that input resolves the older one resurfaces
// without another approval/question event.
async fn latest_first(kind: &str, live_inputs: bool) {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    let input = |id: &str| match kind {
        "approval" => json!({ "s": { "approval": { "call": { "id": id } } } }),
        _ => json!({ "s": { "question": { "callId": id } } }),
    };
    let required = |id: &str| match kind {
        "approval" => json!({ "type": "tool_approval_required", "sessionId": "s", "call": { "id": id } }),
        _ => json!({ "type": "question", "sessionId": "s", "request": { "callId": id } }),
    };
    let resolved = |id: &str| match kind {
        "approval" => json!({ "type": "tool_result", "sessionId": "s", "result": { "toolCallId": id } }),
        _ => json!({ "type": "question_resolved", "sessionId": "s", "callId": id }),
    };
    if live_inputs {
        request(&mut reads).await.send(Ok(json!({}))).unwrap();
        assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
        for id in ["older", "latest"] {
            rig.event(required(id));
            request(&mut reads).await.send(Ok(input(id))).unwrap();
            assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("s")]));
        }
    } else {
        // Neither input's required event was observed on this connection.
        request(&mut reads).await.send(Ok(input("latest"))).unwrap();
        assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("s")]));
    }
    rig.event(resolved("latest"));
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    // A failed read must neither send the held legacy dismiss nor assert zero.
    request(&mut reads).await.send(Err("temporarily unavailable".into())).unwrap();
    loop {
        let frame = next(&mut rig.ws).await;
        assert_ne!(frame["type"], "dismiss");
        if frame["type"] == "attention-unknown" {
            break;
        }
    }
    rig.gap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(input("older"))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("s")]));
    assert!(tokio::time::timeout(Duration::from_millis(100), rig.ws.next()).await.is_err());
    rig.event(resolved("older"));
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
    assert_eq!(next(&mut rig.ws).await, json!({ "type": "dismiss", "tag": activity_tag("s") }));
    assert!(tokio::time::timeout(Duration::from_millis(100), rig.ws.next()).await.is_err());
}

#[tokio::test]
async fn two_approvals_latest_first_only_dismisses_after_both_resolve() {
    latest_first("approval", true).await;
    latest_first("approval", false).await;
}

#[tokio::test]
async fn two_questions_latest_first_only_dismisses_after_both_resolve() {
    latest_first("question", true).await;
    latest_first("question", false).await;
}

#[tokio::test]
async fn a_new_event_cancels_an_older_read_instead_of_overwriting_input() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    let old = request(&mut reads).await;
    rig.event(json!({ "type": "question", "sessionId": "new", "request": { "callId": "q" } }));
    let fresh = request(&mut reads).await;
    assert!(old.send(Ok(json!({}))).is_err(), "the old read was canceled");
    fresh.send(Ok(json!({ "new": { "question": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("new")]));
    assert!(tokio::time::timeout(Duration::from_millis(100), rig.ws.next()).await.is_err(), "no stale zero follows");
}

#[tokio::test]
async fn queued_events_win_even_when_an_old_snapshot_is_already_ready() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    let old = request(&mut reads).await;
    // Both futures become ready before the producer is polled again. A random
    // select could otherwise publish the old empty read after the new input.
    old.send(Ok(json!({}))).unwrap();
    rig.event(json!({ "type": "question", "sessionId": "new", "request": { "callId": "q" } }));
    request(&mut reads).await.send(Ok(json!({ "new": { "question": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("new")]));
}

#[tokio::test]
async fn queued_new_input_prevents_a_ready_empty_read_from_releasing_deferred_dismiss() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    request(&mut reads).await.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
    rig.event(json!({ "type": "question", "sessionId": "s", "request": { "callId": "old" } }));
    request(&mut reads).await.send(Ok(json!({ "s": { "question": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("s")]));
    rig.event(json!({ "type": "question_resolved", "sessionId": "s", "callId": "old" }));
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    let stale = request(&mut reads).await;
    // Both ready before the producer is polled; event priority must win even
    // with a chat-wide dismissal now held for the resolving question.
    stale.send(Ok(json!({}))).unwrap();
    rig.event(json!({ "type": "question", "sessionId": "s", "request": { "callId": "new" } }));
    request(&mut reads).await.send(Ok(json!({ "s": { "question": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("s")]));
    assert!(tokio::time::timeout(Duration::from_millis(100), rig.ws.next()).await.is_err());
    rig.event(json!({ "type": "question_resolved", "sessionId": "s", "callId": "new" }));
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
    assert_eq!(next(&mut rig.ws).await, json!({ "type": "dismiss", "tag": activity_tag("s") }));
}

#[tokio::test]
async fn reconnect_requires_a_new_read_and_cancels_the_old_connections_read() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    let old = request(&mut reads).await;
    rig.ws.close(None).await.unwrap();
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(10), rig.listener.accept()).await.unwrap().unwrap();
    rig.ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    let fresh = request(&mut reads).await;
    assert!(old.send(Ok(json!({ "stale": { "question": {} } }))).is_err());
    fresh.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
}

#[tokio::test]
async fn reconnect_never_replays_a_previously_authoritative_set_after_read_failure() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    request(&mut reads).await.send(Ok(json!({ "old": { "question": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("old")]));
    rig.ws.close(None).await.unwrap();
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(10), rig.listener.accept()).await.unwrap().unwrap();
    rig.ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Err("source unavailable".into())).unwrap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    assert!(tokio::time::timeout(Duration::from_millis(100), rig.ws.next()).await.is_err());
    rig.gap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
}

#[tokio::test]
async fn read_failure_and_hub_gaps_withdraw_authority_until_a_full_read() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    request(&mut reads).await.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
    rig.gap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Err("backend restarted".into())).unwrap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    rig.gap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(json!({ "recovered": { "approval": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("recovered")]));
}

#[tokio::test]
async fn a_hung_read_times_out_without_inventing_zero_and_can_recover() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    let hung = request(&mut reads).await;
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    assert!(hung.send(Ok(json!({}))).is_err(), "five-second timeout dropped the read");
    rig.gap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    request(&mut reads).await.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
}

#[tokio::test]
async fn no_callback_never_claims_authority() {
    let mut rig = Rig::new(None).await;
    rig.event(json!({ "type": "done", "sessionId": "s" }));
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    assert_eq!(next(&mut rig.ws).await["kind"], "finished");
    assert!(tokio::time::timeout(Duration::from_millis(150), rig.ws.next()).await.is_err());
}

#[tokio::test]
async fn periodic_reconciliation_removes_archived_or_deleted_chats_without_events() {
    let (read, mut reads) = source();
    let mut rig = Rig::new(Some(read)).await;
    request(&mut reads).await.send(Ok(json!({ "deleted": { "approval": {} } }))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([activity_tag("deleted")]));
    // No event is delivered. The real production thirty-second timer must read
    // the complete source again, independently of Live Activity registration.
    let read = tokio::time::timeout(Duration::from_secs(35), reads.recv()).await.unwrap().unwrap();
    assert_eq!(next(&mut rig.ws).await["type"], "attention-unknown");
    read.send(Ok(json!({}))).unwrap();
    assert_eq!(snapshot(&mut rig.ws).await["tags"], json!([]));
}
