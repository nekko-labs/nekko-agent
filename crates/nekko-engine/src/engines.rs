//! The engines that can run a chat model, which of them this machine can
//! use, and which one is in use. The Models page's Engines block reads this
//! list as it is; nothing is installed or started here.
//!
//! An engine is tied to the files it reads (llama.cpp reads GGUF, MLX reads
//! MLX folders), so "in use" is a preference, not a switch: the engine in use
//! takes every model it can run, and a model only another engine can run
//! still goes to that one.

use regress::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// What the rules read about this computer.
#[derive(Debug, Clone, Default)]
pub struct Machine {
    /// `darwin`, `win32` or `linux`.
    pub platform: String,
    /// `arm64` or `x64`.
    pub arch: String,
    /// The graphics cards' names, as the GPU probe reports them.
    pub gpus: Vec<String>,
}

struct Entry {
    id: &'static str,
    name: &'static str,
    /// One line: what it is and what it runs.
    detail: &'static str,
    /// The install channel's runtime id, when Nekko installs this engine itself.
    runtime: Option<&'static str>,
    /// Whether this version of Nekko can start it. An engine that is listed
    /// but not built yet is shown, never chosen.
    built: bool,
}

/// Every engine, in the order the ones this machine cannot run are listed.
const CATALOG: [Entry; 5] = [
    Entry {
        id: "llama",
        name: "llama.cpp",
        detail: "Runs any GGUF model, on every computer.",
        runtime: Some("llama"),
        built: true,
    },
    Entry {
        id: "mlx",
        name: "MLX",
        detail: "Apple's own framework. Runs MLX models.",
        runtime: Some("mlx"),
        built: true,
    },
    Entry {
        id: "omlx",
        name: "oMLX",
        detail: "MLX with batching and a prompt cache kept on disk.",
        runtime: None,
        built: false,
    },
    Entry {
        id: "basalt",
        name: "Basalt",
        detail: "Built for RTX 50 series cards. Runs its own model packs.",
        runtime: None,
        built: false,
    },
    Entry {
        id: "squid5090",
        name: "squid5090",
        detail: "Built for one RTX 5090. Runs Inkling 2 Mini.",
        runtime: None,
        built: false,
    },
];

/// Fastest first, on hardware that can run each. squid5090 and Basalt are
/// written for one GPU family, oMLX adds batching and a disk prompt cache to
/// MLX, and MLX is usually ahead of llama.cpp on Apple Silicon.
pub const SPEED: [&str; 5] = ["squid5090", "basalt", "omlx", "mlx", "llama"];

/// Most stable first: the two that have run the most models for the longest,
/// then the newer ones in the order they have settled.
pub const STABILITY: [&str; 5] = ["mlx", "llama", "omlx", "basalt", "squid5090"];

/// What a listed engine says until this version of Nekko can start it.
pub const NOT_BUILT: &str = "Not in this version of Nekko yet";

fn entry(id: &str) -> Option<&'static Entry> {
    CATALOG.iter().find(|e| e.id == id)
}

/// A GeForce RTX 50 series card (5050 to 5090), an RTX PRO Blackwell
/// workstation card, or the DGX Spark's GB10: NVIDIA's Blackwell generation.
/// "RTX 5000 Ada" and "Quadro RTX 5000" are older cards and do not match.
fn is_blackwell(name: &str) -> bool {
    static RTX_50: OnceLock<Regex> = OnceLock::new();
    let rtx_50 = RTX_50.get_or_init(|| Regex::with_flags(r"rtx\s*50[5-9]0", "i").expect("a valid built-in pattern"));
    let lower = name.to_lowercase();
    rtx_50.find(name).is_some() || (lower.contains("rtx pro") && lower.contains("blackwell")) || lower.contains("gb10")
}

fn is_rtx_5090(name: &str) -> bool {
    static RTX_5090: OnceLock<Regex> = OnceLock::new();
    RTX_5090
        .get_or_init(|| Regex::with_flags(r"rtx\s*5090", "i").expect("a valid built-in pattern"))
        .find(name)
        .is_some()
}

/// Why this machine cannot run an engine, as the short words its row shows
/// ("macOS only"), or `None` when it can.
pub fn unsupported_reason(id: &str, m: &Machine) -> Option<&'static str> {
    let mac = m.platform == "darwin";
    match id {
        "mlx" | "omlx" => {
            if !mac {
                Some("macOS only")
            } else if m.arch != "arm64" {
                Some("Apple Silicon only")
            } else {
                None
            }
        }
        // Linux and Windows builds exist; the card is what decides.
        "basalt" => (mac || !m.gpus.iter().any(|g| is_blackwell(g))).then_some("NVIDIA RTX 50 series only"),
        "squid5090" => {
            if mac || !m.gpus.iter().any(|g| is_rtx_5090(g)) {
                Some("NVIDIA RTX 5090 only")
            } else if m.platform != "linux" || m.arch != "x64" {
                Some("Linux only")
            } else {
                None
            }
        }
        _ => None,
    }
}

