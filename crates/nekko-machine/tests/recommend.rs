//! Model recommendations over the bundled feed, for the machines the
//! acceptance criteria name (Windows with NVIDIA, Windows with AMD on Vulkan,
//! Apple Silicon, CPU only) and the edges between them.

use nekko_machine::profile::{Cpu, EngineBuild, Gpu, HardwareProfile};
use nekko_machine::recommend::{Fit, Placement, Recommendations, SpeedBasis, TaskPick, kv_bytes, match_class};
use nekko_machine::{bundled_feed, recommend};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn machine(
    platform: &str,
    ram_gib: f64,
    gpus: Vec<Gpu>,
    unified: bool,
    backends: &[&str],
    engine: Option<&str>,
) -> HardwareProfile {
    HardwareProfile {
        format: 1,
        probed_at: 0,
        platform: platform.into(),
        arch: if platform == "darwin" { "arm64" } else { "x64" }.into(),
        release: String::new(),
        cpu: Cpu { model: None, cores: 16 },
        ram_bytes: ram_gib * GIB,
        unified,
        gpus,
        backends: backends.iter().map(|b| b.to_string()).collect(),
        engine: engine.map(|b| EngineBuild { backend: b.into(), version: Some("b11224".into()) }),
        disk_free_bytes: None,
    }
}

fn gpu(name: &str, vram_gib: f64) -> Gpu {
    Gpu { name: name.into(), vram_bytes: vram_gib * GIB, cores: None }
}

fn apple(name: &str, ram_gib: f64, cores: u32) -> HardwareProfile {
    let g = Gpu { name: name.into(), vram_bytes: ram_gib * GIB, cores: Some(cores) };
    machine("darwin", ram_gib, vec![g], true, &["metal", "cpu"], Some("metal"))
}

fn rtx_5090() -> HardwareProfile {
    machine("win32", 64.0, vec![gpu("NVIDIA GeForce RTX 5090", 32.0)], false, &["cuda", "vulkan", "cpu"], Some("cuda"))
}

fn rtx_4060_vulkan() -> HardwareProfile {
    machine("win32", 32.0, vec![gpu("NVIDIA GeForce RTX 4060", 8.0)], false, &["cuda", "vulkan", "cpu"], Some("vulkan"))
}

fn rx_7900_xtx() -> HardwareProfile {
    machine("win32", 32.0, vec![gpu("AMD Radeon RX 7900 XTX", 24.0)], false, &["vulkan", "cpu"], Some("vulkan"))
}

fn cpu_only() -> HardwareProfile {
    machine("win32", 16.0, vec![], false, &["cpu"], None)
}

fn task<'a>(r: &'a Recommendations, id: &str) -> &'a TaskPick {
    r.tasks.iter().find(|t| t.task == id).unwrap_or_else(|| panic!("task {id}"))
}

/// Every task answered with something that fits, each speed-gated task fast
/// enough or flagged, and a speed shown wherever the hardware is known.
fn assert_complete(r: &Recommendations, name: &str) {
    for t in &r.tasks {
        let p = t.pick.as_ref().unwrap_or_else(|| panic!("{name}: no pick for {}", t.task));
        assert_ne!(p.fit, Fit::TooBig, "{name} {}", t.task);
        assert!(p.headroom_bytes >= 0.0, "{name} {}", t.task);
        assert!(p.download_bytes > 0.0 && !p.files.is_empty(), "{name} {}", t.task);
        if let Some(min) = t.min_tokens_per_second {
            let s = p.speed.as_ref().unwrap_or_else(|| panic!("{name}: no speed for {}", t.task));
            assert!(s.tokens_per_second >= min || t.below_target_speed, "{name} {}: {s:?}", t.task);
        } else {
            assert!(p.speed.is_none(), "{name} {}: decode speed is not what {} waits on", t.task, t.task);
        }
    }
}

#[test]
fn prints_the_picks_for_review() {
    for (name, p) in [
        ("RTX 5090 / CUDA", rtx_5090()),
        ("RTX 4060 8 GB / Vulkan", rtx_4060_vulkan()),
        ("RX 7900 XTX / Vulkan", rx_7900_xtx()),
        ("M2 16 GB", apple("Apple M2", 16.0, 10)),
        ("M5 Max 128 GB", apple("Apple M5 Max", 128.0, 40)),
        ("CPU only, 16 GB", cpu_only()),
    ] {
        let r = recommend(&p, bundled_feed());
        eprintln!(
            "\n{name}: {:?} budget {:.1} GiB ({:?})",
            r.hardware.class_id,
            r.budget.bytes / GIB,
            r.budget.placement
        );
        for t in &r.tasks {
            match &t.pick {
                Some(p) => eprintln!(
                    "  {:9} {:22} {:9} {:5.1} GiB  {:?}  {:?}{}",
                    t.task,
                    p.model_id,
                    p.quant,
                    p.memory_bytes / GIB,
                    p.fit,
                    p.speed.as_ref().map(|s| (s.tokens_per_second, s.basis)),
                    if t.below_target_speed { "  below target" } else { "" }
                ),
                None => eprintln!("  {:9} none", t.task),
            }
        }
    }
}

