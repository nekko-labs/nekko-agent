//! Subscription sign-in (ChatGPT) and OpenRouter's key sign-in, for the
//! engine daemon, which writes `tokens.json` alone. Claude sign-in is an
//! empty approved-client slot (`CLAUDE_APPROVED_CLIENT`): not offered.
//!
//! A port of the pure half of the TS host's `oauth.ts`: the authorize URLs,
//! reading a pasted code or redirect URL, the token requests and what their
//! responses become (token sets or the errors a sign-in fails with), the
//! status the UI is shown, the Codex CLI credential import, and the token
//! store. Token sets keep the TS object literals' key order, with
//! `undefined` fields left out as `JSON.stringify` leaves them out, so the
//! file and every value handed back are what the TS host produced.
//! `tests/golden.rs` holds it to the TS functions
//! (packages/host/src/oauth.golden.test.ts writes the expected set). The
//! stateful half (pending sessions, loopback listeners, renewal) is
//! `crates/nekkod/src/oauth.rs`.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// An OAuth client a vendor issued to Nekko Agent itself; every field is
/// `None` until the vendor hands one over (`ApprovedOAuthClient` in
/// packages/shared/src/oauth-providers.ts).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ApprovedClient {
    /// `false` while awaiting approval.
    pub enabled: bool,
    pub client_id: Option<&'static str>,
    pub authorize_url: Option<&'static str>,
    pub token_url: Option<&'static str>,
    pub scopes: Option<&'static str>,
}

/// The approved-client slot for Claude sign-in (`CLAUDE_APPROVED_CLIENT`).
///
/// Anthropic does not let third-party apps offer Claude.ai login or send
/// requests on a Claude plan's credentials, so the slot is empty and Claude
/// sign-in is not offered. If Anthropic ever issues Nekko Agent its own
/// client, filling it (and the TS mirror) in one reviewed PR turns it on.
/// Never put another app's client id here: scripts/check-claude-compliance.mjs
/// fails CI if this slot is filled.
pub const CLAUDE_APPROVED_CLIENT: ApprovedClient =
    ApprovedClient { enabled: false, client_id: None, authorize_url: None, token_url: None, scopes: None };

/// `CLAUDE_SIGN_IN_UNAVAILABLE`: what a Claude sign-in fails with.
pub const CLAUDE_SIGN_IN_UNAVAILABLE: &str = "Nekko Agent cannot sign in to Claude plans. Use Claude with an API key or a cloud account, or connect Claude Agent to run your installed Claude Code.";

pub const CHATGPT_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CHATGPT_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const CHATGPT_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const CHATGPT_SCOPES: &str = "openid profile email offline_access";
pub const CHATGPT_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
pub const CHATGPT_LOOPBACK_PORT: u16 = 1455;

pub const OPENROUTER_AUTHORIZE_URL: &str = "https://openrouter.ai/auth";
pub const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/auth/keys";

