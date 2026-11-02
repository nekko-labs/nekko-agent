//! Terminal sessions: one shell on a pseudo-terminal per terminal.
//!
//! The data path, per terminal:
//!
//! ```text
//! pty reader thread --(bounded channel)--> pump task --> ring + subscribers + JSON event
//! subscriber input  --(channel)----------> writer thread --> pty
//! ```
//!
//! Three properties matter and are what the TS host lacked:
//!
//! - **Output is coalesced per frame.** The pump forwards the first chunk after
//!   a quiet frame immediately (so a keystroke's echo is never delayed) and
//!   batches everything else into one message per [`FRAME`], so a flood costs
//!   the UI one write per frame instead of one per read.
//! - **Flow control.** Every subscriber acknowledges the bytes it has parsed.
//!   While any healthy subscriber has more than [`HIGH_WATER`] unacknowledged,
//!   the pump stops pulling from the reader; the bounded channel fills, the
//!   reader thread blocks, the kernel's pty buffer fills, and the program
//!   writing the output blocks. A flood slows the producer, not the app.
//! - **A slow client cannot freeze the shell.** A subscriber that stays over the
//!   high-water mark for [`STALL_AFTER`] stops counting for backpressure, and
//!   one that falls [`DROP_AFTER`] bytes behind is disconnected (it reattaches
//!   from the ring snapshot).

use crate::ring::Ring;
use crate::shells::ShellOption;
use crate::tail::tail_cut;
use crate::utf8::Utf8Carry;
use bytes::Bytes;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};

/// Scrollback retained per terminal for reattach.
pub const RING_CAP: usize = 2 * 1024 * 1024;
/// One frame at 120 Hz, rounded down.
pub const FRAME: Duration = Duration::from_millis(8);
/// A batch is flushed early once it reaches this size.
pub const BATCH_MAX: usize = 64 * 1024;
/// Unacknowledged bytes per subscriber above which the pty stops being read.
pub const HIGH_WATER: usize = 1024 * 1024;
/// How long a subscriber may sit above [`HIGH_WATER`] before it is ignored.
pub const STALL_AFTER: Duration = Duration::from_secs(2);
/// How far behind a subscriber may fall before it is disconnected.
pub const DROP_AFTER: usize = 8 * 1024 * 1024;

const READ_BUF: usize = 64 * 1024;
/// Chunks the reader may queue ahead of the pump (the backpressure window).
const READ_QUEUE: usize = 8;
/// After the shell exits, how long to wait for trailing output before closing.
const EXIT_DRAIN: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub cwd: String,
    pub shell: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<f64>,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The chat this terminal was opened for (`terminal:create` / `ssh:open`
    /// with a `sessionId`), so a phone can list one chat's terminals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Remote viewers (a paired phone) attached right now; empty means only
    /// the desktop. The desktop shows a badge while this is non-empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub viewers: Vec<TerminalViewer>,
}

/// A remote viewer of a terminal, as the remote layer names it. Display only:
/// the desktop badge reads `name`, nothing here grants anything.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalViewer {
    /// Stable per viewer (a paired device's id); attach and detach key on it.
    pub id: String,
    /// What kind of viewer, e.g. `phone`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// When it attached (ms since the epoch).
    pub since: u64,
}

impl TerminalViewer {
    /// A viewer attaching now.
    pub fn new(id: impl Into<String>, kind: impl Into<String>, name: Option<String>) -> Self {
        Self {
            id: id.into(),
            kind: kind.into(),
            name: name.filter(|n| !n.trim().is_empty()),
            since: nekko_js::now_ms(),
        }
    }
}

/// What to launch. Resolution of the shell and working directory (which needs
/// the user's settings) happens in the caller.
pub struct CreateSpec {
    pub title: Option<String>,
    pub workspace_id: Option<String>,
    /// The chat this terminal belongs to, recorded on its info.
    pub session_id: Option<String>,
    pub cwd: PathBuf,
    pub shell: ShellOption,
    pub cols: u16,
    pub rows: u16,
    /// Extra environment on top of the daemon's own.
    pub env: Vec<(String, String)>,
}

