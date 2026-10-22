//! The user's projects, served here (PF14): the file explorer, memory notes,
//! line comments, the workspace index, and the git and pull-request state
//! (`crates/nekko-workspace`).
//!
//! A workspace's folder comes from the settings (`crate::settings::current`,
//! the daemon's own store when it knows the data directory); everything runs
//! here, off the async threads. Index progress goes to the UI from here.

use crate::hub::Hub;
use crate::routes::Ctx;
use nekko_workspace::gitops::{self, DiffOpts, GitOps, LogOpts};
use nekko_workspace::{comments, design, files, git::Git, index::Index, memory, pr::Prs, scoped, skills, spec};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;

/// Channels served here whatever the edition.
pub const CHANNELS: &[&str] = &[
    "file:read",
    "file:write",
    "dir:list",
    // Files in a chat's folder, relative to it (IO-33 FA-1, nekko-workspace scoped.rs).
    "files:list",
    "files:search",
    "files:read",
    "files:write",
    "workspace:index",
    "workspace:indexStatus",
    "workspace:search",
    "workspace:files",
    // The chat's index snippets at admission (chat.ts asks for them here).
    "workspace:snippets",
    "workspace:gitStatus",
    "pr:sessionList",
    "pr:diff",
    "pr:action",
    // IO-33 FA-2: git in the workspace's folder, and PRs from it.
    "git:diff",
    "git:log",
    "git:show",
    "git:branches",
    "git:compare",
    "git:stage",
    "git:unstage",
    "git:commit",
    "git:commitMessage",
    "git:push",
    "git:switch",
    "git:mergeAbort",
    "pr:create",
    "pr:checks",
];

/// Channels that keep their files in the data directory, served only when
/// this daemon knows it.
pub const DATA_CHANNELS: &[&str] = &[
    // The saved folders: settings writes, and chats that lose a folder.
    "workspace:list",
    "workspace:addByPath",
    "workspace:remove",
    "memory:list",
    "memory:save",
    "memory:delete",
    "comments:list",
    "comment:add",
    "comment:resolve",
    "design:get",
    "design:addPage",
    "design:updatePage",
    "design:removePage",
    "design:addNote",
    "design:resolveNote",
    "design:generate",
    "skills:installed",
    "skills:external",
    "skills:runnable",
    "workflow:skillDefs",
    "skills:targets",
    "skill:install",
    "skill:uninstall",
    "vaizer:catalog",
    "vaizer:skillMd",
    "spec:path",
    "spec:readDocs",
    "spec:setMethodology",
    "spec:toggleTask",
    "spec:build",
    "spec:buildDoc",
];

/// A design generation has no limit in the host; this keeps a stuck model
/// from holding the call forever.
const DESIGN_TIMEOUT_MS: u64 = 10 * 60 * 1000;

pub struct Workspace {
    data_dir: Option<PathBuf>,
    index: Arc<Index>,
    prs: Arc<Prs>,
    git: Git,
    ops: GitOps,
    vaizer: skills::Vaizer,
}

impl Workspace {
    /// `github_api` is where GitHub's REST API is (`config.githubApiUrl`, else
    /// `NEKKO_GITHUB_API_URL` for the Local Web UI, whose server writes the
    /// config). Tests point it at a loopback server, with `NEKKO_GH_PATH`
    /// naming a `gh` that does not exist so the REST fallback runs.
    pub fn new(data_dir: Option<PathBuf>, github_api: Option<&str>) -> Self {
        let gh = std::env::var("NEKKO_GH_PATH").unwrap_or_else(|_| "gh".into());
        let api = github_api
            .map(str::to_string)
            .or_else(|| std::env::var("NEKKO_GITHUB_API_URL").ok())
            .unwrap_or_else(|| "https://api.github.com".into());
        let prs = Arc::new(Prs::new(&gh, &api));
        Self {
            data_dir,
            index: Arc::new(Index::new()),
            git: Git::new(prs.clone()),
            ops: GitOps::default(),
            prs,
            vaizer: skills::Vaizer::default(),
        }
    }

    /// The data directory, when this daemon knows it.
    pub fn data_dir(&self) -> Option<&std::path::Path> {
        self.data_dir.as_deref()
    }

    /// The PR reads and their caches, shared with the stacked-PR channels.
    pub fn prs(&self) -> &Prs {
        &self.prs
    }

    /// `getVaizerCatalog(refresh)` (`refreshVaizerCatalog` with `true`), for
    /// the update checks; None without a data directory.
    pub async fn vaizer_catalog(&self, refresh: bool) -> Option<Value> {
        let dir = self.data_dir.clone()?;
        Some(self.vaizer.catalog(&dir, refresh).await)
    }

