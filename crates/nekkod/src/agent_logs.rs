//! The agent command logs (PF14 step 5 prep): each chat's read-only
//! `agent_<sessionId>` terminal, where the commands its turns run show their
//! output, and its `sessions/<sessionId>.commands.log` sidecar, which keeps
//! that output across restarts. Ports of `appendAgentTerminal`,
//! `finishAgentTerminal`, `listAgentTerminals`, the agent half of
//! `terminalSnapshot`/`updateTerminal`/`closeTerminal`
//! (`packages/host/src/terminal.ts`) and `agent-log.ts`.
//!
//! Output reaches the UI at once (`terminal:event` on the bus, as the host
//! published it; these terminals have no byte socket). Disk writes go through
//! one writer thread, so appends, a snapshot's read and a delete happen in the
//! order they were asked for, and a deleted log is never written again.

use crate::hub::Hub;
use nekko_js as js;
use nekko_store::SessionStore;
use nekko_tools::CommandLog;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};

/// Rolling output kept in memory per terminal (UTF-16 units, as the host's string was).
const MAX_BUFFER: usize = 256_000;
/// A chat's command log on disk is cut back to its last [`FILE_KEEP`] bytes past this (#1035).
const FILE_MAX: u64 = 5 * 1024 * 1024;
const FILE_KEEP: u64 = 4 * 1024 * 1024;
/// The terminal ids these logs answer for.
pub const PREFIX: &str = "agent_";

pub type ReadSettings = Arc<dyn Fn() -> Value + Send + Sync>;

struct Term {
    info: Map<String, Value>,
    buffer: String,
}

enum Op {
    Append(PathBuf, String),
    Delete(PathBuf, mpsc::Sender<Result<(), String>>),
    Read(PathBuf, usize, mpsc::Sender<Result<Option<String>, String>>),
}

pub struct AgentLogs {
    sessions_dir: PathBuf,
    store: Arc<SessionStore>,
    settings: ReadSettings,
    hub: Hub,
    terms: Mutex<HashMap<String, Term>>,
    removed: Mutex<HashSet<PathBuf>>,
    writer: Mutex<mpsc::Sender<Op>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `(buffer + data).slice(-MAX_BUFFER)` in UTF-16 units.
fn keep_tail(text: String) -> String {
    let units = js::len16(&text);
    if units <= MAX_BUFFER {
        return text;
    }
    let mut drop = units - MAX_BUFFER;
    let mut cut = 0;
    for (i, c) in text.char_indices() {
        if drop == 0 {
            cut = i;
            break;
        }
        drop = drop.saturating_sub(c.len_utf16());
        cut = i + c.len_utf8();
    }
    text[cut..].to_string()
}

/// Cut `path` to about its last `keep` bytes, starting at a line, through a
/// temporary file so a crash midway leaves the old log rather than none.
fn keep_file_tail(path: &Path, keep: u64) -> std::io::Result<()> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(keep)))?;
    let mut tail = Vec::new();
    f.read_to_end(&mut tail)?;
    let start = tail.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
    let private = js::fs::AtomicWrite { mode: js::fs::Mode::Private, ..Default::default() };
    js::fs::atomic_write(path, &tail[start..], private)
}

fn writer_thread(rx: mpsc::Receiver<Op>) {
    // Paths whose last write failed: a read or delete reports it, as `failures` did.
    let mut failures: HashMap<PathBuf, String> = HashMap::new();
    for op in rx {
        match op {
            Op::Append(path, data) => {
                let r = (|| -> std::io::Result<()> {
                    if let Some(dir) = path.parent() {
                        std::fs::create_dir_all(dir)?;
                    }
                    let mut opts = std::fs::OpenOptions::new();
                    opts.create(true).append(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        opts.mode(0o600);
                    }
                    let mut f = opts.open(&path)?;
                    f.write_all(data.as_bytes())?;
                    if f.metadata()?.len() > FILE_MAX {
                        drop(f);
                        keep_file_tail(&path, FILE_KEEP)?;
                    }
                    Ok(())
                })();
                if let Err(e) = r {
                    eprintln!("nekkod: could not persist session command log: {e}");
                    failures.insert(path, e.to_string());
                }
            }
            Op::Delete(path, reply) => {
                let r = match std::fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e.to_string()),
                };
                if r.is_ok() {
                    failures.remove(&path);
                }
                let _ = reply.send(r);
            }
            Op::Read(path, max, reply) => {
                if let Some(e) = failures.get(&path) {
                    let _ = reply.send(Err(e.clone()));
                    continue;
                }
                let _ = reply.send(read_tail(&path, max));
            }
        }
    }
}

