//! The Rust ports against the TS functions.
//!
//! `golden/expected.json` is written by the real `files.ts`, `memory.ts`,
//! `comments.ts` and `workspace.ts` (packages/host/src/workspace.golden.test.ts,
//! which also fails when it goes stale), running `golden/cases.json` over the
//! tree in `golden/tree.json`. This runs the same cases on the same tree and
//! must print the same text, key order included.

use nekko_js as js;
use nekko_workspace::{comments, files, index::Index, memory};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        let suffix: String = b.iter().map(|x| format!("{x:02x}")).collect();
        let p = std::env::temp_dir().join(format!("nekko-ws-{tag}-{suffix}"));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn build(base: &Path, files: &Map<String, Value>) {
    for (rel, spec) in files {
        let full = base.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        let bytes: Vec<u8> = match spec {
            Value::String(s) => s.clone().into_bytes(),
            Value::Object(o) if o.contains_key("bytes") => {
                o["bytes"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect()
            }
            Value::Object(o) => {
                let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
                format!("{}{}{}", s("head"), s("repeat").repeat(o["count"].as_u64().unwrap() as usize), s("tail"))
                    .into_bytes()
            }
            other => panic!("bad spec {other}"),
        };
        std::fs::write(full, bytes).unwrap();
    }
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() && !c.is_ascii_uppercase() }
        })
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
}

