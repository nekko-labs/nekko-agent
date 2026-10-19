//! Sign-in and tokens.json, owned by the daemon (PF14).
//!
//! `oauth:begin/finish/cancel/status/signout` and `providers:importCliAuth`
//! for the UI, and `oauth:fresh` for the TS host, which asks here for a
//! usable token instead of renewing one itself: a renewal rotates the refresh
//! token, so the file needs one writer. The loopback listeners that receive a
//! sign-in's redirect (8765-8795 for Claude, 1455 for ChatGPT, any port for
//! OpenRouter) live here too. The requests, the responses' meaning and the
//! file format are `nekko-oauth`'s (held to oauth.ts by a golden set); this is
//! the stateful half of oauth.ts: pending sessions and their expiry, the
//! listeners, one renewal at a time per token. Owned while the daemon knows
//! the data directory. In the Local Web UI (`signIn: false`) the channels give
//! the same refusal the web backend gave.

use crate::hub::Hub;
use nekko_oauth as o;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHANNELS: &[&str] = &[
    "oauth:begin",
    "oauth:finish",
    "oauth:cancel",
    "oauth:status",
    "oauth:signout",
    "providers:importCliAuth",
    "oauth:fresh",
];

/// The Local Web UI's answer to the sign-in channels (web-channels.ts).
const UNSUPPORTED: &str = "OAuth sign-in is only available in the desktop app.";

/// Reads one CLI's credential file into a token set.
type CliParser = fn(&str, f64) -> Result<Option<Value>, String>;

/// Where the token requests go; tests point them at a local server.
#[derive(Clone)]
pub struct Endpoints {
    pub claude_token: String,
    pub chatgpt_token: String,
    pub openrouter_key: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            claude_token: o::CLAUDE_TOKEN_URL.into(),
            chatgpt_token: o::CHATGPT_TOKEN_URL.into(),
            openrouter_key: o::OPENROUTER_KEY_URL.into(),
        }
    }
}

struct Listener {
    shutdown: tokio::sync::oneshot::Sender<()>,
    done: tokio::task::JoinHandle<()>,
}

struct Session {
    provider: String,
    verifier: String,
    state: String,
    redirect_uri: String,
    expires_at: f64,
    listener: Option<Listener>,
}

pub struct OAuth {
    tokens: o::TokenStore,
    settings: Arc<nekko_settings::SettingsStore>,
    accounts: Arc<crate::accounts::Accounts>,
    hub: Hub,
    http: reqwest::Client,
    endpoints: Endpoints,
    sign_in: bool,
    sessions: Mutex<HashMap<String, Session>>,
    renewing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn arg_str(args: &[Value], i: usize) -> String {
    match args.get(i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => nekko_js::display(v),
    }
}

impl OAuth {
    pub fn new(
        dir: PathBuf,
        settings: Arc<nekko_settings::SettingsStore>,
        accounts: Arc<crate::accounts::Accounts>,
        hub: Hub,
        sign_in: bool,
        endpoints: Endpoints,
    ) -> Arc<Self> {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).https_only(true);
        // Synthetic OAuth servers use loopback HTTP only in unit-test binaries.
        #[cfg(test)]
        let http = http.https_only(false);
        Arc::new(OAuth {
            tokens: o::TokenStore::new(dir),
            settings,
            accounts,
            hub,
            http: http.build().expect("OAuth HTTPS client"),
            endpoints,
            sign_in,
            sessions: Mutex::default(),
            renewing: Mutex::default(),
        })
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        if !self.sign_in && channel != "oauth:fresh" {
            if channel == "oauth:status" {
                return Ok(
                    json!({ "tokenKey": arg_str(args, 0), "connected": false, "state": "missing", "message": UNSUPPORTED }),
                );
            }
            return Err(UNSUPPORTED.into());
        }
        match channel {
            "oauth:begin" => self.begin(&arg_str(args, 0)).await,
            "oauth:finish" => self.finish(&arg_str(args, 0), &arg_str(args, 1)).await,
            "oauth:cancel" => {
                self.close(&arg_str(args, 0)).await;
                Ok(Value::Null)
            }
            "oauth:status" => Ok(self.provider_status(&arg_str(args, 0))),
            "oauth:signout" => {
                if let Some(key) = self.provider_token_key(&arg_str(args, 0)) {
                    let me = self.clone();
                    let k = key.clone();
                    tokio::task::spawn_blocking(move || me.tokens.delete(&k)).await.map_err(|e| e.to_string())??;
                    self.accounts.route("limits:clear", &[json!(key)]).await?;
                }
                Ok(Value::Null)
            }
            "providers:importCliAuth" => {
                let me = self.clone();
                tokio::task::spawn_blocking(move || me.import_cli_auth()).await.map_err(|e| e.to_string())
            }
            "oauth:fresh" => {
                let force = args.get(1) == Some(&json!(true));
                self.ensure_fresh(&arg_str(args, 0), force).await
            }
            other => Err(format!("{other} is not an OAuth channel")),
        }
    }

