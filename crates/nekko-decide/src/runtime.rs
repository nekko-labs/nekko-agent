//! The ONNX Runtime session: model file choice, execution provider fallback, and the forward
//! pass.

use crate::encode::Row;
use ort::session::Session;
use ort::session::builder::{GraphOptimizationLevel, SessionBuilder};
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Which weights to run. fp16 halves the download and memory of fp32 and keeps probabilities
/// within ~0.02 of it; int8 (dynamic, weight-only) is for CPU-only machines.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Precision {
    Fp16,
    Fp32,
    Int8,
}

impl Precision {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "fp16" | "float16" | "half" => Some(Self::Fp16),
            "fp32" | "float32" | "full" => Some(Self::Fp32),
            "int8" | "q8" => Some(Self::Int8),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Fp16 => "fp16",
            Self::Fp32 => "fp32",
            Self::Int8 => "int8",
        }
    }

    /// File names this precision goes by: the tozp/laya-onnx layout first, then what laya's own
    /// `scripts/export_onnx.py` writes.
    fn files(self) -> &'static [&'static str] {
        match self {
            Self::Fp16 => &["model_fp16.onnx", "model.fp16.onnx", "laya.fp16.onnx"],
            Self::Fp32 => &["model.onnx", "laya.onnx"],
            Self::Int8 => &["model_int8.onnx", "model.int8.onnx", "laya.int8.onnx"],
        }
    }

    /// The model file for this precision in `dir`, if there is one.
    pub fn find(self, dir: &Path) -> Option<PathBuf> {
        self.files().iter().map(|f| dir.join(f)).find(|p| p.is_file())
    }
}

/// An execution provider, or `Auto` for this platform's accelerator with CPU behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ep {
    Auto,
    Cpu,
    #[serde(rename = "directml")]
    DirectMl,
    #[serde(rename = "coreml")]
    CoreMl,
    Cuda,
}

impl Ep {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "auto" | "" => Some(Self::Auto),
            "cpu" => Some(Self::Cpu),
            "directml" | "dml" => Some(Self::DirectMl),
            "coreml" => Some(Self::CoreMl),
            "cuda" => Some(Self::Cuda),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::DirectMl => "directml",
            Self::CoreMl => "coreml",
            Self::Cuda => "cuda",
        }
    }

    /// Accelerators this build can offer, best first. CPU is always tried last.
    fn accelerators() -> &'static [Ep] {
        if cfg!(windows) {
            &[Ep::DirectMl]
        } else if cfg!(target_os = "macos") {
            &[Ep::CoreMl]
        } else if cfg!(feature = "cuda") {
            &[Ep::Cuda]
        } else {
            &[]
        }
    }

    /// Whether this provider wants one fixed input shape (see [`Plan`]).
    fn wants_static_shapes(self) -> bool {
        matches!(self, Ep::DirectMl | Ep::CoreMl)
    }
}

/// Marker slots of a fixed-shape session: the next power of two above the 100-option cap.
pub const STATIC_MARKERS: usize = 128;

/// How rows are fed to the session.
///
/// DirectML only runs fast on a shape it compiled at session creation: measured on an RTX 5090
/// with the fp16 English checkpoint, a dynamic session answers its first-seen shape in 15 ms and
/// every other shape in ~85 ms (the graph is not fused for them), while a session with every
/// dimension pinned answers one 512-token row in 7.5 ms. Real requests vary in length and
/// question count on every call, so accelerated sessions pin `batch=1, seq=max_len,
/// markers=128` and run a call's rows one after another. CoreML also compiles per shape, so it
/// gets the same plan. CPU and CUDA handle dynamic shapes well and batch every row of a call in
/// one run, padded to the longest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Plan {
    Dynamic,
    Static { seq: usize, markers: usize },
}

/// A loaded session and what it actually runs on.
pub struct Runtime {
    session: Mutex<Session>,
    pub ep: Ep,
    plan: Plan,
    /// Accelerators that were tried and refused, with ONNX Runtime's reason.
    pub fallbacks: Vec<String>,
    logits_name: String,
    act_name: String,
}

/// The two heads for a set of rows, row-major.
pub struct Outputs {
    pub logits: Vec<f32>,
    pub logits_width: usize,
    pub act: Vec<f32>,
    pub act_width: usize,
}

