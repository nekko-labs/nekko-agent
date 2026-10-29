//! Stacked pull requests, ported from `packages/host/src/pr-stacks.ts`:
//! `pr:continueStack` (a follow-up chat pinned to an open parent PR, its
//! branch fetched into the project as `refs/nekko/pr-bases/<sha>`) and
//! `pr:linkStack` (the dependent PR registered as a native GitHub stack).
//!
//! The logic runs over a [`StackHost`] (the chats, the saved folders, git and
//! GitHub), so the golden set the TS functions write
//! (`tests/golden/stacks.json`) can replay it call for call; the daemon's
//! host is in `crates/nekkod/src/workspace.rs`.

use futures_util::future::BoxFuture;
use nekko_js as js;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// What the stack logic needs from outside, in the order the TS calls it.
pub trait StackHost: Send + Sync {
    /// `getSession(id)`.
    fn session(&self, id: &str) -> Option<Value>;
    /// `getSettings().workspaces`.
    fn workspaces(&self) -> Vec<Value>;
    /// `execFileSync('git', args, { cwd })`: stdout untrimmed, or the error message.
    fn git<'a>(&'a self, cwd: &'a str, args: &'a [String]) -> BoxFuture<'a, Result<String, String>>;
    /// `git fetch --no-tags <remote> refs/heads/<branch>:<ref>`; false when it failed.
    fn fetch<'a>(&'a self, cwd: &'a str, args: &'a [String]) -> BoxFuture<'a, bool>;
    /// `githubStackRequest(path, pullRequests?)`.
    fn request<'a>(&'a self, path: &'a str, body: Option<&'a [Value]>) -> BoxFuture<'a, Result<Value, String>>;
    /// `refreshPrInfo(url)`: the PR's state read afresh, or null.
    fn refresh<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Value>;
    /// `createSession(workspaceId)`.
    fn create<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<Value, String>>;
    /// `saveSession(s)`; `s` comes back as written.
    fn save<'a>(&'a self, session: &'a mut Value) -> BoxFuture<'a, Result<(), String>>;
}

fn re(cell: &'static OnceLock<Regex>, src: &str, flags: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::with_flags(src, flags).expect("stack pattern compiles"))
}

fn test(cell: &'static OnceLock<Regex>, src: &str, flags: &str, text: &str) -> bool {
    re(cell, src, flags).find(text).is_some()
}

/// `String(v)` as a template literal or `RegExp.test` coerces it.
fn string_of(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::display)
}

fn get<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(v, |v, k| v.get(*k))
}

/// `githubRemoteRepo(url)`: `owner/repo` lower-cased for a GitHub remote, else None.
pub fn github_remote_repo(url: &str) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = re(
        &R,
        r"^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)\/?(?:\.git)?$",
        "i",
    );
    let m = r.find(url)?;
    Some(url[m.group(1)?].to_lowercase())
}

/// A parent or dependent PR as `parsedPr` reads its URL.
#[derive(Debug, Clone)]
struct Parsed {
    slug: String,
    number: f64,
}

impl Parsed {
    fn number_text(&self) -> String {
        js::number_to_string(self.number)
    }
}

/// `parsedPr(url)`.
fn parsed_pr(url: &str) -> Result<Parsed, String> {
    static WHOLE: OnceLock<Regex> = OnceLock::new();
    static PARTS: OnceLock<Regex> = OnceLock::new();
    if !test(&WHOLE, r"^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$", "", url) {
        return Err("Use a GitHub PR URL.".into());
    }
    // `parsePrUrl` (shared/pr.ts).
    let r = re(&PARTS, r"github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/pull\/(\d+)", "");
    let m = r.find(url).ok_or("Invalid PR number.")?;
    let g = |i: usize| m.group(i).map(|r| url[r].to_string()).unwrap_or_default();
    let number = js::string_to_number(&g(3));
    if !(number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0) {
        return Err("Invalid PR number.".into());
    }
    Ok(Parsed { slug: format!("{}/{}", g(1), g(2)), number })
}

