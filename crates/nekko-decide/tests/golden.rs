//! Parity with the reference `laya` package (0.3.22, torch, CPU, fp32).
//!
//! `tests/golden/cases.json` holds 60 requests (all three question types, 1 to 30 options,
//! states from empty to far past the 512-token window, JSON and conversation states, unicode)
//! and `golden.json` what the official package answered with the English checkpoint, plus a
//! fingerprint of the exact token sequence it built for every question.
//! `golden-multilingual.json` and `golden-typed-decisions.json` are the same cases answered by
//! the other two checkpoints (`LAYA_GOLDEN=multilingual|typed-decisions`). All three are written
//! by `scripts/decision-models/reference.py`.
//!
//! Needs a model directory, so it only runs when `LAYA_MODEL_DIR` points at one (an ONNX
//! export plus `tokenizer.json` and `rl_agent_config.json`); CI does not download 800 MB.
//! `LAYA_PRECISION` (fp16 default, fp32, int8) and `LAYA_EP` (auto default, cpu, directml,
//! coreml, cuda) pick the session; `LAYA_GOLDEN_REPORT=1` prints the comparison without
//! failing, for measuring someone else's export.
//!
//! Tolerances, absolute on every probability (responses are rounded to 4 places, like the
//! reference): fp32 1e-3 (the same maths in a different kernel order; measured 1e-4), fp16
//! 2e-2 (fp16 weights and activations through 28 encoder layers move a logit by up to ~0.01,
//! which after the temperature softmax moves a probability by under 0.02; measured 0.014 on
//! CPU and 0.018 on DirectML), int8 0.06 (block-wise weight-only int8, see
//! docs/decision-models.md; measured 0.048). fp32 and fp16 must also pick the same answer on
//! every question; int8 reports its argmax flips instead of failing on them, because a
//! different int8 recipe legitimately moves near-ties.

use nekko_decide::{DecisionModel, Encoder, Ep, LoadOptions, Precision, Question};
use serde_json::Value;
use std::path::PathBuf;

/// The reference answers for the checkpoint under test: `golden.json` is the English one, and
/// `LAYA_GOLDEN=multilingual` or `typed-decisions` picks `golden-<name>.json` (same cases).
fn golden() -> (Vec<Value>, Vec<Value>) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden");
    let read = |f: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(dir.join(f)).unwrap()).unwrap() };
    let file = match std::env::var("LAYA_GOLDEN").ok().filter(|g| !g.is_empty() && g != "en") {
        Some(name) => format!("golden-{name}.json"),
        None => "golden.json".into(),
    };
    let cases = read("cases.json")["cases"].as_array().unwrap().clone();
    let golden = read(&file)["golden"].as_array().unwrap().clone();
    assert_eq!(cases.len(), golden.len());
    (cases, golden)
}

fn model_dir() -> Option<PathBuf> {
    match std::env::var_os("LAYA_MODEL_DIR") {
        Some(d) => Some(PathBuf::from(d)),
        None => {
            eprintln!("skipped: set LAYA_MODEL_DIR to a Laya ONNX model directory to run the golden tests");
            None
        }
    }
}