/// Sidebar edits; `workspace_id: Some(None)` clears the project.
#[derive(Default)]
pub struct UpdatePatch {
    pub workspace_id: Option<Option<String>>,
    pub order: Option<f64>,
    pub title: Option<String>,
}

/// What a stream subscriber receives.
#[derive(Debug)]
pub enum StreamMsg {
    Data(Bytes),
    Exit(Option<i32>),
}

/// Registry-wide events, for the JSON `terminal:event` channel.
#[derive(Clone, Debug)]
pub enum RegistryEvent {
    Data {
        id: String,
        text: String,
    },
    Exit {
        id: String,
        code: Option<i32>,
    },
    /// The terminal's remote viewers changed (`terminal:viewers`).
    Viewers {
        id: String,
        viewers: Vec<TerminalViewer>,
    },
}

pub struct Snapshot {
    pub info: TerminalInfo,
    pub buffer: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
}

struct Sub {
    id: u64,
    tx: mpsc::UnboundedSender<StreamMsg>,
    unacked: usize,
    over_since: Option<Instant>,
}

struct State {
    ring: Ring,
    subs: Vec<Sub>,
    cols: u16,
    rows: u16,
    /// `Some` once the shell has exited and its last output was delivered.
    exit: Option<Option<i32>>,
    next_sub: u64,
}

struct Term {
    id: String,
    info: Mutex<TerminalInfo>,
    state: Mutex<State>,
    flow: Notify,
    input: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
}

fn new_id() -> String {
    let mut r = [0u8; 4];
    let _ = getrandom::fill(&mut r);
    format!("term_{}_{}", to_base36(nekko_js::now_ms()), to_base36(u32::from_le_bytes(r) as u64 % 1_000_000))
}

