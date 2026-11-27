//! Replays the frozen TS model-server golden set (`golden/server.json`): the
//! same command lines, companion files, load-failure sentences and image
//! requests, and the same policy over the same scripted daemon: what loads,
//! what is evicted and when, what the router hears and what status reads.

use nekko_engine::BoxFuture;
use nekko_engine::launch::{self, Companions};
use nekko_engine::load_check::EngineInUse;
use nekko_engine::server::{Daemon, Engine, Env, ModelServer};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/server.json")).unwrap()
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

fn scratch(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("local-model-server-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

fn write_files(root: &str, files: &Value) {
    for (rel, text) in files.as_object().unwrap() {
        let p = Path::new(root).join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text.as_str().unwrap()).unwrap();
    }
}

fn join(parts: &[&str]) -> String {
    nekko_tools::path::native::join(parts)
}

fn companions_of(v: Option<&Value>) -> Companions {
    let s = |k: &str| v.and_then(|v| v.get(k)).and_then(Value::as_str).map(str::to_string);
    Companions {
        mmproj: s("mmproj"),
        chat_template_file: s("chatTemplateFile"),
        draft_model: s("draftModel"),
        draft_arch: None,
    }
}

#[test]
fn launches_models_as_the_host_does() {
    let g = golden();
    let root = scratch("pure");
    write_files(&root, &g["files"]);
    for c in g["args"].as_array().unwrap() {
        let flags: HashSet<String> = g["flagSets"][c["flags"].as_str().unwrap()]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap().to_string())
            .collect();
        let model = denorm(&root, &c["model"]);
        let companions = companions_of(Some(&denorm(&root, c.get("companions").unwrap_or(&Value::Null))));
        let caching = c.get("caching").and_then(Value::as_bool).unwrap_or(true);
        let out = launch::build_args(&model, "{port}", &c["params"], &companions, &|f| flags.contains(f), caching);
        assert_eq!(norm(&root, &json!(out)), c["out"], "{c}");
    }
    for c in g["explained"].as_array().unwrap() {
        let log: Vec<String> = c["log"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_string()).collect();
        assert_eq!(launch::explain_load_error(&log), c["out"].as_str().unwrap(), "{c}");
    }
    let asked: Vec<&str> = g["asked"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    for c in g["help"].as_array().unwrap() {
        let known = launch::known_flags(c["text"].as_str().unwrap());
        let out: Vec<bool> = asked.iter().map(|f| known.contains(*f)).collect();
        assert_eq!(json!(out), c["out"], "{c}");
    }
    for c in g["unsupported"].as_array().unwrap() {
        assert_eq!(json!(launch::unsupported_load_reason(&c["model"])), c["out"], "{c}");
    }
    for c in g["dll"].as_array().unwrap() {
        assert_eq!(json!(launch::is_missing_dll_exit(c["message"].as_str())), c["out"], "{c}");
    }
    assert_eq!(launch::missing_dll_message("The model server"), g["dllMessages"][0].as_str().unwrap());
    assert_eq!(launch::missing_dll_message("The image server"), g["dllMessages"][1].as_str().unwrap());
    for c in g["images"].as_array().unwrap() {
        let out = match launch::image_generation_body(&c["request"]) {
            Ok(body) => json!({ "body": body }),
            Err(problem) => json!({ "problem": problem }),
        };
        assert_eq!(nekko_js::stringify(&out), c["out"].as_str().unwrap(), "{}", c["request"]);
    }
    for c in g["memory"].as_array().unwrap() {
        let gpu = (!c["gpu"].is_null()).then(|| &c["gpu"]);
        assert_eq!(launch::engine_memory(gpu, c["total"].as_f64().unwrap()), c["out"], "{c}");
    }
    for c in g["reserves"].as_array().unwrap() {
        assert_eq!(json!(launch::reserves_endpoint(&c["patch"])), c["out"], "{c}");
    }
    let templates = join(&[&root, "engine", "templates"]);
    for (i, c) in g["companions"].as_array().unwrap().iter().enumerate() {
        let model = denorm(&root, &g["models"][i]);
        let dir = join(&[&root, "models", ".companions", c["id"].as_str().unwrap()]);
        let out = match launch::resolve_companions(&model, Some(&templates), Some(&dir)) {
            Ok(c) => c.to_value(),
            Err(e) => json!({ "error": e }),
        };
        assert_eq!(norm(&root, &out), c["out"], "{}", c["id"]);
    }
    let sd = denorm(&root, g["models"].as_array().unwrap().iter().find(|m| m["id"] == "sd").unwrap());
    for c in g["diffusion"].as_array().unwrap() {
        let out = if c["preset"] == "flux" {
            let flux = denorm(
                &root,
                &json!({ "id": "flux", "name": "FLUX.1 dev", "path": "<root>/models/flux1-dev.gguf", "sizeBytes": 4_000_000_000u64, "layers": 32, "maxContext": 32768, "addedAt": 1_600_000_000_123u64, "modality": "image" }),
            );
            launch::diffusion_args(&flux, "1234", None, Some(&join(&[&root, "models", ".companions", "image"])))
        } else {
            let mut model = sd.clone();
            if !c["preset"].is_null() {
                model["preset"] = json!({ "diffusion": denorm(&root, &c["preset"]) });
            }
            launch::diffusion_args(
                &model,
                "{port}",
                Some(&join(&[&root, "models", ".companions", "sd"])),
                Some(&join(&[&root, "models", ".companions", "image"])),
            )
        };
        let out = match out {
            Ok(a) => json!(a),
            Err(e) => json!({ "error": e }),
        };
        assert_eq!(norm(&root, &out), c["out"], "{}", c["preset"]);
    }
    let mlx_model = denorm(&root, &g["models"][6]);
    for c in g["mlx"].as_array().unwrap() {
        let draft = c["draft"].as_str().map(|d| d.replace("<root>", &root));
        let out = launch::mlx_args(&mlx_model, "9000", &c["params"], draft.as_deref());
        assert_eq!(norm(&root, &json!(out)), c["out"], "{c}");
    }
    std::fs::remove_dir_all(&root).ok();
}

/* --------------------------------------------------------- the scripted run */

struct Fake {
    case: Value,
    root: String,
    clock: Mutex<f64>,
    landed: Mutex<bool>,
    settings: Mutex<Value>,
    models: Vec<Value>,
    flags: Arc<HashSet<String>>,
    children: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
    serving: Mutex<bool>,
    spawns: Mutex<Map<String, Value>>,
    n: Mutex<u64>,
}

impl Fake {
    fn now(&self) -> f64 {
        *self.clock.lock().unwrap()
    }
}

impl Daemon for Fake {
    fn serve(&self, config: Value) -> BoxFuture<Value> {
        self.calls.lock().unwrap().push(norm(&self.root, &json!({ "serve": config })));
        let res = self.case.get("serve").cloned().unwrap_or_else(|| {
            json!({ "ok": true, "message": format!("Listening on {}:{}", nekko_js::display(&config["host"]), nekko_js::display(&config["port"])) })
        });
        if res["ok"] == true {
            *self.serving.lock().unwrap() = true;
        }
        Box::pin(async move { res })
    }
    fn stop_serving(&self) -> BoxFuture<()> {
        self.calls.lock().unwrap().push(json!({ "stopServing": true }));
        *self.serving.lock().unwrap() = false;
        Box::pin(async {})
    }
    fn serving(&self) -> BoxFuture<bool> {
        let s = *self.serving.lock().unwrap();
        Box::pin(async move { s })
    }
    fn spawn(&self, spec: Value) -> BoxFuture<Value> {
        self.calls.lock().unwrap().push(norm(&self.root, &json!({ "spawn": spec })));
        let id = spec["modelId"].as_str().unwrap().to_string();
        let next = {
            let mut spawns = self.spawns.lock().unwrap();
            spawns
                .get_mut(&id)
                .and_then(|q| q.as_array_mut())
                .and_then(|q| if q.is_empty() { None } else { Some(q.remove(0)) })
        };
        let out = match next {
            Some(Value::Object(f)) => json!({ "status": "failed", "message": f["message"], "log": f["log"] }),
            _ => {
                let n = {
                    let mut n = self.n.lock().unwrap();
                    *n += 1;
                    *n
                };
                *self.landed.lock().unwrap() = true;
                let now = self.now();
                let c = json!({ "modelId": id, "kind": spec["kind"], "port": 40000 + n, "pid": 1000 + n, "startedAt": now, "lastUsedAt": now, "activeRequests": 0 });
                let mut children = self.children.lock().unwrap();
                children.retain(|x| x["modelId"] != id.as_str());
                children.push(c);
                json!({ "status": "ready", "port": 40000 + n, "pid": 1000 + n })
            }
        };
        Box::pin(async move { out })
    }
    fn kill(&self, model_id: String) -> BoxFuture<bool> {
        self.calls.lock().unwrap().push(json!({ "kill": model_id }));
        let mut children = self.children.lock().unwrap();
        let before = children.len();
        children.retain(|x| x["modelId"] != model_id.as_str());
        let killed = children.len() < before;
        Box::pin(async move { killed })
    }
    fn list(&self) -> BoxFuture<Vec<Value>> {
        let l = self.children.lock().unwrap().clone();
        Box::pin(async move { l })
    }
}

impl Env for Fake {
    fn settings(&self) -> Value {
        self.settings.lock().unwrap().clone()
    }
    fn prompt_caching(&self) -> bool {
        self.case.get("promptCaching").and_then(Value::as_bool).unwrap_or(true)
    }
    fn engine(&self, runtime: &'static str) -> BoxFuture<Option<Engine>> {
        let file = match runtime {
            "diffusion" => "sd-server.exe",
            "mlx" => "mlx_lm.server",
            "mlx-dflash2" => "mlx_vlm.server",
            _ => "llama-server.exe",
        };
        let on = self.case.get("bins").and_then(|b| b.get(runtime)) == Some(&Value::Bool(true));
        // `engine: { source, version }` says which llama.cpp this is; a managed engine of unknown version otherwise.
        let install = self.case.get("engine").cloned().unwrap_or_else(|| json!({ "source": "managed" }));
        let p = on.then(|| {
            let bin = join(&[&self.root, "engine", file]);
            let mut install = install;
            install["binPath"] = json!(bin);
            Engine { bin, in_use: EngineInUse::from_install(&install) }
        });
        Box::pin(async move { p })
    }
    fn gpu_capable(&self) -> BoxFuture<Option<bool>> {
        let c = Some(self.case.get("gpuCapable").and_then(Value::as_bool).unwrap_or(true));
        Box::pin(async move { c })
    }
    fn find_model(&self, id: String) -> BoxFuture<Option<Value>> {
        let m = self.models.iter().find(|m| m["id"] == id.as_str()).cloned();
        Box::pin(async move { m })
    }
    fn list_models(&self) -> BoxFuture<Vec<Value>> {
        let m = self.models.clone();
        Box::pin(async move { m })
    }
    fn gpu(&self) -> BoxFuture<Option<Value>> {
        let g = self.case.get("gpu").filter(|g| !g.is_null()).map(|g| {
            let free = if *self.landed.lock().unwrap() { &g["after"] } else { &g["before"] };
            json!({ "source": "nvidia-smi", "devices": [{ "name": "GPU", "memoryTotalMB": 24000, "memoryUsedMB": 0, "memoryFreeMB": 0 }], "totalMB": 24000, "usedMB": 0, "freeMB": free })
        });
        Box::pin(async move { g })
    }
    fn flags(&self, _: String) -> BoxFuture<Arc<HashSet<String>>> {
        let f = self.flags.clone();
        Box::pin(async move { f })
    }
    fn work_dir(&self) -> Option<String> {
        Some(join(&[&self.root, "engine", "templates"]))
    }
    fn companions_dir(&self, id: &str) -> Option<String> {
        let key: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
        Some(join(&[&self.root, "models", ".companions", &key]))
    }
    fn image_companions_dir(&self) -> Option<String> {
        Some(join(&[&self.root, "models", ".companions", "image"]))
    }
    fn vc_runtime(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn now(&self) -> f64 {
        Fake::now(self)
    }
    fn clock(&self) -> String {
        "00:00:00".into()
    }
    fn on_serving(&self, _: String) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

fn unclock(v: Value) -> Value {
    match v {
        Value::Object(mut m) if m.get("log").is_some_and(Value::is_array) => {
            let log: Vec<Value> = m["log"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| {
                    let s = l.as_str().unwrap();
                    json!(s.get(9..).filter(|_| s.as_bytes().get(8) == Some(&b' ')).unwrap_or(s))
                })
                .collect();
            m.insert("log".into(), json!(log));
            Value::Object(m)
        }
        other => other,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_the_model_server_as_the_host_does() {
    let g = golden();
    let now = g["now"].as_f64().unwrap();
    for case in g["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        let root = scratch(&slug);
        write_files(&root, &g["files"]);
        let mut settings = json!({ "port": 11500, "bind": "local", "autoStart": false, "jitLoad": true, "idleTtlSeconds": 900, "maxLoaded": 2 });
        for (k, v) in case.get("settings").and_then(Value::as_object).cloned().unwrap_or_default() {
            settings[k] = v;
        }
        let mut children = Vec::new();
        let mut n = 0u64;
        for a in case.get("attached").and_then(Value::as_array).cloned().unwrap_or_default() {
            n += 1;
            children.push(json!({ "modelId": a["modelId"], "kind": a["kind"], "port": 40000 + n, "pid": 1000 + n, "startedAt": now - 60_000.0, "lastUsedAt": a["lastUsedAt"], "activeRequests": a["activeRequests"] }));
        }
        let fake = Arc::new(Fake {
            case: case.clone(),
            root: root.clone(),
            clock: Mutex::new(now),
            landed: Mutex::new(false),
            settings: Mutex::new(settings),
            models: denorm(&root, &case["models"]).as_array().unwrap().clone(),
            flags: Arc::new(
                g["flagSets"][case.get("flags").and_then(Value::as_str).unwrap_or("none")]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| f.as_str().unwrap().to_string())
                    .collect(),
            ),
            serving: Mutex::new(case.get("attached").is_some()),
            children: Mutex::new(children),
            calls: Mutex::default(),
            spawns: Mutex::new(case.get("spawn").and_then(Value::as_object).cloned().unwrap_or_default()),
            n: Mutex::new(n),
        });
        let server = ModelServer::new(fake.clone(), fake.clone(), false);
        let mut outs = Vec::new();
        for op in case["ops"].as_array().unwrap() {
            let id = op.get("id").and_then(Value::as_str).unwrap_or_default();
            let out = match op["op"].as_str().unwrap() {
                "status" => unclock(server.status()),
                "resident" => json!(server.resident()),
                "start" => server.start().await,
                "stop" => server.stop().await,
                "reconfigure" => server.reconfigure().await,
                "reattach" => {
                    server.reattach().await;
                    Value::Null
                }
                "load" => server.load(id, op["params"].clone()).await,
                "unload" => server.unload(id).await,
                "ttl" => server.set_resident_ttl(id, op.get("ttl")),
                "routerLoad" => server.router_load(id, op["image"].as_bool().unwrap()).await,
                "routerModels" => server.router_models().await,
                "routerModel" => server.router_model(id).await,
                "sync" => {
                    server.sync().await;
                    Value::Null
                }
                "sweep" => {
                    server.sweep_idle().await;
                    Value::Null
                }
                "advance" => {
                    *fake.clock.lock().unwrap() += op["ms"].as_f64().unwrap();
                    Value::Null
                }
                "setSettings" => {
                    let mut s = fake.settings.lock().unwrap();
                    for (k, v) in op["settings"].as_object().unwrap() {
                        s[k] = v.clone();
                    }
                    Value::Null
                }
                "touch" => {
                    let clock = fake.now();
                    if let Some(c) = fake.children.lock().unwrap().iter_mut().find(|c| c["modelId"] == id) {
                        c["lastUsedAt"] = json!(clock);
                        c["activeRequests"] = op["activeRequests"].clone();
                    }
                    Value::Null
                }
                "crash" => {
                    fake.children.lock().unwrap().retain(|c| c["modelId"] != id);
                    Value::Null
                }
                "settle" => {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    for _ in 0..500 {
                        if server.status()["loading"].as_array().is_none_or(Vec::is_empty) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    Value::Null
                }
                other => panic!("op {other}"),
            };
            outs.push(nekko_js::stringify(&norm(&root, &out)));
        }
        let want: Vec<String> =
            case["result"]["outs"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_string()).collect();
        for (i, (got, want)) in outs.iter().zip(&want).enumerate() {
            assert_eq!(got, want, "{name}: op {i} {}", case["ops"][i]);
        }
        assert_eq!(outs.len(), want.len());
        // The TS run stops the server before it reads the calls.
        server.stop().await;
        let calls = fake.calls.lock().unwrap().clone();
        let want_calls = case["result"]["calls"].as_array().unwrap();
        for (i, (got, want)) in calls.iter().zip(want_calls).enumerate() {
            assert_eq!(got, want, "{name}: call {i}");
        }
        assert_eq!(calls.len(), want_calls.len(), "calls of {name}: {calls:?}");
        let dir = join(&[&root, "engine", "templates"]);
        let mut templates = Map::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            let mut names: Vec<String> =
                rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            for n in names {
                templates.insert(n.clone(), json!(std::fs::read_to_string(Path::new(&dir).join(&n)).unwrap()));
            }
        }
        assert_eq!(Value::Object(templates), case["result"]["templates"], "templates of {name}");
        std::fs::remove_dir_all(&root).ok();
    }
}

/* ------------------------------------------- residency: pins and free memory */

/// A scripted engine for the residency rules: llama.cpp installed, these
/// models, and a GPU probe that always reads `free_mb` free.
fn residency_rig(name: &str, models: Value, settings: Value, free_mb: Option<f64>) -> (Arc<Fake>, Arc<ModelServer>) {
    let g = golden();
    let root = scratch(name);
    write_files(&root, &g["files"]);
    let mut s = json!({ "port": 11500, "bind": "local", "autoStart": false, "jitLoad": true, "idleTtlSeconds": 900, "maxLoaded": 2 });
    for (k, v) in settings.as_object().unwrap() {
        s[k] = v.clone();
    }
    let gpu = free_mb.map_or(Value::Null, |f| json!({ "before": f, "after": f }));
    let fake = Arc::new(Fake {
        case: json!({ "bins": { "llama": true, "diffusion": true }, "gpu": gpu }),
        root: root.clone(),
        clock: Mutex::new(1_700_000_000_000.0),
        landed: Mutex::new(false),
        settings: Mutex::new(s),
        models: denorm(&root, &models).as_array().unwrap().clone(),
        flags: Arc::new(HashSet::new()),
        serving: Mutex::new(true),
        children: Mutex::default(),
        calls: Mutex::default(),
        spawns: Mutex::default(),
        n: Mutex::new(0),
    });
    let server = ModelServer::new(fake.clone(), fake.clone(), false);
    (fake, server)
}

/// A chat model the planner can size: `gb` of weights, 36 layers, 8 KV heads
/// of 128, at 8k context (about 1.2 GB of f16 KV cache).
fn sized(id: &str, gb: f64) -> Value {
    json!({ "id": id, "name": id, "path": "<root>/models/chat/qwen/qwen.gguf", "sizeBytes": gb * 1e9, "layers": 36,
        "kvHeads": 8, "headDim": 128, "maxContext": 32768, "addedAt": 1_600_000_000_123u64, "architecture": "qwen3",
        "preset": { "contextTokens": 8192 } })
}

fn kills(fake: &Fake) -> Vec<String> {
    fake.calls.lock().unwrap().iter().filter_map(|c| c["kill"].as_str().map(str::to_string)).collect()
}

fn advance(fake: &Fake, ms: f64) {
    *fake.clock.lock().unwrap() += ms;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_model_kept_resident_is_never_unloaded_to_make_room() {
    let models = json!([sized("kept", 2.0), sized("b", 2.0), sized("c", 2.0)]);
    let (fake, server) = residency_rig("pinned", models, json!({ "maxLoaded": 2 }), None);
    assert_eq!(server.load("kept", json!({})).await["ok"], true);
    assert_eq!(server.set_resident_ttl("kept", Some(&json!(0)))["ok"], true);
    advance(&fake, 1000.0);
    assert_eq!(server.load("b", json!({})).await["ok"], true);
    advance(&fake, 1000.0);
    // "kept" is the least recently used, but it is pinned: "b" goes instead.
    assert_eq!(server.load("c", json!({})).await["ok"], true);
    assert_eq!(kills(&fake), vec!["b".to_string()]);
    let resident: Vec<String> = server.resident().iter().map(|r| r["id"].as_str().unwrap().to_string()).collect();
    assert!(resident.contains(&"kept".to_string()) && resident.contains(&"c".to_string()), "{resident:?}");

    // With every other slot pinned too, the load is refused and says why.
    assert_eq!(server.set_resident_ttl("c", Some(&json!(0)))["ok"], true);
    let refused = server.load("b", json!({})).await;
    assert_eq!(refused["ok"], false);
    assert!(refused["message"].as_str().unwrap().contains("kept resident"), "{refused}");
}

#[tokio::test(flavor = "multi_thread")]
async fn load_times_are_kept_per_model_across_unloads() {
    let models = json!([sized("a", 2.0), sized("b", 2.0)]);
    let (fake, server) = residency_rig("load-times", models, json!({}), None);
    assert!(server.load_times().is_empty());
    assert_eq!(server.load("a", json!({})).await["ok"], true);
    assert_eq!(server.unload("a").await["ok"], true);
    advance(&fake, 5000.0);
    assert_eq!(server.load("a", json!({})).await["ok"], true);
    assert_eq!(server.load("b", json!({})).await["ok"], true);

    let times = server.load_times();
    let a = times["a"].as_array().unwrap();
    assert_eq!(a.len(), 2, "the unload keeps the first: {a:?}");
    assert_eq!(a[1]["at"].as_f64().unwrap() - a[0]["at"].as_f64().unwrap(), 5000.0);
    assert_eq!(a[0]["sizeBytes"].as_f64(), Some(2e9));
    assert!(
        a.iter().all(|t| t["spawnMs"].as_f64().unwrap() >= 0.0
            && t["totalMs"].as_f64().unwrap() >= t["spawnMs"].as_f64().unwrap())
    );
    assert_eq!(times["b"].as_array().unwrap().len(), 1);

    // Only the last few are kept.
    for _ in 0..10 {
        server.unload("a").await;
        server.load("a", json!({})).await;
    }
    assert_eq!(server.load_times()["a"].as_array().unwrap().len(), 8);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_model_that_needs_the_memory_unloads_idle_ones_first() {
    // 10,000 MB free on the GPU; each small model needs about 3.3 GB, the big one about 21 GB.
    let models = json!([sized("small1", 2.0), sized("small2", 2.0), sized("big", 20.0)]);
    let (fake, server) = residency_rig("memory", models, json!({ "maxLoaded": 4 }), Some(10_000.0));
    assert_eq!(server.load("small1", json!({})).await["ok"], true);
    advance(&fake, 1000.0);
    assert_eq!(server.load("small2", json!({})).await["ok"], true);
    assert!(kills(&fake).is_empty(), "under the limit and both fit: nothing goes");
    advance(&fake, 1000.0);
    // The big one does not fit: the idle ones go, oldest first, and it loads
    // anyway once nothing is left to unload, saying so.
    assert_eq!(server.load("big", json!({})).await["ok"], true);
    assert_eq!(kills(&fake), vec!["small1".to_string(), "small2".to_string()]);
    let log = server.status()["log"].to_string();
    assert!(log.contains("Unloading small1 to free memory for big."), "{log}");
    assert!(log.contains("big may not fit in free memory"), "{log}");
}

/// A Z-Image Turbo file of `gb`: its companion set adds the FLUX.1 VAE and a
/// Qwen3 4B encoder (about 2.8 GB) and sd.cpp's 2 GiB working allowance.
fn picture(id: &str, gb: f64) -> Value {
    json!({ "id": id, "name": "Z-Image Turbo", "path": "<root>/models/image/z_image_turbo-Q4_K.gguf", "sizeBytes": gb * 1e9,
        "addedAt": 1_600_000_000_123u64, "modality": "image" })
}

/// Z-Image's companion files, downloaded, so its load can start.
fn with_picture_companions(fake: &Fake) {
    let dir = join(&[&fake.root, "models", ".companions", "image"]);
    std::fs::create_dir_all(&dir).unwrap();
    for f in ["vae-z-image.safetensors", "llm-qwen3-4b-instruct-2507-q4_k_m.gguf"] {
        std::fs::write(join(&[&dir, f]), b"x").unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_picture_model_counts_its_companions_and_makes_room_like_a_chat_model() {
    // 6,000 MB free with the chat model loaded: the 3 GB picture file and the
    // working allowance alone (5.1 GB) would fit, but with its companions
    // (about 8 GB in all) it does not.
    let models = json!([sized("chat", 2.0), picture("zimage", 3.0)]);
    let (fake, server) = residency_rig("picture-memory", models, json!({ "maxLoaded": 4 }), Some(6_000.0));
    with_picture_companions(&fake);
    assert_eq!(server.load("chat", json!({})).await["ok"], true);
    advance(&fake, 1000.0);
    assert_eq!(server.load("zimage", json!({})).await["ok"], true);
    assert_eq!(kills(&fake), vec!["chat".to_string()], "the idle chat model makes room");
    let log = server.status()["log"].to_string();
    assert!(log.contains("Unloading chat to free memory for zimage."), "{log}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_picture_model_that_fits_leaves_the_chat_model_loaded() {
    let models = json!([sized("chat", 2.0), picture("zimage", 3.0)]);
    let (fake, server) = residency_rig("picture-fits", models, json!({ "maxLoaded": 4 }), Some(40_000.0));
    with_picture_companions(&fake);
    assert_eq!(server.load("chat", json!({})).await["ok"], true);
    let r = server.load("zimage", json!({})).await;
    assert_eq!(r["ok"], true, "{r}");
    assert!(kills(&fake).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_gpu_reading_only_the_resident_limit_counts() {
    let models = json!([sized("small1", 2.0), sized("big", 20.0)]);
    let (fake, server) = residency_rig("no-gpu", models, json!({ "maxLoaded": 4 }), None);
    assert_eq!(server.load("small1", json!({})).await["ok"], true);
    assert_eq!(server.load("big", json!({})).await["ok"], true);
    assert!(kills(&fake).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn unloading_all_shuts_down_every_model_even_one_kept_resident() {
    let models = json!([sized("kept", 2.0), sized("b", 3.0)]);
    let (fake, server) = residency_rig("release", models, json!({ "maxLoaded": 4 }), None);
    assert_eq!(server.load("kept", json!({})).await["ok"], true);
    assert_eq!(server.set_resident_ttl("kept", Some(&json!(0)))["ok"], true);
    assert_eq!(server.load("b", json!({})).await["ok"], true);
    let r = server.unload_all().await;
    assert_eq!(r["unloaded"], json!(["kept", "b"]), "{r}");
    assert_eq!(r["freedBytes"], json!(5e9));
    assert_eq!(r["stopped"], json!(0));
    assert_eq!(kills(&fake), vec!["kept".to_string(), "b".to_string()]);
    assert!(server.loaded_ids().is_empty());
}

/* ----------------------------------------- the load gate: what the engine in use can run */

/// A scripted engine of this kind (`{ source, version }`, as `detect` reports it) and these models.
fn engine_rig(name: &str, engine: Value, models: Value) -> (Arc<Fake>, Arc<ModelServer>) {
    engine_rig_with_flags(name, engine, models, &[])
}

fn engine_rig_with_flags(name: &str, engine: Value, models: Value, flags: &[&str]) -> (Arc<Fake>, Arc<ModelServer>) {
    let g = golden();
    let root = scratch(name);
    write_files(&root, &g["files"]);
    let fake = Arc::new(Fake {
        case: json!({ "bins": { "llama": true }, "engine": engine }),
        root: root.clone(),
        clock: Mutex::new(1_700_000_000_000.0),
        landed: Mutex::new(false),
        settings: Mutex::new(
            json!({ "port": 11500, "bind": "local", "autoStart": false, "jitLoad": true, "idleTtlSeconds": 900, "maxLoaded": 2 }),
        ),
        models: denorm(&root, &models).as_array().unwrap().clone(),
        flags: Arc::new(flags.iter().map(|f| (*f).to_string()).collect()),
        serving: Mutex::new(true),
        children: Mutex::default(),
        calls: Mutex::default(),
        spawns: Mutex::default(),
        n: Mutex::new(0),
    });
    let server = ModelServer::new(fake.clone(), fake.clone(), false);
    (fake, server)
}

fn spawned(fake: &Fake) -> usize {
    fake.calls.lock().unwrap().iter().filter(|c| c.get("spawn").is_some()).count()
}

#[tokio::test(flavor = "multi_thread")]
async fn gguf_dflash_head_uses_the_verified_llama_args_only_when_selected() {
    let models = json!([
        { "id": "target", "path": "<root>/target.gguf", "architecture": "qwen35" },
        { "id": "head", "path": "<root>/renamed.gguf", "architecture": "dflash" },
        { "id": "small", "path": "<root>/small.gguf", "architecture": "qwen35" },
    ]);
    let flags = ["--spec-default", "--spec-draft-model", "--spec-draft-ngl", "--spec-type", "--spec-draft-n-max"];
    let (fake, server) =
        engine_rig_with_flags("gguf-dflash", json!({ "source": "managed", "version": "b12503" }), models, &flags);
    let standalone = server.load("head", json!({})).await;
    assert_eq!(standalone["ok"], false, "{standalone}");
    assert!(standalone["message"].as_str().unwrap().contains("not on its own"), "{standalone}");
    assert_eq!(spawned(&fake), 0);

    for (params, expected) in [
        (json!({}), vec!["--spec-default"]),
        (
            json!({ "draftModelId": "head" }),
            vec![
                "--spec-default",
                "--spec-draft-model",
                "<root>/renamed.gguf",
                "--spec-draft-ngl",
                "all",
                "--spec-type",
                "draft-dflash",
                "--spec-draft-n-max",
                "7",
            ],
        ),
        (
            json!({ "draftModelId": "small" }),
            vec![
                "--spec-default",
                "--spec-draft-model",
                "<root>/small.gguf",
                "--spec-draft-ngl",
                "all",
                "--spec-type",
                "draft-simple",
            ],
        ),
        (json!({ "draftModelId": "head", "speculative": false }), vec![]),
    ] {
        let loaded = server.load("target", params.clone()).await;
        assert_eq!(loaded["ok"], true, "{loaded}");
        let calls = fake.calls.lock().unwrap();
        let spawn = calls.iter().rev().find_map(|c| c.get("spawn")).unwrap();
        let args: Vec<_> = spawn["args"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap()).collect();
        let first = args.iter().position(|a| a.starts_with("--spec-")).unwrap_or(args.len());
        assert_eq!(&args[first..], expected, "{params}");
    }
}

/// PrismML's 1-bit build (tensor type 143, hadamard header) and a build of known types with the hadamard header.
fn prism_models() -> Value {
    let mut ptq1 = sized("ptq1", 6.0);
    ptq1["unknownWeightType"] = json!(143);
    ptq1["minEngineBuild"] = json!(11556);
    let mut q2 = sized("q2", 7.0);
    q2["minEngineBuild"] = json!(11556);
    json!([ptq1, q2, sized("plain", 2.0)])
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gate_refuses_what_a_managed_engine_cannot_run_before_anything_spawns() {
    let managed = json!({ "source": "managed", "version": "b11224" });
    let (fake, server) = engine_rig("gate-managed", managed, prism_models());
    // An unknown weight format, even though the old engine is also too old.
    let r = server.load("ptq1", json!({})).await;
    assert_eq!(r["ok"], false, "{r}");
    assert!(r["message"].as_str().unwrap().contains("tensor type 143"), "{r}");
    // Too old for the hadamard header: update, not "wrong format".
    let r = server.load("q2", json!({})).await;
    assert_eq!(r["ok"], false, "{r}");
    let why = r["message"].as_str().unwrap();
    assert!(why.contains("b11556") && why.contains("b11224") && why.contains("Update the engine"), "{why}");
    assert_eq!(spawned(&fake), 0, "llama-server never started");
    // The refusal is kept as the model's last error, as the Models page and phones read it.
    let errors = server.load_errors();
    assert!(errors["q2"].as_str().unwrap().contains("too old"), "{errors:?}");
    // An ordinary model still loads.
    assert_eq!(server.load("plain", json!({})).await["ok"], true);
    assert_eq!(spawned(&fake), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_managed_engine_that_is_current_still_refuses_the_unknown_format_but_runs_the_rest() {
    let managed = json!({ "source": "managed", "version": "b12436" });
    let (fake, server) = engine_rig("gate-current", managed, prism_models());
    assert_eq!(server.load("ptq1", json!({})).await["ok"], false);
    assert_eq!(server.load("q2", json!({})).await["ok"], true);
    assert_eq!(spawned(&fake), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_external_engine_of_unknown_version_is_warned_about_and_let_try() {
    let external = json!({ "source": "external" });
    let (fake, server) = engine_rig("gate-external", external, prism_models());
    for id in ["ptq1", "q2"] {
        let r = server.load(id, json!({})).await;
        assert_eq!(r["ok"], true, "{id}: {r}");
    }
    assert_eq!(spawned(&fake), 2);
    let log = server.status()["log"].to_string();
    assert!(log.contains("tensor type 143") && log.contains("could not be read"), "the warnings are in the log: {log}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_external_engine_is_never_refused_whatever_version_it_reports() {
    // A PrismML build reads these files whatever its own number says, so an old-looking one only gets a warning.
    let external = json!({ "source": "external", "version": "b11224" });
    let (fake, server) = engine_rig("gate-external-old", external, prism_models());
    for id in ["ptq1", "q2"] {
        assert_eq!(server.load(id, json!({})).await["ok"], true, "{id}");
    }
    assert_eq!(spawned(&fake), 2);
    let log = server.status()["log"].to_string();
    assert!(log.contains("reports b11224") && log.contains("update it"), "the warning is in the log: {log}");
    let current = json!({ "source": "external", "version": "b12436" });
    let (fake, server) = engine_rig("gate-external-new", current, prism_models());
    // Fork or not, a current external engine is the user's to try; llama.cpp's own error would surface.
    for id in ["ptq1", "q2"] {
        assert_eq!(server.load(id, json!({})).await["ok"], true, "{id}");
    }
    assert_eq!(spawned(&fake), 2);
}

fn queue_failure(fake: &Fake, id: &str, line: &str) {
    fake.spawns.lock().unwrap().insert(id.into(), json!([{ "message": "exited with code 1", "log": [line] }]));
}

fn spawn_args(fake: &Fake) -> Vec<Vec<String>> {
    fake.calls
        .lock()
        .unwrap()
        .iter()
        .filter_map(|c| c["spawn"]["args"].as_array())
        .map(|a| a.iter().map(|x| x.as_str().unwrap_or_default().to_string()).collect())
        .collect()
}

/// #3325: a load that names no KV type runs with q8_0; when that cache will
/// not start (here the f8 abort llama.cpp b12470 hits on Metal), the engine
/// tries once more with f16 and says so, rather than leaving the model
/// unloadable.
#[tokio::test(flavor = "multi_thread")]
async fn a_quantized_cache_that_will_not_start_falls_back_to_f16() {
    let (fake, server) = residency_rig("kv-fallback", json!([sized("m", 2.0)]), json!({}), None);
    queue_failure(
        &fake,
        "m",
        "ggml-backend.cpp:1358: pre-allocated tensor (cache_k_l0 (view)) in a buffer (MTL0) that cannot run the operation (SET_ROWS)",
    );
    let r = server.load("m", json!({})).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["kvFallback"], "f16", "{r}");
    assert!(r["message"].as_str().unwrap().contains("full-precision (f16) KV cache"), "{r}");
    let args = spawn_args(&fake);
    assert_eq!(args.len(), 2, "{args:?}");
    assert!(args[0].windows(2).any(|w| w == ["--cache-type-k", "q8_0"]), "first try, the default: {:?}", args[0]);
    assert!(!args[1].iter().any(|a| a == "--cache-type-k"), "the retry runs f16: {:?}", args[1]);
}

/// Out of memory, or a load that already asked for f16: no second try, since
/// the f16 cache is the bigger one and would fail the same way.
#[tokio::test(flavor = "multi_thread")]
async fn a_failure_the_cache_does_not_cause_is_not_retried() {
    let (fake, server) = residency_rig("kv-no-fallback", json!([sized("m", 2.0)]), json!({}), None);
    queue_failure(&fake, "m", "llama_kv_cache: failed to allocate KV cache buffer of 2448 MiB");
    let r = server.load("m", json!({})).await;
    assert_eq!(r["ok"], false, "{r}");
    assert!(r["message"].as_str().unwrap().starts_with("Not enough memory"), "{r}");
    assert_eq!(spawn_args(&fake).len(), 1);
    queue_failure(&fake, "m", "something unexplained went wrong");
    let r = server.load("m", json!({ "kvCacheDtype": "f16" })).await;
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(spawn_args(&fake).len(), 2, "one more spawn, no retry");
}

fn mlx_dflash2_rig(name: &str, external: bool, target_dir: &str) -> (Arc<Fake>, Arc<ModelServer>) {
    let (mut fake, server) = engine_rig(
        name,
        json!({ "source": "external" }),
        json!([
            { "id": "target", "name": "Target", "path": format!("<root>/{target_dir}"), "format": "mlx", "mlxRunnable": true, "modality": "vision" },
            { "id": "head", "name": "Head", "path": "<root>/head", "format": "mlx", "mlxRunnable": true, "modality": "draft" },
            { "id": "ordinary", "name": "Ordinary", "path": "<root>/ordinary", "format": "mlx", "mlxRunnable": true },
        ]),
    );
    drop(server);
    Arc::get_mut(&mut fake).unwrap().case["bins"] = json!({ "mlx": true, "mlx-dflash2": external });
    write_files(
        &fake.root,
        &json!({
            format!("{target_dir}/config.json"): json!({
                "model_type": "qwen3_5", "vision_config": {}, "text_config": {
                    "hidden_size": 5120, "num_hidden_layers": 64, "vocab_size": 248320
                }
            }).to_string(),
            "head/config.json": json!({
                "model_type": "qwen3", "architectures": ["DFlash2DraftModel"],
                "hidden_size": 5120, "num_target_layers": 64, "vocab_size": 248320,
                "dflash_config": { "block_size": 8, "conv_group_size": 16, "conv_kernel_size": 2,
                    "mask_token_id": 248070, "selector_rank": 256, "selector_top_k": 16,
                    "target_layer_ids": [5, 19, 33, 47, 61] }
            }).to_string(),
        }),
    );
    let server = ModelServer::new(fake.clone(), fake.clone(), false);
    (fake, server)
}

#[tokio::test]
async fn mlx_dflash2_requires_explicit_selection_and_uses_the_vlm_contract() {
    let (fake, server) = mlx_dflash2_rig("dflash2-pair", true, "mlx-community_Qwen3.8-27B-4bit");
    for params in [
        json!({}),
        json!({"draftModelId":"head","speculative":false}),
        json!({"draftModelId":"ordinary"}),
        json!({"draftModelId":"head"}),
    ] {
        let result = server.load("target", params).await;
        assert_eq!(result["ok"], true, "{result}");
    }
    let calls = fake.calls.lock().unwrap();
    let specs: Vec<_> = calls.iter().filter_map(|c| c.get("spawn")).collect();
    assert_eq!(specs.len(), 4);
    for spec in &specs[..3] {
        assert_eq!(spec["bin"], "<root>/engine/mlx_lm.server");
        assert_eq!(spec["healthExpect"], "\"ok\"");
        assert!(spec.get("upstreamModel").is_none());
    }
    assert_eq!(specs[0]["args"], specs[1]["args"]);
    assert_eq!(
        &specs[2]["args"].as_array().unwrap()[6..],
        &[json!("--draft-model"), json!("<root>/ordinary"), json!("--num-draft-tokens"), json!("3")]
    );
    assert_eq!(specs[3]["bin"], "<root>/engine/mlx_vlm.server");
    assert_eq!(
        specs[3]["args"],
        json!([
            "--model",
            "<root>/mlx-community_Qwen3.8-27B-4bit",
            "--host",
            "127.0.0.1",
            "--port",
            "{port}",
            "--draft-model",
            "<root>/head",
            "--draft-kind",
            "dflash"
        ])
    );
    assert_eq!(specs[3]["upstreamModel"], "<root>/mlx-community_Qwen3.8-27B-4bit");
    assert_eq!(specs[3]["healthPath"], "/health");
    assert_eq!(specs[3]["healthExpect"], "\"model_ready\":true");
    assert_eq!(specs[3]["healthReadyLog"], "Drafter ready; speculative decoding enabled.");
}

#[tokio::test]
async fn mlx_dflash2_fails_closed_without_a_runtime_or_matching_config() {
    for (name, runtime, target_dir, reason) in [
        ("dflash2-no-runtime", false, "Qwen3.8-27B-MLX-8bit", "mlx_vlm.server"),
        ("dflash2-wrong-target", true, "Qwen3.5-27B-4bit", "matching stock Qwen3.8-27B"),
        ("dflash2-wrong-shape", true, "Qwen3.8-27B-4bit", "matching stock Qwen3.8-27B"),
    ] {
        let (fake, server) = mlx_dflash2_rig(name, runtime, target_dir);
        if name == "dflash2-wrong-shape" {
            let path = join(&[&fake.root, "head", "config.json"]);
            let mut config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            config["num_target_layers"] = json!(32);
            std::fs::write(path, config.to_string()).unwrap();
        }
        let result = server.load("target", json!({ "draftModelId": "head" })).await;
        assert_eq!(result["ok"], false, "{result}");
        assert!(result["message"].as_str().unwrap().contains(reason), "{result}");
        let standalone = server.load("head", json!({})).await;
        assert_eq!(standalone["ok"], false, "{standalone}");
        assert!(standalone["message"].as_str().unwrap().contains("not on its own"), "{standalone}");
        assert_eq!(spawned(&fake), 0);
    }
}