    /// Is this channel answered here (never handed back to the host)?
    pub fn serves(&self, channel: &str) -> bool {
        CHANNELS.contains(&channel) || (self.data_dir.is_some() && DATA_CHANNELS.contains(&channel))
    }

    /// What `daemon:info` lists.
    pub fn owned(&self) -> Vec<&'static str> {
        let mut all = CHANNELS.to_vec();
        if self.data_dir.is_some() {
            all.extend_from_slice(DATA_CHANNELS);
        }
        all
    }
}

fn arg(args: &[Value], i: usize) -> Option<&Value> {
    args.get(i)
}

fn text(args: &[Value], i: usize) -> String {
    args.get(i).and_then(Value::as_str).unwrap_or_default().to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("workspace call failed: {e}"))
}

/// The saved folders, `settings.workspaces`.
async fn folders(ctx: &Ctx) -> Vec<Value> {
    crate::settings::current(ctx).await.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The user's settings.
async fn settings(ctx: &Ctx) -> Value {
    crate::settings::current(ctx).await
}

/// A chat, from the daemon's store or else the host.
async fn session(ctx: &Ctx, id: &str) -> Value {
    let Some(store) = ctx.sessions.clone() else { return Value::Null };
    let id = id.to_string();
    blocking(move || store.get(&id).unwrap_or(Value::Null)).await.unwrap_or(Value::Null)
}

/// The GitHub token for the REST fallback: the GitHub connector's, else the
/// environment's (`githubToken` in pr.ts).
pub fn github_token(settings: &Value) -> Option<String> {
    let connector = settings.get("connectors").and_then(Value::as_array).and_then(|list| {
        list.iter().find(|c| {
            c.get("kind") == Some(&json!("github"))
                && nekko_js::truthy(c.get("connected"))
                && nekko_js::truthy(c.get("token"))
        })
    });
    connector
        .and_then(|c| c.get("token"))
        .map(nekko_js::display)
        .or_else(|| ["GH_TOKEN", "GITHUB_TOKEN"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty())))
}

