use super::*;
use crate::runner::egress::Egress;
use crate::runner::provider::Minted;
use crate::runner::signals::HostState;
use crate::runner::store::GithubLink;
use crate::runner::vm::Halt;
use nekko_cloud::vault::Vault;
use nekko_machine::activity::Power;
use nekko_runner::{KeepAwake, Pressure, Priority, RunnerSettings, Scope, Thermal};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

type Log = Arc<Mutex<Vec<String>>>;

fn quiet() -> MacState {
    MacState {
        wall_secs: 1_700_000_000.0,
        idle_seconds: Some(600.0),
        user_cpu_pct: 5.0,
        power: Some(Power { on_battery: false, percent: Some(100.0), low: false }),
        host: Some(HostState { thermal: Thermal::Nominal, low_power_mode: false, memory: Pressure::Normal }),
        egress: Some(Egress {
            physical: Some(("en0".into(), 4)),
            vpn_carries_default: false,
            expensive: false,
            constrained: false,
        }),
        host_nets_ok: true,
        network_id: Some("gw:1".into()),
        free_disk_gb: 200.0,
        available_memory_mb: 60_000.0,
        ram_mb: 65_536,
        cores: 12,
        user_memory_mb: Some(8000),
        security_update_overdue_days: None,
        paused_all: false,
        updates_read: true,
    }
}

fn record(id: &str, priority: Priority, slots: u8) -> RunnerRecord {
    RunnerRecord {
        config: RunnerConfig {
            id: id.into(),
            scope: Scope::Org { org: "acme".into() },
            label: "nekko-mac".into(),
            settings: RunnerSettings {
                enabled: true,
                priority,
                macos_slots: slots,
                trusted_networks: vec!["gw:1".into()],
                ..Default::default()
            },
        },
        github: GithubLink { app_id: 1, installation_id: 2, group_id: None, repos: vec![], allow_public: false },
        image: None,
    }
}

/// The Mac as scripted, minus the memory of every VM still running: macOS
/// counts our own guests as used memory.
#[derive(Clone)]
struct FakeSense(Arc<Mutex<MacState>>, Arc<Mutex<VmState>>);

impl Sense for FakeSense {
    async fn sample(&self) -> MacState {
        let mut m = self.0.lock().unwrap().clone();
        let vms = self.1.lock().unwrap();
        let used: u32 = vms.done.iter().zip(&vms.mems).filter(|(d, _)| d.is_some()).map(|(_, mb)| *mb).sum();
        m.available_memory_mb -= f64::from(used);
        m
    }
}

#[derive(Default)]
struct VmState {
    root: PathBuf,
    other: u8,
    count_err: bool,
    start_fails: u32,
    /// Halts are logged but `done` waits for `finish`.
    hold_done: bool,
    done: Vec<Option<oneshot::Sender<Stopped>>>,
    /// The next `start` takes this many seconds, of paused time and of the fake wall clock.
    slow_start: Option<(u64, Arc<Mutex<MacState>>)>,
    /// Each run's memory, beside `done`.
    mems: Vec<u32>,
}

#[derive(Clone)]
struct FakeVm(Arc<Mutex<VmState>>, Log);

impl FakeVm {
    fn finish(&self, run: usize, why: Stopped) {
        if let Some(tx) = self.0.lock().unwrap().done[run].take() {
            let _ = tx.send(why);
        }
    }

    fn live(&self) -> usize {
        self.0.lock().unwrap().done.iter().flatten().count()
    }

    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(&self.0.lock().unwrap().root).unwrap_or(p).display().to_string()
    }
}

impl Vm for FakeVm {
    async fn clone_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
        self.1.lock().unwrap().push(format!("clone_bundle {} {}", self.rel(from), self.rel(to)));
        std::fs::create_dir(to).map_err(|e| e.to_string())?;
        std::fs::write(to.join("disk.img"), b"clone").map_err(|e| e.to_string())
    }

    async fn write_seed(&self, path: &Path, jit: &str) -> Result<(), String> {
        self.1.lock().unwrap().push(format!("write_seed {}", self.rel(path)));
        std::fs::write(path, jit).map_err(|e| e.to_string())
    }

    async fn start(&self, spec: RunSpec) -> Result<RunHandle, String> {
        self.1.lock().unwrap().push(format!("start {} {}", spec.cpus, spec.memory_mb));
        let slow = self.0.lock().unwrap().slow_start.take();
        if let Some((secs, mac)) = slow {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            mac.lock().unwrap().wall_secs += secs as f64;
        }
        let run = {
            let mut st = self.0.lock().unwrap();
            if st.start_fails > 0 {
                st.start_fails -= 1;
                return Err("boot failed".into());
            }
            st.done.len()
        };
        let (done_tx, done_rx) = oneshot::channel();
        let (stop_tx, mut stop_rx) = mpsc::unbounded_channel();
        {
            let mut st = self.0.lock().unwrap();
            st.done.push(Some(done_tx));
            st.mems.push(spec.memory_mb);
        }
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(h) = stop_rx.recv().await {
                let what = if h == Halt::Kill { "kill" } else { "request_stop" };
                me.1.lock().unwrap().push(format!("{what} {run}"));
                if !me.0.lock().unwrap().hold_done {
                    me.finish(run, if h == Halt::Kill { Stopped::Error("killed".into()) } else { Stopped::Signal });
                }
            }
        });
        Ok(RunHandle::new(done_rx, stop_tx))
    }

    async fn count_vms(&self) -> Result<u8, String> {
        let st = self.0.lock().unwrap();
        if st.count_err { Err("helper gone".into()) } else { Ok(st.other + st.done.iter().flatten().count() as u8) }
    }
}

