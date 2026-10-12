//! Latency of one decision call, for docs/decision-models.md.
//!
//! ```text
//! cargo run --release -p nekko-decide --example latency -- <model dir> [auto|cpu|directml|coreml|cuda] [fp16|fp32|int8] [iterations]
//! ```
//!
//! Loads the model, warms up, then times a 1-question and a 10-question call on the README's
//! support-ticket state and prints p50 / p95 / mean in milliseconds.

use nekko_decide::{DecisionModel, Ep, LoadOptions, Precision};
use serde_json::{Map, Value, json};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(dir) = args.first() else {
        eprintln!("usage: latency <model dir> [ep] [precision] [iterations]");
        std::process::exit(2);
    };
    let ep = args.get(1).and_then(|e| Ep::parse(e)).unwrap_or(Ep::Auto);
    let precision = args.get(2).and_then(|p| Precision::parse(p));
    let iterations: usize = args.get(3).and_then(|n| n.parse().ok()).unwrap_or(50);
    let model = match DecisionModel::load(
        std::path::Path::new(dir),
        &LoadOptions { precision, ep, ..LoadOptions::default() },
    ) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("load failed: {e}");
            std::process::exit(1);
        }
    };
    println!("loaded {} ({:?}) on {} in {} ms", model.name, model.precision, model.ep().name(), model.load_ms);
    if let Some(f) = model.status()["epFallbacks"].as_array().filter(|f| !f.is_empty()) {
        println!("fallbacks: {f:?}");
    }

    let state = json!({
        "from": "user@acme.com",
        "subject": "Duplicate charge on invoice #4411",
        "body": "Hi, we were billed twice for March. Please refund the duplicate today or we will cancel our plan."
    });
    let pool = [
        json!({"type": "choice", "instructions": "Which department should handle this request?",
               "criteria": {"billing": "invoices, payments, refunds", "technical": "bugs, outages, system errors",
                            "sales": "pricing, new contracts", "other": "everything else"}}),
        json!({"type": "score", "instructions": "How urgent is this request?", "criteria": ["not urgent", "soon", "critical deadline or blocking issue"]}),
        json!({"type": "noul", "instructions": "Does the user threaten to cancel or leave?"}),
        json!({"type": "noul", "instructions": "Does the user explicitly request a refund?"}),
        json!({"type": "noul", "instructions": "Is the tone polite?"}),
        json!({"type": "choice", "instructions": "Which month is mentioned?", "criteria": ["January", "February", "March", "April"]}),
        json!({"type": "score", "instructions": "How angry is the customer?", "criteria": ["calm", "annoyed", "angry", "furious"]}),
        json!({"type": "noul", "instructions": "Is an invoice number mentioned?"}),
        json!({"type": "choice", "instructions": "What is the requested action?", "criteria": {"refund": "money back", "fix": "correct the invoice", "info": "explain"}}),
        json!({"type": "noul", "instructions": "Is this spam?"}),
    ];
    for n in [1usize, 10] {
        let questions: Map<String, Value> =
            pool.iter().take(n).enumerate().map(|(i, q)| (format!("q{i}"), q.clone())).collect();
        let request = json!({ "state": state, "questions": questions });
        for _ in 0..3 {
            model.decide(&request).expect("decide");
        }
        let mut ms: Vec<f64> = (0..iterations)
            .map(|_| {
                let t = Instant::now();
                model.decide(&request).expect("decide");
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        ms.sort_by(|a, b| a.total_cmp(b));
        let pct = |p: f64| ms[((ms.len() as f64 - 1.0) * p).round() as usize];
        println!(
            "{n:>2} question(s): p50 {:.1} ms, p95 {:.1} ms, mean {:.1} ms ({iterations} runs)",
            pct(0.5),
            pct(0.95),
            ms.iter().sum::<f64>() / ms.len() as f64
        );
    }
}
