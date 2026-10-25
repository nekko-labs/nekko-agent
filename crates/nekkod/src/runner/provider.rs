//! The CI service a runner registers with. The supervisor only needs these
//! calls; GitHub's implementation lives in `github.rs`, and tests script a fake.

use super::store::RunnerRecord;
use serde::{Deserialize, Serialize};
use std::future::Future;

/// A just-in-time runner registration: single use, handed to one VM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Minted {
    pub runner_id: u64,
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
    fn job(
        &self,
        r: &RunnerRecord,
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