struct ProvState {
    status: RunnerStatus,
    queued: u32,
    mint: VecDeque<Result<Minted, ProviderError>>,
    rerun: VecDeque<Result<(), ProviderError>>,
    /// `None`: the runner's job while `status` is `Busy`, else none (as GitHub answers).
    job: Option<Result<Option<JobRef>, ProviderError>>,
    next_id: u64,
}

#[derive(Clone)]
struct FakeProvider(Arc<Mutex<ProvState>>, Log);

fn job_ref() -> JobRef {
    JobRef { repo: "acme/app".into(), run_id: 7, job_id: 70, workflow: "ci".into(), job: "build".into() }
}

impl Provider for FakeProvider {
    async fn mint(&self, _: &RunnerRecord, name: &str) -> Result<Minted, ProviderError> {
        self.1.lock().unwrap().push(format!("mint {name}"));
        let mut st = self.0.lock().unwrap();
        st.next_id += 1;
        let id = st.next_id;
        st.mint.pop_front().unwrap_or(Ok(Minted { runner_id: id, jit_config: "jit".into() }))
    }

    async fn status(&self, _: &RunnerRecord, _: u64) -> Result<RunnerStatus, ProviderError> {
        Ok(self.0.lock().unwrap().status)
    }

    async fn job(&self, _: &RunnerRecord, _: &str) -> Result<Option<JobRef>, ProviderError> {
        self.1.lock().unwrap().push("job".into());
        let st = self.0.lock().unwrap();
        st.job.clone().unwrap_or(Ok((st.status == RunnerStatus::Busy).then(job_ref)))
    }

    async fn queued(&self, _: &RunnerRecord) -> Result<u32, ProviderError> {
        Ok(self.0.lock().unwrap().queued)
    }

    async fn remove(&self, _: &RunnerRecord, runner_id: u64) -> Result<(), ProviderError> {
        self.1.lock().unwrap().push(format!("remove {runner_id}"));
        Ok(())
    }

    async fn remove_stale(&self, _: &RunnerRecord, prefix: &str) -> Result<u32, ProviderError> {
        self.1.lock().unwrap().push(format!("remove_stale {prefix}"));
        Ok(0)
    }

    async fn rerun(&self, _: &RunnerRecord, _: &JobRef) -> Result<(), ProviderError> {
        self.1.lock().unwrap().push("rerun".into());
        self.0.lock().unwrap().rerun.pop_front().unwrap_or(Ok(()))
    }
}

struct FakeAwake(Arc<Mutex<Vec<bool>>>);

impl Awake for FakeAwake {
    fn set(&self, hold: bool) {
        self.0.lock().unwrap().push(hold);
    }
}

struct H {
    dir: tempfile::TempDir,
    sense: FakeSense,
    vm: FakeVm,
    prov: FakeProvider,
    log: Log,
    awake: Arc<Mutex<Vec<bool>>>,
    sup: Supervisor<FakeSense, FakeVm, FakeProvider>,
}

fn harness_with(records: Vec<RunnerRecord>, no_vm: Option<&str>) -> H {
    let dir = tempfile::tempdir().unwrap();
    let image = dir.path().join("images").join("default");
    std::fs::create_dir_all(&image).unwrap();
    std::fs::write(image.join("disk.img"), b"golden").unwrap();
    let log: Log = Arc::default();
    let vm = FakeVm(Arc::new(Mutex::new(VmState { root: dir.path().into(), ..Default::default() })), log.clone());
    let sense = FakeSense(Arc::new(Mutex::new(quiet())), vm.0.clone());
    let prov = FakeProvider(
        Arc::new(Mutex::new(ProvState {
            status: RunnerStatus::Idle,
            queued: 0,
            mint: VecDeque::new(),
            rerun: VecDeque::new(),
            job: None,
            next_id: 99,
        })),
        log.clone(),
    );
    let awake = Arc::new(Mutex::new(Vec::new()));
    let backend = match no_vm {
        Some(why) => Err(why.to_owned()),
        None => Ok(vm.clone()),
    };
    let mut sup = Supervisor::new(
        dir.path().into(),
        sense.clone(),
        backend,
        prov.clone(),
        Box::new(FakeAwake(awake.clone())),
        "Mac1".into(),
    );
    sup.set_records(records);
    H { dir, sense, vm, prov, log, awake, sup }
}

fn harness(records: Vec<RunnerRecord>) -> H {
    harness_with(records, None)
}

impl H {
    /// One tick per 5 s, with the fake wall clock moving along.
    async fn tick_for(&mut self, secs: u64) {
        for _ in 0..secs / 5 {
            self.sense.0.lock().unwrap().wall_secs += 5.0;
            tokio::time::advance(TICK).await;
            self.sup.tick().await;
            // Let the fake VMs see their halts.
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
        }
    }

    fn mac(&self, f: impl FnOnce(&mut MacState)) {
        f(&mut self.sense.0.lock().unwrap());
    }

    fn status(&self, s: RunnerStatus) {
        self.prov.0.lock().unwrap().status = s;
    }

    fn queued(&self, q: u32) {
        self.prov.0.lock().unwrap().queued = q;
    }

    fn count(&self, prefix: &str) -> usize {
        self.log.lock().unwrap().iter().filter(|l| l.starts_with(prefix)).count()
    }