fn to_base36(mut n: u64) -> String {
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

impl Term {
    /// True while a healthy subscriber is too far behind to send it more.
    /// Also applies the stall and drop policies as a side effect.
    fn congested(&self) -> bool {
        let mut st = self.state.lock().unwrap();
        let now = Instant::now();
        let mut congested = false;
        st.subs.retain_mut(|s| {
            if s.unacked > DROP_AFTER {
                return false;
            }
            if s.unacked > HIGH_WATER {
                let since = *s.over_since.get_or_insert(now);
                if now.duration_since(since) < STALL_AFTER {
                    congested = true;
                }
            } else {
                s.over_since = None;
            }
            true
        });
        congested
    }

    fn deliver(&self, bytes: &Bytes) {
        let mut st = self.state.lock().unwrap();
        st.ring.push(bytes);
        st.subs.retain_mut(|s| {
            s.unacked += bytes.len();
            s.tx.send(StreamMsg::Data(bytes.clone())).is_ok()
        });
    }

    fn finish(&self, code: Option<i32>) {
        {
            let mut info = self.info.lock().unwrap();
            info.running = false;
            info.exit_code = code;
        }
        let mut st = self.state.lock().unwrap();
        st.exit = Some(code);
        for s in &st.subs {
            let _ = s.tx.send(StreamMsg::Exit(code));
        }
    }

    fn running(&self) -> bool {
        self.info.lock().unwrap().running
    }

    fn write(&self, bytes: &[u8]) {
        if !self.running() {
            return;
        }
        if let Some(tx) = &self.input {
            let _ = tx.send(bytes.to_vec());
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        {
            let mut st = self.state.lock().unwrap();
            st.cols = cols;
            st.rows = rows;
        }
        if let Some(m) = self.master.lock().unwrap().as_ref() {
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    fn kill(&self) {
        if let Some(k) = self.killer.lock().unwrap().as_mut() {
            let _ = k.kill();
        }
    }
}

/// Every live terminal, keyed by id.
pub struct Registry {
    terms: Mutex<HashMap<String, Arc<Term>>>,
    events: broadcast::Sender<RegistryEvent>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(4096);
        Self { terms: Mutex::new(HashMap::new()), events }
    }

    pub fn events(&self) -> broadcast::Receiver<RegistryEvent> {
        self.events.subscribe()
    }

    fn get(&self, id: &str) -> Option<Arc<Term>> {
        self.terms.lock().unwrap().get(id).cloned()
    }

    /// Start a shell. Must be called inside a tokio runtime (the pump is a task).
    pub fn create(&self, spec: CreateSpec) -> TerminalInfo {
        let id = new_id();
        let cols = spec.cols.max(1);
        let rows = spec.rows.max(1);
        let mut info = TerminalInfo {
            id: id.clone(),
            title: spec.title.filter(|t| !t.is_empty()).unwrap_or_else(|| spec.shell.label.clone()),
            workspace_id: spec.workspace_id,
            cwd: spec.cwd.to_string_lossy().into_owned(),
            shell: spec.shell.path.clone(),
            created_at: nekko_js::now_ms(),
            order: None,
            running: true,
            exit_code: None,
            session_id: spec.session_id.filter(|s| !s.is_empty()),
            viewers: Vec::new(),
        };

        match spawn_pty(&spec.shell, &spec.cwd, cols, rows, &spec.env) {
            Ok(parts) => {
                let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
                let term = Arc::new(Term {
                    id: id.clone(),
                    info: Mutex::new(info.clone()),
                    state: Mutex::new(State {
                        ring: Ring::new(RING_CAP),
                        subs: Vec::new(),
                        cols,
                        rows,
                        exit: None,
                        next_sub: 1,
                    }),
                    flow: Notify::new(),
                    input: Some(input_tx),
                    master: Mutex::new(Some(parts.master)),
                    killer: Mutex::new(Some(parts.killer)),
                });
                self.terms.lock().unwrap().insert(id.clone(), term.clone());

                let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(READ_QUEUE);
                let mut reader = parts.reader;
                std::thread::Builder::new()
                    .name(format!("{id}-read"))
                    .spawn(move || {
                        let mut buf = vec![0u8; READ_BUF];
                        loop {
                            match reader.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    if chunk_tx.blocking_send(buf[..n].to_vec()).is_err() {
                                        break;
                                    }
                                }
                                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                                Err(_) => break,
                            }
                        }
                    })
                    .ok();

                let mut writer = parts.writer;
                std::thread::Builder::new()
                    .name(format!("{id}-write"))
                    .spawn(move || {
                        while let Ok(bytes) = input_rx.recv() {
                            if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                                break;
                            }
                        }
                    })
                    .ok();

                let (exit_tx, exit_rx) = oneshot::channel::<Option<i32>>();
                let mut child = parts.child;
                let waiter = term.clone();
                std::thread::Builder::new()
                    .name(format!("{id}-wait"))
                    .spawn(move || {
                        let code = child.wait().ok().map(|s| s.exit_code() as i32);
                        let _ = exit_tx.send(code);
                        // ConPTY keeps the output pipe open until the pseudo
                        // console is closed; give trailing output a moment,
                        // then close it so the reader sees EOF.
                        std::thread::sleep(Duration::from_millis(50));
                        waiter.master.lock().unwrap().take();
                    })
                    .ok();

                tokio::spawn(pump(term, chunk_rx, exit_rx, self.events.clone()));
            }
            Err(err) => {
                info.running = false;
                info.exit_code = Some(-1);
                let mut ring = Ring::new(RING_CAP);
                ring.push(format!("Failed to start {}: {err}\r\n", spec.shell.path).as_bytes());
                let term = Arc::new(Term {
                    id: id.clone(),
                    info: Mutex::new(info.clone()),
                    state: Mutex::new(State { ring, subs: Vec::new(), cols, rows, exit: Some(Some(-1)), next_sub: 1 }),
                    flow: Notify::new(),
                    input: None,
                    master: Mutex::new(None),
                    killer: Mutex::new(None),
                });
                self.terms.lock().unwrap().insert(id.clone(), term);
                let _ = self.events.send(RegistryEvent::Exit { id, code: Some(-1) });
            }
        }
        info
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let mut all: Vec<TerminalInfo> =
            self.terms.lock().unwrap().values().map(|t| t.info.lock().unwrap().clone()).collect();
        // Manually ordered terminals first (in order), then the rest by age.
        all.sort_by(|a, b| match (a.order, b.order) {
            (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.created_at.cmp(&b.created_at),
        });
        all
    }

    pub fn contains(&self, id: &str) -> bool {
        self.terms.lock().unwrap().contains_key(id)
    }

    pub fn update(&self, id: &str, patch: UpdatePatch) {
        let Some(t) = self.get(id) else { return };
        let mut info = t.info.lock().unwrap();
        if let Some(ws) = patch.workspace_id {
            info.workspace_id = ws;
        }
        if let Some(o) = patch.order {
            info.order = Some(o);
        }
        if let Some(title) = patch.title.filter(|t| !t.is_empty()) {
            info.title = title;
        }
    }

    pub fn snapshot(&self, id: &str) -> Option<Snapshot> {
        let t = self.get(id)?;
        let info = t.info.lock().unwrap().clone();
        let st = t.state.lock().unwrap();
        Some(Snapshot { info, buffer: st.ring.snapshot(), cols: st.cols, rows: st.rows })
    }

    /// The snapshot with only the last `max_bytes` of scrollback, cut where a
    /// replay starts cleanly (see [`tail_cut`]). For viewers on a slow link.
    pub fn tail(&self, id: &str, max_bytes: usize) -> Option<(Snapshot, usize)> {
        let mut snap = self.snapshot(id)?;
        let total = snap.buffer.len();
        let start = tail_cut(&snap.buffer, max_bytes);
        snap.buffer.drain(..start);
        Some((snap, total))
    }

    /// Mark `viewer` as watching terminal `id` (a phone opened it). Attaching
    /// again with the same viewer id replaces its name and keeps one entry.
    /// Returns the viewers after the change, or `None` for an unknown terminal.
    pub fn attach_viewer(&self, id: &str, viewer: TerminalViewer) -> Option<Vec<TerminalViewer>> {
        let t = self.get(id)?;
        let viewers = {
            let mut info = t.info.lock().unwrap();
            match info.viewers.iter_mut().find(|v| v.id == viewer.id) {
                Some(v) => {
                    v.kind = viewer.kind;
                    v.name = viewer.name;
                }
                None => info.viewers.push(viewer),
            }
            info.viewers.clone()
        };
        let _ = self.events.send(RegistryEvent::Viewers { id: id.to_string(), viewers: viewers.clone() });
        Some(viewers)
    }

    /// The viewer left terminal `id`. Returns the viewers after the change,
    /// or `None` for an unknown terminal. No event when nothing changed.
    pub fn detach_viewer(&self, id: &str, viewer_id: &str) -> Option<Vec<TerminalViewer>> {
        let t = self.get(id)?;
        let (changed, viewers) = {
            let mut info = t.info.lock().unwrap();
            let before = info.viewers.len();
            info.viewers.retain(|v| v.id != viewer_id);
            (info.viewers.len() != before, info.viewers.clone())
        };
        if changed {
            let _ = self.events.send(RegistryEvent::Viewers { id: id.to_string(), viewers: viewers.clone() });
        }
        Some(viewers)
    }

    /// The viewer left every terminal (its connection dropped). Returns the
    /// ids of the terminals it was attached to.
    pub fn detach_viewer_everywhere(&self, viewer_id: &str) -> Vec<String> {
        let ids: Vec<String> = self
            .terms
            .lock()
            .unwrap()
            .values()
            .filter(|t| t.info.lock().unwrap().viewers.iter().any(|v| v.id == viewer_id))
            .map(|t| t.id.clone())
            .collect();
        for id in &ids {
            self.detach_viewer(id, viewer_id);
        }
        ids
    }

    pub fn write(&self, id: &str, bytes: &[u8]) {
        if let Some(t) = self.get(id) {
            t.write(bytes);
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(t) = self.get(id)
            && t.running()
        {
            t.resize(cols, rows);
        }
    }

    /// Type a command line and press Enter.
    pub fn run(&self, id: &str, command: &str) {
        self.write(id, format!("{command}\r").as_bytes());
    }

    /// Ctrl-C is ETX on the input stream; the tty turns it into SIGINT.
    pub fn interrupt(&self, id: &str) {
        self.write(id, b"\x03");
    }

    pub fn close(&self, id: &str) {
        if let Some(t) = self.terms.lock().unwrap().remove(id) {
            t.kill();
        }
    }

    pub fn close_all(&self) {
        let all: Vec<Arc<Term>> = self.terms.lock().unwrap().drain().map(|(_, t)| t).collect();
        for t in all {
            t.kill();
        }
    }

    /// Attach a stream subscriber. The snapshot and the subscription are taken
    /// under one lock, so no output falls between them.
    pub fn subscribe(&self, id: &str) -> Option<Subscription> {
        let term = self.get(id)?;
        let info = term.info.lock().unwrap().clone();
        let (tx, rx) = mpsc::unbounded_channel();
        let (sub_id, snapshot, exit, cols, rows) = {
            let mut st = term.state.lock().unwrap();
            let sub_id = st.next_sub;
            st.next_sub += 1;
            if st.exit.is_none() {
                st.subs.push(Sub { id: sub_id, tx, unacked: 0, over_since: None });
            }
            (sub_id, st.ring.snapshot(), st.exit, st.cols, st.rows)
        };
        Some(Subscription { rx, handle: SubHandle { term, sub_id }, snapshot, exit, cols, rows, info })
    }
}

impl Drop for Registry {
    fn drop(&mut self) {
        self.close_all();
    }
}

/// One attached viewer of a terminal.
pub struct Subscription {
    pub rx: mpsc::UnboundedReceiver<StreamMsg>,
    /// Acknowledge, type and resize through this; dropping it detaches.
    pub handle: SubHandle,
    /// Scrollback at the moment of attaching, to replay first.
    pub snapshot: Vec<u8>,
    /// Set when the shell had already exited at attach time.
    pub exit: Option<Option<i32>>,
    pub cols: u16,
    pub rows: u16,
    /// The terminal as it was at attach time.
    pub info: TerminalInfo,
}

impl Subscription {
    pub fn ack(&self, n: usize) {
        self.handle.ack(n);
    }
}

/// The viewer's side of a subscription, separate from its receiver so a socket
/// can read input on one task while it writes output on another.
pub struct SubHandle {
    term: Arc<Term>,
    sub_id: u64,
}

impl SubHandle {
    pub fn ack(&self, n: usize) {
        let mut st = self.term.state.lock().unwrap();
        if let Some(s) = st.subs.iter_mut().find(|s| s.id == self.sub_id) {
            s.unacked = s.unacked.saturating_sub(n);
            if s.unacked <= HIGH_WATER {
                s.over_since = None;
            }
        }
        drop(st);
        self.term.flow.notify_waiters();
    }

    pub fn write(&self, bytes: &[u8]) {
        self.term.write(bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if self.term.running() {
            self.term.resize(cols, rows);
        }
    }
}

impl Drop for SubHandle {
    fn drop(&mut self) {
        let mut st = self.term.state.lock().unwrap();
        st.subs.retain(|s| s.id != self.sub_id);
        drop(st);
        self.term.flow.notify_waiters();
    }
}

async fn pump(
    term: Arc<Term>,
    mut rx: mpsc::Receiver<Vec<u8>>,
    mut exit_rx: oneshot::Receiver<Option<i32>>,
    events: broadcast::Sender<RegistryEvent>,
) {
    let mut carry = Utf8Carry::default();
    let mut last_flush = Instant::now() - FRAME;
    let mut exit: Option<Option<i32>> = None;
    let mut startup_query = cfg!(windows);
    loop {
        // Backpressure: hold the reader while a healthy subscriber is behind.
        while term.congested() {
            let notified = term.flow.notified();
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
        }

        let first = if exit.is_some() {
            // The shell is gone: drain what is left, but stop once it goes quiet
            // (a background job can hold the pty open indefinitely).
            match tokio::time::timeout(EXIT_DRAIN, rx.recv()).await {
                Ok(Some(c)) => c,
                _ => break,
            }
        } else {
            tokio::select! {
                c = rx.recv() => match c { Some(c) => c, None => break },
                code = &mut exit_rx => {
                    exit = Some(code.unwrap_or(None));
                    continue;
                }
            }
        };

        let mut batch = first;
        if last_flush.elapsed() < FRAME {
            // Output inside the frame we just flushed: gather until it ends.
            let deadline = tokio::time::Instant::from_std(last_flush + FRAME);
            while batch.len() < BATCH_MAX {
                tokio::select! {
                    c = rx.recv() => match c { Some(c) => batch.extend_from_slice(&c), None => break },
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }
        } else {
            // First output after a quiet frame (a keystroke's echo): send now.
            while batch.len() < BATCH_MAX {
                match rx.try_recv() {
                    Ok(c) => batch.extend_from_slice(&c),
                    Err(_) => break,
                }
            }
        }
        last_flush = Instant::now();
        if startup_query {
            startup_query = false;
            answer_startup_cursor_query(&term, &mut batch);
            if batch.is_empty() {
                continue;
            }
        }
        let bytes = Bytes::from(batch);
        term.deliver(&bytes);
        let text = carry.decode(&bytes);
        if !text.is_empty() {
            let _ = events.send(RegistryEvent::Data { id: term.id.clone(), text });
        }
    }

    let code = match exit {
        Some(c) => c,
        None => tokio::time::timeout(Duration::from_secs(2), exit_rx).await.ok().and_then(|r| r.ok()).flatten(),
    };
    term.finish(code);
    let _ = events.send(RegistryEvent::Exit { id: term.id.clone(), code });
}

/// ConPTY opens by asking the terminal where its cursor is (`ESC[6n`) and
/// holds every byte of output until it gets an answer. With no viewer attached
/// (a terminal created before its pane opens, or one nobody is looking at) no
/// answer ever comes and the shell looks frozen, so the daemon answers the
/// opening query itself and keeps it out of the scrollback. Later queries from
/// programs are the viewer's to answer.
fn answer_startup_cursor_query(term: &Term, batch: &mut Vec<u8>) {
    const QUERY: &[u8] = b"[6n";
    if let Some(at) = batch.windows(QUERY.len()).position(|w| w == QUERY) {
        batch.drain(at..at + QUERY.len());
        if let Some(tx) = &term.input {
            let _ = tx.send(b"[1;1R".to_vec());
        }
    }
}

struct PtyParts {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

fn spawn_pty(
    shell: &ShellOption,
    cwd: &std::path::Path,
    cols: u16,
    rows: u16,
    env: &[(String, String)],
) -> Result<PtyParts, String> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&shell.path);
    if let Some(args) = &shell.args {
        cmd.args(args);
    }
    cmd.cwd(cwd);
    // A real TTY: advertise what the renderer supports, leave PAGER alone.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok(PtyParts { master: pair.master, reader, writer, child, killer })
}
