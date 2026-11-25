//! The two HTTP services the device talks to: Supabase Auth (only to prove
//! who the user is) and the Nekko Cloud API (the device token and the sealed
//! records). Neither ever receives a key or a plaintext chat.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

/// An HTTP failure with what the server said, kept short for the UI.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpError {
    pub status: u16,
    /// The API's `error` code (`plan-required`, `conflict`…), when it sent one.
    pub code: String,
    pub message: String,
    /// The API's whole JSON answer (`currentRevision`, `currentKeyId`...), or null.
    pub body: Box<Value>,
    /// What the `Retry-After` header asked for (whole seconds), when the answer had one.
    pub retry_after: Option<std::time::Duration>,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<HttpError> for String {
    fn from(e: HttpError) -> String {
        e.message
    }
}

fn network(e: impl std::fmt::Display) -> HttpError {
    HttpError {
        status: 0,
        code: "network".into(),
        message: format!("Couldn't reach Nekko Cloud: {}", short(&e.to_string())),
        body: Box::new(Value::Null),
        retry_after: None,
    }
}

fn short(s: &str) -> String {
    s.chars().take(200).collect()
}

/// How long to wait before each retry of a failed connect, which is known to have sent nothing (#3186).
const CONNECT_WAITS: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(2000)];
/// The least to wait before each of the (at most two) retries of a busy or unavailable answer. The
/// API says `retry-after: 5` after already queueing the request for up to 20 s, so asking again
/// sooner only adds load; a longer `Retry-After` from the server wins over these.
const BUSY_FLOORS: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(10)];
/// The longest `Retry-After` we honour, so a bad header can't park a call for minutes.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(60);
/// Up to this much is added on top of every wait (0 to 50%), so clients that stalled together don't retry together.
const JITTER: f64 = 0.5;

/// What kind of failure an answer was, which decides if and when it is tried again.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Stall {
    /// The connect failed: nothing reached the service.
    Connect,
    /// The service said it can't do the work right now (502, 503, a database that didn't answer).
    Busy,
    /// A 504: the gateway gave up waiting, but the work may still be running.
    GatewayTimeout,
}

fn stall(e: &HttpError) -> Option<Stall> {
    match e.status {
        0 if e.code == "unreachable" => Some(Stall::Connect),
        502 | 503 => Some(Stall::Busy),
        504 => Some(Stall::GatewayTimeout),
        // An API from before #3186 answered a database connect timeout with a bare 500.
        500 if e.code == "database-unavailable" => Some(Stall::Busy),
        _ => None,
    }
}

/// A 504 on these is never retried: the first request may still hold memory on the server, and the
/// next sync pass picks the work up again anyway (the 2026-11-25 stalls).
fn sync_transfer(path: &str) -> bool {
    path.starts_with("/v1/sync/push") || path.starts_with("/v1/sync/pull")
}

/// How many retries of each kind a call has used.
#[derive(Default)]
struct Tries {
    connect: usize,
    busy: usize,
}

/// The wait before the next retry of `err`, or `None` when it should surface now. `unit` is a
/// random number in `[0, 1)`; passing it in keeps the schedule testable.
fn next_wait(err: &HttpError, path: &str, tries: &mut Tries, unit: f64) -> Option<Duration> {
    let base = match stall(err)? {
        Stall::Connect => {
            let w = *CONNECT_WAITS.get(tries.connect)?;
            tries.connect += 1;
            w
        }
        Stall::GatewayTimeout if sync_transfer(path) => return None,
        Stall::Busy | Stall::GatewayTimeout => {
            let floor = *BUSY_FLOORS.get(tries.busy)?;
            tries.busy += 1;
            err.retry_after.map_or(floor, |ra| ra.min(RETRY_AFTER_CAP).max(floor))
        }
    };
    Some(base.mul_f64(1.0 + JITTER * unit))
}

/// A random number in `[0, 1)`.
fn unit_random() -> f64 {
    u32::from_le_bytes(nekko_sync_random::<4>()) as f64 / (u32::MAX as f64 + 1.0)
}

