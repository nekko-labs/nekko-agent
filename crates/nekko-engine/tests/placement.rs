//! Where a load's bytes land, and the setup the "Use recommended settings"
//! button picks. The headline case is the one people run by hand: a big
//! mixture-of-experts model with an n-gram table on an 8 GB card and 32 GB of
//! RAM, which only loads with the experts in RAM and the table left on the SSD.

use nekko_engine::capacity::{Device, Hardware, KvLayout, ModelFacts, WeightLayout};
use nekko_engine::launch::{Companions, build_args};
use nekko_engine::placement::{Goal, Request, RunOn, place, recommend as rec};

fn recommend(f: &ModelFacts, hw: &Hardware, resident: f64) -> Value {
    rec(f, hw, resident, Goal::Speed, None)
}
use serde_json::{Value, json};

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

fn machine(vram_gb: f64, vram_free_gb: f64, ram_gb: f64, ram_free_gb: f64) -> Hardware {
    Hardware {
        devices: vec![Device { name: "Test GPU".into(), total: vram_gb * GB, free: vram_free_gb * GB }],
        unified: false,
        ram_total: ram_gb * GB,
        ram_free: ram_free_gb * GB,
    }
}

/// 45 GB: a 3 GB core, 21 GB of experts and a 21 GB n-gram table; 12 of 48
/// layers keep a KV cache (2 KV heads x 256 x 2), as a hybrid-attention model does.
fn flash_next() -> ModelFacts {
    ModelFacts {
        id: "flash-next".into(),
        weights: Some(45.0 * GB),
        layers: Some(48.0),
        kv_heads: Some(2.0),
        head_dim: Some(256.0),
        max_context: Some(262144.0),
        kv_layout: Some(KvLayout { full_per_token: 12.0 * 2.0 * 2.0 * 256.0, ..KvLayout::default() }),
        weight_layout: Some(WeightLayout {
            expert_share: 21.0 / 45.0,
            ffn_share: 0.0,
            table_share: 21.0 / 45.0,
            experts: Some(512.0),
            experts_used: Some(10.0),
        }),
    }
}

/// A dense 8.4 GB model, 40 layers, 8 KV heads of 128.
fn dense_14b() -> ModelFacts {
    ModelFacts {
        id: "dense".into(),
        weights: Some(8.4 * GB),
        layers: Some(40.0),
        kv_heads: Some(8.0),
        head_dim: Some(128.0),
        max_context: Some(131072.0),
        kv_layout: Some(KvLayout { full_per_token: 40.0 * 2.0 * 8.0 * 128.0, ..KvLayout::default() }),
        weight_layout: Some(WeightLayout {
            expert_share: 0.0,
            ffn_share: 0.62,
            table_share: 0.0,
            experts: None,
            experts_used: None,
        }),
    }
}

fn n(v: &Value, path: &[&str]) -> f64 {
    path.iter().fold(v, |v, k| &v[*k]).as_f64().unwrap_or(f64::NAN)
}

#[test]
fn recommended_on_8_gb_keeps_experts_in_ram_and_the_table_on_disk() {
    let hw = machine(8.0, 7.5, 32.0, 24.5);
    let out = recommend(&flash_next(), &hw, 0.0);
    assert_eq!(out["request"]["runOn"], "hybrid", "{out}");
    assert!(n(&out, &["request", "contextTokens"]) >= 32768.0, "a useful context: {out}");
    assert!(n(&out, &["request", "cpuMoeLayers"]) > 0.0, "{out}");
    assert_eq!(n(&out, &["plan", "disk", "tableBytes"]), 21.0 * GB);
}

#[test]
fn fill_keeps_the_context_and_finds_the_lightest_split() {
    let hw = machine(8.0, 7.5, 32.0, 24.5);
    let base = Request { context_per_session: 65536.0, kv_cache_dtype: "q8_0".into(), ..Request::base(48.0) };
    let out = rec(&flash_next(), &hw, 0.0, Goal::Fill, Some(&base));
    assert_eq!(out["request"]["contextTokens"], 65536, "{out}");
    assert_eq!(out["request"]["kvCacheDtype"], "q8_0");
    let fewer = Request { cpu_moe_layers: n(&out, &["request", "cpuMoeLayers"]) - 1.0, run_on: RunOn::Hybrid, ..base };
    assert_eq!(place(&flash_next(), &fewer, &hw, 0.0).verdict, "wont-load", "one layer fewer in RAM does not fit");
}

