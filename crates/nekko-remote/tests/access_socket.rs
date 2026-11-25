//! Decision 0116: an agent on Nekko Cloud Relay dials with a ticket, renews it
//! on the open socket before it runs out, and waits out a ticket it can't get.
use futures_util::StreamExt;
use nekko_remote::{Access, AccessTicket, LinkHandle, RelayAgent, Spawn, hello, proof};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

fn spawn(url: String, access: Access) -> RelayAgent {
    let (_events, rx) = tokio::sync::mpsc::unbounded_channel();
    std::mem::forget(_events);
    RelayAgent::spawn(
        &tokio::runtime::Handle::current(),
        Spawn {
            url,
            access: Some(access),
            secret: "secret".into(),
            room: "room".into(),
            host_key: proof::new_key(&hello::os_random()),
            verify: Arc::new(|_| json!({ "type": "denied" })),
            dispatch: Arc::new(|_, _, _| Box::pin(async { Err("unused".into()) })),
            events: rx,
            terminals: nekko_remote::PhoneTerminals::new(),
            summaries: None,
            pending: None,
        },
    )
}

/// Tickets `t1`, `t2`, ... each renewed after 300 ms.
fn tickets(asked: Arc<AtomicUsize>) -> Access {
    Arc::new(move || {
        let n = asked.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(async move { Ok(AccessTicket { ticket: format!("t{n}"), renew_after: Duration::from_millis(300) }) })
    })
}

#[tokio::test]
async fn dials_with_a_ticket_and_renews_it_on_the_open_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let asked = Arc::new(AtomicUsize::new(0));
    let agent = spawn(
        format!("ws://{}/relay?role=agent&room=room&key=k", listener.local_addr().unwrap()),
        tickets(asked.clone()),
    );
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await.unwrap().unwrap();
    let query = Arc::new(Mutex::new(String::new()));
    let q = query.clone();
    #[allow(clippy::result_large_err)] // tungstenite requires its response type in the callback.
    let capture_query = move |req: &Request, res: Response| {
        *q.lock().unwrap() = req.uri().query().unwrap_or_default().to_string();
        Ok(res)
    };
    let mut ws = tokio_tungstenite::accept_hdr_async(tcp, capture_query).await.unwrap();
    assert_eq!(*query.lock().unwrap(), "role=agent&room=room&key=k&access=t1");
    // Its frames, until the renewal arrives.
    let renewed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["type"] == "access" {
                    return v;
                }
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(renewed, json!({ "type": "access", "access": "t2" }));
    assert!(agent.is_online());
    agent.stop();
}

#[tokio::test]
async fn without_a_ticket_it_does_not_dial_and_says_why() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let asked = Arc::new(AtomicUsize::new(0));
    let a = asked.clone();
    let refuse: Access = Arc::new(move || {
        a.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err("Nekko Cloud Relay is part of Pro. Upgrade to use it.".to_string()) })
    });
    let agent = spawn(format!("ws://{}/relay?role=agent&room=room&key=k", listener.local_addr().unwrap()), refuse);
    // The room key is derived first (PBKDF2, slow in a debug build), then the ticket is asked for.
    tokio::time::timeout(Duration::from_secs(20), async {
        while agent.last_error().is_none() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(300), listener.accept()).await.is_err(), "never dialed");
    assert_eq!(agent.last_error().as_deref(), Some("Nekko Cloud Relay is part of Pro. Upgrade to use it."));
    assert!(!agent.is_online());
    // Asked once, then waits a minute rather than hammering the Cloud API.
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    agent.stop();
}
