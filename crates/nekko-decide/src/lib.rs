//! Local decision models: Laya (Convai Innovations, Apache 2.0) on ONNX Runtime.
//!
//! A decision model does not generate text. It reads a `state` (text or JSON) and a set of
//! named, typed questions, and returns a calibrated probability distribution per question in one
//! forward pass:
//!
//! - `choice`: one option out of `criteria` (an object of label -> description, or a list),
//! - `score`: a level on an ordinal scale (`criteria` is the ordered list of levels),
//! - `noul`: the probability a statement is true.
//!
//! The request and response follow TypeSafe Jev's decision API (`/v1/decisions`), which is also
//! what Laya's own `laya-serve` speaks on `/v1/systemone`, so a Jev client works against this
//! runtime unchanged. Pre- and post-processing follow the reference `laya` package (0.3.22)
//! token for token; `tests/golden` holds that package's own outputs to prove it.
//!
//! Python is not involved at run time: the checkpoint is an ONNX export, the tokenizer is the
//! checkpoint's `tokenizer.json`, and the session runs on DirectML (Windows), CoreML (macOS) or
//! CUDA (Linux, `cuda` feature), falling back to CPU.

mod answer;
mod config;
pub mod directml;
mod encode;
mod onnx_meta;
mod pyjson;
mod question;
mod runtime;

pub use config::AgentConfig;
pub use encode::{Encoder, Row, serialize_state};
pub use question::{Kind, Question};
pub use runtime::{Ep, Precision};

use runtime::Runtime;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Request-level caps, the same as `laya-serve`'s. They bound one call's tokenizer and session
/// work; anything past them is refused before tokenizing.
pub const MAX_QUESTIONS: usize = 64;
pub const MAX_STATE_CHARS: usize = 50_000;
pub const MAX_TOTAL_OPTIONS: usize = 512;

/// Why a whole request was refused. A bad *question* is not one of these: it becomes that
/// question's error entry and the rest are still answered.
#[derive(Debug, Clone, PartialEq)]
pub enum DecideError {
    /// The body is not a decision request (400).
    BadRequest(String),
    /// Over a request cap (413).
    TooLarge(String),
    /// The session failed (500).
    Runtime(String),
}

impl DecideError {
    pub fn status(&self) -> u16 {
        match self {
            Self::BadRequest(_) => 400,
            Self::TooLarge(_) => 413,
            Self::Runtime(_) => 500,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::BadRequest(m) | Self::TooLarge(m) | Self::Runtime(m) => m,
        }
    }
}

impl std::fmt::Display for DecideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for DecideError {}

/// How to load a model directory.
#[derive(Clone, Debug)]
pub struct LoadOptions {
    /// `None`: fp16 when the directory has it, else fp32, else int8.
    pub precision: Option<Precision>,
    pub ep: Ep,
    /// The id responses report as `model`; defaults to the directory's name.
    pub name: Option<String>,
    /// A DirectML.dll the host downloaded, for a Windows whose own copy is too old
    /// (see [`directml`]).
    pub directml: Option<PathBuf>,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self { precision: None, ep: Ep::Auto, name: None, directml: None }
    }
}

/// A loaded decision model: tokenizer, budgets, temperatures and an ONNX Runtime session.
pub struct DecisionModel {
    encoder: Encoder,
    runtime: Runtime,
    pub name: String,
    pub dir: PathBuf,
    pub file: PathBuf,
    pub precision: Precision,
    pub load_ms: u64,
}