    fn vms(&self) -> Vec<String> {
        std::fs::read_dir(self.dir.path().join("vms"))
            .map(|d| d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    }

    fn audit(&self) -> Vec<AuditLine> {
        std::fs::read_to_string(self.dir.path().join("audit.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn view(&self) -> RunnerView {
        self.sup.views().remove(0)
    }

    /// Ticks until every runner has a running job, then stops handing out more.
    async fn running(&mut self) {
        self.status(RunnerStatus::Busy);
        self.queued(1);
        for _ in 0..40 {
            self.tick_for(5).await;
            let views = self.sup.views();
            if views.iter().all(|v| v.slots.iter().any(|s| s.state == SlotState::Running)) {
                self.status(RunnerStatus::Idle);
                self.queued(0);
                return;
            }
        }
        panic!("no job started: {:?}", self.log.lock().unwrap());
    }
}

#[tokio::test(start_paused = true)]
async fn takes_a_job_when_gates_pass_and_deletes_vm_after() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.sup.start().await;
    h.tick_for(5).await;
    let log = h.log.lock().unwrap().clone();
    let name = log[1].strip_prefix("mint ").unwrap().to_owned();
    let id = std::fs::read_to_string(h.dir.path().join("install-id")).unwrap();
    assert!(name.starts_with(&format!("nekko-mac1-{id}-1700000005-")), "{name}");
    assert_eq!(
        log[1..],
        [
            format!("mint {name}"),
            format!("write_seed vms/{name}/seed.iso"),
            format!("clone_bundle images/default vms/{name}/bundle"),
            "start 10 8192".into(),
        ]
    );
    h.status(RunnerStatus::Busy);
    h.tick_for(15).await;
    assert_eq!(h.view().state, RunnerState::Running);
    assert_eq!(h.view().slots[0].job, Some(job_ref()));
    h.status(RunnerStatus::Idle);
    h.vm.finish(0, Stopped::Guest);
    h.tick_for(5).await;
    assert!(!h.vms().contains(&name));
    assert_eq!(h.count("remove 100"), 1);
    let audit = h.audit();
    assert_eq!(audit.len(), 1);
    assert_eq!((audit[0].result, audit[0].repo.as_deref()), (AuditResult::Finished, Some("acme/app")));
    assert_eq!(h.view().today.jobs, 1);
}

#[tokio::test(start_paused = true)]
async fn holds_without_a_vm_when_gates_fail() {
    let mut h = harness(vec![record("r1", Priority::DoNotDisturb, 1)]);
    h.mac(|m| m.idle_seconds = Some(30.0));
    h.queued(1);
    h.tick_for(60).await;
    assert_eq!(h.count("mint"), 0);
    let v = h.view();
    assert_eq!((v.state, v.reasons), (RunnerState::Waiting, vec![Reason::UserActive]));
}

#[tokio::test(start_paused = true)]
async fn dnd_starts_on_demand_only() {
    let mut h = harness(vec![record("r1", Priority::DoNotDisturb, 1)]);
    h.tick_for(60).await;
    assert_eq!(h.count("mint"), 0);
    h.queued(1);
    h.tick_for(120).await;
    assert_eq!(h.count("mint"), 1);
}

#[tokio::test(start_paused = true)]
async fn balanced_keeps_one_warm_vm() {
    let mut h = harness(vec![record("r1", Priority::Balanced, 2)]);
    h.tick_for(120).await;
    assert_eq!(h.count("start"), 1);
    assert_eq!(h.view().slots[0].state, SlotState::Ready);
}

#[tokio::test(start_paused = true)]
async fn drains_then_stops_after_grace() {
    let mut h = harness(vec![record("r1", Priority::DoNotDisturb, 1)]);
    h.running().await;
    h.mac(|m| m.user_cpu_pct = 80.0);
    h.tick_for(115).await;
    assert_eq!(h.count("request_stop"), 0);
    let slot = h.view().slots[0].clone();
    assert_eq!(slot.state, SlotState::Draining);
    let now = h.sense.0.lock().unwrap().wall_secs as u64;
    assert_eq!(slot.drain_ends_at, Some(now + 10));
    assert_eq!(h.view().state, RunnerState::Draining);
    h.tick_for(10).await;
    assert_eq!(h.count("request_stop"), 1);
}

#[tokio::test(start_paused = true)]
async fn drain_is_cancelled_when_gates_pass_again() {
    let mut h = harness(vec![record("r1", Priority::DoNotDisturb, 1)]);
    h.running().await;
    h.mac(|m| m.user_cpu_pct = 80.0);
    h.tick_for(60).await;
    h.mac(|m| m.user_cpu_pct = 5.0);
    h.tick_for(65).await;
    assert_eq!(h.count("request_stop"), 0);
    let slot = h.view().slots[0].clone();
    assert_eq!((slot.state, slot.drain_ends_at), (SlotState::Running, None));
}

#[tokio::test(start_paused = true)]
async fn runner_first_grace_is_capped_by_max_job_time() {
    let mut r = record("r1", Priority::RunnerFirst, 1);
    r.config.settings.max_job_minutes = 10;
    let mut h = harness(vec![r]);
    h.running().await;
    let busy_start = h.sense.0.lock().unwrap().wall_secs as u64;
    h.tick_for(540).await;
    assert_eq!(h.count("request_stop"), 0);
    h.mac(|m| m.power = Some(Power { on_battery: true, percent: Some(40.0), low: false }));
    h.tick_for(55).await;
    assert_eq!(h.count("request_stop"), 0);
    // Runner first's own grace is the whole max job time (600 s); only the cap ends it here.
    assert_eq!(h.view().slots[0].drain_ends_at, Some(busy_start + 600));
    h.tick_for(5).await;
    assert_eq!(h.count("request_stop"), 1);
}

#[tokio::test(start_paused = true)]
async fn max_job_time_stops_the_vm() {
    let mut r = record("r1", Priority::RunnerFirst, 1);
    r.config.settings.max_job_minutes = 10;
    let mut h = harness(vec![r]);
    h.running().await;
    h.tick_for(595).await;
    assert_eq!(h.count("request_stop"), 0);
    h.tick_for(10).await;
    assert_eq!(h.count("request_stop"), 1);
    h.tick_for(300).await;
    let audit = h.audit();
    assert_eq!(audit.len(), 1);
    assert_eq!((audit[0].result, audit[0].reason.clone()), (AuditResult::Stopped, vec!["maxJobTime".to_owned()]));
    assert!((600..610).contains(&audit[0].seconds), "{}", audit[0].seconds);
    assert_eq!(h.count("rerun"), 0);
}

#[tokio::test(start_paused = true)]
async fn hard_limit_stops_immediately() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.running().await;
    h.mac(|m| m.host.as_mut().unwrap().thermal = Thermal::Critical);
    h.tick_for(5).await;
    assert_eq!(h.count("kill"), 1);
    h.tick_for(5).await;
    let audit = h.audit();
    assert_eq!((audit[0].result, audit[0].reason.clone()), (AuditResult::Stopped, vec!["thermalCritical".to_owned()]));
}

#[tokio::test(start_paused = true)]
async fn disk_floor_stops_and_reaps() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.running().await;
    assert_eq!(h.vms().len(), 1);
    h.mac(|m| m.free_disk_gb = 24.0);
    h.tick_for(10).await;
    assert_eq!(h.count("kill"), 1);
    assert!(h.vms().is_empty());
    let golden = h.dir.path().join("images/default");
    assert_eq!(std::fs::read(golden.join("disk.img")).unwrap(), b"golden");
    assert_eq!(std::fs::read_dir(golden).unwrap().count(), 1);
}

