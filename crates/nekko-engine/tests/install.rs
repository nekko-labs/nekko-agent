//! Replays the TS install golden set (`install.golden.test.ts`): the same
//! machines are offered the same builds and release files, and the
//! installers, driven through the same scripted GitHub, archive tools and
//! PATH, make the same requests and commands, answer the same, and leave the
//! same files.

use futures_util::StreamExt;
use nekko_engine::BoxFuture;
use nekko_engine::builds;
use nekko_engine::download::{self, Downloads, Reply};
use nekko_engine::gpu_adapters::parse_windows_adapters;
use nekko_engine::install::{InstallIo, Installer, VcOptions};
use nekko_engine::mlx::{MlxIo, MlxRuntime};
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/install.json")).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

fn opt<'a>(set: &'a Value, key: &Value) -> Option<&'a Value> {
    set.get(key.as_str().unwrap()).filter(|v| !v.is_null())
}

#[test]
fn offers_the_builds_the_host_offers() {
    let g = golden();
    assert_eq!(nekko_js::stringify(&json!(builds::all_builds())), g["allBuilds"].as_str().unwrap());
    for c in g["builds"].as_array().unwrap() {
        let gpu = opt(&g["gpus"], &c["gpu"]);
        let adapters = g["adapterSets"][c["adapters"].as_str().unwrap()].as_array().unwrap().clone();
        let cuda = opt(&g["cudaSets"], &c["cuda"]);
        let (platform, arch) = (c["platform"].as_str().unwrap(), c["arch"].as_str().unwrap());
        let out = builds::builds_for(platform, arch, gpu, &adapters, cuda);
        assert_eq!(nekko_js::stringify(&json!(out)), c["out"].as_str().unwrap(), "{c}");
        let sd = builds::diffusion_builds(platform, arch, gpu);
        assert_eq!(nekko_js::stringify(&json!(sd)), c["diffusion"].as_str().unwrap(), "diffusion {c}");
    }
    for c in g["smi"].as_array().unwrap() {
        assert_eq!(builds::cuda_support_from(c["stdout"].as_str()).unwrap_or(Value::Null), c["out"], "{c}");
    }
    for c in g["upgrades"].as_array().unwrap() {
        let gpu = opt(&g["gpus"], &c["gpu"]);
        let cuda = opt(&g["cudaSets"], &c["cuda"]);
        let out = builds::cuda_upgrade(c["platform"].as_str().unwrap(), "x64", gpu, c["installed"].as_str(), cuda);
        assert_eq!(out.map(|b| b["id"].clone()).unwrap_or(Value::Null), c["out"], "{c}");
    }
    let names = strings(&g["llamaAssets"]);
    for c in g["assets"].as_array().unwrap() {
        let build = builds::all_builds().iter().find(|b| b["id"] == c["id"]).unwrap();
        let asset = builds::match_asset(build, &names);
        let companion = asset.as_deref().and_then(|a| builds::match_companion(build, a, &names));
        assert_eq!((json!(asset), json!(companion)), (c["asset"].clone(), c["companion"].clone()), "{c}");
    }
    let sd_names = strings(&g["sdAssetNames"]);
    for c in g["sdAssets"].as_array().unwrap() {
        let sd = builds::diffusion_builds(
            c["platform"].as_str().unwrap(),
            c["arch"].as_str().unwrap(),
            opt(&g["gpus"], &json!("nvidia")),
        );
        let build = sd.iter().find(|b| b["id"] == c["id"]).unwrap();
        let asset = builds::match_diffusion_asset(build, &sd_names);
        let companion = asset.as_ref().and_then(|_| builds::match_diffusion_companion(build, &sd_names));
        assert_eq!((json!(asset), json!(companion)), (c["asset"].clone(), c["companion"].clone()), "{c}");
    }
    for c in g["adapters"].as_array().unwrap() {
        assert_eq!(json!(parse_windows_adapters(c["text"].as_str().unwrap())), c["out"], "{c}");
    }
}

/* -------------------------------------------------------- the scripted IO */

fn norm(root: &str, v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(root, "<root>").replace('\\', "/")),
        Value::Array(a) => Value::Array(a.iter().map(|x| norm(root, x)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), norm(root, x))).collect()),
        other => other.clone(),
    }
}

fn denorm(root: &str, s: &str) -> String {
    s.replace("<root>", root)
}

struct Script {
    root: String,
    case: Value,
    requests: Mutex<Vec<Value>>,
    runs: Mutex<Vec<Value>>,
    execs: Mutex<Vec<Value>>,
}

impl Script {
    fn reply(&self, url: &str, headers: Vec<(String, String)>) -> Result<(u16, Vec<u8>), String> {
        let h: Map<String, Value> = headers.into_iter().map(|(k, v)| (k, json!(v))).collect();
        self.requests.lock().unwrap().push(norm(&self.root, &json!({ "url": url, "headers": h })));
        match self.case["http"].get(url) {
            None => Ok((404, b"missing".to_vec())),
            Some(Value::String(t)) if t == "throw" => Err("fetch failed".into()),
            Some(r) => Ok((
                r["status"].as_u64().unwrap() as u16,
                r.get("body").and_then(Value::as_str).unwrap_or("").as_bytes().to_vec(),
            )),
        }
    }
}

