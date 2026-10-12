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