/// An engine's install on this machine, from its runtime's `detect` answer.
fn install_of<'a>(e: &Entry, installs: &'a Value) -> Option<&'a Value> {
    installs.get(e.runtime?).filter(|i| i.get("binPath").is_some_and(|p| nekko_js::truthy(Some(p))))
}

fn usable(e: &Entry, m: &Machine) -> bool {
    e.built && unsupported_reason(e.id, m).is_none()
}

/// The engine in use: the saved choice while this machine can run it and has
/// it; else the fastest usable engine that is installed; else, with nothing
/// installed, the fastest one Nekko can install; else llama.cpp.
///
/// A choice that is not installed (removed since, or synced from another
/// computer's settings) waits rather than leaving nothing in use.
pub fn in_use(m: &Machine, installs: &Value, chosen: Option<&str>) -> &'static str {
    let ranked = || SPEED.iter().filter_map(|id| entry(id)).filter(|e| usable(e, m));
    if let Some(e) = chosen.and_then(entry)
        && usable(e, m)
        && install_of(e, installs).is_some()
    {
        return e.id;
    }
    ranked()
        .find(|e| install_of(e, installs).is_some())
        .or_else(|| ranked().find(|e| e.runtime.is_some()))
        .map_or("llama", |e| e.id)
}

/// The Engines block's rows: the engines this machine can run, fastest
/// first, then the ones it cannot, each with the reason.
///
/// `installs` holds each runtime's `detect` answer under its runtime id
/// (`{ "llama": ..., "mlx": ... }`); `chosen` is the saved `chatEngine`.
pub fn list(m: &Machine, installs: &Value, chosen: Option<&str>) -> Value {
    let using = in_use(m, installs, chosen);
    let can: Vec<&Entry> = SPEED.iter().filter_map(|id| entry(id)).filter(|e| usable(e, m)).collect();
    // With one engine to pick from there is nothing to compare.
    let fastest = (can.len() > 1).then(|| can[0].id);
    let stable =
        (can.len() > 1).then(|| STABILITY.iter().find(|id| can.iter().any(|e| e.id == **id)).copied()).flatten();
    let row = |e: &Entry| {
        let mut o = Map::new();
        o.insert("id".into(), json!(e.id));
        o.insert("name".into(), json!(e.name));
        o.insert("detail".into(), json!(e.detail));
        match unsupported_reason(e.id, m) {
            Some(reason) => {
                o.insert("state".into(), json!("unsupported"));
                o.insert("reason".into(), json!(reason));
            }
            None if !e.built => {
                o.insert("state".into(), json!("planned"));
                o.insert("reason".into(), json!(NOT_BUILT));
            }
            None => {
                o.insert("state".into(), json!("usable"));
                let labels: Vec<&str> = [(fastest, "fastest"), (stable, "stable")]
                    .into_iter()
                    .filter(|(id, _)| *id == Some(e.id))
                    .map(|(_, label)| label)
                    .collect();
                if !labels.is_empty() {
                    o.insert("labels".into(), json!(labels));
                }
                if let Some(runtime) = e.runtime {
                    o.insert("runtime".into(), json!(runtime));
                }
                if let Some(install) = install_of(e, installs) {
                    o.insert("installed".into(), json!(true));
                    for k in ["version", "source"] {
                        if let Some(v) = install.get(k).filter(|v| nekko_js::truthy(Some(v))) {
                            o.insert(k.into(), v.clone());
                        }
                    }
                }
                // Nothing installed yet: no engine is in use, only next to install.
                if e.id == using && install_of(e, installs).is_some() {
                    o.insert("inUse".into(), json!(true));
                }
            }
        }
        Value::Object(o)
    };
    let state = |e: &Entry| {
        if unsupported_reason(e.id, m).is_some() {
            2
        } else if !e.built {
            1
        } else {
            0
        }
    };
    let mut rows: Vec<&Entry> = can.clone();
    for rank in [1, 2] {
        rows.extend(CATALOG.iter().filter(|e| state(e) == rank));
    }
    Value::Array(rows.into_iter().map(row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(platform: &str, arch: &str, gpus: &[&str]) -> Machine {
        Machine { platform: platform.into(), arch: arch.into(), gpus: gpus.iter().map(|g| g.to_string()).collect() }
    }

    fn both() -> Value {
        json!({
            "llama": { "binPath": "/e/llama-server", "version": "b12532", "source": "managed" },
            "mlx": { "binPath": "/e/mlx/bin/mlx_lm.server", "version": "mlx-lm 0.31.3", "source": "managed" },
        })
    }

    fn by_id<'a>(rows: &'a Value, id: &str) -> &'a Value {
        rows.as_array().unwrap().iter().find(|r| r["id"] == id).unwrap()
    }

    fn ids(rows: &Value) -> Vec<&str> {
        rows.as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect()
    }

    #[test]
    fn an_apple_silicon_mac_runs_mlx_and_llama_and_says_why_not_the_nvidia_engines() {
        let m = machine("darwin", "arm64", &["Apple M1 Max"]);
        let rows = list(&m, &both(), None);
        assert_eq!(ids(&rows), ["mlx", "llama", "omlx", "basalt", "squid5090"]);
        assert_eq!(by_id(&rows, "mlx")["labels"], json!(["fastest", "stable"]));
        assert_eq!(by_id(&rows, "mlx")["inUse"], json!(true));
        assert_eq!(by_id(&rows, "mlx")["version"], "mlx-lm 0.31.3");
        assert!(by_id(&rows, "llama").get("labels").is_none());
        assert!(by_id(&rows, "llama").get("inUse").is_none());
        assert_eq!(by_id(&rows, "omlx")["state"], "planned");
        assert_eq!(by_id(&rows, "omlx")["reason"], NOT_BUILT);
        assert_eq!(by_id(&rows, "basalt")["reason"], "NVIDIA RTX 50 series only");
        assert_eq!(by_id(&rows, "squid5090")["reason"], "NVIDIA RTX 5090 only");
    }

    #[test]
    fn an_intel_mac_and_a_pc_say_which_part_is_missing() {
        assert_eq!(unsupported_reason("mlx", &machine("darwin", "x64", &[])), Some("Apple Silicon only"));
        assert_eq!(unsupported_reason("omlx", &machine("win32", "x64", &[])), Some("macOS only"));
        let windows = machine("win32", "x64", &["NVIDIA GeForce RTX 5090"]);
        assert_eq!(unsupported_reason("squid5090", &windows), Some("Linux only"));
        assert_eq!(unsupported_reason("basalt", &windows), None);
        let linux = machine("linux", "x64", &["NVIDIA GeForce RTX 5090"]);
        assert_eq!(unsupported_reason("squid5090", &linux), None);
        assert_eq!(unsupported_reason("llama", &machine("linux", "x64", &[])), None);
    }

    #[test]
    fn blackwell_is_the_50_series_not_every_card_with_a_5_in_it() {
        for yes in [
            "NVIDIA GeForce RTX 5090",
            "NVIDIA GeForce RTX 5070 Ti",
            "GeForce RTX 5060 Ti",
            "NVIDIA GeForce RTX 5090 Laptop GPU",
            "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            "NVIDIA GB10",
        ] {
            assert!(is_blackwell(yes), "{yes}");
        }
        for no in [
            "NVIDIA GeForce RTX 4090",
            "NVIDIA RTX 5000 Ada Generation",
            "Quadro RTX 5000",
            "AMD Radeon RX 9070",
            "card0",
        ] {
            assert!(!is_blackwell(no), "{no}");
        }
        assert!(is_rtx_5090("NVIDIA GeForce RTX 5090"));
        assert!(!is_rtx_5090("NVIDIA GeForce RTX 5080"));
    }

    #[test]
    fn one_usable_engine_gets_no_label() {
        let m = machine("win32", "x64", &["NVIDIA GeForce RTX 4070"]);
        let rows = list(&m, &json!({ "llama": { "binPath": "C:/e/llama-server.exe", "version": "b12532" } }), None);
        assert_eq!(ids(&rows), ["llama", "mlx", "omlx", "basalt", "squid5090"]);
        assert!(by_id(&rows, "llama").get("labels").is_none());
        assert_eq!(by_id(&rows, "llama")["inUse"], json!(true));
        assert_eq!(by_id(&rows, "mlx")["reason"], "macOS only");
        assert_eq!(by_id(&rows, "omlx")["reason"], "macOS only");
    }

    #[test]
    fn a_saved_choice_wins_while_it_is_installed_and_waits_while_it_is_not() {
        let m = machine("darwin", "arm64", &[]);
        assert_eq!(in_use(&m, &both(), Some("llama")), "llama");
        let llama_only = json!({ "llama": { "binPath": "/e/llama-server" }, "mlx": { "available": [] } });
        // MLX was chosen (its Install was clicked) but has not landed yet.
        assert_eq!(in_use(&m, &llama_only, Some("mlx")), "llama");
        // An engine this machine cannot run, or one Nekko cannot start yet, is never in use.
        assert_eq!(in_use(&m, &both(), Some("basalt")), "mlx");
        assert_eq!(in_use(&m, &both(), Some("omlx")), "mlx");
        assert_eq!(in_use(&m, &both(), Some("nonsense")), "mlx");
    }

    #[test]
    fn with_nothing_installed_the_fastest_installable_engine_is_the_one_to_get() {
        let none = json!({ "llama": { "available": [] }, "mlx": { "available": [] } });
        assert_eq!(in_use(&machine("darwin", "arm64", &[]), &none, None), "mlx");
        assert_eq!(in_use(&machine("linux", "x64", &["NVIDIA GeForce RTX 5090"]), &none, None), "llama");
        let rows = list(&machine("darwin", "arm64", &[]), &none, None);
        assert!(by_id(&rows, "mlx").get("installed").is_none());
        assert!(rows.as_array().unwrap().iter().all(|r| r.get("inUse").is_none()));
        assert_eq!(by_id(&rows, "mlx")["runtime"], "mlx");
    }
}
