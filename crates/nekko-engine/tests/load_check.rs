//! The engine's verdict on a file: managed, external with a known version and
//! external with an unknown one, against a file with an unknown weight format,
//! one that needs a newer llama.cpp, both, and neither.

use nekko_engine::load_check::{EngineInUse, Level, LoadCheck, Source, load_check};
use serde_json::{Value, json};

fn engine(source: Source, version: Option<&str>) -> EngineInUse {
    EngineInUse { source, version: version.map(str::to_string) }
}

fn plain() -> Value {
    json!({ "name": "Qwen3 8B", "quantization": "Q4_K_M" })
}
/// PrismML's 1-bit build: tensor type 143 and the hadamard header.
fn ptq1() -> Value {
    json!({ "name": "Ternary-Bonsai-2-27B-PTQ1_0", "unknownWeightType": 143, "minEngineBuild": 11556 })
}
/// A build of known tensor types that still carries the hadamard header.
fn hadamard() -> Value {
    json!({ "name": "Ternary-Bonsai-2-27B-Q2_0", "minEngineBuild": 11556 })
}
fn foreign_only() -> Value {
    json!({ "name": "Fork", "unknownWeightType": 150 })
}

fn level(model: &Value, e: &EngineInUse) -> Option<Level> {
    load_check(model, e).map(|c| c.level)
}

#[test]
fn a_managed_engine_cannot_run_an_unknown_weight_format() {
    for version in [Some("b11224"), Some("b12436"), Some("b99999"), None] {
        let check = load_check(&foreign_only(), &engine(Source::Managed, version)).unwrap();
        assert!(check.blocked(), "{version:?}");
        assert!(check.reason.contains("GGUF tensor type 150"), "{}", check.reason);
        assert!(check.reason.contains("modified build of llama.cpp"), "{}", check.reason);
    }
    // No engine yet: the same, since the one Nekko Agent would install is stock.
    assert_eq!(level(&foreign_only(), &engine(Source::None, None)), Some(Level::Blocked));
}

#[test]
fn an_external_engine_gets_a_warning_and_the_load_goes_ahead() {
    for version in [None, Some("b11224"), Some("b12436"), Some("1 (abcdef0)")] {
        let check = load_check(&foreign_only(), &engine(Source::External, version)).unwrap();
        assert_eq!(check.level, Level::Warning, "{version:?}");
        assert!(check.reason.contains("tensor type 150") && check.reason.contains("will fail"), "{}", check.reason);
    }
}

#[test]
fn an_engine_older_than_the_file_needs_is_refused() {
    let managed = load_check(&hadamard(), &engine(Source::Managed, Some("b11224"))).unwrap();
    assert!(managed.blocked());
    assert_eq!(
        managed.reason,
        "Ternary-Bonsai-2-27B-Q2_0 needs llama.cpp b11556 or newer. Older builds load it without an error and give wrong output. The engine is too old for this file: it is b11224. Update the engine on the Model server card."
    );
    let external = load_check(&hadamard(), &engine(Source::External, Some("b11555"))).unwrap();
    assert!(external.blocked());
    assert!(
        external.reason.contains("it is b11555") && external.reason.contains("Update the llama-server"),
        "{}",
        external.reason
    );
    // The number is compared as a number, not as text.
    assert_eq!(level(&hadamard(), &engine(Source::Managed, Some("b999"))), Some(Level::Blocked));
}

#[test]
fn a_new_enough_engine_is_fine() {
    for version in ["b11556", "b11557", "b12436", "b100000"] {
        assert_eq!(level(&hadamard(), &engine(Source::Managed, Some(version))), None, "{version}");
        assert_eq!(level(&hadamard(), &engine(Source::External, Some(version))), None, "{version}");
    }
}

#[test]
fn an_engine_whose_version_is_unknown_is_warned_about_not_refused() {
    for (source, version) in [
        (Source::External, None),
        (Source::External, Some("1 (abcdef0)")),
        (Source::External, Some("master")),
        (Source::Managed, None),
        (Source::Managed, Some("")),
    ] {
        let check = load_check(&hadamard(), &engine(source, version)).unwrap();
        assert_eq!(check.level, Level::Warning, "{source:?} {version:?}");
        assert!(check.reason.contains("b11556") && check.reason.contains("could not be read"), "{}", check.reason);
    }
    // With no engine there is nothing to update or to warn about: the load says "No engine is installed."
    assert_eq!(level(&hadamard(), &engine(Source::None, None)), None);
}

#[test]
fn where_both_apply_the_weight_format_wins_on_the_managed_engine() {
    let old = load_check(&ptq1(), &engine(Source::Managed, Some("b11224"))).unwrap();
    assert!(
        old.blocked() && old.reason.contains("tensor type 143") && !old.reason.contains("too old"),
        "{}",
        old.reason
    );
    // Updating would not help it, so a current managed engine says the same.
    let current = load_check(&ptq1(), &engine(Source::Managed, Some("b12436"))).unwrap();
    assert!(current.blocked() && current.reason.contains("tensor type 143"));
    // External: a known-old engine is refused for its age (older builds read the header wrongly whatever the
    // file's own format), an unknown or new one only warned, and warnings are said together.
    let old = load_check(&ptq1(), &engine(Source::External, Some("b11224"))).unwrap();
    assert!(old.blocked() && old.reason.contains("too old"), "{}", old.reason);
    let unknown = load_check(&ptq1(), &engine(Source::External, None)).unwrap();
    assert_eq!(unknown.level, Level::Warning);
    assert!(unknown.reason.contains("tensor type 143") && unknown.reason.contains("b11556"), "{}", unknown.reason);
    let new = load_check(&ptq1(), &engine(Source::External, Some("b12436"))).unwrap();
    assert_eq!(new.level, Level::Warning);
    assert!(new.reason.contains("tensor type 143") && !new.reason.contains("b11556"), "{}", new.reason);
}

#[test]
fn a_file_with_neither_is_never_checked() {
    for source in [Source::None, Source::Managed, Source::External] {
        for version in [None, Some("b1"), Some("b12436")] {
            assert_eq!(load_check(&plain(), &engine(source, version)), None);
        }
    }
}

#[test]
fn reads_the_engine_from_an_install_report() {
    let from = |v: Value| EngineInUse::from_install(&v);
    assert_eq!(
        from(json!({ "binPath": "C:/e/llama-server.exe", "source": "managed", "version": "b11224" })),
        engine(Source::Managed, Some("b11224"))
    );
    assert_eq!(
        from(json!({ "binPath": "/usr/bin/llama-server", "source": "external", "version": "b12000" })),
        engine(Source::External, Some("b12000"))
    );
    assert_eq!(
        from(json!({ "binPath": "/usr/bin/llama-server", "source": "external" })),
        engine(Source::External, None)
    );
    assert_eq!(from(json!({ "reason": "No engine installed yet." })), engine(Source::None, None));
    assert_eq!(from(Value::Null), engine(Source::None, None));
}

#[test]
fn the_row_shape_is_level_and_reason() {
    let check = LoadCheck { level: Level::Warning, reason: "r".into() };
    assert_eq!(check.to_value(), json!({ "level": "warning", "reason": "r" }));
    assert_eq!(LoadCheck { level: Level::Blocked, reason: "r".into() }.to_value()["level"], "blocked");
}
