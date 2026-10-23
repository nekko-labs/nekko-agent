//! Decode speeds measured on this machine, kept in
//! `<data>/measured-speeds.json`: the median of a model file's recent replies
//! replaces the feed's figure for it, in the speed shown and in the speed
//! target a pick has to meet.
//!
//! A sample is one reply the engine served (`nekko-infer`'s meter reads the
//! `timings` llama-server ends it with). Only replies that had the model to
//! themselves and generated enough tokens to say something count. A file's
//! samples belong to the machine they were taken on (GPU and engine backend):
//! a new card or a CPU build starts the file's record over.

use crate::profile::HardwareProfile;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE: &str = "measured-speeds.json";
const FORMAT: u32 = 1;
/// The recent replies a median is taken over.
const KEEP: usize = 20;
/// Fewer than this and the feed's figure stands.
pub const MIN_SAMPLES: usize = 3;
/// Shorter replies are dominated by per-request overhead, not decode.
pub const MIN_TOKENS: f64 = 32.0;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Which machine the samples are from ([`machine_key`]).
    pub machine: String,
    /// Tokens per second, oldest first.
    pub samples: Vec<f64>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSpeeds {
    pub format: u32,
    /// By weights file name (the first shard of a split model), lower-cased.
    pub files: BTreeMap<String, Record>,
}

/// A local figure for one file: the median and how many replies it is from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalSpeed {
    pub tokens_per_second: f64,
    pub samples: usize,
}

/// The file name a record is kept under.
pub fn file_key(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase()
}

/// What makes samples comparable: the roomiest GPU (or none) and the engine backend.
pub fn machine_key(profile: &HardwareProfile) -> String {
    let gpu = profile.gpus.iter().max_by(|a, b| a.vram_bytes.total_cmp(&b.vram_bytes));
    let backend = profile.engine.as_ref().map_or("none", |e| e.backend.as_str());
    format!("{}|{backend}", gpu.map_or("cpu", |g| g.name.as_str()))
}

fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    let m = s.len() / 2;
    if s.len().is_multiple_of(2) { (s[m - 1] + s[m]) / 2.0 } else { s[m] }
}

impl LocalSpeeds {
    /// The median for `file` on `machine`, once there are enough samples.
    pub fn speed(&self, file: &str, machine: &str) -> Option<LocalSpeed> {
        let r = self.files.get(&file_key(file)).filter(|r| r.machine == machine)?;
        (r.samples.len() >= MIN_SAMPLES).then(|| LocalSpeed {
            tokens_per_second: (median(&r.samples) * 10.0).round() / 10.0,
            samples: r.samples.len(),
        })
    }

    /// Add one reply's speed; a record from another machine starts over.
    pub fn add(&mut self, file: &str, machine: &str, tokens_per_second: f64, now: u64) {
        let r = self.files.entry(file_key(file)).or_default();
        if r.machine != machine {
            *r = Record { machine: machine.to_string(), ..Record::default() };
        }
        r.samples.push(tokens_per_second);
        if r.samples.len() > KEEP {
            r.samples.remove(0);
        }
        r.updated_at = now;
    }
}

/// The record on disk, read once and written after every sample.
pub struct MeasuredSpeeds {
    path: Option<PathBuf>,
    speeds: Mutex<Option<LocalSpeeds>>,
}

impl MeasuredSpeeds {
    pub fn new(data_dir: Option<&Path>) -> Self {
        Self { path: data_dir.map(|d| d.join(FILE)), speeds: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut LocalSpeeds) -> T) -> T {
        let mut guard = self.speeds.lock().unwrap();
        let speeds = guard.get_or_insert_with(|| {
            self.path
                .as_ref()
                .and_then(|p| std::fs::read(p).ok())
                .and_then(|b| serde_json::from_slice::<LocalSpeeds>(&b).ok())
                .filter(|s| s.format == FORMAT)
                .unwrap_or(LocalSpeeds { format: FORMAT, files: BTreeMap::new() })
        });
        f(speeds)
    }

    pub fn snapshot(&self) -> LocalSpeeds {
        self.with(|s| s.clone())
    }

    /// Record one reply: `predicted_n` tokens in `predicted_ms`, with the model to itself or not.
    /// `false` when the reply does not count.
    pub fn record(
        &self,
        file: &str,
        machine: &str,
        predicted_n: f64,
        predicted_ms: f64,
        alone: bool,
        now: u64,
    ) -> bool {
        if !alone || predicted_n < MIN_TOKENS || predicted_ms <= 0.0 {
            return false;
        }
        let tps = predicted_n / predicted_ms * 1000.0;
        let text = self.with(|s| {
            s.add(file, machine, tps, now);
            serde_json::to_string(s).ok()
        });
        if let (Some(p), Some(text)) = (&self.path, text) {
            // Best-effort: a sample that cannot be saved still counts until restart.
            let tmp = p.with_extension(format!("json.{}.tmp", std::process::id()));
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, p);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_median_needs_three_replies_from_this_machine() {
        let mut s = LocalSpeeds::default();
        s.add("/m/Qwen3.5-4B-Q4_K_M.gguf", "M5|metal", 120.0, 1);
        s.add("D:\\models\\qwen3.5-4b-q4_k_m.gguf", "M5|metal", 130.0, 2);
        assert_eq!(s.speed("Qwen3.5-4B-Q4_K_M.gguf", "M5|metal"), None, "two replies");
        s.add("Qwen3.5-4B-Q4_K_M.gguf", "M5|metal", 10.0, 3);
        assert_eq!(
            s.speed("Qwen3.5-4B-Q4_K_M.gguf", "M5|metal"),
            Some(LocalSpeed { tokens_per_second: 120.0, samples: 3 })
        );
        assert_eq!(s.speed("Qwen3.5-4B-Q4_K_M.gguf", "RTX 4060|cuda"), None, "another machine");
        // A new GPU starts the record over.
        s.add("Qwen3.5-4B-Q4_K_M.gguf", "RTX 4060|cuda", 50.0, 4);
        assert_eq!(s.files["qwen3.5-4b-q4_k_m.gguf"].samples, vec![50.0]);
    }

    #[test]
    fn keeps_the_last_twenty() {
        let mut s = LocalSpeeds::default();
        for i in 0..25 {
            s.add("a.gguf", "x", i as f64, i);
        }
        assert_eq!(s.files["a.gguf"].samples.first(), Some(&5.0));
        assert_eq!(s.speed("a.gguf", "x").unwrap(), LocalSpeed { tokens_per_second: 14.5, samples: 20 });
    }

    #[test]
    fn only_long_replies_alone_on_the_model_count_and_they_are_saved() {
        let dir = std::env::temp_dir().join(format!("nekko-measured-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = MeasuredSpeeds::new(Some(&dir));
        assert!(!store.record("a.gguf", "x", 16.0, 100.0, true, 1), "too short");
        assert!(!store.record("a.gguf", "x", 64.0, 500.0, false, 1), "shared the model");
        assert!(store.record("a.gguf", "x", 64.0, 500.0, true, 1));
        let again = MeasuredSpeeds::new(Some(&dir));
        assert_eq!(again.snapshot().files["a.gguf"].samples, vec![128.0]);
        std::fs::remove_dir_all(dir).ok();
    }
}