/// `getSessionWorkspaceIds(session)`: the primary folder, then the supporting ones, once each.
fn session_workspace_ids(session: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let primary = session.get("workspaceId").filter(|v| nekko_js::truthy(Some(v)));
    let supporting = session.get("supportingWorkspaceIds").and_then(Value::as_array).cloned().unwrap_or_default();
    for v in primary.into_iter().chain(supporting.iter().filter(|v| nekko_js::truthy(Some(v)))) {
        let id = nekko_js::display(v);
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// The folder `getGitStatus` reads for an id: a saved workspace, or for
/// `session:<id>` the chat's first checkout (its worktree when isolated).
/// None when there is nothing to read, including an isolated chat whose
/// worktree is not made yet (the source checkout is not its branch).
async fn git_folder(ctx: &Ctx, id: &str) -> Option<String> {
    let settings = settings(ctx).await;
    let saved = settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(sid) = id.strip_prefix("session:") else { return folder_path(&saved, id) };
    let s = session(ctx, sid).await;
    if s.is_null() {
        return None;
    }
    let worktrees = s.get("gitWorktrees").and_then(Value::as_object);
    if nekko_js::truthy(s.get("gitIsolation")) && worktrees.is_none_or(|w| w.is_empty()) {
        return None;
    }
    let (wid, path) =
        session_workspace_ids(&s).into_iter().find_map(|wid| folder_path(&saved, &wid).map(|p| (wid, p)))?;
    if s.get("gitIsolation") == Some(&json!(false)) {
        return Some(path);
    }
    Some(
        worktrees
            .and_then(|w| w.get(&wid))
            .and_then(|w| w.get("path"))
            .filter(|p| !p.is_null())
            .map(nekko_js::display)
            .unwrap_or(path),
    )
}

/// The folder a scoped file call (`files:*`, IO-33 FA-1) works in, from
/// `{ sessionId }` (the chat's checkout: its worktree when it is isolated and
/// the worktree exists, else its project folder), `{ sessionId, workspaceId }`
/// (one of that chat's folders) or `{ workspaceId }` (a saved folder). The
/// caller never names a path: it is looked up here.
pub(crate) async fn scoped_root(ctx: &Ctx, root: Option<&Value>) -> Result<PathBuf, String> {
    let bad = || "bad-request: the root is { sessionId } or { workspaceId }".to_string();
    let obj = root.and_then(Value::as_object).ok_or_else(bad)?;
    let field = |k: &str| obj.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let (sid, wid) = (field("sessionId"), field("workspaceId"));
    let saved = folders(ctx).await;
    let Some(sid) = sid else {
        let wid = wid.ok_or_else(bad)?;
        return folder_path(&saved, &wid).map(PathBuf::from).ok_or_else(|| "not-found: no such folder".to_string());
    };
    let s = session(ctx, &sid).await;
    if s.is_null() {
        return Err("not-found: no such chat".into());
    }
    let ids = session_workspace_ids(&s);
    let wid = match wid {
        Some(w) if ids.contains(&w) => w,
        Some(_) => return Err("not-found: that folder is not this chat's".into()),
        None => ids
            .iter()
            .find(|w| folder_path(&saved, w).is_some())
            .cloned()
            .ok_or_else(|| "no-folder: this chat has no folder".to_string())?,
    };
    if s.get("gitIsolation") != Some(&json!(false))
        && let Some(p) = s.get("gitWorktrees").and_then(|w| w.get(&wid)).and_then(|w| w.get("path"))
        && let Some(p) = p.as_str().filter(|p| std::path::Path::new(p).is_dir())
    {
        return Ok(PathBuf::from(p));
    }
    folder_path(&saved, &wid).map(PathBuf::from).ok_or_else(|| "no-folder: this chat has no folder".to_string())
}

/// `files:*`: resolve the root, then run the call on its scope off the async threads.
async fn scoped(ctx: &Ctx, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let root = scoped_root(ctx, arg(&args, 0)).await?;
    let listed = if channel == "files:search" { scoped::git_files(&root).await } else { None };
    let channel = channel.to_string();
    blocking(move || {
        let scope = scoped::Scope::new(&root)?;
        let opt = |k: &str| arg(&args, 2).and_then(|o| o.get(k));
        match channel.as_str() {
            "files:list" => scope.list(&text(&args, 1)),
            "files:search" => {
                let limit = arg(&args, 2).and_then(Value::as_u64).map(|n| n as usize);
                Ok(scope.search(&text(&args, 1), limit, listed))
            }
            "files:read" => scope.read(&text(&args, 1), opt("maxBytes").and_then(Value::as_u64).map(|n| n as usize)),
            "files:write" => {
                let Some(Value::String(content)) = arg(&args, 2) else {
                    return Err("bad-request: content must be text".into());
                };
                let expect = arg(&args, 3).and_then(|o| o.get("expectHash")).and_then(Value::as_str);
                scope.write(&text(&args, 1), content, expect)
            }
            _ => Err(format!("unknown channel {channel}")),
        }
    })
    .await?
}

fn folder_path(folders: &[Value], id: &str) -> Option<String> {
    folders
        .iter()
        .find(|w| w.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|w| w.get("path").and_then(Value::as_str))
        .map(str::to_string)
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let ws = &ctx.workspace;
    let args = args.to_vec();
    match channel {
        "file:read" => blocking(move || files::read_file(&text(&args, 0))).await?,
        "file:write" => {
            blocking(move || files::write_file(&text(&args, 0), arg(&args, 1).unwrap_or(&Value::Null))).await??;
            Ok(Value::Null)
        }
        "dir:list" => blocking(move || files::list_dir(&text(&args, 0))).await?,
        "files:list" | "files:search" | "files:read" | "files:write" => scoped(ctx, channel, args).await,
        "workspace:indexStatus" => Ok(ws.index.status(&text(&args, 0))),
        "workspace:files" => {
            let list = ws.index.files(&text(&args, 0));
            blocking(move || Value::Array(list.iter().map(|f| f.to_json()).collect())).await
        }
        "workspace:index" => {
            let id = text(&args, 0);
            let Some(root) = folder_path(&folders(ctx).await, &id) else {
                return Err("Workspace not found".into());
            };
            index_now(ws.index.clone(), ctx.hub.clone(), id, root).await
        }
        "workspace:search" => {
            let id = text(&args, 0);
            if folder_path(&folders(ctx).await, &id).is_none() {
                return Ok(json!([]));
            }
            // `query.toLowerCase()` on anything else throws in the host.
            let Some(Value::String(query)) = arg(&args, 1).cloned() else {
                return Err("query.toLowerCase is not a function".into());
            };
            let index = ws.index.clone();
            blocking(move || Value::Array(index.search(&id, &query))).await
        }
        "workspace:snippets" => {
            let ids: Vec<String> = arg(&args, 0)
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|v| v.as_str().unwrap_or_default().to_string()).collect())
                .unwrap_or_default();
            Ok(Value::Array(index_snippets(ctx, &ids, &text(&args, 1)).await))
        }
        "workspace:gitStatus" => {
            let id = text(&args, 0);
            let folder = git_folder(ctx, &id).await;
            Ok(ws.git.status(&id, folder.as_deref(), nekko_js::truthy(arg(&args, 1))).await)
        }
        "pr:sessionList" => {
            let s = session(ctx, &text(&args, 0)).await;
            let Some(messages) = s.get("messages").and_then(Value::as_array) else { return Ok(json!([])) };
            let token = github_token(&settings(ctx).await);
            Ok(Value::Array(
                ws.prs.session_prs(messages, token.as_deref(), arg(&args, 1) == Some(&Value::Bool(true))).await,
            ))
        }
        "pr:diff" => {
            let token = github_token(&settings(ctx).await);
            Ok(ws.prs.diff(&text(&args, 0), token.as_deref()).await)
        }
        "pr:action" => {
            let token = github_token(&settings(ctx).await);
            let out = ws.prs.action(&text(&args, 0), &text(&args, 1), token.as_deref()).await;
            match out.get("error").and_then(Value::as_str) {
                Some(e) => Err(e.to_string()),
                None => Ok(out),
            }
        }
        "pr:checks" => {
            let token = github_token(&settings(ctx).await);
            ws.prs.checks(&text(&args, 0), token.as_deref()).await
        }
        c if c.starts_with("git:") || c == "pr:create" => git_route(ctx, c, &args).await,
        "workspace:list" => Ok(settings(ctx).await.get("workspaces").cloned().unwrap_or(json!([]))),
        "workspace:addByPath" => add_folder(ctx, arg(&args, 0)).await,
        "workspace:remove" => remove_folder(ctx, &text(&args, 0)).await,
        "skills:installed" | "skills:targets" | "skill:install" | "skill:uninstall" | "skills:external"
        | "skills:runnable" | "workflow:skillDefs" => {
            let Some(dir) = ws.data_dir.clone() else { return Err(format!("{channel} needs the data directory")) };
            let roots: Vec<String> = if matches!(channel, "skills:external" | "skills:runnable" | "workflow:skillDefs")
            {
                folders(ctx).await.iter().filter_map(|w| w.get("path").map(nekko_js::display)).collect()
            } else {
                Vec::new()
            };
            let channel = channel.to_string();
            blocking(move || skills_route(&dir, &channel, &args, &roots)).await?
        }
        "vaizer:catalog" => {
            let Some(dir) = ws.data_dir.clone() else { return Err(format!("{channel} needs the data directory")) };
            Ok(ws.vaizer.catalog(&dir, nekko_js::truthy(arg(&args, 0))).await)
        }
        "vaizer:skillMd" => Ok(ws.vaizer.skill_md(&text(&args, 0)).await),
        "spec:path" | "spec:readDocs" | "spec:setMethodology" | "spec:toggleTask" => {
            let sid = text(&args, 0);
            let (session, settings) = (session(ctx, &sid).await, settings(ctx).await);
            let store = ctx.sessions.clone();
            let channel = channel.to_string();
            blocking(move || {
                let wid = |i: usize| arg(&args, i).and_then(Value::as_str).map(str::to_string);
                match channel.as_str() {
                    "spec:path" => spec::spec_path(&sid, &session, &settings),
                    "spec:readDocs" => spec::read_docs(&sid, &session, &settings, wid(1).as_deref()),
                    "spec:toggleTask" => spec::toggle_task(
                        &sid,
                        &session,
                        &settings,
                        arg(&args, 1).unwrap_or(&Value::Null),
                        wid(2).as_deref(),
                    ),
                    _ => {
                        spec::assert_host(&sid, &session, "Host spec access")?;
                        if let Some(store) = store.filter(|_| !session.is_null()) {
                            store.set_spec_methodology(&sid, &spec::methodology_id(arg(&args, 1)))?;
                        }
                        Ok(Value::Null)
                    }
                }
            })
            .await?
        }
        "spec:build" | "spec:buildDoc" => build_spec(ctx, args).await,
        "design:addPage" => {
            let Some(dir) = ws.data_dir.clone() else { return Err(format!("{channel} needs the data directory")) };
            let folder = folder_path(&folders(ctx).await, &arg(&args, 0).map(nekko_js::display).unwrap_or_default());
            blocking(move || design::add_page(&dir, arg(&args, 0), arg(&args, 1), arg(&args, 2), folder.as_deref()))
                .await?
        }
        "design:generate" => {
            let Some(dir) = ws.data_dir.clone() else { return Err(format!("{channel} needs the data directory")) };
            generate_design(ctx, dir, args).await
        }
        _ => {
            let Some(dir) = ws.data_dir.clone() else { return Err(format!("{channel} needs the data directory")) };
            data_route(dir, channel, args).await
        }
    }
}

