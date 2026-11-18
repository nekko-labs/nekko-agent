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
//!
//! Pictures and clips are kept beside them, in seconds each: a sample is one
//! picture (or clip) the daemon asked a picture model for, timed from the
//! request to the result with the model already loaded, at whatever size and
//! steps it was asked at.

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
    /// Tokens per second (seconds each, for a picture file), oldest first.
    pub samples: Vec<f64>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSpeeds {
    pub format: u32,
    /// By weights file name (the first shard of a split model), lower-cased.
    pub files: BTreeMap<String, Record>,
    /// Seconds a picture or clip, by the picture model's weights file name.
    #[serde(default)]
    pub pictures: BTreeMap<String, Record>,
}

/// A local figure for one picture file: the median seconds and how many pictures it is from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalSeconds {
    pub seconds: f64,
    pub samples: usize,
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

    /// The median seconds a picture for `file` on `machine`, once there are enough of them.
    pub fn picture_seconds(&self, file: &str, machine: &str) -> Option<LocalSeconds> {
        let r = self.pictures.get(&file_key(file)).filter(|r| r.machine == machine)?;
        (r.samples.len() >= MIN_SAMPLES)
            .then(|| LocalSeconds { seconds: (median(&r.samples) * 10.0).round() / 10.0, samples: r.samples.len() })
    }

    /// Add one reply's speed; a record from another machine starts over.
    pub fn add(&mut self, file: &str, machine: &str, tokens_per_second: f64, now: u64) {
        Self::push(self.files.entry(file_key(file)).or_default(), machine, tokens_per_second, now);
    }

    /// Add one picture's seconds; a record from another machine starts over.
    pub fn add_picture(&mut self, file: &str, machine: &str, seconds: f64, now: u64) {
        Self::push(self.pictures.entry(file_key(file)).or_default(), machine, seconds, now);
    }

    fn push(r: &mut Record, machine: &str, sample: f64, now: u64) {
        if r.machine != machine {
            *r = Record { machine: machine.to_string(), ..Record::default() };
        }
        r.samples.push(sample);
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
                .unwrap_or(LocalSpeeds { format: FORMAT, ..LocalSpeeds::default() })
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
        self.save(|s| s.add(file, machine, tps, now));
        true
    }

    /// Record one picture or clip that took `ms`. `false` when it does not count.
    pub fn record_picture(&self, file: &str, machine: &str, ms: f64, now: u64) -> bool {
        if !ms.is_finite() || ms <= 0.0 {
            return false;
        }
        self.save(|s| s.add_picture(file, machine, ms / 1000.0, now));
        true
    }

    fn save(&self, change: impl FnOnce(&mut LocalSpeeds)) {
        let text = self.with(|s| {
            change(s);
            serde_json::to_string(s).ok()
        });
        if let (Some(p), Some(text)) = (&self.path, text) {
            // Best-effort: a sample that cannot be saved still counts until restart.
            let _ = nekko_js::fs::atomic_write(p, text.as_bytes(), Default::default());
        }
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

    #[test]
    fn pictures_keep_their_own_median_in_seconds_and_old_files_still_load() {
        let dir = std::env::temp_dir().join(format!("nekko-measured-pictures-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A file written before pictures were timed has no `pictures`.
        std::fs::write(dir.join(FILE), r#"{"format":1,"files":{}}"#).unwrap();
        let m = MeasuredSpeeds::new(Some(&dir));
        assert!(!m.record_picture("/m/z_image_turbo-Q4_K.gguf", "RTX 4060|vulkan", 0.0, 1));
        for ms in [31_000.0, 24_000.0] {
            assert!(m.record_picture("/m/z_image_turbo-Q4_K.gguf", "RTX 4060|vulkan", ms, 1));
        }
        assert_eq!(m.snapshot().picture_seconds("z_image_turbo-Q4_K.gguf", "RTX 4060|vulkan"), None);
        m.record_picture("/m/z_image_turbo-Q4_K.gguf", "RTX 4060|vulkan", 25_500.0, 2);
        let again = MeasuredSpeeds::new(Some(&dir)).snapshot();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(
            again.picture_seconds("Z_Image_Turbo-Q4_K.gguf", "RTX 4060|vulkan"),
            Some(LocalSeconds { seconds: 25.5, samples: 3 })
        );
        // Another card's pictures say nothing about this one, and a picture is not a reply.
        assert_eq!(again.picture_seconds("z_image_turbo-Q4_K.gguf", "RTX 5090|cuda"), None);
        assert_eq!(again.speed("z_image_turbo-Q4_K.gguf", "RTX 4060|vulkan"), None);
    }
}
