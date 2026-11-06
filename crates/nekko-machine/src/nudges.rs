//! Upgrade nudges: "A better coding model now fits your 16 GB GPU".
//!
//! The picks a user has seen are kept in `<data>/recommendations-seen.json`,
//! with the feed and machine they were made for. A task's pick changes when a
//! newer app ships a newer feed, or when the machine changes (a new GPU, a GPU
//! engine build). A nudge says so only when it is news to this user: they
//! already have a model for that task, it is not the new pick, and the new
//! pick ranks above it in the feed's order. The first time anything is
//! recommended there is nothing to compare with, so the picks are only
//! remembered. Dismissing a nudge remembers its pick as seen.

use crate::recommend::{Feed, Recommendations};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

const FILE: &str = "recommendations-seen.json";
const FORMAT: u32 = 1;

/// What the user has seen recommended, per task.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    pub format: u32,
    pub feed_version: String,
    /// `machine_key` of the machine the picks were made for.
    pub machine: String,
    /// Task id to `modelId/quant`.
    pub picks: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NudgeReason {
    /// The machine changed (a new GPU, a GPU build of the engine).
    Hardware,
    /// A newer feed ranks a better model for it.
    Feed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nudge {
    pub task: String,
    pub label: String,
    pub reason: NudgeReason,
    /// The model the user has for this task now.
    pub have_model_id: String,
    pub have_name: String,
}

fn key(model: &str, quant: &str) -> String {
    format!("{model}/{quant}")
}

fn base(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase()
}

/// The picks of `recs`, as they would be remembered.
pub fn picks_of(recs: &Recommendations) -> BTreeMap<String, String> {
    recs.tasks.iter().filter_map(|t| t.pick.as_ref().map(|p| (t.task.clone(), key(&p.model_id, &p.quant)))).collect()
}

/// The nudges for `recs`, given what was seen before and the model files on disk.
pub fn nudges(recs: &Recommendations, feed: &Feed, seen: &Seen, machine: &str, have_files: &[String]) -> Vec<Nudge> {
    let have: Vec<String> = have_files.iter().map(|f| base(f)).collect();
    let owns = |model_id: &str| {
        feed.models
            .iter()
            .find(|m| m.id == model_id)
            .is_some_and(|m| m.quants.iter().any(|q| q.files.first().is_some_and(|f| have.contains(&base(f)))))
    };
    let mut out = Vec::new();
    for t in &recs.tasks {
        let Some(pick) = &t.pick else { continue };
        let Some(before) = seen.picks.get(&t.task) else { continue };
        if *before == key(&pick.model_id, &pick.quant) || owns(&pick.model_id) {
            continue;
        }
        let Some(task) = feed.tasks.iter().find(|x| x.id == t.task) else { continue };
        let rank = |id: &str| task.candidates.iter().position(|c| c == id);
        let Some(new_rank) = rank(&pick.model_id) else { continue };
        // The best model the user already has for this task.
        let Some((have_rank, have_id)) =
            task.candidates.iter().enumerate().find(|(_, id)| owns(id)).map(|(i, id)| (i, id.clone()))
        else {
            continue;
        };
        if new_rank >= have_rank {
            continue;
        }
        out.push(Nudge {
            task: t.task.clone(),
            label: t.label.clone(),
            reason: if seen.machine != machine { NudgeReason::Hardware } else { NudgeReason::Feed },
            have_name: feed.models.iter().find(|m| m.id == have_id).map(|m| m.name.clone()).unwrap_or_default(),
            have_model_id: have_id,
        });
    }
    out
}

fn path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(FILE)
}

pub fn read_seen(data_dir: &Path) -> Option<Seen> {
    serde_json::from_slice::<Seen>(&std::fs::read(path(data_dir)).ok()?).ok().filter(|s| s.format == FORMAT)
}

pub fn write_seen(data_dir: &Path, seen: &Seen) {
    let p = path(data_dir);
    if let Ok(text) = serde_json::to_string_pretty(seen) {
        let _ = nekko_js::fs::atomic_write(&p, text.as_bytes(), Default::default());
    }
}

/// The nudges for this answer. The first answer ever only remembers its picks.
pub fn nudges_for(
    data_dir: &Path,
    recs: &Recommendations,
    feed: &Feed,
    machine: &str,
    have_files: &[String],
) -> Vec<Nudge> {
    match read_seen(data_dir) {
        Some(seen) => nudges(recs, feed, &seen, machine, have_files),
        None => {
            let seen = Seen {
                format: FORMAT,
                feed_version: recs.feed_version.clone(),
                machine: machine.to_string(),
                picks: picks_of(recs),
            };
            write_seen(data_dir, &seen);
            Vec::new()
        }
    }
}

/// Remember the current pick for `task` (or every task) as seen: its nudge goes.
pub fn dismiss(data_dir: &Path, recs: &Recommendations, machine: &str, task: Option<&str>) {
    let mut seen = read_seen(data_dir).unwrap_or(Seen { format: FORMAT, ..Seen::default() });
    let now = picks_of(recs);
    for (t, pick) in &now {
        if task.is_none_or(|x| x == t) {
            seen.picks.insert(t.clone(), pick.clone());
        }
    }
    // The machine and feed move on once every pick has been seen, so a nudge
    // still showing keeps saying why it came.
    if now.iter().all(|(t, p)| seen.picks.get(t) == Some(p)) {
        seen.feed_version = recs.feed_version.clone();
        seen.machine = machine.to_string();
    }
    write_seen(data_dir, &seen);
}