async fn data_route(dir: PathBuf, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let channel = channel.to_string();
    blocking(move || match channel.as_str() {
        "memory:list" => Ok(Value::Array(memory::list(&dir, arg(&args, 0), arg(&args, 1)))),
        "memory:save" => memory::save(&dir, arg(&args, 0).unwrap_or(&Value::Null)).map(Value::Array),
        "memory:delete" => memory::delete(&dir, arg(&args, 0)).map(|()| Value::Null),
        "comments:list" => Ok(comments::list(&dir, arg(&args, 0))),
        "comment:add" => comments::add(&dir, arg(&args, 0), arg(&args, 1), arg(&args, 2), arg(&args, 3)),
        "comment:resolve" => comments::resolve(&dir, arg(&args, 0), arg(&args, 1)),
        "design:get" => Ok(design::get(&dir, arg(&args, 0))),
        "design:updatePage" => {
            design::update_page(&dir, arg(&args, 0), arg(&args, 1), arg(&args, 2).unwrap_or(&Value::Null))
        }
        "design:removePage" => design::remove_page(&dir, arg(&args, 0), arg(&args, 1)),
        "design:addNote" => design::add_note(&dir, arg(&args, 0), arg(&args, 1), arg(&args, 2)),
        "design:resolveNote" => design::resolve_note(&dir, arg(&args, 0), arg(&args, 1), arg(&args, 2)),
        other => Err(format!("{other} is not a workspace channel")),
    })
    .await?
}