#[tokio::test(start_paused = true)]
async fn pause_all_stops_every_runner() {
    let mut h = harness(vec![record("a", Priority::RunnerFirst, 1), record("b", Priority::RunnerFirst, 1)]);
    h.running().await;
    h.mac(|m| m.paused_all = true);
    h.tick_for(5).await;
    assert_eq!(h.count("kill"), 2);
}

#[tokio::test(start_paused = true)]
async fn off_stops_and_deletes_vms() {
    let mut r = record("r1", Priority::RunnerFirst, 1);
    let mut h = harness(vec![r.clone()]);
    h.running().await;
    r.config.settings.enabled = false;
    h.sup.set_records(vec![r]);
    h.tick_for(10).await;
    assert_eq!(h.count("kill"), 1);
    assert!(h.vms().is_empty());
    assert_eq!(h.view().state, RunnerState::Off);
    h.tick_for(60).await;
    assert_eq!(h.count("start"), 1);
}

#[tokio::test(start_paused = true)]
async fn removed_record_is_stopped_and_cleaned() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.running().await;
    h.sup.set_records(vec![]);
    h.tick_for(10).await;
    assert_eq!(h.count("kill"), 1);
    assert_eq!(h.count("remove 100"), 1);
    assert!(h.vms().is_empty());
    assert!(h.sup.views().is_empty());
    assert_eq!(h.sup.running_vm_mb(), 0);
}

#[tokio::test(start_paused = true)]
async fn stale_vms_are_reaped_on_start() {
    let mut h = harness(vec![record("a", Priority::RunnerFirst, 1), record("b", Priority::RunnerFirst, 1)]);
    let old = h.dir.path().join("vms/old");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("disk.img"), b"x").unwrap();
    h.sup.start().await;
    assert!(!old.exists());
    assert_eq!(h.count("clone_bundle"), 0);
    assert_eq!(h.count("remove_stale nekko-mac1-"), 2);
    h.tick_for(5).await;
    assert_eq!(h.count("clone_bundle"), 1);
}

/// A running job, then a 600 s jump of the wall clock in one tick.
async fn sleep_through_a_job(h: &mut H) {
    h.running().await;
    h.sense.0.lock().unwrap().wall_secs += 600.0;
    tokio::time::advance(TICK).await;
    h.sup.tick().await;
}

#[tokio::test(start_paused = true)]
async fn wake_after_sleep_kills_and_reaps() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    sleep_through_a_job(&mut h).await;
    let log = h.log.lock().unwrap().clone();
    let kill = log.iter().position(|l| l.starts_with("kill")).expect("killed");
    assert!(!log[kill..].iter().any(|l| l.starts_with("clone_bundle")));
    assert!(h.vms().is_empty());
    let audit = h.audit();
    assert_eq!((audit[0].result, audit[0].reason.clone()), (AuditResult::Lost, vec!["slept".to_owned()]));
    assert_eq!(h.count("rerun"), 0);
    h.tick_for(60).await;
    assert_eq!(h.count("rerun"), 1);
}

#[tokio::test(start_paused = true)]
async fn lost_job_is_rerun_once() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    let other = || Err(ProviderError::Other("run not finished".into()));
    h.prov.0.lock().unwrap().rerun = VecDeque::from([other(), other(), Ok(())]);
    sleep_through_a_job(&mut h).await;
    h.tick_for(55).await;
    assert_eq!(h.count("rerun"), 0);
    h.tick_for(5).await;
    assert_eq!(h.count("rerun"), 1);
    h.tick_for(60).await;
    assert_eq!(h.count("rerun"), 2);
    h.tick_for(60).await;
    assert_eq!(h.count("rerun"), 3);
    h.tick_for(600).await;
    assert_eq!(h.count("rerun"), 3);
}

