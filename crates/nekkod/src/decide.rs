//! Decision models (Laya, via `nekko-decide`), owned by the daemon.
//!
//! One model is resident at a time. The UI drives it over the `decide:*` channels, and the
//! engine router answers `POST /v1/decisions` and `/v1/systemone` from the same model, so an
//! app on the OpenAI-compatible port and the UI see one state.
//!
//! - `decide:load` `[dir, precision?]` or `[{ dir, precision?, ep?, name?, directml? }]`: load (replacing
//!   any resident model) and reply with the status below. Precision is `fp16` (the default
//!   when present), `fp32` or `int8`; ep is `auto` (default), `cpu`, `directml`, `coreml`, `cuda`;
//!   `directml` is a DirectML.dll the host downloaded, for a Windows whose own copy is too old.
//! - `decide:unload`: free it.
//! - `decide:status`: `{ loaded, model, dir, file, precision, ep, epFallbacks, loadMs, ... }`,
//!   plus `loading` while a load runs and `error` after one failed. On Windows, `directml` says
//!   whether a new enough DirectML.dll is on the machine (`nekko_decide::directml::status`).
//! - `decide:run` `[{ model?, state, questions }]`: the Jev-shaped answer.
//!
//! Loading and inference block (seconds and milliseconds of ONNX Runtime work), so both run on
//! the blocking pool and never on the socket's task.

use nekko_decide::{DecisionModel, Ep, LoadOptions, Precision};
use nekko_infer::{BoxFuture, Decisions};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct DecideService {
    model: Mutex<Option<Arc<DecisionModel>>>,
    /// The directory being loaded, while a load runs.
    loading: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    /// One load at a time; a second waits and then replaces the first.
    load_gate: tokio::sync::Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // Nothing here holds a lock across code that can panic half-way through an update.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn load_options(args: &[Value]) -> Result<(PathBuf, LoadOptions), String> {
    let first = args.first().unwrap_or(&Value::Null);
    let (dir, precision, ep, name, directml) = match first {
        Value::String(dir) => (Some(dir.as_str()), args.get(1).and_then(Value::as_str), None, None, None),
        Value::Object(o) => (
            o.get("dir").or_else(|| o.get("path")).and_then(Value::as_str),
            o.get("precision").and_then(Value::as_str),
            o.get("ep").and_then(Value::as_str),
            o.get("name").and_then(Value::as_str),
            o.get("directml").and_then(Value::as_str).filter(|p| !p.trim().is_empty()),
        ),
        _ => (None, None, None, None, None),
    };
    let dir = dir.filter(|d| !d.trim().is_empty()).ok_or("decide:load needs a model directory")?;
    let precision = match precision {
        None => None,
        Some(p) => Some(Precision::parse(p).ok_or_else(|| format!("unknown precision {p:?}; use fp16, fp32 or int8"))?),
    };
    let ep = match ep {
        None => Ep::Auto,
        Some(e) => Ep::parse(e)
            .ok_or_else(|| format!("unknown execution provider {e:?}; use auto, cpu, directml, coreml or cuda"))?,
    };
    Ok((
        PathBuf::from(dir),
        LoadOptions { precision, ep, name: name.map(str::to_string), directml: directml.map(PathBuf::from) },
    ))
}