/// The chat's index snippets (`collectIndexSnippets` in chat.ts): what
/// `workspace:snippets` answers, and what a daemon-side admission calls.
/// Each is `{ relPath, path, body }`, the TS `ContextSnippet` shape.
pub async fn index_snippets(ctx: &Ctx, workspace_ids: &[String], text: &str) -> Vec<Value> {
    let saved = if workspace_ids.is_empty() { Vec::new() } else { folders(ctx).await };
    let found: Vec<(String, bool)> =
        workspace_ids.iter().map(|id| (id.clone(), folder_path(&saved, id).is_some())).collect();
    let (index, query) = (ctx.workspace.index.clone(), text.to_string());
    blocking(move || index.snippets(&found, &query)).await.unwrap_or_default()
}

/// `addWorkspaceByPath(path)`: a folder already saved (by `folderPathKey`)
/// is reused; a new one is saved through the settings and indexed shortly
/// after. Returns the list as the host did (its own copy, not the saved one).
pub async fn add_folder(ctx: &Ctx, path: Option<&Value>) -> Result<Value, String> {
    let Some(Value::String(path)) = path else {
        return Err("The \"path\" argument must be of type string.".into());
    };
    let current = folders(ctx).await;
    let key = nekko_settings::folder_path_key(path);
    let shown = |w: &Value| w.get("path").map(nekko_js::display).unwrap_or_default();
    if current.iter().any(|w| nekko_settings::folder_path_key(&shown(w)) == key) {
        return Ok(Value::Array(current));
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    // Two folders added in the same millisecond must not share an id.
    let stamp = format!("ws_{}", base36(now));
    let taken = |id: &str| current.iter().any(|w| w.get("id").and_then(Value::as_str) == Some(id));
    let mut id = stamp.clone();
    let mut n = 1;
    while taken(&id) {
        id = format!("{stamp}_{n}");
        n += 1;
    }
    let folder = json!({ "id": id, "name": nekko_tools::path::native::basename(path), "path": path, "addedAt": now });
    let mut workspaces = current;
    workspaces.push(folder);
    crate::settings::update(ctx, json!({ "workspaces": workspaces })).await?;
    let (index, hub, root) = (ctx.workspace.index.clone(), ctx.hub.clone(), path.clone());
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = index_now(index, hub, id, root).await;
    });
    Ok(Value::Array(workspaces))
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// The chats this daemon is running right now.
fn busy_chats(ctx: &Ctx) -> Vec<String> {
    ctx.turns.running_sessions()
}

/// `removeWorkspace(id)`: revoke saved access only, never touching the
/// folder. Refused while a chat using it runs; chats using it lose it.
async fn remove_folder(ctx: &Ctx, id: &str) -> Result<Value, String> {
    let Some(store) = ctx.sessions.clone() else { return Err("workspace:remove needs the data directory".into()) };
    let wid = id.to_string();
    let affected: Vec<String> = blocking({
        let store = store.clone();
        move || {
            store
                .list()
                .into_iter()
                .filter(|s| {
                    s.get("workspaceId").and_then(Value::as_str) == Some(wid.as_str())
                        || s.get("supportingWorkspaceIds")
                            .and_then(Value::as_array)
                            .is_some_and(|a| a.iter().any(|w| w.as_str() == Some(wid.as_str())))
                })
                .filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        }
    })
    .await?;
    if !affected.is_empty() {
        let busy = busy_chats(ctx);
        if affected.iter().any(|s| busy.contains(s)) {
            return Err("Wait for chats using this folder to finish before revoking access.".into());
        }
    }
    let wid = id.to_string();
    blocking(move || {
        for sid in &affected {
            store.revoke_workspace(sid, &wid)?;
        }
        Ok::<(), String>(())
    })
    .await??;
    let kept: Vec<Value> =
        folders(ctx).await.into_iter().filter(|w| w.get("id").and_then(Value::as_str) != Some(id)).collect();
    let saved = crate::settings::update(ctx, json!({ "workspaces": kept })).await?;
    ctx.workspace.index.forget(id);
    Ok(saved.get("workspaces").cloned().unwrap_or(json!([])))
}

