//! What the engine in use makes of a repo's builds before they are downloaded
//! (`Catalog::load_checks`): only builds whose name cannot be placed have their
//! header read (a capped range of the file), and the verdict is the library's own.

use nekko_engine::BoxFuture;
use nekko_engine::catalog::{Catalog, Fetch, HF_API, Reply, hf_file_url};
use nekko_engine::gguf::{self, HeaderRead};
use nekko_engine::load_check::{EngineInUse, Source};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const REPO: &str = "prism-ml/Ternary-Bonsai-2-27B-gguf";

fn ggstr(s: &str) -> Vec<u8> {
    let mut out = (s.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(s.as_bytes());
    out
}

/// A v3 header: string and u32 pairs, then one-dimensional tensors of these types.
fn gguf_bytes(strings: &[(&str, &str)], numbers: &[(&str, u32)], tensors: &[(&str, u32)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(0x4655_4747u32.to_le_bytes());
    out.extend(3u32.to_le_bytes());
    out.extend((tensors.len() as u64).to_le_bytes());
    out.extend(((strings.len() + numbers.len()) as u64).to_le_bytes());
    for (k, v) in strings {
        out.extend(ggstr(k));
        out.extend(8u32.to_le_bytes());
        out.extend(ggstr(v));
    }
    for (k, v) in numbers {
        out.extend(ggstr(k));
        out.extend(4u32.to_le_bytes());
        out.extend(v.to_le_bytes());
    }
    for (name, kind) in tensors {
        out.extend(ggstr(name));
        out.extend(1u32.to_le_bytes());
        out.extend(256u64.to_le_bytes());
        out.extend(kind.to_le_bytes());
        out.extend(0u64.to_le_bytes());
    }
    out.extend([0u8; 64]);
    out
}

/// PrismML's ternary pack: a tensor of type 143 and the `prism.hadamard` keys.
fn ternary() -> Vec<u8> {
    gguf_bytes(
        &[("general.architecture", "qwen35")],
        &[("prism.hadamard.version", 1)],
        &[("token_embd.weight", 0), ("output.weight", 143)],
    )
}

/// Hugging Face: the repo's JSON, and files' first bytes (each request recorded with its cap).
struct Hub {
    json: Map<String, Value>,
    files: HashMap<String, Vec<u8>>,
    byte_reads: Mutex<Vec<(String, usize, Option<String>)>>,
}

impl Fetch for Hub {
    fn get(&self, url: String, _headers: Vec<(&'static str, String)>) -> BoxFuture<Result<Reply, String>> {
        let reply = match self.json.get(&url) {
            Some(body) => Reply { status: 200, body: body.to_string() },
            None => Reply { status: 404, body: "Not found".into() },
        };
        Box::pin(async move { Ok(reply) })
    }
    fn get_bytes(
        &self,
        url: String,
        headers: Vec<(&'static str, String)>,
        max: usize,
    ) -> BoxFuture<Result<(u16, Vec<u8>), String>> {
        let range = headers.iter().find(|(k, _)| *k == "range").map(|(_, v)| v.clone());
        self.byte_reads.lock().unwrap().push((url.clone(), max, range.clone()));
        // `bytes=<from>-<to>`, as Hugging Face honours it.
        let from: usize = range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.split('-').next())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        let reply = match self.files.get(&url) {
            Some(bytes) if from < bytes.len() => (206, bytes[from..bytes.len().min(from + max)].to_vec()),
            Some(_) => (416, Vec::new()),
            None => (404, Vec::new()),
        };
        Box::pin(async move { Ok(reply) })
    }
}

/// The LFS oid Hugging Face lists: a hash of the file's content (here its name and bytes).
fn oid_of(name: &str, bytes: Option<&[u8]>) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (name, bytes).hash(&mut h);
    format!("{:016x}", h.finish())
}

fn hub(files: &[(&str, f64, Option<Vec<u8>>)]) -> Arc<Hub> {
    let tree: Vec<Value> = files
        .iter()
        .map(|(p, s, b)| {
            json!({ "type": "file", "path": p, "size": s, "oid": "blobsha", "lfs": { "oid": oid_of(p, b.as_deref()), "size": s } })
        })
        .collect();
    let mut json = Map::new();
    json.insert(format!("{HF_API}/models/{REPO}/tree/main?recursive=true"), json!(tree));
    json.insert(format!("{HF_API}/models/{REPO}"), json!({ "tags": ["gguf"] }));
    let files = files.iter().filter_map(|(p, _, b)| Some((hf_file_url(REPO, p), b.clone()?))).collect();
    Arc::new(Hub { json, files, byte_reads: Mutex::default() })
}

fn engine(source: Source, version: Option<&str>) -> EngineInUse {
    EngineInUse { source, version: version.map(str::to_string) }
}

fn level(checks: &Value, file: &str) -> Option<(String, String)> {
    let c = checks.get(file)?;
    Some((c["level"].as_str()?.to_string(), c["cause"].as_str()?.to_string()))
}

#[test]
fn a_header_is_read_from_the_first_bytes_and_asks_for_more_when_cut_short() {
    let bytes = ternary();
    let HeaderRead::Done(Some(meta)) = gguf::read_metadata_prefix(&bytes, false) else { panic!("whole header") };
    assert_eq!((meta.unknown_weight_type, meta.min_engine_build), (Some(143), Some(11556)));
    // The tensor table cut off: more is needed, unless no more will come.
    let cut = &bytes[..bytes.len() - 70];
    assert!(matches!(gguf::read_metadata_prefix(cut, false), HeaderRead::NeedMore));
    assert!(matches!(gguf::read_metadata_prefix(&bytes[..10], false), HeaderRead::Done(None)));
    assert!(matches!(gguf::read_metadata_prefix(b"not a gguf file at all, sorry", false), HeaderRead::Done(None)));
}

/// A stock-format build: known tensor types, and the hadamard key only when `key`.
fn stock(key: bool) -> Vec<u8> {
    let numbers: &[(&str, u32)] = if key { &[("prism.hadamard.version", 1)] } else { &[] };
    gguf_bytes(&[("general.architecture", "qwen35")], numbers, &[("token_embd.weight", 0), ("output.weight", 8)])
}

fn cache_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekko-header-cache-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn catalog(hub: &Arc<Hub>, dir: &Path) -> Catalog {
    Catalog::new(hub.clone(), Box::new(|| None), Box::new(|| false)).with_header_cache(dir.to_path_buf())
}

const OLD: (Source, Option<&str>) = (Source::Managed, Some("b11224"));
const PTQ1: &str = "Ternary-Bonsai-2-27B-PTQ1_0.gguf";
const Q2: &str = "Ternary-Bonsai-2-27B-Q2_0.gguf";
const Q4: &str = "Ternary-Bonsai-2-27B-Q4_K_M.gguf";

fn prism_repo() -> Arc<Hub> {
    hub(&[
        (PTQ1, 5.95e9, Some(ternary())),
        (Q2, 7.63e9, Some(stock(true))),
        ("Ternary-Bonsai-2-27B-F16.gguf", 53.8e9, Some(stock(false))),
    ])
}

fn blocked(cause: &str) -> Option<(String, String)> {
    Some(("blocked".into(), cause.into()))
}

#[tokio::test]
async fn opening_the_page_reads_no_header() {
    let hub = prism_repo();
    let dir = cache_dir("open");
    let checks = catalog(&hub, &dir).load_checks(REPO, &engine(OLD.0, OLD.1), None).await;
    assert_eq!(checks, json!({}), "nothing has been read, so the list keeps its size-based fit");
    assert!(hub.byte_reads.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn opening_a_build_reads_only_that_build() {
    let hub = prism_repo();
    let dir = cache_dir("one");
    let c = catalog(&hub, &dir);
    let checks = c.load_checks(REPO, &engine(OLD.0, OLD.1), Some(PTQ1)).await;
    assert_eq!(level(&checks, PTQ1), blocked("weightFormat"));
    assert_eq!(checks.as_object().unwrap().len(), 1, "{checks}");
    // One capped range, for that file alone.
    let reads = hub.byte_reads.lock().unwrap().clone();
    assert_eq!(reads.len(), 1);
    assert!(reads[0].0.contains("PTQ1_0"));
    assert_eq!(reads[0].1, gguf::HEADER_FIRST_READ);
    // Opening the page again (nothing asked for) still shows what was read, without a request.
    let again = c.load_checks(REPO, &engine(OLD.0, OLD.1), None).await;
    assert_eq!(level(&again, PTQ1), blocked("weightFormat"));
    assert_eq!(hub.byte_reads.lock().unwrap().len(), 1);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn a_header_is_read_once_ever_per_file_content_even_after_a_restart() {
    let hub = prism_repo();
    let dir = cache_dir("restart");
    let first = catalog(&hub, &dir).load_checks(REPO, &engine(OLD.0, OLD.1), Some(Q2)).await;
    assert_eq!(level(&first, Q2), blocked("engineAge"));
    assert_eq!(hub.byte_reads.lock().unwrap().len(), 1);

    // A restart: a fresh catalog (no memory) over the same folder, against a hub that would serve the file again.
    let hub2 = prism_repo();
    let again = catalog(&hub2, &dir).load_checks(REPO, &engine(OLD.0, OLD.1), Some(Q2)).await;
    assert_eq!(level(&again, Q2), blocked("engineAge"));
    assert!(hub2.byte_reads.lock().unwrap().is_empty(), "the cache is keyed by the file's hash, so no request");
    // And merely opening the page after the restart shows it.
    let page = catalog(&hub2, &dir).load_checks(REPO, &engine(OLD.0, OLD.1), None).await;
    assert_eq!(level(&page, Q2), blocked("engineAge"));
    assert!(hub2.byte_reads.lock().unwrap().is_empty());

    // The facts, not the verdict, are what is kept: a newer engine reads the same file as fine.
    let current = catalog(&hub2, &dir).load_checks(REPO, &engine(Source::Managed, Some("b12470")), None).await;
    assert!(current.get(Q2).is_none());
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn a_file_whose_content_changed_is_read_again() {
    let dir = cache_dir("changed");
    let before = hub(&[(Q2, 7.6e9, Some(stock(false)))]);
    let c = catalog(&before, &dir);
    assert!(c.load_checks(REPO, &engine(OLD.0, OLD.1), Some(Q2)).await.get(Q2).is_none());
    // The repo republished Q2_0 with the marker: a new hash, so a new read.
    let after = hub(&[(Q2, 7.6e9, Some(stock(true)))]);
    let checks = catalog(&after, &dir).load_checks(REPO, &engine(OLD.0, OLD.1), Some(Q2)).await;
    assert_eq!(level(&checks, Q2), blocked("engineAge"));
    assert_eq!(after.byte_reads.lock().unwrap().len(), 1);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn a_failed_read_is_not_kept_on_disk_and_is_not_repeated_for_a_minute() {
    let hub = hub(&[("Odd-build.gguf", 1e9, Some(b"GGUF but not really".to_vec()))]);
    let dir = cache_dir("failed");
    let c = catalog(&hub, &dir);
    assert_eq!(c.load_checks(REPO, &engine(OLD.0, OLD.1), Some("Odd-build.gguf")).await, json!({}));
    assert_eq!(c.load_checks(REPO, &engine(OLD.0, OLD.1), Some("Odd-build.gguf")).await, json!({}));
    assert_eq!(hub.byte_reads.lock().unwrap().len(), 1, "remembered for a minute");
    // A restart tries again: nothing wrong was written down.
    catalog(&hub, &dir).load_checks(REPO, &engine(OLD.0, OLD.1), Some("Odd-build.gguf")).await;
    assert_eq!(hub.byte_reads.lock().unwrap().len(), 2);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn each_build_is_judged_on_its_own_header_and_an_unread_one_says_nothing() {
    let hub = hub(&[(PTQ1, 5.95e9, Some(ternary())), (Q2, 7.63e9, Some(stock(false))), (Q4, 9e9, Some(stock(true)))]);
    let dir = cache_dir("own");
    let c = catalog(&hub, &dir);
    let e = engine(OLD.0, OLD.1);
    c.load_checks(REPO, &e, Some(PTQ1)).await;
    let checks = c.load_checks(REPO, &e, Some(Q2)).await;
    // The fork build needs b11556, but the stock Q2_0's own header does not: it is not in the way,
    // and the Q4_K_M that nobody has opened says nothing rather than borrowing the repo's minimum.
    assert_eq!(level(&checks, PTQ1), blocked("weightFormat"));
    assert!(checks.get(Q2).is_none() && checks.get(Q4).is_none(), "{checks}");
    let checks = c.load_checks(REPO, &e, Some(Q4)).await;
    assert_eq!(level(&checks, Q4), blocked("engineAge"));
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn the_users_own_engine_is_only_warned() {
    let hub = prism_repo();
    let dir = cache_dir("own-engine");
    let checks = catalog(&hub, &dir).load_checks(REPO, &engine(Source::External, None), Some(PTQ1)).await;
    assert_eq!(level(&checks, PTQ1).unwrap().0, "warning");
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn a_header_longer_than_the_first_read_is_read_on_without_fetching_its_start_again() {
    // A big vocabulary, as PrismML's real files have, pushes the tensor table past the first 4 MiB.
    let vocab = "t".repeat(gguf::HEADER_FIRST_READ + 1024);
    let long = gguf_bytes(
        &[("general.architecture", "qwen35"), ("tokenizer.chat_template", vocab.as_str())],
        &[("prism.hadamard.version", 1)],
        &[("token_embd.weight", 0), ("output.weight", 142)],
    );
    assert!(long.len() > gguf::HEADER_FIRST_READ);
    let file = "Ternary-Bonsai-2-27B-PQ2_0.gguf";
    let hub = hub(&[(file, 7.21e9, Some(long))]);
    let dir = cache_dir("long");
    let checks = catalog(&hub, &dir).load_checks(REPO, &engine(Source::Managed, Some("b12470")), Some(file)).await;
    assert_eq!(level(&checks, file), blocked("weightFormat"));
    assert!(checks[file]["reason"].as_str().unwrap().contains("tensor type 142"));
    let ranges: Vec<Option<String>> = hub.byte_reads.lock().unwrap().iter().map(|(_, _, r)| r.clone()).collect();
    let (first, most) = (gguf::HEADER_FIRST_READ, gguf::HEADER_MAX_READ);
    assert_eq!(ranges, [Some(format!("bytes=0-{}", first - 1)), Some(format!("bytes={first}-{}", most - 1))]);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn the_variants_list_and_the_library_judge_the_same_header_alike() {
    use nekko_engine::load_check::load_check;
    let work = cache_dir("same-files");
    std::fs::create_dir_all(&work).unwrap();
    let cases = [("A-PTQ1_0", ternary()), ("A-Q2_0", stock(true)), ("A-Q4_K_M", stock(false))];
    let listing: Vec<(String, f64, Option<Vec<u8>>)> =
        cases.iter().map(|(n, b)| (format!("{n}.gguf"), 1e9, Some(b.clone()))).collect();
    let refs: Vec<(&str, f64, Option<Vec<u8>>)> = listing.iter().map(|(n, s, b)| (n.as_str(), *s, b.clone())).collect();
    let hub = hub(&refs);
    let dir = cache_dir("same");
    let c = catalog(&hub, &dir);
    for e in [
        engine(Source::Managed, Some("b11224")),
        engine(Source::Managed, Some("b12470")),
        engine(Source::External, None),
    ] {
        for (name, bytes) in &cases {
            let checks = c.load_checks(REPO, &e, Some(&format!("{name}.gguf"))).await;
            // The library's row for a downloaded copy: the header's facts and the file's name.
            let path = work.join(format!("{name}.gguf"));
            std::fs::write(&path, bytes).unwrap();
            let mut row = gguf::read_metadata(&path.to_string_lossy()).unwrap().to_value();
            row["name"] = json!(name);
            let library = load_check(&row, &e).map(|c| c.to_value());
            assert_eq!(checks.get(format!("{name}.gguf")).cloned(), library, "{name} on {e:?}");
        }
    }
    std::fs::remove_dir_all(work).ok();
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn lora_requires_header_provenance_and_reuses_an_exact_installed_base() {
    let base = "example/Exact-Base";
    let file = "Style-LoRA-F16.gguf";
    let adapter = gguf_bytes(
        &[
            ("general.architecture", "llama"),
            ("general.type", "adapter"),
            ("adapter.type", "lora"),
            ("general.base_model.0.repo_url", "https://huggingface.co/example/Exact-Base"),
        ],
        &[("general.base_model.count", 1)],
        &[("test.lora_a", 1)],
    );
    let h = hub(&[(file, 256.0, Some(adapter))]);
    let catalog = Catalog::new(h, Box::new(|| None), Box::new(|| false));
    let model = catalog.model(REPO).await;
    let build = &model["quants"][0];
    assert_eq!(build["file"], file, "adapter files must not disappear from the catalog");
    let rows = [
        json!({"id":"wrong", "name":"Similar", "loraBaseRepo":"example/Other", "architecture":"llama", "modality":"chat"}),
        json!({"id":"right", "name":"Exact", "loraBaseRepo":base, "architecture":"llama", "modality":"chat"}),
    ];
    let selected = catalog.companion(&model, build, &rows, false).await.unwrap();
    assert_eq!(selected["kind"], "lora");
    assert_eq!(selected["installedBase"]["id"], "right");
    assert!(selected["base"].is_null());
    let unresolved = catalog.companion(&model, build, &rows[..1], false).await.unwrap();
    assert!(unresolved["base"].is_null() && unresolved["installedBase"].is_null());
    assert!(unresolved["reason"].is_string());
}

#[tokio::test]
async fn dflash2_offers_the_stock_runtime_build_and_accounts_for_its_projector() {
    let draft = "incoai/Qwen3.8-27B-DFlash2-GGUF";
    let base = "ggml-org/Qwen3.8-27B-GGUF";
    let draft_file = "Qwen3.8-27B-DFlash2-Q4_K_M.gguf";
    let base_file = "Qwen3.8-27B-Q4_K_M.gguf";
    let tree = |files: &[(&str, u64)]| {
        json!(files.iter().map(|(path, size)| json!({"type":"file", "path":path, "size":size})).collect::<Vec<_>>())
    };
    let mut docs = Map::new();
    docs.insert(format!("{HF_API}/models/{draft}/tree/main?recursive=true"), tree(&[(draft_file, 800_000_000)]));
    docs.insert(
        format!("{HF_API}/models/{base}/tree/main?recursive=true"),
        tree(&[(base_file, 16_000_000_000), ("mmproj-BF16.gguf", 700_000_000)]),
    );
    let files = HashMap::from([(
        hf_file_url(draft, draft_file),
        gguf_bytes(&[("general.architecture", "dflash")], &[], &[("draft.weight", 0)]),
    )]);
    let catalog = Catalog::new(
        Arc::new(Hub { json: docs, files, byte_reads: Mutex::default() }),
        Box::new(|| None),
        Box::new(|| false),
    );
    let model = catalog.model(draft).await;
    assert_eq!(model["dependent"], true);
    let offered = catalog.companion(&model, &model["quants"][0], &[], false).await.unwrap();
    assert_eq!(offered["baseRepo"], "Qwen/Qwen3.8-27B");
    assert_eq!(
        offered["base"],
        json!({"repo":base, "quant":"Q4_K_M", "file":base_file, "sizeBytes":16_700_000_000u64})
    );
}
