//! The runner supervisor: every `TICK` it reads the Mac, stops what the gates
//! or the hard limits say must stop, boots at most one new job VM, follows
//! each VM's registration, and cleans up VMs that ended. Each slot runs one
//! job in a throwaway clone: Starting (booting, not yet online), Ready (online,
//! waiting for a job), Running, Draining (a gate failed; the job has a grace
//! period), Cleaning (stopped or stopping; its clone is deleted once the
//! helper is reaped).

use super::audit::{self, AuditLine, AuditResult, Today};
use super::awake::Awake;
use super::provider::{JobRef, Provider, ProviderError, RunnerStatus};
use super::signals::{MacState, Sense, signals_for};
use super::store::{RunnerRecord, overlaps};
use super::updates::write_atomic;
use super::vm::{RunHandle, RunSpec, Stopped, Vm, reap};
use nekko_runner::{
    Decision, HostFacts, MAX_MACOS_VMS, Reason, RunnerConfig, SlotLimit, cpus_per_vm, evaluate, hold_awake, keep_idle,
    macos_slots_explained, recommended_runner_memory_mb, runner_memory_mb, vms_wanted, warm_slots,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::oneshot::error::TryRecvError;

pub const TICK: Duration = Duration::from_secs(5);
/// A wall-clock jump this far past a tick means the Mac slept.
pub const WAKE_GAP_SECS: f64 = 60.0;
pub const STATUS_POLL: Duration = Duration::from_secs(15);
pub const QUEUE_POLL: Duration = Duration::from_secs(30);
/// A ready VM above what is wanted stops after this long.
pub const IDLE_READY_SECS: u64 = 180;
pub const BOOT_TIMEOUT: Duration = Duration::from_secs(600);
pub const RERUN_EVERY: Duration = Duration::from_secs(60);
pub const RERUN_FOR: Duration = Duration::from_secs(30 * 60);
/// A failed registration removal backs off from `RERUN_EVERY`, doubling up to this.
pub const REMOVE_BACKOFF_MAX: Duration = Duration::from_secs(10 * 60);
/// How long a removed record waits for its failed removals before it is handed back anyway.
pub const REMOVE_FOR: Duration = Duration::from_secs(60 * 60);
pub const MAX_START_FAILURES: u32 = 3;
/// Bounds every provider call, so a slow CI service never holds up the next
/// tick's hard limits for long.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a wake waits for killed VMs to be reaped before moving on.
const KILL_WAIT: Duration = Duration::from_secs(10);
const NO_IMAGE: &str = "No VM image yet.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerState {
    Off,
    Waiting,
    Ready,
    Running,
    Draining,
    Cleaning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotState {
    Starting,
    Ready,
    Running,
    Draining,
    Cleaning,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub state: SlotState,
    pub job: Option<JobRef>,
    pub since: u64,
    pub drain_ends_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerView {
    pub config: RunnerConfig,
    pub state: RunnerState,
    pub slots: Vec<SlotView>,
    pub reasons: Vec<Reason>,
    pub available: u8,
    pub limit: Option<SlotLimit>,
    pub awake: bool,
    pub error: Option<String>,
    pub today: Today,
    pub host: HostView,
    /// This runner's last jobs, newest first.
    pub recent: Vec<AuditLine>,
}

/// The Mac's facts as one runner sees them, for the settings sheet.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub ram_mb: u64,
    pub cores: u8,
    pub recommended_memory_mb: u64,
    pub runner_memory_mb: u64,
    pub cpus_per_vm: u8,
    pub on_battery: Option<bool>,
    pub battery_pct: Option<f64>,
    pub network_id: Option<String>,
    pub network_trusted: bool,
}

impl HostView {
    fn of(m: &MacState, s: &nekko_runner::RunnerSettings) -> HostView {
        let host = HostFacts { ram_mb: m.ram_mb, cores: m.cores, other_macos_vms: 0, user_memory_mb: m.user_memory_mb };
        HostView {
            ram_mb: m.ram_mb,
            cores: m.cores,
            recommended_memory_mb: recommended_runner_memory_mb(&host),
            runner_memory_mb: runner_memory_mb(s, &host),
            cpus_per_vm: cpus_per_vm(s, &host),
            on_battery: m.power.map(|p| p.on_battery),
            battery_pct: m.power.and_then(|p| p.percent),
            network_id: m.network_id.clone(),
            network_trusted: m.network_id.as_ref().is_some_and(|id| s.trusted_networks.contains(id)),
        }
    }
}

/// Lines kept per runner for `RunnerView::recent`.
const RECENT: usize = 5;

/// Why we stopped a VM.
struct Stop {
    reasons: Vec<String>,
    /// False for `maxJobTime`: a job that ran out of time is not re-run.
    rerun: bool,
    /// Lost to a sleep rather than stopped on purpose.
    lost: bool,
    killed: bool,
}

struct Slot {
    /// The runner name, also the folder under `vms/`.
    name: String,
    runner_id: u64,
    handle: RunHandle,
    memory_mb: u32,
    state: SlotState,
    since: f64,
    started_at: f64,
    polled_at: f64,
    online: bool,
    /// When the provider first reported `Busy`.
    busy_since: Option<f64>,
    idle_since: Option<f64>,
    job: Option<JobRef>,
    drain_ends_at: Option<f64>,
    stop: Option<Stop>,
}

impl Slot {
    fn set_state(&mut self, state: SlotState, now: f64) {
        if self.state != state {
            self.state = state;
            self.since = now;
        }
    }

    /// Asks the VM to shut down, or kills it; a later kill escalates a stop.
    fn halt(&mut self, now: f64, reasons: Vec<String>, kill: bool, rerun: bool) {
        if self.stop.is_none() {
            self.stop = Some(Stop { reasons, rerun, lost: false, killed: false });
            self.drain_ends_at = None;
            self.set_state(SlotState::Cleaning, now);
            if !kill {
                self.handle.request_stop();
            }
        }
        if let Some(stop) = &mut self.stop
            && kill
            && !stop.killed
        {
            stop.killed = true;
            self.handle.kill();
        }
    }
}

struct Runner {
    record: RunnerRecord,
    /// No longer in the records: its VMs are stopped and it goes once they are cleaned.
    dropped: bool,
    slots: Vec<Slot>,
    /// Sticky until the record changes: auth refused, or too many failed starts.
    error: Option<String>,
    /// Re-checked every tick.
    blocked: Option<String>,
    start_failures: u32,
    /// A new VM may start (every gate passes).
    gates_pass: bool,
    /// A booted VM with no job may stay: the gates without the start-only checks.
    keep_idle: bool,
    idle_why: Vec<Reason>,
    reasons: Vec<Reason>,
    available: u8,
    limit: Option<SlotLimit>,
    wanted: u8,
    queued: u32,
    queue_polled_at: Option<f64>,
    /// After a transient mint error, no mint before this.
    mint_after: Option<f64>,
    awake: bool,
    /// Newest first, at most `RECENT`; seeded from the audit log, then pushed to.
    recent: VecDeque<AuditLine>,
}

impl Runner {
    fn new(record: RunnerRecord) -> Runner {
        Runner {
            record,
            dropped: false,
            slots: Vec::new(),
            error: None,
            blocked: None,
            start_failures: 0,
            gates_pass: false,
            keep_idle: false,
            idle_why: Vec::new(),
            reasons: Vec::new(),
            available: 0,
            limit: None,
            wanted: 0,
            queued: 0,
            queue_polled_at: None,
            mint_after: None,
            awake: false,
            recent: VecDeque::new(),
        }
    }

    fn note(&mut self, e: ProviderError) {
        match e {
            ProviderError::Auth(m) => self.error = Some(m),
            ProviderError::Other(m) => eprintln!("runner {}: {m}", self.record.config.id),
        }
    }

    fn state(&self) -> RunnerState {
        let has = |st: SlotState| self.slots.iter().any(|s| s.state == st);
        if !self.record.config.settings.enabled {
            RunnerState::Off
        } else if self.error.is_some() || self.blocked.is_some() {
            RunnerState::Error
        } else if has(SlotState::Draining) {
            RunnerState::Draining
        } else if has(SlotState::Running) {
            RunnerState::Running
        } else if has(SlotState::Cleaning) {
            RunnerState::Cleaning
        } else if has(SlotState::Starting) || has(SlotState::Ready) || self.gates_pass {
            RunnerState::Ready
        } else {
            RunnerState::Waiting
        }
    }
}

/// A lost or stopped job waiting to be re-run.
struct Rerun {
    record: RunnerRecord,
    job: JobRef,
    first_at: f64,
    next_at: f64,
}

/// A registration whose removal failed; a live one still accepts jobs, so it is retried.
struct Removal {
    record: RunnerRecord,
    runner_id: u64,
    name: String,
    next_at: f64,
    /// Seconds to the next try after this one fails.
    backoff: f64,
    /// The credentials were refused: wait for a reconnect (`reset`).
    held: bool,
}

pub struct Supervisor<S: Sense, V: Vm, P: Provider> {
    runners_dir: PathBuf,
    sense: S,
    vm: Result<V, String>,
    provider: P,
    awake: Box<dyn Awake>,
    host: String,
    install: String,
    runners: Vec<Runner>,
    // shortcut: queued re-runs live in memory, lost on daemon restart; persist if pilots show it matters.
    reruns: Vec<Rerun>,
    // shortcut: like `reruns`, lost on a crash. A live record's are swept by `start()`; a removed
    // record is not swept after a restart (its credentials may be gone), so `shutdown` audits them.
    removals: Vec<Removal>,
    /// (repo, job id) of every job ever queued, so each is re-run at most once.
    rerun_seen: HashSet<(String, u64)>,
    /// The wall clock and the monotonic clock at the last tick: the wall
    /// clock keeps counting through sleep, the monotonic one does not.
    last_wall: Option<(f64, tokio::time::Instant)>,
    /// Records whose stale registrations were swept (once per id).
    swept: HashSet<String>,
    /// Removed records whose VMs are all cleaned, for [`Supervisor::take_gone`].
    /// With the wall clock at removal; held while its failed removals are retried.
    gone: Vec<(RunnerRecord, f64)>,
    serial: u64,
    day_start: u64,
    today: HashMap<String, Today>,
    /// The last sample, for `views`; `None` before the first tick.
    mac: Option<MacState>,
    /// An image build is running: it holds the Mac awake too.
    building: Arc<AtomicBool>,
}

/// A provider call that gives up after `PROVIDER_TIMEOUT`.
async fn call<T>(f: impl Future<Output = Result<T, ProviderError>>) -> Result<T, ProviderError> {
    tokio::time::timeout(PROVIDER_TIMEOUT, f)
        .await
        .unwrap_or_else(|_| Err(ProviderError::Other("the CI service did not answer in time".into())))
}

fn reason_names(why: &[Reason]) -> Vec<String> {
    why.iter().filter_map(|r| serde_json::to_value(r).ok()?.as_str().map(str::to_owned)).collect()
}

fn why(d: &Decision) -> &[Reason] {
    match d {
        Decision::Take => &[],
        Decision::Hold { why } | Decision::Drain { why, .. } | Decision::StopNow { why } => why,
    }
}

/// Unix seconds of the local midnight starting the day `ts` falls in.
fn local_midnight(ts: u64) -> u64 {
    use chrono::{Local, TimeZone};
    Local
        .timestamp_opt(ts as i64, 0)
        .single()
        .and_then(|t| t.date_naive().and_hms_opt(0, 0, 0))
        .and_then(|d| d.and_local_timezone(Local).earliest())
        .map_or(ts - ts % 86_400, |d| d.timestamp().max(0) as u64)
}

/// This install's id (8 lowercase hex, `<runners>/install-id`), made once, so
/// our runner names never match another Mac's, even one with the same name.
/// No randomness, no id: a fixed one would collide with every other such Mac.
fn install_id(runners_dir: &Path) -> Result<String, String> {
    let path = runners_dir.join("install-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim();
        if id.len() == 8 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Ok(id.to_owned());
        }
    }
    let mut b = [0u8; 4];
    getrandom::fill(&mut b)
        .map_err(|e| format!("CI runners are unavailable: this Mac could not make its runner id ({e})."))?;
    let id: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let saved = std::fs::create_dir_all(runners_dir).and_then(|()| write_atomic(&path, id.as_bytes()));
    if let Err(e) = saved {
        eprintln!("runner: cannot save {}: {e}", path.display());
    }
    Ok(id)
}

