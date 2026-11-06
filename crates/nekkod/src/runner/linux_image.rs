//! The Linux image builder (decision 0053): Ubuntu 24.04's arm64 cloud image, provisioned once
//! by cloud-init with `scripts/runner-image/linux`, becomes `runners/images/linux`. Linux needs no
//! Xcode, no SSH and no first-boot admin, so this is far smaller than the macOS builder: download
//! and check three files, assemble a bundle `nekko-vm` boots directly, boot it once with a CIDATA
//! seed (the guest provisions itself and powers off), test-boot a clone, swap it in. It works in
//! `images/linux.new` and leaves a working image alone until the new one passed its test boot.

use super::Runners;
use super::vm::{HelperVm, RunSpec, Stopped, Vm, output_within};
use nekko_engine::download::{Downloads, HttpFetch, Request};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task::JoinHandle;
use tokio::time::timeout;

pub const CHANNELS: &[&str] = &["runner:linuxImageStatus", "runner:linuxImageBuild", "runner:linuxImageCancel"];
/// Pushed with [`LinuxImageView`] whenever it changes.
pub const EVENT: &str = "runner:linuxImageChanged";

/// Canonical's current Ubuntu 24.04 cloud images, over HTTPS, checked against the SHA256SUMS
/// files published beside them.
// shortcut: the SHA256SUMS files' GPG signatures are not checked, only HTTPS; verify them if Canonical's mirror is ever not the origin.
const BASE: &str = "https://cloud-images.ubuntu.com/noble/current";
const ROOTFS: &str = "noble-server-cloudimg-arm64.tar.gz";
const ROOTFS_IMG: &str = "noble-server-cloudimg-arm64.img";
const KERNEL: &str = "unpacked/noble-server-cloudimg-arm64-vmlinuz-generic";
const INITRD: &str = "unpacked/noble-server-cloudimg-arm64-initrd-generic";
/// The guest's disk: sparse, so only what it writes costs space. cloud-init grows the filesystem.
const DISK_BYTES: u64 = 64 * 1_000_000_000;
/// Downloads (0.6 GB), the unpacked root (2 GB), a provisioned disk (about 6 GB), with a margin.
pub const NEEDS_GB: f64 = 15.0;
const CPUS: u8 = 4;
const MEMORY_MB: u32 = 4096;
const PROVISION_LIMIT: Duration = Duration::from_secs(40 * 60);
const TEST_LIMIT: Duration = Duration::from_secs(10 * 60);
const DOWNLOAD_STALL_LIMIT: Duration = Duration::from_secs(5 * 60);
const STEP_LIMIT: Duration = Duration::from_secs(10 * 60);
/// What the guest scripts print, read back from the console log.
const PROVISIONED: &str = "NEKKO-PROVISION-OK";
const PROVISION_FAILED: &str = "NEKKO-PROVISION-FAILED";
const TEST_BOOTED: &str = "test seed: the image boots";
/// The test boot's seed file (`nekko-runner-boot.sh` knows it).
const TEST_SEED: &str = "nekko-test";
/// The CIDATA seed: cloud-init's user-data is the provision script itself.
const SEED_FILES: [(&str, &str); 3] = [
    ("user-data", include_str!("../../../../scripts/runner-image/linux/provision.sh")),
    ("nekko-runner-boot.sh", include_str!("../../../../scripts/runner-image/linux/nekko-runner-boot.sh")),
    ("nekko-runner-boot.service", include_str!("../../../../scripts/runner-image/linux/nekko-runner-boot.service")),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Download,
    Assemble,
    Provision,
    Test,
    Finish,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    #[default]
    None,
    Building,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxImageView {
    pub state: State,
    pub stage: Option<Stage>,
    /// 0 to 1 within a download; `None` when a stage has no measure.
    pub progress: Option<f64>,
    pub message: Option<String>,
    /// What the guest wrote at the end of provisioning (versions); `None` without an image.
    pub proof: Option<Value>,
}

/// One `sha256  name` line per file; `*name` is binary mode, the same file.
pub fn sums_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let (hash, file) = l.split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

/// How a provisioning boot ended, from its console log.
pub fn provision_verdict(console: &str) -> Result<(), String> {
    if console.lines().any(|l| l.trim_end().ends_with(PROVISIONED)) {
        return Ok(());
    }
    let last = console
        .lines()
        .rev()
        .find(|l| l.contains("provision:") || l.contains(PROVISION_FAILED))
        .map(|l| l.trim().to_owned());
    Err(match last {
        Some(l) => format!("Setting up the Linux image failed: {l}"),
        None => "Setting up the Linux image failed before it started. Its VM log has the details.".into(),
    })
}

/// A Linux bundle's config.json: `nekko-vm` reads only `os` and `macAddress`.
pub fn bundle_config(mac: [u8; 6]) -> Value {
    let mac = mac.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":");
    json!({ "version": 1, "os": "linux", "arch": "arm64", "macAddress": mac })
}

