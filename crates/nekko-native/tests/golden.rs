//! The updater held to electron-updater: `golden/updater.json` is written by
//! `apps/desktop/src/main/updater.golden.test.ts` from electron-updater's own
//! node-semver, `parseUpdateInfo`, `resolveFiles` and `findFile`, over every
//! `latest*.yml` published for past releases (`fixtures/feeds`).

use nekko_native::semver;
use nekko_native::update::{self, Feed, LinuxPackage, Platform};
use serde_json::{Value, json};
use std::path::Path;

fn golden() -> Value {
    let text =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/updater.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn versions_parse_like_node_semver() {
    for case in golden()["versions"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let ours = semver::parse(input).map(|v| v.to_string());
        assert_eq!(json!(ours), case["parsed"], "parse({input:?})");
    }
}

#[test]
fn update_availability_matches_electron_updater() {
    for case in golden()["compares"].as_array().unwrap() {
        let current = semver::parse(case["current"].as_str().unwrap()).unwrap();
        let latest = case["latest"].as_str().unwrap();
        let ours = semver::is_update_available(&current, latest).ok();
        assert_eq!(json!(ours), case["available"], "{} -> {latest}", case["current"]);
    }
}

#[test]
fn every_published_feed_resolves_and_picks_the_same_file() {
    let feeds_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/feeds");
    let github =
        Feed::GitHub { owner: "nekko-labs".into(), repo: "nekko-agent".into(), host: "https://github.com".into() };
    let generic = Feed::Generic { url: "http://127.0.0.1:4599/feed/".into() };
    let cases = golden()["feeds"].as_array().unwrap().clone();
    assert!(cases.len() >= 11, "every fixture is covered");
    for case in cases {
        let (tag, file) = (case["tag"].as_str().unwrap(), case["file"].as_str().unwrap());
        let text = std::fs::read_to_string(feeds_dir.join(tag).join(file)).unwrap();
        let info = update::parse_update_info(&text, file).unwrap();
        assert_eq!(info.version, case["version"].as_str().unwrap(), "{tag}/{file}");
        assert_eq!(json!(info.release_date), case["releaseDate"], "{tag}/{file}");
        let resolved = update::resolve_files(&github, tag, &info).unwrap();
        let ours: Vec<Value> = resolved
            .iter()
            .map(|r| json!({ "url": r.url.as_str(), "sha512": r.info.sha512, "size": r.info.size }))
            .collect();
        assert_eq!(Value::Array(ours), case["files"], "{tag}/{file}");
        let generic_urls: Vec<String> =
            update::resolve_files(&generic, tag, &info).unwrap().iter().map(|r| r.url.to_string()).collect();
        assert_eq!(json!(generic_urls), case["generic"], "{tag}/{file} generic");
        for arch in ["x64", "arm64"] {
            let pick = |platform, linux| {
                update::pick_download(&resolved, platform, arch, linux).ok().map(|r| r.url.to_string())
            };
            let picks = &case["picks"];
            assert_eq!(
                json!(pick(Platform::Windows, LinuxPackage::AppImage)),
                picks[format!("win-{arch}")],
                "{tag}/{file} win-{arch}"
            );
            assert_eq!(
                json!(pick(Platform::Mac, LinuxPackage::AppImage)),
                picks[format!("mac-{arch}")],
                "{tag}/{file} mac-{arch}"
            );
            assert_eq!(
                json!(pick(Platform::Linux, LinuxPackage::AppImage)),
                picks[format!("appimage-{arch}")],
                "{tag}/{file} appimage-{arch}"
            );
            assert_eq!(
                json!(pick(Platform::Linux, LinuxPackage::Deb)),
                picks[format!("deb-{arch}")],
                "{tag}/{file} deb-{arch}"
            );
        }
    }
}

#[test]
fn the_real_feeds_name_the_files_each_platform_installs() {
    // The release this PR's updater will first update from: 0.8.1's own feeds.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/feeds/v0.8.1");
    let gh = Feed::GitHub { owner: "nekko-labs".into(), repo: "nekko-agent".into(), host: "https://github.com".into() };
    let read = |f: &str| update::parse_update_info(&std::fs::read_to_string(dir.join(f)).unwrap(), f).unwrap();
    let win = update::resolve_files(&gh, "v0.8.1", &read("latest.yml")).unwrap();
    let exe = update::pick_download(&win, Platform::Windows, "x64", LinuxPackage::AppImage).unwrap();
    assert!(exe.url.path().ends_with("/v0.8.1/NekkoAgent-0.8.1-x64.exe"));
    assert_eq!(exe.info.size, Some(185_773_714));
    let mac = update::resolve_files(&gh, "v0.8.1", &read("latest-mac.yml")).unwrap();
    assert!(
        update::pick_download(&mac, Platform::Mac, "arm64", LinuxPackage::AppImage)
            .unwrap()
            .url
            .path()
            .ends_with(".zip")
    );
    let linux = update::resolve_files(&gh, "v0.8.1", &read("latest-linux.yml")).unwrap();
    assert!(
        update::pick_download(&linux, Platform::Linux, "x64", LinuxPackage::AppImage)
            .unwrap()
            .url
            .path()
            .ends_with(".AppImage")
    );
    assert!(
        update::pick_download(&linux, Platform::Linux, "x64", LinuxPackage::Deb).unwrap().url.path().ends_with(".deb")
    );
    assert_eq!(update::channel_file(Platform::Linux, "arm64"), "latest-linux-arm64.yml");
}

#[test]
fn checksums_are_electron_builders_base64_sha512() {
    // `sha512` of "abc" as electron-builder writes it (base64 of the digest).
    assert_eq!(
        update::sha512_base64(b"abc"),
        "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw=="
    );
}

#[test]
fn reads_app_update_yml_as_electron_builder_writes_it() {
    let cfg = update::read_app_update_config(
        "owner: nekko-labs\nrepo: nekko-agent\nprovider: github\nupdaterCacheDirName: nekko-agent-desktop-updater\n",
    )
    .unwrap();
    assert_eq!(
        cfg.feed,
        Feed::GitHub { owner: "nekko-labs".into(), repo: "nekko-agent".into(), host: "https://github.com".into() }
    );
    assert_eq!(cfg.cache_dir_name, "nekko-agent-desktop-updater");
    let generic = update::read_app_update_config(
        "provider: generic\nurl: http://127.0.0.1:1/feed\npublisherName:\n  - Nekko Labs\n",
    )
    .unwrap();
    assert_eq!(generic.feed, Feed::Generic { url: "http://127.0.0.1:1/feed".into() });
    assert_eq!(generic.publisher_names, vec!["Nekko Labs".to_string()]);
    assert!(update::read_app_update_config("provider: s3\n").is_err());
}

#[test]
fn feeds_without_a_checksum_or_files_are_refused() {
    assert!(
        update::parse_update_info("version: 1.0.0\nfiles:\n  - url: a.exe\n", "latest.yml")
            .unwrap_err()
            .contains("checksum")
    );
    assert!(update::parse_update_info("version: 1.0.0\n", "latest.yml").unwrap_err().starts_with("No files provided"));
    let legacy = update::parse_update_info("version: 1.0.0\npath: a.exe\nsha512: x\n", "latest.yml").unwrap();
    assert_eq!(legacy.files[0].url, "a.exe");
}
