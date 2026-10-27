//! The CI service a runner registers with. The supervisor only needs these
//! calls; GitHub's implementation lives in `github.rs`, and tests script a fake.
//! [`ByLink`] sends each call to the provider the record is linked to.

use super::store::{Link, RunnerRecord};
use serde::{Deserialize, Serialize};
use std::future::Future;

/// A just-in-time runner registration: single use, handed to one VM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Minted {
    pub runner_id: u64,
    /// The file name the guest reads `jit_config` from on the seed image.
    pub seed_file: &'static str,
    /// The single-job credential, whatever its format.
    pub jit_config: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStatus {
    /// Not registered (never was, or already removed after its one job).
    Missing,
    Offline,
    Idle,
    Busy,
}

/// The job a runner took.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRef {
    pub repo: String,
    pub run_id: u64,
    pub job_id: u64,
    pub workflow: String,
    pub job: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// The credentials are missing or refused: the runner cannot work until
    /// the owner reconnects. The message is shown as is.
    Auth(String),
    Other(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::Auth(m) | ProviderError::Other(m) => f.write_str(m),
        }
    }
}

pub trait Provider: Send + Sync + 'static {
    fn mint(&self, r: &RunnerRecord, name: &str) -> impl Future<Output = Result<Minted, ProviderError>> + Send;
    fn status(
        &self,
        r: &RunnerRecord,
        runner_id: u64,
    ) -> impl Future<Output = Result<RunnerStatus, ProviderError>> + Send;
    /// `runner_id` is the minted registration (GitLab looks jobs up by it; GitHub by name).
    fn job(
        &self,
        r: &RunnerRecord,
        runner_id: u64,
        runner_name: &str,
    ) -> impl Future<Output = Result<Option<JobRef>, ProviderError>> + Send;
    /// Jobs waiting for a runner with this record's labels.
    fn queued(&self, r: &RunnerRecord) -> impl Future<Output = Result<u32, ProviderError>> + Send;
    /// Removes a registration; one that is already gone is `Ok`.
    fn remove(&self, r: &RunnerRecord, runner_id: u64) -> impl Future<Output = Result<(), ProviderError>> + Send;
    /// Removes every offline registration named exactly `<name_prefix><unix secs>-<n>`; returns how many.
    fn remove_stale(
        &self,
        r: &RunnerRecord,
        name_prefix: &str,
    ) -> impl Future<Output = Result<u32, ProviderError>> + Send;
    fn rerun(&self, r: &RunnerRecord, job: &JobRef) -> impl Future<Output = Result<(), ProviderError>> + Send;
}

/// Routes every call to `github` or `gitlab` by the record's link.
pub struct ByLink<G: Provider, L: Provider> {
    pub github: G,
    pub gitlab: L,
}

impl<G: Provider, L: Provider> Provider for ByLink<G, L> {
    async fn mint(&self, r: &RunnerRecord, name: &str) -> Result<Minted, ProviderError> {
        match r.link {
            Link::Github(_) => self.github.mint(r, name).await,
            Link::Gitlab(_) => self.gitlab.mint(r, name).await,
        }
    }

    async fn status(&self, r: &RunnerRecord, runner_id: u64) -> Result<RunnerStatus, ProviderError> {
        match r.link {
            Link::Github(_) => self.github.status(r, runner_id).await,
            Link::Gitlab(_) => self.gitlab.status(r, runner_id).await,
        }
    }

    async fn job(&self, r: &RunnerRecord, runner_id: u64, runner_name: &str) -> Result<Option<JobRef>, ProviderError> {
        match r.link {
            Link::Github(_) => self.github.job(r, runner_id, runner_name).await,
            Link::Gitlab(_) => self.gitlab.job(r, runner_id, runner_name).await,
        }
    }

    async fn queued(&self, r: &RunnerRecord) -> Result<u32, ProviderError> {
        match r.link {
            Link::Github(_) => self.github.queued(r).await,
            Link::Gitlab(_) => self.gitlab.queued(r).await,
        }
    }

    async fn remove(&self, r: &RunnerRecord, runner_id: u64) -> Result<(), ProviderError> {
        match r.link {
            Link::Github(_) => self.github.remove(r, runner_id).await,
            Link::Gitlab(_) => self.gitlab.remove(r, runner_id).await,
        }
    }