impl DecideService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn status(&self) -> Value {
        let mut status = match lock(&self.model).as_ref() {
            Some(m) => m.status(),
            None => json!({ "loaded": false }),
        };
        if let Some(dir) = lock(&self.loading).as_ref() {
            status["loading"] = json!(dir);
        }
        if let Some(e) = lock(&self.last_error).as_ref() {
            status["error"] = json!(e);
        }
        if cfg!(windows) {
            status["directml"] = nekko_decide::directml::status(None);
        }
        status
    }

    pub async fn load(&self, args: &[Value]) -> Result<Value, String> {
        let (dir, opts) = load_options(args)?;
        let _gate = self.load_gate.lock().await;
        *lock(&self.loading) = Some(dir.display().to_string());
        // Free the old model first: two 800 MB sessions side by side is what runs a laptop GPU
        // out of memory.
        lock(&self.model).take();
        let loaded = tokio::task::spawn_blocking(move || DecisionModel::load(&dir, &opts))
            .await
            .unwrap_or_else(|e| Err(format!("the load crashed: {e}")));
        lock(&self.loading).take();
        match loaded {
            Ok(model) => {
                *lock(&self.model) = Some(Arc::new(model));
                lock(&self.last_error).take();
                Ok(self.status())
            }
            Err(e) => {
                *lock(&self.last_error) = Some(e.clone());
                Err(e)
            }
        }
    }

    pub fn unload(&self) -> Value {
        let was = lock(&self.model).take().is_some();
        lock(&self.last_error).take();
        json!({ "loaded": false, "unloaded": was })
    }

    /// Answer one request, or `(status, message)` for the HTTP side.
    pub async fn run(&self, request: Value) -> Result<Value, (u16, String)> {
        let Some(model) = lock(&self.model).clone() else {
            return Err((409, "No decision model is loaded. Load one with decide:load.".into()));
        };
        tokio::task::spawn_blocking(move || model.decide(&request).map_err(|e| (e.status(), e.message().to_string())))
            .await
            .unwrap_or_else(|e| Err((500, format!("the decision crashed: {e}"))))
    }
}

/// The router's view of the service.
pub struct RouterDecisions(pub Arc<DecideService>);

impl Decisions for RouterDecisions {
    fn decide(&self, body: Value) -> BoxFuture<Result<Value, (u16, String)>> {
        let service = self.0.clone();
        Box::pin(async move { service.run(body).await })
    }
}

/// The `decide:*` channels [`route`] serves.
pub const CHANNELS: &[&str] = &["decide:load", "decide:unload", "decide:status", "decide:run"];

/// The `decide:*` channels.
pub async fn route(service: &DecideService, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    Some(match channel {
        "decide:load" => service.load(args).await,
        "decide:unload" => Ok(service.unload()),
        "decide:status" => Ok(service.status()),
        "decide:run" => service.run(args.first().cloned().unwrap_or(Value::Null)).await.map_err(|(_, m)| m),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_arguments_take_both_shapes() {
        let (dir, o) = load_options(&[json!("/m"), json!("fp32")]).unwrap();
        assert_eq!(dir, PathBuf::from("/m"));
        assert_eq!(o.precision, Some(Precision::Fp32));
        let (_, o) = load_options(&[json!({ "dir": "/m", "ep": "cpu", "name": "laya" })]).unwrap();
        assert_eq!((o.ep, o.precision, o.name.as_deref()), (Ep::Cpu, None, Some("laya")));
        assert_eq!(o.directml, None);
        let (_, o) = load_options(&[json!({ "dir": "/m", "directml": "C:/rt/DirectML.dll" })]).unwrap();
        assert_eq!(o.directml, Some(PathBuf::from("C:/rt/DirectML.dll")));
        assert!(load_options(&[]).is_err());
        assert!(load_options(&[json!("/m"), json!("fp8")]).is_err());
        assert!(load_options(&[json!({ "dir": "/m", "ep": "tpu" })]).is_err());
    }

    #[tokio::test]
    async fn nothing_loaded_is_a_clear_409() {
        let s = DecideService::new();
        assert_eq!(s.status()["loaded"], false);
        let err = s.run(json!({ "state": "x", "questions": {} })).await.unwrap_err();
        assert_eq!(err.0, 409);
        let bad = s.load(&[json!("/definitely/not/a/model/dir")]).await.unwrap_err();
        assert!(bad.contains("not a directory"), "{bad}");
        assert!(s.status()["error"].as_str().is_some());
        assert_eq!(s.unload()["unloaded"], false);
    }
}
