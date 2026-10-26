//! A scripted `Http` for provider tests: canned replies in order, every request kept.

use nekko_connectors::http::{BoxFut, Response};
use nekko_connectors::{Http, Request};
use serde_json::Value;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Replies in order and the requests seen; with `watch`, whether the vault
/// file held the app key when each request went out.
#[derive(Clone, Default)]
pub struct Scripted(pub Arc<Inner>);

#[derive(Default)]
pub struct Inner {
    pub replies: Mutex<VecDeque<(u16, String, Option<String>)>>,
    pub seen: Mutex<Vec<Request>>,
    pub watch: Mutex<Option<PathBuf>>,
    pub key_seen: Mutex<Vec<bool>>,
}

impl Scripted {
    pub fn new(replies: Vec<(u16, Value)>) -> Self {
        let s = Self::default();
        for (status, body) in replies {
            s.push(status, body);
        }
        s
    }
    pub fn push(&self, status: u16, body: Value) {
        self.0.replies.lock().unwrap().push_back((status, body.to_string(), None));
    }
    /// A redirect to `location`.
    pub fn push_redirect(&self, status: u16, location: &str) {
        self.0.replies.lock().unwrap().push_back((status, String::new(), Some(location.into())));
    }
    pub fn urls(&self) -> Vec<String> {
        self.0.seen.lock().unwrap().iter().map(|r| format!("{} {}", r.method, r.url)).collect()
    }
    pub fn last(&self) -> Request {
        self.0.seen.lock().unwrap().last().unwrap().clone()
    }
    pub fn body(&self, i: usize) -> Value {
        serde_json::from_str(self.0.seen.lock().unwrap()[i].body.as_deref().unwrap()).unwrap()
    }
}

impl Http for Scripted {
    fn send(&self, req: Request) -> BoxFut<'_, Result<Response, String>> {
        if let Some(p) = self.0.watch.lock().unwrap().as_ref() {
            let held = std::fs::read_to_string(p).is_ok_and(|t| t.contains("github-app-123"));
            self.0.key_seen.lock().unwrap().push(held);
        }
        self.0.seen.lock().unwrap().push(req);
        let next = self.0.replies.lock().unwrap().pop_front();
        Box::pin(async move {
            let (status, body, location) = next.ok_or_else(|| "fetch failed".to_string())?;
            Ok(Response { status, body, location })
        })
    }
}