/// `x?.toLowerCase()` of a repository's full name.
fn full_name(pr: &Value, side: &str) -> Option<String> {
    get(pr, &[side, "repo", "full_name"]).and_then(Value::as_str).map(str::to_lowercase)
}

/// `requireStackablePr(pr, slug)`.
pub fn require_stackable(pr: &Value, slug: &str) -> Result<(), String> {
    static SHA: OnceLock<Regex> = OnceLock::new();
    if pr.get("state").and_then(Value::as_str) != Some("open") || js::truthy(pr.get("merged")) {
        return Err("The parent PR must still be open. Refresh it or start a normal chat.".into());
    }
    let want = Some(slug.to_lowercase());
    if full_name(pr, "head") != want || full_name(pr, "base") != want {
        return Err(
            "GitHub stacks require the head and base branches in the same repository. Fork PRs cannot be stacked."
                .into(),
        );
    }
    let sha = string_of(get(pr, &["head", "sha"]));
    if !get(pr, &["head", "ref"]).is_some_and(Value::is_string) || !test(&SHA, r"^[a-f0-9]{40,64}$", "i", &sha) {
        return Err("GitHub did not return a valid parent branch and commit.".into());
    }
    Ok(())
}

/// `getExecutionMode(session)`.
fn execution_mode(s: &Value) -> String {
    match s.get("executionMode") {
        Some(v) if !v.is_null() => js::display(v),
        _ if s.get("gitIsolation") == Some(&json!(false)) => "unified".into(),
        _ => "worktree".into(),
    }
}

/// `getSessionWorkspaceIds(session)`: the primary folder, then the supporting ones, once each.
fn session_workspace_ids(s: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let primary = s.get("workspaceId").filter(|v| js::truthy(Some(v)));
    let supporting = s.get("supportingWorkspaceIds").and_then(Value::as_array).cloned().unwrap_or_default();
    for v in primary.into_iter().cloned().chain(supporting.into_iter().filter(|v| js::truthy(Some(v)))) {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

/// `activeSession(id)`.
fn active_session(host: &dyn StackHost, id: &str) -> Result<Value, String> {
    let s = host.session(id).ok_or("Chat not found.")?;
    if js::truthy(s.get("offline")) || js::truthy(s.get("incognito")) || execution_mode(&s) == "sandbox" {
        return Err("PR stacks require an online, saved chat outside the sandbox.".into());
    }
    if js::truthy(s.get("archivedAt")) || s.get("chatType").and_then(Value::as_str) == Some("image") {
        return Err("Continue from an active coding chat.".into());
    }
    Ok(s)
}

async fn git_trim(host: &dyn StackHost, cwd: &str, args: &[&str]) -> Result<String, String> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    host.git(cwd, &args).await.map(|out| js::trim(&out).to_string())
}

/// `s[key] = value`: `undefined` leaves no key (as `JSON.stringify` writes it).
fn assign(s: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            s.insert(key.into(), v);
        }
        None => {
            s.shift_remove(key);
        }
    }
}

fn same_number(a: Option<&Value>, n: f64) -> bool {
    a.and_then(Value::as_f64) == Some(n)
}

fn last_number(list: Option<&Value>) -> Option<&Value> {
    list.and_then(Value::as_array).and_then(|a| a.last()).and_then(|p| p.get("number"))
}