#[tokio::test(start_paused = true)]
async fn never_starts_more_vms_than_the_cap() {
    let mut h = harness(vec![record("a", Priority::RunnerFirst, 2), record("b", Priority::RunnerFirst, 2)]);
    h.vm.0.lock().unwrap().other = 1;
    for _ in 0..40 {
        h.tick_for(5).await;
        assert!(h.vm.live() <= 1);
    }
    assert_eq!(h.count("start"), 1);
    assert_eq!(h.view().limit, Some(SlotLimit::OtherApps));
}

#[tokio::test(start_paused = true)]
async fn count_vms_failure_starts_nothing() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 2)]);
    h.vm.0.lock().unwrap().count_err = true;
    h.tick_for(60).await;
    assert_eq!(h.count("mint"), 0);
}

#[tokio::test(start_paused = true)]
async fn unknown_host_state_starts_nothing_and_keeps_running_jobs() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 2)]);
    h.running().await;
    let mints = h.count("mint");
    h.mac(|m| m.host = None);
    h.tick_for(120).await;
    // The job's VM (the first) keeps running; an idle warm one may stop, as it loses nothing.
    assert_eq!(h.count("kill 0"), 0);
    assert_eq!(h.count("mint"), mints);
    assert!(h.view().reasons.contains(&Reason::HostStateUnknown));
    assert!(h.view().slots.iter().any(|s| s.state == SlotState::Running));
}

#[tokio::test(start_paused = true)]
async fn cleanup_kills_before_deleting() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.running().await;
    h.vm.0.lock().unwrap().hold_done = true;
    let name = h.vms().remove(0);
    h.mac(|m| m.host.as_mut().unwrap().memory = Pressure::Critical);
    h.tick_for(15).await;
    assert_eq!(h.count("kill"), 1);
    assert!(h.vms().contains(&name), "deleted while the helper was alive");
    h.vm.finish(0, Stopped::Error("killed".into()));
    h.tick_for(5).await;
    assert!(!h.vms().contains(&name));
}

#[tokio::test(start_paused = true)]
async fn start_failures_stop_retrying_after_three() {
    let mut r = record("r1", Priority::RunnerFirst, 1);
    let mut h = harness(vec![r.clone()]);
    h.vm.0.lock().unwrap().start_fails = 3;
    h.tick_for(60).await;
    assert_eq!(h.count("clone_bundle"), 3);
    assert_eq!(h.view().state, RunnerState::Error);
    assert!(h.view().error.unwrap().contains("boot failed"));
    // Every minted registration was removed, every folder deleted.
    assert_eq!(h.count("remove "), 3);
    assert!(h.vms().is_empty());
    assert_eq!(h.audit().iter().filter(|l| l.result == AuditResult::FailedToStart).count(), 3);
    assert_eq!(h.view().today.jobs, 0);
    r.config.settings.max_job_minutes = 30;
    h.sup.set_records(vec![r]);
    h.tick_for(5).await;
    assert_eq!(h.count("clone_bundle"), 4);
    assert_ne!(h.view().state, RunnerState::Error);
}

#[tokio::test(start_paused = true)]
async fn auth_error_marks_runner_error() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.prov.0.lock().unwrap().mint.push_back(Err(ProviderError::Auth("revoked".into())));
    h.tick_for(30).await;
    let v = h.view();
    assert_eq!((v.state, v.error.as_deref()), (RunnerState::Error, Some("revoked")));
    assert_eq!(h.count("clone_bundle"), 0);
    assert_eq!(h.count("mint"), 1);
}

#[tokio::test(start_paused = true)]
async fn missing_image_is_an_error() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    std::fs::remove_dir_all(h.dir.path().join("images/default")).unwrap();
    h.tick_for(10).await;
    let v = h.view();
    assert_eq!((v.state, v.error.as_deref()), (RunnerState::Error, Some("No VM image yet.")));
    assert_eq!(h.count("mint"), 0);
}

#[tokio::test(start_paused = true)]
async fn no_vm_support_marks_every_runner_error() {
    let why = "CI runners need a Mac with Apple silicon.";
    let mut h =
        harness_with(vec![record("a", Priority::RunnerFirst, 1), record("b", Priority::Balanced, 1)], Some(why));
    h.sup.start().await;
    h.tick_for(10).await;
    let views = h.sup.views();
    assert_eq!(views.len(), 2);
    assert!(views.iter().all(|v| v.state == RunnerState::Error && v.error.as_deref() == Some(why)));
    assert_eq!(h.count("mint"), 0);
}

#[tokio::test(start_paused = true)]
async fn keep_awake_follows_running_jobs() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.tick_for(10).await;
    assert_eq!(h.awake.lock().unwrap().last(), Some(&false));
    h.running().await;
    assert_eq!(h.awake.lock().unwrap().last(), Some(&true));
    assert!(h.view().awake);
    h.vm.finish(0, Stopped::Guest);
    h.tick_for(5).await;
    assert_eq!(h.awake.lock().unwrap().last(), Some(&false));

    let mut r = record("r1", Priority::RunnerFirst, 1);
    r.config.settings.keep_awake = KeepAwake::SystemDefault;
    let mut h = harness(vec![r]);
    h.running().await;
    h.tick_for(30).await;
    assert!(!h.awake.lock().unwrap().contains(&true));
}