    async fn remove_stale(&self, r: &RunnerRecord, name_prefix: &str) -> Result<u32, ProviderError> {
        match r.link {
            Link::Github(_) => self.github.remove_stale(r, name_prefix).await,
            Link::Gitlab(_) => self.gitlab.remove_stale(r, name_prefix).await,
        }
    }

    async fn rerun(&self, r: &RunnerRecord, job: &JobRef) -> Result<(), ProviderError> {
        match r.link {
            Link::Github(_) => self.github.rerun(r, job).await,
            Link::Gitlab(_) => self.gitlab.rerun(r, job).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::store::{GithubLink, GitlabLink};
    use nekko_runner::{RunnerConfig, RunnerSettings, Scope};
    use std::sync::{Arc, Mutex};

    type Log = Arc<Mutex<Vec<String>>>;

    /// Logs `<tag> <call> <args>` and answers with fixed values.
    struct Tagged(&'static str, Log);

    impl Tagged {
        fn log(&self, what: String) {
            self.1.lock().unwrap().push(format!("{} {what}", self.0));
        }
    }

    impl Provider for Tagged {
        async fn mint(&self, _: &RunnerRecord, name: &str) -> Result<Minted, ProviderError> {
            self.log(format!("mint {name}"));
            Ok(Minted { runner_id: 1, seed_file: self.0, jit_config: "c".into() })
        }
        async fn status(&self, _: &RunnerRecord, id: u64) -> Result<RunnerStatus, ProviderError> {
            self.log(format!("status {id}"));
            Ok(RunnerStatus::Idle)
        }
        async fn job(&self, _: &RunnerRecord, id: u64, name: &str) -> Result<Option<JobRef>, ProviderError> {
            self.log(format!("job {id} {name}"));
            Ok(None)
        }
        async fn queued(&self, _: &RunnerRecord) -> Result<u32, ProviderError> {
            self.log("queued".into());
            Ok(0)
        }
        async fn remove(&self, _: &RunnerRecord, id: u64) -> Result<(), ProviderError> {
            self.log(format!("remove {id}"));
            Ok(())
        }
        async fn remove_stale(&self, _: &RunnerRecord, prefix: &str) -> Result<u32, ProviderError> {
            self.log(format!("remove_stale {prefix}"));
            Ok(0)
        }
        async fn rerun(&self, _: &RunnerRecord, job: &JobRef) -> Result<(), ProviderError> {
            self.log(format!("rerun {}", job.job_id));
            Ok(())
        }
    }

    fn record(link: Link) -> RunnerRecord {
        RunnerRecord {
            config: RunnerConfig {
                id: "r".into(),
                scope: Scope::Org { org: "acme".into() },
                label: "nekko-mac".into(),
                settings: RunnerSettings::default(),
            },
            link,
            image: None,
        }
    }

    #[tokio::test]
    async fn by_link_routes_by_record() {
        let log = Log::default();
        let p = ByLink { github: Tagged("gh", log.clone()), gitlab: Tagged("gl", log.clone()) };
        let gh = record(Link::Github(GithubLink {
            app_id: 1,
            installation_id: 2,
            group_id: None,
            repos: vec![],
            allow_public: false,
        }));
        let gl = record(Link::Gitlab(GitlabLink {
            base_url: "https://gitlab.com".into(),
            namespace_id: 3,
            projects: vec![],
            allow_public: false,
            protected_only: true,
        }));
        let job = JobRef { repo: "a/b".into(), run_id: 1, job_id: 9, workflow: "w".into(), job: "j".into() };
        for (r, tag) in [(&gh, "gh"), (&gl, "gl")] {
            log.lock().unwrap().clear();
            assert_eq!(p.mint(r, "n").await.unwrap().seed_file, tag);
            p.status(r, 5).await.unwrap();
            p.job(r, 5, "n").await.unwrap();
            p.queued(r).await.unwrap();
            p.remove(r, 5).await.unwrap();
            p.remove_stale(r, "nekko-h-").await.unwrap();
            p.rerun(r, &job).await.unwrap();
            let want: Vec<String> =
                ["mint n", "status 5", "job 5 n", "queued", "remove 5", "remove_stale nekko-h-", "rerun 9"]
                    .iter()
                    .map(|c| format!("{tag} {c}"))
                    .collect();
            assert_eq!(*log.lock().unwrap(), want);
        }
    }
}
