//! CI runner VMs: the userspace NAT that is a job VM's only network, the
//! host networks it keeps the guest away from, the physical interface it
//! sends from, and [`Runners`], which wires the supervisor, the Mac's
//! readings, the `nekko-vm` helper and GitHub into the daemon (`runner:*`).

pub mod audit;
pub mod awake;
pub mod egress;
pub mod github;
pub mod hostnets;
pub mod keychain;
pub mod lan;
pub mod net;
pub mod provider;
pub mod signals;
pub mod store;
pub mod supervisor;
pub mod updates;
pub mod vm;

use github::{ConnectRequest, GitHub, SecKeySigner};
use keychain::{key_name, runner_vault};
use nekko_connectors::Net;
use nekko_runner::{HostNets, RunnerSettings};
use provider::Provider;
use serde_json::{Value, json};
use signals::HostSense;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use store::{RunnerRecord, Store, same_scope};
use supervisor::{RunnerView, Supervisor, TICK};
use vm::HelperVm;

pub const CHANNELS: &[&str] = &["runner:list", "runner:connect", "runner:update", "runner:remove", "runner:setEnabled"];
/// Pushed with `RunnerView[]` whenever the views change.
pub const EVENT: &str = "runner:changed";
const NO_RUNNER: &str = "No runner with that id.";
/// How often the router is asked for its public address, and how often the gateway is checked for a change.
const WAN_EVERY: Duration = Duration::from_secs(300);
const GATEWAY_EVERY: Duration = Duration::from_secs(30);

type Sup = Supervisor<HostSense, HelperVm, GitHub<Net>>;

pub struct Runners {
    store: Store,
    github: GitHub<Net>,
    sup: tokio::sync::Mutex<Sup>,
    /// Serializes load-change-save of `runners.json`.
    edit: tokio::sync::Mutex<()>,
    hub: crate::hub::Hub,
    wake: tokio::sync::Notify,
    published: std::sync::Mutex<Value>,
    /// `nekko-<host>-`: every runner name of this Mac.
    prefix: String,
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
        let store = Store::new(&dir);
        let mut sup =
            Supervisor::new(dir, sense, vm, github.clone(), Box::new(awake::Caffeinate::default()), host_name.clone());
        sup.set_records(store.load());
        let me = Arc::new(Runners {
            store,
            github,
            sup: tokio::sync::Mutex::new(sup),
            edit: tokio::sync::Mutex::new(()),
            hub,
            wake: tokio::sync::Notify::new(),
            published: std::sync::Mutex::new(Value::Null),
            prefix: format!("nekko-{}-", supervisor::name_host(&host_name)),
        });
        if helper.is_ok() {
            let r = me.clone();
            tokio::spawn(async move {
                r.sup.lock().await.start().await;
                loop {
                    let views = {
                        let mut s = r.sup.lock().await;
                        s.tick().await;
                        running_vm_mb.store(s.running_vm_mb(), Ordering::SeqCst);
                        s.views()
                    };
                    r.publish(&views);
                    tokio::select! {
                        () = tokio::time::sleep(TICK) => {}
                        () = r.wake.notified() => {}
                    }
                }
            });
        }
        me
    }

    fn publish(&self, views: &[RunnerView]) {
        let v = json!(views);
        let Ok(mut last) = self.published.lock() else { return };
        if *last != v {
            *last = v.clone();
            self.hub.publish(EVENT, v, false);
        }
    }

    /// Saves `records`, hands them to the supervisor, and returns the view of `id`.
    async fn commit(&self, records: Vec<RunnerRecord>, id: Option<&str>) -> Result<Value, String> {
        self.store.save(&records).map_err(|e| format!("Could not save the runners: {e}"))?;
        let views = {
            let mut s = self.sup.lock().await;
            s.set_records(records);
            if let Some(id) = id {
                s.reset(id);
            }
            s.views()
        };
        self.publish(&views);
        self.wake.notify_one();
        Ok(id.map_or(Value::Null, |id| json!(views.iter().find(|v| v.config.id == id))))
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let id = arg(0).as_str().unwrap_or_default().to_string();
        if channel == "runner:list" {
            return Ok(json!(self.sup.lock().await.views()));
        }
        if channel == "runner:connect" {
            let req: ConnectRequest =
                serde_json::from_value(arg(0)).map_err(|e| format!("That is not a connect request: {e}"))?;
            let network = signals::read_network_id().await;
            let _g = self.edit.lock().await;
            let rec = self.github.connect(req, network.clone()).await?;
            let mut records = self.store.load();
            // Reconnecting a scope keeps its id and settings.
            let id = match records.iter_mut().find(|r| same_scope(&r.config.scope, &rec.config.scope)) {
                Some(old) => {
                    old.github = rec.github;
                    old.config.label = rec.config.label;
                    let nets = &mut old.config.settings.trusted_networks;
                    if let Some(n) = network.filter(|n| !nets.contains(n)) {
                        nets.push(n);
                    }
                    old.config.settings = old.config.settings.clone().sanitized();
                    old.config.id.clone()
                }
                None => {
                    let id = rec.config.id.clone();
                    records.push(rec);
                    id
                }
            };
            return self.commit(records, Some(&id)).await;
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
                let gone = records.remove(i);
                self.commit(records.clone(), None).await?;
                // Its VMs stop on the next tick; offline registrations go now.
                let sweep = self.github.remove_stale(&gone, &self.prefix);
                match tokio::time::timeout(Duration::from_secs(15), sweep).await {
                    Ok(Err(e)) => eprintln!("runner {id}: cannot remove stale runners: {e}"),
                    Err(_) => eprintln!("runner {id}: GitHub did not answer while removing stale runners"),
                    Ok(Ok(_)) => {}
                }
                if !records.iter().any(|r| r.github.app_id == gone.github.app_id) {
                    self.github.vault().delete(&key_name(gone.github.app_id));
                }
                Ok(Value::Null)
            }
            _ => Err(format!("unknown channel {channel}")),
        }
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