/// `os.homedir()`.
pub(crate) fn home_dir() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()
}

/// The skills channels, on the data directory and the user's home.
fn skills_route(dir: &std::path::Path, channel: &str, args: &[Value], roots: &[String]) -> Result<Value, String> {
    let home = home_dir();
    match channel {
        "skills:installed" => Ok(Value::Array(skills::list_installed(dir))),
        "skills:targets" => Ok(skills::targets(&home)),
        "skill:install" => {
            skills::install(dir, &home, arg(args, 0).unwrap_or(&Value::Null), arg(args, 1), arg(args, 2))
        }
        "skill:uninstall" => {
            skills::uninstall(dir, arg(args, 0).unwrap_or(&Value::Null), arg(args, 1)).map(Value::Array)
        }
        "skills:external" => Ok(Value::Array(skills::external_skills(dir, &home, roots))),
        "skills:runnable" => Ok(Value::Array(skills::runnable_skills(dir, &home, roots))),
        "workflow:skillDefs" => Ok(Value::Array(skills::resolve_skill_defs(dir, &home, roots))),
        other => Err(format!("{other} is not a skills channel")),
    }
}

/// `buildSpecDoc(sessionId, docId, workspaceId)` (and `buildSpec`, its
/// first-doc form): the prompt here, the chat's provider (signed in) from the
/// host, the model call on the Rust providers, then the file written.
async fn build_spec(ctx: &Ctx, args: Vec<Value>) -> Result<Value, String> {
    let sid = text(&args, 0);
    let (session, settings) = (session(ctx, &sid).await, settings(ctx).await);
    let plan = {
        let (sid, session, settings, args) = (sid.clone(), session.clone(), settings.clone(), args.clone());
        blocking(move || {
            let wid = arg(&args, 2).and_then(Value::as_str).map(str::to_string);
            spec::build_plan(&sid, &session, &settings, arg(&args, 1), wid.as_deref())
        })
        .await??
    };
    let plan = match plan {
        Ok(plan) => plan,
        Err(refusal) => return Ok(refusal),
    };
    let resolved = match resolved_provider(ctx, plan.provider_id.as_str().unwrap_or_default()).await {
        Ok(v) => v,
        Err(e) => return Ok(json!({ "ok": false, "message": e })),
    };
    let request = json!({
        "model": plan.model,
        "system": plan.system,
        "messages": [{ "id": "spec", "role": "user", "content": plan.prompt, "createdAt": nekko_workspace_now() }],
        "temperature": 0.3,
        "promptCaching": resolved.get("promptCaching").cloned().unwrap_or(json!(true)),
    });
    let spec_call = json!({ "provider": resolved.get("provider").cloned().unwrap_or(Value::Null), "request": request, "timeoutMs": DESIGN_TIMEOUT_MS });
    let raw = match crate::sideband::complete(&spec_call).await {
        Ok(reply) => reply.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
        Err(e) => return Ok(json!({ "ok": false, "message": e })),
    };
    blocking(move || spec::land(&sid, &session, &plan, &raw)).await?
}

