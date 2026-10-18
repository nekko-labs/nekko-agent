//! Replays the TS model-server golden set (`server.golden.test.ts`): the
//! same command lines, companion files, load-failure sentences and image
//! requests, and the same policy over the same scripted daemon: what loads,
//! what is evicted and when, what the router hears and what status reads.

use nekko_engine::BoxFuture;
use nekko_engine::launch::{self, Companions};
use nekko_engine::server::{Daemon, Env, ModelServer};
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
    Companions { mmproj: s("mmproj"), chat_template_file: s("chatTemplateFile"), draft_model: s("draftModel") }
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
    fn bin(&self, runtime: &'static str) -> BoxFuture<Option<String>> {
        let file = match runtime {
            "diffusion" => "sd-server.exe",
            "mlx" => "mlx_lm.server",
            _ => "llama-server.exe",
        };
        let on = self.case.get("bins").and_then(|b| b.get(runtime)) == Some(&Value::Bool(true));
        let p = on.then(|| join(&[&self.root, "engine", file]));
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
