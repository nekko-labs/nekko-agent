//! `runners.json`: the runner records the owner configured. A hand-edited or
//! damaged file must never stop the daemon: records load sanitized, broken
//! ones are skipped, and a file that is not JSON at all is kept aside.

use nekko_runner::RunnerConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

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

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(runners_dir: &Path) -> Store {
        Store { path: runners_dir.join("runners.json") }
    }

    pub fn load(&self) -> Vec<RunnerRecord> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                eprintln!("runner store: cannot read {}: {e}", self.path.display());
                return Vec::new();
            }
        };
        let Ok(items) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
            let bad = self.path.with_file_name("runners.json.bad");
            match std::fs::rename(&self.path, &bad) {
                Ok(()) => eprintln!("runner store: not valid JSON, kept as {}", bad.display()),
                Err(e) => eprintln!("runner store: not valid JSON and could not be set aside: {e}"),
            }
            return Vec::new();
        };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (i, v) in items.into_iter().enumerate() {
            match serde_json::from_value::<RunnerRecord>(v) {
                Ok(mut r) if seen.insert(r.config.id.clone()) => {
                    r.config.settings = r.config.settings.sanitized();
                    out.push(r);
                }
                Ok(r) => eprintln!("runner store: record {i} repeats id {}, skipped", r.config.id),
                Err(e) => eprintln!("runner store: record {i} skipped: {e}"),
            }
        }
        out
    }

    /// Write through a temp file and rename, so a crash never leaves half a file.
    pub fn save(&self, records: &[RunnerRecord]) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_file_name("runners.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(records)?)?;
        std::fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nekko_runner::{RunnerSettings, Scope};
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
}