/// The same normalization the TS test applies.
fn norm(v: Value, root: &str, data: &str, key: Option<&str>) -> Value {
    match v {
        Value::String(s) => {
            if key == Some("id") && is_uuid(&s) {
                return json!("<uuid>");
            }
            let mut s = if let Some(rest) = s.strip_prefix(root) {
                format!("<root>{rest}")
            } else if let Some(rest) = s.strip_prefix(data) {
                format!("<data>{rest}")
            } else {
                s
            };
            if s.starts_with("<root>") || s.starts_with("<data>") {
                s = s.replace('\\', "/");
            }
            let units: Vec<u16> = s.encode_utf16().collect();
            if units.len() > 300 {
                let head = String::from_utf16_lossy(&units[..40]);
                let tail = String::from_utf16_lossy(&units[units.len() - 40..]);
                return json!({ "length": units.len(), "head": head, "tail": tail });
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

fn replace_digits(text: &str, prefix: &str, digits: usize, with: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find(prefix) {
        let start = i + prefix.len();
        let run = rest[start..].bytes().take_while(u8::is_ascii_digit).count();
        out.push_str(&rest[..i]);
        if run == digits {
            out.push_str(with);
        } else {
            out.push_str(&rest[i..start + run]);
        }
        rest = &rest[start + run..];
    }
    out.push_str(rest);
    out
}

fn uuid_free(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    let prefix = "\"id\": \"";
    while let Some(i) = rest.find(prefix) {
        let start = i + prefix.len();
        out.push_str(&rest[..start]);
        let cand = rest.get(start..start + 36).unwrap_or("");
        if cand.len() == 36
            && cand.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
            && rest[start + 36..].starts_with('"')
        {
            out.push_str("<uuid>");
            rest = &rest[start + 36..];
        } else {
            rest = &rest[start..];
        }
    }
    out.push_str(rest);
    out
}

#[test]
fn every_case_returns_what_the_ts_host_returns() {
    let tree: Value = serde_json::from_str(&std::fs::read_to_string(golden().join("tree.json")).unwrap()).unwrap();
    let cases: Vec<Vec<Value>> =
        serde_json::from_str(&std::fs::read_to_string(golden().join("cases.json")).unwrap()).unwrap();
    let (root_dir, data_dir) = (TempDir::new("root"), TempDir::new("data"));
    build(&root_dir.0, tree["root"].as_object().unwrap());
    for d in tree["rootDirs"].as_array().unwrap() {
        std::fs::create_dir_all(root_dir.0.join(d.as_str().unwrap())).unwrap();
    }
    build(&data_dir.0, tree["data"].as_object().unwrap());
    let (root, data) = (root_dir.path(), data_dir.path());
    let at = |rel: &Value| {
        let rel = rel.as_str().unwrap();
        if rel.is_empty() { root.clone() } else { nekko_tools::path::native::join(&[&root, rel]) }
    };
    let folders = |id: &str| (id == "w1").then(|| root.clone());
    let index = Index::new();

    let mut results = Vec::new();
    for case in &cases {
        let name = case[0].as_str().unwrap();
        let args = &case[1..];
        let a = |i: usize| args.get(i);
        let out: Result<Value, String> = match name {
            "read" => files::read_file(&at(&args[0])),
            "list" => files::list_dir(&at(&args[0])),
            "write" => files::write_file(&at(&args[0]), &args[1]).map(|()| Value::Null),
            "append" => {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().append(true).open(at(&args[0])).unwrap();
                f.write_all(args[1].as_str().unwrap().as_bytes()).unwrap();
                Ok(Value::Null)
            }
            "index" => {
                let id = args[0].as_str().unwrap();
                let progress = std::sync::Mutex::new(Vec::new());
                let done = index.index(id, &folders(id).unwrap(), &|s| progress.lock().unwrap().push(s.clone()));
                Ok(json!({ "done": done, "progress": progress.into_inner().unwrap() }))
            }
            "files" => Ok(Value::Array(index.files(args[0].as_str().unwrap()).iter().map(|f| f.to_json()).collect())),
            "status" => Ok(index.status(args[0].as_str().unwrap())),
            "search" => {
                let id = args[0].as_str().unwrap();
                Ok(if folders(id).is_some() {
                    Value::Array(index.search(id, args[1].as_str().unwrap()))
                } else {
                    json!([])
                })
            }
            "snippets" => {
                let ids: Vec<(String, bool)> = args[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| (v.as_str().unwrap().to_string(), folders(v.as_str().unwrap()).is_some()))
                    .collect();
                Ok(Value::Array(index.snippets(&ids, args[1].as_str().unwrap())))
            }
            "memList" => Ok(Value::Array(memory::list(&data_dir.0, a(0), a(1)))),
            "memSave" => memory::save(&data_dir.0, &args[0]).map(Value::Array),
            "memFile" => {
                let text = std::fs::read_to_string(
                    data_dir.0.join("memory").join(format!("{}.md", args[0].as_str().unwrap())),
                )
                .unwrap();
                Ok(json!(replace_digits(&text, "updatedAt: ", 13, "updatedAt: 0")))
            }
            "memDelete" => memory::delete(&data_dir.0, a(0)).map(|()| Value::Null),
            "cList" => Ok(comments::list(&data_dir.0, a(0))),
            "cAdd" => comments::add(&data_dir.0, a(0), a(1), a(2), a(3)),
            "cResolve" => {
                let list = comments::list(&data_dir.0, a(0));
                let id = list.get(args[1].as_u64().unwrap() as usize).and_then(|c| c.get("id")).cloned();
                comments::resolve(&data_dir.0, a(0), id.as_ref())
            }
            "cFile" => {
                let text = std::fs::read_to_string(data_dir.0.join("comments.json")).unwrap();
                let text = replace_digits(&uuid_free(&text), "\"createdAt\": ", 13, "\"createdAt\": 0");
                Ok(Value::Array(text.split('\n').map(|l| json!(l)).collect()))
            }
            other => panic!("unknown op {other}"),
        };
        results.push(match out {
            Ok(v) => json!({ "op": name, "result": norm(v, &root, &data, None) }),
            Err(e) => json!({ "op": name, "error": e }),
        });
    }
    let text = format!("{}\n", js::stringify_pretty(&Value::Array(results)));
    let want = std::fs::read_to_string(golden().join("expected.json")).unwrap().replace("\r\n", "\n");
    if text != want {
        let got_lines: Vec<&str> = text.lines().collect();
        for (i, w) in want.lines().enumerate() {
            if got_lines.get(i) != Some(&w) {
                panic!(
                    "expected.json differs at line {}:\n  want: {w}\n  got:  {}",
                    i + 1,
                    got_lines.get(i).unwrap_or(&"<end>")
                );
            }
        }
        panic!("output has {} lines, expected {}", got_lines.len(), want.lines().count());
    }
}
