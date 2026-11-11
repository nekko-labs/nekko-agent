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

pub const CHANNELS: &[&str] = &["repos:list", "repos:clone", "repos:setSandbox"];

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
            // A copy already on this computer wins over a new clone.
            let saved = saved_paths(&settings);
            let (url, chosen) = (plan.url.clone(), clone_dir_set(&settings));
            let local = tokio::task::spawn_blocking(move || find_local(&url, &saved, &scan_roots()))
                .await
                .map_err(|e| format!("search failed: {e}"))?;
            // A sandbox chat keeps a repository that isn't here inside its sandbox (#2561).
            let chat = args.get(1).and_then(|o| o.get("sessionId")).and_then(Value::as_str);
            if local.is_none()
                && let Some(id) = chat
                && let Some(s) = session(ctx, id).await
                && s.get("executionMode").and_then(Value::as_str) == Some("sandbox")
            {
                return add_to_sandbox(ctx, id, &s, &pick).await;
            }
            let reused = local.is_some();
            let path = match local {
                Some(p) => p,
                // No copy and no repositories folder yet: the user picks one first.
                None if !chosen => {
                    let suggested = nekko_js::home_dir().unwrap_or_default().join(DEFAULT_DIR);
                    return Ok(json!({ "needsFolder": true, "suggested": suggested.to_string_lossy() }));
                }
                None => tokio::task::spawn_blocking(move || clone(&plan))
                    .await
                    .map_err(|e| format!("clone failed: {e}"))??,
            };
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
            Ok(json!({ "workspaces": workspaces, "folderId": id, "path": path, "reused": reused }))
        }
        "repos:setSandbox" => {
            let id = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
            let repos = args.get(1).cloned().unwrap_or(json!([]));
            if !repos.as_array().is_some_and(|a| a.iter().all(|r| r.get("fullName").is_some_and(Value::is_string))) {
                return Err("Expected a list of repositories.".into());
            }
            let store = ctx.sessions.clone();
            tokio::task::spawn_blocking(move || store.set_sandbox_repos(&id, &repos))
                .await
                .map_err(|e| e.to_string())?
        }
        other => Err(format!("unknown channel {other}")),
    }
}

async fn session(ctx: &Ctx, id: &str) -> Option<Value> {
    let (store, id) = (ctx.sessions.clone(), id.to_string());
    tokio::task::spawn_blocking(move || store.meta(&id)).await.ok().flatten().map(nekko_store::Meta::into_value)
}

/// Records `pick` on the sandbox chat; the sandbox clones it when it is made.
async fn add_to_sandbox(ctx: &Ctx, id: &str, s: &Value, pick: &Value) -> Result<Value, String> {
    let full = pick.get("fullName").and_then(Value::as_str).unwrap_or_default();
    let mut repos = s.get("sandboxRepos").and_then(Value::as_array).cloned().unwrap_or_default();
    let same = |r: &Value| {
        r.get("provider") == pick.get("provider")
            && r.get("fullName").and_then(Value::as_str).is_some_and(|f| f.eq_ignore_ascii_case(full))
    };
    if !repos.iter().any(same) {
        repos.push(json!({
            "provider": pick["provider"],
            "fullName": full,
            "cloneUrl": pick.get("cloneUrl").cloned().unwrap_or(json!("")),
            "webUrl": pick.get("webUrl").cloned().unwrap_or(json!("")),
        }));
    }
    let (store, id) = (ctx.sessions.clone(), id.to_string());
    let session = tokio::task::spawn_blocking(move || store.set_sandbox_repos(&id, &json!(repos)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(json!({ "sandbox": true, "session": session }))
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

fn clone_dir_set(settings: &Value) -> bool {
    settings.get("repoCloneDir").and_then(Value::as_str).is_some_and(|d| !d.trim().is_empty())
}

fn saved_paths(settings: &Value) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = settings
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| w.get("path").and_then(Value::as_str).map(PathBuf::from))
        .collect();
    if clone_dir_set(settings) {
        out.push(clone_root(settings));
    }
    out
}

/// Where people usually keep code, searched (two levels deep) for a clone
/// that is already here.
fn scan_roots() -> Vec<PathBuf> {
    let Some(home) = nekko_js::home_dir() else { return vec![] };
    [
        DEFAULT_DIR,
        "code",
        "Code",
        "src",
        "dev",
        "Developer",
        "projects",
        "Projects",
        "repos",
        "git",
        "GitHub",
        "Documents/GitHub",
        "source/repos",
        "workspace",
    ]
    .iter()
    .map(|d| home.join(d))
    .collect()
}

/// `https://u@Host/a/b.git`, `git@host:a/b` and `ssh://git@host/a/b` all become `host/a/b`.
fn remote_key(url: &str) -> String {
    let s = url.trim();
    let s = s.split_once("://").map_or(s, |(_, rest)| rest);
    let s = s.rsplit_once('@').map_or(s, |(_, rest)| rest);
    // scp-like `host:path` (not a `host:port/` URL, which `://` already handled).
    let s = s.replacen(':', "/", 1);
    s.trim_end_matches('/').trim_end_matches(".git").to_lowercase()
}

/// The `origin` url in a clone's `.git/config`, read without running git.
fn origin_url(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(".git").join("config")).ok()?;
    let mut in_origin = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line.replace(' ', "").eq_ignore_ascii_case("[remote\"origin\"]");
        } else if in_origin
            && let Some((k, v)) = line.split_once('=')
            && k.trim().eq_ignore_ascii_case("url")
        {
            return Some(v.trim().to_string());
        }
    }
    None
}