/// Send, and while the answer is a stall worth another try, wait (per `next_wait`) and send again.
/// `send` gives a fresh attempt each time, or `None` when the request can't be repeated.
async fn with_retries<S, SFut, W, WFut>(
    path: &str,
    mut send: S,
    mut sleep: W,
    mut unit: impl FnMut() -> f64,
) -> Result<Value, HttpError>
where
    S: FnMut() -> Option<SFut>,
    SFut: std::future::Future<Output = Result<Value, HttpError>>,
    W: FnMut(Duration) -> WFut,
    WFut: std::future::Future<Output = ()>,
{
    let mut tries = Tries::default();
    let mut result = send().expect("the first attempt is always possible").await;
    loop {
        let Err(err) = &result else { return result };
        let Some(wait) = next_wait(err, path, &mut tries, unit()) else { return result };
        let Some(again) = send() else { return result };
        sleep(wait).await;
        result = again.await;
    }
}

/// Send through Settings > Connections as `cloud-sync` and read the answer.
async fn call(rb: reqwest::RequestBuilder) -> Result<Value, HttpError> {
    match nekko_net::send("cloud-sync", rb).await {
        Ok(res) => answer(res).await,
        Err(err) => {
            // Only a failed connect is known to have sent nothing; a timeout mid-request may have done the work.
            let unreachable = matches!(&err, nekko_net::Error::Http(e) if e.is_connect());
            let mut e = network(err);
            if unreachable {
                e.code = "unreachable".into();
            }
            Err(e)
        }
    }
}

/// `call` for the Nekko Cloud API on `path`. A failed connect is retried after 0.5 s and 2 s. A
/// busy answer (502, 503, a database that didn't answer) is retried at most twice, after at least
/// 5 s and then 10 s, or the longer `Retry-After` the server sent, plus up to 50% jitter, so a
/// stalled API isn't hit again by every client at once. A 504 on sync push and pull isn't retried.
/// Supabase calls stay single: a retried sign-in code could send a second email.
async fn call_api(path: &str, rb: reqwest::RequestBuilder) -> Result<Value, HttpError> {
    // Nothing can be repeated from a body that can't be cloned: send it once.
    if rb.try_clone().is_none() {
        return call(rb).await;
    }
    with_retries(path, || rb.try_clone().map(call), tokio::time::sleep, unit_random).await
}

/// The phrases node-postgres uses when it can't open a connection in time.
fn database_unavailable(body: &Value) -> bool {
    let m = body.get("message").and_then(Value::as_str).unwrap_or("");
    m.contains("connection timeout") || m.contains("timeout exceeded when trying to connect")
}

/// What `answer` says for any 5xx: the server's own text stays in its logs.
const UNAVAILABLE: &str = "Nekko Cloud is busy right now. Try again in a moment.";

