//! skills.rs against skills.ts and external-skills.ts: `golden/skills.json`
//! is written by packages/host/src/skills.golden.test.ts from
//! `golden/skills-cases.json` (and `src/skills-data.json` beside it).

use nekko_workspace::skills;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

fn golden(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name)).unwrap()
}

fn temp(tag: &str) -> PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let p = std::env::temp_dir()
        .join(format!("nekko-skills-{tag}-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn build(base: &Path, files: &Map<String, Value>) {
    for (rel, text) in files {
        let full = base.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, text.as_str().unwrap()).unwrap();
    }
}

fn norm(v: Value, roots: &[(String, &str)], key: Option<&str>) -> Value {
    match v {
        Value::String(s) => {
            for (root, name) in roots {
                if s.contains(root.as_str()) {
                    return Value::String(s.replace(root.as_str(), name).replace('\\', "/"));
                }
            }
            Value::String(s)
        }
        Value::Number(_) if key == Some("installedAt") => json!(0),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| norm(x, roots, None)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (k.clone(), norm(x, roots, Some(&k)))).collect()),
        other => other,
    }
}

#[test]
fn installs_listings_and_discovery_match_the_ts_host() {
    let c: Value = serde_json::from_str(&golden("skills-cases.json")).unwrap();
    let (home_dir, project_dir, data_dir) = (temp("home"), temp("project"), temp("data"));
    build(&home_dir, c["home"].as_object().unwrap());
    build(&project_dir, c["project"].as_object().unwrap());
    let s = |p: &PathBuf| p.to_string_lossy().into_owned();
    let (home, project) = (s(&home_dir), s(&project_dir));
    let roots = [(home.clone(), "<home>"), (project.clone(), "<project>"), (s(&data_dir), "<data>")];
    let d = data_dir.as_path();
    let mut ops = Vec::new();
    for o in c["ops"].as_array().unwrap() {
        let op = o[0].as_str().unwrap();
        let a = |i: usize| o.get(i);
        let out: Result<Value, String> = match op {
            "targets" => Ok(skills::targets(&home)),
            "defs" => Ok(Value::Array(skills::installed_skill_defs(d))),
            "list" => Ok(Value::Array(skills::list_installed(d))),
            "install" => skills::install(d, &home, &o[1], a(2), a(3)),
            "uninstall" => skills::uninstall(d, &o[1], a(2)).map(Value::Array),
            "external" => {
                let exclude: Vec<String> = skills::list_installed(d)
                    .iter()
                    .filter_map(|r| r.get("path").and_then(Value::as_str).map(str::to_string))
                    .collect();
                Ok(Value::Array(skills::discover_external(
                    &home,
                    std::slice::from_ref(&project),
                    &exclude,
                    &skills::reserved_names(d),
                )))
            }
            "runnable" => Ok(Value::Array(skills::runnable_skills(d, &home, std::slice::from_ref(&project)))),
            "skillFile" => {
                Ok(json!(std::fs::read_to_string(home_dir.join(o[1].as_str().unwrap()).join("SKILL.md")).unwrap()))
            }
            "exists" => Ok(json!(home_dir.join(o[1].as_str().unwrap()).exists())),
            "removeHome" => {
                let _ = std::fs::remove_dir_all(home_dir.join(o[1].as_str().unwrap()));
                Ok(Value::Null)
            }
            other => panic!("unknown op {other}"),
        };
        ops.push(match out {
            Ok(v) => json!({ "op": op, "result": norm(v, &roots, None) }),
            Err(e) => json!({ "op": op, "error": e }),
        });
    }
    let data: Value = serde_json::from_str(include_str!("../src/skills-data.json")).unwrap();
    let markdown: Vec<Value> =
        data["market"].as_array().unwrap().iter().map(|m| json!(skills::skill_to_markdown(m))).collect();
    let parse: Vec<Value> = c["parse"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| {
            let (name, description, body) = skills::parse_skill_markdown(raw.as_str().unwrap());
            let mut m = Map::new();
            if let Some(n) = name {
                m.insert("name".into(), json!(n));
            }
            if let Some(dsc) = description {
                m.insert("description".into(), json!(dsc));
            }
            m.insert("body".into(), json!(body));
            Value::Object(m)
        })
        .collect();
    let market = data["market"].as_array().unwrap().iter();
    let skill_defs: Vec<Value> = market.chain(c["defsExtra"].as_array().unwrap()).map(skills::skill_def).collect();
    let actual = json!({ "ops": ops, "markdown": markdown, "parse": parse, "skillDefs": skill_defs });
    let text = format!("{}\n", nekko_js::stringify_pretty(&actual, "  "));
    for p in [&home_dir, &project_dir, &data_dir] {
        let _ = std::fs::remove_dir_all(p);
    }
    let want = golden("skills.json").replace("\r\n", "\n");
    if text != want {
        for (i, (w, g)) in want.lines().zip(text.lines()).enumerate() {
            assert_eq!(g, w, "skills.json differs at line {}", i + 1);
        }
        assert_eq!(text.lines().count(), want.lines().count());
    }
}