fn builder_for(ep: Ep, plan: Plan) -> ort::Result<SessionBuilder> {
    let mut b = Session::builder()?.with_optimization_level(GraphOptimizationLevel::All)?;
    if let Plan::Static { seq, markers } = plan {
        // The dimension names every Laya export uses (laya's scripts/export_onnx.py and the
        // tozp/laya-onnx export alike). An export with other names stays dynamic and still
        // works, only slower.
        b = b
            .with_dimension_override("batch_size", 1)?
            .with_dimension_override("seq_len", seq as i64)?
            .with_dimension_override("num_markers", markers as i64)?;
    }
    Ok(match ep {
        Ep::Cpu | Ep::Auto => b,
        // DirectML runs neither memory patterns nor parallel execution.
        #[cfg(windows)]
        Ep::DirectMl => b
            .with_memory_pattern(false)?
            .with_parallel_execution(false)?
            .with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])?,
        #[cfg(target_os = "macos")]
        Ep::CoreMl => {
            use ort::ep::coreml::{ComputeUnits, ModelFormat};
            b.with_execution_providers([ort::ep::CoreML::default()
                .with_model_format(ModelFormat::MLProgram)
                .with_compute_units(ComputeUnits::All)
                .with_static_input_shapes(true)
                .build()
                .error_on_failure()])?
        }
        #[cfg(feature = "cuda")]
        Ep::Cuda => b.with_execution_providers([ort::ep::CUDA::default().build().error_on_failure()])?,
        #[allow(unreachable_patterns)]
        other => return Err(ort::Error::new(format!("{} is not built into this runtime", other.name()))),
    })
}

/// Two rows of different lengths and option counts, one of each head path: enough to make a
/// provider compile every kernel the real requests use. Token ids are arbitrary vocabulary.
fn probe_rows() -> Vec<Row> {
    let row = |ids: Vec<i64>, markers: Vec<i64>, qtype: i64| Row {
        ids,
        markers,
        qtype,
        state_tokens: 0,
        state_used: 0,
        options_distinct: 0,
        tokens_per_option: None,
    };
    vec![
        row(vec![1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008], vec![2, 4, 6], 0),
        row(vec![1000, 1001, 1002, 1003, 1004], vec![1, 3], 2),
    ]
}

impl Runtime {
    /// Open `model` on the preferred provider, falling back through the platform's
    /// accelerator to CPU. A provider that registers but cannot build or run this graph (a
    /// missing driver, an op it does not implement) is a fallback, not an error: every session
    /// runs a small probe batch before it is accepted, so that surfaces here and not on a
    /// user's first request. The probe also pays the provider's one-off compile cost up front.
    pub fn open(model: &Path, prefer: Ep, pad: i64, max_len: usize, directml: Option<&Path>) -> Result<Self, String> {
        let order: Vec<Ep> = match prefer {
            Ep::Auto => Ep::accelerators().iter().copied().chain([Ep::Cpu]).collect(),
            Ep::Cpu => vec![Ep::Cpu],
            other => vec![other, Ep::Cpu],
        };
        let mut fallbacks = Vec::new();
        for ep in order {
            // nekkod delay-loads DirectML.dll: load a new enough copy before ONNX Runtime binds
            // the name, or skip the provider rather than let it bind Windows 10's old one.
            if ep == Ep::DirectMl
                && let Err(e) = crate::directml::prepare(directml)
            {
                fallbacks.push(format!("{}: {e}", ep.name()));
                continue;
            }
            let plan = if ep.wants_static_shapes() {
                Plan::Static { seq: max_len, markers: STATIC_MARKERS }
            } else {
                Plan::Dynamic
            };
            let opened = builder_for(ep, plan)
                .and_then(|mut b| b.commit_from_file(model))
                .map_err(|e| e.to_string())
                .and_then(|session| Self::accept(session, ep, plan, model))
                .and_then(|rt| rt.run(&probe_rows(), pad).map(|_| rt));
            match opened {
                Ok(mut rt) => {
                    rt.fallbacks = fallbacks;
                    return Ok(rt);
                }
                Err(e) if ep != Ep::Cpu => fallbacks.push(format!("{}: {e}", ep.name())),
                Err(e) => return Err(format!("couldn't open {}: {e}", model.display())),
            }
        }
        Err(format!("couldn't open {}: no execution provider accepted it ({})", model.display(), fallbacks.join("; ")))
    }