async fn answer(res: reqwest::Response) -> Result<Value, HttpError> {
    let status = res.status().as_u16();
    let retry_after = res
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    let text = res.text().await.map_err(network)?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let mut code = body.get("error").or(body.get("error_code")).and_then(Value::as_str).unwrap_or("").to_string();
    if status == 500 && database_unavailable(&body) {
        code = "database-unavailable".into();
    }
    // Nekko Cloud is switched on for Nekko Labs accounts only (#2932); say so in our words whatever the server sent.
    let invite_only = "Nekko Cloud is invite-only for now. This account isn't on the list yet.";
    let message = ["message", "msg", "error_description"]
        .iter()
        .find_map(|k| body.get(*k).and_then(Value::as_str).filter(|_| code != "account-not-available" && status < 500))
        .map(str::to_string)
        .unwrap_or_else(|| match (status, code.as_str()) {
            (_, "account-not-available") => invite_only.into(),
            (402, _) => "Sync needs a Pro or Enterprise plan.".into(),
            (401, _) => "You're signed out of Nekko Cloud. Sign in again.".into(),
            (429, _) => "Too many requests. Try again in a minute.".into(),
            (500.., "unavailable" | "database-unavailable" | "busy") | (502..=504, _) => UNAVAILABLE.into(),
            // Fastify's own 5xx carries an HTTP reason phrase ("Internal Server Error"), not one of our codes.
            (500.., c) if c.is_empty() || c.contains(' ') => {
                "Nekko Cloud ran into a problem. Try again in a moment.".into()
            }
            (_, "already-subscribed") => "You already have a plan. Use Manage billing to change it.".into(),
            (_, "no-billing-account") => {
                "The Nekko team set up your plan, so there's nothing to manage here. Email hello@nekkoagent.com to change it.".into()
            }
            (_, "") => format!("Nekko Cloud answered {status}."),
            (_, c) => c.to_string(),
        });
    Err(HttpError { status, code, message: short(&message), body: Box::new(body), retry_after })
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("nekko-agent/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("reqwest builds a default client")
}

/// A PKCE verifier and its S256 challenge.
pub fn pkce() -> (String, String) {
    let verifier = URL_SAFE_NO_PAD.encode(nekko_sync_random::<32>());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub(crate) fn nekko_sync_random<const N: usize>() -> [u8; N] {
    let mut out = [1u8; N];
    getrandom::fill(&mut out).expect("the OS random source is available");
    out
}

/// Supabase Auth (GoTrue) over REST, with the project's public anon key.
#[derive(Clone)]
pub struct Supabase {
    pub url: String,
    pub anon_key: String,
    pub http: reqwest::Client,
}

impl Supabase {
    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}/auth/v1/{path}", self.url.trim_end_matches('/')))
            .header("apikey", &self.anon_key)
            .bearer_auth(&self.anon_key)
    }

    /// Email a one-time sign-in code (and create the user on first use).
    pub async fn send_code(&self, email: &str) -> Result<(), HttpError> {
        call(self.post("otp").json(&json!({ "email": email, "create_user": true }))).await.map(|_| ())
    }

    /// The code from the email, for a Supabase access token.
    pub async fn verify_code(&self, email: &str, code: &str) -> Result<String, HttpError> {
        let v = call(self.post("verify").json(&json!({ "type": "email", "email": email, "token": code })))
            .await
            .map_err(|e| {
                if e.status == 403 || e.status == 400 {
                    HttpError { message: "That code didn't work. Check it, or send a new one.".into(), ..e }
                } else {
                    e
                }
            })?;
        access_token(&v)
    }

    /// Where the browser goes for GitHub, Google or Apple.
    pub fn authorize_url(&self, provider: &str, redirect: &str, challenge: &str) -> String {
        let q = |s: &str| -> String {
            s.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                    _ => format!("%{b:02X}"),
                })
                .collect()
        };
        format!(
            "{}/auth/v1/authorize?provider={}&redirect_to={}&code_challenge={}&code_challenge_method=s256",
            self.url.trim_end_matches('/'),
            q(provider),
            q(redirect),
            q(challenge)
        )
    }

    /// The `code` the browser brought back, for a Supabase access token.
    pub async fn exchange(&self, code: &str, verifier: &str) -> Result<String, HttpError> {
        let v = call(self.post("token?grant_type=pkce").json(&json!({ "auth_code": code, "code_verifier": verifier })))
            .await?;
        access_token(&v)
    }
}

fn access_token(v: &Value) -> Result<String, HttpError> {
    v.get("access_token").and_then(Value::as_str).map(str::to_string).ok_or(HttpError {
        status: 0,
        code: "bad-answer".into(),
        message: "Supabase didn't return a session.".into(),
        body: Box::new(Value::Null),
        retry_after: None,
    })
}

/// The Nekko Cloud API.
#[derive(Clone)]
pub struct Api {
    pub base: String,
    pub http: reqwest::Client,
}

