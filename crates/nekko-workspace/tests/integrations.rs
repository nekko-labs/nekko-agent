//! integrations.rs against integrations.ts: `golden/integrations.json` is
//! written by packages/host/src/integrations.golden.test.ts from
//! `golden/integrations-cases.json`.

use nekko_workspace::integrations;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn golden(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name)).unwrap()
}

fn temp() -> PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let p = std::env::temp_dir()
        .join(format!("nekko-integrations-home-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn norm(v: Value, home: &str, key: Option<&str>) -> Value {
    match v {
        Value::String(s) if s.contains(home) => Value::String(s.replace(home, "<home>").replace('\\', "/")),
        Value::String(s) if key == Some("message") => Value::String(s.replace('\\', "/")),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| norm(x, home, None)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (k.clone(), norm(x, home, Some(&k)))).collect()),
        other => other,
    }
}

fn remove(p: &Path) {
    if p.is_dir() {
        let _ = std::fs::remove_dir_all(p);
    } else {
        let _ = std::fs::remove_file(p);
    }
}

#[test]
fn detection_installs_refreshes_and_snippets_match_the_ts_host() {
    let c: Value = serde_json::from_str(&golden("integrations-cases.json")).unwrap();
    let home_dir = temp();
    for (rel, text) in c["home"].as_object().unwrap() {
        std::fs::write(home_dir.join(rel), text.as_str().unwrap()).unwrap();
    }
    let home = home_dir.to_string_lossy().into_owned();
    let none = Value::Null;
    let mut ops = Vec::new();
    for o in c["ops"].as_array().unwrap() {
        let op = o[0].as_str().unwrap();
        let a = |i: usize| o.get(i).unwrap_or(&none);
        let at = |i: usize| home_dir.join(a(i).as_str().unwrap());
        let out: Result<Value, String> = match op {
            "detect" => Ok(integrations::detect(&home)),
            "install" => integrations::install(&home, a(1), a(2)),
            "refresh" => integrations::refresh(&home, a(1), a(2)).map(Value::Bool),
            "snippet" => Ok(integrations::snippet(a(1), a(2))),
            "read" => Ok(std::fs::read_to_string(at(1)).map(Value::String).unwrap_or(Value::Null)),
            "write" => {
                std::fs::create_dir_all(at(1).parent().unwrap()).unwrap();
                std::fs::write(at(1), a(2).as_str().unwrap()).unwrap();
                Ok(Value::Null)
            }
            "mkdir" => {
                std::fs::create_dir_all(at(1)).unwrap();
                Ok(Value::Null)
            }
            "rm" => {
                remove(&at(1));
                Ok(Value::Null)
            }
            "ls" => {
                let mut names: Vec<String> = std::fs::read_dir(at(1))
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                Ok(json!(names))
            }
            other => panic!("unknown op {other}"),
        };
        ops.push(match out {
            Ok(v) => json!({ "op": op, "result": norm(v, &home, None) }),
            Err(e) => json!({ "op": op, "error": e }),
        });
    }
    let _ = std::fs::remove_dir_all(&home_dir);
    let expected: Value = serde_json::from_str(&golden("integrations.json")).unwrap();
    let expected = expected["ops"].as_array().unwrap();
    assert_eq!(ops.len(), expected.len());
    for (i, (got, want)) in ops.iter().zip(expected).enumerate() {
        assert_eq!(got, want, "op {i}: {}", c["ops"][i]);
    }
}