/// A folder on this computer whose `origin` is `url`: the saved folders
/// first, then the usual code folders, two levels deep.
fn find_local(url: &str, saved: &[PathBuf], roots: &[PathBuf]) -> Option<String> {
    let want = remote_key(url);
    let is_it = |d: &Path| d.join(".git").is_dir() && origin_url(d).is_some_and(|o| remote_key(&o) == want);
    if let Some(p) = saved.iter().find(|p| is_it(p)) {
        return Some(p.to_string_lossy().into_owned());
    }
    let children = |d: &Path| -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(d) else { return vec![] };
        let mut v: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.') && e.file_name() != "node_modules")
            .map(|e| e.path())
            .collect();
        v.sort();
        v
    };
    // shortcut: bounded scan of the usual folders; a clone elsewhere can still be added with Add folder.
    let mut budget = 4000usize;
    for root in roots {
        for a in children(root) {
            if is_it(&a) {
                return Some(a.to_string_lossy().into_owned());
            }
            if a.join(".git").exists() {
                continue;
            }
            for b in children(&a) {
                budget = budget.checked_sub(1)?;
                if is_it(&b) {
                    return Some(b.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
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
    git_clone(plan, false)?;
    Ok(shown)
}

/// A sandbox chat's repository (#2561): a shallow clone into `target`, a
/// temporary folder in the sandbox's own state, copied into the container and
/// then deleted by the caller. Same token scoping and checks as any clone.
pub fn clone_for_sandbox(settings: &Value, pick: &Value, target: &Path) -> Result<(), String> {
    let mut plan = plan(settings, pick)?;
    plan.target = target.to_path_buf();
    if plan.target.exists() {
        std::fs::remove_dir_all(&plan.target).map_err(|e| format!("Couldn't clear {}: {e}", plan.target.display()))?;
    }
    git_clone(&plan, true)
}

fn git_clone(plan: &Plan, shallow: bool) -> Result<(), String> {
    let shown = plan.target.to_string_lossy().into_owned();
    let parent = plan.target.parent().ok_or("no folder to clone into")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    nekko_net::check("connectors", &plan.host)?;
    let ev = nekko_net::Event::new("request").host(&plan.host);
    let cwd = parent.to_string_lossy().into_owned();
    let mut args = vec!["clone"];
    if shallow {
        args.extend(["--depth", "1"]);
    }
    args.extend(["--", &plan.url, &shown]);
    let ran = run_with_env("git", &args, &cwd, None, CLONE_TIMEOUT, &plan.env);
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
            Ok(())
        }
        Some(e) => {
            nekko_net::record("connectors", ev.error(&e));
            Err(e)
        }
    }
}

/// A git failure in plain words, keeping git's own last line.
fn explain(stderr: &str, origin: &str) -> String {
    let last = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("git clone failed");
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
    fn remote_forms_match() {
        let k = remote_key("https://github.com/me/app");
        for u in ["https://x@GitHub.com/me/app.git", "git@github.com:me/app.git", "ssh://git@github.com/me/app/"] {
            assert_eq!(remote_key(u), k, "{u}");
        }
        assert_ne!(remote_key("git@github.com:me/apps"), k);
    }

    #[test]
    fn an_existing_clone_is_found_and_reused() {
        let root = std::env::temp_dir().join(format!("nekko-find-local-{}", std::process::id()));
        let clone = root.join("work").join("app");
        std::fs::create_dir_all(clone.join(".git")).unwrap();
        std::fs::write(
            clone.join(".git").join("config"),
            "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://github.com/other/app\n[remote \"origin\"]\n\turl = git@github.com:me/app.git\n",
        )
        .unwrap();
        let url = "https://github.com/me/app.git";
        // Found two levels under a code folder.
        assert_eq!(find_local(url, &[], std::slice::from_ref(&root)).as_deref(), Some(clone.to_str().unwrap()));
        // And as a saved folder, with no code folders searched.
        assert_eq!(find_local(url, std::slice::from_ref(&clone), &[]).as_deref(), Some(clone.to_str().unwrap()));
        // Only `origin` counts.
        assert_eq!(find_local("https://github.com/other/app", &[], std::slice::from_ref(&root)), None);
        let _ = std::fs::remove_dir_all(&root);
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
