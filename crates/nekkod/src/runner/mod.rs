//! CI runner VMs: the userspace NAT that is a job VM's only network, the
//! host networks it keeps the guest away from, the physical interface it
//! sends from, and [`Runners`], which wires the supervisor, the Mac's
//! readings, the `nekko-vm` helper, GitHub and GitLab into the daemon (`runner:*`).

pub mod audit;
pub mod awake;
pub mod egress;
pub mod github;
pub mod gitlab;
pub mod hostnets;
pub mod keychain;
pub mod lan;
pub mod net;
pub mod provider;
pub mod signals;
pub mod store;
pub mod supervisor;
#[cfg(test)]
pub mod test_http;
pub mod updates;
pub mod vm;

use github::{ConnectRequest, GitHub, SecKeySigner};
use gitlab::{GitLab, GitlabConnectRequest};
use keychain::{key_name, runner_vault, token_key};
use nekko_cloud::vault::Vault;
use nekko_connectors::Net;
use nekko_runner::{HostNets, RunnerSettings};
use provider::{ByLink, Provider};
use serde_json::{Value, json};
use signals::HostSense;
use signals::Sense;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use store::{Link, RunnerRecord, Store, same_scope, same_target};
use supervisor::{RunnerState, RunnerView, Supervisor, TICK};
use vm::HelperVm;
use vm::Vm;

pub const CHANNELS: &[&str] = &["runner:list", "runner:connect", "runner:update", "runner:remove", "runner:setEnabled"];
/// Pushed with `RunnerView[]` whenever the views change.
pub const EVENT: &str = "runner:changed";
const NO_RUNNER: &str = "No runner with that id.";
/// How often the router is asked for its public address, and how often the gateway is checked for a change.
const WAN_EVERY: Duration = Duration::from_secs(300);
const GATEWAY_EVERY: Duration = Duration::from_secs(30);

/// What connects new runners.
pub struct Connectors {
    pub github: GitHub<Net>,
    pub gitlab: GitLab<Net>,
}

/// The vault item a record's credential lives in: its GitHub App's key, shared
/// by every record of that app, or its own GitLab token.
fn secret_key(r: &RunnerRecord) -> String {
    match &r.link {
        Link::Github(g) => key_name(g.app_id),
        Link::Gitlab(_) => token_key(&r.config.id),
    }
}

pub struct Runners<S: Sense = HostSense, V: Vm = HelperVm, P: Provider = ByLink<GitHub<Net>, GitLab<Net>>> {
    store: Store,
    /// Connects new runners; `None` in tests.
    connectors: Option<Connectors>,
    /// The supervisor's runner name prefix, for the connect probe.
    prefix: String,
    vault: Arc<dyn Vault>,
    sup: tokio::sync::Mutex<Supervisor<S, V, P>>,
    /// Serializes load-change-save of `runners.json`.
    edit: tokio::sync::Mutex<()>,
    hub: crate::hub::Hub,
    wake: tokio::sync::Notify,
    /// True once the tick loop runs (VM support is there).
    looping: AtomicBool,
    pending: std::sync::Mutex<Option<Pending>>,
    /// The views last published; `runner:list` answers from here.
    views: std::sync::Mutex<Vec<RunnerView>>,
    /// Vault items a connect is storing, with how many connects are in flight.
    connecting: std::sync::Mutex<HashMap<String, u32>>,
    running_vm_mb: Arc<AtomicU64>,
    /// Why no VM can run here, shown on every enabled runner.
    vm_error: Option<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The `nekko-vm` helper beside the executable, or the sentence the UI shows.
fn helper() -> Result<PathBuf, String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err("VM support unavailable: CI runners need a Mac with Apple silicon.".into());
    }
    std::env::current_exe()
        .ok()
        .and_then(|e| Some(e.parent()?.join("nekko-vm")))
        .filter(|h| h.is_file())
        .ok_or_else(|| "VM support unavailable: the nekko-vm helper is not installed.".into())
}