/// `readAgentLog`'s bounded tail: the last `max` bytes, a split UTF-8 sequence at the start skipped.
fn read_tail(path: &Path, max: usize) -> Result<Option<String>, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let size = file.metadata().map_err(|e| e.to_string())?.len() as usize;
    let start = size.saturating_sub(max);
    file.seek(SeekFrom::Start(start as u64)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(size - start);
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let skip = bytes.iter().take_while(|b| (**b & 0xc0) == 0x80).count();
    Ok(Some(String::from_utf8_lossy(&bytes[skip..]).into_owned()))
}

impl AgentLogs {
    pub fn new(data_dir: &Path, store: Arc<SessionStore>, settings: ReadSettings, hub: Hub) -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("nekkod-agent-logs".into())
            .spawn(move || writer_thread(rx))
            .expect("the command log writer starts");
        Arc::new(Self {
            sessions_dir: data_dir.join("sessions"),
            store,
            settings,
            hub,
            terms: Mutex::default(),
            removed: Mutex::default(),
            writer: Mutex::new(tx),
        })
    }

    /// `agentLogPath`: refused for an id that is not a plain chat id.
    fn path(&self, session_id: &str) -> Result<PathBuf, String> {
        let ok =
            !session_id.is_empty() && session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !ok {
            return Err("Invalid command log session ID".into());
        }
        Ok(self.sessions_dir.join(format!("{session_id}.commands.log")))
    }

    fn send(&self, op: Op) {
        let _ = lock(&self.writer).send(op);
    }

    /// `resolveCwd(workspaceId, undefined, sessionId)`: the chat's own checkout,
    /// else the folder, else the first folder, else this process's directory.
    fn cwd(&self, session: Option<&Value>, workspace_id: Option<&str>) -> String {
        let exists = |p: &str| Path::new(p).exists();
        if let Some(s) = session {
            let worktrees = if s.get("gitIsolation") == Some(&json!(false)) {
                None
            } else {
                s.get("gitWorktrees").and_then(Value::as_object)
            };
            if let Some(w) = worktrees {
                let path = workspace_id
                    .and_then(|id| w.get(id))
                    .and_then(|t| t.get("path"))
                    .or_else(|| w.values().next().and_then(|t| t.get("path")))
                    .and_then(Value::as_str);
                if let Some(p) = path.filter(|p| exists(p)) {
                    return p.to_string();
                }
            }
        }
        let settings = (self.settings)();
        let folders = settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
        let path_of = |w: &Value| w.get("path").and_then(Value::as_str).map(str::to_string);
        if let Some(id) = workspace_id
            && let Some(p) = folders.iter().find(|w| w.get("id").and_then(Value::as_str) == Some(id)).and_then(path_of)
            && exists(&p)
        {
            return p;
        }
        if let Some(p) = folders.first().and_then(path_of).filter(|p| exists(p)) {
            return p;
        }
        std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// `appendAgentTerminal` (with `loopLog`'s refusal for a sandbox chat):
    /// the output shown at once and written to the chat's log.
    pub fn append(&self, session_id: &str, workspace_id: Option<&str>, data: &str) {
        self.append_status(session_id, workspace_id, data, true);
    }

    /// A status notice must not make an idle command terminal look running.
    pub fn notice(&self, session_id: &str, data: &str) {
        self.append_status(session_id, None, data, false);
    }

    fn append_status(&self, session_id: &str, workspace_id: Option<&str>, data: &str, running: bool) {
        let session = self.store.get(session_id);
        if session.as_ref().is_some_and(|s| crate::worktrees::execution_mode(s) == "sandbox") {
            return;
        }
        let Ok(path) = self.path(session_id) else { return };
        let id = format!("{PREFIX}{session_id}");
        {
            let mut terms = lock(&self.terms);
            let term = terms.entry(id.clone()).or_insert_with(|| {
                let mut info = Map::new();
                info.insert("id".into(), json!(id));
                info.insert("title".into(), json!("Agent commands"));
                if let Some(w) = workspace_id {
                    info.insert("workspaceId".into(), json!(w));
                }
                info.insert("cwd".into(), json!(self.cwd(session.as_ref(), workspace_id)));
                info.insert("shell".into(), json!("agent"));
                info.insert("agentSessionId".into(), json!(session_id));
                info.insert("createdAt".into(), json!(nekko_js::now_ms_f64()));
                info.insert("running".into(), json!(running));
                Term { info, buffer: String::new() }
            });
            if running {
                term.info.insert("running".into(), json!(true));
                term.info.shift_remove("exitCode");
            }
            term.buffer = keep_tail(std::mem::take(&mut term.buffer) + data);
        }
        self.hub.publish("terminal:event", json!({ "type": "data", "terminalId": id, "data": data }), false);
        if !lock(&self.removed).contains(&path) {
            self.send(Op::Append(path, data.to_string()));
        }
    }

    /// `finishAgentTerminal`: the chat's turn is over.
    pub fn finish(&self, session_id: &str) {
        let id = format!("{PREFIX}{session_id}");
        let ended = {
            let mut terms = lock(&self.terms);
            match terms.get_mut(&id) {
                Some(t) if js::truthy(t.info.get("running")) => {
                    t.info.insert("running".into(), json!(false));
                    t.info.insert("exitCode".into(), json!(0));
                    true
                }
                _ => false,
            }
        };
        if ended {
            self.hub.publish("terminal:event", json!({ "type": "exit", "terminalId": id, "code": 0 }), false);
        }
    }

    /// `listAgentTerminals`.
    pub fn list(&self) -> Vec<Value> {
        let mut infos: Vec<Map<String, Value>> = lock(&self.terms).values().map(|t| t.info.clone()).collect();
        // Manually ordered first (in order), then by age, as `sortTerminals` sorts.
        infos.sort_by(|a, b| {
            let (oa, ob) = (a.get("order").and_then(Value::as_f64), b.get("order").and_then(Value::as_f64));
            match (oa, ob) {
                (Some(x), Some(y)) => x.total_cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => {
                    let age = |m: &Map<String, Value>| m.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0);
                    age(a).total_cmp(&age(b))
                }
            }
        });
        infos.into_iter().map(Value::Object).collect()
    }

    /// The agent half of `terminalSnapshot`: the saved log (after every write
    /// before it), or what this process holds, or `null`.
    pub async fn snapshot(&self, id: &str) -> Result<Value, String> {
        let sid = id.strip_prefix(PREFIX).unwrap_or(id).to_string();
        let path = self.path(&sid)?;
        let (tx, rx) = mpsc::channel();
        self.send(Op::Read(path, MAX_BUFFER, tx));
        let persisted =
            tokio::task::spawn_blocking(move || rx.recv().unwrap_or(Ok(None))).await.map_err(|e| e.to_string())??;
        if let Some(t) = lock(&self.terms).get(id) {
            let buffer = persisted.unwrap_or_else(|| t.buffer.clone());
            return Ok(json!({ "info": t.info, "buffer": buffer, "cols": 80, "rows": 24 }));
        }
        let Some(buffer) = persisted else { return Ok(Value::Null) };
        let created = self.store.get(&sid).and_then(|s| s.get("createdAt").cloned());
        let info = json!({
            "id": id, "title": "Agent commands", "shell": "agent", "agentSessionId": sid, "cwd": "",
            "createdAt": created.unwrap_or(json!(0)), "running": false,
        });
        Ok(json!({ "info": info, "buffer": buffer, "cols": 80, "rows": 24 }))
    }

    /// The agent half of `updateTerminal`: its folder, order and title.
    pub fn update(&self, id: &str, patch: &Value) {
        let mut terms = lock(&self.terms);
        let Some(t) = terms.get_mut(id) else { return };
        if let Some(w) = patch.get("workspaceId") {
            if w.is_null() {
                t.info.shift_remove("workspaceId");
            } else {
                t.info.insert("workspaceId".into(), w.clone());
            }
        }
        if let Some(o) = patch.get("order").filter(|o| !o.is_null()) {
            t.info.insert("order".into(), o.clone());
        }
        if let Some(title) = patch.get("title").filter(|t| js::truthy(Some(t))) {
            t.info.insert("title".into(), title.clone());
        }
    }

    /// `closeTerminal` on an agent log: it leaves the list (its saved log stays).
    pub fn close(&self, id: &str) {
        lock(&self.terms).remove(id);
    }

    /// `deleteAgentLog`, from a blocking caller (the session store's delete,
    /// clear and purge): after every write before it; never written again.
    pub fn delete_blocking(&self, session_id: &str) -> Result<(), String> {
        let path = self.path(session_id)?;
        lock(&self.removed).insert(path.clone());
        let (tx, rx) = mpsc::channel();
        self.send(Op::Delete(path, tx));
        rx.recv().unwrap_or(Ok(()))
    }

    /// Route one `terminal:*` call for an agent log.
    pub async fn route(&self, channel: &str, id: &str, args: &[Value]) -> Result<Value, String> {
        match channel {
            "terminal:snapshot" => self.snapshot(id).await,
            "terminal:update" => {
                self.update(id, args.get(1).unwrap_or(&Value::Null));
                Ok(Value::Null)
            }
            "terminal:close" => {
                self.close(id);
                Ok(Value::Null)
            }
            // Read-only: nothing types into an agent log.
            _ => Ok(Value::Null),
        }
    }
}