#[test]
fn runner_names_use_a_safe_host() {
    assert_eq!(name_host("Philip's MacBook Pro"), "philip-s-macbook-pro");
}

#[tokio::test(start_paused = true)]
async fn views_serialize_camel_case() {
    let mut h = harness(vec![record("r1", Priority::Balanced, 1)]);
    h.tick_for(5).await;
    let v = serde_json::to_value(h.sup.views()).unwrap();
    assert_eq!(v[0]["state"], "ready");
    assert_eq!(v[0]["slots"][0]["state"], "starting");
    assert!(v[0]["slots"][0].get("drainEndsAt").is_some());
    assert_eq!(v[0]["today"], json!({"jobs": 0, "seconds": 0}));
}

#[tokio::test(start_paused = true)]
async fn slow_start_is_not_a_sleep() {
    let mut h = harness(vec![record("r1", Priority::Balanced, 2)]);
    h.running().await;
    h.vm.0.lock().unwrap().slow_start = Some((70, h.sense.0.clone()));
    h.queued(1);
    h.tick_for(60).await;
    assert_eq!(h.count("start"), 2, "{:?}", h.log.lock().unwrap());
    h.tick_for(30).await;
    assert_eq!(h.count("kill"), 0);
    assert!(h.audit().iter().all(|l| l.result != AuditResult::Lost));
    assert_eq!(h.view().slots[0].state, SlotState::Running);
}

#[tokio::test(start_paused = true)]
async fn mint_blips_do_not_stick_in_error() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    let blip = || Err(ProviderError::Other("GitHub said 502".into()));
    h.prov.0.lock().unwrap().mint = VecDeque::from([blip(), blip(), blip()]);
    for _ in 0..40 {
        h.tick_for(5).await;
        assert_ne!(h.view().state, RunnerState::Error);
    }
    assert_eq!(h.count("mint"), 4);
    assert_eq!(h.count("start"), 1);
    assert!(h.audit().is_empty());
}

#[tokio::test(start_paused = true)]
async fn mint_blips_back_off() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.prov.0.lock().unwrap().mint = VecDeque::from([Err(ProviderError::Other("GitHub said 502".into()))]);
    h.tick_for(25).await;
    assert_eq!(h.count("mint"), 1);
    h.tick_for(10).await;
    assert_eq!(h.count("mint"), 2);
}

#[tokio::test(start_paused = true)]
async fn job_taken_between_polls_is_audited_when_stopped() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.tick_for(20).await;
    assert_eq!(h.view().slots[0].state, SlotState::Ready);
    // GitHub hands it a job; the Mac overheats before the next status poll.
    h.prov.0.lock().unwrap().job = Some(Ok(Some(job_ref())));
    h.mac(|m| m.host.as_mut().unwrap().thermal = Thermal::Critical);
    h.tick_for(10).await;
    let audit = h.audit();
    assert_eq!(audit.len(), 1);
    assert_eq!((audit[0].result, audit[0].job.as_deref()), (AuditResult::Stopped, Some("build")));
    h.tick_for(60).await;
    assert_eq!(h.count("rerun"), 1);
}

#[tokio::test(start_paused = true)]
async fn idle_vm_stopped_without_a_job_is_not_audited() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.prov.0.lock().unwrap().job = Some(Ok(None));
    h.tick_for(20).await;
    h.mac(|m| m.host.as_mut().unwrap().thermal = Thermal::Critical);
    h.tick_for(10).await;
    assert!(h.audit().is_empty());
}

#[tokio::test(start_paused = true)]
async fn job_lookup_auth_error_marks_runner_error() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.prov.0.lock().unwrap().job = Some(Err(ProviderError::Auth("revoked".into())));
    h.status(RunnerStatus::Busy);
    h.tick_for(20).await;
    let v = h.view();
    assert_eq!((v.state, v.error.as_deref()), (RunnerState::Error, Some("revoked")));
}

#[tokio::test(start_paused = true)]
async fn missing_image_stays_visible_when_gates_fail() {
    let mut h = harness(vec![record("r1", Priority::DoNotDisturb, 1)]);
    std::fs::remove_dir_all(h.dir.path().join("images/default")).unwrap();
    h.mac(|m| m.idle_seconds = Some(30.0));
    h.tick_for(10).await;
    let v = h.view();
    assert_eq!((v.state, v.error.as_deref()), (RunnerState::Error, Some("No VM image yet.")));
}

#[tokio::test(start_paused = true)]
async fn records_added_later_get_their_stale_runners_swept_once() {
    let mut h = harness(vec![record("a", Priority::DoNotDisturb, 1)]);
    h.sup.start().await;
    assert_eq!(h.count("remove_stale"), 1);
    h.sup.set_records(vec![record("a", Priority::DoNotDisturb, 1), record("b", Priority::DoNotDisturb, 1)]);
    h.tick_for(5).await;
    assert_eq!(h.count("remove_stale"), 2);
    h.sup.set_records(vec![record("a", Priority::DoNotDisturb, 1), record("b", Priority::Balanced, 1)]);
    h.tick_for(30).await;
    assert_eq!(h.count("remove_stale"), 2);
}

#[tokio::test(start_paused = true)]
async fn a_new_record_never_sweeps_a_live_runner_of_the_same_scope() {
    let mut h = harness(vec![record("a", Priority::RunnerFirst, 1)]);
    h.sup.start().await;
    h.running().await;
    h.sup.set_records(vec![record("a", Priority::RunnerFirst, 1), record("b", Priority::DoNotDisturb, 1)]);
    h.tick_for(30).await;
    assert_eq!(h.count("remove_stale"), 1);
    h.vm.finish(0, Stopped::Guest);
    h.mac(|m| m.paused_all = true);
    h.tick_for(10).await;
    assert_eq!(h.count("remove_stale"), 2);
}