#[test]
fn windows_nvidia_runs_the_big_models_on_the_gpu() {
    let r = recommend(&rtx_5090(), bundled_feed());
    assert_complete(&r, "5090");
    assert_eq!(r.hardware.class_id.as_deref(), Some("nvidia-rtx-5090"));
    assert_eq!(r.hardware.backend, "cuda");
    assert_eq!(r.budget.placement, Placement::Gpu);
    assert_eq!(r.budget.bytes, 31.0 * GIB, "32 GB less the display's share");
    let feed = bundled_feed();
    for t in &r.tasks {
        let p = t.pick.as_ref().unwrap();
        assert_eq!(p.placement, Placement::Gpu, "{}", t.task);
        if let Some(s) = &p.speed {
            let moe = feed.models.iter().find(|m| m.id == p.model_id).unwrap().experts.is_some();
            // CUDA has its own dense calibration; its MoE figure is scaled by the ratio measured on Metal.
            let want = if moe { SpeedBasis::EstimatedBorrowed } else { SpeedBasis::Estimated };
            assert_eq!(s.basis, want, "{} {}", t.task, p.model_id);
        }
    }
}

#[test]
fn mixture_of_experts_models_get_their_own_efficiency() {
    let feed = bundled_feed();
    let speed = |r: &Recommendations, model: &str, quant: &str| {
        let o = r.tasks.iter().flat_map(|t| &t.options).find(|o| o.model_id == model && o.quant == quant);
        o.and_then(|o| o.speed.clone()).unwrap_or_else(|| panic!("{model} {quant}"))
    };
    // Metal's MoE efficiency is measured (Qwen3.6 35B A3B at 108 tok/s on a 40-core M5 Max,
    // where the dense efficiency would have promised 140); its Q8_0 is estimated with it.
    let m5 = recommend(&apple("Apple M5 Max", 128.0, 40), feed);
    let estimated = speed(&m5, "qwen3.6-35b-a3b", "Q8_0");
    let bpt = feed.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap().quants[0].bytes_per_token;
    assert_eq!((estimated.tokens_per_second, estimated.basis), ((0.46 * 614e9 / bpt).round(), SpeedBasis::Estimated));
    // CUDA borrows the MoE-to-dense ratio: 0.52 x 0.46 / 0.6.
    let cuda = recommend(&rtx_5090(), feed);
    let s = speed(&cuda, "gemma-4-26b-a4b", "UD-Q4_K_M");
    let g = feed.models.iter().find(|m| m.id == "gemma-4-26b-a4b").unwrap();
    let bpt = g.quants.iter().find(|q| q.label == "UD-Q4_K_M").unwrap().bytes_per_token;
    assert_eq!(
        (s.tokens_per_second, s.basis),
        ((0.52 * 0.46 / 0.6 * 1792e9 / bpt).round(), SpeedBasis::EstimatedBorrowed)
    );
}

#[test]
fn windows_amd_on_vulkan_says_its_speed_is_borrowed() {
    let r = recommend(&rx_7900_xtx(), bundled_feed());
    assert_complete(&r, "7900 XTX");
    assert_eq!(r.hardware.class_id.as_deref(), Some("amd-rx-7900-xtx"));
    assert_eq!(r.hardware.backend, "vulkan");
    let chat = task(&r, "chat").pick.as_ref().unwrap();
    assert_eq!(chat.speed.as_ref().unwrap().basis, SpeedBasis::EstimatedBorrowed);
}

#[test]
fn a_small_nvidia_card_on_the_default_vulkan_build_still_gets_a_set() {
    let r = recommend(&rtx_4060_vulkan(), bundled_feed());
    assert_complete(&r, "4060");
    for t in &r.tasks {
        assert!(t.pick.as_ref().unwrap().memory_bytes <= 7.0 * GIB * 0.9, "{}", t.task);
    }
}

