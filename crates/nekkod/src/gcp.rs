//! A Google Cloud access token for Claude on Vertex AI, from the user's own
//! Application Default Credentials: the file `gcloud auth application-default
//! login` writes (or `GOOGLE_APPLICATION_CREDENTIALS`). A user credential is
//! exchanged for an access token over HTTPS; anything else (a service account
//! key, external account) is handed to `gcloud`, which signs for it. The token
//! is billed to the user's own Google Cloud project and is never stored.

use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Refresh this long before Google says the token expires.
const EARLY_MS: f64 = 5.0 * 60_000.0;
const TIMEOUT: Duration = Duration::from_secs(20);

/// (token, expires at in epoch ms), shared by every Vertex provider: ADC is
/// one credential per machine user.
static CACHE: Mutex<Option<(String, f64)>> = Mutex::new(None);

/// Where Google's client libraries look for ADC, in their order.
fn adc_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("gcloud"))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config").join("gcloud"))
    };
    base.map(|b| b.join("application_default_credentials.json"))
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(TIMEOUT).build().unwrap_or_default())
}

/// A fresh access token for Vertex AI, cached until five minutes before it expires.
pub async fn access_token() -> Result<String, String> {
    if let Some((token, expires)) = CACHE.lock().ok().and_then(|c| c.clone())
        && nekko_js::now_ms_f64() < expires - EARLY_MS
    {
        return Ok(token);
    }
    let adc =
        adc_path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let (token, expires) =
        match adc.as_ref().filter(|a| a.get("type").and_then(Value::as_str) == Some("authorized_user")) {
            Some(user) => refresh_user(http(), user).await?,
            None => from_gcloud().await?,
        };
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((token.clone(), expires));
    }
    Ok(token)
}

/// `grant_type=refresh_token` with the client the credential file names.
async fn refresh_user(http: &reqwest::Client, user: &Value) -> Result<(String, f64), String> {
    let field = |k: &str| user.get(k).and_then(Value::as_str).unwrap_or_default();
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", field("client_id")),
        ("client_secret", field("client_secret")),
        ("refresh_token", field("refresh_token")),
    ];
    let res = nekko_net::send("sign-in", http.post(TOKEN_URL).form(&form).timeout(TIMEOUT))
        .await
        .map_err(|e| format!("Google sign-in: {e}"))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!(
            "Google rejected the Application Default Credentials ({status}). Run `gcloud auth application-default login` again."
        ));
    }
    parse_token(&body).ok_or_else(|| "Google's token response had no access token.".into())
}

/// `{ access_token, expires_in }` as (token, expires at).
fn parse_token(body: &Value) -> Option<(String, f64)> {
    let token = body.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty())?;
    let secs = body.get("expires_in").and_then(Value::as_f64).unwrap_or(3600.0);
    Some((token.to_string(), nekko_js::now_ms_f64() + secs * 1000.0))
}

/// `gcloud auth application-default print-access-token`, for credentials only
/// gcloud can sign for. Google tokens last an hour; assume the least.
async fn from_gcloud() -> Result<(String, f64), String> {
    let mut cmd = if cfg!(windows) {
        // gcloud is a .cmd shim on Windows, which only cmd can start.
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", "gcloud"]);
        c
    } else {
        tokio::process::Command::new("gcloud")
    };
    cmd.args(["auth", "application-default", "print-access-token"]).kill_on_drop(true);
    let out = tokio::time::timeout(TIMEOUT, cmd.output())
        .await
        .map_err(|_| "gcloud took too long to print an access token.".to_string())?
        .map_err(|_| no_credentials())?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || token.is_empty() {
        return Err(no_credentials());
    }
    Ok((token, nekko_js::now_ms_f64() + 3_600_000.0))
}

fn no_credentials() -> String {
    "No Google Cloud credentials found. Run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS."
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn token_responses_parse_with_their_lifetime() {
        let before = nekko_js::now_ms_f64();
        let (token, expires) = parse_token(&json!({ "access_token": "ya29.x", "expires_in": 3599 })).unwrap();
        assert_eq!(token, "ya29.x");
        assert!(expires >= before + 3_599_000.0 && expires < before + 3_700_000.0);
        assert_eq!(parse_token(&json!({ "access_token": "" })), None);
        assert_eq!(parse_token(&json!({ "error": "invalid_grant" })), None);
    }
}
