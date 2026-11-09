//! Repositories in a chat's environment (#2404): `repos:list` lists what the
//! connected GitHub or GitLab account can reach, `repos:clone` clones one onto
//! this computer and saves it as a folder tagged with its repository.
//!
//! The connector's token reaches git only through `GIT_CONFIG_*` environment
//! variables, scoped to the provider's origin: never on the command line
//! (process listings show it) and never in the clone's `.git/config`. Later
//! fetches and pushes use the user's own git credentials, as any other folder.

use crate::routes::Ctx;
use crate::worktrees::{git, run_with_env};
use base64::Engine;
use nekko_connectors::repos;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const CHANNELS: &[&str] = &["repos:list", "repos:clone"];

/// A first clone of a large repository can take a while.
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Where clones go unless `settings.repoCloneDir` says otherwise.
const DEFAULT_DIR: &str = "nekko-repos";

fn github_api() -> String {
    std::env::var("NEKKO_GITHUB_API_URL").unwrap_or_else(|_| repos::GITHUB_API.into())
}

fn connectors(settings: &Value) -> Vec<Value> {
    settings.get("connectors").and_then(Value::as_array).cloned().unwrap_or_default()
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let settings = crate::settings::current(ctx).await;
    match channel {
        "repos:list" => {
            let query = args.first().and_then(Value::as_str).unwrap_or_default();
            Ok(repos::list(crate::connectors::NET.as_ref(), &github_api(), &connectors(&settings), query).await)
        }
        "repos:clone" => {
            let pick = args.first().cloned().unwrap_or(Value::Null);
            let plan = plan(&settings, &pick)?;
            let path =
                tokio::task::spawn_blocking(move || clone(&plan)).await.map_err(|e| format!("clone failed: {e}"))??;
            let tag = json!({
                "provider": pick["provider"],
                "fullName": pick["fullName"],
                "webUrl": pick.get("webUrl").cloned().unwrap_or(json!("")),
            });
            let workspaces = crate::workspace::add_folder_with(ctx, Some(&json!(path)), Some(tag)).await?;
            let key = nekko_settings::folder_path_key(&path);
            let id = workspaces
                .as_array()
                .and_then(|l| {
                    l.iter().find(|w| {
                        nekko_settings::folder_path_key(&w.get("path").map(nekko_js::display).unwrap_or_default())
                            == key
                    })
                })
                .and_then(|w| w.get("id").cloned())
                .unwrap_or(Value::Null);
            Ok(json!({ "workspaces": workspaces, "folderId": id, "path": path }))
        }
        other => Err(format!("unknown channel {other}")),
    }
}

/// What a clone needs, checked before anything runs.
#[derive(Debug)]
struct Plan {
    url: String,
    host: String,
    origin: String,
    target: PathBuf,
    /// `GIT_CONFIG_*` carrying the token's header for `origin` only.
    env: Vec<(String, String)>,
}

/// The parts of `owner/name` (GitLab: `group/sub/name`), each a plain name.
fn segments(full: &str) -> Result<Vec<&str>, String> {
    let parts: Vec<&str> = full.split('/').collect();
    let plain = |s: &&str| {
        !s.is_empty()
            && *s != "."
            && *s != ".."
            && s.len() <= 100
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    };
    if parts.len() < 2 || parts.len() > 10 || !parts.iter().all(plain) {
        return Err(format!("\"{full}\" isn't a repository name this app can clone."));
    }
    Ok(parts)
}

fn clone_root(settings: &Value) -> PathBuf {
    match settings.get("repoCloneDir").and_then(Value::as_str).map(str::trim) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => nekko_js::home_dir().unwrap_or_default().join(DEFAULT_DIR),
    }
}

