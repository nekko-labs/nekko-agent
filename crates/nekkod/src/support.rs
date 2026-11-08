//! Explicit, opt-in support for the fixed Nekko Agent repository. No ambient
//! credentials: only the person's connected GitHub connector may act for them.
use crate::routes::Ctx;
use serde_json::{Value, json};
use std::time::Duration;

pub const CHANNELS: &[&str] = &["support:starStatus", "support:star"];
const STAR_PATH: &str = "/user/starred/nekko-labs/nekko-agent";

fn token(settings: &Value) -> Option<&str> {
    settings["connectors"]
        .as_array()?
        .iter()
        .filter(|c| c["kind"] == "github" && c["connected"] == true)
        .find_map(|c| c["token"].as_str().filter(|t| !t.trim().is_empty()))
}

fn unavailable(reason: &str) -> Value {
    json!({"state": "unavailable", "reason": reason})
}

pub async fn route(ctx: &Ctx, channel: &str) -> Result<Value, String> {
    let settings = crate::settings::current(ctx).await;
    let Some(token) = token(&settings) else {
        return Ok(unavailable(
            "Connect your GitHub account in Connectors to check or add a star here. You can also star on GitHub.",
        ));
    };
    // The browser cannot choose a repository, endpoint or credential.
    Ok(star("https://api.github.com", token, channel == "support:star").await)
}

async fn request(base: &str, token: &str, method: reqwest::Method, path: &str) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Couldn't prepare the GitHub connection.".to_string())?;
    let req = client
        .request(method, format!("{base}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "nekko-agent")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("Content-Length", "0");
    nekko_net::send("github", req)
        .await
        .map_err(|_| "Couldn't reach GitHub. Check your connection or network settings, then try again.".to_string())
}

fn refused(status: u16) -> &'static str {
    match status {
        401 => "GitHub couldn't verify your account. Reconnect GitHub in Connectors or open GitHub directly.",
        403 => {
            "GitHub didn't allow this request. Check your token's starring permissions or rate limit, or star on GitHub."
        }
        429 => "GitHub's rate limit was reached. Try again later or open GitHub.",
        _ => "GitHub couldn't confirm your star. Try again later or open GitHub.",
    }
}

async fn star(base: &str, token: &str, write: bool) -> Value {
    let result = async {
        let user = request(base, token, reqwest::Method::GET, "/user").await?;
        if user.status().as_u16() != 200 {
            return Err(refused(user.status().as_u16()).to_string());
        }
        let user: Value = user.json().await.map_err(|_| "GitHub returned an unreadable account.".to_string())?;
        let login = user["login"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 100)
            .ok_or_else(|| "GitHub couldn't identify your account.".to_string())?;
        let state = request(base, token, reqwest::Method::GET, STAR_PATH).await?;
        match state.status().as_u16() {
            204 => Ok(json!({"state":"starred", "login":login, "newlyStarred":false})),
            404 if !write => Ok(json!({"state":"not-starred", "login":login})),
            404 => {
                let added = request(base, token, reqwest::Method::PUT, STAR_PATH).await?;
                if added.status().as_u16() != 204 {
                    return Err(refused(added.status().as_u16()).to_string());
                }
                Ok(json!({"state":"starred", "login":login, "newlyStarred":true}))
            }
            status => Err(refused(status).to_string()),
        }
    }
    .await;
    result.unwrap_or_else(|reason| unavailable(&reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn only_an_explicit_connected_github_token() {
        assert_eq!(token(&json!({})), None);
        assert_eq!(token(&json!({"connectors":[{"kind":"github","connected":false,"token":"secret"}]})), None);
        assert_eq!(token(&json!({"connectors":[{"kind":"github","connected":true,"token":""}]})), None);
        assert_eq!(token(&json!({"connectors":[{"kind":"github","connected":true,"token":"chosen"}]})), Some("chosen"));
    }

    async fn serve(responses: Vec<(u16, &'static str)>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = vec![];
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = vec![0; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                requests.push(String::from_utf8_lossy(&buf[..n]).to_string());
                let reply = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
            requests
        });
        (base, server)
    }

    #[tokio::test]
    async fn existing_star_never_writes_or_celebrates() {
        let (base, server) = serve(vec![(200, r#"{"login":"supporter"}"#), (204, "")]).await;
        let result = star(&base, "test-only", true).await;
        assert_eq!(result["state"], "starred");
        assert_eq!(result["newlyStarred"], false);
        assert!(server.await.unwrap().iter().all(|r| r.starts_with("GET ")));
    }

    #[tokio::test]
    async fn status_only_never_writes() {
        let (base, server) = serve(vec![(200, r#"{"login":"supporter"}"#), (404, "")]).await;
        assert_eq!(star(&base, "test-only", false).await["state"], "not-starred");
        assert!(server.await.unwrap().iter().all(|r| r.starts_with("GET ")));
    }

    #[tokio::test]
    async fn explicit_star_checks_first_then_puts_fixed_repo() {
        let (base, server) = serve(vec![(200, r#"{"login":"supporter"}"#), (404, ""), (204, "")]).await;
        let result = star(&base, "test-only", true).await;
        assert_eq!(result["newlyStarred"], true);
        let requests = server.await.unwrap();
        assert!(requests[2].starts_with(&format!("PUT {STAR_PATH} ")));
        assert!(!result.to_string().contains("test-only"));
    }

    #[tokio::test]
    async fn permission_denied_does_not_claim_a_star() {
        let (base, server) = serve(vec![(200, r#"{"login":"supporter"}"#), (404, ""), (403, "")]).await;
        assert_eq!(star(&base, "test-only", true).await["state"], "unavailable");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn invalid_identity_is_not_an_unstarred_account() {
        let (base, server) = serve(vec![(401, "")]).await;
        assert_eq!(star(&base, "test-only", true).await["state"], "unavailable");
        assert_eq!(server.await.unwrap().len(), 1);
    }
}
