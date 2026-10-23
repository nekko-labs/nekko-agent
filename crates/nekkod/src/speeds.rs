//! Decode speeds measured here: the engine router's meter hears how fast each
//! local reply decoded, and the sample is kept against the model file and this
//! machine (`nekko-machine`'s `measured.rs`), where the recommendations read it.
//!
//! Nothing happens on the reply's path: the router reports after the last
//! byte went out, and the lookup and the write run on a task of their own.

use crate::library::Library;
use nekko_infer::{DecodeSample, Meter};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// The router's meter, live once the daemon has a library to resolve model ids against.
#[derive(Default)]
pub struct SpeedMeter {
    pub sink: OnceLock<Arc<Speeds>>,
}

impl Meter for SpeedMeter {
    fn decoded(&self, model_id: String, sample: DecodeSample) {
        if let Some(speeds) = self.sink.get().cloned() {
            tokio::spawn(async move { speeds.record(model_id, sample).await });
        }
    }
}

pub struct Speeds {
    machine: Arc<nekko_machine::Machine>,
    library: Arc<Library>,
    /// Model id to its file, filled from the library on a miss.
    paths: Mutex<HashMap<String, String>>,
}

impl Speeds {
    pub fn new(machine: Arc<nekko_machine::Machine>, library: Arc<Library>) -> Arc<Self> {
        Arc::new(Self { machine, library, paths: Mutex::default() })
    }

    async fn path_of(&self, id: &str) -> Option<String> {
        if let Some(p) = self.paths.lock().unwrap().get(id) {
            return Some(p.clone());
        }
        let rows = self.library.list().await.ok()?;
        let mut paths = self.paths.lock().unwrap();
        for row in rows {
            if let (Some(id), Some(path)) =
                (row.get("id").and_then(|v| v.as_str()), row.get("path").and_then(|v| v.as_str()))
            {
                paths.insert(id.to_string(), path.to_string());
            }
        }
        paths.get(id).cloned()
    }

    async fn record(&self, model_id: String, s: DecodeSample) {
        // A model the library does not know (an external server's name) has no file to keep it against.
        if let Some(path) = self.path_of(&model_id).await {
            self.machine.record_decode(&path, s.predicted_n, s.predicted_ms, s.concurrent <= 1).await;
        }
    }
}