fn plan(settings: &Value, pick: &Value) -> Result<Plan, String> {
    let kind = pick.get("provider").and_then(Value::as_str).unwrap_or_default();
    let full = pick.get("fullName").and_then(Value::as_str).unwrap_or_default();
    let url = pick.get("cloneUrl").and_then(Value::as_str).unwrap_or_default();
    let list = connectors(settings);
    let provider = repos::connected(&list).into_iter().find(|p| p.kind == kind).ok_or_else(|| {
        let label = if kind == "gitlab" { "GitLab" } else { "GitHub" };
        format!("Connect {label} in Connectors to add its repositories.")
    })?;
    let origin = repos::web_origin(kind, provider.settings)?;
    let parts = segments(full)?;
    // The token goes only to the provider it belongs to: the clone URL must be
    // that provider's https address for this repository.
    let parsed = url::Url::parse(url).map_err(|_| "That repository has no clone address.".to_string())?;
    let same_origin = parsed.scheme() == "https" && parsed.origin().ascii_serialization() == origin;
    let path = parsed.path().trim_end_matches(".git");
    if !same_origin || !path.trim_start_matches('/').eq_ignore_ascii_case(full) || parsed.query().is_some() {
        return Err(format!("{url} isn't {full} on {origin}."));
    }
    let host = parsed.host_str().unwrap_or_default().to_string();
    let user = if kind == "github" { "x-access-token" } else { "oauth2" };
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", provider.token));
    let env = vec![
        ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
        ("GIT_CONFIG_KEY_0".to_string(), format!("http.{origin}/.extraheader")),
        ("GIT_CONFIG_VALUE_0".to_string(), format!("AUTHORIZATION: basic {basic}")),
    ];
    let mut target = clone_root(settings);
    for p in parts {
        target.push(p);
    }
    Ok(Plan { url: url.to_string(), host, origin, target, env })
}

/// `https://Host/a/b.git` and `https://host/a/b` are the same remote.
fn same_remote(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('/').trim_end_matches(".git").to_lowercase();
    norm(a) == norm(b)
}

fn is_empty_dir(p: &Path) -> bool {
    std::fs::read_dir(p).is_ok_and(|mut d| d.next().is_none())
}

/// Clone (or reuse an existing clone of the same repository) and return its path.
fn clone(plan: &Plan) -> Result<String, String> {
    let shown = plan.target.to_string_lossy().into_owned();
    if plan.target.exists() && !is_empty_dir(&plan.target) {
        let origin = git(&shown, &["remote", "get-url", "origin"]).unwrap_or_default();
        if plan.target.join(".git").exists() && same_remote(&origin, &plan.url) {
            return Ok(shown);
        }
        return Err(format!(
            "{shown} already exists and isn't a clone of {}. Move it, or add it with Add folder.",
            plan.url
        ));
    }
    let parent = plan.target.parent().ok_or("no folder to clone into")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    nekko_net::check("connectors", &plan.host)?;
    let ev = nekko_net::Event::new("request").host(&plan.host);
    let cwd = parent.to_string_lossy().into_owned();
    let ran = run_with_env("git", &["clone", "--", &plan.url, &shown], &cwd, None, CLONE_TIMEOUT, &plan.env);
    let failure = match ran {
        Ok((0, _, _)) => None,
        Ok((_, _, err)) => Some(explain(&String::from_utf8_lossy(&err), &plan.origin)),
        Err(e) if e.contains("ENOENT") => Some(
            "Git isn't installed on this computer, so the repository can't be cloned. Install Git, then try again."
                .into(),
        ),
        Err(e) if e.contains("ETIMEDOUT") => Some("The clone took longer than 15 minutes and was stopped.".into()),
        Err(e) => Some(e),
    };
    match failure {
        None => {
            nekko_net::record("connectors", ev);
            Ok(shown)
        }
        Some(e) => {
            nekko_net::record("connectors", ev.error(&e));
            Err(e)
        }
    }
}

