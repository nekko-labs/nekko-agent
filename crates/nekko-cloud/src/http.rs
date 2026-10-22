//! The two HTTP services the device talks to: Supabase Auth (only to prove
//! who the user is) and the Nekko Cloud API (the device token and the sealed
//! records). Neither ever receives a key or a plaintext chat.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// An HTTP failure with what the server said, kept short for the UI.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpError {
    pub status: u16,
    /// The API's `error` code (`plan-required`, `conflict`…), when it sent one.
    pub code: String,
    pub message: String,
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

fn network(e: reqwest::Error) -> HttpError {
    HttpError {
        status: 0,
        code: "network".into(),
        message: format!("Couldn't reach Nekko Cloud: {}", short(&e.to_string())),
    }
}

fn short(s: &str) -> String {
    s.chars().take(200).collect()
}

async fn answer(res: reqwest::Response) -> Result<Value, HttpError> {
    let status = res.status().as_u16();
    let text = res.text().await.map_err(network)?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let code = body.get("error").or(body.get("error_code")).and_then(Value::as_str).unwrap_or("").to_string();
    let message = ["message", "msg", "error_description"]
        .iter()
        .find_map(|k| body.get(*k).and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| match (status, code.as_str()) {
            (402, _) => "Sync needs a Pro or Team plan.".into(),
            (401, _) => "You're signed out of Nekko Cloud. Sign in again.".into(),
            (429, _) => "Too many requests. Try again in a minute.".into(),
            (_, "") => format!("Nekko Cloud answered {status}."),
            (_, c) => c.to_string(),
        });
    Err(HttpError { status, code, message: short(&message) })
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
        answer(self.post("otp").json(&json!({ "email": email, "create_user": true })).send().await.map_err(network)?)
            .await
            .map(|_| ())
    }

    /// The code from the email, for a Supabase access token.
    pub async fn verify_code(&self, email: &str, code: &str) -> Result<String, HttpError> {
        let v = answer(
            self.post("verify")
                .json(&json!({ "type": "email", "email": email, "token": code }))
                .send()
                .await
                .map_err(network)?,
        )
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
        let v = answer(
            self.post("token?grant_type=pkce")
                .json(&json!({ "auth_code": code, "code_verifier": verifier }))
                .send()
                .await
                .map_err(network)?,
        )
        .await?;
        access_token(&v)
    }
}

fn access_token(v: &Value) -> Result<String, HttpError> {
    v.get("access_token").and_then(Value::as_str).map(str::to_string).ok_or(HttpError {
        status: 0,
        code: "bad-answer".into(),
        message: "Supabase didn't return a session.".into(),
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
        answer(self.http.get(self.url("/v1/auth/config")).send().await.map_err(network)?).await
    }

    pub async fn session(&self, access_token: &str, label: &str) -> Result<Value, HttpError> {
        let body = json!({ "accessToken": access_token, "label": label });
        answer(self.http.post(self.url("/v1/auth/session")).json(&body).send().await.map_err(network)?).await
    }

    pub async fn get(&self, token: &str, path: &str) -> Result<Value, HttpError> {
        answer(self.http.get(self.url(path)).bearer_auth(token).send().await.map_err(network)?).await
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
        answer(req.send().await.map_err(network)?).await
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
}
