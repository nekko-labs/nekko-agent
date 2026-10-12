//! The user's projects, served here (PF14): the file explorer, memory notes,
//! line comments, the workspace index, and the git and pull-request state
//! (`crates/nekko-workspace`).
//!
//! A workspace's folder comes from the settings (`crate::settings::current`,
//! the daemon's own store when it knows the data directory); everything runs
//! here, off the async threads. Index progress goes to the UI from here and to the
//! host's own listeners (the phone relay) through `index:progress`, marked
//! `relayOnly` there so the backend's copy is not sent twice.

use crate::backend::Backend;
use crate::hub::Hub;
use crate::routes::Ctx;
use nekko_workspace::{comments, files, git::Git, index::Index, memory, pr::Prs};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;

/// Channels served here whatever the edition.
pub const CHANNELS: &[&str] = &[
    "file:read",
    "file:write",
    "dir:list",
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
];

/// Channels that keep their files in the data directory, served only when
/// this daemon knows it.
pub const DATA_CHANNELS: &[&str] =
    &["memory:list", "memory:save", "memory:delete", "comments:list", "comment:add", "comment:resolve"];

pub struct Workspace {
    data_dir: Option<PathBuf>,
    index: Arc<Index>,
    prs: Arc<Prs>,
    git: Git,
}

impl Workspace {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        let prs = Arc::new(Prs::default());
        Self { data_dir, index: Arc::new(Index::new()), git: Git::new(prs.clone()), prs }
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
    if let Some(store) = ctx.sessions.clone() {
        let id = id.to_string();
        return blocking(move || store.get(&id).unwrap_or(Value::Null)).await.unwrap_or(Value::Null);
    }
    match tokio::time::timeout(crate::routes::AUX_WAIT, ctx.backend.call("session:get", json!([id]))).await {
        Ok(Ok(s)) => s,
        _ => Value::Null,
    }
}

/// The GitHub token for the REST fallback: the GitHub connector's, else the
/// environment's (`githubToken` in pr.ts).
fn github_token(settings: &Value) -> Option<String> {
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
            index_now(ws.index.clone(), ctx.backend.clone(), ctx.hub.clone(), id, root).await
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
            Ok(Value::Array(ws.prs.session_prs(messages, token.as_deref()).await))
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

/// Index a folder off the async threads, telling the UI and the host's
/// listeners as it goes.
pub async fn index_now(
    index: Arc<Index>,
    backend: Arc<Backend>,
    hub: Hub,
    id: String,
    root: String,
) -> Result<Value, String> {
    let rt = tokio::runtime::Handle::current();
    blocking(move || {
        index.index(&id, &root, &|status| {
            hub.publish("index:progress", status.clone(), false);
            let (backend, status) = (backend.clone(), status.clone());
            rt.spawn(async move {
                let _ = backend.call("index:progress", json!([status])).await;
            });
        })
    })
    .await
}