#[tokio::test(start_paused = true)]
async fn a_live_runner_is_not_swept_by_a_record_naming_its_scope_in_another_case() {
    let mut h = harness(vec![record("a", Priority::RunnerFirst, 1)]);
    h.sup.start().await;
    h.running().await;
    let mut b = record("b", Priority::DoNotDisturb, 1);
    b.config.scope = Scope::Org { org: "ACME".into() };
    h.sup.set_records(vec![record("a", Priority::RunnerFirst, 1), b]);
    h.tick_for(30).await;
    assert_eq!(h.count("remove_stale"), 1);
}

#[tokio::test(start_paused = true)]
async fn a_disabled_runner_is_off_even_without_vm_support() {
    let mut r = record("a", Priority::RunnerFirst, 1);
    r.config.settings.enabled = false;
    let h = harness_with(vec![r], Some("VM support unavailable."));
    assert_eq!(h.view().state, RunnerState::Off);
}

#[tokio::test(start_paused = true)]
async fn reconnecting_clears_an_auth_error() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.prov.0.lock().unwrap().mint.push_back(Err(ProviderError::Auth("revoked".into())));
    h.tick_for(10).await;
    assert_eq!(h.view().state, RunnerState::Error);
    h.sup.reset("r1");
    assert_eq!(h.view().error, None);
}

#[tokio::test(start_paused = true)]
async fn a_removed_runner_is_handed_back_only_once_its_vms_are_cleaned() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.sup.start().await;
    h.running().await;
    h.vm.0.lock().unwrap().hold_done = true;
    h.sup.set_records(vec![]);
    h.tick_for(10).await;
    assert!(h.sup.take_gone().await.is_empty(), "its VM is still being stopped");
    let swept = h.count("remove_stale");
    h.vm.finish(0, Stopped::Error("killed".into()));
    h.tick_for(5).await;
    let gone = h.sup.take_gone().await;
    assert_eq!(gone.iter().map(|r| r.config.id.as_str()).collect::<Vec<_>>(), ["r1"]);
    assert_eq!(h.count("remove_stale"), swept + 1, "its offline registrations are swept");
    assert!(h.sup.take_gone().await.is_empty());
}

struct Rig {
    runners: Arc<crate::runner::Runners<FakeSense, FakeVm, FakeProvider>>,
    dir: tempfile::TempDir,
    vm: FakeVm,
    log: Log,
    vault: nekko_cloud::vault::FileVault,
}

/// `Runners` over the fakes, its loop running, with `r1` saved and the app key in a file vault.
fn runners_rig(h: H) -> Rig {
    let H { dir, vm, log, sup, .. } = h;
    crate::runner::store::Store::new(dir.path()).save(&[record("r1", Priority::RunnerFirst, 1)]).unwrap();
    let secrets = dir.path().join("secrets.json");
    let vault = nekko_cloud::vault::FileVault::new(secrets.clone());
    vault.set("github-app-1", "pem").unwrap();
    let runners = crate::runner::Runners::new(
        dir.path(),
        sup,
        None,
        Arc::new(nekko_cloud::vault::FileVault::new(secrets)),
        crate::hub::Hub::new(),
        None,
        Arc::default(),
    );
    runners.spawn_loop();
    Rig { runners, dir, vm, log, vault }
}

/// Lets paused time run, a second at a time, until `f` holds.
async fn wait_for(what: &str, f: impl Fn() -> bool) {
    for _ in 0..600 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("never: {what}");
}

#[tokio::test(start_paused = true)]
async fn channels_never_wait_for_a_slow_tick() {
    let h = harness(vec![]);
    h.vm.0.lock().unwrap().slow_start = Some((300, h.sense.0.clone()));
    let Rig { runners, log, dir: _dir, .. } = runners_rig(h);
    // The loop is now inside a tick, booting a VM for 300 s.
    wait_for("a VM start", || log.lock().unwrap().iter().any(|l| l.starts_with("start"))).await;
    let quick = Duration::from_secs(1);
    let list = tokio::time::timeout(quick, runners.route("runner:list", &[])).await.expect("list answers at once");
    assert_eq!(list.unwrap().as_array().map(Vec::len), Some(1));
    let off = tokio::time::timeout(quick, runners.route("runner:setEnabled", &[json!("r1"), json!(false)]))
        .await
        .expect("setEnabled answers at once")
        .unwrap();
    assert_eq!(off["state"], "off");
    let listed = runners.route("runner:list", &[]).await.unwrap();
    assert_eq!(listed[0]["state"], "off", "the change shows before the tick ends");
    // Once the slow start ends, the next tick stops the VM.
    wait_for("the VM stopped", || log.lock().unwrap().iter().any(|l| l.starts_with("kill"))).await;
}

#[tokio::test(start_paused = true)]
async fn removing_keeps_the_key_until_the_runner_is_cleaned() {
    let h = harness(vec![]);
    h.vm.0.lock().unwrap().hold_done = true;
    let Rig { runners, vm, log, vault, dir: _dir } = runners_rig(h);
    wait_for("a VM start", || log.lock().unwrap().iter().any(|l| l.starts_with("start"))).await;
    assert_eq!(runners.route("runner:remove", &[json!("r1")]).await, Ok(Value::Null));
    assert_eq!(runners.route("runner:list", &[]).await, Ok(json!([])));
    wait_for("the VM killed", || log.lock().unwrap().iter().any(|l| l.starts_with("kill"))).await;
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(vault.get("github-app-1").as_deref(), Some("pem"), "kept while its VM may still deregister");
    vm.finish(0, Stopped::Error("killed".into()));
    wait_for("the key forgotten", || vault.get("github-app-1").is_none()).await;
}

