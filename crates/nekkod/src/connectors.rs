//! Connectors owned by the daemon (PF14): `connectors:list`,
//! `connector:connect`, `connector:disconnect`, `connector:fetch`, and the
//! chat-context snippets a turn's admission gathers (`snippets`). The
//! connector configs live in `settings.json`, which the daemon writes
//! (crate::settings); the reads and posts are `nekko-connectors`'.

use crate::routes::Ctx;
use nekko_connectors::{Http, Net};
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

pub const CHANNELS: &[&str] = &[
    "connectors:list",
    "connector:connect",
    "connector:disconnect",
    "connector:fetch",
    "connectors:detect",
    "connector:importCli",
    "connector:repos",
    "connector:exclude",
];

/// How long a turn waits for the connectors' context before going without (TS: 2.5 s).
const SNIPPET_WAIT: Duration = Duration::from_millis(2500);

/// How long `gh` gets to print its token before the card falls back to a pasted one.
const GH_WAIT: Duration = Duration::from_secs(8);

/// Where `gh` usually is when the app's PATH misses it (an app started from
/// the Dock gets a bare PATH; the Windows installer's folder is not always on it).
const GH_CANDIDATES: &[&str] =
    &["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", r"C:\Program Files\GitHub CLI\gh.exe"];

/// The network every connector call goes out on.
pub static NET: LazyLock<Arc<dyn Http>> = LazyLock::new(|| Arc::new(Net::default()));

fn connectors_of(settings: &Value) -> Vec<Value> {
    settings.get("connectors").and_then(Value::as_array).cloned().unwrap_or_default()
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let kind = arg(0).clone();
    match channel {
        "connectors:list" => Ok(crate::settings::current(ctx).await.get("connectors").cloned().unwrap_or(json!([]))),
        "connector:connect" => store(ctx, kind, args.get(1), args.get(2)).await,
        // Sign-ins already on this computer a card can connect with in one
        // click. Only the account name leaves the daemon, never the token.
        "connectors:detect" => {
            let mut found = serde_json::Map::new();
            if let Some(token) = gh_token().await {
                found.insert("github".into(), json!({ "source": "gh", "account": github_login(&token).await }));
            }
            Ok(Value::Object(found))
        }
        // Connect GitHub with the GitHub CLI's own sign-in: the daemon reads
        // the token, so it never crosses into the UI.
        "connector:importCli" => {
            if kind.as_str() != Some("github") {
                return Err("Only GitHub can use a command-line sign-in.".into());
            }
            let token = gh_token().await.ok_or(
                "The GitHub CLI is not signed in on this computer. Run `gh auth login`, or create a token instead.",
            )?;
            store(ctx, kind, Some(&json!(token)), None).await
        }
        "connector:disconnect" => {
            let connectors: Vec<Value> = connectors_of(&crate::settings::current(ctx).await)
                .into_iter()
                .filter(|c| c.get("kind") != Some(&kind))
                .collect();
            let next = crate::settings::update(ctx, json!({ "connectors": connectors })).await?;
            Ok(next.get("connectors").cloned().unwrap_or(json!([])))
        }
        "connector:fetch" => {
            let cfg =
                connectors_of(&crate::settings::current(ctx).await).into_iter().find(|c| c.get("kind") == Some(&kind));
            // Connected-not-token is the gate: a Teams webhook lives in settings.
            let Some(cfg) = cfg.filter(|c| nekko_js::truthy(c.get("connected"))) else {
                return Err("Connector not connected".into());
            };
            let token = cfg.get("token").filter(|t| !t.is_null()).map(nekko_js::display).unwrap_or_default();
            let query = args.get(1).and_then(Value::as_str);
            let kind = kind.as_str().unwrap_or("");
            nekko_connectors::fetch(NET.as_ref(), kind, &token, query, cfg.get("settings")).await
        }
        // Every repository a git connector reaches, the removed ones too, so
        // the card can group them and bring a removed one back (#2562).
        "connector:repos" => {
            let kind = kind.as_str().unwrap_or("");
            let mine: Vec<Value> =
                connectors_of(&crate::settings::current(ctx).await).into_iter().filter(|c| c["kind"] == kind).collect();
            if nekko_connectors::repos::connected(&mine).is_empty() {
                return Err("Connector not connected".into());
            }
            let api =
                std::env::var("NEKKO_GITHUB_API_URL").unwrap_or_else(|_| nekko_connectors::repos::GITHUB_API.into());
            Ok(nekko_connectors::repos::list_reachable(NET.as_ref(), &api, &mine).await)
        }
        "connector:exclude" => exclude(ctx, &kind, arg(1)).await,
        other => Err(format!("unknown channel {other}")),
    }
}