impl DecisionModel {
    /// Load `dir`: an ONNX export (`model_fp16.onnx` / `model.onnx` / `model_int8.onnx`), its
    /// `tokenizer.json` and `rl_agent_config.json`. Blocking, and seconds long for the 800 MB
    /// English checkpoint; call it off any async executor.
    pub fn load(dir: &Path, opts: &LoadOptions) -> Result<Self, String> {
        let started = Instant::now();
        if !dir.is_dir() {
            return Err(format!("{} is not a directory", dir.display()));
        }
        let (precision, file) = match opts.precision {
            Some(p) => (p, p.find(dir).ok_or_else(|| format!("no {} model file in {}", p.name(), dir.display()))?),
            None => [Precision::Fp16, Precision::Fp32, Precision::Int8]
                .into_iter()
                .find_map(|p| p.find(dir).map(|f| (p, f)))
                .ok_or_else(|| format!("no model_fp16.onnx, model.onnx or model_int8.onnx in {}", dir.display()))?,
        };
        if let Some(opset) = onnx_meta::default_opset(&file)?
            && opset < onnx_meta::MIN_OPSET
        {
            return Err(format!(
                "{} is an opset {opset} export; Laya needs a dynamic-shape export (opset {} or later, from laya's scripts/export_onnx.py). Opset-14 traces such as tozp/laya-onnx bake in a 512-token length and answer wrongly.",
                file.display(),
                onnx_meta::MIN_OPSET
            ));
        }
        let encoder = Encoder::load(dir)?;
        let runtime = Runtime::open(&file, opts.ep, encoder.pad, encoder.config.max_len, opts.directml.as_deref())?;
        let name = opts.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
            dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "laya".into())
        });
        Ok(Self {
            encoder,
            runtime,
            name,
            dir: dir.to_path_buf(),
            file,
            precision,
            load_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// The execution provider the session actually runs on.
    pub fn ep(&self) -> Ep {
        self.runtime.ep
    }

    /// For `decide:status`.
    pub fn status(&self) -> Value {
        json!({
            "loaded": true,
            "model": self.name,
            "dir": self.dir,
            "file": self.file,
            "precision": self.precision,
            "ep": self.runtime.ep.name(),
            "epFallbacks": self.runtime.fallbacks,
            "loadMs": self.load_ms,
            "maxLen": self.encoder.config.max_len,
            "headMaxLen": self.encoder.config.head_max_len,
            "clampedTemperatures": self.encoder.config.clamped,
        })
    }

    pub fn encoder(&self) -> &Encoder {
        &self.encoder
    }

    /// Answer a Jev-shaped request, `{model?, state, questions}`. Blocking (one forward pass).
    pub fn decide(&self, request: &Value) -> Result<Value, DecideError> {
        let started = Instant::now();
        let (state, questions) = parse_request(request)?;
        let (state_ids, truncate_left) = self.encoder.state_tokens(state).map_err(DecideError::Runtime)?;

        let mut answers: Map<String, Value> = Map::new();
        let mut rows = Vec::new();
        let mut asked: Vec<Question> = Vec::new();
        for (id, def) in questions {
            let row = Question::parse(id, def).and_then(|q| {
                let row = self.encoder.row(&q, &state_ids, truncate_left)?;
                Ok((q, row))
            });
            match row {
                Ok((q, row)) => {
                    // Reserve the slot so answers come back in the caller's question order.
                    answers.insert(id.clone(), Value::Null);
                    asked.push(q);
                    rows.push(row);
                }
                Err(message) => {
                    let kind = def.get("type").cloned().unwrap_or(Value::Null);
                    answers.insert(id.clone(), json!({ "type": kind, "error": message }));
                }
            }
        }

        let mut usage = json!({
            "input_tokens": rows.iter().map(|r| r.ids.len()).sum::<usize>(),
            "output_tokens": 0,
            "state_tokens": state_ids.len(),
            "state_tokens_dropped": rows.iter().map(|r| r.state_tokens - r.state_used).max().unwrap_or(0),
            "truncated": rows.iter().any(|r| r.state_used < r.state_tokens),
            "truncated_questions": asked.iter().zip(&rows).filter(|(_, r)| r.state_used < r.state_tokens).map(|(q, _)| q.id.clone()).collect::<Vec<_>>(),
        });
        let collapsed: Map<String, Value> = asked
            .iter()
            .zip(&rows)
            .filter(|(q, r)| r.options_distinct < q.options.len())
            .map(|(q, r)| {
                (q.id.clone(), json!({ "total": q.options.len(), "distinct": r.options_distinct, "tokens_per_option": r.tokens_per_option }))
            })
            .collect();
        if !collapsed.is_empty() {
            usage["options"] = Value::Object(collapsed);
        }

        if !rows.is_empty() {
            let out = self.runtime.run(&rows, self.encoder.pad).map_err(DecideError::Runtime)?;
            for (i, (q, row)) in asked.iter().zip(&rows).enumerate() {
                let k = row.markers.len();
                let logits = &out.logits[i * out.logits_width..i * out.logits_width + k.min(out.logits_width)];
                let act = &out.act[i * out.act_width..(i + 1) * out.act_width];
                answers.insert(q.id.clone(), answer::answer(q, &self.encoder.config, logits, act));
            }
        }
        Ok(json!({
            "model": self.name,
            "answers": answers,
            "usage": usage,
            "latency_ms": (started.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0,
        }))
    }
}

/// The request's state and questions, with the request-level caps applied.
fn parse_request(request: &Value) -> Result<(&Value, &Map<String, Value>), DecideError> {
    let Some(body) = request.as_object() else {
        return Err(DecideError::BadRequest("the request must be an object with 'state' and 'questions'".into()));
    };
    let state = match body.get("state") {
        None | Some(Value::Null) => return Err(DecideError::BadRequest("'state' is required".into())),
        Some(s) => s,
    };
    let Some(questions) = body.get("questions").and_then(Value::as_object) else {
        return Err(DecideError::BadRequest("'questions' must be an object of question id -> definition".into()));
    };
    if questions.len() > MAX_QUESTIONS {
        return Err(DecideError::TooLarge(format!("too many questions ({} > {MAX_QUESTIONS})", questions.len())));
    }
    let total: usize = questions
        .values()
        .filter_map(|q| q.get("criteria"))
        .map(|c| match c {
            Value::Array(a) => a.len(),
            Value::Object(o) => o.len(),
            _ => 0,
        })
        .sum();
    if total > MAX_TOTAL_OPTIONS {
        return Err(DecideError::TooLarge(format!(
            "too many answer options across questions ({total} > {MAX_TOTAL_OPTIONS})"
        )));
    }
    let chars = serialize_state(state).0.chars().count();
    if chars > MAX_STATE_CHARS {
        return Err(DecideError::TooLarge(format!("state too large ({chars} > {MAX_STATE_CHARS} chars)")));
    }
    Ok((state, questions))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_checked_before_tokenizing() {
        let bad = [
            json!("nope"),
            json!({"questions": {}}),
            json!({"state": null, "questions": {}}),
            json!({"state": "x", "questions": []}),
        ];
        for b in bad {
            assert_eq!(parse_request(&b).unwrap_err().status(), 400, "{b}");
        }
        let many: Map<String, Value> =
            (0..65).map(|i| (format!("q{i}"), json!({"type": "noul", "instructions": "x"}))).collect();
        assert_eq!(parse_request(&json!({"state": "x", "questions": many})).unwrap_err().status(), 413);
        let long = "x".repeat(MAX_STATE_CHARS + 1);
        assert_eq!(parse_request(&json!({"state": long, "questions": {}})).unwrap_err().status(), 413);
        assert!(parse_request(&json!({"state": "", "questions": {}})).is_ok());
    }
}
