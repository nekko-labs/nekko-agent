//! Exact parity with the TS host's probes and readiness advisor, over the
//! golden set `packages/host/src/machine.golden.test.ts` writes.

use nekko_machine::parse::{
    cpuinfo_features, gpu_backends, ioreg_stats, listed_to_stats, mac_memory_used_mb, parse_list_devices,
    parse_nvidia_smi,
};
use nekko_machine::{GpuStats, MachineFacts, catalog, evaluate, num};
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/machine.json")).expect("golden set")
}

fn cases<'a>(g: &'a Value, key: &str) -> &'a Vec<Value> {
    g[key].as_array().unwrap_or_else(|| panic!("{key} cases"))
}

fn stats_text(s: Option<GpuStats>) -> String {
    nekko_js::stringify(&s.map_or(Value::Null, |s| s.to_value()))
}

fn input(c: &Value) -> &str {
    c["input"].as_str().expect("input")
}

#[test]
fn nvidia_smi_matches() {
    let g = golden();
    for c in cases(&g, "nvidiaSmi") {
        assert_eq!(stats_text(parse_nvidia_smi(input(c))), c["stats"].as_str().unwrap(), "{}", input(c));
    }
}

#[test]
fn ioreg_matches() {
    let g = golden();
    for c in cases(&g, "ioreg") {
        let total = c["totalMB"].as_f64().unwrap();
        assert_eq!(stats_text(ioreg_stats(input(c), total)), c["stats"].as_str().unwrap(), "{total}");
    }
}

#[test]
fn list_devices_matches() {
    let g = golden();
    for c in cases(&g, "listDevices") {
        assert_eq!(
            stats_text(listed_to_stats(&parse_list_devices(input(c)))),
            c["stats"].as_str().unwrap(),
            "{}",
            input(c)
        );
    }
}

#[test]
fn cpu_features_and_backends_match() {
    let g = golden();
    for c in cases(&g, "cpuinfo") {
        assert_eq!(json!(cpuinfo_features(input(c))), c["features"], "{}", input(c));
    }
    for c in cases(&g, "sysctl") {
        assert_eq!(json!(nekko_machine::parse::sysctl_features(input(c))), c["features"], "{}", input(c));
    }
    for c in cases(&g, "backends") {
        assert_eq!(json!(gpu_backends(c["smi"].as_str(), c["vk"].as_str())), c["backends"], "{c}");
    }
    for c in cases(&g, "vmStat") {
        assert_eq!(mac_memory_used_mb(input(c)).map_or(Value::Null, num), c["usedMB"], "{}", input(c));
    }
}

#[test]
fn temperature_sensors_match() {
    use nekko_machine::temps::{SensorKind, classify_sensor, fold};
    let name = |k: Option<SensorKind>| match k {
        Some(SensorKind::Cpu) => json!("cpu"),
        Some(SensorKind::Memory) => json!("memory"),
        Some(SensorKind::Gpu) => json!("gpu"),
        None => Value::Null,
    };
    let g = golden();
    for c in cases(&g, "sensors") {
        let (chip, label) = (c["chip"].as_str().unwrap(), c["label"].as_str().unwrap());
        assert_eq!(name(classify_sensor(chip, label)), c["kind"], "{chip} / {label}");
    }
    for c in cases(&g, "tempFolds") {
        let readings = c["readings"].as_array().unwrap().iter().map(|r| {
            let kind = match r[0].as_str().unwrap() {
                "cpu" => SensorKind::Cpu,
                "memory" => SensorKind::Memory,
                _ => SensorKind::Gpu,
            };
            (kind, r[1].as_f64().unwrap())
        });
        assert_eq!(fold(readings).unwrap_or(Value::Null), c["temps"], "{c}");
    }
}

#[test]
fn readiness_matches() {
    let g = golden();
    for c in cases(&g, "readiness") {
        let facts = MachineFacts::from_value(&c["facts"]).expect("facts");
        let language = c["language"].as_str().unwrap_or("en");
        let report = nekko_js::stringify(&evaluate(&facts, catalog(), language));
        assert_eq!(report, c["report"].as_str().unwrap(), "{} / {language}", c["facts"]);
    }
}
