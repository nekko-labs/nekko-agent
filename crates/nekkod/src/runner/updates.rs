//! Pending macOS security updates, from `softwareupdate --list --no-scan`. The
//! 7-day grace starts when nekkod first saw an update listed, kept in
//! `<data>/runners/updates.json` (label to first-seen unix seconds) so a
//! restart does not reset it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Labels of listed updates that are a security update (a Title containing
/// `Security`) or a macOS update for the running major version. The list also
/// offers the next major release, which the owner may decline for good, so a
/// `macOS` label whose first version number names another major is skipped.
/// One with no version, or any when `os_major` is 0 (unknown), counts.
pub fn security_labels(softwareupdate_list: &str, os_major: u32) -> Vec<String> {
    let mut out = Vec::new();
    let mut lines = softwareupdate_list.lines().peekable();
    while let Some(line) = lines.next() {
        let Some(label) = line.trim().strip_prefix("* Label:").map(str::trim) else { continue };
        let title = lines.peek().and_then(|l| l.trim().strip_prefix("Title:")).unwrap_or("");
        let major = first_number(label).or_else(|| first_number(title));
        let same_major = os_major == 0 || major.is_none_or(|m| m == os_major);
        if (label.starts_with("macOS") && same_major) || title.contains("Security") {
            out.push(label.to_string());
        }
    }
    out
}

fn first_number(s: &str) -> Option<u32> {
    s.split(|c: char| !c.is_ascii_digit()).find(|t| !t.is_empty())?.parse().ok()
}

/// The running macOS major version from `sw_vers -productVersion` output; 0 when unreadable.
pub fn os_major(product_version: &str) -> u32 {
    product_version.trim().split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0)
}

/// Writes through a temp file and renames, so a crash never leaves half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    nekko_js::fs::atomic_write(path, bytes, Default::default())
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
            serde_json::to_vec(&self.first_seen).map_err(std::io::Error::other).and_then(|b| write_atomic(path, &b));
        if let Err(e) = write {
            eprintln!("runner updates: cannot save {}: {e}", path.display());
        }
    }
}
