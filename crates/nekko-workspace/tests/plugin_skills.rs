//! Claude Code plugin skills and commands, and the one resolver a workflow's
//! skill step reads (`resolve_skill_defs`).

use nekko_workspace::skills;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn temp(tag: &str) -> PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let p = std::env::temp_dir()
        .join(format!("nekko-plugins-{tag}-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
    std::fs::create_dir_all(&p).unwrap();
    // Without Windows' verbatim prefix (`\\?\C:\...`), as the skill defs show paths.
    let canonical = std::fs::canonicalize(p).unwrap().to_string_lossy().into_owned();
    canonical.strip_prefix(r"\\?\").unwrap_or(&canonical).into()
}

fn write(base: &Path, rel: &str, text: &str) {
    let full = base.join(rel);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(full, text).unwrap();
}

fn settings(home: &Path, enabled: Value) {
    write(home, ".claude/settings.json", &json!({ "enabledPlugins": enabled }).to_string());
}

const CR: &str = "---\ndescription: Review a PR\nallowed-tools: Bash(gh:*) Bash(git:*) Bash(pnpm:*) Read Grep Glob\nargument-hint: <pr-number>\n---\n\nReview PR $ARGUMENTS using ${CLAUDE_PLUGIN_ROOT}/skills/nyaa/references/rules.md.\n";
const NYAA: &str =
    "---\nname: nyaa\ndescription: The nyaa review method\n---\n\n# nyaa\n\nRead references/rules.md first.\n";

fn nyaa(home: &Path, version_dir: &str, version: &str) -> PathBuf {
    let root = home.join(".claude").join("plugins").join("cache").join("nekko-labs").join("nyaa").join(version_dir);
    write(&root, ".claude-plugin/plugin.json", &json!({ "name": "nyaa", "version": version }).to_string());
    write(&root, "commands/cr.md", CR);
    write(&root, "skills/nyaa/SKILL.md", NYAA);
    write(&root, "skills/nyaa/references/rules.md", "rules");
    root
}

fn ids(defs: &[Value]) -> Vec<String> {
    defs.iter().map(|d| d["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn an_enabled_plugin_lists_its_skills_and_commands() {
    let home = temp("home");
    let root = nyaa(&home, "1.2.0", "1.2.0");
    settings(&home, json!({ "nyaa@nekko-labs": true }));
    let defs = skills::plugin_skills(&home.to_string_lossy());
    assert_eq!(ids(&defs), ["nyaa:nyaa", "nyaa:cr"]);
    let cr = &defs[1];
    assert_eq!(cr["name"], json!("nyaa:cr"));
    assert_eq!(cr["source"], json!("plugin"));
    assert_eq!(cr["pluginRoot"], json!(root.to_string_lossy()));
    assert_eq!(cr["origin"]["kind"], json!("command"));
    assert_eq!(cr["argumentHint"], json!("<pr-number>"));
    assert_eq!(cr["allowedTools"], json!(["Bash(gh:*)", "Bash(git:*)", "Bash(pnpm:*)", "Read", "Grep", "Glob"]));
    // The frontmatter is gone, the placeholders are left for the step.
    let template = cr["template"].as_str().unwrap();
    assert!(template.starts_with("Review PR $ARGUMENTS using ${CLAUDE_PLUGIN_ROOT}/"), "{template}");
    assert!(!template.contains("allowed-tools"));
    // A skill points the model at its own folder.
    assert!(
        defs[0]["template"].as_str().unwrap().contains(&root.join("skills").join("nyaa").to_string_lossy().to_string())
    );
}

#[test]
fn a_disabled_or_unlisted_plugin_lists_nothing() {
    let home = temp("off");
    nyaa(&home, "1.0.0", "1.0.0");
    settings(&home, json!({ "nyaa@nekko-labs": false }));
    assert!(skills::plugin_skills(&home.to_string_lossy()).is_empty());
    settings(&home, json!({ "other@nekko-labs": true }));
    assert!(skills::plugin_skills(&home.to_string_lossy()).is_empty());
    std::fs::remove_file(home.join(".claude/settings.json")).unwrap();
    assert!(skills::plugin_skills(&home.to_string_lossy()).is_empty());
}

#[test]
fn the_highest_installed_version_wins() {
    let home = temp("versions");
    nyaa(&home, "a", "1.9.2");
    let newest = nyaa(&home, "b", "1.10.0");
    write(&newest, "commands/only-new.md", "---\ndescription: new\n---\nNew command.");
    settings(&home, json!({ "nyaa@nekko-labs": true }));
    let defs = skills::plugin_skills(&home.to_string_lossy());
    assert!(ids(&defs).contains(&"nyaa:only-new".to_string()));
    assert_eq!(defs[0]["origin"]["version"], json!("1.10.0"));
}

#[test]
fn a_skill_wins_over_a_command_of_the_same_name() {
    let home = temp("same");
    let root = nyaa(&home, "1.0.0", "1.0.0");
    write(&root, "commands/nyaa.md", "---\ndescription: command\n---\nThe command.");
    settings(&home, json!({ "nyaa@nekko-labs": true }));
    let defs = skills::plugin_skills(&home.to_string_lossy());
    let hits: Vec<&Value> = defs.iter().filter(|d| d["id"] == json!("nyaa:nyaa")).collect();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["origin"]["kind"], json!("skill"));
}

#[test]
fn an_oversized_file_is_skipped() {
    let home = temp("big");
    let root = nyaa(&home, "1.0.0", "1.0.0");
    let big = format!("---\ndescription: big\n---\n{}", "x".repeat(skills::MAX_SKILL_BYTES as usize + 1));
    write(&root, "commands/big.md", &big);
    settings(&home, json!({ "nyaa@nekko-labs": true }));
    let defs = skills::plugin_skills(&home.to_string_lossy());
    assert!(!ids(&defs).contains(&"nyaa:big".to_string()));
    assert!(ids(&defs).contains(&"nyaa:cr".to_string()));
}

#[cfg(unix)]
#[test]
fn links_out_of_the_plugin_folder_are_refused() {
    let (home, outside) = (temp("links"), temp("outside"));
    let root = nyaa(&home, "1.0.0", "1.0.0");
    write(&outside, "secret.md", "---\ndescription: s\n---\nSecret.");
    write(&outside, "evil/SKILL.md", "---\nname: evil\n---\nEvil.");
    std::os::unix::fs::symlink(outside.join("secret.md"), root.join("commands/secret.md")).unwrap();
    std::os::unix::fs::symlink(outside.join("evil"), root.join("skills/evil")).unwrap();
    // A link inside the plugin is fine.
    std::os::unix::fs::symlink(root.join("commands/cr.md"), root.join("commands/review.md")).unwrap();
    settings(&home, json!({ "nyaa@nekko-labs": true }));
    let got = ids(&skills::plugin_skills(&home.to_string_lossy()));
    assert!(!got.contains(&"nyaa:secret".to_string()), "{got:?}");
    assert!(!got.contains(&"nyaa:evil".to_string()), "{got:?}");
    assert!(got.contains(&"nyaa:review".to_string()), "{got:?}");
}

#[test]
fn invalid_names_are_skipped() {
    let home = temp("names");
    let root = nyaa(&home, "1.0.0", "1.0.0");
    write(&root, "commands/bad name.md", "---\ndescription: x\n---\nBody.");
    settings(&home, json!({ "nyaa@nekko-labs": true, "bad/plugin@x": true }));
    let got = ids(&skills::plugin_skills(&home.to_string_lossy()));
    assert!(!got.iter().any(|i| i.contains("bad")), "{got:?}");
}

#[test]
fn the_resolver_keeps_precedence_and_tags_the_source() {
    let (home, project, data) = (temp("rh"), temp("rp"), temp("rd"));
    nyaa(&home, "1.0.0", "1.0.0");
    settings(&home, json!({ "nyaa@nekko-labs": true }));
    // An external skill named like a built-in is shadowed; another is kept with its allowed tools.
    write(&home, ".claude/skills/review/SKILL.md", "---\nname: review\ndescription: mine\n---\nMine.");
    write(
        &project,
        ".claude/skills/triage/SKILL.md",
        "---\nname: triage\ndescription: t\nallowed-tools:\n  - Read\n  - Bash(gh pr view:*)\n---\nTriage.",
    );
    let defs = skills::resolve_skill_defs(&data, &home.to_string_lossy(), &[project.to_string_lossy().into_owned()]);
    let find = |id: &str| defs.iter().find(|d| d["name"] == json!(id)).unwrap_or_else(|| panic!("{id} in {defs:?}"));
    assert_eq!(find("review")["source"], json!("builtin"));
    assert_eq!(defs.iter().filter(|d| d["name"] == json!("review")).count(), 1);
    assert!(!defs.iter().any(|d| d["name"] == json!("goal")), "goals are not steps");
    assert_eq!(find("triage")["source"], json!("external"));
    assert_eq!(find("triage")["allowedTools"], json!(["Read", "Bash(gh pr view:*)"]));
    assert_eq!(find("nyaa:cr")["source"], json!("plugin"));
    let order: Vec<&str> = defs.iter().map(|d| d["source"].as_str().unwrap()).collect();
    let rank = |s: &str| ["builtin", "installed", "external", "plugin"].iter().position(|x| *x == s).unwrap();
    assert!(order.windows(2).all(|w| rank(w[0]) <= rank(w[1])), "{order:?}");
}

#[test]
fn allowed_tools_split_outside_parentheses() {
    assert_eq!(
        skills::split_allowed_tools("Bash(git add:*), Bash(git status:*) Read,Grep"),
        ["Bash(git add:*)", "Bash(git status:*)", "Read", "Grep"]
    );
    assert_eq!(
        skills::frontmatter_value("---\nallowed-tools: [Read, Glob]\n---\nx", "allowed-tools").unwrap(),
        "Read, Glob"
    );
    assert_eq!(skills::frontmatter_value("no frontmatter", "allowed-tools"), None);
}