/// The repositories and owners a git connector's user removed from what the
/// app offers and reads (#2562), saved in the connector's settings. Only
/// these two lists change, so the token and where it is sent never do.
async fn exclude(ctx: &Ctx, kind: &Value, choice: &Value) -> Result<Value, String> {
    if !matches!(kind.as_str(), Some("github" | "gitlab")) {
        return Err("Only GitHub and GitLab have repositories to choose.".into());
    }
    let names = |key: &str| -> Result<Value, String> {
        let list = choice.get(key).and_then(Value::as_array).ok_or(format!("{key} must be a list of names."))?;
        let mut out: Vec<String> = Vec::new();
        for v in list {
            let name = v.as_str().map(str::trim).filter(|n| !n.is_empty() && n.len() <= 300);
            let name = name.ok_or(format!("{key} must be a list of names."))?.to_lowercase();
            if !out.contains(&name) {
                out.push(name);
            }
        }
        Ok(json!(out))
    };
    let (repos, owners) = (names("excludedRepos")?, names("excludedOwners")?);
    let mut connectors = connectors_of(&crate::settings::current(ctx).await);
    let entry = connectors.iter_mut().find(|c| c.get("kind") == Some(kind)).ok_or("Connector not connected")?;
    if !entry.get("settings").is_some_and(Value::is_object) {
        entry["settings"] = json!({});
    }
    entry["settings"]["excludedRepos"] = repos;
    entry["settings"]["excludedOwners"] = owners;
    let next = crate::settings::update(ctx, json!({ "connectors": connectors })).await?;
    Ok(next.get("connectors").cloned().unwrap_or(json!([])))
}

/// Saves `{ kind, connected: true, token, settings, connectedAt }` in place of
/// any earlier entry for the kind, absent fields left out.
async fn store(ctx: &Ctx, kind: Value, token: Option<&Value>, settings: Option<&Value>) -> Result<Value, String> {
    let mut connectors: Vec<Value> = connectors_of(&crate::settings::current(ctx).await)
        .into_iter()
        .filter(|c| c.get("kind") != Some(&kind))
        .collect();
    let mut entry = serde_json::Map::new();
    entry.insert("kind".into(), kind);
    entry.insert("connected".into(), json!(true));
    if let Some(t) = token {
        entry.insert("token".into(), t.clone());
    }
    if let Some(s) = settings {
        entry.insert("settings".into(), s.clone());
    }
    entry.insert("connectedAt".into(), nekko_connectors::js::num(nekko_js::now_ms_f64()));
    connectors.push(Value::Object(entry));
    let next = crate::settings::update(ctx, json!({ "connectors": connectors })).await?;
    Ok(next.get("connectors").cloned().unwrap_or(json!([])))
}

/// `gh auth token` for github.com, or `None` when gh is missing, signed out
/// or slow. `NEKKO_GH_PATH` points at a specific gh, as the runner setup does.
async fn gh_token() -> Option<String> {
    let gh = std::env::var("NEKKO_GH_PATH")
        .ok()
        .or_else(|| GH_CANDIDATES.iter().find(|p| std::path::Path::new(p).is_file()).map(|p| p.to_string()))
        .unwrap_or_else(|| "gh".into());
    let mut cmd = tokio::process::Command::new(gh);
    cmd.args(["auth", "token", "--hostname", "github.com"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash.
    let out = tokio::time::timeout(GH_WAIT, cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    plausible_token(&String::from_utf8_lossy(&out.stdout))
}

/// The first line of gh's answer, if it reads as a GitHub token. A gh that
/// prints a notice or nothing at all must not be taken for a sign-in.
fn plausible_token(stdout: &str) -> Option<String> {
    let t = stdout.lines().next()?.trim();
    let known = ["gho_", "ghp_", "ghu_", "ghs_", "github_pat_"].iter().any(|p| t.starts_with(p));
    (known && t.len() >= 20 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then(|| t.to_string())
}

/// The account a GitHub token belongs to, or "" if GitHub does not say (the
/// card then reads "Use your GitHub CLI sign-in" without a name). Goes out on
/// the connectors connection, so the Connections switch covers it.
async fn github_login(token: &str) -> String {
    let auth = format!("Bearer {token}");
    let headers =
        [("Authorization", auth.as_str()), ("Accept", "application/vnd.github+json"), ("User-Agent", "nekko-agent")];
    let req = nekko_connectors::Request::get("https://api.github.com/user", &headers);
    match NET.send(req).await {
        Ok(res) if res.ok() => serde_json::from_str::<Value>(&res.body)
            .ok()
            .and_then(|v| v.get("login").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// `collectConnectorSnippets(text, session)`: up to five resources per
/// connected connector the chat has not switched off, as `{ label, origin,
/// body }` context snippets, or none if they take longer than 2.5 s.
pub async fn snippets(ctx: &Ctx, text: Option<&str>, session: &Value) -> Vec<Value> {
    let connectors = nekko_turn::chat_connectors(connectors_of(&crate::settings::current(ctx).await), session);
    nekko_connectors::snippets(NET.as_ref(), &connectors, text, SNIPPET_WAIT).await
}

#[cfg(test)]
mod tests {
    use super::plausible_token;

    #[test]
    fn only_a_github_token_counts_as_a_cli_sign_in() {
        let tok = "gho_0123456789abcdefABCDEF0123456789abcd";
        assert_eq!(plausible_token(&format!("{tok}\n")).as_deref(), Some(tok));
        assert_eq!(
            plausible_token("github_pat_11ABCDEFG0123456789_abcdefghij\r\n").as_deref(),
            Some("github_pat_11ABCDEFG0123456789_abcdefghij")
        );
        assert_eq!(plausible_token(""), None);
        assert_eq!(plausible_token("no oauth token found for github.com"), None);
        assert_eq!(plausible_token("gho_short"), None);
        assert_eq!(plausible_token("gho_0123456789abcdef 0123456789"), None);
    }
}