/// A git failure in plain words, keeping git's own last line.
fn explain(stderr: &str, origin: &str) -> String {
    let last = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("git clone failed");
    let lower = stderr.to_lowercase();
    if lower.contains("authentication failed") || lower.contains("could not read username") || lower.contains("403") {
        format!("{origin} refused the clone: the connector's token may lack access to this repository. ({last})")
    } else {
        format!("The clone failed: {last}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Value {
        json!({
            "repoCloneDir": "/clones",
            "connectors": [
                {"kind":"github","connected":true,"token":"ghp_secret"},
                {"kind":"gitlab","connected":true,"token":"glpat","settings":{"site":"https://gl.example.com"}}
            ]
        })
    }

    fn pick(provider: &str, full: &str, url: &str) -> Value {
        json!({"provider": provider, "fullName": full, "cloneUrl": url})
    }

    #[test]
    fn a_github_clone_scopes_the_token_to_github() {
        let p = plan(&settings(), &pick("github", "me/app", "https://github.com/me/app.git")).unwrap();
        assert_eq!(p.target, PathBuf::from("/clones").join("me").join("app"));
        assert_eq!(p.env[1].1, "http.https://github.com/.extraheader");
        let header = base64::engine::general_purpose::STANDARD.encode("x-access-token:ghp_secret");
        assert_eq!(p.env[2].1, format!("AUTHORIZATION: basic {header}"));
        // Never on the command line.
        assert!(!p.url.contains("ghp_secret"));
    }

    #[test]
    fn gitlab_keeps_nested_groups_and_its_instance() {
        let p = plan(&settings(), &pick("gitlab", "grp/sub/tool", "https://gl.example.com/grp/sub/tool.git")).unwrap();
        assert_eq!(p.target, PathBuf::from("/clones").join("grp").join("sub").join("tool"));
        assert_eq!(p.env[1].1, "http.https://gl.example.com/.extraheader");
    }

    #[test]
    fn the_token_never_goes_to_another_host_or_repository() {
        let s = settings();
        for (provider, full, url) in [
            ("github", "me/app", "https://evil.example/me/app.git"),
            ("github", "me/app", "http://github.com/me/app.git"),
            ("github", "me/app", "https://github.com/me/other.git"),
            ("github", "me/app", "https://github.com/me/app.git?x=1"),
            ("gitlab", "grp/tool", "https://gitlab.com/grp/tool.git"),
        ] {
            assert!(plan(&s, &pick(provider, full, url)).is_err(), "{url}");
        }
    }

    #[test]
    fn names_cannot_escape_the_clone_folder() {
        for full in ["../x", "me/..", "me", "me/a b", "me//x", "/me/x", "me/x\\y"] {
            assert!(segments(full).is_err(), "{full}");
        }
        assert!(segments("me/app.rs").is_ok());
    }

    #[test]
    fn needs_a_connected_provider() {
        let err = plan(&json!({}), &pick("gitlab", "a/b", "https://gitlab.com/a/b.git")).unwrap_err();
        assert!(err.contains("Connect GitLab"));
    }

    #[test]
    fn remotes_compare_loosely() {
        assert!(same_remote("https://GitHub.com/me/app.git\n", "https://github.com/me/app"));
        assert!(!same_remote("https://github.com/me/app", "https://github.com/me/apps"));
    }

    #[test]
    fn an_existing_unrelated_folder_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("nekko-repos-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("me").join("app")).unwrap();
        std::fs::write(dir.join("me").join("app").join("notes.txt"), "mine").unwrap();
        let mut s = settings();
        s["repoCloneDir"] = json!(dir.to_string_lossy());
        let p = plan(&s, &pick("github", "me/app", "https://github.com/me/app.git")).unwrap();
        let err = clone(&p).unwrap_err();
        assert!(err.contains("already exists"));
        assert_eq!(std::fs::read_to_string(dir.join("me").join("app").join("notes.txt")).unwrap(), "mine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auth_failures_name_the_token() {
        assert!(
            explain("remote: Repository not found.\nfatal: Authentication failed for 'x'", "https://github.com")
                .contains("lack access")
        );
        assert_eq!(explain("fatal: something\n", "o"), "The clone failed: fatal: something");
    }
}