#[test]
fn the_photo_setup_is_the_context_goal_on_8_gb() {
    let hw = machine(8.0, 7.5, 32.0, 24.5);
    let out = rec(&flash_next(), &hw, 0.0, Goal::Context, None);
    let req = &out["request"];
    assert_eq!(req["runOn"], "hybrid", "{out}");
    assert!(n(req, &["cpuMoeLayers"]) >= 40.0, "nearly every expert in RAM: {out}");
    assert_eq!(req["contextTokens"], 262144, "the full context: {out}");
    assert_eq!(req["kvCacheDtype"], "q8_0", "{out}");
    assert_eq!(req["sessions"], 1);
    let plan = &out["plan"];
    assert!(matches!(plan["verdict"].as_str(), Some("fits" | "tight")), "{plan}");
    assert_eq!(n(plan, &["disk", "tableBytes"]), 21.0 * GB, "the table stays on the SSD");
    let vram = n(plan, &["vram", "model", "weightsBytes"])
        + n(plan, &["vram", "model", "kvCacheBytes"])
        + n(plan, &["vram", "model", "overheadBytes"]);
    assert!(vram <= 7.5 * GB, "under the card's free memory: {vram}");
    let why = out["why"].as_array().unwrap();
    assert!(why.iter().any(|w| w["field"] == "Lookup table"), "{why:?}");
}

#[test]
fn with_mmap_off_the_table_has_to_fit_in_ram() {
    let hw = machine(8.0, 7.5, 32.0, 24.5);
    let req = Request {
        run_on: RunOn::Hybrid,
        context_per_session: 32768.0,
        cpu_moe_layers: 48.0,
        mmap: false,
        ..Request::base(48.0)
    };
    let plan = place(&flash_next(), &req, &hw, 0.0);
    assert_eq!(plan.verdict, "wont-load");
    assert_eq!(plan.reason, Some("ram"));
    assert_eq!(plan.disk_tables, 0.0);
}

#[test]
fn gpu_only_is_refused_when_the_core_and_experts_do_not_fit() {
    let plan = place(&flash_next(), &Request::base(48.0), &machine(8.0, 7.5, 32.0, 24.5), 0.0);
    assert_eq!((plan.verdict, plan.reason), ("wont-load", Some("vram")));
    assert!(plan.short_by > 15.0 * GB);
}

#[test]
fn experts_in_ram_move_bytes_but_layers_stay_on_the_gpu() {
    let hw = machine(24.0, 23.0, 64.0, 50.0);
    let f = flash_next();
    let some = place(&f, &Request { run_on: RunOn::Hybrid, cpu_moe_layers: 24.0, ..Request::base(48.0) }, &hw, 0.0);
    let all = place(&f, &Request { run_on: RunOn::Hybrid, cpu_moe_layers: 48.0, ..Request::base(48.0) }, &hw, 0.0);
    assert!(
        (some.vram.weights - (3.0 + 10.5) * GB).abs() < 1.0,
        "half the experts on the GPU: {}",
        some.vram.weights / GB
    );
    assert!((all.vram.weights - 3.0 * GB).abs() < 1.0, "only the core: {}", all.vram.weights / GB);
    assert!((all.ram.weights - 21.0 * GB).abs() < 1.0);
    assert_eq!(all.vram.kv, some.vram.kv, "the KV cache stays on the GPU either way");
}

#[test]
fn a_dense_model_that_fits_runs_gpu_only_with_two_sessions() {
    let out = recommend(&dense_14b(), &machine(24.0, 23.0, 64.0, 50.0), 0.0);
    assert_eq!(out["request"]["runOn"], "gpu", "{out}");
    assert!(n(&out, &["request", "sessions"]) >= 1.0);
    assert_eq!(out["plan"]["verdict"], "fits");
}

