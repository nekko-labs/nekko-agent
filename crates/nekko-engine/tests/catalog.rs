//! Replays the TS catalog's golden set: the same Hugging Face answers give the
//! same models, text for text, and the same requests.

use nekko_engine::BoxFuture;
use nekko_engine::catalog::{Catalog, Fetch, Reply, hf_file_url, strip_front_matter};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};

struct Script {
    hf: Map<String, Value>,
    requests: Mutex<Vec<Value>>,
}

impl Fetch for Script {
    fn get(&self, url: String, headers: Vec<(&'static str, String)>) -> BoxFuture<Result<Reply, String>> {
        let h: Map<String, Value> = headers.into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
        self.requests.lock().unwrap().push(json!({ "url": url, "headers": h }));
        let reply = match self.hf.get(&url) {
            Some(Value::String(s)) if s == "throw" => Err("fetch failed".to_string()),
            Some(r) => Ok(Reply {
                status: r["status"].as_u64().unwrap() as u16,
                body: r["body"].as_str().unwrap().to_string(),
            }),
            None => Ok(Reply { status: 404, body: "Not found".into() }),
        };
        Box::pin(async move { reply })
    }
}

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/catalog.json")).unwrap()
}

#[tokio::test]
async fn replays_the_host_catalog() {
    let g = golden();
    for step in g["steps"].as_array().unwrap() {
        let script = Arc::new(Script { hf: g["hf"].as_object().unwrap().clone(), requests: Mutex::default() });
        let token = step["token"].as_str().map(str::to_string);
        let mlx = step["mlx"].as_bool().unwrap();
        let catalog = Catalog::new(script.clone(), Box::new(move || token.clone()), Box::new(move || mlx));
        let args = step["args"].as_array().unwrap();
        let arg = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
        let out = match step["op"].as_str().unwrap() {
            "curated" => json!(catalog.curated().await),
            "search" => {
                let limit = args.get(1).and_then(Value::as_u64).unwrap_or(20) as usize;
                json!(catalog.search(&arg(0), limit, args.get(2) == Some(&json!("mlx"))).await)
            }
            "model" => catalog.model(&arg(0)).await,
            "detail" => catalog.detail(&arg(0)).await,
            "companions" => catalog.companions(&arg(0)).await,
            other => panic!("unknown op {other}"),
        };
        let mut requests = std::mem::take(&mut *script.requests.lock().unwrap());
        requests.sort_by(|a, b| nekko_usage::locale_compare(&nekko_js::stringify(a), &nekko_js::stringify(b)));
        assert_eq!(nekko_js::stringify(&out), step["out"].as_str().unwrap(), "{} {}", step["op"], step["args"]);
        assert_eq!(json!(requests), step["requests"], "requests for {} {}", step["op"], step["args"]);
    }
}

#[test]
fn front_matter_and_file_urls_match() {
    let g = golden();
    for c in g["frontMatter"].as_array().unwrap() {
        assert_eq!(strip_front_matter(c["input"].as_str().unwrap()), c["out"].as_str().unwrap(), "{c}");
    }
    for c in g["fileUrls"].as_array().unwrap() {
        assert_eq!(hf_file_url(c["repo"].as_str().unwrap(), c["file"].as_str().unwrap()), c["url"].as_str().unwrap());
    }
}

#[test]
fn quant_labels_keep_ordinary_names_and_learn_the_ternary_ones() {
    use nekko_engine::catalog::quant_label;
    // Unchanged: what the label was before PTQ/PQ/TQ were read as quants.
    for (file, label) in [
        ("Qwen3-4B-Q4_K_M.gguf", "Q4_K_M"),
        ("Qwen3-4B-UD-Q4_K_XL.gguf", "Q4_K_XL"),
        ("Qwen3-4B-IQ4_XS.gguf", "IQ4_XS"),
        ("Q8_0/big-Q8_0.gguf", "Q8_0"),
        ("bge-small-en-v1.5-q8_0.gguf", "Q8_0"),
        ("bge-small-en-v1.5-f16.gguf", "F16"),
        ("Qwen3-4B-BF16.gguf", "BF16"),
        ("f32/model-f32.gguf", "F32"),
        ("gpt-oss-20b-MXFP4.gguf", "MXFP4"),
        ("Qwen2.5-7B-Instruct.Q5_K_S.gguf", "Q5_K_S"),
        ("weird-name.gguf", "weird-name"),
        ("UPPER.GGUF", "UPPER"),
        ("Qwen-Q.gguf", "Qwen-Q"),
        ("Model-TQV2.gguf", "Model-TQV2"),
        ("Qwen3-4B.gguf", "Qwen3-4B"),
        ("mmproj-F16.gguf", "F16"),
    ] {
        assert_eq!(quant_label(file), label, "{file}");
    }
    // New: the ternary quants, which used to take the whole base name.
    for (file, label) in [
        ("Ternary-Bonsai-2-27B-PTQ1_0.gguf", "PTQ1_0"),
        ("Ternary-Bonsai-2-27B-PQ2_0.gguf", "PQ2_0"),
        ("Ternary-Bonsai-2-27B-Q2_0.gguf", "Q2_0"),
        ("Falcon3-1B-TQ1_0.gguf", "TQ1_0"),
        ("Falcon3-1B.TQ2_0.gguf", "TQ2_0"),
    ] {
        assert_eq!(quant_label(file), label, "{file}");
    }
}