/// Milliseconds a pending sign-in stays valid.
pub const SESSION_TTL_MS: f64 = 10.0 * 60.0 * 1000.0;
/// ChatGPT CLI access tokens are valid for 10 days after `last_refresh`.
const CHATGPT_CLI_TOKEN_TTL_MS: f64 = 10.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `Date.now()`.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// A number as JSON holds it: whole numbers as integers, so the wire
/// carries `1760000000000`, not `1760000000000.0`.
pub fn num(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// An object literal with JavaScript's `undefined`: every key keeps its
/// place, and the undefined ones are left out when it becomes JSON.
#[derive(Clone, Debug, Default)]
pub struct Obj(Vec<(&'static str, Option<Value>)>);

impl Obj {
    pub fn new(fields: Vec<(&'static str, Option<Value>)>) -> Self {
        Obj(fields)
    }

    pub fn get(&self, k: &str) -> Option<&Value> {
        self.0.iter().find(|(key, _)| *key == k).and_then(|(_, v)| v.as_ref())
    }

    pub fn set(&mut self, k: &'static str, v: Option<Value>) {
        match self.0.iter_mut().find(|(key, _)| *key == k) {
            Some(slot) => slot.1 = v,
            None => self.0.push((k, v)),
        }
    }

    pub fn into_value(self) -> Value {
        Value::Object(self.0.into_iter().filter_map(|(k, v)| v.map(|v| (k.to_string(), v))).collect())
    }
}

/// `x ?? y` over values that may be undefined (`None`).
fn coalesce(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    match a {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => b.cloned(),
    }
}

/// `obj.key` for any JSON value: only objects have own keys here.
fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(Value::as_object).and_then(|m| m.get(key))
}

/// `JSON.parse(text)`, or `undefined` (`safeJson`).
fn safe_json(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// `Buffer.from(s, 'base64url')`: both alphabets, other characters skipped,
/// stopping at the first `=`, a trailing partial byte dropped.
pub fn base64url_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// A URL-safe base64 string without padding (`toString('base64url')`).
pub fn base64url_encode(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    let _ = getrandom::fill(&mut b);
    b
}

/// `pkcePair()`: a 32-byte verifier and its S256 challenge.
pub fn pkce_pair() -> (String, String) {
    use sha2::Digest;
    let verifier = base64url_encode(&random_bytes(32));
    let challenge = base64url_encode(&sha2::Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// `generateState()`.
pub fn generate_state() -> String {
    base64url_encode(&random_bytes(16))
}

/// `randomUUID()`.
pub fn random_uuid() -> String {
    let mut b = random_bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// `URLSearchParams` serialization (application/x-www-form-urlencoded).
fn form(pairs: &[(&str, &str)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

/// `oauthProviderOffered`: whether the app offers sign-in through `provider`.
pub fn provider_offered(provider: &str) -> bool {
    provider != "claude" || claude_client().is_some()
}

/// A PKCE client: who we sign in as, where, and for what.
#[derive(Clone, Copy, Debug)]
struct SignInClient {
    client_id: &'static str,
    authorize_url: &'static str,
    token_url: &'static str,
    scopes: &'static str,
}

const CHATGPT_CLIENT: SignInClient = SignInClient {
    client_id: CHATGPT_CLIENT_ID,
    authorize_url: CHATGPT_AUTHORIZE_URL,
    token_url: CHATGPT_TOKEN_URL,
    scopes: CHATGPT_SCOPES,
};

/// The approved Claude client, once the slot is filled and enabled.
fn claude_client() -> Option<SignInClient> {
    let c = CLAUDE_APPROVED_CLIENT;
    if !c.enabled {
        return None;
    }
    Some(SignInClient {
        client_id: c.client_id.filter(|s| !s.is_empty())?,
        authorize_url: c.authorize_url.filter(|s| !s.is_empty())?,
        token_url: c.token_url.filter(|s| !s.is_empty())?,
        scopes: c.scopes.unwrap_or(""),
    })
}

/// `signInClient`: ChatGPT's, or Claude's approved one; anything else fails.
fn sign_in_client(provider: &str) -> Result<SignInClient, String> {
    match provider {
        "chatgpt" => Ok(CHATGPT_CLIENT),
        "claude" => claude_client().ok_or_else(|| CLAUDE_SIGN_IN_UNAVAILABLE.to_string()),
        _ => Err(format!("No sign-in client for {provider}.")),
    }
}

/// `buildAuthorizeUrl`.
pub fn authorize_url(provider: &str, redirect_uri: &str, challenge: &str, state: &str) -> Result<String, String> {
    if provider == "openrouter" {
        // OpenRouter calls the redirect `callback_url` and takes no client_id, scope or state.
        let q =
            form(&[("callback_url", redirect_uri), ("code_challenge", challenge), ("code_challenge_method", "S256")]);
        return Ok(format!("{OPENROUTER_AUTHORIZE_URL}?{q}"));
    }
    let client = sign_in_client(provider)?;
    let pairs = [
        ("response_type", "code"),
        ("client_id", client.client_id),
        ("redirect_uri", redirect_uri),
        ("scope", client.scopes),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ];
    Ok(format!("{}?{}", client.authorize_url, form(&pairs)))
}

/// `makeTokenKey`.
pub fn token_key(provider: &str, account_id: Option<&str>, session_id: &str) -> String {
    match account_id {
        Some(id) => format!("{provider}:{id}"),
        None => {
            format!("{provider}:{}", String::from_utf16_lossy(&session_id.encode_utf16().take(8).collect::<Vec<_>>()))
        }
    }
}

/// `parsePasted`: a code and optional state from a raw code, `code#state`,
/// or the redirect URL itself.
pub fn parse_pasted(pasted: &str, redirect_uri: &str) -> Result<(String, Option<String>), String> {
    let trimmed = nekko_js::trim(pasted);
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = url::Url::parse(trimmed).map_err(|_| "Invalid URL".to_string())?;
        let redirect = url::Url::parse(redirect_uri).map_err(|_| "Invalid URL".to_string())?;
        let host = |u: &url::Url| u.host_str().unwrap_or_default().to_lowercase();
        if host(&url) != host(&redirect) || url.path() != redirect.path() {
            return Err("Pasted URL does not match this session's redirect URI.".into());
        }
        let first = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
        let code = first("code").filter(|c| !c.is_empty()).ok_or("No authorization code found in the URL.")?;
        return Ok((code, first("state")));
    }
    if let Some((code, rest)) = trimmed.split_once('#') {
        let state = rest.split('#').next().unwrap_or_default();
        return Ok((code.to_string(), Some(state.to_string())));
    }
    Ok((trimmed.to_string(), None))
}

/// A JWT's payload, decoded and parsed, if it has one.
fn jwt_payload(jwt: &str) -> Option<Value> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    serde_json::from_str(&String::from_utf8_lossy(&base64url_decode(parts[1]))).ok()
}

/// `cleanEmail`: a plausible email address, trimmed (display only).
pub fn clean_email(raw: Option<&Value>) -> Option<String> {
    let email = nekko_js::trim(raw?.as_str()?);
    let (local, domain) = email.split_once('@')?;
    let plain = |p: &str| !p.is_empty() && !p.chars().any(|c| c == '@' || nekko_js::is_js_space(c));
    (email.encode_utf16().count() <= 254 && plain(local) && plain(domain)).then(|| email.to_string())
}

/// `extractEmail`: the `email` claim of a ChatGPT id token.
pub fn extract_email(id_token: &str) -> Option<String> {
    clean_email(prop(Some(&jwt_payload(id_token)?), "email"))
}

/// `extractAccountId`: the ChatGPT account id an id token carries.
pub fn extract_account_id(id_token: &str) -> Option<String> {
    let json = jwt_payload(id_token)?;
    prop(prop(Some(&json), "https://api.openai.com/auth"), "chatgpt_account_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `expFromJwt`: the `exp` claim in epoch milliseconds.
pub fn exp_from_jwt(jwt: Option<&Value>) -> Option<f64> {
    let json = jwt_payload(jwt?.as_str()?)?;
    prop(Some(&json), "exp").and_then(Value::as_f64).map(|e| e * 1000.0)
}

/// `tokenExpiresAt`: the stored expiry, else a ChatGPT JWT's.
pub fn token_expires_at(t: &Value) -> Option<f64> {
    match t.get("expiresAt") {
        Some(e) if nekko_js::truthy(Some(e)) => Some(nekko_js::to_number(Some(e))),
        _ if t.get("provider").and_then(Value::as_str) == Some("chatgpt") => exp_from_jwt(t.get("accessToken")),
        _ => None,
    }
}

/// `tokenFromResponse`, with `now` for `Date.now()`.
pub fn token_from_response(provider: &str, json: &Value, obtained_at: f64, now: f64) -> Result<Obj, String> {
    let access = coalesce(prop(Some(json), "access_token"), prop(Some(json), "key"));
    if !nekko_js::truthy(access.as_ref()) {
        return Err("Token response missing access_token.".into());
    }
    if provider == "openrouter" {
        return Ok(Obj::new(vec![
            ("provider", Some(json!(provider))),
            ("accessToken", access),
            ("obtainedAt", Some(num(obtained_at))),
        ]));
    }
    let chatgpt = provider == "chatgpt";
    let id_token = prop(Some(json), "id_token");
    let account_id = if chatgpt && nekko_js::truthy(id_token) {
        match id_token {
            Some(Value::String(s)) => extract_account_id(s).map(Value::String),
            // `idToken.split` on a value that is not a string throws.
            _ => return Err("idToken.split is not a function".into()),
        }
    } else {
        None
    };
    let account_email = match id_token {
        Some(Value::String(s)) if !s.is_empty() => extract_email(s),
        _ => None,
    };
    let expires_in = prop(Some(json), "expires_in").and_then(Value::as_f64).unwrap_or(3600.0);
    let jwt_exp = if chatgpt { exp_from_jwt(access.as_ref()) } else { None };
    let expires_at = jwt_exp.unwrap_or(now + expires_in * 1000.0);
    Ok(Obj::new(vec![
        ("provider", Some(json!(provider))),
        ("accessToken", access),
        ("refreshToken", prop(Some(json), "refresh_token").cloned()),
        ("expiresAt", Some(num(expires_at))),
        ("accountId", account_id),
        ("accountEmail", account_email.map(Value::String)),
        ("scopes", prop(Some(json), "scope").cloned()),
        ("obtainedAt", Some(num(obtained_at))),
    ]))
}

/// A token endpoint request.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenRequest {
    pub url: String,
    pub headers: Vec<(&'static str, &'static str)>,
    pub body: String,
}

impl TokenRequest {
    pub fn to_value(&self) -> Value {
        let headers: Map<String, Value> = self.headers.iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
        json!({ "url": self.url, "headers": headers, "body": self.body })
    }
}

const JSON_HEADERS: [(&str, &str); 2] = [("Content-Type", "application/json"), ("Accept", "application/json")];
const FORM_HEADERS: [(&str, &str); 2] =
    [("Content-Type", "application/x-www-form-urlencoded"), ("Accept", "application/json")];

/// `exchangeRequest`.
pub fn exchange_request(
    provider: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
    _state: &str,
) -> Result<TokenRequest, String> {
    if provider == "openrouter" {
        return Ok(TokenRequest {
            url: OPENROUTER_KEY_URL.into(),
            headers: JSON_HEADERS.to_vec(),
            body: nekko_js::stringify(
                &json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }),
            ),
        });
    }
    let client = sign_in_client(provider)?;
    Ok(TokenRequest {
        url: client.token_url.into(),
        headers: FORM_HEADERS.to_vec(),
        body: form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client.client_id),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ]),
    })
}

/// `String(safeJson(text)?.error_description ?? text.slice(0, 200) ?? ...)`.
fn error_text(text: &str) -> String {
    let parsed = safe_json(text);
    match prop(parsed.as_ref(), "error_description") {
        Some(v) if !v.is_null() => nekko_js::display(v),
        _ => nekko_js::slice16(text, 200).to_string(),
    }
}

/// `exchangeResult`: a redeemed code's response as a token set, or the error.
pub fn exchange_result(
    provider: &str,
    ok: bool,
    status: u16,
    text: &str,
    obtained_at: f64,
    now: f64,
) -> Result<Obj, String> {
    if provider == "openrouter" {
        if !ok {
            let body = safe_json(text);
            let err = match (prop(prop(body.as_ref(), "error"), "message"), prop(body.as_ref(), "error_description")) {
                (Some(m), _) if !m.is_null() => nekko_js::display(m),
                (_, Some(d)) if !d.is_null() => nekko_js::display(d),
                _ => {
                    let cut = nekko_js::slice16(text, 200);
                    if cut.is_empty() { format!("HTTP {status}") } else { cut.to_string() }
                }
            };
            return Err(format!("Key exchange failed: {err}"));
        }
        let json = safe_json(text).unwrap_or(Value::Null);
        if !nekko_js::truthy(prop(Some(&json), "key")) {
            return Err("OpenRouter returned no API key.".into());
        }
        return token_from_response(provider, &json, obtained_at, now);
    }
    if !ok {
        return Err(format!("Token exchange failed: {}", error_text(text)));
    }
    let json = safe_json(text).filter(|v| nekko_js::truthy(Some(v))).ok_or("Token response was not valid JSON.")?;
    let token = token_from_response(provider, &json, obtained_at, now)?;
    if provider == "chatgpt" && !nekko_js::truthy(token.get("accountId")) {
        return Err("Could not read your ChatGPT account id from the sign-in response.".into());
    }
    Ok(token)
}

/// `refreshRequest`.
pub fn refresh_request(token: &Value) -> Result<TokenRequest, String> {
    let provider = match token.get("provider") {
        Some(Value::String(s)) => s.clone(),
        Some(v) if !v.is_null() => nekko_js::display(v),
        _ => "undefined".into(),
    };
    let client = sign_in_client(&provider)?;
    let refresh = match token.get("refreshToken") {
        None | Some(Value::Null) => String::new(),
        Some(v) => nekko_js::display(v),
    };
    Ok(TokenRequest {
        url: client.token_url.into(),
        headers: FORM_HEADERS.to_vec(),
        body: form(&[("grant_type", "refresh_token"), ("client_id", client.client_id), ("refresh_token", &refresh)]),
    })
}

/// `refreshResult`: a renewal's response as the next token set, or the error.
pub fn refresh_result(
    token: &Value,
    ok: bool,
    status: u16,
    text: &str,
    obtained_at: f64,
    now: f64,
) -> Result<Obj, String> {
    if !ok {
        let err = error_text(text);
        let lower = err.to_lowercase();
        if status == 401 || ["invalid_grant", "expired", "revoked"].iter().any(|w| lower.contains(w)) {
            return Err("Subscription session expired. Sign in again.".into());
        }
        return Err(format!("Token refresh failed: {err}"));
    }
    let json =
        safe_json(text).filter(|v| nekko_js::truthy(Some(v))).ok_or("Token refresh response was not valid JSON.")?;
    let provider = token.get("provider").and_then(Value::as_str).unwrap_or_default();
    let mut next = token_from_response(provider, &json, obtained_at, now)?;
    let nullish = |o: &Obj, k: &str| o.get(k).is_none_or(Value::is_null);
    if nullish(&next, "refreshToken") {
        next.set("refreshToken", token.get("refreshToken").cloned());
    }
    if nullish(&next, "accountId") && nekko_js::truthy(token.get("accountId")) {
        next.set("accountId", token.get("accountId").cloned());
    }
    if nullish(&next, "accountEmail") && nekko_js::truthy(token.get("accountEmail")) {
        next.set("accountEmail", token.get("accountEmail").cloned());
    }
    if nullish(&next, "scopes") && nekko_js::truthy(token.get("scopes")) {
        next.set("scopes", token.get("scopes").cloned());
    }
    Ok(next)
}

/// `buildStatus`, with `now` for `Date.now()`. Never carries a token.
pub fn status(token_key: &str, token: Option<&Value>, state: &str, message: Option<&str>, now: f64) -> Value {
    let message = message.map(|m| json!(m));
    let Some(t) = token else {
        return Obj::new(vec![
            ("tokenKey", Some(json!(token_key))),
            ("connected", Some(json!(false))),
            ("state", Some(json!(state))),
            ("message", message),
        ])
        .into_value();
    };
    let expired = token_expires_at(t).is_some_and(|e| nekko_js::truthy_number(e) && e < now);
    Obj::new(vec![
        ("tokenKey", Some(json!(token_key))),
        ("provider", t.get("provider").cloned()),
        ("connected", Some(json!(!expired))),
        ("accountId", t.get("accountId").cloned()),
        ("accountEmail", t.get("accountEmail").cloned()),
        ("expiresAt", t.get("expiresAt").cloned()),
        ("scopes", t.get("scopes").cloned()),
        ("state", Some(json!(state))),
        ("message", message),
    ])
    .into_value()
}

/// `codexCliToken`: `~/.codex/auth.json` as a token set.
pub fn codex_cli_token(raw: &str, now: f64) -> Result<Option<Value>, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if parsed.is_null() {
        return Err("Cannot read properties of null (reading 'tokens')".into());
    }
    let tokens = prop(Some(&parsed), "tokens");
    let access = prop(tokens, "access_token");
    if !nekko_js::truthy(access) {
        return Ok(None);
    }
    let obtained_at = match prop(Some(&parsed), "last_refresh") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(now),
        Some(Value::String(s)) => {
            let ms = date_parse(s);
            if ms.is_nan() { now } else { ms }
        }
        _ => now,
    };
    let expires_at = exp_from_jwt(access)
        .or_else(|| exp_from_jwt(prop(tokens, "id_token")))
        .unwrap_or(obtained_at + CHATGPT_CLI_TOKEN_TTL_MS);
    Ok(Some(
        Obj::new(vec![
            ("provider", Some(json!("chatgpt"))),
            ("accessToken", access.cloned()),
            ("refreshToken", prop(tokens, "refresh_token").cloned()),
            ("accountId", prop(tokens, "account_id").cloned()),
            (
                "accountEmail",
                match prop(tokens, "id_token") {
                    Some(Value::String(s)) => extract_email(s).map(Value::String),
                    _ => None,
                },
            ),
            ("expiresAt", Some(num(expires_at))),
            ("obtainedAt", Some(num(obtained_at))),
        ])
        .into_value(),
    ))
}

/// `Date.parse` for the ECMAScript date-time string format (`YYYY`,
/// `YYYY-MM`, `YYYY-MM-DD`, then optionally `THH:mm`, `:ss`, `.sss` and `Z`
/// or `±HH:mm`; a date alone is UTC, a date-time without an offset local
/// time). Anything else is NaN; V8 also guesses at other formats, which no
/// CLI writes.
pub fn date_parse(s: &str) -> f64 {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize, n: usize| -> Option<u32> {
        let part = s.get(*i..*i + n)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        *i += n;
        part.parse().ok()
    };
    let Some(year) = digits(&mut i, 4) else { return f64::NAN };
    let (mut month, mut day) = (1, 1);
    if b.get(i) == Some(&b'-') {
        i += 1;
        let Some(m) = digits(&mut i, 2) else { return f64::NAN };
        month = m;
        if b.get(i) == Some(&b'-') {
            i += 1;
            let Some(d) = digits(&mut i, 2) else { return f64::NAN };
            day = d;
        }
    }
    let Some(date) = NaiveDate::from_ymd_opt(year as i32, month, day) else { return f64::NAN };
    if i == b.len() {
        return date.and_hms_opt(0, 0, 0).map_or(f64::NAN, |d| d.and_utc().timestamp_millis() as f64);
    }
    if b.get(i) != Some(&b'T') {
        return f64::NAN;
    }
    i += 1;
    let Some(h) = digits(&mut i, 2) else { return f64::NAN };
    if b.get(i) != Some(&b':') {
        return f64::NAN;
    }
    i += 1;
    let Some(mi) = digits(&mut i, 2) else { return f64::NAN };
    let (mut sec, mut ms) = (0, 0);
    if b.get(i) == Some(&b':') {
        i += 1;
        let Some(sv) = digits(&mut i, 2) else { return f64::NAN };
        sec = sv;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                return f64::NAN;
            }
            let frac = &s[start..i];
            ms = format!("{frac:0<3}")[..3].parse().unwrap_or(0);
        }
    }
    let time = if h == 24 && mi == 0 && sec == 0 && ms == 0 {
        NaiveTime::from_hms_milli_opt(0, 0, 0, 0)
    } else {
        NaiveTime::from_hms_milli_opt(h, mi, sec, ms)
    };
    let Some(time) = time else { return f64::NAN };
    let mut naive = NaiveDateTime::new(date, time);
    if h == 24 {
        naive += chrono::Duration::days(1);
    }
    let rest = &s[i..];
    let utc_ms = |n: NaiveDateTime| n.and_utc().timestamp_millis() as f64;
    match rest {
        "" => chrono::Local.from_local_datetime(&naive).earliest().map_or(f64::NAN, |d| d.timestamp_millis() as f64),
        "Z" => utc_ms(naive),
        _ => {
            let rb = rest.as_bytes();
            if rb.len() != 6 || !(rb[0] == b'+' || rb[0] == b'-') || rb[3] != b':' {
                return f64::NAN;
            }
            let (Ok(oh), Ok(om)) = (rest[1..3].parse::<i64>(), rest[4..6].parse::<i64>()) else { return f64::NAN };
            let sign = if rb[0] == b'-' { -1 } else { 1 };
            utc_ms(naive) - (sign * (oh * 60 + om) * 60_000) as f64
        }
    }
}