#[test]
fn a_dense_model_too_big_for_the_card_moves_feed_forward_first() {
    let out = recommend(&dense_14b(), &machine(8.0, 7.5, 32.0, 24.5), 0.0);
    assert_eq!(out["request"]["runOn"], "hybrid", "{out}");
    assert!(n(&out, &["request", "cpuFfnLayers"]) > 0.0, "{out}");
    assert_eq!(n(&out, &["request", "gpuLayers"]), 40.0, "every layer stays on the GPU: {out}");
}

#[test]
fn no_gpu_means_cpu_only() {
    let hw = Hardware { devices: vec![], unified: false, ram_total: 32.0 * GB, ram_free: 24.0 * GB };
    let out = recommend(&dense_14b(), &hw, 0.0);
    assert_eq!(out["request"]["runOn"], "cpu", "{out}");
    assert!(out["why"][0]["sentence"].as_str().unwrap().contains("no graphics card"));
}

#[test]
fn a_mac_puts_everything_in_one_pool() {
    let hw = Hardware {
        devices: vec![Device { name: "Apple M4".into(), total: 48.0 * GB, free: 40.0 * GB }],
        unified: true,
        ram_total: 64.0 * GB,
        ram_free: 50.0 * GB,
    };
    let plan = place(&flash_next(), &Request::base(48.0), &hw, 0.0);
    assert!(plan.unified);
    assert_eq!(plan.ram.weights, 0.0, "nothing counted twice");
    assert_eq!(plan.disk_tables, 21.0 * GB);
}

#[test]
fn a_reload_gets_its_own_vram_back() {
    let hw = machine(8.0, 1.0, 32.0, 24.5);
    let req = Request { context_per_session: 4096.0, ..Request::base(40.0) };
    let small = ModelFacts { weights: Some(5.0 * GB), ..dense_14b() };
    assert_eq!(place(&small, &req, &hw, 0.0).verdict, "wont-load");
    assert_ne!(place(&small, &req, &hw, 6.5 * GB).verdict, "wont-load");
}

#[test]
fn unknown_geometry_is_unknown_not_a_guess() {
    let facts = ModelFacts { weights: Some(GB), ..ModelFacts::default() };
    let out = recommend(&facts, &machine(8.0, 7.5, 32.0, 24.5), 0.0);
    assert_eq!(out["plan"]["verdict"], "unknown");
}

fn args(params: Value, help: &[&str]) -> Vec<String> {
    let model = json!({ "path": "/m.gguf", "id": "m", "layers": 48 });
    build_args(&model, "9000", &params, &Companions::default(), &|f| help.contains(&f), false)
}

fn has(args: &[String], pair: &[&str]) -> bool {
    args.windows(pair.len()).any(|w| w.iter().zip(pair).all(|(a, b)| a == b))
}

#[test]
fn experts_in_ram_launch_with_the_builds_own_flags() {
    let all = args(json!({ "gpuLayers": 48, "cpuMoeLayers": 48 }), &["--cpu-moe", "--n-cpu-moe", "--fit"]);
    assert!(all.contains(&"--cpu-moe".to_string()), "{all:?}");
    assert!(has(&all, &["--fit", "off"]), "our placement, not llama.cpp's: {all:?}");
    let some = args(json!({ "gpuLayers": 48, "cpuMoeLayers": 12 }), &["--cpu-moe", "--n-cpu-moe"]);
    assert!(has(&some, &["--n-cpu-moe", "12"]), "{some:?}");
    assert!(!some.contains(&"--fit".to_string()), "no --fit on a build without it");
}

#[test]
fn an_older_build_gets_override_tensor_patterns() {
    let all = args(json!({ "cpuMoeLayers": 48 }), &[]);
    assert!(has(&all, &["--override-tensor", r"\.ffn_(up|down|gate|gate_up)_(ch|)exps\.=CPU"]), "{all:?}");
    let some = args(json!({ "cpuMoeLayers": 3 }), &[]);
    assert!(
        has(&some, &["--override-tensor", r"blk\.(0|1|2)\.ffn_(up|down|gate|gate_up)_(ch|)exps\.=CPU"]),
        "{some:?}"
    );
    let ffn = args(json!({ "cpuFfnLayers": 2 }), &[]);
    assert!(has(&ffn, &["--override-tensor", r"blk\.(0|1)\.ffn_(up|down|gate|gate_up)\.=CPU"]), "{ffn:?}");
}

