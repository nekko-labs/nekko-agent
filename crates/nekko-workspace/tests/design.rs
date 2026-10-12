//! design.rs against design.ts: `golden/design.json` is written by
//! packages/host/src/design.golden.test.ts from `golden/design-cases.json`
//! (the model's answers scripted there, handed to `land` here).

use nekko_workspace::design;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

fn golden(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name)).unwrap()
}

fn temp(tag: &str) -> PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let p = std::env::temp_dir()
        .join(format!("nekko-design-{tag}-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// Replace every v4 UUID inside a string.
fn strip_uuids(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if i + 36 <= b.len() && s.is_char_boundary(i) && s.is_char_boundary(i + 36) {
            let c = &b[i..i + 36];
            let ok = c.iter().enumerate().all(|(j, x)| {
                if [8, 13, 18, 23].contains(&j) { *x == b'-' } else { x.is_ascii_digit() || (b'a'..=b'f').contains(x) }
            }) && c[14] == b'4'
                && matches!(c[19], b'8' | b'9' | b'a' | b'b');
            if ok {
                out.push_str("<uuid>");
                i += 36;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn norm(v: Value, root: &str, data: &str, key: Option<&str>) -> Value {
    match v {
        Value::String(s) => {
            let s = strip_uuids(&s);
            let mut s = if let Some(r) = s.strip_prefix(root) {
                format!("<root>{r}")
            } else if let Some(r) = s.strip_prefix(data) {
                format!("<data>{r}")
            } else {
                s
            };
            if s.starts_with("<root>") || s.starts_with("<data>") {
                s = s.replace('\\', "/");
                // `-[0-9a-f]{6}.html` at the end: the prototype's random suffix.
                if s.len() > 12 && s.ends_with(".html") {
                    let cut = s.len() - 12;
                    let tail = &s[cut..];
                    if tail.starts_with('-')
                        && tail[1..7].bytes().all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
                    {
                        s = format!("{}-<id6>.html", &s[..cut]);
                    }
                }
            }
            Value::String(s)
        }
        Value::Number(n) if matches!(key, Some("updatedAt" | "createdAt")) && n.as_f64().unwrap_or(0.0) >= 1e12 => {
            json!(0)
        }
        Value::Array(a) => Value::Array(a.into_iter().map(|x| norm(x, root, data, None)).collect()),
        Value::Object(o) => {
            Value::Object(o.into_iter().map(|(k, x)| (k.clone(), norm(x, root, data, Some(&k)))).collect())
        }
        other => other,
    }
}

#[test]
fn every_board_edit_and_generation_matches_the_ts_host() {
    let c: Value = serde_json::from_str(&golden("design-cases.json")).unwrap();
    let (root_dir, data_dir) = (temp("root"), temp("data"));
    for (rel, spec) in c["files"].as_object().unwrap() {
        let bytes: Vec<u8> = match spec {
            Value::String(s) => s.clone().into_bytes(),
            o => o["bytes"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect(),
        };
        std::fs::write(root_dir.join(rel), bytes).unwrap();
    }
    std::fs::create_dir_all(root_dir.join("w2")).unwrap();
    let (root, data) = (root_dir.to_string_lossy().into_owned(), data_dir.to_string_lossy().into_owned());
    let w2 = nekko_tools::path::native::join(&[&root, "w2"]);
    let folder = |ws: &str| match ws {
        "w1" => Some(root.clone()),
        "w2" => Some(w2.clone()),
        _ => None,
    };
    let d = data_dir.as_path();
    let page = |ws: &str, i: &Value| -> Option<Value> {
        design::get(d, Some(&json!(ws)))["pages"].as_array().and_then(|p| p.get(i.as_u64().unwrap() as usize).cloned())
    };
    let id_of = |ws: &str, i: &Value| page(ws, i).and_then(|p| p.get("id").cloned());

    let mut ops = Vec::new();
    for o in c["ops"].as_array().unwrap() {
        let op = o[0].as_str().unwrap();
        let ws = o.get(1).and_then(Value::as_str).unwrap_or_default().to_string();
        let wsv = json!(ws);
        let a = |i: usize| o.get(i);
        let out: Result<Value, String> = match op {
            "get" => Ok(design::get(d, Some(&wsv))),
            "add" => design::add_page(d, Some(&wsv), a(2), a(3), folder(&ws).as_deref()),
            "addImport" => {
                let path = json!(nekko_tools::path::native::join(&[&root, o[3].as_str().unwrap()]));
                design::add_page(d, Some(&wsv), a(2), Some(&path), folder(&ws).as_deref())
            }
            "update" => design::update_page(d, Some(&wsv), id_of(&ws, &o[2]).as_ref(), &o[3]),
            "remove" => design::remove_page(d, Some(&wsv), id_of(&ws, &o[2]).as_ref()),
            "note" => design::add_note(d, Some(&wsv), id_of(&ws, &o[2]).as_ref(), a(3)),
            "resolve" => {
                let note = page(&ws, &o[2])
                    .and_then(|p| p["notes"].get(o[3].as_u64().unwrap() as usize).and_then(|n| n.get("id").cloned()));
                design::resolve_note(d, Some(&wsv), id_of(&ws, &o[2]).as_ref(), note.as_ref())
            }
            "file" => Ok(page("w1", &o[1])
                .and_then(|p| p.get("file").and_then(Value::as_str).map(|f| json!(std::fs::read_to_string(f).unwrap())))
                .unwrap_or(Value::Null)),
            "generate" => {
                let mut input: Map<String, Value> = o[2].as_object().unwrap().clone();
                if let Some(i) = input.shift_remove("pageIndex")
                    && let Some(id) = id_of(&ws, &i)
                {
                    input.insert("pageId".into(), id);
                }
                let input = Value::Object(input);
                design::plan(d, Some(&wsv), &input).and_then(|plan| {
                    design::land(d, Some(&wsv), &input, &plan, o[3].as_str().unwrap(), folder(&ws).as_deref())
                })
            }
            other => panic!("unknown op {other}"),
        };
        ops.push(match out {
            Ok(v) => json!({ "op": op, "result": norm(v, &root, &data, None) }),
            Err(e) => json!({ "op": op, "error": e }),
        });
    }
    let list = |k: &str| c[k].as_array().unwrap().clone();
    let opt = |v: &Value| if v.is_null() { None } else { Some(v.clone()) };
    let mut actual = Map::new();
    actual.insert("ops".into(), Value::Array(ops));
    actual.insert(
        "asks".into(),
        list("asks").iter().map(|a| json!(design::ask(opt(&a[0]).as_ref(), &a[1], a[2].as_str().unwrap()))).collect(),
    );
    actual.insert(
        "cleans".into(),
        list("cleans")
            .iter()
            .map(|r| match design::clean_output(r.as_str().unwrap()) {
                Ok(s) => json!(s),
                Err(e) => json!({ "error": e }),
            })
            .collect(),
    );
    actual.insert(
        "labels".into(),
        list("labels")
            .iter()
            .map(|a| json!(design::label(&a[0], opt(&a[1]).as_ref(), a[2].as_str().unwrap()).unwrap()))
            .collect(),
    );
    actual.insert("slugs".into(), list("slugs").iter().map(|s| json!(design::slug(s.as_str().unwrap()))).collect());
    actual.insert("system".into(), json!(design::DESIGN_SYSTEM));
    let text = format!("{}\n", nekko_js::stringify_pretty(&Value::Object(actual), "  "));
    let want = golden("design.json").replace("\r\n", "\n");
    let _ = std::fs::remove_dir_all(&root_dir);
    let _ = std::fs::remove_dir_all(&data_dir);
    if text != want {
        for (i, (w, g)) in want.lines().zip(text.lines()).enumerate() {
            assert_eq!(g, w, "design.json differs at line {}", i + 1);
        }
        assert_eq!(text.lines().count(), want.lines().count());
    }
}