/// `continuePrStack(sessionId, url)`: pin a selected parent; the follow-up
/// chat's checkout and setup stay lazy until its first send.
pub async fn continue_stack(host: &dyn StackHost, session_id: &str, url: &str) -> Result<Value, String> {
    let source = active_session(host, session_id)?;
    let Parsed { slug, number } = parsed_pr(url)?;
    let n = js::number_to_string(number);
    let pr = host.request(&format!("repos/{slug}/pulls/{n}"), None).await?;
    require_stackable(&pr, &slug)?;
    if let Some(stack) = pr.get("stack").filter(|v| js::truthy(Some(v))) {
        let path = format!("repos/{slug}/stacks/{}", string_of(stack.get("number")));
        let stack = host.request(&path, None).await?;
        if !same_number(last_number(stack.get("pull_requests")), number) {
            return Err(
                "Continue from the top PR of this stack. Another dependent PR is already above this parent.".into()
            );
        }
    }
    let head_ref = string_of(get(&pr, &["head", "ref"]));
    let head_sha = string_of(get(&pr, &["head", "sha"]));
    let folders = host.workspaces();
    for id in session_workspace_ids(&source) {
        let Some(folder) = folders.iter().find(|w| w.get("id") == Some(&id)) else { continue };
        let path = string_of(folder.get("path"));
        let Ok(list) = git_trim(host, &path, &["remote"]).await else { continue };
        let remotes: Vec<String> =
            list.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).filter(|l| !l.is_empty()).collect();
        for remote in remotes {
            let remote_url = git_trim(host, &path, &["remote", "get-url", &remote]).await?;
            if github_remote_repo(&remote_url) != Some(slug.to_lowercase()) {
                continue;
            }
            git_trim(host, &path, &["check-ref-format", &format!("refs/heads/{head_ref}")]).await?;
            let base_ref = format!("refs/nekko/pr-bases/{head_sha}");
            let fetch_args: Vec<String> = ["fetch", "--no-tags", &remote, &format!("refs/heads/{head_ref}:{base_ref}")]
                .iter()
                .map(|a| a.to_string())
                .collect();
            nekko_net::check("github", "github.com")?;
            if !host.fetch(&path, &fetch_args).await {
                return Err(
                    "Could not fetch the parent PR. Check Git authentication and repository access, then retry.".into(),
                );
            }
            if git_trim(host, &path, &["rev-parse", &format!("{base_ref}^{{commit}}")]).await? != head_sha {
                return Err("The parent PR changed while fetching. Refresh and try again.".into());
            }
            active_session(host, session_id)?;
            let mut s = host.create(&js::display(&id)).await?;
            let Value::Object(map) = &mut s else { return Err("Could not create the follow-up chat.".into()) };
            map.insert("title".into(), json!(format!("Follow-up to PR #{n}")));
            map.insert("titleAuto".into(), json!(false));
            for key in ["providerId", "modelId", "autoModel", "autoQuality", "thinking", "mode"] {
                assign(map, key, source.get(key).cloned());
            }
            let tools = source.get("disabledTools").filter(|v| js::truthy(Some(v))).cloned();
            assign(map, "disabledTools", tools);
            map.insert("executionMode".into(), json!("worktree"));
            map.insert("gitIsolation".into(), json!(true));
            map.insert(
                "gitStackParent".into(),
                json!({
                    "workspaceId": id,
                    "url": format!("https://github.com/{slug}/pull/{n}"),
                    "branch": get(&pr, &["head", "ref"]).cloned().unwrap_or(Value::Null),
                    "sha": get(&pr, &["head", "sha"]).cloned().unwrap_or(Value::Null),
                }),
            );
            host.save(&mut s).await?;
            return Ok(s);
        }
    }
    Err("Select a local project with a GitHub remote matching this PR before continuing it.".into())
}

/// `linkPrStack(sessionId, url)`: never fails the call, answers `{ ok, message, pr? }`.
pub async fn link_stack(host: &dyn StackHost, session_id: &str, url: &str) -> Value {
    match link(host, session_id, url).await {
        Ok(v) => v,
        Err(message) => json!({ "ok": false, "message": message }),
    }
}

fn linked(message: &str, pr: Value) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), json!(true));
    out.insert("message".into(), json!(message));
    if !pr.is_null() {
        out.insert("pr".into(), pr);
    }
    Value::Object(out)
}