fn fnv64(ids: &[i64]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &t in ids {
        for b in (t as u32).to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("{h:016x}")
}

/// Every question's token sequence and marker positions are exactly the reference's.
#[test]
fn preprocessing_matches_the_reference_token_for_token() {
    let Some(dir) = model_dir() else { return };
    let enc = Encoder::load(&dir).unwrap();
    let (cases, golden) = golden();
    let mut checked = 0;
    for (case, gold) in cases.iter().zip(&golden) {
        let (state_ids, left) = enc.state_tokens(&case["state"]).unwrap();
        for (qid, def) in case["questions"].as_object().unwrap() {
            let q = Question::parse(qid, def).unwrap_or_else(|e| panic!("{}: {e}", case["id"]));
            let row = enc.row(&q, &state_ids, left).unwrap();
            let fp = &gold["fingerprints"][qid];
            let markers: Vec<i64> = fp["markers"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap()).collect();
            assert_eq!(row.ids.len() as u64, fp["len"].as_u64().unwrap(), "{} / {qid}: length", case["id"]);
            assert_eq!(row.markers, markers, "{} / {qid}: markers", case["id"]);
            assert_eq!(fnv64(&row.ids), fp["fnv64"].as_str().unwrap(), "{} / {qid}: token ids", case["id"]);
            checked += 1;
        }
    }
    eprintln!("preprocessing: {checked} question rows identical to laya 0.3.22");
}

/// The probabilities of every option, per case, against the reference.
#[test]
fn answers_match_the_reference() {
    let Some(dir) = model_dir() else { return };
    let precision = std::env::var("LAYA_PRECISION").ok().and_then(|p| Precision::parse(&p)).unwrap_or(Precision::Fp16);
    let ep = std::env::var("LAYA_EP").ok().and_then(|e| Ep::parse(&e)).unwrap_or(Ep::Auto);
    let model =
        DecisionModel::load(&dir, &LoadOptions { precision: Some(precision), ep, ..LoadOptions::default() }).unwrap();
    let (tol, strict_argmax) = match precision {
        Precision::Fp32 => (1e-3, true),
        Precision::Fp16 => (2e-2, true),
        Precision::Int8 => (0.06, false),
    };
    let (cases, golden) = golden();
    let (mut worst, mut worst_at) = (0.0f64, String::new());
    let (mut questions, mut agree, mut sum_err, mut n_probs) = (0, 0, 0.0, 0usize);
    let mut flips = Vec::new();
    for (case, gold) in cases.iter().zip(&golden) {
        let request = serde_json::json!({ "state": case["state"], "questions": case["questions"] });
        let res = model.decide(&request).unwrap();
        let want_usage = &gold["response"]["usage"];
        for key in ["input_tokens", "state_tokens", "state_tokens_dropped", "truncated", "truncated_questions"] {
            assert_eq!(res["usage"][key], want_usage[key], "{}: usage.{key}", case["id"]);
        }
        for (qid, want) in gold["probs"].as_object().unwrap() {
            let want: Vec<f64> = want.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            let a = &res["answers"][qid];
            assert!(a.get("error").is_none(), "{} / {qid}: {a}", case["id"]);
            let got: Vec<f64> = match a["type"].as_str().unwrap() {
                "noul" => {
                    let p = a["noul"].as_f64().unwrap();
                    vec![1.0 - p, p]
                }
                _ => a["probabilities"].as_object().unwrap().values().map(|v| v.as_f64().unwrap()).collect(),
            };
            assert_eq!(got.len(), want.len(), "{} / {qid}", case["id"]);
            for (g, w) in got.iter().zip(&want) {
                // The response rounds to 4 places, like the reference.
                let err = (g - w).abs();
                sum_err += err;
                n_probs += 1;
                if err > worst {
                    worst = err;
                    worst_at = format!("{} / {qid}", case["id"]);
                }
            }
            let argmax = |p: &[f64]| p.iter().enumerate().fold(0, |b, (i, &v)| if v > p[b] { i } else { b });
            questions += 1;
            // For a choice the answer itself must match too (same label, same JSON type).
            let same_choice = gold["response"]["answers"][qid].get("choice").is_none_or(|c| &a["choice"] == c);
            if argmax(&got) == argmax(&want) && same_choice {
                agree += 1;
            } else {
                flips.push(format!("{} / {qid}", case["id"]));
            }
        }
    }
    eprintln!(
        "answers ({precision:?} on {}): {questions} questions, argmax agreement {agree}/{questions}, max |dp| {worst:.4} at {worst_at}, mean |dp| {:.5}",
        model.ep().name(),
        sum_err / n_probs.max(1) as f64
    );
    if !flips.is_empty() {
        eprintln!("argmax flips: {}", flips.join(", "));
    }
    // LAYA_GOLDEN_REPORT=1 measures a third-party export without failing on it.
    if std::env::var_os("LAYA_GOLDEN_REPORT").is_some() {
        return;
    }
    assert!(worst <= tol, "max |dp| {worst} at {worst_at} exceeds {tol}");
    if strict_argmax {
        assert!(flips.is_empty(), "argmax differs from the reference on {flips:?}");
    }
}
