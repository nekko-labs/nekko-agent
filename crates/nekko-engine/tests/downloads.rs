//! Replays the frozen TS downloads golden set (`golden/downloads.json`): the
//! queue over the same scripted server leaves the same jobs, requests and
//! files, and the plans fetch the same things, text for text.

use futures_util::StreamExt;
use nekko_engine::BoxFuture;
use nekko_engine::acquire;
use nekko_engine::capacity::Hardware;
use nekko_engine::download::{Downloads, Fetch, Reply, Request};
use nekko_engine::folders::companions_dir;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/downloads.json")).unwrap()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekko-dl-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn norm(root: &str, v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(root, "<root>").replace('\\', "/")),
        Value::Array(a) => Value::Array(a.iter().map(|x| norm(root, x)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), norm(root, x))).collect()),
        other => other.clone(),
    }
}

fn denorm(root: &str, v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("<root>", root)),
        Value::Array(a) => Value::Array(a.iter().map(|x| denorm(root, x)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), denorm(root, x))).collect()),
        other => other.clone(),
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The TS test's scripted fetch.
struct Script {
    replies: Map<String, Value>,
    requests: Mutex<Vec<Value>>,
}

impl Fetch for Script {
    fn get(&self, url: String, headers: Vec<(String, String)>) -> BoxFuture<Result<Reply, String>> {
        let h: Map<String, Value> = headers.into_iter().map(|(k, v)| (k, json!(v))).collect();
        self.requests.lock().unwrap().push(json!({ "url": url, "headers": h }));
        let reply = self.replies.get(&url).cloned();
        Box::pin(async move {
            let Some(reply) = reply else {
                return Ok(Reply {
                    status: 404,
                    content_length: None,
                    body: Some(futures_util::stream::empty().boxed()),
                });
            };
            if reply == "throw" {
                return Err("fetch failed".into());
            }
            let chunks: Vec<Vec<u8>> = match reply.get("hex") {
                Some(h) => vec![hex(h.as_str().unwrap())],
                None => reply["chunks"]
                    .as_array()
                    .map(|c| c.iter().map(|x| x.as_str().unwrap().as_bytes().to_vec()).collect())
                    .unwrap_or_default(),
            };
            // A stream that errors from its start drops what it had queued.
            let body = match reply.get("error").and_then(Value::as_str) {
                Some(e) => futures_util::stream::iter(vec![Err(e.to_string())]).boxed(),
                None => {
                    let items = futures_util::stream::iter(chunks.into_iter().map(Ok));
                    if reply.get("hang") == Some(&Value::Bool(true)) {
                        items.chain(futures_util::stream::pending()).boxed()
                    } else {
                        items.boxed()
                    }
                }
            };
            Ok(Reply {
                status: reply["status"].as_u64().unwrap() as u16,
                content_length: reply.get("length").and_then(Value::as_str).map(str::to_string),
                body: Some(body),
            })
        })
    }
}

async fn wait_for(downloads: &Downloads, id: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(j) = downloads.list().into_iter().find(|j| j["id"] == id).filter(|j| done(j)) {
            return j;
        }
        assert!(std::time::Instant::now() < deadline, "{id} timed out: {:?}", downloads.list());
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_the_queue_as_the_host_does() {
    let g = golden();
    let now = g["now"].as_f64().unwrap();
    for case in g["queue"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = scratch(&format!("q-{}", name.replace(' ', "-")));
        let root = dir.to_string_lossy().into_owned();
        for (rel, text) in case.get("pre").and_then(Value::as_object).cloned().unwrap_or_default() {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text.as_str().unwrap()).unwrap();
        }
        let script =
            Arc::new(Script { replies: case["replies"].as_object().unwrap().clone(), requests: Mutex::default() });
        let downloads = Downloads::new(script.clone(), Arc::new(move || now), |_| {});
        let mut outs = Vec::new();
        for op in case["ops"].as_array().unwrap() {
            let id = op.get("id").and_then(Value::as_str).unwrap_or_default();
            let out = match op["op"].as_str().unwrap() {
                "start" => {
                    let raw = denorm(&root, &op["req"]);
                    let mut req = Request::from_value(&raw);
                    req.verify =
                        (raw.get("verifyGguf") == Some(&Value::Bool(true))).then(nekko_engine::download::gguf_verify);
                    downloads.start(req)
                }
                "settle" => {
                    wait_for(&downloads, id, |j| matches!(j["state"].as_str(), Some("done" | "failed" | "cancelled")))
                        .await
                }
                "receiving" => {
                    let bytes = op["bytes"].as_f64().unwrap();
                    wait_for(&downloads, id, |j| j["receivedBytes"].as_f64().unwrap() >= bytes).await
                }
                "cancel" => {
                    downloads.cancel(id);
                    Value::Null
                }
                "dismiss" => {
                    downloads.dismiss(id);
                    Value::Null
                }
                "list" => json!(downloads.list()),
                other => panic!("op {other}"),
            };
            outs.push(nekko_js::stringify(&norm(&root, &out)));
        }
        let want: Vec<&str> = case["outs"].as_array().unwrap().iter().map(|o| o.as_str().unwrap()).collect();
        assert_eq!(outs, want, "{name}");
        let requests = std::mem::take(&mut *script.requests.lock().unwrap());
        assert_eq!(norm(&root, &json!(requests)), case["requests"], "requests of {name}");
        for (p, want) in case["files"].as_object().unwrap() {
            let real = denorm(&root, &json!(p));
            let got = std::fs::read(real.as_str().unwrap()).ok().map(|b| to_hex(&b));
            assert_eq!(json!(got), *want, "{p} after {name}");
        }
        std::fs::remove_dir_all(dir).ok();
    }
}