async fn link(host: &dyn StackHost, session_id: &str, url: &str) -> Result<Value, String> {
    let s = active_session(host, session_id)?;
    let parent = s.get("gitStackParent").filter(|v| js::truthy(Some(v)));
    let Some(parent) = parent.filter(|_| execution_mode(&s) == "worktree") else {
        return Err("This chat was not started from a parent PR.".into());
    };
    let (a, b) = (parsed_pr(&string_of(parent.get("url")))?, parsed_pr(url)?);
    if a.slug.to_lowercase() != b.slug.to_lowercase() || a.number == b.number {
        return Err("Select the new dependent PR in the same repository.".into());
    }
    let workspace = string_of(parent.get("workspaceId"));
    let checkout = s
        .get("gitWorktrees")
        .and_then(|w| w.get(&workspace))
        .filter(|v| js::truthy(Some(v)))
        .ok_or("Send the first prompt to prepare this chat\u{2019}s dependent worktree.")?;
    let (pa, pb) =
        (format!("repos/{}/pulls/{}", a.slug, a.number_text()), format!("repos/{}/pulls/{}", b.slug, b.number_text()));
    let (lower, upper) = futures_util::future::join(host.request(&pa, None), host.request(&pb, None)).await;
    let (lower, upper) = (lower?, upper?);
    require_stackable(&lower, &a.slug)?;
    require_stackable(&upper, &b.slug)?;
    let branch = checkout.get("branch");
    let mismatch = "The dependent PR must use this chat\u{2019}s branch and target its parent PR branch. Update its base on GitHub, then retry.";
    if get(&upper, &["head", "ref"]) != branch {
        return Err(mismatch.into());
    }
    let current = git_trim(host, &string_of(checkout.get("path")), &["branch", "--show-current"]).await?;
    if Some(&json!(current)) != branch || get(&upper, &["base", "ref"]) != get(&lower, &["head", "ref"]) {
        return Err(mismatch.into());
    }
    let parent_stacks =
        host.request(&format!("repos/{}/stacks?pull_request={}", a.slug, a.number_text()), None).await?;
    let Value::Array(stacks) = parent_stacks else { return Err("Could not read GitHub stack membership.".into()) };
    let holds_parent = |item: &&Value| {
        item.get("pull_requests")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|p| same_number(p.get("number"), a.number)))
    };
    if let Some(stack) = stacks.iter().find(holds_parent) {
        let entries = stack.get("pull_requests").and_then(Value::as_array).cloned().unwrap_or_default();
        let index = entries.iter().position(|p| same_number(p.get("number"), a.number));
        let next = index.and_then(|i| entries.get(i + 1));
        if same_number(next.and_then(|p| p.get("number")), b.number) {
            return Ok(linked("This PR is already linked to its parent stack.", host.refresh(url).await));
        }
        if !same_number(entries.last().and_then(|p| p.get("number")), a.number) {
            return Err(
                "Continue from the top PR of this stack. Another dependent PR is already above this parent.".into()
            );
        }
        let path = format!("repos/{}/stacks/{}/add", a.slug, string_of(stack.get("number")));
        host.request(&path, Some(&[json!(b.number as u64)])).await?;
    } else {
        let path = format!("repos/{}/stacks", a.slug);
        host.request(&path, Some(&[json!(a.number as u64), json!(b.number as u64)])).await?;
    }
    Ok(linked("Linked as a GitHub PR stack.", host.refresh(url).await))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_github_remotes_exactly() {
        assert_eq!(github_remote_repo("git@github.com:Owner/Repo.git").as_deref(), Some("owner/repo"));
        assert_eq!(github_remote_repo("https://github.com/owner/repo.git").as_deref(), Some("owner/repo"));
        assert_eq!(github_remote_repo("ssh://git@github.com/owner/repo.git").as_deref(), Some("owner/repo"));
        assert_eq!(github_remote_repo("https://github.com.attacker.test/owner/repo.git"), None);
        assert_eq!(github_remote_repo("https://github.com/owner/repo.git/extra"), None);
    }
}