/// A locally administered unicast MAC.
fn random_mac() -> [u8; 6] {
    let mut b = [0u8; 6];
    let _ = getrandom::fill(&mut b);
    b[0] = (b[0] | 0x02) & 0xfe;
    b
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(format!("{:x}", h.finalize()))
}

fn free_gb(path: &Path) -> Option<f64> {
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: a valid C string and an out-pointer to a zeroed statfs.
    (unsafe { libc::statfs(c.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as f64 * s.f_bsize as f64 / 1e9)
}

async fn run(cmd: &str, args: &[&std::ffi::OsStr], what: &str) -> Result<(), String> {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args);
    let out = output_within(c, STEP_LIMIT, what).await?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

pub struct LinuxImageJob {
    images: PathBuf,
    vm: Result<HelperVm, String>,
    /// Shared with the macOS builder and the supervisor: no job VM starts during a build.
    building: Arc<AtomicBool>,
    view: Mutex<LinuxImageView>,
    task: Mutex<Option<JoinHandle<()>>>,
    publish: Box<dyn Fn(&LinuxImageView) + Send + Sync>,
}

impl LinuxImageJob {
    pub fn new(
        images: PathBuf,
        vm: Result<HelperVm, String>,
        building: Arc<AtomicBool>,
        publish: Box<dyn Fn(&LinuxImageView) + Send + Sync>,
    ) -> Self {
        let job = Self { images, vm, building, view: Mutex::default(), task: Mutex::new(None), publish };
        *job.view.lock().unwrap() = job.at_rest();
        job
    }

    fn image(&self) -> PathBuf {
        self.images.join(super::supervisor::LINUX_IMAGE)
    }

    fn work(&self) -> PathBuf {
        self.images.join(format!("{}.new", super::supervisor::LINUX_IMAGE))
    }

    fn at_rest(&self) -> LinuxImageView {
        let proof = std::fs::read(self.image().join("proof.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let state = if self.image().is_dir() { State::Ready } else { State::None };
        LinuxImageView { state, proof, ..Default::default() }
    }

    pub fn status(&self) -> LinuxImageView {
        self.view.lock().unwrap().clone()
    }

    fn update(&self, f: impl FnOnce(&mut LinuxImageView)) {
        let v = {
            let mut v = self.view.lock().unwrap();
            f(&mut v);
            v.clone()
        };
        (self.publish)(&v);
    }

    fn stage(&self, stage: Stage, message: &str) {
        self.update(|v| {
            v.state = State::Building;
            v.stage = Some(stage);
            v.progress = None;
            v.message = Some(message.into());
        });
    }

    pub fn build(self: &Arc<Self>) -> Result<LinuxImageView, String> {
        self.vm.as_ref().map_err(Clone::clone)?;
        let mut task = self.task.lock().unwrap();
        if task.as_ref().is_some_and(|t| !t.is_finished()) {
            return Err("The Linux image is already being set up.".into());
        }
        if self.building.swap(true, Ordering::SeqCst) {
            return Err("Another image is being set up. Try again when it is done.".into());
        }
        self.stage(Stage::Download, "Downloading Ubuntu 24.04");
        let me = self.clone();
        *task = Some(tokio::spawn(async move {
            let r = me.steps().await;
            me.building.store(false, Ordering::SeqCst);
            match r {
                Ok(()) => {
                    let rest = me.at_rest();
                    me.update(|v| *v = rest);
                }
                Err(e) => me.update(|v| {
                    v.state = State::Failed;
                    v.progress = None;
                    v.message = Some(e);
                }),
            }
        }));
        Ok(self.status())
    }

    pub async fn cancel(&self) -> LinuxImageView {
        let task = self.task.lock().unwrap().take();
        if let Some(t) = task {
            t.abort();
            // Dropping the build's RunHandle kills its VM; the work folder goes next.
            let _ = t.await;
            self.building.store(false, Ordering::SeqCst);
        }
        let _ = tokio::fs::remove_dir_all(self.work()).await;
        let rest = self.at_rest();
        self.update(|v| *v = rest);
        self.status()
    }

    async fn steps(&self) -> Result<(), String> {
        let vm = self.vm.as_ref().map_err(Clone::clone)?;
        std::fs::create_dir_all(&self.images).map_err(|e| format!("Cannot make the images folder: {e}"))?;
        if free_gb(&self.images).is_some_and(|gb| gb < NEEDS_GB) {
            return Err(format!("The Linux image needs {NEEDS_GB:.0} GB free. Free up space and try again."));
        }
        let work = self.work();
        let _ = tokio::fs::remove_dir_all(&work).await;
        let downloads = self.images.join("linux-cache");
        let bundle = work.join("bundle");
        for dir in [&downloads, &bundle] {
            std::fs::create_dir_all(dir).map_err(|e| format!("Cannot make {}: {e}", dir.display()))?;
        }

        // 1. Download and check. Kept in linux-cache, so a rebuild with the same files skips this.
        let sums_for_dir = |dir: &str| format!("{BASE}/{dir}SHA256SUMS");
        let top = self.fetch_text(&sums_for_dir("")).await?;
        let unpacked = self.fetch_text(&sums_for_dir("unpacked/")).await?;
        for (n, (path, sums)) in [(ROOTFS, &top), (KERNEL, &unpacked), (INITRD, &unpacked)].into_iter().enumerate() {
            let name = path.rsplit('/').next().unwrap_or(path);
            let want = sums_for(sums, name).ok_or_else(|| format!("Ubuntu's checksums do not list {name}."))?;
            let file = downloads.join(name);
            if sha256_file(&file).ok().as_deref() == Some(want.as_str()) {
                continue;
            }
            let _ = std::fs::remove_file(&file);
            self.update(|v| v.message = Some(format!("Downloading Ubuntu 24.04 ({} of 3)", n + 1)));
            self.download(&format!("{BASE}/{path}"), &file).await?;
            let got = tokio::task::spawn_blocking({
                let file = file.clone();
                move || sha256_file(&file)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Cannot read {name}: {e}"))?;
            if got != want {
                let _ = std::fs::remove_file(&file);
                return Err(format!("{name} did not match Ubuntu's checksum. Try again."));
            }
        }

        // 2. A bundle nekko-vm boots directly: the kernel uncompressed (Virtualization.framework
        // takes an arm64 Image as is), the initrd, and the root filesystem grown to DISK_BYTES.
        self.stage(Stage::Assemble, "Unpacking Ubuntu");
        let kernel_gz = downloads.join(KERNEL.rsplit('/').next().unwrap_or(KERNEL));
        let vmlinux =
            std::fs::File::create(bundle.join("vmlinux")).map_err(|e| format!("Cannot write the kernel: {e}"))?;
        let mut gunzip = tokio::process::Command::new("gunzip");
        gunzip.arg("-c").arg(&kernel_gz).stdout(vmlinux);
        let st = timeout(STEP_LIMIT, gunzip.status()).await.map_err(|_| "Unpacking the kernel timed out.")?;
        if !st.is_ok_and(|s| s.success()) {
            return Err("Cannot unpack the Linux kernel.".into());
        }
        std::fs::copy(downloads.join(INITRD.rsplit('/').next().unwrap_or(INITRD)), bundle.join("initrd"))
            .map_err(|e| format!("Cannot copy the initrd: {e}"))?;
        run(
            "tar",
            &[
                "-xzf".as_ref(),
                downloads.join(ROOTFS).as_os_str(),
                "-C".as_ref(),
                bundle.as_os_str(),
                ROOTFS_IMG.as_ref(),
            ],
            "Unpacking Ubuntu",
        )
        .await?;
        std::fs::rename(bundle.join(ROOTFS_IMG), bundle.join("disk.img")).map_err(|e| e.to_string())?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(bundle.join("disk.img"))
            .and_then(|f| f.set_len(DISK_BYTES))
            .map_err(|e| format!("Cannot grow the disk: {e}"))?;
        let config = serde_json::to_vec_pretty(&bundle_config(random_mac())).map_err(|e| e.to_string())?;
        std::fs::write(bundle.join("config.json"), config).map_err(|e| format!("Cannot write config.json: {e}"))?;

        // 3. One boot with the CIDATA seed: cloud-init runs provision.sh, which powers off.
        self.stage(Stage::Provision, "Installing the runner and Docker");
        let cidata = work.join("cidata");
        std::fs::create_dir_all(&cidata).map_err(|e| e.to_string())?;
        let instance = format!("instance-id: nekko-{}\nlocal-hostname: nekko-runner\n", now_secs());
        std::fs::write(cidata.join("meta-data"), instance).map_err(|e| e.to_string())?;
        for (name, body) in SEED_FILES {
            std::fs::write(cidata.join(name), body).map_err(|e| e.to_string())?;
        }
        let seed = work.join("cidata.iso");
        let mut os: Vec<&std::ffi::OsStr> =
            ["makehybrid", "-iso", "-joliet", "-default-volume-name", "cidata", "-o"].map(|a| a.as_ref()).to_vec();
        os.extend([seed.as_os_str(), cidata.as_os_str()]);
        run("hdiutil", &os, "Making the setup disk").await?;
        let console = work.join(super::vm::CONSOLE_LOG);
        self.boot(vm, &bundle, &seed, PROVISION_LIMIT, "Setting up the Linux image").await?;
        provision_verdict(&std::fs::read_to_string(&console).unwrap_or_default())?;
        let proof = std::fs::read_to_string(&console)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.find("{\"version\":1,\"os\":\"linux\"").map(|i| &l[i..]))
            .find_map(|l| serde_json::from_str::<Value>(l).ok());

        // 4. A clone boots to the job script and powers off, as every job VM will.
        self.stage(Stage::Test, "Test-booting the image");
        let test = work.join("test");
        std::fs::create_dir_all(&test).map_err(|e| e.to_string())?;
        let test_bundle = test.join("bundle");
        vm.clone_bundle(&bundle, &test_bundle).await?;
        let test_seed = test.join("seed.iso");
        vm.write_seed(&test_seed, TEST_SEED, "test\n").await?;
        self.boot(vm, &test_bundle, &test_seed, TEST_LIMIT, "The test boot").await?;
        let log = std::fs::read_to_string(test.join(super::vm::CONSOLE_LOG)).unwrap_or_default();
        if !log.contains(TEST_BOOTED) {
            return Err("The Linux image did not reach its runner on a test boot. Its VM log has the details.".into());
        }

        // 5. Swap in: the old image (if any) goes only once the new one is in place.
        self.stage(Stage::Finish, "Finishing");
        if let Some(p) = proof {
            let _ = std::fs::write(bundle.join("proof.json"), p.to_string());
        }
        let image = self.image();
        let old = self.images.join(format!("{}.old", super::supervisor::LINUX_IMAGE));
        let _ = tokio::fs::remove_dir_all(&old).await;
        if image.exists() {
            std::fs::rename(&image, &old).map_err(|e| format!("Cannot move the old image aside: {e}"))?;
        }
        std::fs::rename(&bundle, &image).map_err(|e| format!("Cannot swap the image in: {e}"))?;
        let _ = tokio::fs::remove_dir_all(&old).await;
        let _ = tokio::fs::remove_dir_all(&work).await;
        Ok(())
    }

    /// Boots `bundle` with `seed` until the guest powers itself off, within `limit`.
    async fn boot(&self, vm: &HelperVm, bundle: &Path, seed: &Path, limit: Duration, what: &str) -> Result<(), String> {
        let _ = std::fs::remove_file(bundle.with_file_name(super::vm::CONSOLE_LOG));
        let spec = RunSpec { bundle: bundle.into(), cpus: CPUS, memory_mb: MEMORY_MB, seed: seed.into(), stats: None };
        let mut handle = vm.start(spec).await?;
        match timeout(limit, &mut handle.done).await {
            Ok(Ok(Stopped::Guest)) => Ok(()),
            Ok(Ok(other)) => Err(format!("{what} stopped early: {other:?}")),
            Ok(Err(_)) => Err(format!("{what} lost its VM.")),
            Err(_) => {
                handle.kill();
                Err(format!("{what} did not finish within {} minutes.", limit.as_secs() / 60))
            }
        }
    }

    async fn fetch_text(&self, url: &str) -> Result<String, String> {
        let r = reqwest::get(url).await.map_err(|e| format!("Cannot reach Ubuntu's image server: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("Ubuntu's image server answered {} for {url}", r.status()));
        }
        r.text().await.map_err(|e| format!("Cannot read {url}: {e}"))
    }

    async fn download(&self, url: &str, to: &Path) -> Result<(), String> {
        const ID: &str = "runner-linux-image";
        struct Dismiss(Downloads);
        impl Drop for Dismiss {
            fn drop(&mut self) {
                self.0.dismiss(ID);
            }
        }
        let (tx, mut rx) = tokio::sync::watch::channel(Value::Null);
        let queue = Downloads::new(
            Arc::new(HttpFetch(reqwest::Client::new())),
            Arc::new(nekko_js::now_ms_f64),
            move |mut jobs| drop(tx.send_replace(jobs.pop().unwrap_or(Value::Null))),
        );
        let _dismiss = Dismiss(queue.clone());
        queue.start(Request {
            id: ID.into(),
            kind: "runner-image".into(),
            label: "Ubuntu 24.04".into(),
            url: url.into(),
            dest: to.to_string_lossy().into_owned(),
            ..Default::default()
        });
        loop {
            match timeout(DOWNLOAD_STALL_LIMIT, rx.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err("The download stopped.".into()),
                Err(_) => return Err("The download stalled. Try again.".into()),
            }
            let job = rx.borrow_and_update().clone();
            if let (Some(got), Some(all)) = (job["receivedBytes"].as_f64(), job["totalBytes"].as_f64())
                && all > 0.0
            {
                self.update(|v| v.progress = Some(got / all));
            }
            match job["state"].as_str() {
                Some("done") => return Ok(()),
                Some("failed" | "cancelled") => {
                    return Err(job["message"].as_str().unwrap_or("The download failed.").to_owned());
                }
                _ => {}
            }
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Runners {
    pub async fn linux_image_route(&self, channel: &str) -> Result<Value, String> {
        let job = self.linux_image.get().ok_or("Linux images are not available here.")?;
        let view = match channel {
            "runner:linuxImageStatus" => job.status(),
            "runner:linuxImageBuild" => job.build()?,
            "runner:linuxImageCancel" => job.cancel().await,
            _ => return Err(format!("unknown channel {channel}")),
        };
        Ok(json!(view))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_find_the_named_file_only() {
        let sums = "50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e *noble-server-cloudimg-arm64.img\n\
                    8F9178835F6535CBC2E65EB7A8E7F705D4A145DF2FA67D8DA3896B40C1304097 *noble-server-cloudimg-arm64.tar.gz\n\
                    nothex *other.img\n";
        assert_eq!(
            sums_for(sums, ROOTFS).as_deref(),
            Some("8f9178835f6535cbc2e65eb7a8e7f705d4a145df2fa67d8da3896b40c1304097")
        );
        assert_eq!(sums_for(sums, "noble-server-cloudimg-arm64"), None, "no prefix match");
        assert_eq!(sums_for(sums, "other.img"), None, "a malformed hash is no checksum");
        assert_eq!(sums_for("abc  x\n", "x"), None);
    }

    #[test]
    fn the_console_says_how_provisioning_went() {
        assert!(provision_verdict("[  1.0] cloud-init[922]: NEKKO-PROVISION-OK\n").is_ok());
        let e = provision_verdict("cloud-init[9]: provision: packages\ncloud-init[9]: NEKKO-PROVISION-FAILED 100\n")
            .unwrap_err();
        assert!(e.ends_with("NEKKO-PROVISION-FAILED 100"), "{e}");
        assert!(provision_verdict("kernel panic\n").unwrap_err().contains("before it started"));
        // A line that only quotes the marker is not the marker.
        assert!(provision_verdict("echo NEKKO-PROVISION-OK; done\n").is_err());
    }

    #[test]
    fn the_bundle_config_is_a_linux_guest_with_a_local_mac() {
        let c = bundle_config([0x5a, 0x94, 0xef, 0, 0, 1]);
        assert_eq!((c["os"].as_str(), c["macAddress"].as_str()), (Some("linux"), Some("5a:94:ef:00:00:01")));
        for _ in 0..50 {
            let m = random_mac();
            assert_eq!(m[0] & 0x03, 0x02, "locally administered unicast: {m:02x?}");
        }
    }

    /// The whole build on this Mac, against Canonical's servers and a real VM:
    /// `NEKKO_VM_HELPER=<signed nekko-vm> NEKKO_LINUX_IMAGES=<dir> cargo test -p nekkod real_linux_image -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "downloads Ubuntu and boots two VMs"]
    async fn real_linux_image() {
        let helper = PathBuf::from(std::env::var("NEKKO_VM_HELPER").expect("NEKKO_VM_HELPER"));
        let images = PathBuf::from(std::env::var("NEKKO_LINUX_IMAGES").expect("NEKKO_LINUX_IMAGES"));
        let host = Arc::new(std::sync::RwLock::new(super::super::hostnets::try_current().expect("host networks")));
        let egress = super::super::egress::spawn_watch(&helper);
        while egress.read().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let vm = HelperVm::new(helper, host, egress);
        let job = Arc::new(LinuxImageJob::new(
            images.clone(),
            Ok(vm),
            Arc::default(),
            Box::new(|v| eprintln!("{:?} {:?} {:?}", v.stage, v.message, v.progress.map(|p| (p * 100.0).round()))),
        ));
        let started = std::time::Instant::now();
        job.steps().await.expect("the build");
        eprintln!("built in {:?}: {:?}", started.elapsed(), job.at_rest());
        assert_eq!(job.at_rest().state, State::Ready);
        assert!(images.join("linux/vmlinux").is_file() && images.join("linux/proof.json").is_file());
    }

    /// A job VM from the image `real_linux_image` built, with a JIT config GitHub refuses: the guest
    /// must read the seed, start the runner as `runner` over the NAT, sample its usage and power off.
    #[tokio::test]
    #[ignore = "boots a VM from a built Linux image"]
    async fn real_linux_job_boot() {
        let helper = PathBuf::from(std::env::var("NEKKO_VM_HELPER").expect("NEKKO_VM_HELPER"));
        let images = PathBuf::from(std::env::var("NEKKO_LINUX_IMAGES").expect("NEKKO_LINUX_IMAGES"));
        let host = Arc::new(std::sync::RwLock::new(super::super::hostnets::try_current().expect("host networks")));
        let egress = super::super::egress::spawn_watch(&helper);
        while egress.read().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let vm = HelperVm::new(helper, host, egress);
        let dir = images.join("job-check");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bundle = dir.join("bundle");
        vm.clone_bundle(&images.join("linux"), &bundle).await.unwrap();
        let seed = dir.join("seed.iso");
        vm.write_seed(&seed, super::super::vm::GITHUB_SEED, "bm90LWEtcmVhbC1qaXQtY29uZmln\n").await.unwrap();
        let stats = dir.join("stats.img");
        std::fs::write(&stats, nekko_runner::blank_stats_disk()).unwrap();
        let spec = RunSpec { bundle, cpus: 2, memory_mb: 4096, seed, stats: Some(stats.clone()) };
        let started = std::time::Instant::now();
        let mut h = vm.start(spec).await.unwrap();
        let stopped = timeout(Duration::from_secs(300), &mut h.done).await.expect("the guest powers off").unwrap();
        let log = std::fs::read_to_string(dir.join(super::super::vm::CONSOLE_LOG)).unwrap_or_default();
        for l in log.lines().filter(|l| l.contains("nekko-runner-boot") || l.contains("Runner") || l.contains("runner"))
        {
            eprintln!("{l}");
        }
        let disk = std::fs::read(&stats).unwrap();
        let samples = String::from_utf8_lossy(&disk[512..]).trim_end_matches('\0').to_string();
        eprintln!("stopped {stopped:?} after {:?}\nstats: {samples}", started.elapsed());
        assert_eq!(stopped, Stopped::Guest);
        assert!(log.contains("starting the GitHub Actions runner") && log.contains("runner exited with"), "{log}");
    }

    #[test]
    fn the_seed_carries_the_scripts_cloud_init_runs() {
        let (name, user_data) = SEED_FILES[0];
        assert_eq!(name, "user-data");
        assert!(user_data.starts_with("#!/bin/bash"), "cloud-init runs a script user-data as is");
        assert!(user_data.contains(PROVISIONED) && user_data.contains(PROVISION_FAILED));
        assert!(SEED_FILES[1].1.contains(TEST_BOOTED) && SEED_FILES[1].1.contains(TEST_SEED));
        assert!(SEED_FILES[2].1.contains("ExecStart=/usr/local/libexec/nekko-runner-boot.sh"));
    }
}
