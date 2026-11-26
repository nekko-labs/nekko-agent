//! Pairing a computer found on this network, with no link to paste (CC8,
//! decision 0123; `reports/phone-discovery-pairing-proposal.md`, option C).
//!
//! While *Make a link* is open, the computer that lets others in (the host)
//! joins a one-off room on its relay, the **lobby**, and names it in its
//! network advert. A computer that picks it from *On this network* (the
//! joiner) joins the same room. The two swap one-use P-256 keys, and both
//! screens show a 6-digit code made from the lobby and both keys. Only when
//! the owner checks the codes match and taps **Pair** on the host does the
//! host seal the very link it would have shown, under the key the exchange
//! made, and send it. The joiner then pairs with it as if it had been pasted.
//!
//! The lobby is an ordinary relay room: its credential is public (it is in
//! the advert), so anyone on the network can join it. What keeps a stranger,
//! a neighbour or a dishonest relay out is the comparison: a swapped key gives
//! different codes on the two screens, and nothing is sent until the owner
//! approves. One exchange per lobby, then it closes.

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use nekko_remote::e2e::{self, Ephemeral, Key};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

/// Bound into the code and the key, so neither can be reused elsewhere.
pub const LABEL: &str = "nekko-pair-v1";
/// How long a lobby stays open: the life of the link it carries.
pub const TTL: Duration = Duration::from_secs(10 * 60);