#[test]
fn plans_downloads_as_the_host_does() {
    let g = golden();
    let dir = scratch("plans");
    let root = dir.to_string_lossy().into_owned();
    let models = dir.join("models").to_string_lossy().into_owned();
    let landed = |set: &[&str]| {
        let set: Vec<String> = set.iter().map(|s| s.to_string()).collect();
        let root = root.clone();
        move |p: &str| set.contains(&norm(&root, &json!(p)).as_str().unwrap().to_string())
    };

    let first = landed(&["<root>/models/chat/unsloth_Qwen3-4B-GGUF/tokenizer.json"]);
    for case in g["downloadPlans"].as_array().unwrap() {
        let out = acquire::model_download_plan(
            &case["model"],
            case["id"].as_str().unwrap(),
            case["quant"].as_str().unwrap(),
            &models,
            &first,
        );
        assert_eq!(
            nekko_js::stringify(&norm(&root, &out)),
            case["out"].as_str().unwrap(),
            "{} {}",
            case["id"],
            case["quant"]
        );
    }

    for case in g["sourceRepos"].as_array().unwrap() {
        let got = acquire::source_repo_for(&denorm(&root, &case["model"]));
        assert_eq!(json!(got), case["out"], "{}", case["model"]);
    }

    let key = companions_dir(&models, "lmstudio/pub/repo/model");
    let third =
        norm(&root, &json!(Path::new(&key).join("config.json").to_string_lossy())).as_str().unwrap().to_string();
    let second = landed(&[
        "<root>/models/chat/unsloth_Qwen3-4B-GGUF/tokenizer.json",
        "<root>/lmstudio/pub/repo/mmproj-F16.gguf",
        &third,
    ]);
    for case in g["companions"].as_array().unwrap() {
        let model = denorm(&root, &case["model"]);
        let out = acquire::companions_plan(&model, case["repo"].as_str().unwrap(), &case["found"], &models, &second);
        assert_eq!(nekko_js::stringify(&norm(&root, &out)), case["out"].as_str().unwrap(), "{}", case["model"]);
    }

    for (rel, content) in g["imageFiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f, "x"))
        .chain(g["imageEmpty"].as_array().unwrap().iter().map(|f| (f, "")))
    {
        let p = dir.join(rel.as_str().unwrap());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let image_dir = acquire::image_companions_dir(&models);
    for case in g["images"].as_array().unwrap() {
        let model = denorm(&root, &case["model"]);
        let set = acquire::image_companion_set_for(&model).unwrap_or(Value::Null);
        assert_eq!(nekko_js::stringify(&set), case["set"].as_str().unwrap(), "set of {}", case["model"]["id"]);
        let id = model["id"].as_str().unwrap();
        let beside = acquire::companions_beside(&model, &[companions_dir(&models, id)]);
        assert_eq!(
            nekko_js::stringify(&norm(&root, &Value::Object(beside.clone()))),
            case["beside"].as_str().unwrap(),
            "beside {id}"
        );
        for s in case["statuses"].as_array().unwrap() {
            let token = s["token"].as_str();
            let status = acquire::image_companion_status(&model, &image_dir, &beside, token.is_some());
            assert_eq!(
                nekko_js::stringify(&norm(&root, &status)),
                s["status"].as_str().unwrap(),
                "status of {id} {token:?}"
            );
            let plan = acquire::image_companions_plan(&model, &status, token, &models);
            assert_eq!(nekko_js::stringify(&norm(&root, &plan)), s["plan"].as_str().unwrap(), "plan of {id} {token:?}");
        }
    }

    let mut seen = std::collections::HashMap::new();
    for case in g["finished"].as_array().unwrap() {
        let got: Vec<Value> = acquire::finished_model_jobs(case["jobs"].as_array().unwrap(), &mut seen)
            .into_iter()
            .map(|j| j["id"].clone())
            .collect();
        assert_eq!(json!(got), case["out"], "{}", case["jobs"]);
    }

    let list = vec![
        json!({ "id": "gguf", "path": Path::new(&models).join("chat/o_r/m.gguf").to_string_lossy() }),
        json!({ "id": "mlx", "path": Path::new(&models).join("mlx/o_r").to_string_lossy(), "format": "mlx" }),
    ];
    for case in g["downloaded"].as_array().unwrap() {
        let job = json!({ "dest": denorm(&root, &case["dest"]) });
        let got = acquire::downloaded_model(&list, &job).map(|m| m["id"].clone()).unwrap_or(Value::Null);
        assert_eq!(got, case["out"], "{}", case["dest"]);
    }

    for case in g["presets"].as_array().unwrap() {
        let hw = (!case["hw"].is_null()).then(|| Hardware::from_value(&case["hw"]));
        let got = acquire::gpu_first_preset(&case["model"], hw.as_ref(), case["floor"].as_f64().unwrap());
        assert_eq!(
            nekko_js::stringify(&got.unwrap_or(Value::Null)),
            case["out"].as_str().unwrap(),
            "{}",
            case["model"]
        );
    }
    std::fs::remove_dir_all(dir).ok();
}