impl InstallIo for Script {
    fn get(
        &self,
        url: String,
        headers: Vec<(String, String)>,
        _: Option<Duration>,
    ) -> BoxFuture<Result<(u16, Vec<u8>), String>> {
        let r = self.reply(&url, headers);
        Box::pin(async move { r })
    }

    fn run(&self, cmd: String, args: Vec<String>, _: u64) -> BoxFuture<Option<String>> {
        let mut all = vec![cmd.clone()];
        all.extend(args.iter().cloned());
        self.runs.lock().unwrap().push(norm(&self.root, &json!(all)));
        let c = &self.case;
        let out = if cmd == "where" || cmd == "which" {
            c.get("onPath").and_then(|p| p.get(&args[0])).and_then(Value::as_str).map(|s| denorm(&self.root, s))
        } else if cmd == "nvidia-smi" {
            c.get("smi").and_then(Value::as_str).map(str::to_string)
        } else if args.first().map(String::as_str) == Some("--version") {
            c.get("versionOut").and_then(Value::as_str).map(str::to_string)
        } else if cmd == "tar" && c.get("archives").is_some() {
            let archive = &args[1];
            let dest = &args[args.iter().position(|a| a == "-C").unwrap() + 1];
            let name = archive.rsplit(['\\', '/']).next().unwrap().to_string();
            match c["archives"].get(&name).and_then(Value::as_array) {
                None => None,
                Some(leaves) => {
                    for leaf in leaves {
                        let p = Path::new(dest).join(leaf.as_str().unwrap());
                        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                        std::fs::write(p, format!("from {name}")).unwrap();
                    }
                    Some(String::new())
                }
            }
        } else {
            None
        };
        Box::pin(async move { out })
    }
}

impl MlxIo for Script {
    fn exec(&self, cmd: String, args: Vec<String>, env: Vec<(String, String)>) -> BoxFuture<Result<String, String>> {
        let e: Map<String, Value> = env.into_iter().map(|(k, v)| (k, json!(v))).collect();
        self.execs.lock().unwrap().push(norm(&self.root, &json!({ "cmd": cmd, "args": args, "env": e })));
        let dir = Path::new(&self.root).join("engine").join("mlx");
        let tool = args.first().map(String::as_str) == Some("tool");
        let result = if let (Some(fails), true) = (self.case.get("execFails").and_then(Value::as_str), tool) {
            let lines: Vec<&str> = fails.trim().split('\n').collect();
            Err(lines[lines.len().saturating_sub(3)..].join(" "))
        } else {
            if tool && self.case.get("installs") == Some(&Value::Bool(true)) {
                std::fs::create_dir_all(dir.join("bin")).unwrap();
                std::fs::write(dir.join("bin").join("mlx_lm.server"), "#!/bin/sh\n").unwrap();
            }
            if tool {
                std::fs::create_dir_all(dir.join("cache")).unwrap();
            }
            Ok(String::new())
        };
        Box::pin(async move { result })
    }

    fn which(&self, _: String) -> BoxFuture<Option<String>> {
        let w = self.case.get("which").and_then(Value::as_str).map(str::to_string);
        Box::pin(async move { w })
    }
}

impl download::Fetch for Script {
    fn get(&self, url: String, headers: Vec<(String, String)>) -> BoxFuture<Result<Reply, String>> {
        let r = self.reply(&url, headers);
        Box::pin(async move {
            let (status, body) = r?;
            Ok(Reply { status, content_length: None, body: Some(futures_util::stream::iter(vec![Ok(body)]).boxed()) })
        })
    }
}

async fn settle(downloads: &Downloads, id: &Value) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(j) = downloads
            .list()
            .into_iter()
            .find(|j| j["id"] == *id && matches!(j["state"].as_str(), Some("done" | "failed" | "cancelled")))
        {
            return j;
        }
        assert!(std::time::Instant::now() < deadline, "{id} did not settle: {:?}", downloads.list());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn files(root: &str) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, root: &str, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().unwrap().is_dir() {
                walk(&e.path(), &format!("{prefix}{name}/"), root, out);
            } else {
                let text = String::from_utf8_lossy(&std::fs::read(e.path()).unwrap()).into_owned();
                let shown = if name.ends_with(".json") {
                    serde_json::from_str::<Value>(&text)
                        .map(|v| nekko_js::stringify_pretty(&norm(root, &nekko_js::js_order(v)), "  "))
                        .unwrap_or(text)
                } else {
                    text
                };
                out.push(format!("{prefix}{name}={shown}"));
            }
        }
    }
    let mut out = Vec::new();
    walk(Path::new(root), "", root, &mut out);
    out.sort();
    out
}

