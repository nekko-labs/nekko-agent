//! The one door every connector request goes through, so tests can script it.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    /// In the order the TS code wrote them.
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// `redirect: 'manual'`: never follow one.
    pub no_redirect: bool,
}

impl Request {
    pub fn get(url: impl Into<String>, headers: &[(&str, &str)]) -> Self {
        Self::new("GET", url, headers, None)
    }

    pub fn post(url: impl Into<String>, headers: &[(&str, &str)], body: Option<String>) -> Self {
        Self::new("POST", url, headers, body)
    }

    fn new(method: &'static str, url: impl Into<String>, headers: &[(&str, &str)], body: Option<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: headers.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect(),
            body,
            no_redirect: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    /// `res.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Sends a request; `Err` is a network failure (`fetch` rejecting).
pub trait Http: Send + Sync {
    fn send(&self, req: Request) -> BoxFut<'_, Result<Response, String>>;
}

/// Node's `fetch` rejects with this for any network failure.
pub const FETCH_FAILED: &str = "fetch failed";

/// The real network.
pub struct Net {
    follow: reqwest::Client,
    manual: reqwest::Client,
}

impl Default for Net {
    fn default() -> Self {
        // Node's fetch waits five minutes for a response's headers.
        let build = |redirect| {
            reqwest::Client::builder().timeout(Duration::from_secs(300)).redirect(redirect).build().unwrap_or_default()
        };
        Self { follow: build(reqwest::redirect::Policy::limited(20)), manual: build(reqwest::redirect::Policy::none()) }
    }
}

impl Http for Net {
    fn send(&self, req: Request) -> BoxFut<'_, Result<Response, String>> {
        Box::pin(async move {
            let client = if req.no_redirect { &self.manual } else { &self.follow };
            let mut b = if req.method == "POST" { client.post(&req.url) } else { client.get(&req.url) };
            for (k, v) in &req.headers {
                b = b.header(k, v);
            }
            if let Some(body) = req.body {
                // fetch sends a string body as text/plain unless a header says otherwise.
                if !req.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
                    b = b.header("content-type", "text/plain;charset=UTF-8");
                }
                b = b.body(body);
            }
            let res = b.send().await.map_err(|_| FETCH_FAILED.to_string())?;
            let status = res.status().as_u16();
            let body = res.text().await.map_err(|_| FETCH_FAILED.to_string())?;
            Ok(Response { status, body })
        })
    }
}
