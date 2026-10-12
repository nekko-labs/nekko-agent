//! spec.rs against spec.ts: `golden/spec.json` is written by
//! packages/host/src/spec.golden.test.ts from `golden/spec-cases.json`.

use nekko_store::SessionStore;
use nekko_workspace::spec;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn golden(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name)).unwrap()
}

fn temp(tag: &str) -> PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let p = std::env::temp_dir()
        .join(format!("nekko-spec-{tag}-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn norm(v: Value, root: &str) -> Value {
    match v {
        Value::String(s) if s.contains(root) => Value::String(s.replace(root, "<root>").replace('\\', "/")),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| norm(x, root)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (k, norm(x, root))).collect()),
        other => other,
    }
}

#[test]
fn every_spec_call_matches_the_ts_host() {
    let c: Value = serde_json::from_str(&golden("spec-cases.json")).unwrap();
    let (root_dir, data_dir) = (temp("root"), temp("data"));
    for (rel, text) in c["files"].as_object().unwrap() {
        let p = root_dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text.as_str().unwrap()).unwrap();
    }
    for d in c["dirs"].as_array().unwrap() {
        std::fs::create_dir_all(root_dir.join(d.as_str().unwrap())).unwrap();
    }
    std::fs::create_dir_all(data_dir.join("sessions")).unwrap();
    for (id, s) in c["sessions"].as_object().unwrap() {
        std::fs::write(data_dir.join("sessions").join(format!("{id}.json")), serde_json::to_string_pretty(s).unwrap())
            .unwrap();
    }
    let root = root_dir.to_string_lossy().into_owned();
    let w = |name: &str| nekko_tools::path::native::join(&[&root, name]);
    let settings = json!({
        "workspaces": [{ "id": "w1", "name": "w1", "path": w("w1"), "addedAt": 0 }, { "id": "w2", "name": "w2", "path": w("w2"), "addedAt": 0 }],
        "providers": [{ "id": "p", "kind": "llamacpp", "label": "Local", "baseUrl": "http://127.0.0.1:9/v1", "enabled": true }],
    });
    let store = SessionStore::new(data_dir.to_string_lossy().into_owned());
    let session = |id: &str| store.get(id).unwrap_or(Value::Null);
    let wid = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    let mut ops = Vec::new();
    for o in c["ops"].as_array().unwrap() {
        let op = o[0].as_str().unwrap();
        let sid = o.get(1).and_then(Value::as_str).unwrap_or_default().to_string();
        let out: Result<Value, String> = match op {
            "path" => spec::spec_path(&sid, &session(&sid), &settings),
            "docs" => spec::read_docs(&sid, &session(&sid), &settings, wid(o.get(2)).as_deref()),
            "toggle" => spec::toggle_task(&sid, &session(&sid), &settings, &o[2], wid(o.get(3)).as_deref()),
            "method" => spec::assert_host(&sid, &session(&sid), "Host spec access").and_then(|()| {
                if !session(&sid).is_null() {
                    store.set_spec_methodology(&sid, &spec::methodology_id(o.get(2)))?;
                }
                Ok(Value::Null)
            }),
            "field" => Ok(session(&sid).get(o[2].as_str().unwrap()).cloned().unwrap_or(Value::Null)),
            "file" => Ok(json!(std::fs::read_to_string(root_dir.join(o[1].as_str().unwrap())).unwrap())),
            "build" => {
                let s = session(&sid);
                spec::build_plan(&sid, &s, &settings, o.get(2).filter(|v| !v.is_null()), wid(o.get(3)).as_deref()).and_then(|plan| match plan {
                    Err(refusal) => Ok(json!({ "result": refusal, "request": null })),
                    Ok(plan) => {
                        let request = json!({ "system": plan.system, "prompt": plan.prompt, "model": plan.model, "temperature": 0.3 });
                        let result = spec::land(&sid, &s, &plan, o[4].as_str().unwrap())?;
                        Ok(json!({ "result": result, "request": request }))
                    }
                })
            }
            other => panic!("unknown op {other}"),
        };
        ops.push(match out {
            Ok(v) => json!({ "op": op, "result": norm(v, &root) }),
            Err(e) => json!({ "op": op, "error": e }),
        });
    }
    let toggles: Vec<Value> = c["toggles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| json!(spec::toggle_task_line(t[0].as_str().unwrap(), &t[1])))
        .collect();
    let text = format!("{}\n", nekko_js::stringify_pretty(&json!({ "ops": ops, "toggles": toggles }), "  "));
    let _ = std::fs::remove_dir_all(&root_dir);
    let _ = std::fs::remove_dir_all(&data_dir);
    let want = golden("spec.json").replace("\r\n", "\n");
    if text != want {
        for (i, (w, g)) in want.lines().zip(text.lines()).enumerate() {
            assert_eq!(g, w, "spec.json differs at line {}", i + 1);
        }
        assert_eq!(text.lines().count(), want.lines().count());
    }
}