/// Reads the host's networks (retrying every 5 s until the first read works),
/// keeps them fresh, and adds the router's public address, asked again every
/// `WAN_EVERY` and whenever the default gateway changes.
fn spawn_host_nets(host: Arc<RwLock<HostNets>>, ok: Arc<AtomicBool>) {
    tokio::spawn(async move {
        loop {
            match hostnets::try_current() {
                Ok(n) => {
                    if let Ok(mut h) = host.write() {
                        *h = n;
                    }
                    ok.store(true, Ordering::SeqCst);
                    break;
                }
                Err(e) => eprintln!("runner: cannot read this Mac's networks: {e}"),
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        let extra = Arc::new(RwLock::new(Vec::new()));
        hostnets::spawn_refresh(host, Duration::from_secs(5), extra.clone());
        let mut asked: Option<(std::net::Ipv4Addr, tokio::time::Instant)> = None;
        loop {
            let route = signals::output("/sbin/route", &["-n", "get", "default"], Duration::from_secs(5)).await;
            if let Some(gw) = route.as_deref().and_then(lan::default_gateway)
                && asked.is_none_or(|(g, at)| g != gw || at.elapsed() >= WAN_EVERY)
            {
                let wan = lan::discover_wan(gw).await;
                if let Ok(mut e) = extra.write() {
                    *e = wan;
                }
                asked = Some((gw, tokio::time::Instant::now()));
            }
            tokio::time::sleep(GATEWAY_EVERY).await;
        }
    });
}

impl Runners {
    /// Call inside the runtime. Without VM support every runner shows why
    /// and nothing starts (no loop, no helper streams).
    pub fn start(
        data_dir: PathBuf,
        machine: Arc<nekko_machine::Machine>,
        settings: Box<dyn Fn() -> Value + Send + Sync>,
        hub: crate::hub::Hub,
        github_api: Option<String>,
    ) -> Arc<Runners> {
        #[cfg(unix)]
        raise_nofile();
        let dir = data_dir.join("runners");
        let helper = helper();
        let host = Arc::new(RwLock::new(HostNets::default()));
        let host_ok = Arc::new(AtomicBool::new(false));
        let running_vm_mb = Arc::new(AtomicU64::new(0));
        let egress = match &helper {
            Ok(h) => {
                spawn_host_nets(host.clone(), host_ok.clone());
                egress::spawn_watch(h)
            }
            Err(_) => Arc::new(RwLock::new(None)),
        };
        let vm = helper.clone().map(|h| HelperVm::new(h, host, egress.clone()));
        let sense = HostSense::new(
            machine,
            dir.clone(),
            settings,
            helper.as_ref().ok().cloned(),
            egress,
            host_ok,
            running_vm_mb.clone(),
        );
        let github = GitHub::new(
            Net::default(),
            github_api.unwrap_or_else(|| "https://api.github.com".into()),
            runner_vault(&data_dir),
            Box::new(SecKeySigner),
            now_secs,
        );
        let host_name = gethostname::gethostname().to_string_lossy().into_owned();
        let vault = github.vault();
        let gitlab = || GitLab::new(Net::default(), vault.clone(), now_secs);
        let provider = ByLink { github: github.clone(), gitlab: gitlab() };
        let sup = Supervisor::new(dir.clone(), sense, vm, provider, Box::new(awake::Caffeinate::default()), host_name);
        let connectors = Connectors { github, gitlab: gitlab() };
        let me = Runners::new(&dir, sup, Some(connectors), vault, hub, helper.as_ref().err().cloned(), running_vm_mb);
        if helper.is_ok() {
            me.spawn_loop();
        }
        me
    }
}

/// Records saved by a channel call, waiting for the loop's next tick.
struct Pending {
    records: Vec<RunnerRecord>,
    /// Reconnected runners whose sticky error clears.
    reset: Vec<String>,
}

impl<S: Sense, V: Vm, P: Provider> Runners<S, V, P> {
    pub fn new(
        runners_dir: &Path,
        mut sup: Supervisor<S, V, P>,
        connectors: Option<Connectors>,
        vault: Arc<dyn Vault>,
        hub: crate::hub::Hub,
        vm_error: Option<String>,
        running_vm_mb: Arc<AtomicU64>,
    ) -> Arc<Self> {
        let store = Store::new(runners_dir);
        sup.set_records(store.load());
        let views = sup.views();
        Arc::new(Runners {
            store,
            connectors,
            prefix: sup.prefix(),
            vault,
            sup: tokio::sync::Mutex::new(sup),
            looping: AtomicBool::new(false),
            pending: std::sync::Mutex::new(None),
            views: std::sync::Mutex::new(views),
            connecting: std::sync::Mutex::new(HashMap::new()),
            edit: tokio::sync::Mutex::new(()),
            hub,
            wake: tokio::sync::Notify::new(),
            running_vm_mb,
            vm_error,
        })
    }

    /// Ticks every `TICK`, and at once after a channel call. Only the loop
    /// holds the supervisor while it runs; channels never wait for a tick.
    pub fn spawn_loop(self: &Arc<Self>) {
        self.looping.store(true, Ordering::SeqCst);
        let r = self.clone();
        tokio::spawn(async move {
            r.sup.lock().await.start().await;
            // Vault items of removed runners waiting for a readable `runners.json`.
            let mut forget: Vec<String> = Vec::new();
            loop {
                let (views, gone) = {
                    let mut s = r.sup.lock().await;
                    let gone = r.step(&mut s, true).await;
                    r.running_vm_mb.store(s.running_vm_mb(), Ordering::SeqCst);
                    (s.views(), gone)
                };
                forget.extend(gone.iter().map(secret_key));
                if !forget.is_empty() {
                    let _g = r.edit.lock().await;
                    let saved = r.store.load();
                    // An unreadable file loads as no runners at all: forgetting now could delete a key in use.
                    if !r.store.is_unreadable() {
                        r.forget_keys(&saved, std::mem::take(&mut forget).into_iter());
                    }
                }
                // A change saved during the tick keeps its optimistic view until the next one.
                if r.pending.lock().is_ok_and(|p| p.is_none()) {
                    r.publish(views);
                }
                tokio::select! {
                    () = tokio::time::sleep(TICK) => {}
                    () = r.wake.notified() => {}
                }
            }
        });
    }

    /// Applies saved records and ticks if asked; returns removed runners whose
    /// VMs are all cleaned, so their keys can be forgotten.
    async fn step(&self, s: &mut Supervisor<S, V, P>, tick: bool) -> Vec<RunnerRecord> {
        if let Some(p) = self.pending.lock().ok().and_then(|mut p| p.take()) {
            s.set_records(p.records);
            for id in p.reset {
                s.reset(&id);
            }
        }
        if tick {
            s.tick().await;
        }
        s.take_gone().await
    }

    /// Marks a connect storing vault item `key` in progress until the guard drops.
    fn connect_guard(&self, key: String) -> ConnectGuard<'_> {
        if let Ok(mut c) = self.connecting.lock() {
            *c.entry(key.clone()).or_default() += 1;
        }
        ConnectGuard { set: &self.connecting, key }
    }

    /// Deletes each vault item no saved record uses and no connect is adding. Call under `edit`.
    fn forget_keys(&self, saved: &[RunnerRecord], keys: impl Iterator<Item = String>) {
        let connecting = self.connecting.lock().map(|c| c.clone()).unwrap_or_default();
        for key in keys {
            if !connecting.contains_key(&key) && !saved.iter().any(|r| secret_key(r) == key) {
                self.vault.delete(&key);
            }
        }
    }

    /// Audits what removed runners leave behind; waits a few seconds at most for a running tick.
    pub async fn shutdown(&self) {
        match tokio::time::timeout(Duration::from_secs(5), self.sup.lock()).await {
            Ok(mut s) => s.shutdown(),
            Err(_) => eprintln!("runner: a tick is still running; removals left behind are not audited"),
        }
    }

    fn publish(&self, views: Vec<RunnerView>) {
        let Ok(mut last) = self.views.lock() else { return };
        if *last != views {
            self.hub.publish(EVENT, json!(views), false);
            *last = views;
        }
    }

    /// What `records` will look like once the supervisor has them: the last
    /// view of each with its new settings, so the UI shows a change at once.
    fn optimistic(&self, records: &[RunnerRecord], reset: &[String]) -> Vec<RunnerView> {
        let old = self.views.lock().map(|v| v.clone()).unwrap_or_default();
        records
            .iter()
            .map(|r| {
                let mut v = old.iter().find(|v| v.config.id == r.config.id).cloned().unwrap_or_else(|| RunnerView {
                    config: r.config.clone(),
                    state: RunnerState::Waiting,
                    slots: Vec::new(),
                    reasons: Vec::new(),
                    available: 0,
                    limit: None,
                    awake: false,
                    error: None,
                    today: Default::default(),
                    host: Default::default(),
                    recent: Vec::new(),
                });
                v.config = r.config.clone();
                if reset.contains(&r.config.id) {
                    v.error = None;
                }
                v.state = if !r.config.settings.enabled {
                    RunnerState::Off
                } else if let Some(e) = &self.vm_error {
                    v.error = Some(e.clone());
                    RunnerState::Error
                } else if matches!(v.state, RunnerState::Off) || (v.state == RunnerState::Error && v.error.is_none()) {
                    RunnerState::Waiting
                } else {
                    v.state
                };
                v
            })
            .collect()
    }

    /// Saves `records` and hands them to the supervisor without waiting for it;
    /// returns the view of `id`. Call under `edit`.
    async fn commit(&self, records: Vec<RunnerRecord>, id: Option<&str>) -> Result<Value, String> {
        self.store.save(&records).map_err(|e| format!("Could not save the runners: {e}"))?;
        let mut reset = Vec::new();
        if let Ok(mut p) = self.pending.lock() {
            reset = p.take().map(|p| p.reset).unwrap_or_default();
            reset.extend(id.map(str::to_owned));
            *p = Some(Pending { records: records.clone(), reset: reset.clone() });
        }
        let views = if self.looping.load(Ordering::SeqCst) {
            self.wake.notify_one();
            self.optimistic(&records, &reset)
        } else {
            // No loop (no VM support): nothing else holds the supervisor.
            let mut s = self.sup.lock().await;
            let gone = self.step(&mut s, false).await;
            self.forget_keys(&records, gone.iter().map(secret_key));
            s.views()
        };
        let view = id.map_or(Value::Null, |id| json!(views.iter().find(|v| v.config.id == id)));
        self.publish(views);
        Ok(view)
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let id = arg(0).as_str().unwrap_or_default().to_string();
        if channel == "runner:list" {
            return Ok(json!(*self.views.lock().map_err(|_| "The runner views are unavailable.")?));
        }
        if channel == "runner:connect" {
            return self.connect(arg(0)).await;
        }
        let _g = self.edit.lock().await;
        let mut records = self.store.load();
        let i = records.iter().position(|r| r.config.id == id).ok_or(NO_RUNNER)?;
        match channel {
            "runner:update" => {
                let Value::Object(patch) = arg(1) else { return Err("The settings must be an object.".into()) };
                let mut cur = serde_json::to_value(&records[i].config.settings).map_err(|e| e.to_string())?;
                if let Some(cur) = cur.as_object_mut() {
                    cur.extend(patch);
                }
                let next: RunnerSettings =
                    serde_json::from_value(cur).map_err(|e| format!("Those settings are not valid: {e}"))?;
                records[i].config.settings = next.sanitized();
                self.commit(records, Some(&id)).await
            }
            "runner:setEnabled" => {
                records[i].config.settings.enabled = arg(1).as_bool().ok_or("Enabled must be true or false.")?;
                self.commit(records, Some(&id)).await
            }
            "runner:remove" => {
                // Its VMs stop on the next tick; its offline registrations and,
                // when no other runner uses the app, its key go once they are cleaned.
                records.remove(i);
                self.commit(records, None).await
            }
            _ => Err(format!("unknown channel {channel}")),
        }
    }

    /// Checks and saves a new runner. The provider's checks hold no lock.
    async fn connect(&self, req: Value) -> Result<Value, String> {
        // Never echo the request: it holds a private key or an access token.
        const INVALID: &str = "That is not a valid connect request.";
        let c = self.connectors.as_ref().ok_or("Connecting is not available here.")?;
        // Held through the save, so a removed record's cleanup never deletes the token being stored.
        let _connecting;
        let (rec, network, previous) = match req["provider"].as_str() {
            Some("github") => {
                let req: ConnectRequest = serde_json::from_value(req).map_err(|_| INVALID)?;
                let _connecting = self.connect_guard(key_name(req.app_id));
                let network = signals::read_network_id().await;
                let rec = c.github.connect(req, network.clone()).await?;
                return self.save_connected(rec, network).await;
            }
            Some("gitlab") => {
                let req: GitlabConnectRequest = serde_json::from_value(req).map_err(|_| INVALID)?;
                let base = nekko_connectors::connectors::gitlab_base(Some(
                    &json!({ "site": req.base_url.clone().unwrap_or_default() }),
                ))?;
                let existing = self.store.load().into_iter().find(|r| {
                    r.gitlab().is_some_and(|g| g.base_url.eq_ignore_ascii_case(&base))
                        && same_scope(&r.config.scope, &req.scope)
                });
                _connecting = existing.as_ref().map(|e| self.connect_guard(token_key(&e.config.id)));
                // Put back if the save fails: the connect overwrites it before the record is saved.
                let previous = existing.as_ref().and_then(|e| self.vault.get(&token_key(&e.config.id)));
                // Read now, not from the VM's copy: a Mac without VM support never fills that.
                let nets = hostnets::try_current().map_err(|e| format!("Cannot read this Mac's networks: {e}"))?;
                let network = signals::read_network_id().await;
                let resolve = async |h: &str| Ok(tokio::net::lookup_host((h, 443)).await?.map(|a| a.ip()).collect());
                let rec =
                    c.gitlab.connect(req, existing.as_ref(), &self.prefix, network.clone(), &nets, resolve).await?;
                (rec, network, previous)
            }
            _ => return Err("Unknown CI provider.".into()),
        };
        self.save_gitlab(rec, network, previous).await
    }

    /// Saves a GitLab record whose token is stored; a failed save leaves the
    /// vault as before the connect: the `previous` token back, or none.
    async fn save_gitlab(
        &self,
        rec: RunnerRecord,
        network: Option<String>,
        previous: Option<String>,
    ) -> Result<Value, String> {
        let key = secret_key(&rec);
        let saved = self.save_connected(rec, network).await;
        if saved.is_err() {
            match previous {
                Some(p) => {
                    if let Err(e) = self.vault.set(&key, &p) {
                        eprintln!("runner: could not put the previous GitLab token back: {e}");
                    }
                }
                None if !self.store.load().iter().any(|r| secret_key(r) == key) && !self.store.is_unreadable() => {
                    self.vault.delete(&key);
                }
                None => {}
            }
        }
        saved
    }

    /// A record the CI service accepted: a target already saved (same service,
    /// GitLab instance and scope) keeps its id and settings.
    async fn save_connected(&self, rec: RunnerRecord, network: Option<String>) -> Result<Value, String> {
        let _g = self.edit.lock().await;
        let mut records = self.store.load();
        let mut replaced = None;
        let id = match records.iter_mut().find(|r| same_target(r, &rec)) {
            Some(old) => {
                // A connect that did not see this record stored its token under its own new id.
                if rec.gitlab().is_some() && old.config.id != rec.config.id {
                    let new = token_key(&rec.config.id);
                    let token = self.vault.get(&new).ok_or("The GitLab access token was not stored.")?;
                    self.vault.set(&token_key(&old.config.id), &token)?;
                    self.vault.delete(&new);
                }
                let before = secret_key(old);
                old.link = rec.link;
                old.config.label = rec.config.label;
                let nets = &mut old.config.settings.trusted_networks;
                if let Some(n) = network.filter(|n| !nets.contains(n)) {
                    nets.push(n);
                }
                old.config.settings = old.config.settings.clone().sanitized();
                replaced = Some(before).filter(|k| *k != secret_key(old));
                old.config.id.clone()
            }
            None => {
                let id = rec.config.id.clone();
                records.push(rec);
                id
            }
        };
        let view = self.commit(records.clone(), Some(&id)).await?;
        // The scope moved to another app: the old app's key goes once nothing uses it.
        self.forget_keys(&records, replaced.into_iter());
        Ok(view)
    }
}

/// The open-file limit nekkod runs with: the soft limit raised to 10240
/// (macOS's per-process ceiling for `setrlimit`), capped by the hard limit,
/// never lowered. Each job's NAT holds a socket per guest flow, and the
/// default soft limit of 256 runs out under a busy build.
pub fn nofile_target(soft: u64, hard: u64) -> u64 {
    soft.max(hard.min(10_240))
}

/// Applies [`nofile_target`] to this process; a failure is logged, not fatal.
#[cfg(unix)]
pub fn raise_nofile() {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: getrlimit and setrlimit with a valid rlimit struct.
    let rc = unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            -1
        } else {
            lim.rlim_cur = nofile_target(lim.rlim_cur, lim.rlim_max);
            libc::setrlimit(libc::RLIMIT_NOFILE, &lim)
        }
    };
    if rc != 0 {
        eprintln!("nekkod: cannot raise the open-file limit: {}", std::io::Error::last_os_error());
    }
}

struct ConnectGuard<'a> {
    set: &'a std::sync::Mutex<HashMap<String, u32>>,
    key: String,
}

impl Drop for ConnectGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut c) = self.set.lock()
            && let Some(n) = c.get_mut(&self.key)
        {
            *n -= 1;
            if *n == 0 {
                c.remove(&self.key);
            }
        }
    }
}
