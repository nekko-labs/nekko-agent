//! The user's projects, served here (PF14): the file explorer, memory notes,
//! line comments and the workspace index (`crates/nekko-workspace`).
//!
//! The folder list is still a setting the TS host keeps, so finding a
//! workspace's folder asks it (`settings:get`); everything else runs here,
//! off the async threads. Index progress goes to the UI from here and to the
//! host's own listeners (the phone relay) through `index:progress`, marked
//! `relayOnly` there so the backend's copy is not sent twice.

use crate::backend::Backend;
use crate::hub::Hub;
use nekko_workspace::{comments, files, index::Index, memory};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// How long a call waits on the host for the folder list.
const SETTINGS_WAIT: Duration = Duration::from_secs(5);

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
];

/// Channels that keep their files in the data directory, served only when
/// this daemon knows it.
pub const DATA_CHANNELS: &[&str] =
    &["memory:list", "memory:save", "memory:delete", "comments:list", "comment:add", "comment:resolve"];

pub struct Workspace {
    data_dir: Option<PathBuf>,
    index: Arc<Index>,
}

impl Workspace {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self { data_dir, index: Arc::new(Index::new()) }
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

/// The saved folders, `settings.workspaces`, from the host.
async fn folders(backend: &Backend) -> Vec<Value> {
    match tokio::time::timeout(SETTINGS_WAIT, backend.call("settings:get", json!([]))).await {
        Ok(Ok(s)) => s.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn folder_path(folders: &[Value], id: &str) -> Option<String> {
    folders
        .iter()
        .find(|w| w.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|w| w.get("path").and_then(Value::as_str))
        .map(str::to_string)
}

pub async fn route(
    ws: &Workspace,
    backend: &Arc<Backend>,
    hub: &Hub,
    channel: &str,
    args: &[Value],
) -> Result<Value, String> {
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
            let Some(root) = folder_path(&folders(backend).await, &id) else {
                return Err("Workspace not found".into());
            };
            index_now(ws.index.clone(), backend.clone(), hub.clone(), id, root).await
        }
        "workspace:search" => {
            let id = text(&args, 0);
            if folder_path(&folders(backend).await, &id).is_none() {
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
            Ok(Value::Array(snippets_for(ws, backend, &ids, &text(&args, 1)).await))
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

/// The chat's index snippets (`collectIndexSnippets` in chat.ts): for the
/// daemon's own turn admission, the same as `workspace:snippets`. Each is
/// `{ relPath, path, body }`, the TS `ContextSnippet` shape.
#[allow(dead_code, reason = "chat admission moving into the daemon calls it")]
pub async fn index_snippets(ctx: &crate::routes::Ctx, workspace_ids: &[String], text: &str) -> Vec<Value> {
    snippets_for(&ctx.workspace, &ctx.backend, workspace_ids, text).await
}

async fn snippets_for(ws: &Workspace, backend: &Backend, ids: &[String], query: &str) -> Vec<Value> {
    let saved = if ids.is_empty() { Vec::new() } else { folders(backend).await };
    let found: Vec<(String, bool)> = ids.iter().map(|id| (id.clone(), folder_path(&saved, id).is_some())).collect();
    let (index, query) = (ws.index.clone(), query.to_string());
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