/// Where a record's registrations live, for a person deleting them by hand.
fn place(r: &RunnerRecord) -> String {
    match (&r.config.scope, r.gitlab()) {
        (nekko_runner::Scope::Repo { owner, repo }, None) => format!("repo {owner}/{repo}"),
        (nekko_runner::Scope::Org { org }, None) => format!("org {org}"),
        (nekko_runner::Scope::Repo { owner, repo }, Some(g)) => {
            format!("project {owner}/{repo} (id {}) at {}", g.namespace_id, g.base_url)
        }
        (nekko_runner::Scope::Org { org }, Some(g)) => format!("group {org} (id {}) at {}", g.namespace_id, g.base_url),
    }
}

/// `<host>` in runner names: lowercase `[a-z0-9-]`.
pub(super) fn name_host(host: &str) -> String {
    host.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

impl<S: Sense, V: Vm, P: Provider> Supervisor<S, V, P> {
    pub fn new(
        runners_dir: PathBuf,
        sense: S,
        vm: Result<V, String>,
        provider: P,
        awake: Box<dyn Awake>,
        host_name: String,
    ) -> Self {
        let install = install_id(&runners_dir);
        // Without an id nothing may start: every runner shows why.
        let vm = match &install {
            Ok(_) => vm,
            Err(e) => Err(e.clone()),
        };
        Supervisor {
            install: install.unwrap_or_default(),
            runners_dir,
            sense,
            vm,
            provider,
            awake,
            host: name_host(&host_name),
            runners: Vec::new(),
            reruns: Vec::new(),
            removals: Vec::new(),
            rerun_seen: HashSet::new(),
            last_wall: None,
            swept: HashSet::new(),
            gone: Vec::new(),
            serial: 0,
            day_start: u64::MAX,
            today: HashMap::new(),
            building: Arc::default(),
            mac: None,
        }
    }

    /// `nekko-<host>-<install>-`: our runner names are this plus `<unix secs>-<n>`.
    pub(super) fn prefix(&self) -> String {
        format!("nekko-{}-{}-", self.host, self.install)
    }

    fn vms_dir(&self) -> PathBuf {
        self.runners_dir.join("vms")
    }

    /// Before the first tick: reaps what a crash or a sleep left under `vms/`,
    /// removes our stale registrations, and loads today's totals.
    pub async fn start(&mut self) {
        if let Err(e) = reap(&self.vms_dir()).await {
            eprintln!("runner: cannot clear {}: {e}", self.vms_dir().display());
        }
        self.sweep().await;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        self.roll_day(now);
    }

    /// Whether a runner whose sweep could reach `r`'s registrations has a VM out.
    fn overlaps_live(&self, r: &RunnerRecord) -> bool {
        self.runners.iter().any(|o| overlaps(&o.record, r) && !o.slots.is_empty())
    }

    /// Removes stale registrations of each record not yet swept. The prefix
    /// matches every VM of ours, so a record waits while one of ours it
    /// overlaps is live.
    async fn sweep(&mut self) {
        let prefix = self.prefix();
        for i in 0..self.runners.len() {
            let r = &self.runners[i];
            if r.dropped || self.swept.contains(&r.record.config.id) || self.overlaps_live(&r.record) {
                continue;
            }
            self.swept.insert(r.record.config.id.clone());
            if let Err(e) = call(self.provider.remove_stale(&r.record, &prefix)).await {
                eprintln!("runner {}: cannot remove stale runners: {e}", r.record.config.id);
            }
        }
    }

    /// A changed record clears its error; a dropped one's VMs are stopped and cleaned on the next tick.
    pub fn set_records(&mut self, records: Vec<RunnerRecord>) {
        for r in &mut self.runners {
            r.dropped = true;
        }
        for rec in records {
            match self.runners.iter_mut().find(|r| r.record.config.id == rec.config.id) {
                Some(r) => {
                    if r.record != rec {
                        r.error = None;
                        r.start_failures = 0;
                        r.queue_polled_at = None;
                    }
                    r.record = rec;
                    r.dropped = false;
                }
                None => {
                    let mut r = Runner::new(rec);
                    r.recent = audit::recent(&self.runners_dir, &r.record.config.id, RECENT).into();
                    self.runners.push(r);
                }
            }
        }
        self.retire();
    }

    /// Moves removed runners with no VM left to `gone`.
    fn retire(&mut self) {
        let (gone, keep): (Vec<Runner>, Vec<Runner>) =
            std::mem::take(&mut self.runners).into_iter().partition(|r| r.dropped && r.slots.is_empty());
        self.runners = keep;
        let now = self.wall_now();
        self.gone.extend(gone.into_iter().map(|r| (r.record, now)));
    }

    /// Removed runners whose VMs are all cleaned, each handed back once after
    /// its offline registrations are swept; the caller may then forget its key.
    pub async fn take_gone(&mut self) -> Vec<RunnerRecord> {
        let now = self.wall_now();
        let prefix = self.prefix();
        let mut out = Vec::new();
        for (r, since) in std::mem::take(&mut self.gone) {
            let id = &r.config.id;
            let mine = || self.removals.iter().filter(|q| &q.record.config.id == id);
            let pending = mine().next().is_some();
            // Held ones wait for a reconnect, which a removed record never gets.
            let all_held = mine().all(|q| q.held);
            let early = now < since + REMOVE_FOR.as_secs_f64();
            // GitLab's sweep deletes whatever its status; GitHub's only offline runners, so it never waits.
            let live = r.gitlab().is_some() && self.overlaps_live(&r);
            // Its credentials are forgotten once handed back: until then the retries keep going.
            if early && ((pending && !all_held) || live) {
                self.gone.push((r, since));
                continue;
            }
            if pending {
                self.abandon_removals(&r, now);
            }
            if live {
                let what = format!(
                    "stale runners named {prefix}* in {} were not swept while an overlapping runner was busy; delete them by hand",
                    place(&r)
                );
                self.not_removed(&r, now, what);
            } else if let Err(e) = call(self.provider.remove_stale(&r, &prefix)).await {
                eprintln!("runner {id}: cannot remove stale runners: {e}");
            }
            out.push(r);
        }
        out
    }

    /// Never silent: each registration left behind is logged and audited for deletion by hand.
    fn abandon_removals(&mut self, r: &RunnerRecord, now: f64) {
        let (mine, keep) = std::mem::take(&mut self.removals)
            .into_iter()
            .partition::<Vec<_>, _>(|q| q.record.config.id == r.config.id);
        self.removals = keep;
        let place = place(r);
        for q in mine {
            let what =
                format!("runner {} ({}) in {place} could not be removed; delete it by hand", q.runner_id, q.name);
            self.not_removed(r, now, what);
        }
    }

    /// Logs and audits something of `r` left registered for deletion by hand.
    fn not_removed(&mut self, r: &RunnerRecord, now: f64, what: String) {
        eprintln!("runner {}: {what}", r.config.id);
        let line = AuditLine {
            ts: now as u64,
            runner_id: r.config.id.clone(),
            repo: None,
            workflow: None,
            job: None,
            result: AuditResult::NotRemoved,
            seconds: 0,
            reason: vec![what],
        };
        self.audit(&line);
    }

    /// The daemon is stopping: the failed removals of removed records are audited, since
    /// nothing retries or sweeps them after a restart.
    pub fn shutdown(&mut self) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
        for (r, _) in std::mem::take(&mut self.gone) {
            self.abandon_removals(&r, now);
        }
    }

    /// The owner reconnected: a sticky error is cleared even if the record did not change.
    pub fn reset(&mut self, id: &str) {
        if let Some(r) = self.runners.iter_mut().find(|r| r.record.config.id == id) {
            r.error = None;
            r.start_failures = 0;
        }
        for q in self.removals.iter_mut().filter(|q| q.record.config.id == id) {
            q.held = false;
            q.next_at = 0.0;
            q.backoff = RERUN_EVERY.as_secs_f64();
        }
    }

    /// The records of registrations still waiting for removal: their credentials stay.
    pub fn queued_removals(&self) -> impl Iterator<Item = &RunnerRecord> {
        self.removals.iter().map(|q| &q.record)
    }

    /// The wall clock of the last tick (0 before the first).
    fn wall_now(&self) -> f64 {
        self.last_wall.map_or(0.0, |(w, _)| w)
    }

    pub fn views(&self) -> Vec<RunnerView> {
        let vm_error = self.vm.as_ref().err();
        self.runners
            .iter()
            .filter(|r| !r.dropped)
            .map(|r| RunnerView {
                config: r.record.config.clone(),
                state: if vm_error.is_some() && r.record.config.settings.enabled {
                    RunnerState::Error
                } else {
                    r.state()
                },
                slots: r
                    .slots
                    .iter()
                    .map(|s| SlotView {
                        state: s.state,
                        job: s.job.clone(),
                        since: s.since as u64,
                        drain_ends_at: s.drain_ends_at.map(|t| t as u64),
                    })
                    .collect(),
                reasons: r.reasons.clone(),
                available: r.available,
                limit: r.limit,
                awake: r.awake,
                error: vm_error.cloned().or_else(|| r.error.clone()).or_else(|| r.blocked.clone()),
                today: self.today.get(&r.record.config.id).copied().unwrap_or_default(),
                host: self.mac.as_ref().map(|m| HostView::of(m, &r.record.config.settings)).unwrap_or_default(),
                recent: r.recent.iter().cloned().collect(),
            })
            .collect()
    }

    /// Memory of every VM still running, for the owner's usual-use history.
    pub fn set_building(&mut self, building: Arc<AtomicBool>) {
        self.building = building;
    }

    /// The Mac as of the last tick.
    pub fn mac_state(&self) -> Option<MacState> {
        self.mac.clone()
    }

    pub fn running_vm_mb(&self) -> u64 {
        self.runners.iter().flat_map(|r| &r.slots).map(|s| u64::from(s.memory_mb)).sum()
    }

    fn roll_day(&mut self, now: u64) {
        let midnight = local_midnight(now);
        if midnight != self.day_start {
            self.day_start = midnight;
            self.today = audit::today(&self.runners_dir, midnight);
        }
    }

    pub async fn tick(&mut self) {
        // 1. Read the Mac.
        let m = self.sense.sample().await;
        self.mac = Some(m.clone());
        let now = m.wall_secs;
        let mono = tokio::time::Instant::now();
        // A slow tick (a VM start can take minutes) moves both clocks alike; only a sleep moves the wall alone.
        // A manual or NTP step of the clock by more than WAKE_GAP_SECS also reads as a wake.
        let slept = self
            .last_wall
            .is_some_and(|(wall, at)| (now - wall) - mono.duration_since(at).as_secs_f64() > WAKE_GAP_SECS);
        self.last_wall = Some((now, mono));
        self.roll_day(now as u64);
        for r in &mut self.runners {
            let (s, sig) = (&r.record.config.settings, signals_for(&m, &r.record.config.settings));
            let d = evaluate(s, &sig, false);
            r.gates_pass = d == Decision::Take;
            r.reasons = why(&d).to_vec();
            let keep = keep_idle(s, &sig);
            r.keep_idle = keep == Decision::Take;
            r.idle_why = why(&keep).to_vec();
        }
        if self.vm.is_err() {
            self.awake.set(false);
            return;
        }
        if slept {
            self.wake(now).await;
        } else if !self.runners.is_empty() {
            self.run(&m, now).await;
        }
        // Also with no runner left: a removed record's registrations still need removing.
        self.retry_removals(now).await;
        // 7. Keep awake.
        let mut hold = false;
        for r in self.runners.iter_mut().filter(|r| !r.dropped) {
            let s = &r.record.config.settings;
            let job = r.slots.iter().any(|s| matches!(s.state, SlotState::Running | SlotState::Draining));
            r.awake = hold_awake(s.keep_awake, job, r.gates_pass || (r.keep_idle && !r.slots.is_empty()));
            hold |= r.awake;
        }
        self.awake.set(hold || self.building.load(Ordering::SeqCst));
    }

    /// The Mac slept: every VM is killed, its job audited as lost and queued
    /// for a re-run, and `vms/` reaped. Nothing starts this tick.
    async fn wake(&mut self, now: f64) {
        for slot in self.runners.iter_mut().flat_map(|r| &mut r.slots) {
            slot.halt(now, vec!["slept".into()], true, true);
            if let Some(stop) = &mut slot.stop {
                stop.lost = true;
            }
        }
        let deadline = tokio::time::Instant::now() + KILL_WAIT;
        for ri in 0..self.runners.len() {
            for slot in std::mem::take(&mut self.runners[ri].slots) {
                let mut slot = slot;
                match tokio::time::timeout_at(deadline, &mut slot.handle.done).await {
                    Ok(done) => {
                        self.finish(ri, slot, done.unwrap_or(Stopped::Error("the VM driver went away".into())), now)
                            .await
                    }
                    // Not reaped yet: cleaned by a later tick, never deleted under a live helper.
                    Err(_) => self.runners[ri].slots.push(slot),
                }
            }
        }
        if self.runners.iter().all(|r| r.slots.is_empty())
            && let Err(e) = reap(&self.vms_dir()).await
        {
            eprintln!("runner: cannot clear {}: {e}", self.vms_dir().display());
        }
        self.retire();
    }

    /// Steps 2 to 6 of a normal tick.
    async fn run(&mut self, m: &MacState, now: f64) {
        // 2. Every VZ VM on the Mac, ours and other apps'; a failed count counts as full.
        let count = match &self.vm {
            Ok(vm) => vm.count_vms().await.unwrap_or_else(|e| {
                eprintln!("runner: cannot count VMs: {e}");
                MAX_MACOS_VMS
            }),
            Err(_) => return,
        };

        self.sweep().await;

        // 3. Stop what must stop.
        for r in &mut self.runners {
            let s = &r.record.config.settings;
            let running = evaluate(s, &signals_for(m, s), true);
            let max_secs = f64::from(s.max_job_minutes) * 60.0;
            let idle_why = reason_names(&r.idle_why);
            for slot in &mut r.slots {
                if r.dropped {
                    slot.halt(now, vec!["removed".into()], true, true);
                    continue;
                }
                let Some(busy_since) = slot.busy_since else {
                    // No job here, so stopping loses nothing.
                    if !r.keep_idle {
                        slot.halt(now, idle_why.clone(), true, true);
                    }
                    continue;
                };
                if slot.stop.is_some() {
                    if let Decision::StopNow { why } = &running {
                        slot.halt(now, reason_names(why), true, true);
                    }
                    continue;
                }
                let left = busy_since + max_secs - now;
                if left <= 0.0 {
                    slot.halt(now, vec!["maxJobTime".into()], false, false);
                    continue;
                }
                match &running {
                    Decision::Take | Decision::Hold { .. } => {
                        slot.drain_ends_at = None;
                        slot.set_state(SlotState::Running, now);
                    }
                    Decision::Drain { grace_secs, why } => {
                        let ends = *slot.drain_ends_at.get_or_insert(now + (*grace_secs as f64).min(left));
                        slot.set_state(SlotState::Draining, now);
                        if now >= ends {
                            slot.halt(now, reason_names(why), false, true);
                        }
                    }
                    Decision::StopNow { why } => slot.halt(now, reason_names(why), true, true),
                }
            }
        }

        // 4. New VMs, at most one per tick across all runners.
        let mut started = false;
        for ri in 0..self.runners.len() {
            let r = &mut self.runners[ri];
            let s = r.record.config.settings.clone();
            let ours = u8::try_from(r.slots.len()).unwrap_or(u8::MAX);
            let host = HostFacts {
                ram_mb: m.ram_mb,
                cores: m.cores,
                other_macos_vms: count.saturating_sub(ours),
                user_memory_mb: m.user_memory_mb,
            };
            let (available, limit) = macos_slots_explained(&s, &host);
            (r.available, r.limit) = (available, limit);
            r.wanted = 0;
            if r.dropped {
                continue;
            }
            let image = r.record.image.clone().unwrap_or_else(|| self.runners_dir.join("images").join("default"));
            r.blocked = (!image.is_dir()).then(|| NO_IMAGE.into());
            // `wanted` is kept while booted VMs may stay, so a start-only gate (memory headroom,
            // which counts our own VMs as used) never idles them out.
            if r.blocked.is_some() || !r.keep_idle || r.error.is_some() {
                continue;
            }
            let warm = warm_slots(&s, available);
            if warm < available && r.queue_polled_at.is_none_or(|t| now - t >= QUEUE_POLL.as_secs_f64()) {
                r.queue_polled_at = Some(now);
                match call(self.provider.queued(&r.record)).await {
                    Ok(q) => r.queued = q,
                    Err(e) => r.note(e),
                }
            }
            let busy = r.slots.iter().filter(|s| s.busy_since.is_some() && s.stop.is_none()).count() as u8;
            r.wanted = vms_wanted(available, warm, busy, r.queued);
            let live = r.slots.iter().filter(|s| s.stop.is_none()).count();
            // `slots.len()` counts VMs still shutting down: they hold a place under Apple's cap.
            if started
                || !r.gates_pass
                || r.error.is_some()
                || r.mint_after.is_some_and(|t| now < t)
                || live >= usize::from(r.wanted)
                || r.slots.len() >= usize::from(available)
            {
                continue;
            }
            started = true;
            let spec = (cpus_per_vm(&s, &host), s.memory_per_vm_mb);
            // A start can hold this tick for minutes (bounded by the provider and Vm timeouts);
            // a hard limit that appears meanwhile is acted on next tick.
            self.start_vm(ri, &image, spec, now).await;
        }

        // 5. Follow booting and ready VMs.
        for r in &mut self.runners {
            let mut excess = r.slots.iter().filter(|s| s.stop.is_none()).count().saturating_sub(usize::from(r.wanted));
            for slot in &mut r.slots {
                if slot.stop.is_some() || slot.busy_since.is_some() {
                    continue;
                }
                if now - slot.polled_at >= STATUS_POLL.as_secs_f64() {
                    slot.polled_at = now;
                    match call(self.provider.status(&r.record, slot.runner_id)).await {
                        Ok(RunnerStatus::Busy) => {
                            slot.busy_since = Some(now);
                            slot.idle_since = None;
                            slot.set_state(SlotState::Running, now);
                            match call(self.provider.job(&r.record, slot.runner_id, &slot.name)).await {
                                Ok(job) => slot.job = job,
                                Err(ProviderError::Auth(e)) => r.error = Some(e),
                                Err(e) => eprintln!("runner {}: {e}", r.record.config.id),
                            }
                            continue;
                        }
                        Ok(RunnerStatus::Idle) => {
                            slot.online = true;
                            slot.set_state(SlotState::Ready, now);
                        }
                        Ok(RunnerStatus::Offline | RunnerStatus::Missing) => {}
                        Err(ProviderError::Auth(e)) => r.error = Some(e),
                        Err(e) => eprintln!("runner {}: {e}", r.record.config.id),
                    }
                }
                if !slot.online {
                    if now - slot.started_at >= BOOT_TIMEOUT.as_secs_f64() {
                        slot.halt(now, vec!["bootTimeout".into()], true, true);
                    }
                } else if excess > 0 {
                    excess -= 1;
                    let since = *slot.idle_since.get_or_insert(now);
                    if now - since >= IDLE_READY_SECS as f64 {
                        slot.halt(now, vec!["idle".into()], true, true);
                    }
                } else {
                    slot.idle_since = None;
                }
            }
        }

        // 6. Clean up VMs whose helper is reaped, then re-run lost jobs.
        for ri in 0..self.runners.len() {
            let mut i = 0;
            while i < self.runners[ri].slots.len() {
                let done = match self.runners[ri].slots[i].handle.done.try_recv() {
                    Ok(st) => st,
                    Err(TryRecvError::Closed) => Stopped::Error("the VM driver went away".into()),
                    Err(TryRecvError::Empty) => {
                        i += 1;
                        continue;
                    }
                };
                let slot = self.runners[ri].slots.remove(i);
                self.finish(ri, slot, done, now).await;
            }
        }
        self.retire();
        self.retry_reruns(now).await;
    }

    /// Removes a registration; a failure is retried every `RERUN_EVERY` (a gone one is `Ok`).
    async fn remove(&mut self, record: RunnerRecord, runner_id: u64, name: String, now: f64) {
        let q = Removal { record, runner_id, name, next_at: 0.0, backoff: RERUN_EVERY.as_secs_f64(), held: false };
        self.try_removal(q, now).await;
    }

    /// One try; a failure is queued again: held on `Auth` (shown as the runner's
    /// error) until `reset`, else after `backoff`, which doubles up to `REMOVE_BACKOFF_MAX`.
    async fn try_removal(&mut self, mut q: Removal, now: f64) {
        let Err(e) = call(self.provider.remove(&q.record, q.runner_id)).await else { return };
        eprintln!("runner {}: cannot remove runner {} ({}): {e}", q.record.config.id, q.runner_id, q.name);
        if let ProviderError::Auth(_) = &e {
            q.held = true;
            if let Some(r) = self.runners.iter_mut().find(|r| r.record.config.id == q.record.config.id) {
                r.note(e);
            }
        } else {
            q.next_at = now + q.backoff;
            q.backoff = (q.backoff * 2.0).min(REMOVE_BACKOFF_MAX.as_secs_f64());
        }
        self.removals.push(q);
    }

    async fn retry_removals(&mut self, now: f64) {
        for q in std::mem::take(&mut self.removals) {
            if q.held || now < q.next_at {
                self.removals.push(q);
            } else {
                self.try_removal(q, now).await;
            }
        }
    }

    /// Mint, seed, clone, start. A failure removes whatever it made, the
    /// registration included, and counts toward `MAX_START_FAILURES`.
    async fn start_vm(&mut self, ri: usize, image: &Path, (cpus, memory_mb): (u8, u32), now: f64) {
        let Ok(vm) = &self.vm else { return };
        self.serial += 1;
        let name = format!("{}{}-{}", self.prefix(), now as u64, self.serial);
        let dir = self.vms_dir().join(&name);
        let record = self.runners[ri].record.clone();
        let minted = match call(self.provider.mint(&record, &name)).await {
            Ok(m) => m,
            Err(ProviderError::Auth(e)) => {
                self.runners[ri].error = Some(e);
                return;
            }
            // A GitHub blip is not the Mac's fault: back off, without counting it or auditing it.
            Err(ProviderError::Other(e)) => {
                eprintln!("runner {}: cannot register a runner: {e}", record.config.id);
                self.runners[ri].mint_after = Some(now + QUEUE_POLL.as_secs_f64());
                return;
            }
        };
        let (seed, bundle) = (dir.join("seed.iso"), dir.join("bundle"));
        let made = async {
            std::fs::create_dir_all(self.vms_dir()).map_err(|e| format!("cannot make the VMs folder: {e}"))?;
            // 0700: the seed carries a credential until the runner registers.
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
            vm.write_seed(&seed, minted.seed_file, &minted.jit_config).await?;
            vm.clone_bundle(image, &bundle).await?;
            vm.start(RunSpec { bundle: bundle.clone(), cpus, memory_mb, seed: seed.clone() }).await
        }
        .await;
        match made {
            Ok(handle) => {
                let r = &mut self.runners[ri];
                r.start_failures = 0;
                r.slots.push(Slot {
                    name,
                    runner_id: minted.runner_id,
                    handle,
                    memory_mb,
                    state: SlotState::Starting,
                    since: now,
                    started_at: now,
                    polled_at: now,
                    online: false,
                    busy_since: None,
                    idle_since: None,
                    job: None,
                    drain_ends_at: None,
                    stop: None,
                });
            }
            Err(e) => {
                if let Err(err) = tokio::fs::remove_dir_all(&dir).await
                    && err.kind() != std::io::ErrorKind::NotFound
                {
                    eprintln!("runner: cannot remove {}: {err}", dir.display());
                }
                self.remove(record, minted.runner_id, name, now).await;
                self.start_failed(ri, e, now);
            }
        }
    }

    fn start_failed(&mut self, ri: usize, e: String, now: f64) {
        eprintln!("runner {}: a job VM did not start: {e}", self.runners[ri].record.config.id);
        let r = &mut self.runners[ri];
        r.start_failures += 1;
        if r.start_failures >= MAX_START_FAILURES {
            r.error = Some(format!("The job VM failed to start {MAX_START_FAILURES} times in a row: {e}"));
        }
        let line = AuditLine {
            ts: now as u64,
            runner_id: r.record.config.id.clone(),
            repo: None,
            workflow: None,
            job: None,
            result: AuditResult::FailedToStart,
            seconds: 0,
            reason: vec![e],
        };
        self.audit(&line);
    }

    fn audit(&mut self, line: &AuditLine) {
        if let Err(e) = audit::append(&self.runners_dir, line) {
            eprintln!("runner: cannot write the audit log: {e}");
        }
        if let Some(r) = self.runners.iter_mut().find(|r| r.record.config.id == line.runner_id) {
            r.recent.push_front(line.clone());
            r.recent.truncate(RECENT);
        }
        if line.ts >= self.day_start {
            self.today.entry(line.runner_id.clone()).or_default().add(line);
        }
    }

    /// A VM whose helper is reaped: delete its clone and seed, remove its
    /// registration, audit the job, and queue a re-run if it was cut short.
    async fn finish(&mut self, ri: usize, mut slot: Slot, stopped: Stopped, now: f64) {
        let record = self.runners[ri].record.clone();
        // An online VM we stopped may have taken a job since its last status poll.
        if slot.stop.is_some() && slot.busy_since.is_none() {
            match call(self.provider.job(&record, slot.runner_id, &slot.name)).await {
                Ok(Some(job)) => {
                    slot.job = Some(job);
                    slot.busy_since = Some(slot.polled_at);
                }
                Ok(None) => {}
                Err(e) => self.runners[ri].note(e),
            }
        }
        let dir = self.vms_dir().join(&slot.name);
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("runner: cannot remove {}: {e}", dir.display());
        }
        self.remove(record.clone(), slot.runner_id, slot.name.clone(), now).await;
        // A guest that shut down on its own ran its one job, even if no poll saw it busy.
        let ran = slot.busy_since.is_some() || (stopped == Stopped::Guest && slot.stop.is_none());
        if !ran {
            return;
        }
        let (result, reason, rerun) = match (&slot.stop, &stopped) {
            (Some(s), _) if s.lost => (AuditResult::Lost, s.reasons.clone(), s.rerun),
            (Some(s), _) => (AuditResult::Stopped, s.reasons.clone(), s.rerun),
            (None, Stopped::Guest) => (AuditResult::Finished, vec![], false),
            (None, Stopped::Signal) => (AuditResult::Lost, vec!["signal".into()], true),
            (None, Stopped::Error(e)) => (AuditResult::Lost, vec![e.clone()], true),
        };
        let job = slot.job.as_ref();
        let line = AuditLine {
            ts: now as u64,
            runner_id: record.config.id.clone(),
            repo: job.map(|j| j.repo.clone()),
            workflow: job.map(|j| j.workflow.clone()),
            job: job.map(|j| j.job.clone()),
            result,
            seconds: (now - slot.busy_since.unwrap_or(slot.started_at)).max(0.0) as u64,
            reason,
        };
        self.audit(&line);
        if let Some(job) = slot.job
            && rerun
            && record.config.settings.rerun_lost_jobs
            && self.rerun_seen.insert((job.repo.clone(), job.job_id))
        {
            let next_at = now + RERUN_EVERY.as_secs_f64();
            self.reruns.push(Rerun { record, job, first_at: now, next_at });
        }
    }

    /// GitHub accepts a re-run only once the run has finished, so each queued
    /// job is tried every `RERUN_EVERY` until it works or `RERUN_FOR` passes.
    async fn retry_reruns(&mut self, now: f64) {
        let mut keep = Vec::new();
        for mut q in std::mem::take(&mut self.reruns) {
            if now < q.next_at {
                keep.push(q);
                continue;
            }
            match call(self.provider.rerun(&q.record, &q.job)).await {
                Ok(()) => continue,
                Err(e) => {
                    eprintln!("runner {}: cannot re-run {} job {}: {e}", q.record.config.id, q.job.repo, q.job.job_id)
                }
            }
            q.next_at = now + RERUN_EVERY.as_secs_f64();
            if q.next_at - q.first_at <= RERUN_FOR.as_secs_f64() {
                keep.push(q);
            }
        }
        self.reruns = keep;
    }
}

#[cfg(test)]
#[path = "supervisor_tests.rs"]
mod tests;