/// tokens.json in a data directory: read whole, written whole, atomically.
pub struct TokenStore {
    path: PathBuf,
}

impl TokenStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        TokenStore { path: dir.into().join("tokens.json") }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `loadTokens()`: `{}` for a missing or unreadable file.
    pub fn load(&self) -> Value {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_str(&String::from_utf8_lossy(&bytes)).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        }
    }

    /// `getToken(key)`.
    pub fn get(&self, key: &str) -> Option<Value> {
        self.load().get(key).cloned()
    }

    fn write(&self, mut tokens: Value, f: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
        match &mut tokens {
            Value::Object(m) => f(m),
            // Properties set on an array never reach JSON.stringify.
            Value::Array(_) => {}
            _ => return Err("Cannot create property on a token store that is not an object".into()),
        }
        nekko_settings::write_json_atomic(&self.path, &nekko_js::js_order(tokens)).map_err(|e| e.to_string())
    }

    /// `setToken(key, token)`.
    pub fn set(&self, key: &str, token: Value) -> Result<(), String> {
        self.write(self.load(), |m| {
            m.insert(key.to_string(), token);
        })
    }

    /// `deleteToken(key)`.
    pub fn delete(&self, key: &str) -> Result<(), String> {
        self.write(self.load(), |m| {
            m.shift_remove(key);
        })
    }
}
