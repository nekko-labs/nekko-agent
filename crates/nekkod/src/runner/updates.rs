//! Pending macOS security updates, from `softwareupdate --list --no-scan`. The
//! 7-day grace starts when nekkod first saw an update listed, kept in
//! `<data>/runners/updates.json` (label to first-seen unix seconds) so a
//! restart does not reset it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Labels of listed updates that are macOS itself or a security update.
pub fn security_labels(softwareupdate_list: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut lines = softwareupdate_list.lines().peekable();
    while let Some(line) = lines.next() {
        let Some(label) = line.trim().strip_prefix("* Label:").map(str::trim) else { continue };
        let title = lines.peek().and_then(|l| l.trim().strip_prefix("Title:")).unwrap_or("");
        if label.starts_with("macOS") || title.contains("Security") {
            out.push(label.to_string());
        }
    }
    out
}

pub struct UpdateLedger {
    path: Option<PathBuf>,
    first_seen: BTreeMap<String, u64>,
}

impl UpdateLedger {
    pub fn load(runners_dir: &Path) -> UpdateLedger {
        let path = runners_dir.join("updates.json");
        let first_seen = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        UpdateLedger { path: Some(path), first_seen }
    }

    pub fn in_memory() -> UpdateLedger {
        UpdateLedger { path: None, first_seen: BTreeMap::new() }
    }

    /// Records new labels, forgets ones no longer listed, and returns whole
    /// days since the oldest still listed was first seen (`None`: nothing listed).
    pub fn observe(&mut self, labels: &[String], now_secs: u64) -> Option<u32> {
        let before = self.first_seen.clone();
        self.first_seen.retain(|l, _| labels.contains(l));
        for l in labels {
            self.first_seen.entry(l.clone()).or_insert(now_secs);
        }
        if self.first_seen != before {
            self.save();
        }
        let oldest = *self.first_seen.values().min()?;
        Some(u32::try_from(now_secs.saturating_sub(oldest) / 86_400).unwrap_or(u32::MAX))
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let write =
            serde_json::to_vec(&self.first_seen).map_err(std::io::Error::other).and_then(|b| std::fs::write(path, b));
        if let Err(e) = write {
            eprintln!("runner updates: cannot save {}: {e}", path.display());
        }
    }
}