#[test]
fn apple_silicon_budgets_the_gpu_share_of_unified_memory() {
    let small = recommend(&apple("Apple M2", 16.0, 10), bundled_feed());
    assert_complete(&small, "M2 16 GB");
    assert_eq!(small.budget.placement, Placement::Unified);
    assert_eq!(small.budget.bytes, (16.0 * GIB * 2.0 / 3.0).round(), "two thirds up to 36 GB");
    assert_eq!(small.hardware.class_id.as_deref(), Some("apple-m2"));

    let big = recommend(&apple("Apple M5 Max", 128.0, 40), bundled_feed());
    assert_complete(&big, "M5 Max");
    assert_eq!(big.budget.bytes, 96.0 * GIB, "three quarters above 36 GB");
    assert_eq!(big.hardware.class_id.as_deref(), Some("apple-m5-max-40"));
}

#[test]
fn a_measured_speed_is_used_as_is() {
    // Only the Q4_K_M build of Gemma 4 12B, which the feed measured on a 40-core M5 Max.
    let mut feed = bundled_feed().clone();
    for m in &mut feed.models {
        m.quants.retain(|q| q.label != "Q8_0");
    }
    let speed_of = |r: &Recommendations| {
        let o = task(r, "chat").options.iter().find(|o| o.model_id == "gemma-4-12b").unwrap();
        o.speed.clone().unwrap()
    };
    let s = speed_of(&recommend(&apple("Apple M5 Max", 128.0, 40), &feed));
    assert_eq!((s.tokens_per_second, s.basis), (61.8, SpeedBasis::Measured));
    // The same file on a 32-core M5 Max is another class: estimated, never the 40-core measurement.
    let r32 = recommend(&apple("Apple M5 Max", 128.0, 32), &feed);
    assert_eq!(r32.hardware.class_id.as_deref(), Some("apple-m5-max"));
    assert_eq!(speed_of(&r32).basis, SpeedBasis::Estimated);
}

#[test]
fn a_comfortable_smaller_quant_beats_a_bigger_one_at_the_edge() {
    let r = recommend(&apple("Apple M5 Max", 128.0, 40), bundled_feed());
    let code = task(&r, "code").pick.as_ref().unwrap();
    assert_eq!((code.model_id.as_str(), code.quant.as_str(), code.fit), ("qwen3-coder-next", "Q4_K_M", Fit::Fits));
}

#[test]
fn when_nothing_is_fast_enough_the_pick_is_the_fastest_that_fits() {
    let r = recommend(&cpu_only(), bundled_feed());
    let code = task(&r, "code");
    assert!(code.below_target_speed);
    let fastest = code
        .options
        .iter()
        .filter(|o| o.fit != Fit::TooBig)
        .map(|o| o.speed.as_ref().unwrap().tokens_per_second)
        .fold(0.0, f64::max);
    assert_eq!(code.pick.as_ref().unwrap().speed.as_ref().unwrap().tokens_per_second, fastest);
}

#[test]
fn cpu_only_runs_small_models_and_is_honest_about_speed() {
    let r = recommend(&cpu_only(), bundled_feed());
    assert_complete(&r, "CPU only");
    assert_eq!(r.budget.placement, Placement::Cpu);
    assert_eq!(r.budget.bytes, 12.0 * GIB, "16 GB less the OS and apps");
    assert_eq!(r.hardware.backend, "cpu");
    assert_eq!(task(&r, "chat").pick.as_ref().unwrap().speed.as_ref().unwrap().basis, SpeedBasis::EstimatedBorrowed);
}

#[test]
fn a_gpu_the_table_does_not_know_gets_no_speed_rather_than_a_guess() {
    let laptop = machine(
        "win32",
        32.0,
        vec![gpu("NVIDIA GeForce RTX 4070 Laptop GPU", 8.0)],
        false,
        &["cuda", "cpu"],
        Some("cuda"),
    );
    let r = recommend(&laptop, bundled_feed());
    assert_eq!(r.hardware.class_id, None, "a laptop part is not the desktop card");
    let chat = task(&r, "chat");
    assert!(chat.pick.is_some());
    assert!(chat.options.iter().all(|o| o.speed.is_none()));
}

#[test]
fn a_gpu_too_small_for_everything_falls_back_to_the_cpu() {
    let tiny = machine("win32", 32.0, vec![gpu("NVIDIA GeForce GTX 1650", 0.5)], false, &["cuda", "cpu"], Some("cuda"));
    let r = recommend(&tiny, bundled_feed());
    let chat = task(&r, "chat").pick.as_ref().unwrap();
    assert_eq!(chat.placement, Placement::Cpu);
}

