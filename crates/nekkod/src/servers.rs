//! `servers:list` (issue #2824): the web pages served on this computer, for
//! the Agents panel's Browsers view. The probe is `nekko-machine`'s
//! `servers.rs`; this shares one scan between the windows that ask within
//! a couple of seconds of each other. Local only: never offered to phones or
//! the relay (it is not in `nekko-remote`'s channel list).

use nekko_machine::servers::{self, Server};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const CHANNELS: &[&str] = &["servers:list"];

/// Windows asking this close together share one scan.
const TTL: Duration = Duration::from_secs(3);

/// The last scan and when it ran.
type Scan = Option<(Instant, Vec<Server>)>;

fn cache() -> &'static Mutex<Scan> {
    static CACHE: OnceLock<Mutex<Scan>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub async fn route(channel: &str, _args: &[Value]) -> Result<Value, String> {
    match channel {
        "servers:list" => {
            // Held across the scan, so a second window waits for the first's answer.
            let mut slot = cache().lock().await;
            let fresh = slot.as_ref().filter(|(at, _)| at.elapsed() < TTL).map(|(_, s)| s.clone());
            let list = match fresh {
                Some(list) => list,
                None => {
                    let list = servers::servers().await;
                    *slot = Some((Instant::now(), list.clone()));
                    list
                }
            };
            serde_json::to_value(serde_json::json!({ "servers": list })).map_err(|e| e.to_string())
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}
