//! Replays the TS runtime control plane's golden script: the same servers,
//! CLIs and engine answers give the same results, requests, runs, engine calls
//! and calibration file.

use nekko_engine::BoxFuture;
use nekko_engine::runtimes::{HostEngine, Probes, Reply, RuntimeIo, Runtimes};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/runtimes.json")).unwrap()
}

struct Script {
    http: Value,
    run: Value,
    requests: Mutex<Vec<String>>,
    runs: Mutex<Vec<String>>,
}

impl RuntimeIo for Script {
    fn fetch(
        &self,
        method: &'static str,
        url: String,
        body: Option<String>,
        _: Option<Duration>,
    ) -> BoxFuture<Option<Reply>> {
        let key = format!("{method} {url} {}", body.unwrap_or_default());
        self.requests.lock().unwrap().push(key.clone());
        let reply = match self.http.get(&key) {
            Some(Value::String(s)) if s == "throw" => None,
            Some(r) => {
                Some(Reply { status: r["status"].as_u64().unwrap() as u16, body: r["body"].as_str().unwrap().into() })
            }
            None => Some(Reply { status: 404, body: "Not found".into() }),
        };
        Box::pin(async move { reply })
    }

    fn run(&self, cmd: String, args: Vec<String>, _: Duration) -> BoxFuture<Option<String>> {
        let base = cmd.rsplit(['/', '\\']).next().unwrap_or(&cmd).trim_end_matches(".exe").to_string();
        let key = std::iter::once(base).chain(args).collect::<Vec<_>>().join(" ");
        self.runs.lock().unwrap().push(key.clone());
        let out = self.run.get(&key).and_then(Value::as_str).map(str::to_string);
        Box::pin(async move { out })
    }
}

/// The TS golden test's scripted engine.
struct Engine {
    status: Value,
    calls: Mutex<Vec<Value>>,
}

impl HostEngine for Engine {
    fn call(&self, method: &'static str, args: Vec<Value>) -> BoxFuture<Result<Value, String>> {
        let mut record = vec![json!(method)];
        record.extend(args);
        self.calls.lock().unwrap().push(Value::Array(record));
        let out = match method {
            "detectEngine" => json!({ "binPath": "C:/engine/llama-server.exe", "version": "b6000" }),
            "isRunning" => json!(true),
            "status" => self.status.clone(),
            "models" => json!([
                { "id": "gemma", "sizeBytes": 3_300_000_000u64, "layers": 34, "kvHeads": 4, "headDim": 256, "maxContext": 131072, "quantization": "Q4_K_M", "parameterSize": "4B", "loaded": true },
                { "id": "nogeo", "sizeBytes": 1_000_000, "loaded": false }
            ]),
            "resident" => self.status["resident"].clone(),
            "start" => json!({ "ok": false, "message": "Port 18431 is in use." }),
            "stop" => json!({ "ok": true, "message": "Stopped the engine." }),
            "load" => json!({ "ok": true, "message": "Loaded gemma" }),
            "unload" => json!({ "ok": true, "message": "Unloaded gemma" }),
            other => panic!("unexpected engine call {other}"),
        };
        Box::pin(async move { Ok(out) })
    }
}

struct Meters;

impl Probes for Meters {
    fn gpu(&self) -> BoxFuture<Value> {
        Box::pin(async {
            json!({ "source": "nvidia-smi", "devices": [{ "name": "RTX 5090", "memoryTotalMB": 32607, "memoryUsedMB": 2000, "memoryFreeMB": 30607 }], "totalMB": 32607, "usedMB": 2000, "freeMB": 30607 })
        })
    }
    fn system(&self) -> BoxFuture<Value> {
        Box::pin(async { json!({ "cpuPct": 5, "cpuCores": 32, "memUsedMB": 30000, "memTotalMB": 48270 }) })
    }
}