#[test]
fn a_cpu_engine_build_ignores_the_gpu() {
    let p = machine("win32", 32.0, vec![gpu("NVIDIA GeForce RTX 5090", 32.0)], false, &["cuda", "cpu"], Some("cpu"));
    let r = recommend(&p, bundled_feed());
    assert_eq!(r.budget.placement, Placement::Cpu);
    assert_eq!(r.hardware.backend, "cpu");
}

#[test]
fn hardware_names_match_the_most_specific_row() {
    let feed = bundled_feed();
    let id =
        |name: &str, gib: f64, cores: Option<u32>| match_class(feed, name, gib * GIB, cores).map(|c| c.id.as_str());
    assert_eq!(id("NVIDIA GeForce RTX 4070 Ti SUPER", 16.0, None), Some("nvidia-rtx-4070-ti-super"));
    assert_eq!(id("NVIDIA GeForce RTX 4070 Ti", 12.0, None), Some("nvidia-rtx-4070-ti"));
    assert_eq!(id("NVIDIA GeForce RTX 4070", 12.0, None), Some("nvidia-rtx-4070"));
    assert_eq!(id("NVIDIA GeForce RTX 3060", 12.0, None), Some("nvidia-rtx-3060-12gb"));
    assert_eq!(id("NVIDIA GeForce RTX 3060", 8.0, None), Some("nvidia-rtx-3060"));
    assert_eq!(id("AMD Radeon RX 7900 XT", 20.0, None), Some("amd-rx-7900-xt"));
    assert_eq!(id("Intel(R) Arc(TM) B580 Graphics", 12.0, None), Some("intel-arc-b580"));
    assert_eq!(id("Apple M4 Max", 64.0, Some(32)), Some("apple-m4-max"));
    assert_eq!(id("Apple M4 Max", 64.0, Some(40)), Some("apple-m4-max-40"));
    assert_eq!(id("Apple M4 Pro", 48.0, Some(20)), Some("apple-m4-pro"));
    assert_eq!(id("Apple M4", 16.0, Some(10)), Some("apple-m4"));
    assert_eq!(id("NVIDIA GeForce RTX 4090 Laptop GPU", 16.0, None), None);
    assert_eq!(id("NVIDIA RTX PRO 6000 Blackwell", 96.0, None), None);
}

#[test]
fn the_kv_cache_matches_what_llama_cpp_allocates() {
    // llama-server b11429 at 32768 context, one slot, f16 (2026-10-22):
    // Gemma 4 12B holds 512 MiB on its 8 global layers and 1440 MiB on its 40
    // sliding-window layers (4608 cells: the four sequences llama-server runs
    // when the engine passes no --parallel); Qwen3.5 4B holds 1024 MiB on its 8
    // attention layers and none on its recurrent ones.
    let feed = bundled_feed();
    let kv = |id: &str| &feed.models.iter().find(|m| m.id == id).unwrap().kv;
    assert_eq!(kv_bytes(kv("gemma-4-12b"), 32768.0), (512.0 + 1440.0) * 1024.0 * 1024.0);
    assert_eq!(kv_bytes(kv("qwen3.5-4b"), 32768.0), 1024.0 * 1024.0 * 1024.0);
}

#[test]
fn every_candidate_is_in_the_feed() {
    let feed = bundled_feed();
    assert_eq!(feed.format, 1);
    for t in &feed.tasks {
        for c in &t.candidates {
            let m = feed.models.iter().find(|m| &m.id == c).unwrap_or_else(|| panic!("{} names {c}", t.id));
            assert!(!t.projector || m.projector.is_some(), "{c} for {} needs a projector", t.id);
        }
    }
}

#[test]
fn download_labels_are_the_catalogs() {
    use nekko_machine::recommend::download_label;
    assert_eq!(download_label("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"), "Q4_K_M");
    assert_eq!(download_label("gemma-4-12b-it-Q4_K_M.gguf"), "Q4_K_M");
    assert_eq!(download_label("Qwen3-Coder-Next-Q8_0-00001-of-00003.gguf"), "Q8_0");
    assert_eq!(download_label("gpt-oss-120b-MXFP4.gguf"), "MXFP4");
    assert_eq!(download_label("bge-small-en-v1.5-f16.gguf"), "F16");
    assert_eq!(download_label("Q8_0/big-Q8_0-00001-of-00003.gguf"), "Q8_0");
    assert_eq!(download_label("weird-name.gguf"), "weird-name");
    // Every pick in the feed downloads under a label the catalog gives it.
    for m in &bundled_feed().models {
        for q in &m.quants {
            let label = download_label(&q.files[0]);
            assert!(q.label.to_uppercase().ends_with(&label), "{} {} -> {label}", m.id, q.label);
        }
    }
}
