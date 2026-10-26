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

/// The GitLab project (repo scope) or group (org scope) a runner registers with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabLink {
    pub base_url: String,
    /// The numeric project id (repo scope) or group id (org scope).
    pub namespace_id: u64,
    /// Full project paths watched for queued jobs (org scope only).
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub allow_public: bool,
    #[serde(default = "yes")]
    pub protected_only: bool,
}

fn yes() -> bool {
    true
}

/// On disk a record has a top-level `"github"` or `"gitlab"` key, never both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Link {
    Github(GithubLink),
    Gitlab(GitlabLink),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerRecord {
    #[serde(flatten)]
    pub config: RunnerConfig,
    #[serde(flatten)]
    pub link: Link,
    /// A golden bundle other than `images/default/`.
    #[serde(default)]
    pub image: Option<PathBuf>,
}

impl RunnerRecord {
    pub fn github(&self) -> Option<&GithubLink> {
        match &self.link {
            Link::Github(g) => Some(g),
            Link::Gitlab(_) => None,
        }
    }

    pub fn gitlab(&self) -> Option<&GitlabLink> {
        match &self.link {
            Link::Gitlab(g) => Some(g),
            Link::Github(_) => None,
        }
    }
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

fn same_instance(a: &GitlabLink, b: &GitlabLink) -> bool {
    a.base_url.trim_end_matches('/').eq_ignore_ascii_case(b.base_url.trim_end_matches('/'))
}

/// One runner target: the same CI service (and GitLab instance) and scope. A
/// connect over a saved target updates that record; anything else is a new one.
pub fn same_target(a: &RunnerRecord, b: &RunnerRecord) -> bool {
    let service = match (&a.link, &b.link) {
        (Link::Github(_), Link::Github(_)) => true,
        (Link::Gitlab(x), Link::Gitlab(y)) => same_instance(x, y),
        _ => false,
    };
    service && same_scope(&a.config.scope, &b.config.scope)
}

/// Whether one record's stale sweep could see the other's runners: the same
/// target, or two GitLab groups on one instance (one may be the other's
/// ancestor, which nekkod does not track).
pub fn overlaps(a: &RunnerRecord, b: &RunnerRecord) -> bool {
    let groups = matches!((&a.config.scope, &b.config.scope), (Scope::Org { .. }, Scope::Org { .. }));
    same_target(a, b) || (groups && a.gitlab().zip(b.gitlab()).is_some_and(|(x, y)| same_instance(x, y)))
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
            // Serde would quietly take the first link of two; which one is meant is unknowable.
            if v.get("github").is_some() && v.get("gitlab").is_some() {
                eprintln!("runner store: record {i} has both a GitHub and a GitLab link, skipped");
                skipped.push(v);
                continue;
            }
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
            link: Link::Github(GithubLink {
                app_id: 1,
                installation_id: 2,
                group_id: None,
                repos: vec![],
                allow_public: false,
            }),
            image: None,
        }
    }

    fn gitlab_record(id: &str) -> RunnerRecord {
        RunnerRecord {
            link: Link::Gitlab(GitlabLink {
                base_url: "https://gitlab.example.com".into(),
                namespace_id: 42,
                projects: vec!["a/b/c".into()],
                allow_public: false,
                protected_only: true,
            }),
            ..record(id)
        }
    }

    #[test]
    fn t212_records_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let text = r#"[{"id":"a","scope":{"kind":"org","org":"acme"},"label":"nekko-mac","settings":{},
            "github":{"appId":1,"installationId":2}}]"#;
        std::fs::write(dir.path().join("runners.json"), text).unwrap();
        let recs = Store::new(dir.path()).load();
        assert_eq!(recs[0].github().map(|g| g.app_id), Some(1));
        assert!(recs[0].gitlab().is_none());
        Store::new(dir.path()).save(&recs).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("runners.json")).unwrap()).unwrap();
        assert!(saved[0].get("github").is_some() && saved[0].get("link").is_none() && saved[0].get("gitlab").is_none());
        assert_eq!(saved[0]["github"]["appId"], json!(1));
    }

    #[test]
    fn gitlab_record_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let recs = vec![gitlab_record("g")];
        store.save(&recs).unwrap();
        assert_eq!(store.load(), recs);
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("runners.json")).unwrap()).unwrap();
        let gl = &saved[0]["gitlab"];
        assert_eq!(
            (gl["baseUrl"].as_str(), gl["namespaceId"].as_u64()),
            (Some("https://gitlab.example.com"), Some(42))
        );
        assert_eq!(gl["protectedOnly"], json!(true));
        assert!(saved[0].get("github").is_none() && saved[0].get("link").is_none());
    }

    #[test]
    fn protected_only_defaults_true() {
        let dir = tempfile::tempdir().unwrap();
        let text = r#"[{"id":"g","scope":{"kind":"org","org":"a/b"},"label":"nekko-mac","settings":{},
            "gitlab":{"baseUrl":"https://gitlab.com","namespaceId":7}}]"#;
        std::fs::write(dir.path().join("runners.json"), text).unwrap();
        let recs = Store::new(dir.path()).load();
        let gl = recs[0].gitlab().unwrap();
        assert!(gl.protected_only && gl.projects.is_empty() && !gl.allow_public);
        assert!(recs[0].github().is_none());
    }

    #[test]
    fn record_with_two_links_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let mut both = serde_json::to_value(record("a")).unwrap();
        both["gitlab"] = serde_json::to_value(gitlab_record("x")).unwrap()["gitlab"].clone();
        let mut neither = serde_json::to_value(record("b")).unwrap();
        neither.as_object_mut().unwrap().remove("github");
        let good = serde_json::to_value(gitlab_record("c")).unwrap();
        std::fs::write(dir.path().join("runners.json"), json!([both, neither, good]).to_string()).unwrap();
        assert_eq!(Store::new(dir.path()).load(), vec![gitlab_record("c")]);
        let bad: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(dir.path().join("runners.json.bad")).unwrap()).unwrap();
        assert_eq!(bad, vec![both, neither]);
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

    #[test]
    fn targets_and_overlaps_know_the_provider_and_instance() {
        let gh = record("a");
        let gl = gitlab_record("b");
        let mut gl_repo = gitlab_record("c");
        gl_repo.config.scope = Scope::Repo { owner: "acme".into(), repo: "app".into() };
        let mut gl_other = gitlab_record("d");
        gl_other.link =
            Link::Gitlab(GitlabLink { base_url: "https://gitlab.com".into(), ..gl.gitlab().unwrap().clone() });
        let mut gl_sub = gitlab_record("e");
        gl_sub.config.scope = Scope::Org { org: "acme/sub".into() };
        // Same scope string, other provider or other instance: another target, no overlap.
        assert!(!same_target(&gh, &gl) && !overlaps(&gh, &gl));
        assert!(!same_target(&gl, &gl_other) && !overlaps(&gl, &gl_other));
        assert!(same_target(&gl, &gitlab_record("x")) && same_target(&gh, &record("y")));
        // Two groups on one instance overlap whatever their paths; a project and a group do not.
        assert!(overlaps(&gl, &gl_sub) && !same_target(&gl, &gl_sub));
        assert!(!overlaps(&gl, &gl_repo));
        assert!(overlaps(&gh, &record("z")));
    }
}
