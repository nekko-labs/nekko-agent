//! Replays the TS host's decision-service scripts (`tests/golden/decisions.json`)
//! against the port, over the same files, the same scripted local model and
//! the same scripted TypeSafe replies.

use super::*;
use std::sync::Mutex;

/// The TS golden test's fake daemon: a dir named `bad` fails to load.
struct FakeLocal {
    status: Mutex<Value>,
    calls: Arc<Mutex<Vec<Value>>>,
}

impl LocalModel for FakeLocal {
    fn status(&self) -> BoxFuture<Value> {
        self.calls.lock().unwrap().push(json!(["decide:status"]));
        let s = self.status.lock().unwrap().clone();
        Box::pin(async move { s })
    }
    fn load(&self, req: Value) -> BoxFuture<Result<Value, String>> {
        self.calls.lock().unwrap().push(json!(["decide:load", req]));
        let dir = req["dir"].as_str().unwrap_or_default().to_string();
        let result = if dir.ends_with("bad") {
            Err("ONNX Runtime could not load the model".to_string())
        } else {
            let int8 = req["precision"] == "int8";
            let s = json!({
                "loaded": true,
                "model": req["name"],
                "dir": dir,
                "ep": if int8 { "cpu" } else { "directml" },
                "precision": req["precision"],
                "loadMs": if int8 { 0 } else { 1234 },
            });
            *self.status.lock().unwrap() = s.clone();
            Ok(s)
        };
        Box::pin(async move { result })
    }
    fn unload(&self) -> BoxFuture<()> {
        self.calls.lock().unwrap().push(json!(["decide:unload"]));
        *self.status.lock().unwrap() = json!({ "loaded": false });
        Box::pin(async {})
    }
    fn run(&self, request: Value) -> BoxFuture<Result<Value, String>> {
        self.calls.lock().unwrap().push(json!(["decide:run", request]));
        let model = nekko_js::display(&self.status.lock().unwrap()["model"]);
        Box::pin(async move {
            Ok(
                json!({ "model": model, "answers": { "dept": { "type": "choice", "choice": "billing", "probabilities": { "billing": 0.9, "technical": 0.1 } } } }),
            )
        })
    }
}

struct FakePrefs {
    settings: Mutex<Value>,
    calls: Arc<Mutex<Vec<Value>>>,
}

impl Prefs for FakePrefs {
    fn get(&self) -> BoxFuture<Value> {
        let s = self.settings.lock().unwrap().clone();
        Box::pin(async move { s })
    }
    fn save_folders(&self, dirs: Vec<String>) -> BoxFuture<Result<(), String>> {
        self.calls.lock().unwrap().push(json!(["saveFolders", dirs]));
        self.settings.lock().unwrap()["decisionModelDirs"] = json!(dirs);
        Box::pin(async { Ok(()) })
    }
}

/// A loopback TypeSafe answering the scripted replies in order, recording each request.
async fn typesafe(replies: Vec<(u16, String)>, seen: Arc<Mutex<Vec<Value>>>) -> String {
    use axum::http::{HeaderMap, Method, StatusCode, Uri};
    let replies = Arc::new(Mutex::new(std::collections::VecDeque::from(replies)));
    let app = axum::Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap, body: String| {
        let (replies, seen) = (replies.clone(), seen.clone());
        async move {
            seen.lock().unwrap().push(json!({
                "url": format!("{TYPESAFE_URL}{}", uri.path()),
                "method": method.as_str(),
                "auth": headers.get("authorization").and_then(|v| v.to_str().ok()),
                "body": if method == Method::GET { Value::Null } else { json!(body) },
            }));
            let (status, text) = replies.lock().unwrap().pop_front().unwrap_or((500, "no reply scripted".into()));
            (StatusCode::from_u16(status).unwrap(), text)
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://127.0.0.1:{port}")
}

/// The TS test's normalization: the scratch root as `<root>`, backslashes as slashes.
fn norm(v: &Value, root: &str) -> Value {
    let text = nekko_js::stringify(v);
    let escaped = serde_json::to_string(root).unwrap();
    let escaped = &escaped[1..escaped.len() - 1];
    let replaced = text.split(escaped).collect::<Vec<_>>().join("<root>").replace("\\\\", "/");
    serde_json::from_str(&replaced).unwrap()
}

#[test]
fn to_fixed_rounds_half_up_like_javascript() {
    assert_eq!(to_fixed(1.234, 1), "1.2");
    assert_eq!(to_fixed(1.25, 1), "1.3");
    assert_eq!(to_fixed(0.05, 1), "0.1");
    assert_eq!(to_fixed(0.25, 1), "0.3");
    assert_eq!(to_fixed(9.96, 1), "10.0");
    assert_eq!(to_fixed(0.843685645, 2), "0.84");
    assert_eq!(to_fixed(2.5, 0), "3");
}

#[tokio::test]
async fn replays_the_host_golden_scripts() {
    let golden: Value = serde_json::from_str(include_str!("../tests/golden/decisions.json")).unwrap();
    let root = std::env::temp_dir().join(format!("nekkod-decisions-golden-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let root_s = root.to_string_lossy().into_owned();
    let sep = if cfg!(windows) { "\\" } else { "/" };
    for script in golden["scripts"].as_array().unwrap() {
        let _ = std::fs::remove_dir_all(root.join("models"));
        for (rel, text) in golden["tree"].as_object().unwrap() {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text.as_str().unwrap()).unwrap();
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let replies = script["typesafe"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["status"].as_u64().unwrap() as u16, r["body"].as_str().unwrap().to_string()))
            .collect();
        let base = typesafe(replies, seen.clone()).await;
        let mut settings = json!({ "modelsDir": path::join(&[&root_s, "models"]) });
        if let Some(k) = script["typesafeKey"].as_str() {
            settings["typesafeApiKey"] = json!(k);
        }
        let local = Arc::new(FakeLocal { status: Mutex::new(json!({ "loaded": false })), calls: calls.clone() });
        let prefs = Arc::new(FakePrefs { settings: Mutex::new(settings), calls: calls.clone() });
        let d = Decisions::new(local, prefs, "unused".into(), base);
        for step in script["steps"].as_array().unwrap() {
            let op = step["op"].as_str().unwrap();
            let args: Vec<Value> = step["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| match a.as_str() {
                    Some(s) if s.contains("<root>") => json!(s.replacen("<root>", &root_s, 1).replace('/', sep)),
                    _ => a.clone(),
                })
                .collect();
            let channel = match op {
                "remove" => "decisions:delete".to_string(),
                other => format!("decisions:{other}"),
            };
            let mut out = match d.route(&channel, &args).await {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "error": e }),
            };
            if out["ok"].get("latencyMs").is_some() {
                out["ok"]["latencyMs"] = json!(0);
            }
            let got = json!({
                "op": op,
                "args": step["args"],
                "out": norm(&out, &root_s),
                "calls": norm(&json!(std::mem::take(&mut *calls.lock().unwrap())), &root_s),
                "requests": norm(&json!(std::mem::take(&mut *seen.lock().unwrap())), &root_s),
            });
            assert_eq!(
                nekko_js::stringify(&got),
                nekko_js::stringify(step),
                "{} / {op} {}",
                script["name"],
                step["args"]
            );
        }
    }
    let _ = std::fs::remove_dir_all(&root);
}
