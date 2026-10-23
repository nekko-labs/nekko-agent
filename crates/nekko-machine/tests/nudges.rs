//! Upgrade nudges over the bundled feed: only news, only an upgrade, said once.

use nekko_machine::measured::LocalSpeeds;
use nekko_machine::nudges::{NudgeReason, Seen, dismiss, nudges, nudges_for, picks_of, read_seen};
use nekko_machine::profile::{Cpu, EngineBuild, Gpu, HardwareProfile};
use nekko_machine::recommend::Recommendations;
use nekko_machine::{bundled_feed, recommend};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn pc(gpu: &str, vram: f64) -> HardwareProfile {
    HardwareProfile {
        format: 1,
        probed_at: 0,
        platform: "win32".into(),
        arch: "x64".into(),
        release: String::new(),
        cpu: Cpu { model: None, cores: 16 },
        ram_bytes: 64.0 * GIB,
        unified: false,
        gpus: vec![Gpu { name: gpu.into(), vram_bytes: vram * GIB, cores: None }],
        backends: vec!["cuda".into(), "cpu".into()],
        engine: Some(EngineBuild { backend: "cuda".into(), version: None }),
        disk_free_bytes: None,
    }
}

fn rec(p: &HardwareProfile) -> Recommendations {
    recommend(p, bundled_feed(), &LocalSpeeds::default())
}

/// The weights file of a model's quant, as it would sit in the library.
fn file(model: &str, quant: &str) -> String {
    let m = bundled_feed().models.iter().find(|m| m.id == model).unwrap();
    format!("/models/chat/{}", m.quants.iter().find(|q| q.label == quant).unwrap().files[0])
}

fn pick(r: &Recommendations, task: &str) -> (String, String) {
    let p = r.tasks.iter().find(|t| t.task == task).unwrap().pick.clone().unwrap();
    (p.model_id, p.quant)
}

#[test]
fn a_new_gpu_nudges_the_tasks_where_a_better_model_now_fits() {
    let old = rec(&pc("NVIDIA GeForce RTX 4060", 8.0));
    let seen = Seen {
        format: 1,
        feed_version: old.feed_version.clone(),
        machine: "NVIDIA GeForce RTX 4060|cuda".into(),
        picks: picks_of(&old),
    };
    // They downloaded what the 8 GB card was offered for coding.
    let (code_model, code_quant) = pick(&old, "code");
    let have = vec![file(&code_model, &code_quant)];

    let new = rec(&pc("NVIDIA GeForce RTX 4080", 16.0));
    assert_eq!(new.hardware.memory_bytes, 16.0 * GIB);
    let n = nudges(&new, bundled_feed(), &seen, "NVIDIA GeForce RTX 4080|cuda", &have);
    let code = n.iter().find(|x| x.task == "code").expect("a coding nudge");
    assert_eq!(code.reason, NudgeReason::Hardware);
    assert_eq!(code.have_model_id, code_model);
    // That model (Qwen3.5 4B) is also a chat and vision candidate, and better ones fit there now;
    // routing and embeddings did not move, or they have nothing for them.
    let mut tasks: Vec<&str> = n.iter().map(|x| x.task.as_str()).collect();
    tasks.sort();
    assert_eq!(tasks, ["chat", "code", "vision"], "{n:?}");

    // Once they have the new coding pick, coding has nothing to say.
    let (m, q) = pick(&new, "code");
    let n = nudges(&new, bundled_feed(), &seen, "NVIDIA GeForce RTX 4080|cuda", &[have[0].clone(), file(&m, &q)]);
    assert!(n.iter().all(|x| x.task != "code"), "{n:?}");
}

#[test]
fn no_nudge_when_nothing_changed_or_the_new_pick_is_not_better() {
    let r = rec(&pc("NVIDIA GeForce RTX 4080", 16.0));
    let seen = Seen { format: 1, feed_version: r.feed_version.clone(), machine: "x".into(), picks: picks_of(&r) };
    let (m, q) = pick(&r, "code");
    assert!(nudges(&r, bundled_feed(), &seen, "x", &[file(&m, &q)]).is_empty(), "the same picks");

    // A bigger GPU's coding pick, seen before; now on a smaller one with that model downloaded.
    let big = rec(&pc("NVIDIA GeForce RTX 5090", 32.0));
    let small = rec(&pc("NVIDIA GeForce RTX 4060", 8.0));
    let seen = Seen { format: 1, feed_version: big.feed_version.clone(), machine: "big".into(), picks: picks_of(&big) };
    let (bm, bq) = pick(&big, "code");
    assert!(
        nudges(&small, bundled_feed(), &seen, "small", &[file(&bm, &bq)]).is_empty(),
        "a step down is not an upgrade"
    );
}

#[test]
fn the_first_answer_remembers_and_a_dismissal_is_kept() {
    let dir = std::env::temp_dir().join(format!("nekko-nudges-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let old = rec(&pc("NVIDIA GeForce RTX 4060", 8.0));
    let (cm, cq) = pick(&old, "code");
    let have = vec![file(&cm, &cq)];
    assert!(nudges_for(&dir, &old, bundled_feed(), "small|cuda", &have).is_empty(), "nothing to compare with yet");
    assert_eq!(read_seen(&dir).unwrap().picks, picks_of(&old));

    let new = rec(&pc("NVIDIA GeForce RTX 4080", 16.0));
    assert_eq!(nudges_for(&dir, &new, bundled_feed(), "big|cuda", &have).len(), 3);
    dismiss(&dir, &new, "big|cuda", Some("code"));
    let left = nudges_for(&dir, &new, bundled_feed(), "big|cuda", &have);
    assert!(left.len() == 2 && left.iter().all(|n| n.task != "code"), "dismissed: {left:?}");
    // Other tasks' picks still changed and were not dismissed: the machine stays the old one.
    assert_eq!(read_seen(&dir).unwrap().machine, "small|cuda");
    dismiss(&dir, &new, "big|cuda", None);
    assert_eq!(read_seen(&dir).unwrap().machine, "big|cuda");
    std::fs::remove_dir_all(dir).ok();
}