impl Api {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base.trim_end_matches('/'))
    }

    pub async fn config(&self) -> Result<Value, HttpError> {
        call_api("/v1/auth/config", self.http.get(self.url("/v1/auth/config"))).await
    }

    pub async fn session(&self, access_token: &str, label: &str) -> Result<Value, HttpError> {
        let body = json!({ "accessToken": access_token, "label": label });
        call_api("/v1/auth/session", self.http.post(self.url("/v1/auth/session")).json(&body)).await
    }

    pub async fn get(&self, token: &str, path: &str) -> Result<Value, HttpError> {
        call_api(path, self.http.get(self.url(path)).bearer_auth(token)).await
    }

    pub async fn send(
        &self,
        token: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, HttpError> {
        let mut req = self.http.request(method, self.url(path)).bearer_auth(token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        call_api(path, req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_s256_of_the_verifier() {
        let (v, c) = pkce();
        assert_eq!(v.len(), 43);
        assert_eq!(c, URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())));
    }

    #[test]
    fn the_authorize_url_escapes_the_redirect() {
        let s = Supabase { url: "https://p.supabase.co/".into(), anon_key: "k".into(), http: client() };
        assert_eq!(
            s.authorize_url("github", "http://127.0.0.1:5123/callback", "abc"),
            "https://p.supabase.co/auth/v1/authorize?provider=github&redirect_to=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback&code_challenge=abc&code_challenge_method=s256"
        );
    }

    fn fail(status: u16, code: &str, retry_after: Option<u64>) -> HttpError {
        HttpError {
            status,
            code: code.into(),
            message: code.into(),
            body: Box::new(Value::Null),
            retry_after: retry_after.map(Duration::from_secs),
        }
    }

    fn secs(d: Option<Duration>) -> Option<f64> {
        d.map(|d| d.as_secs_f64())
    }

    #[test]
    fn a_failed_connect_keeps_the_short_schedule_and_only_twice() {
        let (err, mut t) = (fail(0, "unreachable", None), Tries::default());
        assert_eq!(secs(next_wait(&err, "/v1/auth/me", &mut t, 0.0)), Some(0.5));
        assert_eq!(secs(next_wait(&err, "/v1/auth/me", &mut t, 0.0)), Some(2.0));
        assert_eq!(next_wait(&err, "/v1/auth/me", &mut t, 0.0), None);
        // A timeout mid-request may have done the work: never retried.
        assert_eq!(next_wait(&fail(0, "network", None), "/v1/auth/me", &mut Tries::default(), 0.0), None);
    }

    #[test]
    fn busy_waits_at_least_five_then_ten_seconds_even_when_the_server_says_less() {
        let (err, mut t) = (fail(503, "busy", Some(1)), Tries::default());
        assert_eq!(secs(next_wait(&err, "/v1/auth/me", &mut t, 0.0)), Some(5.0));
        assert_eq!(secs(next_wait(&err, "/v1/auth/me", &mut t, 0.0)), Some(10.0));
        assert_eq!(next_wait(&err, "/v1/auth/me", &mut t, 0.0), None, "at most two retries");
        let (err, mut t) = (fail(503, "busy", None), Tries::default());
        assert_eq!(secs(next_wait(&err, "/v1/auth/me", &mut t, 0.0)), Some(5.0));
    }

    #[test]
    fn retry_after_is_honoured_when_longer_and_capped() {
        let (mut t, p) = (Tries::default(), "/v1/auth/me");
        assert_eq!(secs(next_wait(&fail(503, "busy", Some(30)), p, &mut t, 0.0)), Some(30.0));
        assert_eq!(secs(next_wait(&fail(503, "busy", Some(3600)), p, &mut t, 0.0)), Some(60.0));
    }

    #[test]
    fn jitter_adds_zero_to_fifty_percent() {
        let p = "/v1/auth/me";
        let e = fail(503, "busy", Some(10));
        assert_eq!(secs(next_wait(&e, p, &mut Tries::default(), 0.0)), Some(10.0));
        assert_eq!(secs(next_wait(&e, p, &mut Tries::default(), 0.5)), Some(12.5));
        let top = secs(next_wait(&e, p, &mut Tries::default(), 0.999_999)).unwrap();
        assert!(top > 14.99 && top < 15.0, "{top}");
        assert!((0.0..1.0).contains(&unit_random()));
    }

    #[test]
    fn a_504_on_sync_push_and_pull_is_not_retried_but_elsewhere_it_is() {
        let err = fail(504, "", None);
        for path in ["/v1/sync/push", "/v1/sync/pull?since=4&limit=100"] {
            assert_eq!(next_wait(&err, path, &mut Tries::default(), 0.0), None, "{path}");
        }
        assert_eq!(secs(next_wait(&err, "/v1/sync/state", &mut Tries::default(), 0.0)), Some(5.0));
        // A 503 means the API refused before doing the work, so it may be retried on push.
        assert_eq!(secs(next_wait(&fail(503, "busy", None), "/v1/sync/push", &mut Tries::default(), 0.0)), Some(5.0));
    }

    #[test]
    fn other_failures_are_never_retried() {
        for (status, code) in
            [(400, ""), (401, ""), (402, "plan-required"), (409, "conflict"), (429, ""), (500, "internal")]
        {
            assert_eq!(next_wait(&fail(status, code, Some(5)), "/v1/auth/me", &mut Tries::default(), 0.0), None);
        }
        assert!(
            next_wait(&fail(500, "database-unavailable", None), "/v1/auth/me", &mut Tries::default(), 0.0).is_some()
        );
    }

    /// Runs `with_retries` on scripted answers and a recording sleep, so nothing really waits.
    fn run(path: &str, answers: Vec<Result<Value, HttpError>>) -> (Result<Value, HttpError>, usize, Vec<f64>) {
        let answers = std::sync::Mutex::new(answers.into_iter());
        let sent = std::sync::atomic::AtomicUsize::new(0);
        let slept = std::sync::Mutex::new(Vec::new());
        let result = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(with_retries(
            path,
            || {
                sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let next = answers.lock().unwrap().next().expect("no more answers scripted");
                Some(async move { next })
            },
            |d| {
                slept.lock().unwrap().push(d.as_secs_f64());
                async {}
            },
            || 0.0,
        ));
        let sleeps = slept.into_inner().unwrap();
        (result, sent.into_inner(), sleeps)
    }

    #[test]
    fn a_busy_api_gets_three_sends_in_all_on_the_longer_schedule() {
        let busy = || Err(fail(503, "busy", Some(5)));
        let (result, sent, slept) = run("/v1/sync/state", vec![busy(), busy(), busy()]);
        assert_eq!(result.unwrap_err().status, 503);
        assert_eq!((sent, slept), (3, vec![5.0, 10.0]));
    }

    #[test]
    fn a_busy_answer_then_success_returns_the_success() {
        let (result, sent, slept) =
            run("/v1/auth/me", vec![Err(fail(503, "busy", Some(7))), Ok(json!({ "ok": true }))]);
        assert_eq!(result.unwrap(), json!({ "ok": true }));
        assert_eq!((sent, slept), (2, vec![7.0]));
    }

    #[test]
    fn a_504_on_pull_surfaces_after_one_send() {
        let (result, sent, slept) = run("/v1/sync/pull?since=0", vec![Err(fail(504, "", None))]);
        assert_eq!(result.unwrap_err().status, 504);
        assert_eq!((sent, slept), (1, vec![]));
    }

    #[test]
    fn connect_failures_then_busy_use_their_own_budgets() {
        let down = || Err(fail(0, "unreachable", None));
        let (result, sent, slept) =
            run("/v1/auth/me", vec![down(), down(), Err(fail(503, "busy", None)), Ok(json!(1))]);
        assert!(result.is_ok());
        assert_eq!((sent, slept), (4, vec![0.5, 2.0, 5.0]));
    }
}