#[tokio::test(start_paused = true)]
async fn reconnecting_a_scope_to_another_app_forgets_the_old_key() {
    let Rig { runners, dir, vault, .. } = runners_rig(harness(vec![]));
    let mut moved = record("new-id", Priority::RunnerFirst, 1);
    moved.github.app_id = 2;
    moved.config.scope = Scope::Org { org: "ACME".into() };
    let view = runners.save_connected(moved, None).await.unwrap();
    assert_eq!(view["config"]["id"], "r1", "the scope keeps its id");
    let saved = crate::runner::store::Store::new(dir.path()).load();
    assert_eq!(saved[0].github.app_id, 2);
    assert_eq!(vault.get("github-app-1"), None);
}

/// A 16 GB Mac: room for exactly one 8 GB VM, and the VM's own memory shows as used.
fn small_mac(m: &mut MacState) {
    m.ram_mb = 16_384;
    m.user_memory_mb = None;
    m.available_memory_mb = 12_000.0;
}

#[tokio::test(start_paused = true)]
async fn own_vms_do_not_fail_the_memory_gate() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.mac(small_mac);
    h.tick_for(600).await;
    assert_eq!(h.count("mint"), 1);
    assert_eq!(h.count("kill"), 0);
    assert_eq!(h.view().slots[0].state, SlotState::Ready);
    // A new VM would not fit, and the view says why.
    assert!(h.view().reasons.contains(&Reason::MemoryHeadroom));
}

#[tokio::test(start_paused = true)]
async fn a_host_state_blip_keeps_a_ready_vm() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.tick_for(30).await;
    assert_eq!(h.view().slots[0].state, SlotState::Ready);
    h.mac(|m| m.host = None);
    h.tick_for(5).await;
    h.mac(|m| m.host = quiet().host);
    h.tick_for(30).await;
    assert_eq!((h.count("kill"), h.count("mint")), (0, 1));
}

#[tokio::test(start_paused = true)]
async fn job_taken_before_the_first_poll_is_audited() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.tick_for(5).await;
    assert_eq!(h.view().slots[0].state, SlotState::Starting);
    h.prov.0.lock().unwrap().job = Some(Ok(Some(job_ref())));
    h.mac(|m| m.host.as_mut().unwrap().thermal = Thermal::Critical);
    h.tick_for(10).await;
    let audit = h.audit();
    assert_eq!((audit.len(), audit[0].result), (1, AuditResult::Stopped));
    h.tick_for(60).await;
    assert_eq!(h.count("rerun"), 1);
}

#[tokio::test(start_paused = true)]
async fn runner_names_carry_this_installs_id() {
    let mut h = harness(vec![record("r1", Priority::RunnerFirst, 1)]);
    h.sup.start().await;
    h.tick_for(5).await;
    let id = std::fs::read_to_string(h.dir.path().join("install-id")).expect("an install id");
    assert!(id.len() == 8 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{id}");
    assert_eq!(h.count(&format!("remove_stale nekko-mac1-{id}-")), 1);
    assert_eq!(h.count(&format!("mint nekko-mac1-{id}-1700000005-")), 1);
    // The id is kept across restarts.
    let again = harness_with_dir(h.dir.path());
    drop(again);
    assert_eq!(std::fs::read_to_string(h.dir.path().join("install-id")).unwrap(), id);
}

/// A second supervisor on the same data folder, as after a daemon restart.
fn harness_with_dir(dir: &Path) -> Supervisor<FakeSense, FakeVm, FakeProvider> {
    let h = harness(vec![]);
    Supervisor::new(dir.into(), h.sense, Ok(h.vm), h.prov, Box::new(FakeAwake(h.awake)), "Mac1".into())
}

#[tokio::test(start_paused = true)]
async fn keys_are_kept_while_runners_json_is_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness(vec![]);
    h.vm.0.lock().unwrap().hold_done = true;
    let Rig { runners, vm, log, vault, dir } = runners_rig(h);
    wait_for("a VM start", || log.lock().unwrap().iter().any(|l| l.starts_with("start"))).await;
    assert_eq!(runners.route("runner:remove", &[json!("r1")]).await, Ok(Value::Null));
    wait_for("the VM killed", || log.lock().unwrap().iter().any(|l| l.starts_with("kill"))).await;
    let file = dir.path().join("runners.json");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read(&file).is_ok() {
        return; // running as root: permissions do not apply
    }
    vm.finish(0, Stopped::Error("killed".into()));
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(vault.get("github-app-1").as_deref(), Some("pem"), "kept while the saved records are unknown");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    wait_for("the key forgotten", || vault.get("github-app-1").is_none()).await;
}

#[tokio::test(start_paused = true)]
async fn overlapping_connects_for_one_app_keep_its_key() {
    let Rig { runners, vault, dir: _dir, .. } = runners_rig(harness(vec![]));
    let first = runners.connect_guard(1);
    let second = runners.connect_guard(1);
    drop(first);
    runners.forget_keys(&[], [1].into_iter());
    assert_eq!(vault.get("github-app-1").as_deref(), Some("pem"), "the second connect still needs it");
    drop(second);
    runners.forget_keys(&[], [1].into_iter());
    assert_eq!(vault.get("github-app-1"), None);
}