#[test]
fn sessions_share_one_pool_capped_per_session() {
    let a = args(json!({ "contextTokens": 131072, "parallelSlots": 2 }), &["--kv-unified", "--kv-unified-per-slot"]);
    assert!(has(&a, &["--parallel", "2"]) && a.contains(&"--kv-unified".to_string()), "{a:?}");
    assert!(has(&a, &["--kv-unified-per-slot", "65536"]), "{a:?}");
}

#[test]
fn context_in_ram_tables_and_expert_cache_flags() {
    let a = args(
        json!({ "kvOnGpu": false, "lazyTables": true, "moeCacheMiB": 2048, "threadsBatch": 8 }),
        &["--lazy-mode", "--moe-cache-mib", "--fit"],
    );
    assert!(a.contains(&"--no-kv-offload".to_string()), "{a:?}");
    assert!(has(&a, &["--lazy-mode", "on"]) && has(&a, &["--moe-cache-mib", "2048"]), "{a:?}");
    assert!(has(&a, &["--threads-batch", "8"]) && has(&a, &["--fit", "off"]), "{a:?}");
    let old = args(json!({ "moeCacheMiB": 2048, "lazyTables": true }), &[]);
    assert!(
        !old.iter().any(|x| x == "--moe-cache-mib" || x == "--lazy-mode"),
        "unsupported flags are left out: {old:?}"
    );
}

/// Writes the load drawer fixture's planner answers (`apps/desktop/scripts/
/// model-tuning-fixture.json`): `NEKKO_DUMP_FIXTURE=<path> cargo test -p
/// nekko-engine --test placement dump_fixture -- --ignored`.
#[test]
#[ignore]
fn dump_fixture() {
    use nekko_engine::capacity::{AutoFitInput, FitRequest, PlanOptions, auto_fit, plan_fit};
    let path = std::env::var("NEKKO_DUMP_FIXTURE").expect("NEKKO_DUMP_FIXTURE");
    let scenarios = [("moe8", flash_next(), machine(8.0, 7.5, 32.0, 24.5)), ("dense24", dense_14b(), machine(24.0, 23.0, 64.0, 50.0)), ("dense8", dense_14b(), machine(8.0, 7.5, 32.0, 24.5))];
    let mut out = serde_json::Map::new();
    for (name, facts, hw) in scenarios {
        let opts = PlanOptions::default();
        let auto = auto_fit(&AutoFitInput { facts: &facts, hardware: &hw, budget_fraction: 0.75, parallel_slots: None, max_context_tokens: None, options: PlanOptions::default() });
        let speed = rec(&facts, &hw, 0.0, Goal::Speed, None);
        let context = rec(&facts, &hw, 0.0, Goal::Context, None);
        let layers = facts.layers.unwrap();
        let check = place(&facts, &Request::from_value(&speed["request"], layers), &hw, 0.0).to_value();
        out.insert(
            name.into(),
            json!({
                "hardware": { "devices": hw.devices.iter().map(|d| json!({ "name": d.name, "totalBytes": d.total, "freeBytes": d.free })).collect::<Vec<_>>(), "unified": hw.unified, "ramTotalBytes": hw.ram_total, "ramFreeBytes": hw.ram_free },
                "facts": { "weightsBytes": facts.weights, "layers": layers, "headDim": facts.head_dim, "kvPerToken": facts.kv_layout.unwrap().full_per_token, "maxContext": facts.max_context, "weightLayout": facts.weight_layout.unwrap().to_value() },
                "autoFit": auto,
                "planFit": plan_fit(&facts, &FitRequest { context_tokens: 32768.0, ..FitRequest::default() }, &hw, &opts).to_value(),
                "speed": speed,
                "context": context,
                "speedPlace": check,
            }),
        );
    }
    std::fs::write(path, serde_json::to_string_pretty(&Value::Object(out)).unwrap() + "\n").unwrap();
}
