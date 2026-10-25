//! `runners.json`: the runner records the owner configured. A hand-edited or
//! damaged file must never stop the daemon: records load sanitized, broken
//! ones are skipped, and a file that is not JSON at all is kept aside.

use nekko_runner::{RunnerConfig, Scope};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The GitHub App installation a runner registers through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubLink {
    pub app_id: u64,
    pub installation_id: u64,
    #[serde(default)]
    pub group_id: Option<u64>,
    #[serde(default)]
    pub repos: Vec<String>,
    #[serde(default)]
    pub allow_public: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerRecord {
    #[serde(flatten)]
    pub config: RunnerConfig,
    pub github: GithubLink,
    /// A golden bundle other than `images/default/`.
    #[serde(default)]
    pub image: Option<PathBuf>,
}

/// GitHub owner, org and repo names match in any case.
pub fn same_scope(a: &Scope, b: &Scope) -> bool {
    match (a, b) {
        (Scope::Org { org: x }, Scope::Org { org: y }) => x.eq_ignore_ascii_case(y),
        (Scope::Repo { owner: o1, repo: r1 }, Scope::Repo { owner: o2, repo: r2 }) => {
            o1.eq_ignore_ascii_case(o2) && r1.eq_ignore_ascii_case(r2)
        }
        _ => false,
    }
}

pub struct Store {
    path: PathBuf,
    /// The last load could not read the file, so saving would overwrite real data.
    unreadable: AtomicBool,
}

impl Store {
    pub fn new(runners_dir: &Path) -> Store {
        Store { path: runners_dir.join("runners.json"), unreadable: AtomicBool::new(false) }
    }

    pub fn load(&self) -> Vec<RunnerRecord> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.unreadable.store(false, Ordering::SeqCst);
                return Vec::new();
            }
            Err(e) => {
                self.unreadable.store(true, Ordering::SeqCst);
                eprintln!("runner store: cannot read {}: {e}", self.path.display());
                return Vec::new();
            }
        };
        self.unreadable.store(false, Ordering::SeqCst);
        let Ok(items) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
            let mut bad = self.path.with_file_name("runners.json.bad");
            if bad.exists() {
                bad = self.path.with_file_name(format!("runners.json.bad.{}", unix_secs()));
            }
            match std::fs::rename(&self.path, &bad) {
                Ok(()) => eprintln!("runner store: not valid JSON, kept as {}", bad.display()),
                Err(e) => eprintln!("runner store: not valid JSON and could not be set aside: {e}"),
            }
            return Vec::new();
        };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let mut skipped = Vec::new();
        for (i, v) in items.into_iter().enumerate() {
            match serde_json::from_value::<RunnerRecord>(v.clone()) {
                Ok(mut r) if seen.insert(r.config.id.clone()) => {
                    r.config.settings = r.config.settings.sanitized();
                    out.push(r);
                }
                Ok(r) => {
                    eprintln!("runner store: record {i} repeats id {}, skipped", r.config.id);
                    skipped.push(v);
                }
                Err(e) => {
                    eprintln!("runner store: record {i} skipped: {e}");
                    skipped.push(v);
                }
            }
        }
        self.keep_aside(skipped);
        out
    }

    /// Append skipped records to `runners.json.bad` (a JSON array) so a later
    /// save does not lose them. Never overwrites something that is not our array.
    fn keep_aside(&self, mut skipped: Vec<serde_json::Value>) {
        if skipped.is_empty() {
            return;
        }
        let mut bad = self.path.with_file_name("runners.json.bad");
        let mut all = Vec::new();
        match std::fs::read(&bad) {
            Ok(b) => match serde_json::from_slice::<Vec<serde_json::Value>>(&b) {
                Ok(old) => all = old,
                Err(_) => bad = self.path.with_file_name(format!("runners.json.bad.{}", unix_secs())),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                eprintln!("runner store: cannot read {}: {e}", bad.display());
                bad = self.path.with_file_name(format!("runners.json.bad.{}", unix_secs()));
            }
        }
        skipped.retain(|v| !all.contains(v));
        if skipped.is_empty() {
            return;
        }
        all.extend(skipped);
        let written = serde_json::to_vec_pretty(&all).map_err(io::Error::from).and_then(|b| std::fs::write(&bad, b));
        if let Err(e) = written {
            eprintln!("runner store: could not keep skipped records in {}: {e}", bad.display());
        }
    }

    /// The last load could not read the file (it exists but is unreadable).
    pub fn is_unreadable(&self) -> bool {
        self.unreadable.load(Ordering::SeqCst)
    }

    /// Write through a temp file and rename, so a crash never leaves half a file.
    pub fn save(&self, records: &[RunnerRecord]) -> io::Result<()> {
        if self.unreadable.load(Ordering::SeqCst) {
            return Err(io::Error::other("runners.json could not be read; not overwriting it"));
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_file_name("runners.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(records)?)?;
        std::fs::rename(&tmp, &self.path)
    }
}

fn unix_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nekko_runner::RunnerSettings;
    use serde_json::json;

    fn record(id: &str) -> RunnerRecord {
        RunnerRecord {
            config: RunnerConfig {
                id: id.into(),
                scope: Scope::Org { org: "acme".into() },
                label: "nekko-mac".into(),
                settings: RunnerSettings { trusted_networks: vec!["gw:aa".into()], ..Default::default() },
            },
            github: GithubLink { app_id: 1, installation_id: 2, group_id: None, repos: vec![], allow_public: false },
            image: None,
        }
    }

    #[test]
    fn store_round_trips_records() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let recs = vec![record("a"), record("b")];
        store.save(&recs).unwrap();
        assert_eq!(store.load(), recs);
        let text = std::fs::read_to_string(dir.path().join("runners.json")).unwrap();
        assert!(text.contains("\"appId\"") && text.contains("\"trustedNetworks\""));
    }

    #[test]
    fn store_loads_sanitized_and_skips_bad_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut wild = serde_json::to_value(record("a")).unwrap();
        wild["settings"]["macosSlots"] = json!(7);
        wild["settings"]["memoryPerVmMb"] = json!(0);
        let mut no_github = serde_json::to_value(record("b")).unwrap();
        no_github.as_object_mut().unwrap().remove("github");
        let dup = serde_json::to_value(record("a")).unwrap();
        std::fs::write(dir.path().join("runners.json"), json!([wild, no_github, dup]).to_string()).unwrap();
        let loaded = Store::new(dir.path()).load();
        assert_eq!(loaded.len(), 1);
        assert_eq!((loaded[0].config.settings.macos_slots, loaded[0].config.settings.memory_per_vm_mb), (2, 8192));
    }

    #[test]
    fn unreadable_store_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("runners.json"), "not json").unwrap();
        assert!(Store::new(dir.path()).load().is_empty());
        assert_eq!(std::fs::read(dir.path().join("runners.json.bad")).unwrap(), b"not json");
        assert!(!dir.path().join("runners.json").exists());
    }

    #[test]
    fn missing_store_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Store::new(dir.path()).load().is_empty());
    }

    #[test]
    fn skipped_records_are_kept_aside_and_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let broken = json!({"id": "x", "oops": true});
        let good = serde_json::to_value(record("a")).unwrap();
        std::fs::write(dir.path().join("runners.json"), json!([good, broken]).to_string()).unwrap();
        let store = Store::new(dir.path());
        let loaded = store.load();
        assert_eq!(loaded.len(), 1);
        store.save(&loaded).unwrap();
        assert_eq!(store.load().len(), 1);
        let bad: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(dir.path().join("runners.json.bad")).unwrap()).unwrap();
        assert_eq!(bad, vec![broken]);
    }

    #[test]
    fn unreadable_file_is_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runners.json");
        let store = Store::new(dir.path());
        store.save(&[record("a")]).unwrap();
        let before = std::fs::read(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_ok() {
            return; // running as root: permissions do not apply
        }
        assert!(store.load().is_empty());
        assert!(store.save(&[record("b")]).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(store.load().len(), 1);
        store.save(&[record("b")]).unwrap();
    }
}