    fn accept(session: Session, ep: Ep, plan: Plan, model: &Path) -> Result<Self, String> {
        let names: Vec<String> = session.outputs().iter().map(|o| o.name().to_string()).collect();
        if names.len() < 2 {
            return Err(format!(
                "{} has {} outputs; a decision model has logits and act",
                model.display(),
                names.len()
            ));
        }
        // `logits` then the act head, whatever the exporter named it (`act`, `act_logits`).
        let logits_name = names.iter().find(|n| n.as_str() == "logits").unwrap_or(&names[0]).clone();
        let act_name = names.iter().find(|n| **n != logits_name).cloned().unwrap_or_default();
        Ok(Self { session: Mutex::new(session), ep, plan, fallbacks: Vec::new(), logits_name, act_name })
    }

    /// Every row's logits and act logits, in row order.
    pub fn run(&self, rows: &[Row], pad: i64) -> Result<Outputs, String> {
        match self.plan {
            Plan::Dynamic => {
                let len = rows.iter().map(|r| r.ids.len()).max().unwrap_or(1);
                // At least two marker slots: the exported act head takes the top two
                // probabilities, and the torch reference pads a lone option the same way (an
                // extra slot at -1e4).
                let width = rows.iter().map(|r| r.markers.len()).max().unwrap_or(1).max(2);
                self.forward(rows, pad, len, width)
            }
            Plan::Static { seq, markers } => {
                let mut all = Outputs { logits: Vec::new(), logits_width: 0, act: Vec::new(), act_width: 0 };
                for row in rows {
                    let out = self.forward(std::slice::from_ref(row), pad, seq, markers)?;
                    all.logits.extend(out.logits);
                    all.act.extend(out.act);
                    all.logits_width = out.logits_width;
                    all.act_width = out.act_width;
                }
                Ok(all)
            }
        }
    }

    /// One session run over `rows`, padded to `len` tokens and `width` marker slots.
    fn forward(&self, rows: &[Row], pad: i64, len: usize, width: usize) -> Result<Outputs, String> {
        let n = rows.len();
        let mut ids = vec![pad; n * len];
        let mut mask = vec![0i64; n * len];
        let mut pos = vec![0i64; n * width];
        let mut pos_mask = vec![false; n * width];
        let mut qtype = vec![0i64; n];
        for (i, r) in rows.iter().enumerate() {
            if r.ids.len() > len || r.markers.len() > width {
                return Err(format!(
                    "a row of {} tokens / {} options exceeds {len} / {width}",
                    r.ids.len(),
                    r.markers.len()
                ));
            }
            ids[i * len..i * len + r.ids.len()].copy_from_slice(&r.ids);
            mask[i * len..i * len + r.ids.len()].fill(1);
            pos[i * width..i * width + r.markers.len()].copy_from_slice(&r.markers);
            pos_mask[i * width..i * width + r.markers.len()].fill(true);
            qtype[i] = r.qtype;
        }
        let tensor_err = |e: ort::Error| format!("input tensor: {e}");
        let inputs = ort::inputs! {
            "input_ids" => Tensor::from_array(([n, len], ids)).map_err(tensor_err)?,
            "attention_mask" => Tensor::from_array(([n, len], mask)).map_err(tensor_err)?,
            "marker_pos" => Tensor::from_array(([n, width], pos)).map_err(tensor_err)?,
            "marker_mask" => Tensor::from_array(([n, width], pos_mask)).map_err(tensor_err)?,
            "qtype" => Tensor::from_array(([n], qtype)).map_err(tensor_err)?,
        };
        // A poisoned lock only means an earlier run panicked inside ONNX Runtime's wrapper; the
        // session itself holds no Rust state that panic could have left half-written.
        let mut session = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let outputs = session.run(inputs).map_err(|e| format!("inference failed: {e}"))?;
        let take = |name: &str| -> Result<(Vec<f32>, usize), String> {
            let value = outputs.get(name).ok_or_else(|| format!("the model returned no {name}"))?;
            let (shape, data) = value.try_extract_tensor::<f32>().map_err(|e| format!("{name}: {e}"))?;
            let cols = shape.get(1).copied().unwrap_or(1).max(1) as usize;
            if data.len() != n * cols {
                return Err(format!("{name}: expected {n} rows, got shape {shape}"));
            }
            Ok((data.to_vec(), cols))
        };
        let (logits, logits_width) = take(&self.logits_name)?;
        let (act, act_width) = take(&self.act_name)?;
        Ok(Outputs { logits, logits_width, act, act_width })
    }
}