/// The `git:*` calls and `pr:create`, in the folder `git_folder` finds for
/// the first argument (a saved workspace id, or `session:<chat id>` for the
/// chat's checkout). A change drops the folder's cached `workspace:gitStatus`.
async fn git_route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let id = text(args, 0);
    let Some(dir) = git_folder(ctx, &id).await.filter(|p| !p.is_empty()) else {
        return Err("This workspace has no folder to run git in.".into());
    };
    let ops = &ctx.workspace.ops;
    let paths = || -> Result<Vec<String>, String> {
        let list = arg(args, 1).and_then(Value::as_array).ok_or("Pass the paths as a list.")?;
        list.iter()
            .map(|p| p.as_str().map(str::to_string).ok_or_else(|| "Every path must be text.".to_string()))
            .collect()
    };
    let out = match channel {
        "git:diff" => ops.diff(&dir, &DiffOpts::from_json(arg(args, 1))?).await,
        "git:log" => ops.log(&dir, &LogOpts::from_json(arg(args, 1))?).await,
        "git:show" => ops.show(&dir, &text(args, 1)).await,
        "git:branches" => ops.branches(&dir).await,
        "git:compare" => ops.compare(&dir, &text(args, 1), &text(args, 2)).await,
        "git:stage" => ops.stage(&dir, &paths()?).await,
        "git:unstage" => ops.unstage(&dir, &paths()?).await,
        "git:commit" => ops.commit(&dir, arg(args, 1)).await,
        "git:commitMessage" => commit_message(ctx, &dir).await,
        "git:push" => ops.push(&dir, arg(args, 1)).await,
        "git:switch" => ops.switch(&dir, &text(args, 1), arg(args, 2)).await,
        "git:mergeAbort" => ops.merge_abort(&dir).await,
        "pr:create" => create_pr(ctx, &dir, arg(args, 1)).await,
        other => return Err(format!("Unknown git call: {other}")),
    };
    if matches!(
        channel,
        "git:stage" | "git:unstage" | "git:commit" | "git:push" | "git:switch" | "git:mergeAbort" | "pr:create"
    ) {
        ctx.workspace.git.invalidate(&dir);
    }
    out
}

/// `git:commitMessage`: a commit message for what is staged, written by the
/// default provider and model from the file list and the (capped) diff.
async fn commit_message(ctx: &Ctx, dir: &str) -> Result<Value, String> {
    let (stat, patch, cut) = ctx.workspace.ops.staged_for_message(dir).await?;
    let chosen = design_provider(ctx).await?;
    let provider = chosen.get("provider").cloned().unwrap_or(Value::Null);
    let model = chosen.get("model").cloned().unwrap_or(Value::Null);
    let content = gitops::commit_message_prompt(&stat, &patch, cut);
    let request = json!({
        "provider": provider,
        "request": {
            "model": model,
            "messages": [{ "id": "commit-message", "role": "user", "createdAt": nekko_workspace_now(), "content": content }],
            "temperature": 0.2,
            "maxOutputTokens": 400,
            "think": false,
            "promptCaching": chosen.get("promptCaching").cloned().unwrap_or(json!(true)),
        },
        "timeoutMs": 60_000,
        "usageOnFailure": true,
    });
    let out = crate::sideband::complete(&request).await.map_err(|e| format!("Writing the message failed: {e}"))?;
    if let Some(usage) = out.get("usage").and_then(Value::as_array).filter(|u| !u.is_empty())
        && ctx.accounts.enabled()
    {
        let who = json!({ "id": provider.get("id"), "kind": provider.get("kind"), "auth": provider.get("auth") });
        ctx.accounts.side_usage(&who, Some(&model), "", usage);
    }
    if let Some(e) = out.get("error") {
        return Err(format!("Writing the message failed: {}", nekko_js::display(e)));
    }
    let message = gitops::clean_commit_message(out.get("text").and_then(Value::as_str).unwrap_or_default());
    if message.is_empty() {
        return Err("The model wrote no message. Try again, or write one.".into());
    }
    Ok(json!({ "message": message, "inputTruncated": cut }))
}

/// `pr:create`: a PR from the folder's current branch, which must be pushed.
async fn create_pr(ctx: &Ctx, dir: &str, opts: Option<&Value>) -> Result<Value, String> {
    let get = |k: &str| opts.and_then(|o| o.get(k));
    let title = get("title").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    if title.is_empty() {
        return Err("Give the PR a title.".into());
    }
    if title.chars().count() > 256 {
        return Err("The PR title is too long (at most 256 characters).".into());
    }
    let body = get("body").and_then(Value::as_str).unwrap_or_default().to_string();
    if body.len() > 60_000 {
        return Err("The PR description is too long.".into());
    }
    let base = get("base").and_then(Value::as_str).filter(|b| !b.is_empty()).map(gitops::safe_ref).transpose()?;
    let draft = nekko_js::truthy(get("draft"));
    let ops = &ctx.workspace.ops;
    let Some(branch) = ops.current_branch(dir).await? else {
        return Ok(json!({ "ok": false, "message": "Not on a branch (detached HEAD). Switch to a branch first." }));
    };
    let slug = match ops.push_remote(dir, &branch).await {
        Some(remote) => ops.github_slug(dir, &remote).await,
        None => None,
    };
    let token = github_token(&settings(ctx).await);
    let prs = &ctx.workspace.prs;
    Ok(prs.create(dir, &branch, slug.as_deref(), &title, &body, base.as_deref(), draft, token.as_deref()).await)
}

/// `fetchPrInfo(url)`: one PR's live state, read now (gh, else the REST API
/// with the GitHub token), `null` when it cannot be read. For agent watches.
pub async fn pr_info(ctx: &Ctx, url: &str) -> Value {
    let token = github_token(&settings(ctx).await);
    ctx.workspace.prs.fetch_info(url, token.as_deref()).await
}