impl CommandLog for AgentLogs {
    fn append(&self, session_id: &str, workspace_id: Option<&str>, data: &str) {
        AgentLogs::append(self, session_id, workspace_id, data);
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_long_command_log_keeps_its_last_whole_lines() {
        let d = std::env::temp_dir().join(format!("nekko-cmdlog-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("s.commands.log");
        let text: String = (0..100).map(|i| format!("line {i:03}\n")).collect();
        std::fs::write(&p, &text).unwrap();
        super::keep_file_tail(&p, 95).unwrap();
        let kept = std::fs::read_to_string(&p).unwrap();
        assert!(kept.starts_with("line ") && kept.ends_with("line 099\n"), "{kept:?}");
        assert!(kept.len() <= 95);
        std::fs::remove_dir_all(&d).unwrap();
    }

    use super::*;

    fn logs(dir: &Path) -> Arc<AgentLogs> {
        AgentLogs::new(dir, Arc::new(SessionStore::new(dir)), Arc::new(|| json!({})), Hub::new())
    }

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nekkod-agent-logs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn a_connectivity_notice_does_not_restart_an_idle_terminal() {
        let dir = temp("notice");
        let l = logs(&dir);
        l.notice("s1", "[2026-06-17T10:00:00Z] Internet reachability lost\n");
        assert_eq!(l.list()[0]["running"], false);
        l.append("s1", None, "$ local work\n");
        l.notice("s1", "Internet reachability restored\n");
        assert_eq!(l.list()[0]["running"], true);
        l.finish("s1");
        l.notice("s1", "Manual Continue available\n");
        assert_eq!(l.list()[0]["running"], false);
        assert!(l.snapshot("agent_s1").await.unwrap()["buffer"].as_str().unwrap().contains("Manual Continue"));
        l.delete_blocking("s1").unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn appends_show_list_save_and_delete_in_order() {
        let dir = temp("order");
        let l = logs(&dir);
        l.append("s1", Some("w1"), "$ ls\r\n");
        l.append("s1", Some("w1"), "a.txt\r\n");
        let listed = l.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"], "agent_s1");
        assert_eq!(listed[0]["workspaceId"], "w1");
        assert_eq!(listed[0]["running"], true);
        let snap = l.snapshot("agent_s1").await.unwrap();
        assert_eq!(snap["buffer"], "$ ls\r\na.txt\r\n");
        l.finish("s1");
        assert_eq!(l.list()[0]["exitCode"], 0);
        l.close("agent_s1");
        assert!(l.list().is_empty());
        // Closed but saved: the snapshot comes from the log.
        let snap = l.snapshot("agent_s1").await.unwrap();
        assert_eq!(
            (snap["buffer"].clone(), snap["info"]["running"].clone()),
            (json!("$ ls\r\na.txt\r\n"), json!(false))
        );
        l.delete_blocking("s1").unwrap();
        assert!(!dir.join("sessions/s1.commands.log").exists());
        // Never written again once deleted.
        l.append("s1", None, "late\r\n");
        assert_eq!(l.snapshot("agent_s1").await.unwrap()["buffer"], "late\r\n");
        assert!(!dir.join("sessions/s1.commands.log").exists());
        assert!(l.delete_blocking("../x").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_tail_skips_a_split_utf8_sequence_and_the_buffer_keeps_utf16_units() {
        let dir = temp("tail");
        let p = dir.join("x.log");
        std::fs::write(&p, "ab猫cd").unwrap();
        // "猫" is 3 bytes: a 4-byte tail starts inside it.
        assert_eq!(read_tail(&p, 4).unwrap().unwrap(), "cd");
        assert_eq!(read_tail(&dir.join("none.log"), 4).unwrap(), None);
        let long = "x".repeat(MAX_BUFFER + 10);
        assert_eq!(js::len16(&keep_tail(long)), MAX_BUFFER);
        let _ = std::fs::remove_dir_all(dir);
    }
}
