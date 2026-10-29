//! `<data>/runners/audit.jsonl`: one line per job a runner ran, lost or
//! stopped, and per VM that failed to start.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuditResult {
    Finished,
    Stopped,
    Lost,
    FailedToStart,
    /// A registration that could not be removed before its runner was forgotten: delete it by hand.
    NotRemoved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLine {
    pub ts: u64,
    pub runner_id: String,
    pub repo: Option<String>,
    pub workflow: Option<String>,
    pub job: Option<String>,
    pub result: AuditResult,
    pub seconds: u64,
    pub reason: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Today {
    pub jobs: u32,
    pub seconds: u64,
}

impl Today {
    pub fn add(&mut self, line: &AuditLine) {
        if !matches!(line.result, AuditResult::FailedToStart | AuditResult::NotRemoved) {
            self.jobs += 1;
            self.seconds += line.seconds;
        }
    }
}

// shortcut: audit.jsonl is not rotated (about 200 bytes a job), rotate when it passes a few MB.
pub fn append(runners_dir: &Path, line: &AuditLine) -> io::Result<()> {
    std::fs::create_dir_all(runners_dir)?;
    let mut text = serde_json::to_string(line)?;
    text.push('\n');
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(runners_dir.join("audit.jsonl"))?
        .write_all(text.as_bytes())
}

/// Jobs and job seconds per runner id since `since_ts`; failed starts are not jobs.
pub fn today(runners_dir: &Path, since_ts: u64) -> HashMap<String, Today> {
    let mut out: HashMap<String, Today> = HashMap::new();
    let text = std::fs::read_to_string(runners_dir.join("audit.jsonl")).unwrap_or_default();
    for line in text.lines().filter_map(|l| serde_json::from_str::<AuditLine>(l).ok()) {
        if line.ts >= since_ts {
            out.entry(line.runner_id.clone()).or_default().add(&line);
        }
    }
    out
}

/// The last `n` lines of one runner, newest first; unreadable lines are skipped.
pub fn recent(runners_dir: &Path, runner_id: &str, n: usize) -> Vec<AuditLine> {
    let text = std::fs::read_to_string(runners_dir.join("audit.jsonl")).unwrap_or_default();
    text.lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<AuditLine>(l).ok())
        .filter(|l| l.runner_id == runner_id)
        .take(n)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(ts: u64, result: AuditResult) -> AuditLine {
        AuditLine {
            ts,
            runner_id: "r1".into(),
            repo: Some("acme/app".into()),
            workflow: Some("ci".into()),
            job: Some("build".into()),
            result,
            seconds: 100,
            reason: vec![],
        }
    }

    #[test]
    fn audit_today_counts_since_midnight() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &line(999, AuditResult::Finished)).unwrap();
        append(dir.path(), &line(1000, AuditResult::Finished)).unwrap();
        append(dir.path(), &line(1001, AuditResult::Lost)).unwrap();
        append(dir.path(), &line(1002, AuditResult::FailedToStart)).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join("audit.jsonl"))
            .unwrap()
            .write_all(b"not json\n")
            .unwrap();
        let t = today(dir.path(), 1000);
        assert_eq!(t.get("r1"), Some(&Today { jobs: 2, seconds: 200 }));
        let text = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
        assert!(text.lines().next().unwrap().contains("\"runnerId\":\"r1\""));
        assert!(text.contains("\"result\":\"failedToStart\""));
    }

    #[test]
    fn recent_reads_newest_first_for_one_runner() {
        let dir = tempfile::tempdir().unwrap();
        for (id, ts) in [("a", 1), ("a", 2), ("a", 3), ("b", 4)] {
            let mut l = line(ts, AuditResult::Finished);
            l.runner_id = id.into();
            append(dir.path(), &l).unwrap();
        }
        std::fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join("audit.jsonl"))
            .unwrap()
            .write_all(b"not json\n")
            .unwrap();
        let ts: Vec<u64> = recent(dir.path(), "a", 2).iter().map(|l| l.ts).collect();
        assert_eq!(ts, [3, 2]);
    }
}