/// `resolvedProvider(providerId)`: a saved provider, signed in (a subscription
/// token refreshed) and ready for the Rust providers, with the prompt-caching
/// setting. What a spec doc is built with.
async fn resolved_provider(ctx: &Ctx, provider_id: &str) -> Result<Value, String> {
    let settings = settings(ctx).await;
    let known = settings
        .get("providers")
        .and_then(Value::as_array)
        .is_some_and(|ps| ps.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(provider_id)));
    if !known {
        return Err("Pick a provider and model, then chat first.".into());
    }
    let provider = crate::providers::resolve_provider(ctx, provider_id).await?;
    Ok(json!({
        "provider": crate::admission::host_provider_config(ctx, &provider),
        "promptCaching": settings.get("promptCaching") != Some(&json!(false)),
    }))
}

/// `designProvider()`: the default provider (resolved) and model a design is generated with.
async fn design_provider(ctx: &Ctx) -> Result<Value, String> {
    let settings = settings(ctx).await;
    let missing = || "Set a default provider and model in Models first.".to_string();
    let id = settings.get("defaultProviderId").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(missing)?;
    let model = settings.get("defaultModelId").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(missing)?;
    let known = settings
        .get("providers")
        .and_then(Value::as_array)
        .is_some_and(|ps| ps.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(id)));
    if !known {
        return Err(missing());
    }
    let mut out = resolved_provider(ctx, id).await?;
    out["model"] = json!(model);
    Ok(out)
}

/// `generateDesign(workspaceId, input)`: the checks and the prompt here, the
/// default provider (signed in) from the host, the model call on the Rust
/// providers, then the prototype file and the concept card.
async fn generate_design(ctx: &Ctx, dir: PathBuf, args: Vec<Value>) -> Result<Value, String> {
    let workspace = arg(&args, 0).cloned();
    let input = arg(&args, 1).cloned().unwrap_or(Value::Null);
    let plan = {
        let (dir, workspace, input) = (dir.clone(), workspace.clone(), input.clone());
        blocking(move || design::plan(&dir, workspace.as_ref(), &input)).await??
    };
    let chosen = design_provider(ctx).await?;
    let mut message =
        json!({ "id": "design", "role": "user", "content": plan.ask, "createdAt": nekko_workspace_now() });
    if let Some(images) = &plan.images {
        message["images"] = json!(images);
    }
    let spec = json!({
        "provider": chosen.get("provider").cloned().unwrap_or(Value::Null),
        "request": {
            "model": chosen.get("model").cloned().unwrap_or(Value::Null),
            "system": design::DESIGN_SYSTEM,
            "messages": [message],
            "temperature": 0.6,
            "promptCaching": chosen.get("promptCaching").cloned().unwrap_or(json!(true)),
        },
        "timeoutMs": DESIGN_TIMEOUT_MS,
    });
    let reply = crate::sideband::complete(&spec).await.map_err(|e| format!("Design generation failed: {e}"))?;
    let raw = reply.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
    let folder = folder_path(&folders(ctx).await, &workspace.as_ref().map(nekko_js::display).unwrap_or_default());
    blocking(move || design::land(&dir, workspace.as_ref(), &input, &plan, &raw, folder.as_deref())).await?
}

fn nekko_workspace_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Index a folder off the async threads, telling the UI as it goes.
pub async fn index_now(index: Arc<Index>, hub: Hub, id: String, root: String) -> Result<Value, String> {
    blocking(move || index.index(&id, &root, &|status| hub.publish("index:progress", status.clone(), false))).await
}

#[cfg(test)]
mod tests {
    use nekko_workspace::scoped::secret_path;

    #[test]
    fn scoped_files_hide_at_least_what_the_phone_changes_view_hides() {
        let paths = [
            ".env",
            ".env.local",
            "a/.env.prod",
            ".ssh/config",
            "x/.aws/credentials",
            ".gnupg/k",
            "id_rsa",
            "id_ed25519.pub",
            ".npmrc",
            ".netrc",
            ".pypirc",
            "credentials",
            "a.pem",
            "b.key",
            "c.p12",
            "d.pfx",
            "e.keystore",
            "f.jks",
            "src/environment.ts",
            "README.md",
            "keys/notes.md",
            "Cargo.toml",
        ];
        for p in paths {
            assert_eq!(secret_path(p), nekko_remote::phone_changes::secret_file(p), "{p}");
        }
        // The extras: git's stored credentials and a repository's config.
        assert!(secret_path(".git-credentials") && secret_path(".git/config"));
    }
}