#[test]
fn only_the_quants_stock_llama_cpp_knows_are_marked_stock() {
    use nekko_engine::gguf::is_stock_quant;
    for label in ["Q4_K_M", "q4_k_m", "Q8_0", "Q2_0", "F16", "BF16", "F32", "IQ4_XS", "IQ1_S", "TQ1_0", "MXFP4", "Q2_K"]
    {
        assert!(is_stock_quant(label), "{label}");
    }
    for label in ["PTQ1_0", "PQ2_0", "Q4_K_XL", "UPPER", "weird-name", "", "Ternary-Bonsai-2-27B", "mxfp4_moe", "Q9_9"]
    {
        assert!(!is_stock_quant(label), "{label}");
    }
}

/// The real repo's file list (names and sizes as Hugging Face reports them), through the catalog's own reader.
#[tokio::test]
async fn the_bonsai_repo_marks_q2_0_stock_and_the_ternary_builds_not() {
    let id = "prism-ml/Ternary-Bonsai-2-27B-gguf";
    let files = [
        ("Ternary-Bonsai-2-27B-F16.gguf", 53.8e9),
        ("Ternary-Bonsai-2-27B-PQ2_0.gguf", 7.21e9),
        ("Ternary-Bonsai-2-27B-PTQ1_0.gguf", 5.95e9),
        ("Ternary-Bonsai-2-27B-Q2_0.gguf", 7.63e9),
        ("Ternary-Bonsai-2-27B-mmproj-BF16.gguf", 0.931e9),
        ("Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf", 0.629e9),
    ];
    let tree: Vec<Value> = files.iter().map(|(p, s)| json!({ "type": "file", "path": p, "size": s })).collect();
    let mut hf = Map::new();
    hf.insert(
        format!("{}/models/{id}/tree/main?recursive=true", nekko_engine::catalog::HF_API),
        json!({ "status": 200, "body": json!(tree).to_string() }),
    );
    hf.insert(
        format!("{}/models/{id}", nekko_engine::catalog::HF_API),
        json!({ "status": 200, "body": json!({ "tags": ["gguf"] }).to_string() }),
    );
    let script = Arc::new(Script { hf, requests: Mutex::default() });
    let catalog = Catalog::new(script, Box::new(|| None), Box::new(|| false));
    let model = nekko_engine::catalog::with_stock(catalog.model(id).await);
    let quants: Vec<(&str, &str, bool)> = model["quants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| (q["label"].as_str().unwrap(), q["file"].as_str().unwrap(), q["stock"].as_bool().unwrap()))
        .collect();
    let stock = |label: &str| quants.iter().find(|q| q.0 == label).unwrap_or_else(|| panic!("{label} in {quants:?}")).2;
    assert!(stock("Q2_0") && stock("F16"));
    assert!(!stock("PTQ1_0") && !stock("PQ2_0"));
    // The row's own file is one of the repo's, by name.
    assert!(quants.iter().any(|q| q.1 == "Ternary-Bonsai-2-27B-PTQ1_0.gguf"));
    // The projector rides with each build rather than being a build.
    let q2 = model["quants"].as_array().unwrap().iter().find(|q| q["label"] == "Q2_0").unwrap();
    assert_eq!(q2["extraFiles"], json!(["Ternary-Bonsai-2-27B-mmproj-BF16.gguf"]));
    // A model that is not there, and an MLX folder, are not marked as GGUF quants.
    assert_eq!(nekko_engine::catalog::with_stock(Value::Null), Value::Null);
    let mlx = nekko_engine::catalog::with_stock(json!({ "quants": [{ "label": "4bit", "format": "mlx" }] }));
    assert_eq!(mlx["quants"][0]["stock"], false);
}

#[tokio::test]
async fn a_model_is_cached() {
    let g = golden();
    let script = Arc::new(Script { hf: g["hf"].as_object().unwrap().clone(), requests: Mutex::default() });
    let catalog = Catalog::new(script.clone(), Box::new(|| None), Box::new(|| false));
    let first = catalog.model("unsloth/Qwen3-4B-GGUF").await;
    let n = script.requests.lock().unwrap().len();
    assert_eq!(catalog.model("unsloth/Qwen3-4B-GGUF").await, first);
    assert_eq!(script.requests.lock().unwrap().len(), n, "the second read is the cache's");
}

/// A repo that publishes several releases of one model, each in the same
/// quantizations (`nokeepai/Inkling-2-Mini-Unbound-GGUF`): every build gets its
/// own label, so asking for one never fetches another, and LoRA adapters are
/// not offered as models.
#[tokio::test]
async fn releases_in_one_repo_stay_apart() {
    let id = "nokeepai/Inkling-2-Mini-Unbound-GGUF";
    let file = |path: &str, size: u64| json!({ "type": "file", "path": path, "size": size });
    let tree = json!([
        file("Inkling-2-Mini-Unbound-BF16.gguf", 52_226_509_504),
        file("Inkling-2-Mini-Unbound-LoRA-r16.gguf", 6_884_416),
        file("Inkling-2-Mini-Unbound-Q4_K_M.gguf", 17_563_029_024),
        file("Inkling-2-Mini-Unbound-Q8_0.gguf", 27_820_099_264),
        file("Inkling-2-Mini-Unbound-v2-LoRA-r64.gguf", 140_001_536),
        file("Inkling-2-Mini-Unbound-v2-Q4_K_M.gguf", 17_782_517_280),
        file("Inkling-2-Mini-Unbound-v2-Q8_0.gguf", 27_820_099_264),
        file("Inkling-2-Mini-Unbound-v2.1-Q4_K_M.gguf", 17_782_517_280),
        file("Inkling-2-Mini-Unbound-v2.1-Q8_0.gguf", 27_820_099_264),
        file("mmproj-Inkling-2-Mini-BF16.gguf", 641_805_984),
    ]);
    let mut hf = Map::new();
    hf.insert(
        format!("https://huggingface.co/api/models/{id}/tree/main?recursive=true"),
        json!({ "status": 200, "body": tree.to_string() }),
    );
    let script = Arc::new(Script { hf, requests: Mutex::default() });
    let catalog = Catalog::new(script, Box::new(|| None), Box::new(|| false));
    let quants = catalog.quants_for(id, None, false).await;
    let row = |q: &Value| {
        format!(
            "{} | {} | {} | {}",
            q["label"].as_str().unwrap(),
            q["variant"].as_str().unwrap_or("-"),
            q["quant"].as_str().unwrap_or("-"),
            q["file"].as_str().unwrap()
        )
    };
    let rows: Vec<String> = quants.iter().map(row).collect();
    assert_eq!(
        rows,
        [
            "v2.1 Q4_K_M | v2.1 | Q4_K_M | Inkling-2-Mini-Unbound-v2.1-Q4_K_M.gguf",
            "v2.1 Q8_0 | v2.1 | Q8_0 | Inkling-2-Mini-Unbound-v2.1-Q8_0.gguf",
            "v2 Q4_K_M | v2 | Q4_K_M | Inkling-2-Mini-Unbound-v2-Q4_K_M.gguf",
            "v2 Q8_0 | v2 | Q8_0 | Inkling-2-Mini-Unbound-v2-Q8_0.gguf",
            "Q4_K_M | - | - | Inkling-2-Mini-Unbound-Q4_K_M.gguf",
            "Q8_0 | - | - | Inkling-2-Mini-Unbound-Q8_0.gguf",
            "BF16 | - | - | Inkling-2-Mini-Unbound-BF16.gguf",
        ]
    );
    assert_eq!(quants[1]["note"], "Effectively full quality. Large.", "the note follows the quantization");
    assert!(quants.iter().all(|q| q["extraFiles"][0] == "mmproj-Inkling-2-Mini-BF16.gguf"));
}
