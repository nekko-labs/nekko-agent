//! Exact parity with core's capacity planner, over `golden/capacity.json`, a
//! frozen record of the deleted TS behaviour (edit it by hand per
//! docs/runbooks/golden-fixtures.md).

use nekko_engine::capacity::{
    AutoFitInput, FitRequest, Hardware, ModelFacts, PlanOptions, auto_fit, estimate_overhead_bytes, head_dim_of,
    kv_cache_bytes, plan_fit,
};
use nekko_engine::num;
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/capacity.json")).unwrap()
}

fn number(v: &Value) -> f64 {
    if v == "NaN" { f64::NAN } else { v.as_f64().unwrap() }
}

#[test]
fn plans_and_auto_fits_match() {
    let g = golden();
    let models: Vec<ModelFacts> = g["models"].as_array().unwrap().iter().map(ModelFacts::from_value).collect();
    let hardware: Vec<Hardware> = g["hardware"].as_array().unwrap().iter().map(Hardware::from_value).collect();
    let requests: Vec<FitRequest> = g["requests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let mut req = FitRequest::from_value(r);
            req.gpu_layer_fraction = number(&r["gpuLayerFraction"]);
            req
        })
        .collect();
    let by_id = |id: &str| models.iter().find(|m| m.id == id).unwrap();

    for (mi, m) in models.iter().enumerate() {
        for (ri, r) in requests.iter().enumerate() {
            let kv = kv_cache_bytes(m, r).map_or(Value::Null, num);
            assert_eq!(kv, g["kv"][mi][ri], "kv {} / {ri}", m.id);
            assert_eq!(num(estimate_overhead_bytes(m, r, None)), g["overhead"][mi][ri], "overhead {} / {ri}", m.id);
        }
    }
    for c in g["plans"].as_array().unwrap() {
        let (h, r) = (c["hw"].as_u64().unwrap() as usize, c["req"].as_u64().unwrap() as usize);
        let opts =
            PlanOptions { overhead_floor: (r == 2).then_some(900.0 * 1024.0 * 1024.0), siblings: models.clone() };
        let plan = plan_fit(by_id(c["model"].as_str().unwrap()), &requests[r], &hardware[h], &opts);
        assert_eq!(nekko_js::stringify(&plan.to_value()), c["plan"].as_str().unwrap(), "{} hw {h} req {r}", c["model"]);
    }
    for c in g["fits"].as_array().unwrap() {
        let h = c["hw"].as_u64().unwrap() as usize;
        let result = auto_fit(&AutoFitInput {
            facts: by_id(c["model"].as_str().unwrap()),
            hardware: &hardware[h],
            budget_fraction: number(&c["budgetFraction"]),
            parallel_slots: c["parallelSlots"].as_f64(),
            max_context_tokens: c["maxContextTokens"].as_f64(),
            options: PlanOptions { overhead_floor: Some(300.0 * 1024.0 * 1024.0), siblings: models.clone() },
            engine_kv: false,
        });
        assert_eq!(
            nekko_js::stringify(&result),
            c["result"].as_str().unwrap(),
            "{} hw {h} {}",
            c["model"],
            c["budgetFraction"]
        );
    }
}

#[test]
fn head_dims_match() {
    let g = golden();
    let cases = [
        (Some(4096.0), Some(32.0)),
        (Some(3584.0), Some(28.0)),
        (None, Some(8.0)),
        (Some(100.0), Some(0.0)),
        (Some(5120.0), Some(3.0)),
    ];
    let got: Vec<Value> = cases.iter().map(|(e, h)| head_dim_of(*e, *h).map_or(Value::Null, num)).collect();
    assert_eq!(json!(got), g["headDim"]);
}

/// Qwen3-8B at 32k as llama-server b12470 allocates its cache (#3325): 36
/// layers, 8 KV heads of 128. llama.cpp's q8_0 and q4_0 keep an f16 scale per
/// 32 values, so they take 34/32 and 18/32 bytes an element, not 1 and 0.5.
#[test]
fn the_kv_estimate_matches_what_llama_server_allocates() {
    let facts = ModelFacts { layers: Some(36.0), kv_heads: Some(8.0), head_dim: Some(128.0), ..ModelFacts::default() };
    let mib = |dtype: &str| {
        let req = FitRequest {
            context_tokens: 32768.0,
            parallel_slots: 1.0,
            kv_cache_dtype: dtype.into(),
            gpu_layer_fraction: 1.0,
        };
        kv_cache_bytes(&facts, &req).unwrap() / (1024.0 * 1024.0)
    };
    assert_eq!(mib("f16"), 4608.0);
    assert_eq!(mib("q8_0"), 2448.0);
    assert_eq!(mib("q4_0"), 1296.0);
}

/// `mlx_lm.server` runs without `--kv-bits`, so an MLX model's cache is f16
/// whatever the request says, and the planner never offers q8_0 for it.
#[test]
fn an_mlx_model_is_planned_with_the_f16_cache_it_gets() {
    let model = json!({ "id": "mlx-qwen", "format": "mlx", "weightsBytes": 4.0e9, "layers": 36, "kvHeads": 8, "headDim": 128, "maxContext": 40960 });
    let facts = ModelFacts::from_value(&model);
    assert!(facts.kv_f16_only);
    let req = |dtype: &str| FitRequest {
        context_tokens: 32768.0,
        parallel_slots: 1.0,
        kv_cache_dtype: dtype.into(),
        gpu_layer_fraction: 1.0,
    };
    assert_eq!(kv_cache_bytes(&facts, &req("q8_0")), kv_cache_bytes(&facts, &req("f16")));
    // A machine too small for the f16 cache: a GGUF model is offered q8_0,
    // the same model in MLX is not, since it would change nothing.
    let hw = Hardware { devices: Vec::new(), unified: true, ram_total: 9.0e9, ram_free: 7.0e9 };
    let opts = PlanOptions { overhead_floor: None, siblings: Vec::new() };
    let gguf = ModelFacts::from_value(
        &json!({ "id": "gguf-qwen", "weightsBytes": 4.0e9, "layers": 36, "kvHeads": 8, "headDim": 128, "maxContext": 40960 }),
    );
    assert!(!gguf.kv_f16_only);
    let offered =
        |f: &ModelFacts| nekko_js::stringify(&plan_fit(f, &req("f16"), &hw, &opts).to_value()).contains("q8_0");
    assert!(offered(&gguf), "the GGUF model is offered a q8_0 cache");
    assert!(!offered(&facts), "the MLX model is not");
}
