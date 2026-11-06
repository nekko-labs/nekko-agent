//! `nekko-bench`: the same model file through several local inference servers,
//! measured the same way.
//!
//! The harness measures; it does not start servers. Each server is started
//! beforehand with the same GGUF at the same quantization (see
//! `docs/benchmarks.md` for the exact commands used), and listed in a config:
//!
//! ```json
//! { "machine": "RTX 5090, Windows 11", "model": "gemma-4-12B-it Q4_K_M",
//!   "repeats": 3,
//!   "targets": [ { "name": "Nekko Agent engine", "baseUrl": "http://127.0.0.1:18080/v1", "model": "gemma" } ] }
//! ```
//!
//! `nekko-bench <config.json> [--out results.json] [--markdown results.md] [--only decode,agent]`
//!
//! `nekko-bench switch <config.json> ...` measures model switching instead
//! (see `switch.rs`).

mod client;
mod switch;
mod workloads;

use client::Target;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use workloads::Metrics;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    machine: String,
    model: String,
    #[serde(default = "three")]
    repeats: usize,
    targets: Vec<Target>,
}

fn three() -> usize {
    3
}

const WORKLOADS: &[&str] = &["decode", "prefill", "agent", "rotate", "code-edit", "concurrent"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    machine: String,
    model: String,
    repeats: usize,
    /// target name -> workload -> metrics (or the error that stopped it).
    results: BTreeMap<String, BTreeMap<String, Result<Metrics, String>>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1).peekable();
    if args.peek().map(String::as_str) == Some("switch") {
        args.next();
        return switch::run(args).await;
    }
    let config_path = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: nekko-bench <config.json> [--out f] [--markdown f] [--only a,b]"))?;
    let (mut out, mut md, mut only) = (None, None, None::<Vec<String>>);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--out" => out = args.next(),
            "--markdown" => md = args.next(),
            "--only" => only = args.next().map(|s| s.split(',').map(str::to_string).collect()),
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    let cfg: Config = serde_json::from_str(&std::fs::read_to_string(&config_path)?)?;
    let http = reqwest::Client::builder().no_proxy().build()?;
    let chosen: Vec<&str> =
        WORKLOADS.iter().copied().filter(|w| only.as_ref().is_none_or(|o| o.iter().any(|x| x == w))).collect();

    let mut report = Report { machine: cfg.machine, model: cfg.model, repeats: cfg.repeats, results: BTreeMap::new() };
    for target in &cfg.targets {
        eprintln!("== {} ({})", target.name, target.base_url);
        let per = report.results.entry(target.name.clone()).or_default();
        if let Err(e) = workloads::warm_up(&http, target).await {
            eprintln!("   warm-up failed: {e}");
            for w in &chosen {
                per.insert(w.to_string(), Err(format!("warm-up failed: {e}")));
            }
            continue;
        }
        for w in &chosen {
            let r = match *w {
                "decode" => workloads::decode(&http, target, cfg.repeats).await,
                "prefill" => workloads::prefill(&http, target, cfg.repeats).await,
                "agent" => workloads::agent(&http, target, cfg.repeats).await,
                "rotate" => workloads::rotate(&http, target, cfg.repeats).await,
                "code-edit" => workloads::code_edit(&http, target, cfg.repeats).await,
                "concurrent" => workloads::concurrent(&http, target, cfg.repeats).await,
                _ => unreachable!(),
            };
            eprintln!(
                "   {w}: {}",
                r.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default()).unwrap_or_else(|e| e.to_string())
            );
            per.insert(w.to_string(), r.map_err(|e| e.to_string()));
        }
    }

    let json = serde_json::to_string_pretty(&report)?;
    match out {
        Some(p) => std::fs::write(p, &json)?,
        None => println!("{json}"),
    }
    if let Some(p) = md {
        std::fs::write(p, markdown(&report))?;
    }
    Ok(())
}

fn fmt(v: Option<f64>, unit: &str) -> String {
    v.map(|x| if x >= 100.0 { format!("{x:.0} {unit}") } else { format!("{x:.1} {unit}") })
        .unwrap_or_else(|| "n/a".into())
}

fn markdown(r: &Report) -> String {
    let names: Vec<&String> = r.results.keys().collect();
    let mut s = format!(
        "Model: **{}** · Machine: **{}** · median of {} runs\n\n| Measure | {} |\n| --- |{}\n",
        r.model,
        r.machine,
        r.repeats,
        names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(" | "),
        " --- |".repeat(names.len())
    );
    type Getter = fn(&Metrics) -> Option<f64>;
    let rows: &[(&str, &str, &str, Getter)] = &[
        ("decode", "Decode, tokens/s", "tok/s", |m| m.decode_tps),
        ("decode", "Time to first token, short prompt", "ms", |m| m.ttft_ms),
        ("prefill", "Prefill of an 8k-token prompt, tokens/s", "tok/s", |m| m.prefill_tps),
        ("agent", "Agent session, first turn to first token", "ms", |m| m.first_turn_ttft_ms),
        ("agent", "Agent session, later turns to first token", "ms", |m| m.later_turns_ttft_ms),
        ("agent", "Agent session, six turns end to end", "ms", |m| m.total_ms),
        ("rotate", "Six chats in turn, revisit to first token", "ms", |m| m.later_turns_ttft_ms),
        ("rotate", "Six chats in turn, three rounds end to end", "ms", |m| m.total_ms),
        ("code-edit", "Code edit (output repeats input), tokens/s", "tok/s", |m| m.decode_tps),
        ("concurrent", "Four requests at once, total tokens/s", "tok/s", |m| m.aggregate_tps),
    ];
    for (workload, label, unit, get) in rows {
        let cells: Vec<String> = names
            .iter()
            .map(|n| match r.results.get(*n).and_then(|w| w.get(*workload)) {
                Some(Ok(m)) => fmt(get(m), unit),
                Some(Err(_)) => "failed".into(),
                None => "not run".into(),
            })
            .collect();
        if cells.iter().any(|c| c != "not run") {
            s.push_str(&format!("| {label} | {} |\n", cells.join(" | ")));
        }
    }
    s
}