/// The TS test's clock normalization: a start's time is the machine's.
fn normalize(text: &str) -> String {
    let re = regress::Regex::new(r#""startedAt":\d{13,}"#).unwrap();
    let mut out = String::new();
    let mut at = 0;
    for m in re.find_iter(text) {
        let s = &text[m.range()];
        out.push_str(&text[at..m.range().start]);
        out.push_str(if s.ends_with("1700000000000") { s } else { r#""startedAt":"<now>""# });
        at = m.range().end;
    }
    out.push_str(&text[at..]);
    out
}

#[tokio::test]
async fn replays_the_host_control_plane() {
    let g = golden();
    let dir = std::env::temp_dir().join(format!("nekko-runtimes-golden-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let io = Arc::new(Script {
        http: g["http"].clone(),
        run: g["run"].clone(),
        requests: Mutex::default(),
        runs: Mutex::default(),
    });
    let engine = Arc::new(Engine { status: g["engineStatus"].clone(), calls: Mutex::default() });
    let providers = g["providers"].clone();
    let rt = Runtimes::new(
        io.clone(),
        engine.clone(),
        Arc::new(Meters),
        Box::new(move || providers.clone()),
        Some(dir.clone()),
    );
    for step in g["steps"].as_array().unwrap() {
        let op = step["op"].as_str().unwrap();
        let a = step["args"].as_array().unwrap();
        let s = |i: usize| a.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
        let v = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
        let out = match op {
            "status" => rt.status(&s(0)).await,
            "start" => rt.start(&s(0)).await,
            "stop" => rt.stop(&s(0), v(1) == json!(true)).await,
            "facts" => json!(rt.facts(&s(0)).await),
            "plan" => rt.plan(&s(0), &s(1), &v(2)).await,
            "autoPlan" => rt.auto_plan(&s(0), &s(1), &v(2), &v(3)).await,
            "load" => rt.load(&s(0), &s(1), &v(2)).await,
            "unload" => rt.unload(&s(0), &s(1)).await,
            "capabilities" => rt.capabilities_of(&s(0)),
            other => panic!("unknown op {other}"),
        };
        let mut requests = std::mem::take(&mut *io.requests.lock().unwrap());
        requests.sort();
        let runs = std::mem::take(&mut *io.runs.lock().unwrap());
        let calls = std::mem::take(&mut *engine.calls.lock().unwrap());
        let label = format!("{op} {}", step["args"]);
        assert_eq!(normalize(&nekko_js::stringify(&out)), step["out"].as_str().unwrap(), "out of {label}");
        assert_eq!(json!(requests), step["requests"], "requests of {label}");
        assert_eq!(json!(runs), step["runs"], "runs of {label}");
        assert_eq!(json!(calls), step["calls"], "engine calls of {label}");
    }
    let calibration = std::fs::read_to_string(dir.join("runtime-calibration.json")).ok();
    assert_eq!(json!(calibration), g["calibration"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vllm_metrics_parse() {
    let m = Runtimes::parse_vllm_metrics(
        "# c\nvllm:num_requests_running{a=\"b\"} 3\nvllm:kv_cache_usage_perc 0.5\nvllm:num_requests_waiting x\n",
    );
    assert_eq!(m, json!({ "requestsRunning": 3, "kvCacheUsagePct": 50 }));
}

fn rig(http: Value, run: Value, providers: Value) -> (Arc<Script>, Runtimes) {
    let io = Arc::new(Script { http, run, requests: Mutex::default(), runs: Mutex::default() });
    let engine = Arc::new(Engine { status: json!({}), calls: Mutex::default() });
    let rt = Runtimes::new(io.clone(), engine, Arc::new(Meters), Box::new(move || providers.clone()), None);
    (io, rt)
}

#[tokio::test]
async fn models_page_calls_match_the_host() {
    let providers = json!([
        { "id": "o", "kind": "ollama", "baseUrl": "http://127.0.0.1:11434/v1/" },
        { "id": "l", "kind": "lmstudio", "baseUrl": "http://localhost:1234/v1" },
        { "id": "r", "kind": "lmstudio", "baseUrl": "http://10.1.1.1:1234/v1" },
        { "id": "c", "kind": "openai", "baseUrl": "https://api.openai.com/v1" },
    ]);
    let http = json!({
        "POST http://127.0.0.1:11434/api/generate {\"model\":\"m\",\"keep_alive\":\"30m\",\"prompt\":\"\"}": { "status": 200, "body": "{}" },
        "POST http://127.0.0.1:11434/api/generate {\"model\":\"m\",\"keep_alive\":0,\"prompt\":\"\"}": { "status": 503, "body": "" },
    });
    let run = json!({
        "lms load m -y": "\u{1b}[31mError: Model Not Found\u{1b}[0m\r\nTry `lms ls`\r\nmore",
        "lms unload m": "Unloaded.",
        "lms version": "lms 0.3",
    });
    let (io, rt) = rig(http, run, providers);
    assert_eq!(rt.load_model("o", "m").await, json!({ "ok": true }));
    assert_eq!(rt.unload_model("o", "m").await, json!({ "ok": false, "message": "Ollama refused (HTTP 503)." }));
    assert_eq!(
        rt.load_model("l", "m").await,
        json!({ "ok": false, "message": "Error: Model Not Found. Try `lms ls`" })
    );
    assert_eq!(rt.unload_model("l", "m").await, json!({ "ok": true, "message": "Unloaded m" }));
    let remote = rt.load_model("r", "m").await;
    assert!(remote["message"].as_str().unwrap().contains("looks remote"), "{remote}");
    assert_eq!(rt.load_model("c", "m").await, json!({ "ok": true }));
    assert_eq!(rt.pull_model("l", "m").await, json!({ "ok": false, "message": "Pull supported on Ollama only." }));
    assert_eq!(rt.lms_probe("l").await, json!({ "available": true }));
    assert_eq!(rt.lms_probe("o").await, json!({ "available": false }));
    assert_eq!(rt.lms_probe("r").await["available"], json!(false));
    assert_eq!(
        rt.stop_server("c").await,
        json!({ "ok": false, "message": "Only local model servers can be stopped from here." })
    );
    assert_eq!(rt.stop_server("x").await, json!({ "ok": false, "message": "Provider not found." }));
    // Nothing scripted for netstat/lsof: nothing listens.
    assert_eq!(
        rt.stop_server("o").await,
        json!({ "ok": false, "message": "Nothing is listening on port 11434; it may already be stopped." })
    );
    // The probe is cached: `lms version` ran once.
    assert_eq!(io.runs.lock().unwrap().iter().filter(|r| *r == "lms version").count(), 1);
}

#[tokio::test]
async fn stop_server_kills_what_listens_on_the_port() {
    let providers = json!([{ "id": "v", "kind": "vllm", "baseUrl": "http://127.0.0.1:8000/v1" }]);
    let netstat = "  TCP    0.0.0.0:8000   0.0.0.0:0   LISTENING   4242\n  TCP    0.0.0.0:18000  0.0.0.0:0   LISTENING   1\n  TCP    [::]:8000   [::]:0   LISTENING   4242\n";
    let run = json!({ "netstat -ano -p tcp": netstat, "taskkill /PID 4242 /T /F": "SUCCESS" });
    let (io, rt) = rig(json!({}), run, providers);
    let out = rt.stop_server("v").await;
    if cfg!(windows) {
        assert_eq!(out, json!({ "ok": true, "message": "Stopped the server on port 8000." }));
        assert_eq!(
            *io.runs.lock().unwrap(),
            vec!["netstat -ano -p tcp".to_string(), "taskkill /PID 4242 /T /F".to_string()]
        );
    } else {
        // lsof finds nothing here: a test never signals a real pid.
        assert_eq!(io.runs.lock().unwrap()[0], "lsof -nP -iTCP:8000 -sTCP:LISTEN -t");
        let _ = out;
    }
}