    fn emit(&self, status: Value) {
        self.hub.publish("oauth:status", status, false);
    }

    fn provider_token_key(&self, provider_id: &str) -> Option<String> {
        let settings = self.settings.get();
        let provider = settings
            .get("providers")
            .and_then(Value::as_array)?
            .iter()
            .find(|p| p.get("id").and_then(Value::as_str) == Some(provider_id))?
            .clone();
        provider.get("tokenKey").filter(|k| nekko_js::truthy(Some(k))).map(nekko_js::display)
    }

    /// The host's `oauthStatus(providerConfigId)`.
    fn provider_status(&self, provider_id: &str) -> Value {
        let settings = self.settings.get();
        let provider = settings
            .get("providers")
            .and_then(Value::as_array)
            .and_then(|ps| ps.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(provider_id)).cloned());
        let key = provider.as_ref().and_then(|p| p.get("tokenKey")).filter(|k| nekko_js::truthy(Some(k)));
        let Some(key) = key.map(nekko_js::display) else {
            let message = if provider.is_some() { "Provider has no token key." } else { "Provider not found." };
            return json!({ "tokenKey": provider_id, "connected": false, "state": "missing", "message": message });
        };
        let token = self.tokens.get(&key);
        o::status(&key, token.as_ref(), if token.is_some() { "success" } else { "missing" }, None, o::now_ms())
    }

    async fn begin(self: &Arc<Self>, provider: &str) -> Result<Value, String> {
        let (verifier, challenge) = o::pkce_pair();
        let state = if provider == "claude" { verifier.clone() } else { o::generate_state() };
        let id = o::random_uuid();
        let redirect_uri = match provider {
            "claude" => o::CLAUDE_MANUAL_REDIRECT_URI.to_string(),
            "openrouter" => "http://localhost/callback".to_string(),
            _ => o::CHATGPT_REDIRECT_URI.to_string(),
        };
        let expires_at = o::now_ms() + o::SESSION_TTL_MS;
        lock(&self.sessions).insert(
            id.clone(),
            Session {
                provider: provider.to_string(),
                verifier,
                state: state.clone(),
                redirect_uri,
                expires_at,
                listener: None,
            },
        );
        {
            let (me, id) = (self.clone(), id.clone());
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(o::SESSION_TTL_MS as u64)).await;
                me.close(&id).await;
            });
        }
        let listening = self.start_loopback(&id, provider).await?;
        let mode = if listening { "loopback" } else { "manual" };
        if !listening && provider == "openrouter" {
            // OpenRouter has no paste-a-code page: without a listener it cannot finish.
            self.close(&id).await;
            return Err("Could not open a local listener for the sign-in callback. Check nothing else is saturating the port range, then try again.".into());
        }
        let redirect = lock(&self.sessions).get(&id).map(|s| s.redirect_uri.clone()).unwrap_or_default();
        let auth_url = o::authorize_url(provider, &redirect, &challenge, &state);
        self.emit(json!({ "tokenKey": "", "provider": provider, "connected": false, "state": "pending" }));
        Ok(
            json!({ "id": id, "provider": provider, "authUrl": auth_url, "mode": mode, "expiresAt": o::num(expires_at) }),
        )
    }

    /// Listen for the redirect: any port for OpenRouter, the first free one of
    /// 8765-8795 for Claude, exactly 1455 for ChatGPT (taking it back from an
    /// earlier unfinished ChatGPT sign-in of ours). False: the flow is manual.
    async fn start_loopback(self: &Arc<Self>, id: &str, provider: &str) -> Result<bool, String> {
        let ports: Vec<u16> = match provider {
            "openrouter" => vec![0],
            "claude" => o::CLAUDE_LOOPBACK_PORTS.collect(),
            _ => vec![o::CHATGPT_LOOPBACK_PORT],
        };
        for port in &ports {
            if let Some(bound) = self.listen(id, *port).await {
                self.set_redirect(id, provider, bound);
                return Ok(true);
            }
        }
        if provider == "chatgpt"
            && self.reclaim_chatgpt(id).await
            && let Some(bound) = self.listen(id, o::CHATGPT_LOOPBACK_PORT).await
        {
            self.set_redirect(id, provider, bound);
            return Ok(true);
        }
        Ok(false)
    }

    fn set_redirect(&self, id: &str, provider: &str, port: u16) {
        if let Some(s) = lock(&self.sessions).get_mut(id) {
            s.redirect_uri = match provider {
                "chatgpt" => o::CHATGPT_REDIRECT_URI.to_string(),
                _ => format!("http://localhost:{port}/callback"),
            };
        }
    }

    /// Bind loopback (IPv4, and IPv6 when it can, since `localhost` may
    /// resolve to either) and serve the callback until the session closes.
    async fn listen(self: &Arc<Self>, id: &str, port: u16) -> Option<u16> {
        let v4 = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.ok()?;
        let bound = v4.local_addr().ok()?.port();
        let v6 = tokio::net::TcpListener::bind(("::1", bound)).await.ok();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let (me, sid) = (self.clone(), id.to_string());
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let (me, sid) = (me.clone(), sid.clone());
            async move { me.callback(&sid, &uri).await }
        });
        let done = tokio::spawn(async move {
            let stop = futures_util::future::FutureExt::shared(async move {
                let _ = rx.await;
            });
            let a = axum::serve(v4, app.clone()).with_graceful_shutdown(stop.clone());
            match v6 {
                Some(v6) => {
                    let b = axum::serve(v6, app).with_graceful_shutdown(stop);
                    let _ = tokio::join!(a, b);
                }
                None => {
                    let _ = a.await;
                }
            }
        });
        let mut sessions = lock(&self.sessions);
        match sessions.get_mut(id) {
            Some(s) => {
                s.listener = Some(Listener { shutdown: tx, done });
                Some(bound)
            }
            // Closed while binding: let the listener go.
            None => {
                let _ = tx.send(());
                None
            }
        }
    }

    async fn reclaim_chatgpt(&self, current: &str) -> bool {
        let stale = lock(&self.sessions)
            .iter()
            .find(|(sid, s)| sid.as_str() != current && s.provider == "chatgpt" && s.listener.is_some())
            .map(|(sid, _)| sid.clone());
        let Some(stale) = stale else { return false };
        if let Some(done) = self.close_now(&stale) {
            let _ = tokio::time::timeout(Duration::from_millis(500), done).await;
        }
        true
    }

    /// `closeSession`: forget it and stop its listener; the listener's task,
    /// to wait for the port to free.
    fn close_now(&self, id: &str) -> Option<tokio::task::JoinHandle<()>> {
        let session = lock(&self.sessions).remove(id)?;
        let l = session.listener?;
        let _ = l.shutdown.send(());
        Some(l.done)
    }

    async fn close(&self, id: &str) {
        let _ = self.close_now(id);
    }

    async fn callback(self: Arc<Self>, sid: &str, uri: &axum::http::Uri) -> axum::response::Response {
        use axum::http::{StatusCode, header};
        use axum::response::IntoResponse;
        let plain = |code: StatusCode, body: String| (code, body).into_response();
        let Some((provider, verifier, state, redirect)) = lock(&self.sessions)
            .get(sid)
            .map(|s| (s.provider.clone(), s.verifier.clone(), s.state.clone(), s.redirect_uri.clone()))
        else {
            return plain(StatusCode::NOT_FOUND, "not found".into());
        };
        let path = url::Url::parse(&redirect).map(|u| u.path().to_string()).unwrap_or_default();
        let url =
            url::Url::parse(&format!("http://localhost{}", uri.path_and_query().map(|p| p.as_str()).unwrap_or("/")));
        let Ok(url) = url else { return plain(StatusCode::NOT_FOUND, "not found".into()) };
        if url.path() != path {
            return plain(StatusCode::NOT_FOUND, "not found".into());
        }
        let first = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
        let Some(code) = first("code").filter(|c| !c.is_empty()) else {
            return plain(StatusCode::BAD_REQUEST, "missing code".into());
        };
        // OpenRouter echoes no state; its protection is the PKCE verifier.
        if provider != "openrouter" && first("state").as_deref() != Some(state.as_str()) {
            return plain(StatusCode::BAD_REQUEST, "invalid state".into());
        }
        match self.exchange(&provider, &code, &redirect, &verifier, &state).await {
            Ok(token) => match self.save_new(sid, &provider, token).await {
                Ok(_) => (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "text/html")],
                    "<html><body>Sign-in complete. You can close this tab.</body></html>",
                )
                    .into_response(),
                Err(e) => self.callback_failed(&provider, e),
            },
            Err(e) => self.callback_failed(&provider, e),
        }
    }

    fn callback_failed(&self, provider: &str, message: String) -> axum::response::Response {
        use axum::response::IntoResponse;
        self.emit(
            json!({ "tokenKey": "", "provider": provider, "connected": false, "state": "error", "message": message }),
        );
        (
            axum::http::StatusCode::BAD_REQUEST,
            [(axum::http::header::CONTENT_TYPE, "text/plain")],
            format!("Sign-in failed: {message}"),
        )
            .into_response()
    }

    /// Store a new sign-in's token under its key, close the session and say so.
    async fn save_new(self: &Arc<Self>, sid: &str, provider: &str, token: Value) -> Result<Value, String> {
        let key = o::token_key(provider, token.get("accountId").and_then(Value::as_str), sid);
        let (me, k, t) = (self.clone(), key.clone(), token.clone());
        tokio::task::spawn_blocking(move || me.tokens.set(&k, t)).await.map_err(|e| e.to_string())??;
        self.close(sid).await;
        let status = o::status(&key, Some(&token), "success", None, o::now_ms());
        self.emit(status.clone());
        Ok(status)
    }

    async fn post(&self, req: &o::TokenRequest) -> Result<(bool, u16, String), String> {
        let url = if req.url == o::CLAUDE_TOKEN_URL {
            &self.endpoints.claude_token
        } else if req.url == o::CHATGPT_TOKEN_URL {
            &self.endpoints.chatgpt_token
        } else {
            &self.endpoints.openrouter_key
        };
        // A token or code only ever goes out over HTTPS (or to this machine, in tests).
        let url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
            return Err(format!("refusing to send a sign-in request over {}", url.scheme()));
        }
        let mut r = self.http.post(url).body(req.body.clone());
        for (k, v) in &req.headers {
            r = r.header(*k, *v);
        }
        let res = r.send().await.map_err(|e| format!("fetch failed: {e}"))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        Ok((status.is_success(), status.as_u16(), text))
    }

    async fn exchange(
        &self,
        provider: &str,
        code: &str,
        redirect: &str,
        verifier: &str,
        state: &str,
    ) -> Result<Value, String> {
        let obtained_at = o::now_ms();
        let req = o::exchange_request(provider, code, redirect, verifier, state);
        let (ok, status, text) = self.post(&req).await?;
        o::exchange_result(provider, ok, status, &text, obtained_at, o::now_ms()).map(o::Obj::into_value)
    }

    async fn finish(self: &Arc<Self>, sid: &str, pasted: &str) -> Result<Value, String> {
        let (provider, verifier, state, redirect, expires_at) = lock(&self.sessions)
            .get(sid)
            .map(|s| (s.provider.clone(), s.verifier.clone(), s.state.clone(), s.redirect_uri.clone(), s.expires_at))
            .ok_or("OAuth session not found or already completed.")?;
        if expires_at < o::now_ms() {
            self.close(sid).await;
            return Err("OAuth session has expired. Start again.".into());
        }
        let (code, pasted_state) = o::parse_pasted(pasted, &redirect)?;
        // A pasted code without a state is the documented manual fallback.
        if pasted_state.as_deref().is_some_and(|s| !s.is_empty() && s != state) {
            return Err("Invalid state parameter. The pasted code does not match this session.".into());
        }
        let token = self.exchange(&provider, &code, &redirect, &verifier, &state).await?;
        self.save_new(sid, &provider, token).await
    }

    /// The stored token set for a key (`getToken`), as saved.
    pub fn stored(&self, key: &str) -> Option<Value> {
        self.tokens.get(key)
    }

    /// `ensureFreshToken`: the stored token while it is good for another
    /// minute (or never expires), else renewed, saved and announced. One
    /// renewal at a time per token; a caller that waited sees the renewed one.
    pub async fn ensure_fresh(&self, key: &str, force: bool) -> Result<Value, String> {
        if key.is_empty() {
            return Err("No token key specified.".into());
        }
        let gate = lock(&self.renewing).entry(key.to_string()).or_default().clone();
        let _held = gate.lock().await;
        let token =
            self.tokens.get(key).ok_or_else(|| format!("No subscription token found for {key}. Sign in again."))?;
        let access = token.get("accessToken").cloned().unwrap_or(Value::Null);
        let expires_at = o::token_expires_at(&token).filter(|e| nekko_js::truthy_number(*e));
        if !force && expires_at.is_some_and(|e| e - 60_000.0 > o::now_ms()) {
            return Ok(access);
        }
        let has_refresh = nekko_js::truthy(token.get("refreshToken"));
        // An OpenRouter sign-in is a permanent API key: nothing to renew.
        if expires_at.is_none() && !has_refresh {
            return Ok(access);
        }
        if !has_refresh {
            return Err(format!("Subscription session expired for {key}. Sign in again."));
        }
        let obtained_at = o::now_ms();
        let (ok, status, text) = self.post(&o::refresh_request(&token)).await?;
        let next = o::refresh_result(&token, ok, status, &text, obtained_at, o::now_ms())?.into_value();
        self.tokens.set(key, next.clone())?;
        self.emit(o::status(key, Some(&next), "success", None, o::now_ms()));
        Ok(next.get("accessToken").cloned().unwrap_or(Value::Null))
    }

    /// `importCliAuth`: the Claude and Codex CLIs' own sign-ins, copied in.
    fn import_cli_auth(&self) -> Value {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
        let mut result = json!({ "claude": false, "chatgpt": false, "openrouter": false });
        let Some(home) = home else { return result };
        let sources: [(&str, PathBuf, CliParser); 2] = [
            ("claude", home.join(".claude").join(".credentials.json"), o::claude_cli_token),
            ("chatgpt", home.join(".codex").join("auth.json"), o::codex_cli_token),
        ];
        for (key, path, parse) in sources {
            let Ok(bytes) = std::fs::read(&path) else { continue };
            if let Ok(Some(token)) = parse(&String::from_utf8_lossy(&bytes), o::now_ms())
                && self.tokens.set(key, token).is_ok()
            {
                result[key] = json!(true);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn token_server(reply: Value) -> (String, Arc<Mutex<Vec<String>>>) {
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let s = seen.clone();
        let app = axum::Router::new().fallback(move |body: String| {
            let (s, reply) = (s.clone(), reply.clone());
            async move {
                lock(&s).push(body);
                axum::Json(reply)
            }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        (url, seen)
    }

    fn rig(name: &str, endpoints: Endpoints) -> (Arc<OAuth>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("nekkod-oauth-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let hub = Hub::new();
        let accounts = Arc::new(crate::accounts::Accounts::new(Some(dir.clone()), hub.clone()));
        let settings = Arc::new(nekko_settings::SettingsStore::new(&dir));
        (OAuth::new(dir.clone(), settings, accounts, hub, true, endpoints), dir)
    }

    #[tokio::test]
    async fn a_loopback_sign_in_lands_in_tokens_json() {
        let (url, seen) =
            token_server(json!({ "access_token": "at", "refresh_token": "rt", "expires_in": 3600 })).await;
        let (oauth, dir) = rig("loopback", Endpoints { claude_token: url, ..Endpoints::default() });
        let begun = oauth.route("oauth:begin", &[json!("claude")]).await.unwrap();
        assert_eq!(begun["mode"], "loopback");
        let auth = url::Url::parse(begun["authUrl"].as_str().unwrap()).unwrap();
        let q = |k: &str| auth.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned()).unwrap();
        let redirect = q("redirect_uri");
        let state = q("state");
        assert!(redirect.starts_with("http://localhost:87"), "{redirect}");
        let callback = redirect.replace("localhost", "127.0.0.1");
        let bad = reqwest::get(format!("{callback}?code=c&state=wrong")).await.unwrap();
        assert_eq!(bad.status(), 400);
        let ok = reqwest::get(format!(
            "{callback}?code=c&state={}",
            url::form_urlencoded::byte_serialize(state.as_bytes()).collect::<String>()
        ))
        .await
        .unwrap();
        assert_eq!(ok.status(), 200);
        let body: Value = serde_json::from_str(&lock(&seen)[0]).unwrap();
        assert_eq!((body["grant_type"].clone(), body["code"].clone()), (json!("authorization_code"), json!("c")));
        let id = begun["id"].as_str().unwrap();
        let tokens = o::TokenStore::new(&dir).load();
        let key = format!("claude:{}", &id[..8]);
        assert_eq!(tokens[&key]["accessToken"], "at");
        // The session is gone and its port free again.
        assert!(oauth.finish(id, "x").await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_token_near_expiry_is_renewed_once_and_saved() {
        let (url, seen) = token_server(json!({ "access_token": "new", "expires_in": 3600 })).await;
        let (oauth, dir) = rig("renew", Endpoints { claude_token: url, ..Endpoints::default() });
        let store = o::TokenStore::new(&dir);
        store
            .set("claude:a", json!({ "provider": "claude", "accessToken": "old", "refreshToken": "r", "expiresAt": o::now_ms() + 1000.0, "obtainedAt": 1 }))
            .unwrap();
        let (a, b) = tokio::join!(oauth.ensure_fresh("claude:a", false), oauth.ensure_fresh("claude:a", false));
        assert_eq!((a.unwrap(), b.unwrap()), (json!("new"), json!("new")));
        assert_eq!(lock(&seen).len(), 1, "one renewal for two callers");
        let saved = store.get("claude:a").unwrap();
        assert_eq!((saved["accessToken"].clone(), saved["refreshToken"].clone()), (json!("new"), json!("r")));
        assert_eq!(oauth.ensure_fresh("claude:a", false).await.unwrap(), json!("new"));
        assert!(oauth.ensure_fresh("missing", false).await.unwrap_err().contains("Sign in again"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_web_edition_refuses_sign_in() {
        let (oauth, dir) = rig("web", Endpoints::default());
        let oauth = Arc::new(OAuth { sign_in: false, ..Arc::try_unwrap(oauth).ok().unwrap() });
        assert_eq!(oauth.route("oauth:begin", &[json!("claude")]).await.unwrap_err(), UNSUPPORTED);
        assert_eq!(oauth.route("oauth:status", &[json!("p")]).await.unwrap()["message"], UNSUPPORTED);
        let _ = std::fs::remove_dir_all(dir);
    }
}