fn scratch(name: &str) -> String {
    let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let dir = std::env::temp_dir().join(format!("nekko-install-{}-{slug}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn installs_runtimes_as_the_host_does() {
    let g = golden();
    let now = g["now"].as_f64().unwrap();
    for case in g["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = scratch(name);
        let escaped = serde_json::to_string(&root).unwrap();
        let escaped = &escaped[1..escaped.len() - 1];
        for (rel, text) in case.get("files").and_then(Value::as_object).cloned().unwrap_or_default() {
            let p = Path::new(&root).join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text.as_str().unwrap().replace("<root>", escaped)).unwrap();
        }
        let script = Arc::new(Script {
            root: root.clone(),
            case: case.clone(),
            requests: Mutex::default(),
            runs: Mutex::default(),
            execs: Mutex::default(),
        });
        let downloads = Downloads::new(script.clone(), Arc::new(move || now), |_| {});
        let gpu = opt(&g["gpus"], &case["gpu"]).cloned();
        let adapters = g["adapterSets"][case.get("adapters").and_then(Value::as_str).unwrap_or("none")]
            .as_array()
            .unwrap()
            .clone();
        let external = case.get("external").and_then(Value::as_str).map(|e| denorm(&root, e));
        let stops = Arc::new(Mutex::new(Vec::<String>::new()));
        let s2 = stops.clone();
        let installer = Installer::new(
            if case["runtime"] == "diffusion" { "diffusion" } else { "llama" },
            Path::new(&root).join("engine").to_string_lossy().into_owned(),
            case["platform"].as_str().unwrap().to_string(),
            case["arch"].as_str().unwrap().to_string(),
            script.clone(),
            downloads.clone(),
            Arc::new(move || {
                let g = gpu.clone();
                Box::pin(async move { g })
            }),
            Arc::new(move || {
                let a = adapters.clone();
                Box::pin(async move { a })
            }),
            Arc::new(move || external.clone()),
            Arc::new(move || {
                s2.lock().unwrap().push("stop".into());
                Box::pin(async {})
            }),
            Arc::new(move || now),
            VcOptions {
                system_dir: Some(Path::new(&root).join("no-system").to_string_lossy().into_owned()),
                runtime_dir: Some(Path::new(&root).join("no-runtime").to_string_lossy().into_owned()),
            },
        );
        let mut outs = Vec::new();
        for op in case["ops"].as_array().unwrap() {
            let build_id = op.get("buildId").and_then(Value::as_str);
            let out = match op["op"].as_str().unwrap() {
                "detect" => installer.detect().await,
                "preview" => installer.preview(build_id).await,
                "installedBin" => json!(installer.installed_bin().await),
                "uninstall" => installer.uninstall(),
                "install" => {
                    let res = installer.install(build_id).await;
                    match res.get("jobId") {
                        Some(id) => {
                            let job = settle(&downloads, id).await;
                            json!({ "res": res, "job": job })
                        }
                        None => json!({ "res": res }),
                    }
                }
                other => panic!("op {other}"),
            };
            outs.push(nekko_js::stringify(&norm(&root, &out)));
        }
        let want: Vec<String> = strings(&case["outs"]);
        assert_eq!(outs, want, "{name}");
        assert_eq!(json!(*script.requests.lock().unwrap()), case["requests"], "requests of {name}");
        assert_eq!(json!(*script.runs.lock().unwrap()), case["runs"], "runs of {name}");
        assert_eq!(json!(*stops.lock().unwrap()), case["stops"], "stops of {name}");
        assert_eq!(json!(files(&root)), case["left"], "files of {name}");
        std::fs::remove_dir_all(&root).ok();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn installs_mlx_as_the_host_does() {
    let g = golden();
    let now = g["now"].as_f64().unwrap();
    for case in g["mlx"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = scratch(&format!("mlx-{name}"));
        let script = Arc::new(Script {
            root: root.clone(),
            case: case.clone(),
            requests: Mutex::default(),
            runs: Mutex::default(),
            execs: Mutex::default(),
        });
        let downloads = Downloads::new(script.clone(), Arc::new(move || now), |_| {});
        let rt = MlxRuntime::new(
            Path::new(&root).join("engine").join("mlx").to_string_lossy().into_owned(),
            case["platform"].as_str().unwrap().into(),
            case["arch"].as_str().unwrap().into(),
            script.clone(),
            downloads.clone(),
        );
        let mut outs = Vec::new();
        for op in case["ops"].as_array().unwrap() {
            let out = match op.as_str().unwrap() {
                "detect" => rt.detect().await,
                "preview" => rt.preview(),
                "binPath" => json!(rt.bin_path().await),
                "uninstall" => rt.uninstall(),
                "install" => {
                    let res = rt.install().await;
                    match res.get("jobId") {
                        Some(id) => json!({ "res": res, "job": settle(&downloads, id).await }),
                        None => json!({ "res": res }),
                    }
                }
                other => panic!("op {other}"),
            };
            outs.push(nekko_js::stringify(&norm(&root, &out)));
        }
        assert_eq!(outs, strings(&case["outs"]), "{name}");
        assert_eq!(json!(*script.requests.lock().unwrap()), case["requests"], "requests of {name}");
        assert_eq!(json!(*script.execs.lock().unwrap()), case["execs"], "execs of {name}");
        assert_eq!(json!(files(&root)), case["left"], "files of {name}");
        std::fs::remove_dir_all(&root).ok();
    }
}