/// The code both screens show, `"482 913"`: SHA-256 over the label, the lobby
/// and both public keys (host first), its first four bytes taken mod 10^6.
/// The keys are fixed-length base64 and the lobby fixed-length hex, so the
/// joined input reads one way only.
pub fn code(lobby: &str, host_pub: &str, joiner_pub: &str) -> String {
    let h = Sha256::new()
        .chain_update(LABEL)
        .chain_update(lobby)
        .chain_update(host_pub)
        .chain_update(joiner_pub)
        .finalize();
    let n = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

fn session(eph: &Ephemeral, theirs: &str, lobby: &str) -> Option<Key> {
    eph.session_key(theirs, &format!("{LABEL}:{lobby}"))
}

fn text(m: Message) -> Option<String> {
    match m {
        Message::Text(t) => Some(t.to_string()),
        _ => None,
    }
}

/// A frame of ours: `{"t": ..}`, else nothing (relay notices, junk).
fn ours(s: &str) -> Option<Value> {
    serde_json::from_str::<Value>(s).ok().filter(|v| v.get("t").and_then(Value::as_str).is_some())
}

/// The host's side, on its agent socket. Waits for the first joiner's
/// greeting, answers it, and asks the owner with `ask(name, code)`. The
/// socket keeps being read meanwhile (a joiner that leaves cancels the
/// question). Approved, `link` goes out sealed. True when it was sent.
pub async fn host<S, A>(
    mut ws: S,
    lobby: &str,
    link: &Value,
    ask: impl FnOnce(String, String) -> A,
) -> Result<bool, String>
where
    S: Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Sink<Message> + Unpin,
    A: Future<Output = bool>,
{
    let to = |cid: &str, data: Value| {
        Message::text(json!({ "type": "d", "cid": cid, "data": data.to_string() }).to_string())
    };
    // The first joiner that says hello with a key on the curve.
    let (cid, name, key, shown) = loop {
        let Some(m) = ws.next().await else { return Err("The relay closed the lobby.".into()) };
        let Some(frame) = m.ok().and_then(text).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        if frame["type"] != "c" {
            continue;
        }
        let (Some(cid), Some(hi)) = (frame["cid"].as_str(), frame["data"].as_str().and_then(ours)) else { continue };
        let (Some(theirs), "hi") = (hi["pub"].as_str(), hi["t"].as_str().unwrap_or_default()) else { continue };
        let eph = Ephemeral::new(&nekko_remote::hello::os_random());
        let Some(key) = session(&eph, theirs, lobby) else { continue };
        let name: String = hi["name"].as_str().unwrap_or("A computer").chars().take(60).collect();
        let shown = code(lobby, &eph.public, theirs);
        ws.send(to(cid, json!({ "t": "hi", "pub": eph.public }))).await.map_err(|_| "The relay closed the lobby.")?;
        break (cid.to_string(), name, key, shown);
    };
    let ask = ask(name, shown);
    tokio::pin!(ask);
    let yes = loop {
        tokio::select! {
            yes = &mut ask => break yes,
            m = ws.next() => match m.map(|m| m.ok().and_then(text)) {
                None => return Err("The relay closed the lobby.".into()),
                Some(Some(t)) if t.contains("client-close") && t.contains(&cid) => return Err("The other computer left before it was paired.".into()),
                _ => {}
            },
        }
    };
    let answer = if yes {
        json!({ "t": "link", "box": e2e::seal_with_iv(&key, link, e2e::random_iv()) })
    } else {
        json!({ "t": "no" })
    };
    ws.send(to(&cid, answer)).await.map_err(|_| "The relay closed the lobby.")?;
    let _ = ws.close().await;
    Ok(yes)
}

/// The joiner's side, on its client socket. Greets the host as `name`, calls
/// `shown(code)` once keys are swapped, and returns the link the host sealed
/// when its owner approved.
pub async fn join<S>(mut ws: S, lobby: &str, name: &str, shown: impl FnOnce(String)) -> Result<Value, String>
where
    S: Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Sink<Message> + Unpin,
{
    let gone = || "The other computer closed its lobby. Make a new link there and try again.".to_string();
    let eph = Ephemeral::new(&nekko_remote::hello::os_random());
    ws.send(Message::text(json!({ "t": "hi", "name": name, "pub": eph.public }).to_string()))
        .await
        .map_err(|_| gone())?;
    let mut shown = Some(shown);
    let mut key: Option<Key> = None;
    while let Some(m) = ws.next().await {
        let Some(frame) = m.ok().and_then(text).as_deref().and_then(ours) else { continue };
        match (frame["t"].as_str(), &key) {
            (Some("hi"), None) => {
                let theirs = frame["pub"].as_str().unwrap_or_default();
                key = Some(session(&eph, theirs, lobby).ok_or("The other computer sent a key that isn't one.")?);
                if let Some(f) = shown.take() {
                    f(code(lobby, theirs, &eph.public));
                }
            }
            (Some("link"), Some(k)) => {
                return e2e::open(k, frame["box"].as_str().unwrap_or_default())
                    .ok_or_else(|| "The link didn't open. Make a new link on the other computer.".to_string());
            }
            (Some("no"), _) => return Err("The other computer didn't pair.".into()),
            _ => {}
        }
    }
    Err(gone())
}

/// A lobby room id: 16 random bytes, hex. It is the room and its credential.
pub fn new_lobby() -> String {
    let mut b = [0u8; 16];
    (nekko_remote::hello::os_random())(&mut b);
    b.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    #[test]
    fn the_code_is_six_digits_and_moves_with_either_key() {
        let c = code("aa", "host", "joiner");
        assert!(c.len() == 7 && c.as_bytes()[3] == b' ' && c.replace(' ', "").bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(c, code("aa", "host", "joiner"));
        // A relay that swaps either key shows different codes on the two screens.
        assert_ne!(c, code("aa", "mallory", "joiner"));
        assert_ne!(c, code("aa", "host", "mallory"));
        assert_ne!(c, code("bb", "host", "joiner"));
    }

    /// A stand-in relay that only moves frames, as the real one does: the
    /// agent hears `{type:'c'}` and `client-close`, and its `{type:'d'}` reaches the client as is.
    #[allow(clippy::result_large_err)] // tungstenite's handshake callback type
    async fn relay() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            type Tx = tokio::sync::mpsc::UnboundedSender<Message>;
            let agent: Arc<Mutex<Option<Tx>>> = Arc::default();
            let client: Arc<Mutex<Option<Tx>>> = Arc::default();
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let (agent, client) = (agent.clone(), client.clone());
                tokio::spawn(async move {
                    let mut role = String::new();
                    let ws = tokio_tungstenite::accept_hdr_async(
                        tcp,
                        |req: &tokio_tungstenite::tungstenite::handshake::server::Request, res| {
                            role = req.uri().query().unwrap_or_default().to_string();
                            Ok(res)
                        },
                    )
                    .await
                    .unwrap();
                    let is_agent = role.contains("role=agent");
                    let (mut sink, mut stream) = ws.split();
                    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
                    *if is_agent { agent.lock() } else { client.lock() }.unwrap() = Some(tx);
                    tokio::spawn(async move {
                        while let Some(m) = rx.recv().await {
                            let _ = sink.send(m).await;
                        }
                    });
                    while let Some(Ok(Message::Text(t))) = stream.next().await {
                        if is_agent {
                            let v: Value = serde_json::from_str(&t).unwrap();
                            if let Some(c) = client.lock().unwrap().as_ref() {
                                let _ = c.send(Message::text(v["data"].as_str().unwrap().to_string()));
                            }
                        } else if let Some(a) = agent.lock().unwrap().as_ref() {
                            let _ = a.send(Message::text(
                                json!({ "type": "c", "cid": "c1", "data": t.to_string() }).to_string(),
                            ));
                        }
                    }
                    if !is_agent && let Some(a) = agent.lock().unwrap().as_ref() {
                        let _ = a.send(Message::text(json!({ "type": "client-close", "cid": "c1" }).to_string()));
                    }
                });
            }
        });
        format!("ws://{addr}")
    }

    async fn dial(
        url: String,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
        tokio_tungstenite::connect_async(url).await.unwrap().0
    }

    async fn exchange(approve: bool) -> (Result<bool, String>, Result<Value, String>, String, String) {
        let relay = relay().await;
        let lobby = new_lobby();
        let link =
            json!({ "relayUrl": "wss://relay.example", "room": "r1", "key": "k", "pair": "ABCD2345", "hostKey": "h" });
        let agent = dial(format!("{relay}/relay?role=agent&room={lobby}")).await;
        let (asked, seen) = (Arc::new(Mutex::new(String::new())), Arc::new(Mutex::new(String::new())));
        let (asked2, seen2) = (asked.clone(), seen.clone());
        let (l1, link1) = (lobby.clone(), link.clone());
        let host = tokio::spawn(async move {
            host(agent, &l1, &link1, |name, code| {
                *asked2.lock().unwrap() = format!("{name} {code}");
                async move { approve }
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let client = dial(format!("{relay}/relay?role=client&room={lobby}")).await;
        let joined = join(client, &lobby, "MacBook", move |c| *seen2.lock().unwrap() = c).await;
        let hosted = host.await.unwrap();
        let (asked, seen) = (asked.lock().unwrap().clone(), seen.lock().unwrap().clone());
        (hosted, joined, asked, seen)
    }

    #[tokio::test]
    async fn an_approved_exchange_hands_over_the_link_after_both_show_one_code() {
        let (hosted, joined, asked, seen) = exchange(true).await;
        assert_eq!(hosted, Ok(true));
        assert_eq!(asked, format!("MacBook {seen}"), "the host is asked with the joiner's name and the same code");
        assert_eq!(joined.unwrap()["pair"], "ABCD2345");
    }

    #[tokio::test]
    async fn a_declined_exchange_sends_nothing() {
        let (hosted, joined, _, _) = exchange(false).await;
        assert_eq!(hosted, Ok(false));
        assert_eq!(joined.unwrap_err(), "The other computer didn't pair.");
    }
}
